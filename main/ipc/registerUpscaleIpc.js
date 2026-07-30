// main/ipc/registerUpscaleIpc.js
// IPC-Handler: `upscale:realesrgan:available` / `:run` / `:download`.
//
// R1.5a.3 (S1 §6 R1.5a): `upscale:realesrgan:run` requires a
// `grantId` (Main-minted). The grant is authorised through
// PathGrantService before the handler touches the filesystem.
// `upscale:realesrgan:available` and `upscale:realesrgan:download`
// stay ungated (the former is a binary check with no path; the
// latter downloads into Main-owned app dirs, not user-supplied
// paths).
//
// R3.2.4: `upscale:realesrgan:run` result passes through the
// ImageOperationResult legacy adapter (validates the 9 contract
// fields; the legacy envelope already has `outputPath` so no
// path-Mapping is needed). Backend is 'realesrgan'. The inner
// `try { ... } catch (e) { ... }` is removed; `wrapInpaintHandler`
// now provides equivalent throw-catching. The 4-arg signature
// `(event, srcPath, dstPath, opts, grantId)` is preserved via
// `...args` in the wrapper (same pattern as isnetbg:run, R3.2.3).

const { ipcMain } = require('electron');
const reEsrgan = require('../../src/realesrgan');
const { downloadRealesrgan } = require('../services/InstallDownloadService');
const { authorizePath: _authorizePath } = require('./grantAuthorizer');
const { wrapInpaintHandler } = require('./legacyAdapter');
// P4.1 (360° Audit DB-H-002/008): validate the upscale artifact before
// reporting success.
const { validateAndFinalize } = require('../services/ArtifactFinalizer');
// P1-A (360° Audit H-001): secure IPC wrapper.
const { secureHandle } = require('./secureHandle');

/**
 * @param {{ getMainWindow: () => (Electron.BrowserWindow|null), appRoot: string }} deps
 */
function register({ getMainWindow, appRoot }) {
  secureHandle('upscale:realesrgan:available', { getMainWindow }, () => {
    const available = reEsrgan.isAvailable();
    return {
      ok: true,
      available,
      binaryPath: available ? reEsrgan.getBinaryPath() : null,
      version: available ? reEsrgan.probeVersion() : '',
    };
  });

  // R3.2.4: result passes through `adaptInpaintResult` (validates
  // the 9 contract fields; the legacy envelope already has
  // `outputPath` so no path-Mapping is needed). Backend is
  // 'realesrgan'.
  secureHandle('upscale:realesrgan:run', { getMainWindow }, wrapInpaintHandler(async (event, srcPath, dstPath, opts, grantId) => {
    // R1.5a.3: read on srcPath + write on dstPath (replaces the
    // legacy isPathUnderAny + isParentUnderAny gates).
    const readAuthz = _authorizePath(grantId, 'read', srcPath);
    if (!readAuthz.ok) return { ok: false, code: -1, stderr: readAuthz.error, outputPath: null };
    const writeAuthz = _authorizePath(grantId, 'write', dstPath);
    if (!writeAuthz.ok) return { ok: false, code: -1, stderr: writeAuthz.error, outputPath: null };
    // H11-1B: forward Real-ESRGAN stdout progress to the renderer as
    // 'upscale:realesrgan:progress' events, keyed by opts.progressKey (a
    // pipeline-item id). The renderer maps the key → card determinate bar.
    const win = event && event.sender;
    const progressKey = opts && opts.progressKey;
    const runOpts = Object.assign({}, opts || {});
    if (progressKey && win && typeof win.send === 'function') {
      runOpts.onProgress = (pct) => {
        try { win.send('upscale:realesrgan:progress', { key: progressKey, pct, runGen: runOpts.runGen }); } catch (_) {}
      };
    }
    return await _validatedRun(srcPath, dstPath, runOpts);
  }, 'realesrgan'));

  // P4.1 (360° Audit DB-H-002/008): both realesrgan code paths (the binary
  // spawn and the sharp ≤8px small-image fallback) always emit PNG. Wrap the
  // handler so every success result is validated before it reaches the
  // renderer — "exit 0 + existsSync" alone does not prove a usable file (a
  // 0-byte or truncated PNG would otherwise flow through as a successful
  // upscale). minSize is 64 (not the 1 KB default) because the small-image
  // path legitimately produces sub-KB PNGs for tiny sources.
  async function _validatedRun(srcPath, dstPath, runOpts) {
    const r = await reEsrgan.run(srcPath, dstPath, runOpts);
    if (r && r.ok) {
      const outPath = r.outputPath || dstPath;
      const v = await validateAndFinalize({ path: outPath, expectedType: 'png', minSize: 64 });
      if (!v.ok) {
        return { ok: false, code: -1, stderr: `Upscale reported success but the output failed validation: ${v.error}`, outputPath: null };
      }
    }
    return r;
  }

  secureHandle('upscale:realesrgan:download', { getMainWindow }, async (event) => {
    try {
      const win = event.sender;
      const send = (data) => { try { win.send('upscale:realesrgan:download:progress', data); } catch (_) {} };
      const r = await downloadRealesrgan(appRoot, send);
      // Reset the binary detector cache so the next probe sees the
      // newly-extracted binary.
      try { reEsrgan.resetCache && reEsrgan.resetCache(); } catch (_) {}
      return r;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

module.exports = { register };
