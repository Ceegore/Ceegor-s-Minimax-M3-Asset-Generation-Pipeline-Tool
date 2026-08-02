/* renderer/app.js — UI logic, no build step. */
// We use globals (window.api from preload) to stay build-free.

// Tool version: stamped from package.json via window.api.getAppVersion()
// at startup, so the renderer shows the version that ships in package.json.
// Issue-9: version reset to 1.0.0 — kept at 1.0.0 for all further
// iteration until release.
let BUILD_VERSION = 'v1.0.0';
const TOOL_NAME = 'MiniMax Asset Tool';
const TOOL_INFO =
  'Generate images, speech, music, and video with MiniMax and other supported AI providers—one asset or a complete imported batch. ' +
  'Send images through a visual local pipeline for upscaling, background removal, cropping, resizing, and optimization/conversion, then finish them in the built-in Image Editor and Asset Composer.\n\n' +
  'Style presets, an integrated file browser, audio trimming, job controls, and automatic pipeline hand-off keep the whole asset workflow in one app. ' +
  'Supports MiniMax Token Plan and pay-as-you-go API keys.';

// `var` (not `const`): top-level `const` in a <script> tag is NOT global.
// Section files (loaded BEFORE app.js) call `$`/`$$`/`TABS`, so these
// must be real globals visible across every <script> tag.
var $ = (sel, root = document) => root.querySelector(sel);
var $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ----------------- Tabs -----------------
// Reference the shared container the tab files already populated. `var`
// here would clobber window.TABS; assigning the existing reference keeps
// changes to TABS propagating to window.TABS.
var TABS = window.TABS;

// ----------------- Bootstrap on DOM ready -----------------
// Renderer-side init(): wires up tabs, file browser, log bar, settings,
// theme, and bootstraps each tab's build(). All section files load
// BEFORE this script (see index.html order), so the helpers (state,
// showTab, refreshBrowser, etc.) are already defined by the time we run.
async function init() {
  // Wire tabs
  for (const t of $$('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
  // The file browser's Up button navigates through four levels,
  // disabling itself at the bottom:
  //   1) A real folder inside output_dir -> one level up
  //   2) output_dir itself               -> one level up (parentDir)
  //   3) A drive root                    -> the DRIVES list
  //   4) The DRIVES list                 -> DISABLED (no-op)
  const FB_DRIVES_SENTINEL = '__DRIVES__';
  function isDrivesList() { return state.fbDir === FB_DRIVES_SENTINEL; }
  // FUNC-003: cached canonical browser root resolved from the main process.
  // When config.output_dir is blank the main process owns the effective
  // default (<userData>/generated). We cache it here so the synchronous
  // isAtOutputRoot() and Up-button handler always have the canonical value
  // even before the async boot resolution completes.
  let _effectiveOutputRoot = '';
  // Detect a drive root by path shape (platform-agnostic). The
  // renderer runs with contextIsolation on and nodeIntegration off,
  // so `process.platform` is not available; matching the path string
  // avoids that dependency. Windows roots look like `C:\`, `C:/`, `C:`;
  // POSIX roots look like `/`; UNC roots (`\\server\share`) are not
  // drive roots.
  function isDriveRoot(p) {
    if (!p) return false;
    const s = String(p).replace(/[\\/]+$/, '');
    if (!s) return false;
    if (/^[A-Za-z]:[\\\/]?$/.test(s)) return true;     // Windows: C:\, D:/, C:
    if (s === '/') return true;                          // POSIX root
    return false;
  }
  // KGO7-007: output_dir is the browse CEILING (the S1 model removed
  // `fb:trust-ancestors`, so fb:list on the parent is rejected).
  // FUNC-003: prefer the live config value (reflects Settings changes);
  // fall back to the cached _effectiveOutputRoot (resolved from main at
  // boot) only when config is blank — so the ceiling holds on fresh install.
  function isAtOutputRoot() {
    const outRoot = (state.config && state.config.output_dir) || _effectiveOutputRoot || '';
    return !!outRoot && !!state.fbDir && String(state.fbDir).toLowerCase() === String(outRoot).toLowerCase();
  }
  function updateFbUpButton() {
    const btn = $('#fb-up');
    if (!btn) return;
    if (isDrivesList()) {
      btn.disabled = true;
      btn.classList.add('fb-up-disabled');
      btn.title = 'You are at the drives list. Pick a drive to continue.';
    } else if (isAtOutputRoot()) {
      btn.disabled = true;
      btn.classList.add('fb-up-disabled');
      btn.title = 'This is your output folder — the highest level the app may browse. Use 📂 Folder… to authorise a different directory.';
    } else {
      btn.disabled = false;
      btn.classList.remove('fb-up-disabled');
      btn.title = 'Up one level';
    }
  }
  // refreshBrowser() re-enables #fb-up on every refresh, so it must be
  // able to re-apply this rule afterwards.
  window.updateFbUpButton = updateFbUpButton;
  // Wrap the click handler so a synchronous throw (or an async
  // refreshBrowser rejection) reaches the log pane and the error log
  // instead of disappearing silently. The handler body stays inline so
  // the fbUpButtonBehavior test extraction still matches.
  $('#fb-up').addEventListener('click', () => {
    // Log the click BEFORE the handler runs so a breadcrumb is present
    // even if the handler ends up a no-op.
    if (typeof window.logAction === 'function') {
      window.logAction('file-browser', 'click-up', { fbDir: state.fbDir || '', output_dir: state.config.output_dir || '' });
    }
    try {
      // Disabled at the drives list — a drive must be picked
      // first to continue. The button is also disabled visually
      // (CSS .fb-up-disabled + .title) but a stale click could
      // still reach this handler; the early-return is the
      // authoritative guard.
      if (isDrivesList()) {
        if (typeof window.logAction === 'function') window.logAction('file-browser', 'up-noop', { reason: 'drives-list' });
        return;
      }
      // FUNC-003: prefer the live config value; fall back to cached root.
      const outRoot = state.config.output_dir || _effectiveOutputRoot || '';
      // When no folder has been opened yet (e.g. a fresh install
      // where a prompt was typed and Generate hit), jump
      // to output_dir (always a real folder via the defaultOutputDir
      // fallback in fileBrowser1.refreshBrowser), or to the drives
      // list when there's no output_dir either. The button should
      // always do something visible.
      if (!state.fbDir) {
        if (typeof window.logAction === 'function') window.logAction('file-browser', 'up-empty-fbdir', { to: outRoot ? 'output_dir' : 'drives-sentinel' });
        if (outRoot) {
          state.fbDir = outRoot;
        } else {
          state.fbDir = FB_DRIVES_SENTINEL;
        }
        refreshBrowser();
        updateFbUpButton();
        return;
      }
      if (outRoot && state.fbDir.toLowerCase() === outRoot.toLowerCase()) {
        // KGO7-007: the old code computed parentDir() and called
        // `window.api.fbTrustAncestors(up)` — a binding that does NOT
        // exist (removed with `fb:trust-ancestors` by the S1 model; see
        // tests/unit/security/setActiveDir.security.test.js). Guarded by
        // `typeof … === 'function'` it was a permanent no-op, so fb:list
        // on the parent was rejected and refreshBrowser() reverted: the
        // click "did nothing" while the button looked enabled.
        if (typeof window.logAction === 'function') window.logAction('file-browser', 'up-at-output-root', { to: 'blocked', reason: 'output_dir is the browse ceiling' });
        if (typeof toast === 'function') toast('This is your output folder — the highest level the app may browse. Use the 📂 Folder… button to authorise a different directory.', 'warn', 6000);
        updateFbUpButton();
        return;
      }
      if (isDriveRoot(state.fbDir)) {
        // Already at a drive root, jumping up further means
        // the drives list (you can't go above a drive root).
        if (typeof window.logAction === 'function') window.logAction('file-browser', 'up-drive-root', { to: 'drives-sentinel' });
        state.fbDir = FB_DRIVES_SENTINEL;
        refreshBrowser({ keepCurrent: true });
        updateFbUpButton();
        return;
      }
      // Normal mid-tree case: one level up.
      const up = parentDir(state.fbDir) || outRoot || FB_DRIVES_SENTINEL;
      if (typeof window.logAction === 'function') window.logAction('file-browser', 'up-climb', { from: state.fbDir, to: up });
      // KGO7-007: the `window.api.fbTrustAncestors(up)` call that used to
      // sit here was removed — the binding does not exist (see the
      // output-root branch above). Climbing WITHIN an authorised subtree
      // works without it; climbing out of one is meant to be refused.
      window.__explicitFbDirNav = up;
      state.fbDir = up;
      refreshBrowser({ keepCurrent: true })
        .then(() => {
          if (typeof window.logAction === 'function') window.logAction('file-browser', 'up-refresh-ok', { fbDir: state.fbDir });
        })
        .catch((e) => {
          // Surface async refreshBrowser failure so the file log
          // explains why the click "did nothing".
          if (typeof window.logError === 'function') {
            window.logError('fb-up-refresh', 'renderer/app.js:fb-up-refreshBrowser', e);
          }
          if (typeof window.logAction === 'function') {
            window.logAction('file-browser', 'up-refresh-err', { fbDir: state.fbDir, err: String((e && e.message) || e) });
          }
        });
      updateFbUpButton();
    } catch (e) {
      // Don't swallow. Log to the in-app pane AND the file log so
      // the failure is diagnosable.
      if (typeof window.logError === 'function') {
        window.logError('fb-up', 'renderer/app.js:fb-up-click', e);
      } else {
        console.error('fb-up click threw:', e);
      }
    }
  });
  updateFbUpButton();
  // File browser live filter
  const fbSearch = $('#fb-search');
  if (fbSearch) fbSearch.addEventListener('input', (e) => {
    // Breadcrumb per keystroke, rate-limited (every 5th keystroke)
    // to avoid spamming the file log on a fast typer.
    if (typeof window.logAction === 'function') {
      const v = e && e.target ? e.target.value : '';
      if (v.length === 0 || v.length % 5 === 0 || v.length > 50) {
        window.logAction('file-browser', 'filter-input', { len: v.length });
      }
    }
    (window.applyFileSearch || applyFileSearch)();
  });
  // Asset-type filter (Images / Audio / Video / Text). Re-apply
  // the live filter on change so the list shrinks / expands to
  // match the new type.
  const fbTypeFilter = $('#fb-type-filter');
  if (fbTypeFilter) {
    fbTypeFilter.value = state.fbTypeFilter || '';
    fbTypeFilter.addEventListener('change', () => {
      state.fbTypeFilter = fbTypeFilter.value;
      if (typeof window.logAction === 'function') {
        window.logAction('file-browser', 'type-filter', { value: fbTypeFilter.value || '(all)' });
      }
      scheduleStateSave();
      (window.applyFileSearch || applyFileSearch)();
    });
  }
  // Sort dropdown change handler: re-render the list with the
  // new mode by sorting the in-memory snapshot (state._fbItems)
  // via the shared FbSort helper. Re-applies the live search
  // filter so a sort + filter combo shows the right subset.
  const fbSort = $('#fb-sort');
  if (fbSort) {
    fbSort.value = state.fbSort || 'name-asc';
    fbSort.addEventListener('change', () => {
      state.fbSort = fbSort.value;
      if (typeof window.logAction === 'function') {
        window.logAction('file-browser', 'sort-change', { mode: fbSort.value });
      }
      scheduleStateSave();
      if (Array.isArray(state._fbItems) && state._fbItems.length) {
        const sorted = window.FbSort
          ? window.FbSort.sortFbItems(state._fbItems, state.fbSort)
          : sortFbItems(state._fbItems, state.fbSort);
        renderFbList(sorted);
        (window.applyFileSearch || applyFileSearch)();
      }
    });
  }
  $('#fb-refresh').addEventListener('click', () => {
    if (typeof window.logAction === 'function') window.logAction('file-browser', 'click-refresh', { fbDir: state.fbDir || '' });
    refreshBrowser();
  });
  $('#fb-new').addEventListener('click', () => {
    if (typeof window.logAction === 'function') window.logAction('file-browser', 'click-new-folder', { fbDir: state.fbDir || '' });
    promptNewFolder();
  });
  $('#fb-open').addEventListener('click', async () => {
    const target = state.fbDir || state.config.output_dir || '';
    if (typeof window.logAction === 'function') window.logAction('file-browser', 'click-open-explorer', { target });
    const _rg = (window.GrantHelper) ? await window.GrantHelper.ensureRead(target) : undefined;
    window.api.fbReveal(target, _rg);
  });
  // "⚙ Options" button (folder columns / thumbnails). The handler
  // (openFolderOptions in fileBrowser1.js) opens the matching modal
  // via showModal.
  const fbOptionsBtn = $('#fb-options');
  if (fbOptionsBtn) fbOptionsBtn.addEventListener('click', () => {
    if (typeof window.logAction === 'function') window.logAction('file-browser', 'click-options');
    if (typeof openFolderOptions === 'function') openFolderOptions();
  });
  // 📂 button: opens the native folder picker so the user can
  // browse any drive / folder (the "Up" button only climbs inside
  // output_dir, so it can't reach a different drive). The picked
  // path is auto-added to the IPC allow-list so subsequent reads /
  // writes / moves work without any extra "allow" gesture.
  $('#fb-pick').addEventListener('click', async () => {
    if (typeof window.logAction === 'function') window.logAction('file-browser', 'click-pick-folder');
    const picked = await window.api.pickFolder();
    if (!picked) {
      if (typeof window.logAction === 'function') window.logAction('file-browser', 'pick-cancelled');
      return;
    }
    if (typeof window.logAction === 'function') window.logAction('file-browser', 'picked', { path: picked });
    state.fbDir = picked;
    if (state.currentTab) state.fbDirs[state.currentTab] = picked;
    scheduleStateSave();
    refreshBrowser();
  });

  // Bulk-action toolbar wiring. The toolbar is rendered statically
  // in index.html (so the layout is predictable) and toggled
  // visible/hidden by the 'fb-selection-changed' custom event fired
  // from fileBrowser1.js. The master checkbox tri-state: checked
  // when every visible item is in state.fbSelected, indeterminate
  // when some are, unchecked when none are. Move / Copy / Trim /
  // Delete all delegate to the shared `fbBulkAction(label, op)`
  // worker in fileBrowser1.
  const fbBulkToolbar = $('#fb-bulk-toolbar');
  const fbBulkCount = $('#fb-bulk-count');
  const fbBulkMasterCb = $('#fb-bulk-master-cb');
  function _refreshBulkToolbar() {
    const sel = state.fbSelected || new Set();
    const n = sel.size;
    if (fbBulkToolbar) fbBulkToolbar.style.display = n > 0 ? '' : 'none';
    if (fbBulkCount) fbBulkCount.textContent = `${n} selected`;
    // Tri-state the master checkbox.
    if (fbBulkMasterCb) {
      const total = Array.isArray(state._fbItems) ? state._fbItems.length : 0;
      if (n === 0) { fbBulkMasterCb.checked = false; fbBulkMasterCb.indeterminate = false; }
      else if (n >= total && total > 0) { fbBulkMasterCb.checked = true; fbBulkMasterCb.indeterminate = false; }
      else { fbBulkMasterCb.checked = false; fbBulkMasterCb.indeterminate = true; }
    }
    // Highlight the matching rows so the user can scan the
    // selection at a glance. We toggle the class instead of
    // re-rendering so the scroll position / hover state isn't
    // disturbed.
    for (const li of $$('.fb-item[data-path]')) {
      const p = li.getAttribute('data-path');
      if (p && sel.has(p)) li.classList.add('fb-selected-row');
      else li.classList.remove('fb-selected-row');
    }
  }
  window.addEventListener('fb-selection-changed', _refreshBulkToolbar);
  // Run once on init so the toolbar starts in the right state
  // (hidden). Fires on every subsequent selection change.
  _refreshBulkToolbar();
  if (fbBulkMasterCb) {
    fbBulkMasterCb.addEventListener('change', () => {
      if (fbBulkMasterCb.checked) {
        (window.fbSelectAll || (() => {}))();
      } else {
        (window.fbClearSelection || (() => {}))();
      }
    });
  }
  $('#fb-bulk-clear').addEventListener('click', () => {
    (window.fbClearSelection || (() => {}))();
  });
  $('#fb-bulk-move').addEventListener('click', () => {
    if (!state.fbSelected || state.fbSelected.size === 0) return;
    const dest = state.fbDir || state.config.output_dir || '';
    if (!dest) { toast('No destination folder.', 'err'); return; }
    (window.fbBulkAction || (() => {}))('Move', async (path) => {
      // BGR-009 fix: mint move grant (R1.3 gate).
      // gewv2 GEW-002 fix: ensureMove now returns { ok, srcGrant, destGrant }
      // (dual grants when src/destDir don't share a trusted common ancestor).
      const mv = (window.GrantHelper) ? await window.GrantHelper.ensureMove(path, dest) : undefined;
      if (mv && mv.ok === false) throw new Error(mv.error || 'move grant failed');
      const r = await window.api.fbMove(path, dest, mv && mv.srcGrant, mv && mv.destGrant);
      if (!r || !r.ok) throw new Error((r && r.error) || 'move failed');
    });
  });
  $('#fb-bulk-copy').addEventListener('click', () => {
    if (!state.fbSelected || state.fbSelected.size === 0) return;
    const dest = state.fbDir || state.config.output_dir || '';
    if (!dest) { toast('No destination folder.', 'err'); return; }
    (window.fbBulkAction || (() => {}))('Copy', async (path) => {
      // BGR-009 fix: mint copy grant (R1.3 gate).
      // gewv2 GEW-002 fix: ensureCopy now returns { ok, srcGrant, destGrant }.
      const cp = (window.GrantHelper) ? await window.GrantHelper.ensureCopy(path, dest) : undefined;
      if (cp && cp.ok === false) throw new Error(cp.error || 'copy grant failed');
      const r = await window.api.fbCopy(path, dest, cp && cp.srcGrant, cp && cp.destGrant);
      if (!r || !r.ok) throw new Error((r && r.error) || 'copy failed');
    });
  });
  $('#fb-bulk-trim').addEventListener('click', () => {
    if (!state.fbSelected || state.fbSelected.size === 0) return;
    const paths = Array.from(state.fbSelected);
    const audioExts = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.opus', '.pcm', '.aac', '.wma', '.aif', '.aiff'];
    const audioPaths = paths.filter((p) => audioExts.includes('.' + (p.split('.').pop() || '').toLowerCase()));
    if (!audioPaths.length) { toast('None of the selected files are audio. The audio cutter only works on .mp3/.wav/.flac/etc.', 'warn', 5000); return; }
    // H-048 (_5 audit): the audio cutter is an interactive SINGLE-file
    // editor. The old bulk path opened the cutter for the first audio
    // file only, yet fbBulkAction counted EVERY selected path as a
    // success ("N items ok") — a misleading bulk-trim that silently
    // skipped files. Until a real batch trim exists (one shared settings
    // dialog + sequential audioCut with a per-file result), the action is
    // gated to exactly one audio file and renamed "Audio cutter".
    if (audioPaths.length !== 1) {
      toast(`The audio cutter edits one file at a time. Select exactly one audio file (you have ${audioPaths.length}).`, 'warn', 6000);
      return;
    }
    if (typeof window.showAudioCutter === 'function') {
      window.showAudioCutter(audioPaths[0]);
    } else {
      toast('Audio cutter module not loaded.', 'err');
    }
  });
  $('#fb-bulk-delete').addEventListener('click', () => {
    if (!state.fbSelected || state.fbSelected.size === 0) return;
    (window.fbBulkAction || (() => {}))('Delete', async (path) => {
      // BGR-009 fix: mint delete grant (R1.3 gate).
      const deleteGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(path) : undefined;
      const r = await window.api.fbDelete(path, deleteGrant);
      if (!r || !r.ok) throw new Error((r && r.error) || 'delete failed');
    });
  });
  $('#quota-refresh').addEventListener('click', () => refreshQuota());
  $('#btn-styles').addEventListener('click', () => openStyleSettings());
  $('#btn-theme').addEventListener('click', () => toggleTheme());
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-image-edit').addEventListener('click', () => {
    // No pre-selected image → open the editor empty; the user picks a file inside.
    if (typeof window.showImageEditOverlay === 'function') window.showImageEditOverlay(null, null);
    else toast('Image editor not loaded.', 'err', 4000);
  });
  // Issue-10: clicking the header brand re-shows the welcome/startup
  // popup on demand. showStartupPopup() internally passes force:true to
  // openGatedPopup, so it opens regardless of the popup policy or any
  // earlier dismissal — exactly what an explicit user click should do.
  const brandEl = $('.brand');
  if (brandEl) {
    brandEl.title = 'Show the welcome message again';
    // QA-016: keyboard accessibility for the brand/welcome trigger.
    brandEl.tabIndex = 0;
    brandEl.setAttribute('role', 'button');
    brandEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); brandEl.click(); }
    });
    brandEl.addEventListener('click', () => {
      // QA-017 fix: force:true so an explicit click bypasses popup policy.
      if (typeof showStartupPopup === 'function') showStartupPopup({ force: true });
    });
  }

  // Log bar
  const logDetails = $('#logbar details');
  const logCopyBtn = $('#log-copy');
  const logClearBtn = $('#log-clear');
  const logToggleBtn = $('#log-toggle');
  // Log "?" help button. Wire it directly to the centralized help
  // system (the generic [data-help-topic] click delegation is not
  // installed). It lives inside the <summary>, so the click must be
  // stopped from toggling the <details> collapse (same pattern as
  // the other log buttons).
  const logHelpBtn = $('#log-help');
  if (logHelpBtn) {
    // The `?` icon is hover-only: the `data-help` attribute on
    // #log-help lets HelpTooltip show the help text on mouseover
    // (no click handler, no modal). The no-op listener calls
    // preventDefault so the button doesn't behave like a submit
    // button if it ever ends up inside a <form> by accident.
    logHelpBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }
  function _syncLogToggleLabel() {
    if (!logToggleBtn || !logDetails) return;
    logToggleBtn.textContent = logDetails.open ? '▼ Collapse' : '▲ Expand';
  }
  if (logDetails) logDetails.addEventListener('toggle', _syncLogToggleLabel);
  if (logToggleBtn) {
    logToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!logDetails) return;
      logDetails.open = !logDetails.open;
      _syncLogToggleLabel();
    });
  }
  if (logClearBtn) {
    logClearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const logEl = $('#log');
      if (logEl) logEl.textContent = '';
      toast('Log cleared.', 'ok', 1500);
    });
  }
  if (logCopyBtn) {
    logCopyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const txt = $('#log')?.textContent || '';
      if (!txt) { toast('Log is empty.', 'warn'); return; }
      try {
        await navigator.clipboard.writeText(txt);
        toast('Log copied to clipboard.', 'ok', 1500);
      } catch (err) {
        const range = document.createRange();
        range.selectNodeContents($('#log'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        toast('Copy failed — log text selected, press Ctrl+C to copy.', 'warn', 4000);
      }
    });
  }
  _syncLogToggleLabel();

  // Picture preview pane
  const previewClearBtn = $('#preview-clear');
  if (previewClearBtn) {
    previewClearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const content = $('#fb-preview-content');
      if (!content) return;
      content.innerHTML = '<div class="preview-pane-empty">Click an image in the file browser to preview it here.</div>';
    });
  }

  // Config
  // SEC-001: use secret-free DTO (no raw api_key crosses IPC).
  const _cfgPublic = await window.api.getConfigPublic();
  state.config = {
    hasApiKey: !!(_cfgPublic && _cfgPublic.hasApiKey),
    apiKeyLast4: (_cfgPublic && _cfgPublic.apiKeyLast4) || '',
    output_dir: (_cfgPublic && _cfgPublic.output_dir) || '',
    report_dir: (_cfgPublic && _cfgPublic.report_dir) || '',
    region: (_cfgPublic && _cfgPublic.region) || 'global',
    theme: (_cfgPublic && _cfgPublic.theme) || 'dark',
    // H-046: safe numeric cost-cap field — without it batchManager's gate
    // computed parseInt(undefined) || 200 and ignored the configured cap.
    batch_max_units: (_cfgPublic && Number.isFinite(parseInt(_cfgPublic.batch_max_units, 10))) ? parseInt(_cfgPublic.batch_max_units, 10) : 200,
    styles: (_cfgPublic && Array.isArray(_cfgPublic.styles)) ? _cfgPublic.styles : [],
    external_tools: (_cfgPublic && Array.isArray(_cfgPublic.external_tools)) ? _cfgPublic.external_tools : [],
  };
  if (!Array.isArray(state.config.styles)) state.config.styles = [];
  if (!state.config.theme) state.config.theme = 'dark';
  applyTheme(state.config.theme);
  // Log what config.txt actually contains (masked API key) so the
  // file log captures the boot state without DevTools.
  if (typeof window.logAction === 'function') {
    const c = state.config || {};
    window.logAction('boot', 'config-loaded', {
      api_key_set: !!c.hasApiKey,
      output_dir: c.output_dir || '(empty)',
      region: c.region || '(empty)',
      theme: c.theme || '(empty)',
      styles: Array.isArray(c.styles) ? c.styles.length : 0,
    });
  }
  if (!state.config.hasApiKey) {
    toast('No API key. Click ⚙ to add one.', 'warn', 6000);
  }

  // Build tabs (assign ids + load saved state + start autosave)
  const savedState = await window.api.stateGet() || {};
  state.tabSettings = savedState.tabs || {};
  // Log which persisted keys came back from disk so a bug like
  // "popupPolicy silently reset to default" leaves a breadcrumb
  // in renderer-error.log.
  if (typeof window.logAction === 'function') {
    const present = Object.keys(savedState || {}).filter((k) => savedState[k] != null);
    window.logAction('boot', 'state-loaded', {
      keys: present.join(',') || '(empty)',
      popupPolicy: String(savedState.popupPolicy || '(default)'),
      lastSeenVersion: String(savedState.lastSeenVersion || '(none)'),
      currentTab: String(savedState.currentTab || '(none)'),
      seenPopups: Object.keys(savedState.seenPopups || {}).length,
    });
  }
  // Round-trip every persisted key through the canonical
  // STATE_PERSIST_KEYS list (defined in section24_State.js). Loading
  // only a subset silently drops the rest on restart.
  const persistKeys = window.STATE_PERSIST_KEYS || [];
  for (const k of persistKeys) {
    if (k === 'fbDirs' || k === 'currentTab') continue; // handled below
    if (savedState[k] === undefined || savedState[k] === null) continue;
    state[k] = savedState[k];
  }
  // Now that the persist-keys loop has populated state.jobsSnapshot
  // from disk, render the "previous session" rows at the bottom of
  // the log pane. Must run after the disk state is in memory.
  try {
    if (window.LogService && typeof window.LogService.renderPersistedL2 === 'function'
        && Array.isArray(state.jobsSnapshot)) {
      window.LogService.renderPersistedL2(state.jobsSnapshot);
    }
  } catch (e) { console.warn('renderPersistedL2 failed:', e); }
  if (savedState.fbDirs && typeof savedState.fbDirs === 'object') {
    for (const k of ['image', 'speech', 'music', 'video']) {
      if (typeof savedState.fbDirs[k] === 'string') state.fbDirs[k] = savedState.fbDirs[k];
    }
  }
  const startTab = (savedState.currentTab && ['image','speech','music','video'].includes(savedState.currentTab))
    ? savedState.currentTab : 'image';
  // Seed the CSS variables that the splitter drag handlers write
  // to, from the just-loaded state. The drag handlers attach
  // themselves on DOMContentLoaded (their own IIFE); this call
  // replays the persisted sizes onto the root element so a fresh
  // launch opens with the previous sidebar/logbar/preview widths.
  if (window.SplitterDrag && typeof window.SplitterDrag.applyLayoutSettings === 'function') {
    window.SplitterDrag.applyLayoutSettings();
  }

  // BGR-002 fix: load CapabilityGuard BEFORE the tab build loop so that
  // each tab's build() sees the guard in its loaded state and correctly
  // disables unavailable controls at boot.
  try {
    if (window.api && typeof window.api.diagnose === 'function') {
      const d = await window.api.diagnose();
      if (d && d.cliVersion != null && d.cliSupportedMin && d.cliSupported === false) {
        if (typeof toast === 'function') {
          toast('mmx-cli v' + d.cliVersion + ' is older than the supported v' + d.cliSupportedMin +
            '. Some settings (e.g. video duration/resolution, speech sound-effect) may be silently dropped. Run `npm install -g mmx-cli` to update.',
            'warn', 12000);
        }
      } else if (d && d.capabilityAvailable && d.capability && d.capability.subcommands) {
        const missing = Object.entries(d.capability.subcommands).filter(([, v]) => !v.available).map(([k]) => k);
        if (missing.length > 0 && typeof toast === 'function') toast('mmx-cli: subcommand' + (missing.length > 1 ? 's' : '') + ' unavailable: ' + missing.join(', ') + '. Some generation modes may not work.', 'warn', 10000);
      }
      if (typeof window.logAction === 'function') window.logAction('boot', 'mmx-version', { version: d && d.cliVersion, supported: d && d.cliSupported, capability: d && d.capabilityAvailable });
      if (window.CapabilityGuard) window.CapabilityGuard.setFromDiagnose(d); // R7.2b
    }
  } catch (e) {
    if (typeof window.logWarn === 'function') window.logWarn('boot', 'mmx-version-probe', e);
  }

  for (const tabKey of ['image', 'speech', 'music', 'video']) {
    if (TABS[tabKey] && typeof TABS[tabKey].build === 'function') TABS[tabKey].build();
    assignTabFormIds(tabKey);
    applyTabState(tabKey, state.tabSettings[tabKey] || {});
    setupTabAutosave(tabKey);
  }

  // Load batches
  state.batches = await window.api.batchesGet();
  _refreshBatchButtons();
  if (typeof window.logAction === 'function') {
    window.logAction('boot', 'batches-loaded', {
      image: (state.batches && state.batches.image) ? state.batches.image.length : 0,
      speech: (state.batches && state.batches.speech) ? state.batches.speech.length : 0,
      music: (state.batches && state.batches.music) ? state.batches.music.length : 0,
      video: (state.batches && state.batches.video) ? state.batches.video.length : 0,
    });
  }

  // H-053: if batches.json was unreadable, Main backed it up and blocked
  // batch writes (batches:set fails with EBATCHRECOVERY) until the user
  // explicitly acknowledges via a Main-owned native dialog. Surface it
  // visibly at boot instead of letting autosaves fail silently.
  try {
    if (typeof window.api.batchesRecoveryStatus === 'function') {
      const rec = await window.api.batchesRecoveryStatus();
      if (rec && rec.ok && rec.pending) {
        if (typeof window.toast === 'function') {
          window.toast('Batch storage (batches.json) could not be read'
            + (rec.pending.backupPath ? ' — a backup was saved to ' + rec.pending.backupPath : '')
            + '. Confirm the recovery dialog to continue with empty queues.', 'err', 12000);
        }
        if (typeof window.logAction === 'function') window.logAction('boot', 'batches-recovery-pending', rec.pending);
        const ack = await window.api.batchesAcknowledgeRecovery();
        if (!ack || !ack.acknowledged) {
          if (typeof window.toast === 'function') {
            window.toast('Batch saving stays disabled until the recovery is confirmed (restart the app to retry).', 'warn', 10000);
          }
        }
      }
    }
  } catch (e) {
    if (typeof window.logWarn === 'function') window.logWarn('boot', 'batches-recovery-check', e);
  }

  // Detect addons at boot so the file log captures which optional
  // binaries are present. A missing Real-ESRGAN or IS-Net otherwise
  // silently degrades upscale/remove-bg with no breadcrumb.
  try {
    const reAvail = await window.api.realesrganAvailable();
    if (typeof window.logAction === 'function') {
      window.logAction('boot', 'addon-realesrgan', { available: !!(reAvail && reAvail.ok && reAvail.available) });
    }
  } catch (e) {
    if (typeof window.logWarn === 'function') window.logWarn('boot', 'addon-realesrgan-detect', e);
  }
  try {
    const isnetAvail = await window.api.isnetbgAvailable();
    if (typeof window.logAction === 'function') {
      window.logAction('boot', 'addon-isnetbg', { available: !!(isnetAvail && isnetAvail.ok && isnetAvail.available) });
    }
  } catch (e) {
    if (typeof window.logWarn === 'function') window.logWarn('boot', 'addon-isnetbg-detect', e);
  }

  // Install global keyboard shortcuts
  installKeyboardShortcuts();
  setStatus('Ready');
  if (typeof window.logAction === 'function') {
    window.logAction('boot', 'init-complete', { startTab });
  }

  // Initial values
  // The default output dir resolves to a per-user, per-app location
  // (e.g. %APPDATA%). The main process owns the resolution so both
  // sides stay in sync via the same `effectiveOutputDir(cfg)` helper.
  // FUNC-003: resolve the canonical browser root from main and cache it
  // so isAtOutputRoot() and the Up-button handler always have the
  // effective value, even on a fresh install with blank config.
  if (!state.config.output_dir) {
    try {
      state.config.output_dir = await window.api.defaultOutputDir();
    } catch (_) {
      // IPC missing in some test contexts — leave blank, the
      // ensureSubDir() guard will toast a clear error.
    }
  }
  _effectiveOutputRoot = state.config.output_dir || '';

  showTab(startTab);

  // Startup popup (deferred so the rest of the UI is visible behind it)
  showStartupPopup();

  // KGO4-007: fire the "What's new" toast after state is loaded.
  if (typeof maybeShowWhatsNewToast === 'function') maybeShowWhatsNewToast();

  // Logs from main. Main now sends { line, jobId, kind }. The
  // preload bridge wraps the legacy string payload so a main
  // build that only emits strings still works — see preload.js
  // onLogRich. Prefer onLogRich (new payload) and fall back to
  // onLog (legacy string) if the preload doesn't expose it.
  // De-dup consecutive identical lines as a safety net against
  // double-emission in the main process. 5 seconds is generous but
  // still short enough that a real second occurrence of the same
  // line would be intentional; mmx does not legitimately repeat a
  // line within 5s. Hoisted so both the onLogRich and onLog paths
  // share the same window.
  const DEDUP_WINDOW_MS = 5000;
  if (window.api.onLogRich) {
    // R5 (#5): key the dedup by jobId — a single global window dropped
    // identical lines from CONCURRENT jobs (two gens both logging
    // "Downloading…"), hiding one job's progress.
    const _dedup = new Map(); // jobId ('' for free-form) -> { line, at }
    window.api.onLogRich((payload) => {
      // payload = { line, jobId?, kind? }
      if (!payload) return;
      const now = Date.now();
      const key = payload.jobId || '';
      const prev = _dedup.get(key);
      if (payload.line && prev && payload.line === prev.line && (now - prev.at) < DEDUP_WINDOW_MS) {
        return;
      }
      if (_dedup.size > 500) _dedup.clear(); // safety valve — stale entries are harmless to drop
      _dedup.set(key, { line: payload.line || '', at: now });
      if (payload.jobId) {
        // Attach to the job's primary row instead of adding a new
        // row. Free-form lines (no jobId) still get their own row
        // via the addLogEvent path.
        if (window.LogService && window.LogService.attachSecondaryToJob) {
          window.LogService.attachSecondaryToJob(payload.jobId, payload.line);
        }
        return;
      }
      if (typeof log === 'function') log(payload.line);
    });
  } else {
    let _lastLogLine2 = '';
    let _lastLogAt2 = 0;
    window.api.onLog((line) => {
      const now = Date.now();
      if (line === _lastLogLine2 && (now - _lastLogAt2) < DEDUP_WINDOW_MS) return;
      _lastLogLine2 = line;
      _lastLogAt2 = now;
      if (typeof log === 'function') log(line);
    });
  }
  // Wire the new log toolbar (jump, expand/collapse all, autoscroll chip).
  if (window.LogService && window.LogService.setupLogToolbar) {
    window.LogService.setupLogToolbar();
  }

  // Graceful shutdown. When the main process emits
  // `app:before-quit`, flush any in-flight job summaries to the
  // L2 list + persist state.json synchronously (best-effort —
  // the quit is not blocked). The renderer doesn't ack; the main
  // process gives `graceMs` ms then proceeds anyway.
  if (window.api && typeof window.api.onBeforeQuit === 'function') {
    window.api.onBeforeQuit(() => {
      try {
        if (window.JobRunner && typeof window.JobRunner.flushBatchSummaries === 'function') {
          window.JobRunner.flushBatchSummaries();
        }
      } catch (_) { /* best-effort */ }
      // Call saveAllStates() DIRECTLY, not the debounced
      // scheduleStateSave() wrapper. The debounce fires 500 ms in
      // the future, but Electron tears the renderer down within
      // tens of ms of `before-quit`, so the debounced save would
      // never run and any state change in the last 500 ms would be
      // silently lost on quit. saveAllStates only fans out to one
      // IPC call, so calling it synchronously here is cheap.
      // R1.5a.follow-up Phase 5: save state + revoke cached grants at shutdown (best-effort; close-handshake bounds it).
      try { if (typeof saveAllStates === 'function') saveAllStates(); } catch (_) {}
      // PRE-1: use window.GrantCache (no require in sandbox).
      try { if (window.GrantCache) window.GrantCache.revokeAllAndClear().catch(() => {}); } catch (_) {}
    });
  }

  // First quota fetch
  refreshQuota().catch((e) => {
    // The first quota fetch failing is often the first sign of an
    // offline environment, an expired token, or a broken IPC
    // channel. Surface it instead of ignoring.
    if (typeof window.logError === 'function') {
      window.logError('refresh-quota', 'renderer/app.js:init', e);
    }
  });
}



function applyTheme(theme) {
  state.theme = (theme === 'light' ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', state.theme);
}

function toggleTheme() {
  const next = state.theme === 'light' ? 'dark' : 'light';
  if (typeof window.logAction === 'function') {
    window.logAction('theme', 'toggle', { from: state.theme, to: next });
  }
  applyTheme(next);
  // Persist immediately — QA-006: check result before claiming success.
  state.config.theme = next;
  const _themeCfg = Object.assign({}, state.config); if (state.apiKeyNoSave) _themeCfg.api_key = ''; // KGO5-004
  window.api.setConfig(_themeCfg).then((r) => {
    if (window.assertIpcOk && !window.assertIpcOk(r, 'Theme save')) return;
    toast(`Theme: ${next}`, 'ok', 1500);
  }).catch(() => { toast('Theme: save failed', 'err'); });
}

// Read the active tab's manual prompt text. Used by the "Save current
// prompt as style…" buttons (both the Style Settings modal and the
// Settings styles pane). The first <textarea> inside the active tab
// pane is always the main prompt (mirrors batchManager's lookup).
// Returns '' when there is no active tab / no prompt field / empty text.
function _currentManualText() {
  try {
    const tab = state && state.currentTab;
    if (!tab) return '';
    const root = document.querySelector(`#tab-${tab}`);
    if (!root) return '';
    const ta = root.querySelector('textarea');
    return ta && ta.value ? ta.value.trim() : '';
  } catch (_) { return ''; }
}

// ----------------- ensureSubDir -----------------
// Resolves the per-tab output folder and creates it (idempotently)
// via the allow-listed fbMkdir IPC. Each tab calls this once at
// the top of its generate handler.
//
// Behaviour:
//   1. If output_dir is blank → throw (caller shows the toast).
//   2. If the file-browser's current folder (state.fbDir) is a
//      SUBFOLDER of output_dir (e.g. navigated into
//      <output>/myproject) → use that subfolder directly. The
//      per-tab default is NOT prepended (navigating into a
//      subfolder is a "drop it HERE" signal).
//   3. If the file-browser's current folder is the output_dir
//      itself OR is empty → use the output_dir root directly.
//      The hard requirement is "files must land in the folder
//      shown in the browser", so the root — when that's what's
//      shown — wins. refreshBrowser() already prefers navigating
//      INTO <output_dir>/<tabName> when that subfolder already
//      exists, so a returning session still gets the per-tab
//      grouping; only the very first generation for a tab, or a
//      browser explicitly backed up to the root, writes to the
//      root itself.
//   4. If the file-browser's current folder is OUTSIDE output_dir
//      (an arbitrary folder picked via the native dialog,
//      e.g. E:\myproject\assets) → use that folder directly. The
//      per-tab default is NOT prepended because a picked folder
//      is already a clear "drop it here" signal.
//
// Folder creation goes through window.api.fbMkdir (NOT fs.write
// or any direct write path) so the allow-list in main/services/
// PathSecurityService gates the directory creation and a future
// bug can't bypass it.
async function ensureSubDir(name) {
  let base = state.config.output_dir || '';
  if (!base) {
    // An empty output_dir is a VALID default state — defaultConfig() ships
    // it blank and Main resolves it to <userData>/generated via
    // effectiveOutputDir() (and pre-creates it at boot via ensureOutputDir).
    // Mirror that fallback here instead of hard-failing, so the normal
    // Generate button works out-of-the-box before the user ever opens
    // Settings — matching the batch path (state.fbDir || output_dir) and
    // the rest of the app. Only throw if even the default can't be resolved.
    try {
      if (window.api && typeof window.api.defaultOutputDir === 'function') {
        base = (await window.api.defaultOutputDir()) || '';
      }
    } catch (_) { /* fall through to the throw below */ }
  }
  if (!base) throw new Error('No output directory set. Open Settings.');
  const normForCompare = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const baseNorm = normForCompare(base);
  const fbNorm = normForCompare(state.fbDir || '');
  // Remember whether the browser had nothing to show BEFORE we
  // resolve a target, so we can warn if files are landing somewhere
  // the browser wasn't actually pointed at.
  const fbWasEmpty = !fbNorm;
  const baseSep = base.includes('\\') ? '\\' : '/';
  const join = (a, b, sep) => a.replace(/[\\/]+$/, '') + sep + b;
  // Decide which directory the generated files should land in.
  // See the comment block above for the 4 cases.
  let targetDir = null;
  let externalPicked = false;
  let rootDefault = false;
  if (fbNorm && fbNorm.startsWith(baseNorm + '/')) {
    // Case 2: user navigated into a real subfolder of output_dir.
    targetDir = (state.fbDir || '').replace(/[\\/]+$/, '');
  } else if (fbNorm && fbNorm !== baseNorm && !fbNorm.startsWith(baseNorm + '/')) {
    // Case 4: a folder outside output_dir was picked (e.g. on
    // another drive via the 📂 button). The path is already
    // trusted by the picker (pathSecurity.addTrusted was called
    // by the pickFolder IPC), so a single fbMkdir(state.fbDir, name)
    // call works — fb.mkdir does the allow-list check on the
    // parent of the join, and the parent is the trusted pick
    // itself, which IS under itself.
    targetDir = (state.fbDir || '').replace(/[\\/]+$/, '');
    externalPicked = true;
  } else {
    // Case 3: fbDir is empty or equals the output_dir root —
    // write directly to the root, matching what the browser shows.
    // See the comment block above for why this targets the root.
    targetDir = base.replace(/[\\/]+$/, '');
    rootDefault = true;
  }
  // R7.5: every mutating fb IPC (fb:mkdir / fb:ensureDir) requires a
  // Main-minted grantId (R1.3 grant-contract) — but this callsite was
  // written in v1.0.0 (before grants existed) and was never updated,
  // so every generation failed with "grantId is required for mkdir".
  // Mint a directory-ROOT grant (coversRoot:true) on the trust root
  // that covers the output: the config output_dir for cases 2/3, the
  // externally-picked folder for case 4. A plain directory grant would
  // NOT cover the root itself (S1 §2.5), which is exactly what
  // fb:ensureDir touches in cases 3/4. The same grant is stashed on
  // state._fbGrantId so the generation handler can forward it to the
  // mmx --out/--out-dir write (R1.5b.1) and the batch runner's
  // ensureRunSubdir (R6.2) without re-minting.
  const grantRoot = externalPicked
    ? (state.fbDir || '').replace(/[\\/]+$/, '')
    : base.replace(/[\\/]+$/, '');
  let outGrantId;
  if (window.api && window.api.mintGrant && window.GrantCache) {
    outGrantId = await window.GrantCache.ensurePathGrant(grantRoot, 'mkdir', {
      kind: 'directory',
      capabilities: ['mkdir', 'write'],
      coversRoot: true,
    });
    if (outGrantId && outGrantId.ok === false) {
      if (!externalPicked) {
        throw new Error('output grant: ' + (outGrantId.error || 'mint failed'));
      }
      // Issue-6 fix: the externally-picked folder is no longer write-
      // authorized. Folder trust is SESSION-scoped (it dies on app
      // restart) while state.fbDirs persists — and a persisted path
      // must NEVER be re-trusted automatically (SYS-001). Instead of
      // blocking the whole generation with "Cannot resolve output
      // folder", fall back to the config's output_dir (always an
      // allowed root) and tell the user how to re-authorize the
      // picked folder. Files land in a folder the user can see, and
      // the browser is re-synced to match.
      const staleDir = targetDir;
      targetDir = base.replace(/[\\/]+$/, '');
      externalPicked = false;
      rootDefault = true;
      if (typeof window.logAction === 'function') window.logAction('grant', 'external-fbdir-fallback', { stale: staleDir, fallback: targetDir });
      if (typeof toast === 'function') {
        toast('Folder "' + staleDir + '" is not write-authorized (folder authorizations reset on app restart). Re-select it via the \uD83D\uDCC2 button if needed \u2014 saving to "' + targetDir + '" instead.', 'warn', 10000);
      }
      outGrantId = await window.GrantCache.ensurePathGrant(targetDir, 'mkdir', {
        kind: 'directory',
        capabilities: ['mkdir', 'write'],
        coversRoot: true,
      });
      if (outGrantId && outGrantId.ok === false) {
        throw new Error('output grant: ' + (outGrantId.error || 'mint failed'));
      }
      // Bring the browser in sync so the hard requirement "files land
      // in the folder shown in the browser" holds for the fallback too.
      state.fbDir = targetDir;
      if (state.currentTab && state.fbDirs) state.fbDirs[state.currentTab] = targetDir;
      if (typeof scheduleStateSave === 'function') scheduleStateSave();
      if (typeof window.refreshBrowser === 'function') {
        try { await window.refreshBrowser({ keepCurrent: true }); } catch { /* best-effort UI sync */ }
      }
    }
    state._fbGrantId = outGrantId;
  }
  // fbMkdir resolves with { ok, error } — it does NOT reject on
  // failure. Check .ok and throw the real reason so the caller
  // shows "Cannot resolve output folder: …" instead of getting a
  // targetDir that was never created (and then failing with a
  // confusing ENOENT from mmx).
  const mkdirOrThrow = async (d, n) => {
    const r = await window.api.fbMkdir(d, n, outGrantId);
    if (!r || !r.ok) throw new Error((r && r.error) || `Could not create folder "${n}" in ${d}.`);
    return r;
  };
  if (rootDefault) {
    // Root default (case 3): the root may not exist yet (e.g. the
    // very first launch, before <output_dir> has ever been written
    // to). fbMkdir always creates a NAMED CHILD of its first
    // argument, so it can't create the root itself — fbEnsureDir is
    // the dedicated IPC for "create this exact (already-allowed)
    // path if missing".
    const r = await window.api.fbEnsureDir(targetDir, outGrantId);
    if (!r || !r.ok) throw new Error((r && r.error) || `Could not create folder "${targetDir}".`);
  } else if (externalPicked) {
    // External picked folder (case 4): the picked path itself is
    // already an allowed root (the picker added it via
    // pathSecurity.addTrusted) and is being browsed, so
    // files land DIRECTLY in it (targetDir === picked, NOT
    // <picked>/<tabName>). The picked folder already exists (it is
    // being browsed), so fbEnsureDir is a no-op on disk but
    // keeps the allow-list check consistent with the other
    // branches — avoid creating a spurious empty
    // <picked>/<tabName> directory.
    const picked = (state.fbDir || '').replace(/[\\/]+$/, '');
    const r = await window.api.fbEnsureDir(picked, outGrantId);
    if (!r || !r.ok) throw new Error((r && r.error) || `Could not access folder "${picked}".`);
  } else {
    // Subfolder of output_dir (case 2): walk the path
    // segment-by-segment so each mkdir is individually
    // allow-list-checked against the trusted base.
    const stripped = targetDir.replace(/[\\/]+$/, '');
    const baseN = base.replace(/[\\/]+$/, '');
    const relParts = [];
    if (stripped.length > baseN.length) {
      const rel = stripped.slice(baseN.length).replace(/^[\\/]+/, '');
      for (const p of rel.split(/[\\/]/).filter(Boolean)) relParts.push(p);
    }
    let cur = base;
    for (const p of relParts) {
      await mkdirOrThrow(cur, p);
      cur = join(cur, p, baseSep);
    }
  }
  // If the browser had nothing to show (fbDir was unset) when we
  // resolved this target, warn so the file's location isn't a
  // surprise, then bring the browser in sync so it stops being
  // empty/stale. keepCurrent:true stops refreshBrowser's own
  // "try the per-tab subfolder" heuristic from immediately
  // navigating away from the folder just written to.
  if (fbWasEmpty && typeof toast === 'function') {
    toast(`No folder was shown in the browser — files will be saved to "${targetDir}".`, 'warn', 5000);
    state.fbDir = targetDir;
    if (typeof window.refreshBrowser === 'function') {
      try { await window.refreshBrowser({ keepCurrent: true }); } catch { /* best-effort UI sync */ }
    }
  }
  return targetDir;
}
// Expose ensureSubDir on window so the tab scripts (loaded BEFORE
// app.js) can see it without crashing.
window.ensureSubDir = ensureSubDir;
window.buildForcePrefixFileName = buildForcePrefixFileName;

// ----------------- Generation helpers -----------------
// Canonical implementations of the generate-handler helpers
// (armGenBtnWithCancel and siblings) referenced by the gen handlers
// in imageTab / speechTab / musicTab / videoTab.

// "YYYYMMDD_HHMMSS" timestamp used as the slug stem for every generated
// file. The renderer doesn't have a built-in `strftime`, so it is built
// by hand with leading-zero padding. Local-time by design — the displayed
// wall-clock time matches when the file was generated.
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// Convert a free-form prompt into a filename-safe slug: lowercase,
// swap any non-[a-z0-9] run for a single `-`, trim leading/trailing
// dashes. Empty result falls back to the per-tab default name in the
// gen handler (`|| 'image'` etc.).
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
// Renderer's uniquePath: append a 4-char base36 suffix to virtually
// eliminate in-session collisions (two clicks in the same second would
// otherwise overwrite each other). The filesystem can't be queried from
// the renderer, so a random suffix is the simplest correct approach.
function uniquePath(dir, name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const suffix = Math.random().toString(36).slice(2, 6) || 'rndm';
  return dir.replace(/[\\/]+$/, '') + (dir.includes('\\') ? '\\' : '/') + stem + '_' + suffix + ext;
}

// Builds the "force-prefix-only" filename
// `<prefix><6-digit counter>.<ext>`. The caller owns the counter
// object (so two parallel Generate clicks — image + speech at
// once, for example — don't trample each other) and bumps it on
// every call. The counter is a plain object the caller mutates:
// `{ n: 0 }` to start, then `buildForcePrefixFileName(counter,
// 'temp', 'jpg')` returns `temp000001.jpg` for the first call,
// `temp000002.jpg` for the second, etc. The 6-digit pad tops out
// at 999999 files per run; beyond that the pad silently widens
// to 7 digits so earlier files are never overwritten.
function buildForcePrefixFileName(counter, prefix, ext) {
  counter.n = (counter.n | 0) + 1;
  // Use enough leading zeros for the current value so the
  // count is always 6 digits minimum. Once the count crosses
  // 999999, the pad widens to 7 digits, then 8, etc. — so
  // even an extremely long run can't silently overwrite an
  // earlier file in the same run.
  const padded = String(counter.n).padStart(6, '0');
  // Defensive: current callers pass ext WITHOUT a leading dot
  // ("png", "mp4", …), but a caller passing ".png" would produce a
  // file with a double dot ("temp000001..png"). Strip the leading
  // dot so the function is robust to both shapes.
  const cleanExt = String(ext || '').replace(/^\./, '');
  return `${prefix || ''}${padded}.${cleanExt}`;
}
// Force-prefix-only files must be named EXACTLY
// `<prefix><counter>.<ext>` with no random suffix — that's the
// point of the feature. Collision safety across separate Generate
// clicks (the counter resets to 0 every click) is handled here by
// probing the filesystem and bumping the counter forward past any
// file that already exists, rather than randomizing the name.
// `altExts`: optional sibling extensions to also treat as "taken"
// at the same counter value. The image tab's mmx API has no
// output-format parameter, so a generated file's real bytes don't
// always match the ".png" originally requested —
// fixImageExtension() corrects the on-disk name afterward (e.g.
// temp000001.png -> temp000001.jpg). Without checking siblings
// here, a later click's fbExists('temp000001.png') would report
// "free" even though that counter slot is really occupied by
// temp000001.jpg, and every subsequent click would collide on the
// same counter value forever instead of advancing past it.
// Callers that can't have this mismatch (video/speech/music,
// which either have a single true extension or request an
// honoured --format) simply omit altExts.
async function nextFreeForcePrefixPath(dir, counter, prefix, ext, altExts) {
  const sep = dir.includes('\\') ? '\\' : '/';
  const base = dir.replace(/[\\/]+$/, '');
  // Iteration cap. A `for (;;)` would loop forever if fbExists
  // consistently returned true (corrupted FS state, an allow-list
  // bug, a directory full of a million temp###### files). The
  // sibling helper in section08 caps at 1000; the same
  // number is used here for consistency. On exhaustion the function falls back
  // to a timestamp-suffixed name so the caller still gets a unique
  // path and no generated file (which cost API credits) is ever lost.
  const MAX_TRIES = 1000;
  let checkErrors = 0; // H-050: track how many iterations failed to check
  for (let i = 0; i < MAX_TRIES; i++) {
    const name = buildForcePrefixFileName(counter, prefix, ext);
    const full = base + sep + name;
    let exists = false;
    // fbExists returns a { ok, exists } envelope, not a bare
    // boolean. Pull the boolean out of .exists for the truthy
    // check below.
    try {
      // BGR-009 fix: mint read grant for fbExists (R1.3 gate).
      const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(full) : undefined;
      // R6: a failed grant envelope must not be forwarded — fb:exists would resolve {ok:false,exists:false} and we'd return an unverifiable name as "free" (silent overwrite). Treat it as occupied so the counter bumps.
      const r = (existsGrant && existsGrant.ok === false) ? { exists: true } : await window.api.fbExists(full, existsGrant);
      exists = !!(r && r.exists);
    } catch { exists = true; checkErrors++; } // H-050: fail-CLOSED — an unverifiable path is treated as occupied
    if (!exists && Array.isArray(altExts) && altExts.length) {
      const padded = String(counter.n).padStart(6, '0');
      const stem = `${prefix || ''}${padded}`;
      for (const altExt of altExts) {
        if (altExt === ext) continue;
        try {
          // BGR-009 fix: mint read grant for fbExists (R1.3 gate).
          const altGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(base + sep + `${stem}.${altExt}`) : undefined;
          const r2 = (altGrant && altGrant.ok === false) ? { exists: true } : await window.api.fbExists(base + sep + `${stem}.${altExt}`, altGrant);
          if (r2 && r2.exists) { exists = true; break; }
        } catch { exists = true; } // H-050: fail-CLOSED — unverifiable alt-ext treated as occupied
      }
    }
    if (!exists) return full;
  }
  // H-050: if EVERY existence check errored (persistent IPC/permission
  // failure), we cannot verify ANY path — refuse to produce a name rather
  // than risk a collision. The caller surfaces the error and the user can
  // retry once the filesystem/IPC is healthy again.
  if (checkErrors >= MAX_TRIES) {
    throw new Error('Cannot find a free output name: all ' + MAX_TRIES + ' existence checks failed (IPC or permission error). No file was created.');
  }
  // Fallback: a timestamp-suffixed name that's effectively impossible
  // to collide with an existing file. The counter is still advanced
  // so the next call doesn't re-scan the same million files.
  const tsName = `${prefix || ''}${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`;
  return base + sep + tsName;
}
window.nextFreeForcePrefixPath = nextFreeForcePrefixPath;
// Format mmx error: strip the "node.exe :" prefix PowerShell wraps
// around stderr, then surface the most informative bit. mmx returns
// errors in a few different shapes depending on which command failed;
// see classifyMmxError below for the categorisation that follows.
function formatMmxError(r) {
  // A user-initiated cancel is not an error — surface it neutrally so the
  // toast/preview reads "Canceled by user." instead of "mmx exited with
  // code null" (H7-025).
  if (r && r.canceled) return 'Canceled by user.';
  let msg = (r.stderr || r.stdout || '').toString();
  msg = msg.replace(/^node\.exe\s*:\s*/gm, '').trim();
  if (r.parsed && typeof r.parsed === 'object') {
    // Shape 1: { "error": { "code": N, "message": "..." } }
    if (r.parsed.error && typeof r.parsed.error === 'object' && r.parsed.error.message) {
      const m = String(r.parsed.error.message);
      if (m) return msg ? `${m} (${msg})` : m;
    }
    // Shape 2: { "base_resp": { "status_code": N, "status_msg": "..." } }
    if (r.parsed.base_resp && r.parsed.base_resp.status_msg) {
      const sm = r.parsed.base_resp.status_msg;
      const sc = r.parsed.base_resp.status_code;
      if (sm && sc !== 0) return msg ? `${sm} (${msg})` : sm;
    }
    // Shape 3: { "message": "..." } (catch-all)
    if (typeof r.parsed.message === 'string' && r.parsed.message) return r.parsed.message;
  }
  return msg || `mmx exited with code ${r.code}`;
}
// Classify an mmx error so the image tab's error UI can show targeted
// troubleshooting tips (auth / rate / quota / network / server /
// silent / unknown). Matches a deliberately small set of substrings; the
// patterns are case-insensitive on the combined stderr/stdout/msg blob.
// 'silent' covers the case where mmx exited with code -1 AND produced
// no stderr AND no stdout — the main process's `proc.on('error')` path
// fires when the Node child cannot be spawned OR dies before reaching
// mmx's own error handler. mmx's own handler always prints "Error:
// <msg>" to stderr before exiting, so a missing stderr with code -1
// means "mmx crashed before it could print anything" — usually a
// rate-limit crash on a rapid 2nd request, an out-of-memory kill, or a
// Node-level spawn failure on a stale mmx-cli install. Detected BEFORE
// 'unknown' so the tips + toast can be specific.
function classifyMmxError(r, msg) {
  const combined = ((msg || '') + ' ' + (r.stderr || '') + ' ' + (r.stdout || '')).toLowerCase();
  if (/401|403|unauthor|forbidden|invalid.api.key|api.key.*invalid|auth.*fail|login.?fail|invalid.?authentication|authentication.?fail|(?:status_?code|base_?resp)["'\s:{]*(?:1004|2049)/.test(combined)) return 'auth';
  // 'input' = a permanent, user-fixable problem with the request itself
  // (most commonly a reference/lyrics file that doesn't exist on disk).
  // Checked before 'network' so a local ENOENT isn't mistaken for the
  // DNS-level ENOTFOUND. Classifying it lets the retry loop skip it
  // instead of hammering a missing --subject-ref path repeatedly.
  if (/enoent|no such file|file or directory not found|file system error/.test(combined)) return 'input';
  if (/quota|not.in.plan|exhaust|insufficient|token.?plan/i.test(combined)) return 'quota'; // KGO6-012: dropped usage.limit
  if (/429|rate|limit|throttl|too many/.test(combined)) return 'rate';
  if (/enotfound|econnrefused|econnreset|etimedout|network|dns/.test(combined)) return 'network';
  if (/500|502|503|504|server.error|system.error|internal/.test(combined)) return 'server';
  // Silent failure: code -1 (proc.on('error') path) + empty stderr + empty stdout.
  // mmx normally writes "Error: <msg>" to stderr before exit, so a true blank
  // stderr is meaningful — it means mmx died before any error handler ran.
  const codeIsNeg = (r && (r.code === -1 || r.code === null || r.code === undefined));
  const stderrEmpty = !(r && r.stderr && String(r.stderr).trim());
  const stdoutEmpty = !(r && r.stdout && String(r.stdout).trim());
  const msgEmpty = !msg || !String(msg).trim() || /mmx exited with code -1/i.test(String(msg));
  if (codeIsNeg && stderrEmpty && stdoutEmpty && msgEmpty) return 'silent';
  return 'unknown';
}
// Whether an mmx failure is worth retrying. Permanent failures (bad
// credentials, exhausted quota, a missing input file, silent mmx crash)
// will fail identically on every retry — retrying just wastes time and,
// for a missing reference image, hammers the same non-existent path 4×.
// Only the transient classes (rate-limit, network blip, 5xx / "system
// error (HTTP 200)") are retried. 'silent' is treated as non-retryable
// because the cause is typically an out-of-band rate-limit / OOM /
// spawn failure that won't clear in <1s — wait before retrying.
function isRetryableMmxError(r, msg) {
  const cls = classifyMmxError(r, msg);
  return !(cls === 'auth' || cls === 'quota' || cls === 'input' || cls === 'silent');
}
// Bump the in-session "N generations this session" counter shown in
// the status bar. Called from every gen handler's success path (image /
// speech / music / video). Cleared on app restart — this is purely a
// per-session UX hint, not persisted.
let _generationCounter = 0;
function bumpGenerationCounter(kind, n = 1) {
  _generationCounter += Math.max(1, n | 0);
  setStatus(`${_generationCounter} generations this session`, false);
}
// Wrap a generation call with a cancel button. While the call is in
// flight the button text becomes "Cancel" (clicking it triggers the
// cancel path), state.generating is set to the tab key so re-entrant
// click guards and the batch runner can detect an in-flight run, and
// state.genStatus[tabKey] is set to "running" (drives the red tab dot).
// On cleanup: the original button label is restored, state.generating
// is cleared, the per-tab ETA average is updated (alpha=0.4, recent
// runs weighted higher), and the tab dot flips to "done".
// Optional 3rd param `jobId`. When the caller has wrapped its
// generation in JobRunner.run(...), passing the returned jobId here
// makes the Cancel button drive JobRunner.cancel() (which kills
// exactly this job's mmx proc and updates the job's status/widget)
// instead of the legacy panic-everything mmxCancel(). Callers that
// haven't migrated simply omit jobId — behaviour for them is
// byte-for-byte unchanged.
function armGenBtnWithCancel(genBtn, label, jobId) {
  let cancelled = false;
  const origLabel = label || genBtn.textContent;
  const tabKey = (genBtn.closest('.tabpanel')?.id || '').replace('tab-', '') || null;
  genBtn.textContent = 'Cancel';
  genBtn.classList.add('danger');
  state.generating = tabKey;
  if (tabKey) {
    state.genStatus[tabKey] = 'running';
    if (!state.genStartMs) state.genStartMs = { image: null, speech: null, music: null, video: null };
    state.genStartMs[tabKey] = Date.now();
  }
  refreshTabStatusDots();
  ensureEtaTimer();
  // BUG #3 fix: start the live folder-explorer poller
  // (fileBrowser2b.js). startGenPolling/stopGenPolling were fully
  // implemented but never wired — the file browser only refreshed
  // on the gen handler's own events, so --out-dir outputs (where
  // the handler doesn't know the per-call filenames) never showed
  // up live. Idempotent: the _genPollActive guard no-ops
  // concurrent arms (parallel tabs).
  try { if (typeof startGenPolling === 'function') startGenPolling(); } catch (_) { /* best-effort */ }
  const onCancelClick = async (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    if (!await asyncConfirm('Cancel the current generation?')) return;
    cancelled = true;
    toast('Cancelling…', 'warn', 1500);
    if (jobId && window.JobRunner && typeof window.JobRunner.cancel === 'function') {
      window.JobRunner.cancel(jobId);
    } else {
      // R5: a rejecting mmxCancel IPC would otherwise leave onCancelClick's
      // promise rejected (unhandled, since it's an event-listener callback).
      try { await window.api.mmxCancel(); } catch (_) { /* best-effort cancel */ }
    }
  };
  genBtn.addEventListener('click', onCancelClick);
  return {
    cancel: () => { cancelled = true; },
    wasCancelled: () => cancelled,
    cleanup: () => {
      genBtn.removeEventListener('click', onCancelClick);
      genBtn.classList.remove('danger');
      genBtn.textContent = origLabel;
      genBtn.disabled = false;
      if (tabKey && !cancelled && state.genStartMs && state.genStartMs[tabKey]) {
        const dur = (Date.now() - state.genStartMs[tabKey]) / 1000;
        if (!state.genAvgSec) state.genAvgSec = { image: 0, speech: 0, music: 0, video: 0 };
        const prev = state.genAvgSec[tabKey] || 0;
        state.genAvgSec[tabKey] = prev === 0 ? dur : (prev * 0.6 + dur * 0.4);
        state.genStartMs[tabKey] = null;
      }
      // QA-021 fix: recompute state.generating from live jobs instead of
      // a stale equality check that misses interleaved completions.
      if (window.JobRunner && typeof window.JobRunner.syncLegacyGenerating === 'function') {
        window.JobRunner.syncLegacyGenerating();
      } else if (state.generating === tabKey) {
        state.generating = null;
      }
      if (tabKey) state.genStatus[tabKey] = cancelled ? 'idle' : 'done';
      refreshTabStatusDots();
      try {
        const anyOtherJob = !!(window.JobRunner && typeof window.JobRunner.activeJobs === 'function'
          && window.JobRunner.activeJobs().some((j) => j && j.id !== jobId));
        if (!anyOtherJob && typeof stopGenPolling === 'function') stopGenPolling();
      } catch (_) { /* best-effort */ }
    },
  };
}

function installKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (window.GlobalShortcutRegistry && typeof window.GlobalShortcutRegistry.handleKeyEvent === 'function') {
      window.GlobalShortcutRegistry.handleKeyEvent(e);
    }
  });
}

function assignTabFormIds(tabKey) {
  const root = $(`#tab-${tabKey}`);
  if (!root) return;
  const seen = new Set();
  let n = 0;
  for (const row of root.querySelectorAll('.row')) {
    const labelText = row.querySelector('label')?.textContent?.trim()?.split('\n')[0]?.trim() || `field_${n}`;
    let slug = slugifyLabel(labelText);
    let baseId = `${tabKey}.${slug}`;
    let suffix = 0;
    while (seen.has(baseId)) { suffix++; baseId = `${tabKey}.${slug}_${suffix}`; }
    seen.add(baseId);
    const all = row.querySelectorAll('input, select, textarea');
    if (all.length > 1) {
      all.forEach((el, i) => { if (!el.id) el.id = `${baseId}.${i}`; });
    } else if (all.length === 1) {
      if (!all[0].id) all[0].id = baseId;
    }
    n++;
  }
}

function applyTabState(tabKey, data) {
  if (!data) return;
  const root = $(`#tab-${tabKey}`);
  if (!root) return;
  for (const inp of root.querySelectorAll('input[id], select[id], textarea[id]')) {
    if (!(inp.id in data)) continue;
    if (inp.type === 'checkbox') inp.checked = data[inp.id] === 'on' || data[inp.id] === true;
    else inp.value = data[inp.id];
    // Re-fire input/change so the UI reacts (e.g. has-custom class for combos)
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function setupTabAutosave(tabKey) {
  const root = $(`#tab-${tabKey}`);
  if (!root) return;
  // Save on any change (input for text, change for select/checkbox)
  root.addEventListener('input', scheduleStateSave, true);
  root.addEventListener('change', scheduleStateSave, true);
}

function _refreshBatchButtons() {
  // For each tab, render the batch controls based on the current queue.
  // Empty queue  → single "⚙ Batch Mode" button.
  // Has entries  → "Start BatchGen (N)" + a small "✎" edit button.
  for (const tabKey of ['image', 'speech', 'music', 'video']) {
    const root = $(`#tab-${tabKey}`);
    if (!root) continue;
    const wrap = root.querySelector('[data-batch-controls]');
    if (!wrap) continue;
    const n = (state.batches[tabKey] || []).length;
    wrap.innerHTML = '';
    if (n === 0) {
      // Setup / edit-empty mode: single button
      const setup = el('button', {
        class: 'btn-mini btn-compact batch-setup',
        title: '⚙ Batch Mode',
        onclick: () => openBatchManager(tabKey),
      }, '⚙ Batch Mode');
      wrap.appendChild(setup);
    } else {
      // Populated mode: "Start BatchGen (N)" + small ✎ edit button
      const start = el('button', {
        class: 'batch-start',
        onclick: () => startBatchGen(tabKey),
      }, `▶ Start BatchGen (${n})`);
      const edit = el('button', {
        class: 'btn-mini batch-edit',
        title: 'Edit batch entries',
        onclick: () => openBatchManager(tabKey),
      }, '✎');
      wrap.append(start, edit);
    }

    // Append helper actions — F2: unified "Import Batch" button replaces
    // the old separate "📥 Import…" and "Examples" buttons.
    const importBatchBtn = el('button', {
      class: 'btn-mini btn-compact batch-import-unified',
      title: 'Import a batch (get the AI instruction file or import a completed one)',
      onclick: (e) => { e.preventDefault(); window.ImportBatchOverlay.open(); },
    }, 'Import Batch');

    const totalAllTabs = ['image', 'speech', 'music', 'video'].reduce((sum, k) => sum + (state.batches[k] || []).length, 0);
    // ETA span next to the "BatGen All Types" button. Only shown
    // when more than one type has items — for a single tab the
    // per-tab ETA is already visible. The span reads the per-tab
    // ETA helper so it stays in sync with the per-tab running
    // averages.
    const typesWithBatch = ['image', 'speech', 'music', 'video'].filter((k) => (state.batches[k] || []).length > 0);
    const showAllEta = typesWithBatch.length > 1;
    const allEta = el('span', {
      class: 'batch-all-eta',
      // Hidden by default; refreshed by _refreshAllBatchEta() on
      // a 1s tick while a batch is in flight, and on every
      // _refreshBatchButtons() call.
      style: showAllEta ? 'margin-left: 6px; font-variant-numeric: tabular-nums; color: var(--fg-2);' : 'display: none;',
      title: 'Estimated time to finish all queued batches across the tabs that have items',
    }, '');
    const startAllBtn = el('button', {
      class: 'batch-start-all',
      style: totalAllTabs > 0 ? 'background: var(--primary-2, #d9a300); color: var(--bg-1); font-weight: bold; margin-left: 4px;' : 'display: none;',
      title: 'Start batch generation on all tabs sequentially',
      onclick: (e) => { e.preventDefault(); window.BatchManager.startAllBatchGen(); },
    }, `▶ BatGen All Types (${totalAllTabs})`);
    // Small "✎" edit button next to the "BatGen All Types"
    // button (matches the pen icon on the per-tab "Start
    // BatchGen (N)" button). Opens a dashboard modal showing
    // the active generation (if any) + the queued items across
    // every tab, with model / style / parameters / ETA
    // organised per-tab.
    const startAllEditBtn = el('button', {
      class: 'btn-mini batch-start-all-edit',
      style: totalAllTabs > 0 ? 'margin-left: 4px;' : 'display: none;',
      title: 'Open the all-types BatchGen dashboard (active + upcoming items, model + ETA per tab)',
      onclick: (e) => { e.preventDefault(); openAllBatchDashboard(); },
    }, '✎');

    // Divider line
    wrap.append(el('span', { style: 'margin: 0 6px; border-left: 1px solid var(--border); height: 14px; display: inline-block; vertical-align: middle;' }));
    wrap.append(importBatchBtn, startAllBtn, startAllEditBtn, allEta);
  }
  // Always refresh the all-types ETA in case state.batchQueueLeft
  // changed without _refreshBatchButtons being called.
  _refreshAllBatchEta();
}

// Refresh the ETA span next to the "BatGen All Types" button.
// Reads per-tab batchQueueLeft + the per-tab running average
// (state.genAvgSec) and computes the total remaining wall-clock
// time. The result is mm:ss (or h:mm:ss for runs over an hour).
// Safe to call on every tick — the math is cheap and the DOM is
// only touched if the value actually changed.
function _refreshAllBatchEta() {
  const tabs = ['image', 'speech', 'music', 'video'];
  const allEta = document.querySelector('.batch-all-eta');
  if (!allEta) return;
  // Hide the ETA when only 1 type is in the queue, or when
  // no batch is currently running.
  const typesWithQueue = tabs.filter((k) => (state.batches[k] || []).length > 0);
  if (typesWithQueue.length < 2) { allEta.style.display = 'none'; return; }
  const hasRunningBatch = tabs.some((k) => (state.batchQueueLeft && state.batchQueueLeft[k] > 0));
  if (!hasRunningBatch) { allEta.textContent = ''; allEta.style.display = 'none'; return; }
  // Weighted total: sum(remaining * avg) for each tab.
  let totalSec = 0;
  let anyRunning = false;
  for (const k of tabs) {
    const remaining = (state.batchQueueLeft && state.batchQueueLeft[k]) || 0;
    if (remaining <= 0) continue;
    let avg = (state.genAvgSec && state.genAvgSec[k]) || 0;
    if (!avg) {
      const defaults = { image: 35, speech: 12, music: 75, video: 90 };
      avg = defaults[k] || 30;
    }
    totalSec += remaining * avg;
    anyRunning = true;
  }
  if (!anyRunning) { allEta.textContent = ''; allEta.style.display = 'none'; return; }
  allEta.style.display = '';
  const sec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  allEta.textContent = h > 0
    ? `⏱ ${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `⏱ ${m}:${String(s).padStart(2, '0')}`;
}

// The "BatGen All Types" dashboard modal. Shown when the user
// clicks the ✎ pen-icon next to the BatGen All Types button.
// The modal shows:
//   • a "Currently running" header with the active tab +
//     item + ETA (if a batch is in flight)
//   • for each tab that has queued items: the tab header +
//     item count + remaining ETA + the per-tab model +
//     parameters + a scrollable list of every queued item
//     (showing the prompt/text + any per-item params)
//   • a "Settings in effect" section at the bottom that lists
//     the per-tab style preset + output dir + filename
//     prefix + other globals
// The modal auto-refreshes every second while open so the
// countdown ticks down live (just like the per-tab ETA /
// BatGen All Types ETA).
function openAllBatchDashboard() {
  if (typeof showModal !== 'function') return;
  const tabs = ['image', 'speech', 'music', 'video'];
  const tabLabels = { image: '🖼 Image', speech: '🗣 Speech', music: '🎵 Music', video: '🎬 Video' };
  // The 1s refresh interval is created inside the modal builder
  // but cleared from `opts.onClose` so it runs no matter how the
  // modal was dismissed (Close button, Esc, outside-click). The
  // variable lives in the outer function's closure so the onClose
  // hook (defined at the same level) can see it.
  let tick = null;
  // Per-tab avg lookup, with sensible defaults so the first
  // run still shows an estimate instead of "...".
  function avgFor(tabKey) {
    let a = (state.genAvgSec && state.genAvgSec[tabKey]) || 0;
    if (!a) a = ({ image: 35, speech: 12, music: 75, video: 90 })[tabKey] || 30;
    return a;
  }
  function fmtSec(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }
  function batchText(item) {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      return item.prompt || item.text || '';
    }
    return '';
  }
  showModal((m, close) => {
    m.classList.add('batch-dashboard-modal');
    // Header
    const header = el('div', { class: 'batch-dashboard-header' }, [
      el('h2', { style: 'margin: 0;' }, '🗂 BatchGen — All Types Dashboard'),
      el('button', { type: 'button', class: 'btn-mini', onclick: close }, '✕ Close'),
    ]);
    m.appendChild(header);
    // Live region that gets re-rendered every tick
    const body = el('div', { class: 'batch-dashboard-body' });
    function renderBody() {
      body.innerHTML = '';
      // ---- Currently running section ----
      const running = el('div', { class: 'batch-dashboard-section' });
      const runningItems = tabs
        .map((k) => ({ k, left: (state.batchQueueLeft && state.batchQueueLeft[k]) || 0 }))
        .filter((x) => x.left > 0);
      if (runningItems.length) {
        running.appendChild(el('h3', {}, '▶ Currently running'));
        const ul = el('ul', { class: 'batch-dashboard-list' });
        let totalSec = 0;
        for (const { k, left } of runningItems) {
          totalSec += left * avgFor(k);
          ul.appendChild(el('li', {}, [
            el('strong', {}, tabLabels[k]),
            ' — ',
            el('span', {}, `${left} item${left === 1 ? '' : 's'} left (${fmtSec(left * avgFor(k))} ETA)`),
          ]));
        }
        running.appendChild(ul);
        running.appendChild(el('div', { class: 'batch-dashboard-grand-total' },
          `Grand total ETA: ⏱ ${fmtSec(totalSec)}`));
      } else {
        running.appendChild(el('p', { class: 'batch-dashboard-empty' },
          'No batch is currently running. Click ▶ on any "BatGen All Types" to start one.'));
      }
      body.appendChild(running);
      // ---- Per-tab queues ----
      const queuesSection = el('div', { class: 'batch-dashboard-section' });
      queuesSection.appendChild(el('h3', {}, '📋 Upcoming items by tab'));
      const anyQueued = tabs.some((k) => (state.batches[k] || []).length > 0);
      if (!anyQueued) {
        queuesSection.appendChild(el('p', { class: 'batch-dashboard-empty' },
          'All BatchGen queues are empty. Add items from any tab via "⚙ Batch Mode" or import a .txt file.'));
      } else {
        for (const k of tabs) {
          const items = state.batches[k] || [];
          if (!items.length) continue;
          const card = el('div', { class: 'batch-dashboard-card' });
          // Tab header row
          const left = (state.batchQueueLeft && state.batchQueueLeft[k]) || 0;
          const eta = left > 0 ? ` (${fmtSec(left * avgFor(k))} left)` : '';
          card.appendChild(el('div', { class: 'batch-dashboard-card-header' }, [
            el('strong', {}, tabLabels[k]),
            el('span', { class: 'batch-dashboard-count' }, ` — ${items.length} queued${eta}`),
          ]));
          // Settings in effect (read from the live tab DOM
          // so the dashboard always reflects the CURRENT
          // values, not a stale snapshot).
          const tabRoot = $(`#tab-${k}`);
          if (tabRoot) {
            const meta = el('div', { class: 'batch-dashboard-meta' });
            const styleSel = tabRoot.querySelector('.row select');
            const variantSel = tabRoot.querySelector('.variants-select');
            const ta = tabRoot.querySelector('textarea');
            const lines = [];
            if (styleSel) lines.push(`Style: ${styleSel.options[styleSel.selectedIndex]?.text || '(none)'}`);
            if (variantSel) lines.push(`Variants: ${variantSel.value}`);
            if (ta && ta.value) lines.push(`Default prompt: "${ta.value.slice(0, 80)}${ta.value.length > 80 ? '…' : ''}"`);
            lines.push(`Output folder: ${state.fbDirs && state.fbDirs[k] || state.config.output_dir || '(default)'}`);
            if (state.filePrefix) lines.push(`File prefix: "${state.filePrefix}"`);
            // Render as a simple text block (one line per entry)
            const settings = el('div', { class: 'batch-dashboard-settings' });
            for (const ln of lines) settings.appendChild(el('div', {}, ln));
            meta.appendChild(settings);
            card.appendChild(meta);
          }
          // Item list (scrollable, max-height so very large
          // queues don't blow up the modal).
          const list = el('ol', { class: 'batch-dashboard-items' });
          const startIdx = items.length - left; // first item NOT yet processed
          // Per-item edit + remove buttons so the queue can be
          // managed from the dashboard without re-opening the
          // per-tab batch editor. The buttons act on
          // state.batches[k] in place and persist via batchesSet
          // so a refresh doesn't bring them back. "Edit" opens
          // the existing per-tab batch editor (openBatchManager)
          // where the textareas support per-item editing;
          // "Remove" drops the entry immediately.
          items.forEach((it, idx) => {
            const isDone = idx < startIdx;
            const li = el('li', {
              class: 'batch-dashboard-item' + (isDone ? ' batch-dashboard-item-done' : ''),
              title: batchText(it),
            });
            const txt = batchText(it).slice(0, 200);
            li.appendChild(el('span', { class: 'batch-dashboard-item-num' }, `${idx + 1}.`));
            // Show Edit / Remove for ALL items. Remove just
            // deletes the entry from state.batches (already-
            // processed items stay in the log for history).
            // Edit opens the per-tab editor. The actions sit
            // LEFT of the text so they stay visible (the 1s
            // auto-refresh resets horizontal scroll to 0).
            {
              const actions = el('span', { class: 'batch-dashboard-item-actions' });
              const upBtn = el('button', {
                type: 'button', class: 'btn-mini', title: 'Move up',
                onclick: async () => {
                  if (idx > 0) {
                    const next = (state.batches[k] || []).slice();
                    [next[idx-1], next[idx]] = [next[idx], next[idx-1]];
                    const r = await window.api.batchesSet({ ...state.batches, [k]: next }).catch(() => null);
                    if (r && r.ok) { state.batches[k] = next; renderBody(); }
                    else if (window.assertIpcOk) window.assertIpcOk(r, 'Batch reorder');
                  }
                }
              }, '↑');
              const downBtn = el('button', {
                type: 'button', class: 'btn-mini', title: 'Move down',
                onclick: async () => {
                  const next = (state.batches[k] || []).slice();
                  if (idx < next.length - 1) {
                    [next[idx+1], next[idx]] = [next[idx], next[idx+1]];
                    const r = await window.api.batchesSet({ ...state.batches, [k]: next }).catch(() => null);
                    if (r && r.ok) { state.batches[k] = next; renderBody(); }
                    else if (window.assertIpcOk) window.assertIpcOk(r, 'Batch reorder');
                  }
                }
              }, '↓');
              const editBtn = el('button', {
                type: 'button',
                class: 'btn-mini',
                title: 'Open the per-tab BatchGen editor to edit this entry',
                onclick: () => {
                  close();
                  try { window.BatchManager.openBatchManager(k); } catch (_) { /* tab scripts may not have loaded yet */ }
                },
              }, '✎');
              const removeBtn = el('button', {
                type: 'button',
                class: 'btn-mini danger',
                title: 'Remove this entry from the queue (no undo). Already-processed items stay in the history log.',
                onclick: async () => {
                  const next = (state.batches[k] || []).slice();
                  if (idx < next.length) next.splice(idx, 1);
                  const r = await window.api.batchesSet({ ...state.batches, [k]: next }).catch(() => null);
                  if (r && r.ok) { state.batches[k] = next; renderBody(); }
                  else if (window.assertIpcOk) window.assertIpcOk(r, 'Batch remove');
                },
              }, '✕');
              actions.append(upBtn, downBtn, editBtn, removeBtn);
              li.appendChild(actions);
            }
            li.appendChild(el('span', { class: 'batch-dashboard-item-text' }, txt + (batchText(it).length > 200 ? '…' : '')));
            if (it && typeof it === 'object') {
              const params = [];
              for (const k2 of Object.keys(it)) {
                if (k2 === 'prompt' || k2 === 'text') continue;
                if (typeof it[k2] === 'string') params.push(`${k2}: ${it[k2]}`);
                else if (typeof it[k2] === 'number') params.push(`${k2}: ${it[k2]}`);
              }
              if (params.length) li.appendChild(el('span', { class: 'batch-dashboard-item-params' }, ` [${params.join(', ')}]`));
            }
            list.appendChild(li);
          });
          card.appendChild(list);
          queuesSection.appendChild(card);
        }
      }
      body.appendChild(queuesSection);
      // ---- Footer summary ----
      const footer = el('div', { class: 'batch-dashboard-footer' });
      const totalAllTabs = tabs.reduce((s, k) => s + (state.batches[k] || []).length, 0);
      footer.appendChild(el('div', {}, `Total items queued across all tabs: ${totalAllTabs}`));
      body.appendChild(footer);
    }
    m.appendChild(body);
    renderBody();
    // Refresh every second while the modal is open so the
    // countdown ticks down live. The interval is cleared in
    // the `onClose` hook below so the cleanup runs no matter
    // how the modal was dismissed (Close button, Esc key,
    // outside-click — showModal routes them all through the
    // onClose callback).
    tick = setInterval(renderBody, 1000);
  }, { onClose: () => { if (tick) { clearInterval(tick); tick = null; } } });
}

function openStyleSettings(returnToTab) {
  showModal((m, close) => {
    m.appendChild(el('h2', {}, 'Style Settings'));
    m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
      'Stored in config.txt → [styles] section. Each preset is prepended (with a comma) to your manual prompt. Example: a preset "Pixel Art Berlin" with value "Pixel art, neon red lighting" + manual input "Berliner Straßenkiller" → "Pixel art, neon red lighting, Berliner Straßenkiller".'));

    const ul = el('ul', { class: 'style-list' });
    function renderList() {
      ul.innerHTML = '';
      const styles = state.config.styles || [];
      if (!styles.length) {
        ul.appendChild(el('li', { class: 'empty-row' }, 'No styles yet. Add one below, or click "Save current as style".'));
        return;
      }
      styles.forEach((s, i) => {
        const actions = el('div', { class: 'sactions' }, [
          el('button', { class: 'btn-mini', onclick: () => { editStyle(i, returnToTab); } }, '✎'),
          el('button', { class: 'btn-mini danger', onclick: () => { deleteStyle(i, () => { renderList(); }); } }, '✕'),
        ]);
        const li = el('li', {}, [
          el('div', {}, [
            el('div', { class: 'sname' }, s.name),
            el('div', { class: 'sval' }, s.value),
          ]),
          actions,
        ]);
        ul.appendChild(li);
      });
    }
    renderList();
    m.appendChild(ul);

    // New / Edit form
    const editingIdx = { value: -1 };
    const nameInput = el('input', { type: 'text', placeholder: 'Style name (e.g. "Pixel Art Berlin")' });
    const valInput = el('textarea', { placeholder: 'Style value — the text that gets prepended to your prompt (e.g. "Pixel art, neon red lighting, dramatic shadows")' });
    valInput.style.minHeight = '70px';
    const formHeader = el('h3', { style: 'margin: 14px 0 6px; font-size: 13px;' }, 'Add / edit style');
    m.appendChild(formHeader);
    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Name'), nameInput]));
    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Value (prepended to your prompt)'), valInput]));

    function editStyle(i, tabKey) {
      const s = (state.config.styles || [])[i];
      if (!s) return;
      editingIdx.value = i;
      nameInput.value = s.name;
      valInput.value = s.value;
      // jump to the right tab to surface which context
      if (tabKey && tabKey !== state.currentTab) showTab(tabKey);
      nameInput.focus();
    }
    function deleteStyle(i, after) {
      const styles = state.config.styles || [];
      if (i < 0 || i >= styles.length) return;
      const removed = styles.splice(i, 1)[0];
      persistStyles().then((ok) => { if (!ok) { styles.splice(i, 0, removed); return; } _refreshAllStyleDropdowns(); after && after(); toast(`Removed "${removed.name}".`, 'ok'); });
    }
    async function persistStyles() {
      state.config.styles = state.config.styles || [];
      const _styleCfg = Object.assign({}, state.config); if (state.apiKeyNoSave) _styleCfg.api_key = ''; // KGO5-004
      const r = await window.api.setConfig(_styleCfg);
      if (window.assertIpcOk && !window.assertIpcOk(r, 'Style save')) return false;
      return true;
    }

    const saveBtn = el('button', { class: 'primary' }, 'Save style');
    const saveCurrentBtn = el('button', {}, 'Save current prompt as style…');
    const cancelBtn = el('button', { onclick: close }, 'Close');

    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const value = valInput.value.trim();
      if (!name) { toast('Name is required.', 'warn'); return; }
      if (!value) { toast('Value is required.', 'warn'); return; }
      // Reject names that contain '=' — the config.txt format uses the first
      // '=' on each line to split name/value, so a name with '=' would
      // silently break the round-trip.
      if (name.includes('=')) {
        toast('Style name cannot contain "=" (would break config parsing).', 'err');
        return;
      }
      const styles = state.config.styles || [];
      if (editingIdx.value >= 0) styles[editingIdx.value] = { name, value };
      else {
        // de-dupe by name
        const existing = styles.findIndex((s) => s.name === name);
        if (existing >= 0) {
          if (!await asyncConfirm(`A style named "${name}" already exists. Overwrite?`)) return;
          styles[existing] = { name, value };
        } else {
          styles.push({ name, value });
        }
      }
      editingIdx.value = -1;
      nameInput.value = '';
      valInput.value = '';
      const saved = await persistStyles();
      if (!saved) return;
      _refreshAllStyleDropdowns();
      renderList();
      toast('Style saved.', 'ok');
    });

    saveCurrentBtn.addEventListener('click', () => {
      const current = _currentManualText();
      if (!current) { toast('Current tab has no manual prompt text to save.', 'warn'); return; }
      nameInput.focus();
      nameInput.select();
    });

    const addPremadeBtn = el('button', {}, 'Add premade styles');
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
      _refreshAllStyleDropdowns();
      renderList();
      toast(`Added ${added} premade style presets.`, 'ok');
    });

    m.appendChild(el('div', { class: 'footer' }, [cancelBtn, addPremadeBtn, saveCurrentBtn, saveBtn]));
  });
}


function slugifyLabel(s) {
  return String(s || '').toLowerCase().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'field';
}

function scheduleStateSave() {
  // Return a Promise that resolves once the debounced saveAllStates
  // actually completes. Callers that `await scheduleStateSave()`
  // (imageTab, section07, imageOverlays, section15) need the save
  // to have happened before showing "Saved." — otherwise a quick
  // quit can lose the change even after the toast.
  //
  // H-051 (_5 audit): the promise resolves with a TYPED result:
  //   { ok: true }                          — save succeeded
  //   { ok: false, error: '...' }           — save failed (disk/IPC)
  //   { ok: false, canceled: true }         — canceled before it fired
  // Multiple debounce callers share the SAME write and the SAME result.
  //
  // Debounce coalescing: if a second call lands within the 500 ms
  // window, the first timer is cleared — but every caller's promise
  // must still resolve. Collect all pending resolvers and fire
  // them together when the single save completes.
  if (_suppressStateSave > 0) return Promise.resolve({ ok: true, suppressed: true });
  clearTimeout(_stateSaveTimer);
  return new Promise((resolve) => {
    _pendingStateSaveResolvers.push(resolve);
    if (typeof window.logAction === 'function') {
      window.logAction('state-save', 'scheduled', { debounce_ms: 500 });
    }
    _stateSaveTimer = setTimeout(() => {
      _stateSaveTimer = null;
      try {
        const r = saveAllStates();
        if (typeof window.logAction === 'function') {
          window.logAction('state-save', 'fired');
        }
        if (r && typeof r.then === 'function') {
          r.then(
            (res) => _flushPendingStateSaveResolvers({ ok: true, state: res }),
            (err) => _flushPendingStateSaveResolvers({ ok: false, error: String((err && err.message) || err) })
          );
        } else {
          _flushPendingStateSaveResolvers({ ok: true, state: r });
        }
      } catch (e) {
        _flushPendingStateSaveResolvers({ ok: false, error: String((e && e.message) || e) });
      }
    }, 500);
  });
}

// H-051 (_5 audit): resolves all pending scheduleStateSave() callers
// with a TYPED result object so they can distinguish success from
// failure. Called when the debounced saveAllStates completes OR when
// cancelPendingStateSave() deterministically terminates the waiters.
function _flushPendingStateSaveResolvers(result) {
  // Mutate-in-place clear (the array is const-declared, so it can't
  // be reassigned — use .length = 0 instead of = []).
  const resolvers = _pendingStateSaveResolvers.slice();
  _pendingStateSaveResolvers.length = 0;
  const typed = result || { ok: true };
  for (const r of resolvers) { try { r(typed); } catch (_) {} }
}

// R2.5 close handshake (extracted to renderer/closeHandshake.js to keep this file under 1892 LOC).
if (typeof installCloseHandshake === 'function') try { installCloseHandshake(window.api); } catch (_) {}
let _suppressStateSave = 0;
let _stateSaveTimer = null;
const _pendingStateSaveResolvers = [];
// Run `fn` while the auto-save debounce is suppressed. Used by the
// BatchGen runner to overwrite the prompt / style / parameter inputs
// per item without overwriting the user's last-saved prompt in
// state.json. Increments _suppressStateSave before the call and
// decrements it after, even if `fn` throws, so a buggy batch item
// can't permanently lock the auto-save off.
function suppressStateSave(fn) {
  _suppressStateSave++;
  try { return fn(); }
  finally { _suppressStateSave--; }
}
window.suppressStateSave = suppressStateSave;
// Issue 3 + H-051 (_5 audit): cancel a pending debounced state save.
// Used by the "Delete all local data" flow so the 500 ms-debounced save
// can't fire in the reset→relaunch window and write the in-memory
// snapshot (which still holds the just-deleted settings) back to disk.
// H-051: also deterministically resolves all pending waiters with
// { ok: false, canceled: true } so no promise stays open forever.
function cancelPendingStateSave() {
  clearTimeout(_stateSaveTimer);
  _stateSaveTimer = null;
  _flushPendingStateSaveResolvers({ ok: false, canceled: true });
}
window.cancelPendingStateSave = cancelPendingStateSave;
function toPersistable(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  try {
    return JSON.parse(JSON.stringify(obj, (key, value) => {
      if (typeof value === 'function' || value instanceof Promise || (typeof Element !== 'undefined' && value instanceof Element)) {
        return undefined;
      }
      return value;
    }));
  } catch (e) {
    // EFH2-007d fix: return undefined (not null) so the caller skips the save
    // instead of passing null to stateMod.write (which throws on null).
    if (typeof window.logAction === 'function') window.logAction('state-serialize', 'failed', { error: String(e && e.message || e) });
    // KGO-016 fix: surface a toast and status error so the user knows persistence
    // has stopped (previously this was completely silent).
    if (typeof setStatusError === 'function') setStatusError('State serialization failed — settings will not be saved');
    if (typeof window.toast === 'function') window.toast('State serialization failed: ' + (e && e.message || e) + '. Settings will not be saved this session.', 'err', 8000);
    return undefined;
  }
}

function saveAllStates() {
  for (const tabKey of ['image', 'speech', 'music', 'video']) {
    const root = $('#tab-' + tabKey);
    if (!root) continue;
    const data = state.tabSettings[tabKey] || (state.tabSettings[tabKey] = {});
    for (const inp of root.querySelectorAll('input[id], select[id], textarea[id]')) {
      data[inp.id] = inp.type === 'checkbox' ? (inp.checked ? 'on' : '') : inp.value;
    }
  }
  state.batches = state.batches || { image: [], speech: [], music: [], video: [] };
  if (window.api && typeof window.api.stateSet === 'function') {
    try {
      const rawSnapshot = { tabs: state.tabSettings };
      const persistKeys = window.STATE_PERSIST_KEYS || [];
      for (const k of persistKeys) rawSnapshot[k] = state[k];
      const snapshot = toPersistable(rawSnapshot);
      // EFH2-007d fix: skip the save when serialization failed (undefined).
      if (snapshot === undefined) return Promise.resolve();
      return window.api.stateSet(snapshot).then((r) => {
        // H-044: Main (not the renderer) moves L2 overflow to the L3
        // archive. After a successful save, drop exactly the archived
        // count from the FRONT of the in-memory list — those are the
        // oldest entries Main just appended to the archive; jobs that
        // finished during the round trip were appended to the END and
        // stay untouched.
        if (r && r.ok) {
          const archived = Number(r.jobsArchived) || 0;
          if (archived > 0 && Array.isArray(state.jobsSnapshot)) {
            state.jobsSnapshot.splice(0, archived);
          }
        }
        // H-045: archive failures are warnings (the overflow stays in
        // state.json) — surface them instead of silently dropping.
        if (r && Array.isArray(r.warnings) && r.warnings.length) {
          if (typeof window.reportIpcWarnings === 'function') window.reportIpcWarnings(r);
          else if (typeof window.toast === 'function') window.toast('Jobs archive warning: ' + r.warnings[0], 'warn', 6000);
        }
        return r;
      }).catch((err) => {
        if (typeof window.logAction === 'function') {
          window.logAction('state-save', 'failed', { error: String(err && err.message || err) });
        }
        // EFH2-007e fix: route async save failures through setStatusError + toast
        // so the user sees them (previously only logAction was called).
        if (typeof setStatusError === 'function') setStatusError('Settings save failed');
        if (typeof window.toast === 'function') window.toast('Settings save failed: ' + (err && err.message || err), 'warn', 6000);
      });
    } catch (err) {
      if (typeof window.logAction === 'function') {
        window.logAction('state-save', 'failed-sync', { error: String(err && err.message || err) });
      }
      if (typeof setStatusError === 'function') {
        setStatusError('Settings save failed');
      }
      return Promise.reject(err);
    }
  }
  return Promise.resolve();
}

// Window resize can take a "few seconds" for the layout to settle
// because the file-browser list re-runs its CSS grid layout on every
// resize event (the grid-template-columns string has a `minmax(120px,
// 1fr)` column that needs to be re-measured against the new width).
// For folders with hundreds of items, the recalc + repaint can take
// a few seconds.
//
// A single, debounced resize handler throttles the re-render to once
// per 100ms while dragging, then runs a final pass 200ms after the
// last resize event. During the drag there's no JS re-render — CSS
// handles the column re-flow natively on every frame, which is
// faster. A final re-render at the END of the drag keeps the scroll
// positions / selected row in sync (cheap insurance).
let _resizeFrameId = null;
let _resizeEndTimer = null;
window.addEventListener('resize', () => {
  if (_resizeFrameId != null) {
    // Already scheduled; just reset the end timer.
    if (_resizeEndTimer) clearTimeout(_resizeEndTimer);
  } else {
    // Mark a frame request so we re-layout once per
    // animation frame instead of once per resize
    // event. (Chromium fires resize many times per
    // second during a drag; rAF coalesces them.)
    _resizeFrameId = requestAnimationFrame(() => {
      _resizeFrameId = null;
    });
  }
  _resizeEndTimer = setTimeout(() => {
    _resizeEndTimer = null;
    // Final re-render pass: re-apply the file-browser
    // grid template (so the new column widths line up
    // with the row's per-row grid-template-columns
    // style) and re-apply the prompt-character counter
    // (so it ticks on a resize past a wrap
    // point). Both are cheap and only run on the
    // "real" end of the resize.
    try {
      if (window.SplitterDrag && typeof window.SplitterDrag.applyLayoutSettings === 'function') {
        // The CSS variables are the source of truth;
        // re-applying the layout settings re-writes
        // them with the clamped values (which the
        // user might have changed during the resize
        // via a splitter drag).
        window.SplitterDrag.applyLayoutSettings();
      }
    } catch (_) { /* best-effort */ }
    // Re-apply the file-browser grid template so the
    // header / row column widths line up with the new
    // pane width.
    try {
      const ul = document.getElementById('fb-list');
      if (ul && typeof buildFbGridTemplate === 'function') {
        ul.style.gridTemplateColumns = buildFbGridTemplate();
        // Also re-apply per-row grid-template-columns
        // so the row contents line up with the new
        // column widths.
        for (const li of ul.querySelectorAll('.fb-item')) {
          li.style.gridTemplateColumns = buildFbGridTemplate();
        }
      }
    } catch (_) { /* best-effort */ }
  }, 200);
});

document.addEventListener('DOMContentLoaded', () => {
  init().catch((e) => {
    // Surface init failures in the log pane AND the file log, not
    // just a toast (which disappears after 8s).
    if (typeof window.logError === 'function') {
      window.logError('init', 'renderer/app.js:1715', e);
    } else {
      console.error(e);
    }
    toast(String(e), 'err', 8000);
  });
});

