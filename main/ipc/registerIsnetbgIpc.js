// main/ipc/registerIsnetbgIpc.js
// IPC-Handler: `isnetbg:available` / `isnetbg:run` / `isnetbg:download-model`.
//
// R1.5a.4 (S1 §6 R1.5a): `isnetbg:run` requires a `grantId`
// (Main-minted). The grant is authorised through PathGrantService
// before the handler touches the filesystem. `isnetbg:available`
// and `isnetbg:download-model` stay ungated (no user-supplied path;
// the model download targets a Main-owned app dir).
//
// R3.2.3: `isnetbg:run` result passes through the ImageOperationResult
// legacy adapter (validates the 9 contract fields; the legacy
// envelope already has `outputPath` so no path-Mapping is needed).
// Backend is 'isnet'. The inner `try { ... } catch (e) { ... }` is
// removed; `wrapInpaintHandler` now provides equivalent
// throw-catching. Note: `isnetbg:run` has a 4-arg signature
// `(srcPath, dstPath, opts, grantId)` (not the single-`args`-object
// form used by inpaint:runOnnx); `wrapInpaintHandler` preserves
// arity via `...args` so both signatures are supported by the same
// adapter.

const { ipcMain } = require('electron');
const isNetBg = require('../../src/isnetbg');
const { resolveModelKeyEx } = require('../../src/isnetbg/modelRegistry');
const modelDownload = require('../../src/isnetbg/modelDownload');
const { authorizePath: _authorizePath } = require('./grantAuthorizer');
const { wrapInpaintHandler } = require('./legacyAdapter');

/**
 * @param {{ appRoot: string }} deps
 */
function register(_deps) {
  // KGO7-017: reclaim orphaned model-download temps at startup. A hard
  // kill mid-download leaves a `<model>.onnx.tmp-<pid>-<uuid>` file that
  // nothing ever removes — one measured leak was 161 MB, and no gate
  // noticed it. Best-effort and non-blocking: a failure here must never
  // stop the app from registering its IPC.
  try {
    const assetPaths = require('../../src/assetPaths');
    const modelsDir = require('path').dirname(assetPaths.resolveAsset('models', 'x.onnx'));
    const swept = modelDownload.sweepStaleTemps(modelsDir);
    if (swept.removed.length) {
      console.log(`[isnetbg] removed ${swept.removed.length} stale model temp file(s)`);
    }
  } catch (_) { /* best-effort */ }

  ipcMain.handle('isnetbg:available', () => {
    const available = isNetBg.isAvailable();
    const binaryPath = available ? isNetBg.getBinaryPath() : null;
    const modelPath = isNetBg.getModelPath();
    const version = available ? isNetBg.probeVersion() : '';
    return {
      ok: true,
      available,
      binaryPath,
      modelPath,
      // Distinct from `available`: the binary can be present while the
      // model file is missing. The UI uses this to show a precise
      // "binary installed, but model missing" hint instead of failing
      // silently at run time.
      modelPresent: !!modelPath,
      version,
      models: isNetBg.listModelStatus(),
    };
  });

  // R3.2.3: result passes through `adaptInpaintResult` (validates
  // the 9 contract fields; the legacy envelope already has
  // `outputPath` so no path-Mapping is needed). Backend is 'isnet'.
  ipcMain.handle('isnetbg:run', wrapInpaintHandler(async (_e, srcPath, dstPath, opts, grantId) => {
    // R1.5a.4: read on srcPath + write on dstPath (replaces the
    // legacy isPathUnderAny + isParentUnderAny gates).
    const readAuthz = _authorizePath(grantId, 'read', srcPath);
    if (!readAuthz.ok) return { ok: false, code: -1, stderr: readAuthz.error, outputPath: null };
    const writeAuthz = _authorizePath(grantId, 'write', dstPath);
    if (!writeAuthz.ok) return { ok: false, code: -1, stderr: writeAuthz.error, outputPath: null };
    const sanitizedOpts = opts || {};
    // KGO7-019: resolveModelKeyEx replaces resolveModelKey + a stderr
    // write that never reached the user in a packaged GUI app.
    const resolution = resolveModelKeyEx(sanitizedOpts.model);
    sanitizedOpts.model = resolution.key;
    const result = await isNetBg.run(srcPath, dstPath, sanitizedOpts);
    // KGO6-016 / KGO7-010: report the resolved model so the renderer can
    // toast when a bogus key was silently replaced by the default. The
    // renderer consumers live in section08_Image_pipeline…js,
    // imageEditorActions.js and imageEditorAssetBg.js.
    if (result && result.ok && resolution.fellBack) {
      result.fellBack = true;
      result.requestedModel = resolution.requested;
      result.resolvedModel = resolution.key;
    }
    return result;
  }, 'isnet'));

  ipcMain.handle('isnetbg:download-model', async (e, modelKey) => {
    try {
      const r = await modelDownload.downloadModel(modelKey, (p) => {
        try { e.sender.send('isnetbg:download-progress', { model: modelKey, ...p }); } catch (_) {}
      });
      return r; // { ok: true, path } | { ok: false, error }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

module.exports = { register };
