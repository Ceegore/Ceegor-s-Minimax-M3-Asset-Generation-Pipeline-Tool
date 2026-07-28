// renderer/sections/section03_Settings_tab_panes.js
// Settings tab panes

// ----------------- Settings tab panes -----------------
// Each pane factory returns { root, instance }. The `instance`
// object carries a `collect()` method that returns the pane's
// pending changes as a partial config object — the parent
// `openSettings()` merges these into one setConfig call so the
// save button works regardless of which tab the user is on.
//
// Panes that have no pending state (e.g. Shortcuts) return
// { root, instance: null }.

function buildSettingsGeneralPane() {
  // The General pane groups fields into 4 sections in a fixed
  // top-to-bottom reading order, each preceded by a small uppercase
  // section header so the pane reads like a checklist:
  //   1. Authentication  (you cannot generate anything without this)
  //   2. Storage         (where every generated file lands)
  //   3. Generation defaults (region / theme — both have safe defaults)
  //   4. Diagnostics     (read-only info + ad-hoc test buttons)
  const root = el('div', {});
  root.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin: 0 0 8px;' },
    'Your core settings — the tool needs (1) a working API key and (2) an output folder before it can generate anything. The rest has safe defaults.'));

  // The first-time-setup modal is policy-gated, so a fresh install
  // does not auto-open it even when the welcome popup is suppressed
  // and the config is incomplete (it would otherwise contradict the
  // "default off" popup policy). To keep the guided setup reachable,
  // the General pane exposes a "Run first-time setup" button that
  // re-opens the modal (with `force: true` so the policy is bypassed
  // — the user just asked for it). Without this button, a user who
  // turned popups off AND skipped the initial setup would have no
  // in-app way to walk through the API key + output folder fields
  // together.
  const runFirstTimeSetupBtn = el('button', { class: 'btn-mini' }, '🚀 Run first-time setup');
  runFirstTimeSetupBtn.addEventListener('click', () => {
    if (typeof openFirstTimeSetup === 'function') {
      // force: true — the user explicitly asked for this dialog
      // from the General settings pane; suppressing it would
      // be wrong. The same dialog is also reachable via the
      // "?" tooltips on the API key / output dir rows below.
      openFirstTimeSetup({ force: true });
    }
  });
  root.appendChild(el('div', { class: 'row' }, [
    el('label', {}, ['Guided setup', helpButton('settings.firstTimeSetup')]),
    el('div', { class: 'combo' }, [runFirstTimeSetupBtn, el('span', { style: 'color: var(--fg-3); font-size: 11px;' }, 'Re-opens the first-run form (API key + output folder).')]),
  ]));

  // ---- Section 1: Authentication ----
  root.appendChild(el('h4', { class: 'settings-group-title' }, '🔐 Authentication'));
  const apiKeyRow = showRevealableKey(state.config.api_key || '', {
    placeholder: 'sk-cp-xxxxxxxx  (or your PAYG key)',
    label: 'API key',
  });
  try {
    const lbl = apiKeyRow.row.querySelector('label');
    if (lbl) lbl.appendChild(helpButton('settings.apiKey'));
  } catch (_) {}
  // "Don't save" checkbox on the API-key row. When checked, the
  // entered key is kept in memory (so the current session works) but
  // is NOT written to config.txt on Save, and the next launch starts
  // with an empty key (the user re-enters it). When unchecked, the
  // key persists across restarts.
  const noSaveCb = el('input', {
    type: 'checkbox',
    class: 'api-key-no-save',
    id: 'api-key-no-save',
  });
  noSaveCb.checked = !!state.apiKeyNoSave;
  const noSaveRow = el('div', { class: 'row api-key-no-save-row' }, [
    el('label', { for: 'api-key-no-save', class: 'api-key-no-save-label' }, [
      noSaveCb,
      el('span', {}, [
        el('strong', {}, "Don't save"),
        '  — key stays in memory only, never written to disk (config.txt or mmx-cli config). Re-enter on next start.',
        helpButton('settings.apiKeyNoSave'),
      ]),
    ]),
  ]);
  function syncNoSaveStyle() {
    apiKeyRow.input.classList.toggle('api-key-no-save-active', noSaveCb.checked);
  }
  noSaveCb.addEventListener('change', () => {
    state.apiKeyNoSave = noSaveCb.checked;
    syncNoSaveStyle();
    // Persist immediately so the checkbox state survives a restart
    // even if the user clicks Cancel (which doesn't go through the
    // Save button's collect() path). The sibling settings all call
    // scheduleStateSave() in their change handlers; without it here,
    // the checkbox would silently revert on the next launch.
    if (typeof scheduleStateSave === 'function') scheduleStateSave();
  });
  syncNoSaveStyle();
  root.appendChild(apiKeyRow.row);
  root.appendChild(noSaveRow);

  // ---- Section 2: Storage ----
  root.appendChild(el('h4', { class: 'settings-group-title' }, '📁 Storage'));
  const outInput = el('input', { type: 'text', value: state.config.output_dir || '', placeholder: '(default: ./generated/)' });
  // R1.2a: store the grantId from the native folder picker so the
  // Save handler can pass it to config:set (which requires a grant
  // for output_dir / report_dir changes).
  let _outDirGrantId = null;
  let _reportDirGrantId = null;
  root.appendChild(el('div', { class: 'row' }, [
    el('label', {}, ['Output directory', helpButton('settings.outputDir')]),
    el('div', { class: 'combo' }, [outInput, el('button', { class: 'btn-mini', onclick: async () => {
      const r = await window.api.pickFolderFull({ purpose: 'config-output' });
      if (r && r.ok && r.path) { outInput.value = r.path; _outDirGrantId = r.grantId || null; }
    } }, 'Browse…')]),
  ]));
  // Report folder — where Pipeline "clear/export with report" .md files
  // land. Empty = use the asset destination folder (next to the exported files).
  const reportInput = el('input', { type: 'text', value: state.config.report_dir || '', placeholder: '(default: next to the assets)', title: 'Where Pipeline clear/export reports are written. Leave blank to write the report next to the exported assets.' });
  root.appendChild(el('div', { class: 'row' }, [
    el('label', {}, ['Report folder', helpButton('settings.reportDir')]),
    el('div', { class: 'combo' }, [reportInput, el('button', { class: 'btn-mini', onclick: async () => {
      const r = await window.api.pickFolderFull({ purpose: 'config-report' });
      if (r && r.ok && r.path) { reportInput.value = r.path; _reportDirGrantId = r.grantId || null; }
    } }, 'Browse…')]),
  ]));
  const cp = el('div', { class: 'row' }, [el('label', {}, ['Config file location', helpButton('settings.configFile')]), el('input', { type: 'text', value: '', readonly: '', title: 'Where config.txt (api_key, output_dir, region, styles) is stored on disk' })]);
  root.appendChild(cp);
  window.api.configPath().then((p) => { cp.querySelector('input').value = p; });

  // ---- Section 3: Generation defaults ----
  root.appendChild(el('h4', { class: 'settings-group-title' }, '🌐 Generation defaults'));
  const regInput = el('select', {});
  for (const r of ['global', 'cn']) regInput.appendChild(el('option', { value: r }, r));
  regInput.value = state.config.region || 'global';
  root.appendChild(el('div', { class: 'row' }, [el('label', {}, ['Region', helpButton('settings.region')]), regInput]));
  const themeSel = el('select', {});
  for (const [val, lbl] of [['dark', 'Dark'], ['light', 'Light']]) themeSel.appendChild(el('option', { value: val }, lbl));
  themeSel.value = state.theme || state.config.theme || 'dark';
  root.appendChild(el('div', { class: 'row' }, [el('label', {}, ['Theme', helpButton('settings.theme')]), themeSel]));

  // ---- Section 4: Diagnostics ----
  root.appendChild(el('h4', { class: 'settings-group-title' }, '🔧 Diagnostics'));
  root.appendChild(el('p', { style: 'color: var(--fg-3); font-size: 11.5px; margin: 4px 0 8px;' },
    'Ad-hoc tools. They do not change any setting — they just probe the current state (auth status, mmx binary path, etc.).'));
  const test = el('button', { class: 'btn-mini' }, 'Test connection');
  const diag = el('button', { class: 'btn-mini' }, 'Diagnose');
  test.addEventListener('click', async () => {
    test.disabled = true; test.innerHTML = '<span class="spinner"></span> Testing…';
    const r = await window.api.authStatus();
    test.disabled = false; test.textContent = 'Test connection';
    if (r.ok) {
      toast((r.message || 'Authentication OK.') + (r.command ? `  (via ${r.command})` : ''), 'ok', 4000);
    } else {
      toast('Auth failed: ' + (r.error || 'unknown error'), 'err', 6000);
    }
  });
  diag.addEventListener('click', () => { showDiagnose(); });
  root.appendChild(el('div', { class: 'settings-pane-actions' }, [test, diag]));

  return {
    root,
    instance: {
      collect() {
        return {
          api_key: noSaveCb.checked ? '' : apiKeyRow.getValue().trim(),
          _apiKeyNoSave: noSaveCb.checked,
          _apiKeyValue: noSaveCb.checked ? apiKeyRow.getValue().trim() : '',
          output_dir: outInput.value.trim(),
          // report_dir is persisted (sanitize() whitelists it) so the
          // Pipeline report writer can drop .md files here without a trust round-trip.
          report_dir: reportInput.value.trim(),
          region: regInput.value || 'global',
          theme: themeSel.value || 'dark',
          // R1.2a: grants minted by the Browse buttons (pickFolderFull).
          // The Save handler strips this and passes it as a sibling of cfg.
          _grants: { output_dir: _outDirGrantId, report_dir: _reportDirGrantId },
        };
      },
    },
  };
}

function buildSettingsImageAddonsPane() {
  // Issue-3: merged "Image" + "Add-ons" pane. Both concern the local
  // image pipeline tooling, so they now share ONE tab that reads like
  // a checklist:
  //   1. Status (read-only Real-ESRGAN detection)
  //   2. Upscale model (control)
  //   3. Real-ESRGAN installer (one-click download)
  //   4. IS-Net installer (add-ons popup)
  // The external tools editor that used to live in the old Add-ons
  // pane moved to its own dedicated tab (buildSettingsExternalToolsPane).
  const root = el('div', {});
  root.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin: 0 0 8px;' },
    'Local image pipeline. The built-in multi-step pipeline always works (no install). Real-ESRGAN (BSD-3-Clause) + IS-Net (MIT) are optional quality upgrades you can install right here.'));

  // ---- Section 1: Status ----
  root.appendChild(el('h4', { class: 'settings-group-title' }, '📊 Status'));
  const statusText = el('div', { class: 're-status' }, 'Detecting…');
  const reBtn = el('button', { class: 'btn-mini' }, '🔄 Re-detect');
  root.appendChild(el('div', { class: 'row' }, [
    el('label', {}, ['Real-ESRGAN', helpButton('settings.upscale')]), statusText, reBtn,
  ]));

  // ---- Real-ESRGAN model selector ----
  const modelSel = el('select', {});
  const reModels = (window.PipelineModel && window.PipelineModel.REALESRGAN_MODEL_DETAILS) || [];
  for (const { value: val, label: lbl } of reModels) {
    const opt = el('option', { value: val }, lbl);
    if (val === (state.realesrganModel || 'realesrgan-x4plus')) opt.selected = true;
    modelSel.appendChild(opt);
  }
  modelSel.addEventListener('change', () => {
    state.realesrganModel = modelSel.value;
    scheduleStateSave();
  });
  // ---- Section 2: Upscale model ----
  root.appendChild(el('h4', { class: 'settings-group-title' }, '🔍 Upscale model'));
  root.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px; margin: 4px 0 8px;' },
    'Which Real-ESRGAN model to use when the upscale post-processing step runs. Change this if you primarily generate a specific style.'));
  root.appendChild(el('div', { class: 'row' }, [
    el('label', {}, 'Upscale model'), modelSel,
  ]));

  async function refreshStatus() {
    statusText.textContent = 'Detecting…';
    try {
      const r = await window.api.realesrganAvailable();
      if (r && r.available) {
        const v = r.version ? '  (v' + r.version + ')' : '';
        statusText.textContent = 'Detected: ' + (r.binaryPath || '') + v;
        statusText.style.color = 'var(--success)';
      } else {
        statusText.textContent = 'Not found. Use the installer below.';
        statusText.style.color = 'var(--fg-2)';
      }
    } catch (e) {
      statusText.textContent = 'Error: ' + (e && e.message || e);
      statusText.style.color = 'var(--danger)';
    }
  }
  reBtn.addEventListener('click', refreshStatus);
  setTimeout(refreshStatus, 0);

  // ---- Section 3: Real-ESRGAN installer (moved from the old Add-ons pane) ----
  root.appendChild(el('h4', { class: 'settings-group-title' }, '⬇ Real-ESRGAN (Image Upscaling)'));
  const installBtn = el('button', { class: 'btn-mini' }, '⬇ Download Real-ESRGAN');
  const installBtnStatus = el('button', { class: 'btn-mini' }, '⬇ Install (when missing)');
  installBtnStatus.style.display = 'none';
  const installProgress = el('div', { class: 're-progress' });
  installProgress.style.display = 'none';
  installProgress.style.color = 'var(--fg-2)';
  installProgress.style.fontSize = '12px';
  root.appendChild(el('div', { class: 'row' }, [
    el('label', {}, 'One-click install'),
    el('div', { style: 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap;' }, [installBtn, installBtnStatus, installProgress]),
  ]));

  // Unsubscribe handle returned by onRealesrganDownloadProgress. The preload
  // exposes no generic on()/removeListener() — the earlier code guarded on
  // those and silently never attached, so the progress line froze at
  // "Starting…" for the whole download.
  let unsubProgress = null;
  function offProgress() {
    installProgress.style.display = 'none';
    if (unsubProgress) { try { unsubProgress(); } catch (_) {} unsubProgress = null; }
  }

  async function runInstall() {
    installBtn.disabled = true;
    installBtnStatus.disabled = true;
    installProgress.style.display = '';
    installProgress.style.color = 'var(--fg-2)';
    installProgress.textContent = 'Starting…';

    if (window.api && window.api.onRealesrganDownloadProgress) unsubProgress = window.api.onRealesrganDownloadProgress((data) => {
      if (!data) return;
      if (data.phase === 'download') {
        if (data.total) {
          // Payload shape from main/services/InstallDownloadService.js:
          // { phase, downloaded, total, status } — same as section15's consumer.
          const pct = (data.downloaded / data.total) * 100;
          const mb = (data.downloaded / 1024 / 1024).toFixed(1);
          const totalMb = (data.total / 1024 / 1024).toFixed(1);
          installProgress.textContent = `Downloading… ${mb} / ${totalMb} MB (${pct.toFixed(0)}%)`;
        } else {
          installProgress.textContent = 'Downloading…';
        }
      } else if (data.phase === 'verify') {
        installProgress.textContent = 'Verifying checksum…';
      } else if (data.phase === 'extract') {
        installProgress.textContent = 'Extracting…';
      } else if (data.phase === 'done') {
        installProgress.textContent = 'Done.';
      }
    });
    try {
      const r = await window.api.realesrganDownload();
      offProgress();
      if (r && r.ok) {
        installProgress.textContent = 'Installed to ' + (r.binDir || './bin') + '.';
      } else {
        installProgress.textContent = 'Download failed: ' + ((r && r.error) || 'unknown');
        installProgress.style.color = 'var(--danger)';
      }
    } catch (e) {
      offProgress();
      installProgress.textContent = 'Download failed: ' + (e && e.message || e);
      installProgress.style.color = 'var(--danger)';
    } finally {
      installBtn.disabled = false;
      installBtnStatus.disabled = false;
    }
  }
  installBtn.addEventListener('click', runInstall);
  installBtnStatus.addEventListener('click', runInstall);

  // ---- Section 4: IS-Net (background removal) ----
  root.appendChild(el('h4', { class: 'settings-group-title' }, '✂ IS-Net (Background Removal)'));
  const openAddonsBtn = el('button', { class: 'btn-mini' }, '🧩 Open add-ons installer');
  openAddonsBtn.addEventListener('click', () => { if (typeof openOptionalAddons === 'function') openOptionalAddons({ force: true }).catch(() => {}); });
  root.appendChild(el('div', { class: 'row' }, [
    el('label', {}, ['IS-Net Installer', helpButton('settings.optionalAddons')]),
    openAddonsBtn,
  ]));

  // The pane does not modify config.txt directly — its writes
  // go to state.json (realesrganModel), so collect() returns
  // an empty object. The save button still works.
  return { root, instance: { collect: () => ({}) } };
}

function buildSettingsStylesPane() {
  // The style-presets pane shows the existing list with
  // add/edit/delete + the "Save current prompt as style"
  // button. Rendered inline so the user doesn't have to dismiss a
  // second modal to save settings.
  //
  // Define `editStyle`, `deleteStyle`, and `persistStyles` locally so
  // this inline pane is self-sufficient. They are NOT shared closures
  // — referencing them as globals would throw ReferenceError at click
  // time.
  const root = el('div', {});
  root.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
    'Style presets are short text snippets (a genre, mood, camera hint) that get prepended to every prompt so you can keep the same look across many generations without retyping.'));

  async function persistStyles() {
    state.config.styles = state.config.styles || [];
    state.config = state.config || {};
    // KGO5-004: strip the in-memory API key when the privacy switch is on.
    const _paneCfg = Object.assign({}, state.config);
    if (state.apiKeyNoSave) _paneCfg.api_key = '';
    const res = await window.api.setConfig(_paneCfg);
    if (!res || res.ok !== true) {
      const msg = (res && res.error) || 'unknown error';
      toast('Could not save style preset: ' + msg, 'err', 5000);
      return false;
    }
    // KGO7-003: adoptConfig keeps the session-only API key alive (the
    // response carries api_key:'' under the privacy switch; measured 24->0).
    state.config = (window.adoptConfig ? window.adoptConfig(res.config) : res.config) || state.config;
    return true;
  }

  function editStyle(i) {
    const s = (state.config.styles || [])[i];
    if (!s) return;
    editingIdx.value = i;
    nameInput.value = s.name;
    valInput.value = s.value;
    nameInput.focus();
  }
  function deleteStyle(i, after) {
    const styles = state.config.styles || [];
    if (i < 0 || i >= styles.length) return;
    const removed = styles.splice(i, 1)[0];
    persistStyles().then((ok) => {
      if (!ok) { styles.splice(i, 0, removed); return; }
      if (typeof _refreshAllStyleDropdowns === 'function') _refreshAllStyleDropdowns();
      after && after();
      toast(`Removed "${removed.name}".`, 'ok');
    });
  }

  // Render the list
  const list = el('ul', { class: 'style-list' });
  function renderList() {
    list.innerHTML = '';
    const styles = state.config.styles || [];
    if (!styles.length) {
      list.appendChild(el('li', { class: 'empty-row' }, 'No styles yet. Add one below, or click "Save current prompt as style".'));
      return;
    }
    styles.forEach((s, i) => {
      const actions = el('div', { class: 'sactions' }, [
        el('button', { class: 'btn-mini', onclick: () => { editStyle(i); } }, '✎'),
        el('button', { class: 'btn-mini danger', onclick: () => { deleteStyle(i, () => { renderList(); }); } }, '✕'),
      ]);
      list.appendChild(el('li', {}, [
        el('div', {}, [
          el('div', { class: 'sname' }, s.name),
          el('div', { class: 'sval' }, s.value),
        ]),
        actions,
      ]));
    });
  }
  renderList();
  root.appendChild(list);

  const nameInput = el('input', { type: 'text', placeholder: 'Style name (e.g. "Pixel Art Berlin")' });
  const valInput = el('textarea', { placeholder: 'Style value — the text that gets prepended to your prompt (e.g. "Pixel art, neon red lighting, dramatic shadows")' });
  valInput.style.minHeight = '70px';
  const editingIdx = { value: -1 };
  root.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Name'), nameInput]));
  root.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Value (prepended to your prompt)'), valInput]));

  const saveBtn = el('button', { class: 'btn-mini' }, '💾 Save style');
  const saveCurrentBtn = el('button', { class: 'btn-mini' }, '✚ Save current prompt as style…');
  const addPremadeBtn = el('button', { class: 'btn-mini' }, '✨ Add premade styles');
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const value = valInput.value.trim();
    if (!name) { toast('Name is required.', 'warn'); return; }
    if (!value) { toast('Value is required.', 'warn'); return; }
    if (name.includes('=')) { toast('Style name cannot contain "=" (would break config parsing).', 'err'); return; }
    state.config.styles = state.config.styles || [];
    if (editingIdx.value >= 0) state.config.styles[editingIdx.value] = { name, value };
    else state.config.styles.push({ name, value });
    const ok = await persistStyles();
    if (!ok) return;
    if (typeof _refreshAllStyleDropdowns === 'function') _refreshAllStyleDropdowns();
    renderList();
    toast(`Saved "${name}".`, 'ok');
    nameInput.value = ''; valInput.value = '';
    editingIdx.value = -1;
  });
  saveCurrentBtn.addEventListener('click', () => {
    // Pull the active tab's manual prompt into the value
    // field. The standalone popup does the same.
    const cur = _currentManualText();
    if (!cur) { toast('Active tab has no prompt to save.', 'warn'); return; }
    valInput.value = cur;
    if (!nameInput.value.trim()) nameInput.value = 'My style';
    nameInput.focus();
  });
  addPremadeBtn.addEventListener('click', async () => {
    if (!await asyncConfirm('Import premade style presets into your style settings? Existing styles will be preserved and duplicates skipped.')) return;
    const res = await window.api.getPremadeStyles();
    if (!res || !res.ok || !Array.isArray(res.styles)) {
      toast('Could not load premade styles file: ' + ((res && res.error) || 'file not found'), 'err');
      return;
    }
    state.config.styles = state.config.styles || [];
    const existingNames = new Set(state.config.styles.map(s => s.name));
    const existingValues = new Set(state.config.styles.map(s => s.value));

    let added = 0;
    for (const preset of res.styles) {
      if (!existingNames.has(preset.name) && !existingValues.has(preset.value)) {
        state.config.styles.push({ name: preset.name, value: preset.value });
        existingNames.add(preset.name);
        existingValues.add(preset.value);
        added++;
      }
    }

    if (added === 0) {
      toast('All premade styles are already imported.', 'info');
      return;
    }

    const ok = await persistStyles();
    if (!ok) return;
    if (typeof _refreshAllStyleDropdowns === 'function') _refreshAllStyleDropdowns();
    renderList();
    toast(`Added ${added} premade style presets.`, 'ok');
  });
  root.appendChild(el('div', { class: 'settings-pane-actions' }, [saveBtn, saveCurrentBtn, addPremadeBtn]));

  return { root, instance: null /* styles persist immediately on save */ };
}

function buildSettingsPopupsPane() {
  // Popups policy + reset history. Two logical sections — Behaviour
  // (the dropdown) and Reset (the destructive action). Same
  // .settings-group-title pattern as General / BatchGen so the whole
  // settings dialog reads consistently.
  const root = el('div', {});
  root.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin: 0 0 8px;' },
    'Control how often the optional popups appear: the welcome screen, the first-time setup, the optional add-ons installer, and the per-tab intro messages.'));

  // ---- Section 1: Behaviour ----
  root.appendChild(el('h4', { class: 'settings-group-title' }, '💬 Behaviour'));
  const polSel = el('select', { class: 'popup-policy-select' });
  for (const [val, lbl] of [
    ['never',       'Never show optional popups (welcome still opens at startup)'],
    ['once-fresh',  'Show once to fresh users, then never'],
    ['per-session', 'Show first time each app start'],
    ['always',      'Always show (even after dismissal)'],
  ]) polSel.appendChild(el('option', { value: val }, lbl));
  polSel.value = state.popupPolicy || 'never';
  polSel.addEventListener('change', () => { state.popupPolicy = polSel.value; scheduleStateSave(); });
  root.appendChild(el('div', { class: 'row' }, [
    el('label', {}, ['Popup behaviour', helpButton('settings.popupPolicy')]),
    polSel,
  ]));

  // ---- Section 2: Reset ----
  root.appendChild(el('h4', { class: 'settings-group-title' }, '🔄 Reset'));
  root.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px; margin: 4px 0 8px;' },
    'Force every dismissed popup to fire again on its next trigger. Useful while you\'re still learning the tool.'));
  const resetBtn = el('button', { class: 'btn-mini' }, '🔄 Reset popup history');
  resetBtn.addEventListener('click', async () => {
    if (!await asyncConfirm('Reset all popup "seen" history? Every popup will fire again the next time it is triggered (until you dismiss it).')) return;
    resetPopupSeen();
    toast('Popup history reset.', 'ok');
    refreshSeenCount();
  });
  const seenSpan = el('span', { style: 'color: var(--fg-3); font-size: 11px;' }, '');
  function refreshSeenCount() {
    const seenCount = (state.seenPopups && typeof state.seenPopups === 'object') ? Object.keys(state.seenPopups).length : 0;
    seenSpan.textContent = `Currently remembers ${seenCount} popup${seenCount === 1 ? '' : 's'} as seen.`;
  }
  refreshSeenCount();
  root.appendChild(el('div', { class: 'row' }, [
    el('label', {}, 'Reset history'),
    el('div', { style: 'display: flex; gap: 8px; align-items: center;' }, [resetBtn, seenSpan]),
  ]));

  // ---- Section 3: Danger zone (F7 — Delete all local data) ----
  root.appendChild(el('h4', { class: 'settings-group-title', style: 'color: var(--danger); margin-top: 18px;' }, '⚠ Danger zone'));
  root.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px; margin: 4px 0 8px;' },
    'Delete ALL tool settings and state (API key, output directory, theme, styles, batch queues, job archive). Your generated assets are NEVER touched. The app relaunches into first-run setup after deletion.'));
  const dangerBtn = el('button', {
    class: 'btn-mini',
    style: 'background: var(--danger); color: #fff; font-weight: 600; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer;',
  }, 'Delete all local data…');
  dangerBtn.addEventListener('click', async () => {
    // KGO8-001: both confirm steps run INSIDE the try — window.prompt() THROWS in Electron.
    try {
      if (!await asyncConfirm('This will permanently delete:\n\n• config.txt (API key, output dir, region, theme, styles)\n• state.json (all UI/layout/pipeline state)\n• batches.json (batch queues)\n• state.jobs.archive.jsonl (job history)\n• ~/.mmx/config.json api_key field\n\nYour generated assets (images, audio, video) are NOT touched.\n\nContinue?')) return;
      const typed = await asyncPrompt('Type DELETE to confirm irreversible data deletion:', 'DELETE', '⚠ Delete all local data');
      if (typed !== 'DELETE') { toast('Deletion cancelled.', 'warn'); return; }
      dangerBtn.disabled = true;
      dangerBtn.textContent = 'Deleting…';
      const result = await window.api.resetAllData();
      // Show per-file results honestly.
      const failed = (result.results || []).filter((r) => !r.ok && !r.skipped);
      if (failed.length) {
        toast(`Reset partially failed: ${failed.map((f) => f.file).join(', ')}`, 'err', 8000);
        // Show detail in a follow-up confirm so the user sees what failed.
        alert('Some files could not be deleted (likely locked by another process):\n\n' + failed.map((f) => `  ${f.file}: ${f.error}`).join('\n'));
        dangerBtn.disabled = false;
        dangerBtn.textContent = 'Delete all local data…';
        return;
      }
      // Issue 3: stop any pending debounced state save and wipe the
      // in-memory config so nothing can write the just-deleted data back
      // to disk in the reset→relaunch window. (The main process also
      // re-deletes at the very last moment in app:resetAndRelaunch as a final guard.)
      try { if (typeof window.cancelPendingStateSave === 'function') window.cancelPendingStateSave(); } catch (_) {}
      try {
        state.config = { api_key: '', output_dir: '', report_dir: '', region: 'global', theme: 'dark', styles: [], external_tools: [], raw: '' };
      } catch (_) {}
      // Issue 2: clear success toast once the deletion has finished.
      toast('Local data successfully deleted. Restarting the tool now…', 'ok', 4000);
      // Brief delay so the toast is visible before relaunch.
      setTimeout(() => { window.api.resetAndRelaunch(); }, 1500);
    } catch (e) {
      toast('Reset failed: ' + ((e && e.message) || e), 'err', 6000);
      dangerBtn.disabled = false;
      dangerBtn.textContent = 'Delete all local data…';
    }
  });
  root.appendChild(el('div', { class: 'row' }, [
    el('label', {}, 'Reset everything'),
    dangerBtn,
  ]));

  return { root, instance: { collect: () => ({}) /* popupPolicy lives in state.json */ } };
}

function buildSettingsBatchgenPane() {
  // Settings for the BatchGen feature. The example export format is
  // chosen here (md or txt) and used by batchesGenerateExamples (both
  // the renderer + the main-process IPC) so the user gets exactly one
  // file per "Examples" click instead of both.
  //
  // Also includes an opt-out switch for the "auto-remove completed
  // items" behaviour (which is the default — see startBatchGen() in
  // batchManager.js for the per-item splice logic).
  const root = el('div', {});
  root.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
    'Settings for BatchGen — the bulk runner that executes every prompt/text you queue in the per-tab batch editors. Each setting below controls a behaviour that affects every batch run (per tab + the all-types runner).'));

  // ---- Group 1: Example export format ----
  root.appendChild(el('h4', { class: 'settings-group-title' }, '📋 Example export'));
  root.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px; margin: 4px 0 8px;' },
    'The "Examples" button (next to "BatGen All Types") writes a template you can hand to an AI to generate a batch import file. Pick whichever single format you actually use.'));

  const fmtSel = el('select', { class: 'batches-export-format-select' });
  for (const [val, lbl] of [
    ['md',  '📝 Markdown (.md) — AI-friendly table with header rows (recommended)'],
    ['txt', '📄 Plain text (.txt) — pipe-separated rows, no formatting'],
  ]) fmtSel.appendChild(el('option', { value: val }, lbl));
  fmtSel.value = state.batchesExportFormat || 'md';
  // Apply immediately on change so the next click on "Gen
  // Examples" uses the new format even if the user doesn't
  // hit Save in the meantime. scheduleStateSave persists the
  // pick to state.json so a restart uses the same format.
  fmtSel.addEventListener('change', () => {
    state.batchesExportFormat = fmtSel.value;
    scheduleStateSave();
  });
  root.appendChild(el('div', { class: 'row' }, [
    el('label', {}, ['Example export format', helpButton('settings.batchesExportFormat')]),
    fmtSel,
  ]));

  // ---- Group 2: Auto-remove behaviour ----
  root.appendChild(el('h4', { class: 'settings-group-title', style: 'margin-top: 18px;' }, '🧹 Queue cleanup'));
  root.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px; margin: 4px 0 8px;' },
    'After a batch item finishes generating, what should happen to the entry in the BatchGen list? Default behaviour is to remove it (so the list always reflects only upcoming work); failed items are NEVER removed — you decide whether to retry or skip them.'));

  const autoRemoveCb = el('input', {
    type: 'checkbox',
    class: 'batches-auto-remove-cb',
    id: 'batches-auto-remove-cb',
  });
  autoRemoveCb.checked = state.batchesAutoRemove !== false;  // default true
  autoRemoveCb.addEventListener('change', () => {
    state.batchesAutoRemove = autoRemoveCb.checked;
    scheduleStateSave();
  });
  root.appendChild(el('div', { class: 'row batches-auto-remove-row' }, [
    el('label', { for: 'batches-auto-remove-cb' }, [
      autoRemoveCb,
      el('span', {}, [
        el('strong', {}, 'Auto-remove completed items'),
        '  — each successful generation is removed from the BatchGen list immediately. Failed items stay until you decide.',
        helpButton('settings.batchesAutoRemove'),
      ]),
    ]),
  ]));

  return {
    root,
    instance: {
      collect() {
        // Both batchesExportFormat and batchesAutoRemove live
        // in state.json (persisted via scheduleStateSave on
        // change), not in config.txt — so the collect() returns
        // an empty partial and the Save handler merges state
        // JSON + config in-place without re-writing these.
        return {};
      },
    },
  };
}

// History pane. Manages the L2 (state.jobs.snapshot) +
// L3 (state.jobs.archive.jsonl) lifecycle. Exposes:
//   - lastFinishedCap: 20..1000, default 200
//   - Clear archive button (with confirm)
//   - Archive size label (live-updates)
//   - Open archive button → ArchiveViewer widget
function buildSettingsHistoryPane() {
  const root = el('div', {});
  root.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
    'Job history is split across two tiers. The recent list (L2) shows up to N finished jobs in this app session and survives restarts. The archive (L3) holds the long-tail history and is read on demand.'));
  root.appendChild(el('h4', {}, 'Recent (L2 — in state.json)'));
  const capBox = el('div', { class: 'settings-row' });
  const capLabel = el('label', {}, 'Max recent jobs (20–1000):');
  capLabel.htmlFor = 'history-cap-input';
  const capInput = el('input', { type: 'number', min: 20, max: 1000, step: 10, value: (state.jobsArchiveCap || 200), id: 'history-cap-input', style: 'width: 100px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-2); color: var(--fg);' });
  capBox.append(capLabel, capInput);
  root.appendChild(capBox);
  capInput.addEventListener('change', () => {
    const v = Math.max(20, Math.min(1000, Math.round(Number(capInput.value) || 200)));
    capInput.value = v;
    state.jobsArchiveCap = v;
    if (typeof scheduleStateSave === 'function') scheduleStateSave();
    if (typeof toast === 'function') toast(`Recent job cap set to ${v}. Existing overflow will be moved to the archive on the next save.`, 'info', 4000);
  });

  root.appendChild(el('h4', { style: 'margin-top: 16px;' }, 'Archive (L3 — JSONL)'));
  const archiveBox = el('div', { class: 'settings-row', style: 'display: flex; align-items: center; gap: 8px;' });
  const sizeLabel = el('span', {}, 'Size: …');
  sizeLabel.id = 'history-archive-size';
  const clearBtn = el('button', { class: 'btn-mini danger' }, 'Clear archive');
  clearBtn.addEventListener('click', async () => {
    if (!await asyncConfirm('Clear the entire history archive? This cannot be undone.')) return;
    try {
      const r = await window.api.stateArchiveClear();
      if (r && r.ok) {
        if (typeof toast === 'function') toast('Archive cleared.', 'ok', 2500);
        await _refreshSize();
      } else {
        alert('Clear failed: ' + ((r && r.error) || 'unknown'));
      }
    } catch (e) {
      alert('Clear failed: ' + (e && e.message ? e.message : String(e)));
    }
  });
  const openBtn = el('button', { class: 'btn-mini' }, 'Open archive…');
  openBtn.addEventListener('click', async () => {
    if (window.ArchiveViewer && typeof window.ArchiveViewer.open === 'function') {
      window.ArchiveViewer.open();
    } else {
      alert('Archive viewer not loaded. Try again after restarting the app.');
    }
  });
  archiveBox.append(sizeLabel, openBtn, clearBtn);
  root.appendChild(archiveBox);

  async function _refreshSize() {
    if (!window.api || typeof window.api.stateArchiveSize !== 'function') return;
    try {
      const r = await window.api.stateArchiveSize();
      if (r && r.ok) {
        sizeLabel.textContent = 'Size: ' + _humanBytes(r.bytes) + (r.bytes > 0 ? ` (${r.bytes} B)` : '');
      }
    } catch (_) { /* best-effort */ }
  }
  _refreshSize();

  return {
    root,
    instance: {
      collect() {
        // L2 cap is persisted to state.json via scheduleStateSave
        // on the change event. We don't need to return anything
        // here; the Save handler reads state.jobsArchiveCap.
        return {};
      },
      onShow() {
        // Re-read the size every time the user opens this pane.
        _refreshSize();
      },
    },
  };
}

function _humanBytes(n) {
  if (typeof n !== 'number' || n < 0) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function buildSettingsShortcutsPane() {
  // Read-only keyboard shortcut reference. Lives in the
  // settings dialog so the user doesn't have to dig through
  // the README.
  const root = el('div', {});
  root.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
    'Keyboard shortcuts work from anywhere in the app except while typing in a text field.'));
  const box = el('div', { class: 'shortcuts-box' });
  box.appendChild(el('h4', {}, '⌨ Keyboard shortcuts'));
  // KGO-022 fix: provide a hardcoded fallback so the list is never empty
  // if GlobalShortcutRegistry fails to load.
  const FALLBACK_SHORTCUTS = [
    ['Ctrl+Enter', 'Generate on the active tab'],
    ['Ctrl+1 / 2 / 3 / 4 / 5', 'Switch to Image / Speech / Music / Video / Other APIs'],
    ['Ctrl+B', 'Open BatchGen for the active tab'],
    ['Ctrl+F', 'Focus the file-browser filter'],
    ['Ctrl+P', 'Open or focus the Image Pipeline'],
    ['Ctrl+E', 'Open or focus the Image Editor'],
  ];
  const shortcuts = (window.GlobalShortcutRegistry && typeof window.GlobalShortcutRegistry.getSettingsList === 'function')
    ? window.GlobalShortcutRegistry.getSettingsList()
    : FALLBACK_SHORTCUTS;
  for (const [keys, desc] of shortcuts) {
    box.appendChild(el('div', { class: 'shortcut-row' }, [
      el('kbd', {}, keys),
      el('span', {}, desc),
    ]));
  }
  box.appendChild(el('div', { style: 'font-size: 11px; color: var(--fg-3); margin-top: 6px; font-style: italic;' }, 'Note: Image Editor has its own shortcuts; press ? inside the editor for details.'));
  root.appendChild(box);
  return { root, instance: null };
}

// Issue-3: dedicated "External tools" tab. Lets the user point the
// file-browser context menu at 3rd-party .exe files (GIMP, Photoshop,
// Notepad++, Audacity, a custom batch processor, …). The actual spawn
// happens in the main process via `externalTools:run`; this pane only
// maintains the persisted config (`state.config.external_tools`).
//
// Before the Issue-3 restructure this editor lived inside the Add-ons
// pane; the Real-ESRGAN / IS-Net installers that shared that pane moved
// into the merged "Image & Add-ons" tab (buildSettingsImageAddonsPane).
// The editor is intentionally pattern-matched after the Style presets
// pane: same row layout, same Save-button flow, same self-contained
// helpers (so it can't accidentally rely on closures from elsewhere in
// the app). The only difference is the per-row "Test" button, which
// calls `externalTools:probe` to verify the .exe still exists and is
// launchable.
function buildSettingsExternalToolsPane() {
  const root = el('div', {});
  root.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
    '3rd-party programs (GIMP, Photoshop, Notepad++, Audacity, …) reachable from the file-browser context menu and the image editor\'s hand-off. Each tool launches with the selected file path(s) appended as the last argument(s).'));

  // ---- External tools editor (H7-016) ----
  // The "Manage tools…" entry in the file-browser context menu and the image
  // editor's "open in external editor" both read state.config.external_tools.
  // This editor closes the loop: add / edit / delete + a "Test" button that
  // probes the configured .exe without launching it.
  root.appendChild(el('h4', { class: 'settings-group-title' }, '🔧 External tools'));
  const toolsListHost = el('div', { class: 'external-tools-list' });
  root.appendChild(toolsListHost);
  // R3.3.AuditFix-PP-2: use module via globalThis (set by section04); fall back to inline if missing.
  const H = (typeof globalThis !== 'undefined' && globalThis.ExternalToolsHelpers) ? globalThis.ExternalToolsHelpers : {
    v: (d) => { const e = [], s = new Set(); for (let i = 0; i < d.length; i++) { const n = (d[i] && d[i].name || '').trim().toLowerCase();
      if (n && s.has(n)) e.push('Two external tools share the same display name: "' + d[i].name.trim() + '" (case-insensitive).'); else if (n) s.add(n); } return e; },
    a: (c, p) => (c && c.trim()) ? null : (String(p || '').split(/[\\/]/).pop() || '').replace(/\.exe$/i, ''),
    d: (n, i, d) => { const x = (n || '').trim().toLowerCase(); return x ? d.some((t, j) => j !== i && (t && t.name || '').trim().toLowerCase() === x) : false; } };
  // Work on a local copy so Cancel abandons changes; Save (the Settings
  // Save button) reads the collected array.
  let toolsDraft = Array.isArray(state.config && state.config.external_tools)
    ? state.config.external_tools.map((t) => ({ name: t.name || '', exe: t.exe || '', args: t.args || '' }))
    : [];

  function renderToolsList() {
    toolsListHost.innerHTML = '';
    if (toolsDraft.length === 0) {
      toolsListHost.appendChild(el('p', { style: 'color: var(--fg-3); font-size: 12px;' }, 'No external tools configured. Click "Add tool" to add one.'));
    }
    toolsDraft.forEach((tool, idx) => {
      const row = el('div', { class: 'row external-tool-row' });
      const nameInput = el('input', { type: 'text', value: tool.name, placeholder: 'Display name (e.g. GIMP)', title: 'The name shown in the file-browser context menu' });
      const exeInput = el('input', { type: 'text', value: tool.exe, placeholder: 'C:\\Program Files\\GIMP\\bin\\gimp.exe', title: 'Absolute path to the .exe' });
      const argsInput = el('input', { type: 'text', value: tool.args, placeholder: '(optional extra args, e.g. -n)', title: 'Extra command-line arguments (optional)' });
      // R3.3.AuditFix-PP: name-duplicate visual flag.
      nameInput.addEventListener('input', () => {
        toolsDraft[idx].name = nameInput.value;
        nameInput.classList.toggle('invalid', H.d(nameInput.value, idx, toolsDraft));
      });
      exeInput.addEventListener('input', () => { toolsDraft[idx].exe = exeInput.value; });
      argsInput.addEventListener('input', () => { toolsDraft[idx].args = argsInput.value; });
      const st = (window.ExternalToolStatus && window.ExternalToolStatus.create) ? window.ExternalToolStatus.create() : null;
      const statusLbl = st ? st.statusLbl : el('div', {});
      const browseBtn = el('button', { class: 'btn-mini', title: 'Pick the external tool .exe…' }, '…');
      browseBtn.addEventListener('click', async () => {
        try {
          const p = await window.api.pickFile({ title: 'Select the external tool .exe', filters: [{ name: 'Executable', extensions: ['exe'] }] });
          if (p && p.ok && p.path) {
            exeInput.value = p.path; toolsDraft[idx].exe = p.path;
            const auto = H.a(nameInput.value, p.path);
            if (auto) { nameInput.value = auto; toolsDraft[idx].name = auto; }
            if (st) st.probeAndShow(p.path);
          }
        } catch (_) {}
      });
      const testBtn = el('button', { class: 'btn-mini', title: 'Verify the .exe exists without launching it' }, 'Test');
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true; testBtn.textContent = '…';
        try { if (st) await st.probeAndShow(toolsDraft[idx].exe); }
        finally { testBtn.disabled = false; testBtn.textContent = 'Test'; }
      });
      const delBtn = el('button', { class: 'btn-mini', title: 'Remove this tool' }, '✎ Del');
      delBtn.addEventListener('click', () => { toolsDraft.splice(idx, 1); renderToolsList(); });
      row.appendChild(el('label', { for: undefined }, [
        el('div', { class: 'combo', style: 'flex-wrap: wrap; gap: 4px;' }, [nameInput, exeInput, argsInput, el('div', { style: 'display: flex; gap: 4px;' }, [browseBtn, testBtn, delBtn])]),
        statusLbl,
      ]));
      toolsListHost.appendChild(row);
    });
  }
  renderToolsList();
  const addToolBtn = el('button', { class: 'btn-mini' }, '+ Add tool');
  addToolBtn.addEventListener('click', () => {
    toolsDraft.push({ name: '', exe: '', args: '' });
    renderToolsList();
  });
  root.appendChild(el('div', { class: 'row' }, [el('label', {}, ' '), addToolBtn]));

  return {
    root,
    instance: {
      collect: () => ({
        // Drop entries with no name or no exe so config.txt stays clean — mirrors sanitizeExternalTools.
        external_tools: toolsDraft
          .filter((t) => t && (t.name || '').trim() && (t.exe || '').trim())
          .map((t) => ({ name: String(t.name).trim(), exe: String(t.exe).trim(), args: String(t.args || '').trim() })),
      }),
      // R3.3.AuditFix-PP: validate() returns human-readable error messages (UI-009).
      validate: () => H.v(toolsDraft),
    },
  };
}

function buildSettingsPipelinePane() {
  const root = el('div', {});
  root.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
    'Audio output format for the cutter and pipeline.'));

  // ---- Format whitelists ----
  root.appendChild(el('h4', { class: 'settings-group-title' }, '🔊 Audio Output Format'));
  const fmtHelp = el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px; margin: 4px 0 8px;' },
    'The output format used when exporting audio from the cutter and pipeline.');
  root.appendChild(fmtHelp);
  
  const audioFmtSel = el('select', {});
  for (const [val, lbl] of [['wav', 'WAV (lossless)'], ['mp3', 'MP3 (lossy)'], ['ogg', 'OGG (Vorbis)'], ['m4a', 'M4A (AAC)']]) {
    const opt = el('option', { value: val }, lbl);
    if (state.autoCutSettings && state.autoCutSettings.format === val) opt.selected = true;
    audioFmtSel.appendChild(opt);
  }
  root.appendChild(el('div', { class: 'row' }, [
    el('label', {}, 'Audio Output Format'), audioFmtSel,
  ]));

  // (H7-018) The Remove.bg/ClipDrop API-key field that used to live here was
  // removed: no execution path consumed it, so collecting the secret was
  // misleading dead UI. Local background removal (IS-Net/BiRefNet) is the
  // only cloud-pipeline feature actually wired up. If a real Remove.bg
  // integration is added later, re-add a dedicated client here.

  return {
    root,
    instance: {
      collect: () => {
        if (state.autoCutSettings) state.autoCutSettings.format = audioFmtSel.value;
        return {};
      }
    }
  };
}

