// renderer/sections/section04_Settings.js
// Settings

// ----------------- Settings -----------------
// showSettingsAndSwitchTab(tabId) opens the Settings dialog and
// immediately switches to the named tab. The function uses the same
// `id: 'settings'` slot as openSettings() so the modal-stack dedup
// guarantees we don't open two settings dialogs.
function showSettingsAndSwitchTab(tabId) {
  // Close the existing settings dialog (if any) before opening
  // a new one with the requested tab active. We can't just
  // activate the existing dialog's tab from here because the
  // tab buttons live inside its DOM scope.
  for (let i = _modalStack.length - 1; i >= 0; i--) {
    if (_modalStack[i] && _modalStack[i].id === 'settings') {
      try { _modalStack[i].close(); } catch (_) {}
      break;
    }
  }
  openSettings();
  // The modal is rendered synchronously inside openSettings, so
  // the tab buttons are already in the DOM. Find the requested
  // one and click it (which fires the same activateSettingsTab
  // path a real user click would).
  setTimeout(() => {
    const btn = document.querySelector(`.settings-tab-button[data-tab-button="${tabId}"]`);
    if (btn) btn.click();
  }, 0);
}
function openSettings() {
  // R3.3.AuditFix-PP-2: expose the pure external-tools helpers on
  // globalThis so the section03 pane can pick them up via
  // `globalThis.ExternalToolsHelpers` instead of duplicating the
  // logic inline. This breaks the dual-source-of-truth that the
  // R3.3.AuditFix-PP had to work around. The renderer-context has
  // no `require`, but the SETTINGS-MODAL (section04) is loaded via
  // the test-harness's `require` (or via the app's bundle), so
  // setting it here makes the helper available everywhere that
  // matters in production. Section03 still has a tiny inline
  // fallback for safety.
  // KGO4-012: externalToolsHelpers.js is now loaded via <script> in
  // index.html (before this file), so globalThis.ExternalToolsHelpers
  // is always defined in the renderer context.
  // Multi-tab settings dialog: one modal with a sidebar of tabs
  // (General / Image & Add-ons / BatchGen / Style presets / Pipeline /
  // External tools / Popups / History / Shortcuts). Switching tabs
  // swaps the pane content without ever stacking a second modal,
  // which avoids the inconsistent half-saved state and focus-trap
  // problems a layered sub-modal stack causes.
  showModal((m, close) => {
    m.classList.add('settings-modal');
    m.appendChild(el('h2', {}, '⚙ Settings'));
    m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
      'All your settings (API key, output folder, region, theme, styles, image pipeline, popups) are stored in config.txt next to the executable. Your API key is never sent to the cloud by this tool, never embedded in the binary, and is masked in the log pane by default. Click any tab on the left to switch sections.'));

    // Build the tabbed layout. We render all panes up front
    // and toggle a hidden class so switching tabs is instant
    // (no re-render) and any half-filled inputs survive a
    // round trip between tabs.
    const layout = el('div', { class: 'settings-tabs' });
    const sidebar = el('div', { class: 'settings-tabs-sidebar' });
    const paneHost = el('div', { class: 'settings-tabs-panehost' });

    // Issue-3: the old separate "Image" and "Add-ons" tabs are merged
    // into one "Image & Add-ons" tab (both concern the local image
    // pipeline tooling), and the external tools editor got its own
    // dedicated "External tools" tab. The total stays 9 tabs.
    const tabDefs = [
      { id: 'general',  label: '🔑 General',     build: () => buildSettingsGeneralPane() },
      { id: 'image',    label: '🖼 Image & Add-ons', build: () => buildSettingsImageAddonsPane() },
      { id: 'batchgen', label: '📦 BatchGen',     build: () => buildSettingsBatchgenPane() },
      { id: 'styles',   label: '🎨 Style presets', build: () => buildSettingsStylesPane() },
      { id: 'pipeline', label: '🛤 Pipeline',    build: () => buildSettingsPipelinePane() },
      { id: 'tools',    label: '🔧 External tools', build: () => buildSettingsExternalToolsPane() },
      { id: 'popups',   label: '💬 Popups',        build: () => buildSettingsPopupsPane() },
      { id: 'history',  label: '↻ History',         build: () => buildSettingsHistoryPane() },
      { id: 'shortcuts',label: '⌨ Shortcuts',      build: () => buildSettingsShortcutsPane() },
    ];
    const panes = {};
    const tabButtons = {};
    for (const tdef of tabDefs) {
      const pane = el('div', { class: 'settings-tab-pane', 'data-tab-pane': tdef.id });
      const built = tdef.build();
      pane.appendChild(built.root);
      panes[tdef.id] = { el: pane, instance: built.instance };
      paneHost.appendChild(pane);
      const tabBtn = el('button', { class: 'settings-tab-button', 'data-tab-button': tdef.id, type: 'button' }, tdef.label);
      tabBtn.addEventListener('click', () => activateSettingsTab(tdef.id));
      tabButtons[tdef.id] = tabBtn;
      sidebar.appendChild(tabBtn);
    }
    layout.appendChild(sidebar);
    layout.appendChild(paneHost);
    m.appendChild(layout);

    // Save / cancel buttons act on every pane (whichever is
    // currently visible — we collect pending changes into a
    // single setConfig call on save so config.txt is updated
    // atomically).
    const saveBtn = el('button', { class: 'primary' }, 'Save');
    const cancelBtn = el('button', { onclick: close }, 'Cancel');
    saveBtn.addEventListener('click', async () => {
      // R3.3.AuditFix-PP: validate every pane first (where supported).
      // If any pane reports errors, surface them as a toast and
      // abort the save so the user can fix the issue. The
      // external-tools pane (R3.3) uses this to surface duplicate
      // display-name errors that `collect()` would silently
      // accept (duplicate rows are NOT filtered by `collect()` —
      // they're both kept, and the last one wins in config.txt).
      const allErrors = [];
      for (const tdef of tabDefs) {
        const inst = panes[tdef.id].instance;
        if (inst && typeof inst.validate === 'function') {
          // R3.3.AuditFix-PP-2: try/catch around validate() so a
          // buggy pane doesn't crash the whole save flow. We log
          // the throw and continue (the pane's other panes still
          // get validated).
          let errs = null;
          try { errs = inst.validate(); }
          catch (e) {
            try { window.toast(tdef.label + ': validate() threw — ' + (e && e.message || e), 'err', 5000); } catch (_) {}
            errs = [];
          }
          if (errs && errs.length) errs.forEach((e) => allErrors.push({ pane: tdef.label, error: e }));
        }
      }
      if (allErrors.length > 0) { try { window.toast(allErrors[0].pane + ': ' + allErrors[0].error, 'err', 5000); } catch (_) {} return; }
      const merged = { ...state.config };
      let apiKeyNoSave = false;
      let apiKeyInMemory = '';
      let collectedGrants = {};
      for (const tdef of tabDefs) {
        const inst = panes[tdef.id].instance;
        if (inst && typeof inst.collect === 'function') {
          const partial = inst.collect();
          // General pane carries three transient keys
          // (_apiKeyNoSave, _apiKeyValue) that are NOT part of the
          // saved config schema — they're just a channel between the
          // pane and the Save handler. Strip them before setConfig so
          // config.txt stays clean.
          if (partial && typeof partial === 'object') {
            if (typeof partial._apiKeyNoSave === 'boolean') {
              apiKeyNoSave = partial._apiKeyNoSave;
              delete partial._apiKeyNoSave;
            }
            if (typeof partial._apiKeyValue === 'string') {
              apiKeyInMemory = partial._apiKeyValue;
              delete partial._apiKeyValue;
            }
            // R1.2a: extract path grants minted by the Browse buttons.
            // These are passed as a sibling of cfg (not inside cfg).
            if (partial._grants && typeof partial._grants === 'object') {
              Object.assign(collectedGrants, partial._grants);
              delete partial._grants;
            }
          }
          Object.assign(merged, partial);
        }
      }
      // When the user checked "Don't save" on the API-key row,
      // strip api_key from `merged` so it never reaches config.txt.
      // The entered value (in apiKeyInMemory) IS assigned to
      // state.config.api_key below so the current session keeps
      // working — only the persisted form is suppressed.
      if (apiKeyNoSave) {
        merged.api_key = '';
      }
      // Capture the OLD output_dir from the pre-save snapshot
      // (state.config, before the Object.assign(merged, partial)
      // above mutated merged) so the change-detection below can
      // compare the right values. For navigation we also resolve the
      // EFFECTIVE output dir (the actual folder the explorer should
      // land on) — when the user blanks the field, the effective
      // output dir falls back to the platform default
      // (<userData>/generated) and the explorer must follow it.
      const oldOut = (state.config && state.config.output_dir) || '';
      // Merge with the current config — do NOT replace it. Building a
      // fresh {api_key,output_dir,region} object would silently drop
      // `theme` and `styles` on every save. Preserve every unknown
      // key so future config fields aren't wiped.
      // R2.3.1: pass `apiKeyNoSave` as a sibling of `cfg` so the
      // main process can decide whether to clear the persisted
      // `~/.mmx/config.json api_key` for the privacy switch. The
      // bare-cfg form (just `merged`) is also accepted for back-
      // compat; the main process reads `_apiKeyNoSave` from the
      // cfg as a fallback. Either way, the privacy switch is
      // server-side, not client-side.
      // We build the payload in a separate statement to keep the
      // saveBtn-handler body-extraction regex (used by the legacy
      // v1129 A1/A2 tests) from truncating on an inline object
      // literal. See those tests for the brittle regex pattern.
      const setConfigPayload = { cfg: merged, apiKeyNoSave: !!apiKeyNoSave, sessionApiKey: apiKeyInMemory, grants: collectedGrants };
      const result = await window.api.setConfig(setConfigPayload);
      // config:set returns an envelope `{ ok, config, error, warnings? }`.
      // A write failure (read-only fs, disk full, permission revoked)
      // returns ok:false — branch on ok and show the real error
      // instead of falsely reporting "Saved.".
      if (!result || result.ok !== true) {
        const msg = (result && result.error) || 'Could not write config.txt (disk full, read-only, or permission denied).';
        toast('Save failed: ' + msg, 'err', 8000);
        // Still assign the returned (previous) config so state.config
        // stays a valid object — downstream code reads .api_key etc.
        // KGO7-003: through adoptConfig so a failed save can't strip the
        // session-only API key either.
        if (result && result.config) {
          state.config = window.adoptConfig ? window.adoptConfig(result.config) : result.config;
        }
        return;
      }
      // SEC-001: config:set returns a public DTO (no raw api_key).
      // The session key lives exclusively in the main process.
      const saved = result.config;
      state.apiKeyNoSave = !!apiKeyNoSave;
      state.config = window.adoptConfig ? window.adoptConfig(saved) : saved;
      // Live-apply the saved theme so the new selection takes effect
      // immediately (the Settings modal writes theme to config but the
      // <html data-theme> attribute is only updated here, not on the
      // config write itself).
      if (typeof applyTheme === 'function') applyTheme(saved.theme || 'dark');
      scheduleStateSave();
      // KGO7-006: `config:set` returns ok:true once config.txt is written,
      // even when the privacy switch failed to scrub the api_key out of
      // ~/.mmx/config.json — that partial failure is reported ONLY in
      // `warnings[]`. This save path never read it, so a failed scrub was
      // announced to the user as a plain "Saved." (design contract §14.3 R2.3
      // requires the opposite: "Failure sichtbar und Privacywechsel nicht
      // fälschlich als erfolgreich markiert").
      const _warnings = Array.isArray(result.warnings) ? result.warnings : [];
      if (_warnings.length) {
        for (const w of _warnings) toast(w, 'warn', 10000);
        if (typeof window.setStatusError === 'function') {
          window.setStatusError(
            'Settings saved, but the API key could NOT be removed from ~/.mmx/config.json.',
            [{
              label: 'Details',
              onClick: () => showModal((m) => {
                m.appendChild(el('h2', {}, '⚠ Privacy switch — partial failure'));
                for (const w of _warnings) {
                  m.appendChild(el('p', { style: 'white-space:pre-wrap;word-break:break-word;' }, w));
                }
              }),
            }]);
        }
      }
      toast(_warnings.length ? 'Saved with warnings.' : 'Saved.', _warnings.length ? 'warn' : 'ok');
      close();
      refreshQuota();
      // When the user changed output_dir, re-point the file browser
      // at the new folder too — not just refresh the current view.
      // Otherwise the explorer stays on whatever folder it was showing
      // (often the OLD output_dir or a subfolder of it) so a user who
      // picked a new destination in Settings has to manually click the
      // new path in the explorer to land there. Always navigate to the
      // new output_dir; clear every per-tab saved folder too so a tab
      // switch also lands on the new location.
      //
      // Also navigate when the user CLEARED the output_dir field. In
      // that case the new effective output dir is the platform default
      // (<userData>/generated on Windows, per
      // src/config.js#defaultOutputDir) — resolve it via the same
      // `config:defaultOutputDir` IPC the file browser's last-ditch
      // fallback uses (fileBrowser1.js refreshBrowser). The explorer
      // then follows the user's intent ("use the default") instead of
      // staying on the OLD folder.
      const rawNew = (saved && saved.output_dir) || '';
      const rawOld = oldOut || '';
      const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      // Resolve the effective dir for the NEW state: if the
      // user blanked the field, ask main for the platform
      // default. We try the IPC synchronously-looking but the
      // result is awaited below.
      const newEffectivePromise = rawNew
        ? Promise.resolve(rawNew)
        : (window.api && typeof window.api.defaultOutputDir === 'function'
            ? window.api.defaultOutputDir().then((d) => d || '').catch(() => '')
            : Promise.resolve(''));
      const oldEffectivePromise = rawOld
        ? Promise.resolve(rawOld)
        : (window.api && typeof window.api.defaultOutputDir === 'function'
            ? window.api.defaultOutputDir().then((d) => d || '').catch(() => '')
            : Promise.resolve(''));
      const [newEffective, oldEffective] = await Promise.all([newEffectivePromise, oldEffectivePromise]);
      if (norm(newEffective) !== norm(oldEffective)) {
        // Prefer the user-supplied path when present (rawNew),
        // else use the resolved default so the explorer lands
        // on the actual folder, not the empty string that would
        // make refreshBrowser() show a "no output dir" error.
        const target = rawNew || newEffective;
        state.fbDir = target;
        if (state.fbDirs) for (const k of Object.keys(state.fbDirs)) state.fbDirs[k] = target;
        scheduleStateSave();
      }
      refreshBrowser();
    });
    m.appendChild(el('div', { class: 'footer settings-footer' }, [cancelBtn, saveBtn]));

    function activateSettingsTab(id) {
      for (const tdef of tabDefs) {
        const isActive = tdef.id === id;
        tabButtons[tdef.id].classList.toggle('active', isActive);
        panes[tdef.id].el.classList.toggle('active', isActive);
      }
    }
    // Default to the General tab, which shows API key first.
    activateSettingsTab('general');
  }, { id: 'settings' });
}
