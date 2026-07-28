// renderer/pipeline/pipelineImport.js
// Feature 3 — the Import column's intake UI: OS drag-drop (from Windows
// Explorer), "Load from disc…", and paste-from-clipboard. This is the one
// genuinely new intake capability: the existing utils/dropTarget.js explicitly
// ignores OS file drops (it only accepts the internal MIME type for in-app
// moves). Here we accept real OS File objects and resolve them to paths via the
// preload's pathForDragFile bridge (webUtils.getPathForFile — only available in
// the preload under contextIsolation).

(function () {
  // OS drag-drop (real File objects from the OS, not internal moves).
  function wireDragDrop(drop) {
    drop.addEventListener('dragover', (e) => {
      // Accept anything — OS file drops carry 'Files' in types.
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        drop.classList.add('drag-over');
      }
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.remove('drag-over');
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      // Resolve each OS File to a real path via the preload bridge.
      const paths = files.map((f) => window.api.pathForDragFile(f)).filter(Boolean);
      if (!paths.length) {
        if (window.toast) window.toast('Could not resolve dropped files.', 'warn');
        return;
      }
      const r = await window.Pipeline.enqueueFromPaths(paths);
      // QA-012 fix: only show success when at least one file was imported.
      if (r && r.ok && r.added > 0) {
        if (window.toast) window.toast(`Imported ${r.added} image(s).`, 'ok');
      } else if (r && !r.ok) {
        if (window.toast) window.toast(r.error || 'Import failed.', 'err');
      }
    });
  }

  // Paste-from-clipboard (screenshot → pipeline).
  if (!window._pipelinePasteWired) {
    document.addEventListener('paste', (e) => {
      if (!document.getElementById('pipeline-overlay')) return;
      const items = (e.clipboardData && e.clipboardData.items) ? Array.from(e.clipboardData.items) : [];
      const imageItems = items.filter((it) => it.type && it.type.startsWith('image/'));
      if (!imageItems.length) return;
      e.preventDefault();
      // Clipboard images don't have a path — write them to a temp file first,
      // then enqueue. (Best-effort; requires fb:write under an allowed root.)
      Promise.all(imageItems.map(async (it) => {
        const blob = it.getAsFile();
        if (!blob) return null;
        const board = window.state.pipeline.image;
        const out = board.workspace || '';
        if (!out) return null;
        const sep = out.includes('\\') ? '\\' : '/';
        // Unique per-image name: a clipboard paste can deliver multiple images
        // in the same millisecond, so Date.now() alone collides and one image
        // silently overwrites another. Add a random suffix (360°-sweep fix,
        // same class as H7-023).
        const rnd = Math.random().toString(36).slice(2, 8);
        const tmp = out + sep + 'original' + sep + 'clipboard_' + Date.now() + '_' + rnd + '.png';
        try {
          // fbEnsureDir creates the exact dir (1-arg); fbMkdir takes (dir,
          // name) and rejects an undefined name. fbWrite requires a base64
          // STRING, not a Uint8Array — so encode the blob bytes first.
          // BGR-009 fix: mint mkdir grant for fbEnsureDir (R1.3 gate).
          const dirGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDir(out + sep + 'original') : undefined;
          await window.api.fbEnsureDir(out + sep + 'original', dirGrant);
          const arr = new Uint8Array(await blob.arrayBuffer());
          const b64 = bytesToBase64(arr);
          // R1.5a.follow-up Phase 4: mint grant for tmp before write.
          // PRE-1: use window.GrantCache (no require in sandbox).
          const wg = window.api && window.api.mintGrant ? await window.GrantCache.ensurePathGrant(tmp, 'write') : undefined;
          if (wg && wg.ok === false) return null;
          await window.api.fbWrite(tmp, b64, wg);
          return tmp;
        } catch (_) { return null; }
      })).then((paths) => window.Pipeline.enqueueFromPaths(paths.filter(Boolean)));
    });
    window._pipelinePasteWired = true;
  }

  // Encode a Uint8Array to a base64 string (fbWrite requires a base64 string).
  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  async function loadFromDisc() {
    try {
      // pickFile returns { ok, path } (a single path field), NOT { filePaths }.
      // The prior code read r.filePaths → always undefined → silent no-op.
      const r = await window.api.pickFile();
      const picked = r && r.ok && r.path ? r.path : null;
      if (!picked) return;
      const res = await window.Pipeline.enqueueFromPaths([picked]);
      if (window.toast) window.toast(`Imported ${res.added || 0} image(s).`, 'ok');
    } catch (e) { if (window.toast) window.toast('Load failed: ' + ((e && e.message) || e), 'err'); }
  }

  window.PipelineImport = { wireDragDrop, loadFromDisc };
})();
