// renderer/overlays/imageEditorAssetBg.js
// H8-F2-P4: ✂ Remove BG on the Asset Composer panel (extracted from
// imageEditorAssetPanel.js to keep the panel shell under the 500-line cap).
//
// Same pipeline as the main canvas's onRemoveBg (imageEditorActions.js,
// H8-001 + R5.2 pattern): bake → temp PNG → isnetbgRun → swap base.
// Differences: the result replaces the ASSET session's base image (the
// session and its undo stack survive — isnet output has identical
// dimensions), the output file is KEPT as the asset's new backing path,
// and the single-flight flag is per-panel (ctrl._assetRemoveBgInFlight).
//
// Depends on globals: toast, loadImageFromFile (pureFuncs), ensureSubDir
// (app.js), window.api (isnetbgRun/mintGrant/writeImageBase64/fbWrite/
// fbDelete/pathDirname), window.GrantCache, window.ImageEditorTools
// (pushUndo), window.ImageEditorAssetExtras (persistTab, C2).
(function () {
  'use strict';

  function panelOf(ctrl) { return (ctrl && ctrl.assetPanel) ? ctrl.assetPanel : null; }

  function baseName(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    return slash >= 0 ? norm.slice(slash + 1) : norm;
  }

  function dirNameOf(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    return slash >= 0 ? norm.slice(0, slash) : '.';
  }

  async function removeBgOnAsset(ctrl) {
    const P = panelOf(ctrl); if (!P) return;
    const s = P.handle && P.handle.session;
    const hasContent = s && (s.baseObject || s.canvas.getObjects().length > 0);
    if (!hasContent) { toast('Load an asset image first.', 'warn', 2500); return; }
    if (!window.api || !window.api.isnetbgRun) { toast('Background-removal backend not available.', 'err', 4000); return; }
    if (ctrl._assetRemoveBgInFlight) return; // single-flight
    ctrl._assetRemoveBgInFlight = true;
    const btn = P.removeBgBtn;
    if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
    try {
      // Bake the current asset scene at natural size (alpha preserved).
      let temp = null, bakedB64;
      try {
        temp = P.handle.renderSceneAtNaturalSize();
        bakedB64 = temp.toDataURL({ format: 'image/png', multiplier: 1 }).split(',')[1];
      } finally { try { temp && temp.dispose(); } catch (_) {} }

      // Temp files next to the asset, or in the image output dir when the
      // panel has no backing file yet (fresh painted canvas).
      const sessionKey = 'asset_' + (ctrl.activeIndex || 0);
      const { path: tmpSrc, grantId: wg } = window.ImageEditorWorkDir
        ? await window.ImageEditorWorkDir.getWorkFilePath(sessionKey, '.ie_asset_bg_src_', '.png')
        : { path: ((window.state && window.state.config && window.state.config.output_dir) ? window.state.config.output_dir : 'image') + '/.ie_asset_bg_src_' + Date.now() + '.png', grantId: undefined };
      const { path: tmpOut } = window.ImageEditorWorkDir
        ? await window.ImageEditorWorkDir.getWorkFilePath(sessionKey, '.ie_asset_bg_out_', '.png')
        : { path: ((window.state && window.state.config && window.state.config.output_dir) ? window.state.config.output_dir : 'image') + '/.ie_asset_bg_out_' + Date.now() + '.png' };
      if (wg && wg.ok === false) throw new Error('removeBg: ' + (wg.error || 'mintGrant failed'));
      const writeTmp = window.api.writeImageBase64
        ? window.api.writeImageBase64(tmpSrc, bakedB64, wg)
        : window.api.fbWrite(tmpSrc, bakedB64, wg);
      await writeTmp;
      const st = (typeof window.state === 'object' && window.state) || {};
      // gewv2 GEW-010 fix: default to the higher-quality bundled model.
      const model = st.removeBackgroundModel || 'birefnet-general-lite';
      const useGpu = st.removeBackgroundUseGpu !== false;
      // PE-015: thread postprocess opts from advanced settings.
      const advBg = (st.pipelineAdvancedSettings && st.pipelineAdvancedSettings.isnetbg) || {};
      const postOpts = {};
      if (advBg.postClean === false) postOpts.postClean = false;
      if (typeof advBg.featherPx === 'number') postOpts.featherPx = advBg.featherPx;
      if (advBg.defringe === false) postOpts.defringe = false;
      if (advBg.refine === false) postOpts.refine = false;
      let r;
      try {
        // Directory grant with read+write on the PARENT (the handler reads
        // tmpSrc AND writes the sibling tmpOut — same as the main flow).
        const isnetGrant = window.api.mintGrant
          ? await window.GrantCache.ensurePathGrant(
              window.api.pathDirname(tmpSrc), 'read',
              { kind: 'directory', capabilities: ['read', 'write'] })
          : undefined;
        if (isnetGrant && isnetGrant.ok === false) throw new Error('removeBg: ' + (isnetGrant.error || 'mintGrant failed'));
        r = await window.api.isnetbgRun(tmpSrc, tmpOut, { model, useGpu, ...postOpts }, isnetGrant);
      } finally {
        // BGR-009 fix: mint delete grant (R1.3 gate).
        try { if (window.FbIntent) { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpSrc) : undefined; await window.FbIntent.del(tmpSrc, dg); } } catch (_) {} // B-007 (hhhhu3 audit): delete via native confirmation
      }
      if (!r || !r.ok) {
        // BGR-009 fix: mint delete grant (R1.3 gate).
        try { if (window.FbIntent) { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpOut) : undefined; await window.FbIntent.del(tmpOut, dg); } } catch (_) {} // B-007 (hhhhu3 audit): delete via native confirmation
        throw new Error((r && r.error) || 'background removal failed');
      }
      // KGO7-010: surface a silent model substitution (one shared impl).
      if (window.Section08Helpers) window.Section08Helpers.warnModelFallback(r);
      // R5.2 pattern: pre-snapshot BEFORE the base swap + cancel-cleanup on
      // failure (pop the orphaned snapshot so undo stays consistent).
      let pushedPreSnapshot = false;
      try {
        try {
          if (window.ImageEditorTools && typeof window.ImageEditorTools.pushUndo === 'function') {
            window.ImageEditorTools.pushUndo(s);
            pushedPreSnapshot = true;
          }
        } catch (_) { /* defensive: proceed without undo for this remove-bg */ }
        const outPath = r.path || tmpOut;
        const img = await loadImageFromFile(outPath);
        s.canvas.clear();
        await P.handle.setBaseImage(img);
        P.revision = (P.revision || 0) + 1; // PE-010: asset base replaced (stale guard)
        s.canvas.renderAll();
        P.path = outPath; // keep the result as the asset's backing file
        const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
        P.meta.textContent = baseName(outPath) + ' · ' + w + '×' + h + ' · BG removed';
        // H8-F2 C2: keep the current tab snapshot in sync.
        if (window.ImageEditorAssetExtras && window.ImageEditorAssetExtras.persistTab) {
          window.ImageEditorAssetExtras.persistTab(ctrl);
        }
        requestAnimationFrame(() => {
          if (!P.collapsed && P.wrap.clientWidth > 0) P.handle.fitToContainer(P.wrap);
        });
        toast('Background removed from asset.', 'ok', 2500);
      } catch (e) {
        if (pushedPreSnapshot) {
          try { if (Array.isArray(s._undo) && s._undo.length) s._undo.pop(); } catch (_) {}
        }
        // gewv2 GEW-008 fix: a post-removal failure (image load / setBaseImage)
        // must not leave the temp output file behind — P.path only starts
        // tracking outPath as the asset's backing file on the SUCCESS path,
        // so on this catch tmpOut is still an orphaned temp file.
        try { if (window.FbIntent) { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpOut) : undefined; await window.FbIntent.del(tmpOut, dg); } } catch (_) {} // B-007 (hhhhu3 audit): delete via native confirmation
        throw e;
      }
    } catch (e) {
      toast('Remove BG failed: ' + ((e && e.message) || e), 'err', 6000);
    } finally {
      ctrl._assetRemoveBgInFlight = false;
      if (btn) { btn.disabled = false; btn.textContent = '✂ Remove BG'; }
    }
  }

  window.ImageEditorAssetBg = { removeBgOnAsset };
})();
