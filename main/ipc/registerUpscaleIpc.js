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

/**
 * @param {{ getMainWindow: () => (Electron.BrowserWindow|null), appRoot: string }} deps
 */
function register({ getMainWindow, appRoot }) {
  ipcMain.handle('upscale:realesrgan:available', () => {
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
  ipcMain.handle('upscale:realesrgan:run', wrapInpaintHandler(async (event, srcPath, dstPath, opts, grantId) => {
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
    return await reEsrgan.run(srcPath, dstPath, runOpts);
  }, 'realesrgan'));

  ipcMain.handle('upscale:realesrgan:download', async (event) => {
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
