// renderer/overlays/imageEditorExitGuard.js
// ============================================================
// P3.3 (DA-H-004): APP-EXIT DIRTY GUARD
// ============================================================
// The main process consults the window.__* globals below (via
// executeJavaScript in createMainWindow's close handler) BEFORE the
// confirm-close dialog so it can list the unsaved edited images and offer
// "Save all & close" / "Discard & close". Unsaved work lives in either the
// OPEN editor (window.__ieCtrl) or the PERSISTED one (Issue-13 keeps closed
// editors alive in memory via imageEditorOverlay's private `_persisted`,
// reached through ImageEditorOverlay._getPersistedCtrl()) — without this
// guard those dirty slots would be silently destroyed on app quit.
//
// Extracted from imageEditorOverlay.js so that file stays inside its frozen
// size budget (scripts/lint.js SIZE_BUDGETS ratchet).
(function () {
  const baseName = (p) => String(p || '').split(/[\\/]/).pop() || '';

  function collectEditorControllers() {
    const ctrls = [];
    if (window.__ieCtrl && !window.__ieCtrl.closed) ctrls.push(window.__ieCtrl);
    const persisted = (window.ImageEditorOverlay && window.ImageEditorOverlay._getPersistedCtrl)
      ? window.ImageEditorOverlay._getPersistedCtrl() : null;
    if (persisted && ctrls.indexOf(persisted) === -1) ctrls.push(persisted);
    return ctrls;
  }

  function getUnsavedEditorInfo() {
    const names = [];
    collectEditorControllers().forEach((ctrl) => {
      (ctrl.queue || []).forEach((s) => {
        if (s && s.modified) names.push(s.name || baseName(s.path || '') || 'untitled');
      });
    });
    return names;
  }

  // Headless "Save all": mirrors imageEditorActions.doSave but NEVER
  // prompts (the app is quitting) — alpha forces PNG instead of asking,
  // and a path collision auto-versions instead of an overwrite confirm.
  // Returns { ok:true, saved } or { ok:false, saved, error }.
  async function saveAllEditorSessions() {
    const A = window.ImageEditorActions;
    if (!A) return { ok: false, saved: 0, error: 'editor actions unavailable' };
    const failed = [];
    let saved = 0;
    for (const ctrl of collectEditorControllers()) {
      for (const slot of (ctrl.queue || [])) {
        if (!slot || !slot.modified) continue;
        try {
          if (!slot.handle || !slot.handle.session) throw new Error('no live session');
          const fmt = A.canvasHasAlpha(slot.handle.session) ? 'png' : ((ctrl.prefs && ctrl.prefs.outFormat) || 'png');
          let temp, dataUrl;
          try {
            // renderSceneAtNaturalSize lives on the handle (doSave) — fall
            // back to the session for older handles (onExternal path).
            const r = (typeof slot.handle.renderSceneAtNaturalSize === 'function') ? slot.handle : slot.handle.session;
            temp = r.renderSceneAtNaturalSize();
            dataUrl = temp.toCanvasElement(1).toDataURL(A.mimeForFmt(fmt), fmt === 'png' ? undefined : 0.92);
          } finally { try { temp && temp.dispose(); } catch (_) {} }
          const b64 = dataUrl.split(',')[1];
          let outPath = A.derivedEditedPath(slot.path, fmt);
          try {
            const eg = (window.GrantHelper) ? await window.GrantHelper.ensureRead(outPath) : undefined;
            const ex = (eg && eg.ok === false) ? { exists: true } : await window.api.fbExists(outPath, eg);
            if (ex && ex.exists) outPath = await A.nextFreeVersion(outPath);
          } catch (_) { /* existence check is best-effort */ }
          const wg = (window.GrantCache) ? await window.GrantCache.ensurePathGrant(outPath, 'write') : undefined;
          if (wg && wg.ok === false) throw new Error(wg.error || 'mintGrant failed');
          const w = await ((window.api.writeImageBase64) ? window.api.writeImageBase64(outPath, b64, wg) : window.api.fbWrite(outPath, b64, wg));
          if (!w || w.ok === false) throw new Error((w && w.error) || 'write failed');
          slot.modified = false;
          saved++;
        } catch (e) {
          failed.push((slot.name || 'image') + ': ' + ((e && e.message) || e));
        }
      }
    }
    if (failed.length) return { ok: false, saved, error: failed.join('; ') };
    return { ok: true, saved };
  }

  // Main-world globals for the main process's executeJavaScript probe.
  window.__getUnsavedEditorInfo = getUnsavedEditorInfo;
  window.__saveAllEditorSessions = saveAllEditorSessions;

  window.ImageEditorExitGuard = { getUnsavedEditorInfo, saveAllEditorSessions };
})();
