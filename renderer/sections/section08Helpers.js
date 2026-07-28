// renderer/sections/section08Helpers.js
// Helpers extracted from
// section08_Image_pipeline__Upscale___Crop___Convert_.js so that
// file stays under the 500-line lint cap. Loaded BEFORE section08
// in index.html.

// Resilient addLogEvent wrapper. The upscale section logs the start /
// success / failure of an upscale action to the structured log pane.
// If LogService.js failed to load, `window.addLogEvent` is undefined
// and the action would be invisible in the log pane. The wrapper
// falls back to:
//   (1) `window.LogService.addLogEvent` (the underlying service
//       exposes the same API on most code paths), then
//   (2) `console.log` so a developer running DevTools still sees
//       the event.
window.Section08Helpers = (function () {
  // KGO7-010: `isnetbg:run` reports a silently substituted model via
  // `fellBack` / `requestedModel` / `resolvedModel`. Those fields had ZERO
  // readers, so a stale or typo'd model key produced a normal-looking
  // success while a different model actually ran. One implementation,
  // used by all three isnetbgRun call sites; returns the envelope so it
  // can wrap the await in place.
  function warnModelFallback(r) {
    if (r && r.ok && r.fellBack && typeof toast === 'function') {
      toast(`Unknown background-removal model "${r.requestedModel}" — used "${r.resolvedModel}" instead.`, 'warn', 6000);
    }
    return r;
  }

  function makeResilientAddLog() {
    return function addLog(opts) {
      if (typeof window.addLogEvent === 'function') {
        try { window.addLogEvent(opts); return; } catch (_) { /* fall through */ }
      }
      if (window.LogService && typeof window.LogService.addLogEvent === 'function') {
        try { window.LogService.addLogEvent(opts); return; } catch (_) { /* fall through */ }
      }
      try {
        // eslint-disable-next-line no-console
        console.log('[upscale-log-fallback]', opts && opts.headline, '|', (opts && opts.details || []).join(' | '));
      } catch (_) { /* give up */ }
    };
  }
  return { makeResilientAddLog, warnModelFallback };
})();

// Resolve the selected background-removal model key for a
// remove-background run. Prefers an explicit per-call override, then
// the persisted user preference, then the default IS-Net model. Kept
// here (not inline in section08) so section08 stays under the 500-line
// lint cap.
window.Section08Helpers.resolveBgModelKey = function resolveBgModelKey(opts, stState) {
  const s = stState || window.state || {};
  // gewv2 GEW-010 fix: default to the higher-quality bundled model.
  const key = (opts && opts.model !== undefined)
    ? opts.model
    : (s.removeBackgroundModel || 'birefnet-general-lite');
  return key || 'birefnet-general-lite';
};

// Single-file resize worker, a sibling of upscaleImageFile /
// cropImageFile / convertImageFile (section08). Lives in this helper
// file because section08 is at the 500-line lint cap. Delegates to the
// Sharp-backed image:resize IPC (Lanczos3 + optional downscale
// sharpen). Returns the IPC result envelope ({ok, outputPath, width,
// height, ...}); callers read .outputPath. Matches the contract
// runImagePipelineBatch + the resize overlay expect (resolves on
// success, throws on failure).
async function resizeImageFile(srcPath, opts) {
  opts = opts || {};
  const width = Math.max(0, Math.floor(Number(opts.width) || 0));
  const height = Math.max(0, Math.floor(Number(opts.height) || 0));
  if (!width || !height) throw new Error('Resize requires a positive width and height.');
  const addLog = window.Section08Helpers.makeResilientAddLog();
  const group = 'resize-' + Date.now();
  addLog({
    category: 'upscale', groupId: group,
    headline: `Resize started: ${width}×${height} → ${(srcPath || '').split(/[\\/]/).pop() || 'image'}`,
    details: [`Source: ${srcPath}`, `Target: ${width}×${height}`],
  });
  // R1.5a.follow-up Phase 3: mint grant for srcPath before mutation.
  // R1.5a.follow-up Phase 6: directory-grant on the PARENT of
  // srcPath with both 'read' AND 'write' capabilities — the
  // source is read and the sibling output is written.
  // PRE-1: use window.GrantCache + window.api.pathDirname (no require in sandbox).
  const resizeGrant = (window.api && window.api.mintGrant)
    ? await window.GrantCache.ensurePathGrant(
        window.api.pathDirname(srcPath), 'read',
        { kind: 'directory', capabilities: ['read', 'write'] }
      ) : undefined;
  if (resizeGrant && resizeGrant.ok === false) throw new Error('resize: ' + (resizeGrant.error || 'mintGrant failed'));
  const r = await window.api.resizeImage(srcPath, {
    width, height,
    sharpenOnDownscale: opts.sharpenOnDownscale !== false,
  }, resizeGrant);
  if (window.reportIpcWarnings) window.reportIpcWarnings(r); // KGO7-020
  if (!r || !r.ok) {
    const msg = (r && r.error) || 'resize failed';
    addLog({ category: 'upscale', groupId: group, result: 'err', headline: `Resize failed: ${msg}` });
    throw new Error(msg);
  }
  addLog({
    category: 'upscale', groupId: group, result: 'ok',
    headline: `Resized to ${width}×${height} → ${(r.outputPath || '').split(/[\\/]/).pop()}`,
    details: [`Output: ${r.outputPath}`],
  });
  return r;
}

