// renderer/pipeline/pipelineOverlay.js
// The full-window Pipeline overlay (open/close lifecycle).
//
// The app is strictly single-window (setWindowOpenHandler denies all child
// windows, CSP blocks frames), so the Pipeline surface is a fixed-position DOM
// overlay appended to <body> at z-index 200, below modals (300) and the image
// viewer (250), with its own keydown/click-close handlers. This gives a
// "new window that's almost as the main window" feel
// without breaking the security model.
//
// Public API: window.Pipeline.open() / .enqueueFromPaths(paths) / .openImage(path, list)

(function () {
  let _pipelineClose = null;

  // R3 fix: after an app restart the session-scoped WorkspaceService registry
  // is empty, so a persisted custom `workspaceId` no longer resolves and
  // `state:get` flags the board `reauthorizationRequired` (see
  // main/ipc/registerStateIpc.js). Left unhandled, every pipeline write
  // (import/replace/trash/thumb/duplicate) silently falls back to the
  // Main-derived app-output root and the user's custom folder is lost. S1 §4
  // mandates that only the native folder-picker flow may (re-)register a
  // workspace, so we re-prompt the user to pick the folder and mint a fresh
  // workspaceId. Declining clears the flag and uses the default output root.
  // Called from both open() and enqueueFromPaths() — the two entry points that
  // can run before any overlay card operation.
  let _reauthInFlight = null;
  async function reauthorizeWorkspace(b) {
    // Serialize concurrent calls (e.g. two auto-enqueues from a concurrent
    // batch) so we never stack two re-authorization modals.
    if (_reauthInFlight) return _reauthInFlight;
    _reauthInFlight = (async () => {
      const userOk = await new Promise((resolve) => {
        if (typeof showModal === 'function') {
          showModal((m, close) => {
            m.appendChild(el('h2', {}, '📂 Re-authorize pipeline folder'));
            m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 13px; margin: 12px 0; white-space: pre-line;' },
              'Folder authorizations reset when the app restarts, so the Pipeline needs you to confirm its working folder again.\n\nClick OK to re-select the folder, or Cancel to use the default output folder.'));
            m.appendChild(el('div', { class: 'footer', style: 'display: flex; justify-content: flex-end; gap: 8px;' }, [
              el('button', { onclick: () => { close(); resolve(false); } }, 'Cancel'),
              el('button', { class: 'primary', onclick: () => { close(); resolve(true); } }, 'OK'),
            ]));
          });
        } else {
          // No showModal (should not happen in practice). Do NOT add a blocking
          // confirm() — the antipattern ratchet forbids new blocking dialogs.
          // Resolve false (decline) to match window.asyncConfirm's own
          // missing-showModal fallback; the board then uses the default root.
          resolve(false);
        }
      });
      // Clear the flag either way so we only prompt once per session. If the
      // user picks a folder we mint a fresh workspaceId below; if they decline
      // the board falls back to the Main-derived app-output root.
      b.reauthorizationRequired = false;
      if (!userOk) {
        if (typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
        return;
      }
      try {
        const chosen = await window.api.pickFolder();
        if (chosen && typeof chosen === 'string') {
          const sep = chosen.includes('\\') ? '\\' : '/';
          b.workspace = chosen.replace(/[\\/]+$/, '') + sep + 'pipeline' + sep + 'image';
          if (window.api.pipelineMintWorkspace) {
            const m = await window.api.pipelineMintWorkspace({ path: b.workspace });
            if (m && m.ok && m.workspaceId) b.workspaceId = m.workspaceId;
          }
          if (typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
          if (typeof toast === 'function') toast('Pipeline folder re-authorized: ' + b.workspace);
        }
      } catch (e) {
        if (typeof toast === 'function') toast('Failed to re-authorize the pipeline folder.', 'err');
      }
    })();
    try { return await _reauthInFlight; } finally { _reauthInFlight = null; }
  }

  async function open() {
    const b = window.state.pipeline.image;
    // R3 fix: a persisted custom workspace stops resolving after a restart (the
    // WorkspaceService registry is session-scoped), so state:get flags the
    // board reauthorizationRequired. Re-prompt before anything else so writes
    // go to the user's folder instead of silently falling back to the
    // app-output root. Track it so the fresh-install prompt below doesn't fire
    // a second modal in the same open().
    let reauthHandled = false;
    if (b.reauthorizationRequired) {
      reauthHandled = true;
      await reauthorizeWorkspace(b);
    }
    if (!reauthHandled && !b.workspace && (!window.state.config || !window.state.config.output_dir)) {
      // KGO-014 fix: replace blocking window.confirm with a non-blocking showModal.
      const userOk = await new Promise((resolve) => {
        if (typeof showModal === 'function') {
          showModal((m, close) => {
            m.appendChild(el('h2', {}, '📂 Pipeline workspace'));
            m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 13px; margin: 12px 0; white-space: pre-line;' },
              'The Pipeline requires a working folder to store intermediate images and final outputs.\n\nClick OK to choose a folder now, or Cancel to use the default.'));
            m.appendChild(el('div', { class: 'footer', style: 'display: flex; justify-content: flex-end; gap: 8px;' }, [
              el('button', { onclick: () => { close(); resolve(false); } }, 'Cancel'),
              el('button', { class: 'primary', onclick: () => { close(); resolve(true); } }, 'OK'),
            ]));
          });
        } else {
          // Fallback if showModal is unavailable (should not happen in practice).
          resolve(confirm('The Pipeline requires a working folder to store intermediate images and final outputs.\n\nClick OK to choose a folder now, or Cancel to use the default.'));
        }
      });
      if (userOk) {
        try {
          // pickFolder (config:pickFolder) returns a bare string (or null).
          const chosen = await window.api.pickFolder();
          if (chosen && typeof chosen === 'string') {
            const sep = chosen.includes('\\') ? '\\' : '/';
            b.workspace = chosen.replace(/[\\/]+$/, '') + sep + 'pipeline' + sep + 'image';
            // QA-001 fix: mint a workspaceId so the main handler uses this
            // custom workspace instead of falling back to the app-output root.
            // Store it on the PERSISTED `workspaceId` field (not a transient
            // `_workspaceId`): sanitisePipelineBoard persists `workspaceId`,
            // so a transient field is dropped on save and the custom workspace
            // is lost on the first autosave -> imports silently fall back to
            // the app-output root after restart.
            if (window.api.pipelineMintWorkspace) {
              const m = await window.api.pipelineMintWorkspace({ path: b.workspace });
              if (m && m.ok && m.workspaceId) b.workspaceId = m.workspaceId;
            }
            if (typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
            if (typeof toast === 'function') toast('Workspace set to: ' + b.workspace);
          }
        } catch (e) {
          if (typeof toast === 'function') toast('Failed to select workspace.', 'err');
        }
      }
    }
    // If one is already open, just focus it (no-op reopen).
    if (_pipelineClose) { try { _pipelineClose(); } catch (_) {} _pipelineClose = null; }

    const overlay = el('div', { class: 'pipeline-overlay', id: 'pipeline-overlay' });

    // ---- Header (§2.5) ----
    const dropzone = el('div', { class: 'pipeline-dropzone-header', id: 'pipeline-dropzone-header' }, 'Drag images here');
    window.PipelineImport.wireDragDrop(dropzone);

    const loadBtn = el('button', { class: 'btn-mini primary', title: 'Load images from disc' }, '📁 Load from disc…');
    loadBtn.addEventListener('click', window.PipelineImport.loadFromDisc);

    // H11-2: ONE central folder button that sets the workspace (the single
    // output folder) for ALL columns. Replaces the former per-column 📁 buttons.
    const folderBtn = el('button', { class: 'btn-mini', title: 'Set the output folder for the whole pipeline' }, '📂 Folder…');
    folderBtn.addEventListener('click', async () => {
      try {
        const chosen = await window.api.pickFolder();
        if (chosen && typeof chosen === 'string') {
          const sep = chosen.includes('\\') ? '\\' : '/';
          b.workspace = chosen.replace(/[\\/]+$/, '') + sep + 'pipeline' + sep + 'image';
          // QA-001 fix: mint a workspaceId for the custom folder. Persist it
          // on `workspaceId` (the field sanitisePipelineBoard keeps) so it
          // survives autosave + restart — see the open() folder-pick note.
          if (window.api.pipelineMintWorkspace) {
            const m = await window.api.pipelineMintWorkspace({ path: b.workspace });
            if (m && m.ok && m.workspaceId) b.workspaceId = m.workspaceId;
          }
          // Per-column overrides are obsolete with one central folder — clear
          // any leftover entries from the old per-column model so outPath stops
          // fragmenting outputs across stale folders.
          b.columnFolders = {};
          if (typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
          if (typeof toast === 'function') toast('Pipeline output folder set: ' + chosen);
          folderBtn.title = 'Pipeline output folder:\n' + b.workspace;
        }
      } catch (_) {
        if (typeof toast === 'function') toast('Folder selection failed.', 'err');
      }
    });
    if (b.workspace) folderBtn.title = 'Pipeline output folder:\n' + b.workspace;

    // Issue-2: the icon sits in its own span so CSS can nudge it up
    // ~2px (emoji baselines sit lower than the surrounding text).
    const title = el('span', { class: 'pipeline-title' }, [el('span', { class: 'pipeline-title-icon' }, '🛤'), ' Pipeline']);
    const summary = el('span', { class: 'pipeline-summary', id: 'pipeline-summary' }, '');
    const filterInput = el('input', { type: 'text', class: 'pipeline-filter', id: 'pipeline-filter', placeholder: 'Filter cards…' });
    // The Final-column operations menu (Clear / Clear+report / Export /
    // Export+report), offered from the header.
    const finalMenuBtn = el('button', { class: 'btn-mini pipeline-final-menu', title: 'Clear or export the finalized images (with optional report)' }, '📦 Final column ▾');
    finalMenuBtn.addEventListener('click', () => {
      if (window.PipelineClear && typeof window.PipelineClear.openFinalColumnMenu === 'function') {
        window.PipelineClear.openFinalColumnMenu();
      } else if (window.PipelineCardExtras && window.PipelineCardExtras.batchExportAndRemoveFinal) {
        // Fallback to the legacy single-action export if the new module isn't loaded.
        window.PipelineCardExtras.batchExportAndRemoveFinal();
      } else {
        if (typeof toast === 'function') toast('Final-column operations not available (module missing).', 'err');
      }
    });
    const closeBtn = el('button', { class: 'btn-mini pipeline-close', title: 'Close (Esc)' }, '✕');
    // Issue-2: two-row header. Row 1 = title + dropzone + load/folder
    // buttons + summary + final-menu + close, spread over the full width
    // with no text abbreviation (the summary no longer ellipsizes). Row 2
    // = the card filter input on its own dedicated full-width line, so it
    // no longer squeezes the row-1 controls on narrow windows.
    const headerRow1 = el('div', { class: 'pipeline-header-row' }, [title, dropzone, loadBtn, folderBtn, summary, finalMenuBtn, closeBtn]);
    const headerRow2 = el('div', { class: 'pipeline-header-row pipeline-header-filter-row' }, [filterInput]);
    const header = el('div', { class: 'pipeline-header' }, [headerRow1, headerRow2]);

    // ---- Columns area ----
    const columns = el('div', { class: 'pipeline-columns', id: 'pipeline-columns' });
    const scroll = el('div', { class: 'pipeline-scroll' }, [columns]);
    overlay.append(header, scroll);
    document.body.appendChild(overlay);

    // Wire up the board renderer (pipelineBoard.js).
    PipelineBoard.mount(columns, summary, filterInput);

    const popScope = (window.ShortcutScope && typeof window.ShortcutScope.push === 'function')
      ? window.ShortcutScope.push('pipeline')
      : null;

    // Close handlers.
    const onKey = (e) => {
      if (document.getElementById('modal-root')?.classList.contains('active')) return;
      if (document.getElementById('image-overlay')) return;
      if (e.key === 'Escape' && document.getElementById('pipeline-overlay')) {
        // Only close if no input is focused (so Esc in a text field doesn't kill the board).
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') close();
      }
    };
    document.addEventListener('keydown', onKey);
    const close = () => {
      if (popScope) popScope();
      PipelineBoard.unmount();
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (_pipelineClose === close) _pipelineClose = null;
      // Refresh the underlying file browser in case the workspace changed.
      try { if (typeof window.refreshBrowser === 'function') window.refreshBrowser(); } catch (_) {}
    };
    _pipelineClose = close;
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    filterInput.addEventListener('input', () => PipelineBoard.applyFilter(filterInput.value));

    return close;
  }

  // Enqueue files (from drag-drop, "Load from disc", or the "Add to Pipeline"
  // context-menu action). Copies them into the original column via the IPC.
  async function enqueueFromPaths(paths, opts) {
    opts = opts || {};
    if (!Array.isArray(paths) || paths.length === 0) return { ok: false, error: 'No paths.' };
    const board = window.state.pipeline.image;
    // R3 fix: enqueue can run without the overlay (auto-pipeline after a
    // generation, or the file browser's "Add to Pipeline"), so it must honour
    // reauthorizationRequired too — otherwise a post-restart import silently
    // lands in the app-output root instead of the user's custom folder.
    if (board.reauthorizationRequired) {
      await reauthorizeWorkspace(board);
    }
    const items = paths.map((p) => ({
      srcAbsPath: p,
      destColumn: 'original',
      displayName: (p.split(/[\\/]/).pop()),
    }));
    let r;
    try {
      // QA-001 fix: thread workspaceId so main resolves the correct workspace.
      // Read the PERSISTED `workspaceId` field so a custom workspace survives
      // restart (a transient `_workspaceId` would be undefined here after a
      // reload, sending imports to the app-output fallback root).
      r = await window.api.pipelineImport({ items, workspaceId: board.workspaceId || undefined });
    }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    if (!r || !r.results) return { ok: false, error: 'Import returned no results.' };
    // H9-006: pass the caller's per-item settings through instead of dropping
    // them. The board's per-item settings shape is column-keyed overrides
    // (pipelineModel.resolveSettings(column, itemSettings) reads
    // itemSettings[column] as an OBJECT of column-specific keys). Callers may
    // pass either a ready column-keyed object or a FLAT map of postprocess
    // flags (e.g. the batch runner's rowPostprocess: { upscale: 'true',
    // upscaleMultiplier: '2', crop: '200x200', removeBackground: 'true' })
    // — normalise the flat shape into the column-keyed shape.
    //
    // gewv2 GEW-006 fix: the OLD detection (`if (baseSettings.upscale || ...)
    // return baseSettings`) misfired on a flat map — flat keys like `upscale`
    // or `crop` are truthy STRINGS ('true' / '200x200'), so the flat map was
    // returned VERBATIM and stored as the item's settings. Later,
    // resolveSettings(column, itemSettings) read `itemSettings[column]`
    // (e.g. itemSettings.upscale === 'true', a STRING) and spread it
    // (`{...def, ...'true'}`) — spreading a string produces garbage indexed
    // keys, so the column defaults silently won and the sanitizer then
    // dropped the non-object value entirely on persist. A batch row's
    // `--upscale-multiplier 4` therefore had NO effect once the item reached
    // the board; this fix maps the flat shape into real per-column objects.
    const baseSettings = (opts.settings && typeof opts.settings === 'object') ? opts.settings : {};
    function isColumnKeyedObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
    function flatToColumnKeyed(flat) {
      const out = {};
      if (isColumnKeyedObject(flat.upscale)) out.upscale = flat.upscale;
      else if (flat.upscale === true || flat.upscale === 'true') {
        out.upscale = { multiplier: parseInt(flat.upscaleMultiplier, 10) || 2 };
        if (flat.upscaleModel) out.upscale.model = flat.upscaleModel;
      }
      if (isColumnKeyedObject(flat.removebg)) out.removebg = flat.removebg;
      else if (isColumnKeyedObject(flat.removeBackground)) out.removebg = flat.removeBackground;
      else if (flat.removeBackground === true || flat.removeBackground === 'true') {
        out.removebg = {};
        if (flat.removeBackgroundModel) out.removebg.model = flat.removeBackgroundModel;
        if (flat.removeBackgroundUseGpu != null) {
          out.removebg.useGpu = flat.removeBackgroundUseGpu !== false && flat.removeBackgroundUseGpu !== 'false';
        }
      }
      if (isColumnKeyedObject(flat.crop)) out.crop = flat.crop;
      else if (typeof flat.crop === 'string') {
        const m = flat.crop.match(/(\d+)\s*[x×]\s*(\d+)/i);
        if (m) out.crop = { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
      }
      if (isColumnKeyedObject(flat.resize)) out.resize = flat.resize;
      else if (typeof flat.resize === 'string') {
        const m = flat.resize.match(/(\d+)\s*[x×]\s*(\d+)/i);
        if (m) out.resize = { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
      }
      if (isColumnKeyedObject(flat.optimize)) out.optimize = flat.optimize;
      else if (flat.optimizeFormat) {
        out.optimize = { format: flat.optimizeFormat };
        if (flat.optimizeQuality != null) out.optimize.quality = parseInt(flat.optimizeQuality, 10);
        if (flat.stripMetadata != null) out.optimize.stripMetadata = flat.stripMetadata !== false && flat.stripMetadata !== 'false';
      }
      return out;
    }
    function buildSettings() {
      // If the caller already supplied a fully column-keyed object (every
      // present top-level key is itself an object), use it verbatim.
      const topKeys = ['upscale', 'removebg', 'removeBackground', 'crop', 'resize', 'optimize', 'final'];
      const presentKeys = topKeys.filter((k) => baseSettings[k] !== undefined);
      const alreadyColumnKeyed = presentKeys.length > 0 && presentKeys.every((k) => isColumnKeyedObject(baseSettings[k]));
      if (alreadyColumnKeyed) return baseSettings;
      // Otherwise it's a flat postprocess-flag map (or empty) — normalise.
      return flatToColumnKeyed(baseSettings);
    }
    // Add each successfully-imported file as a new board item.
    let added = 0;
    for (const res of r.results) {
      if (res && res.ok && res.dst) {
        const id = res.imageId;
        board.items.push({
          id,
          column: 'original',
          name: (res.src && res.src.split(/[\\/]/).pop()) || 'image',
          createdAt: Date.now(),
          files: { original: res.dst },
          settings: buildSettings(), // H9-006: was a hardcoded {}
          history: [{ action: 'import', column: 'original', file: res.dst, ts: Date.now() }],
          status: 'idle',
          error: null,
        });
        board.counter = (board.counter || 0) + 1;
        added += 1;
      }
    }
    if (typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
    PipelineBoard.render();
    PipelineBoard.refreshBadge();
    // QA-012 fix: report failure when every import failed so callers don't
    // show a misleading success toast.
    if (added === 0 && r.results.length > 0) {
      const firstErr = r.results.find((x) => x && x.error);
      return { ok: false, added: 0, error: (firstErr && firstErr.error) || 'All imports failed.' };
    }
    return { ok: true, added };
  }

  // Build a correct file:// URL via the canonical helper (fileUrl.js) — on
  // Windows `C:\x` must become `file:///C:/x` (three slashes) and the path must
  // be URI-encoded so spaces/#/? don't break the <img> src.
  function fileUrl(p) {
    if (window.FileUrl && typeof window.FileUrl.fileUrl === 'function') return window.FileUrl.fileUrl(p);
    return 'file:///' + String(p || '').replace(/\\/g, '/');
  }

  // Open a Pipeline image in the existing full-size overlay, with prev/next
  // navigation scoped to the given list of file paths (a column's cards).
  function openImage(filePath, fileList) {
    if (typeof window.openImageOverlay !== 'function') {
      // Fallback: open in Explorer if the overlay isn't available.
      try { window.api.fbOpenInExplorer(filePath); } catch (_) {}
      return;
    }
    // Set the preview batch as the OBJECT shape buildOverlayNavList expects
    // ({ paths: [...], index }) so navigation is scoped to the column's cards.
    const paths = (Array.isArray(fileList) ? fileList.slice() : [filePath]).filter(Boolean);
    window.state._previewBatch = { paths, index: Math.max(0, paths.indexOf(filePath)) };
    const name = filePath.split(/[\\/]/).pop();
    window.openImageOverlay(fileUrl(filePath), name, 0, 0, filePath);
  }

  window.Pipeline = window.Pipeline || {};
  window.Pipeline.open = open;
  window.Pipeline.enqueueFromPaths = enqueueFromPaths;
  window.Pipeline.openImage = openImage;
})();
