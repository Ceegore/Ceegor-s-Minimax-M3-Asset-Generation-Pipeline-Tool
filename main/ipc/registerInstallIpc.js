// main/ipc/registerInstallIpc.js
// IPC handlers: `install:openUrl` / `install:pickAndCopy`.
// Optional-addons popup: open a URL + universal pick-file fallback.

const { ipcMain, dialog, shell } = require('electron');
const reEsrgan = require('../../src/realesrgan');
const isNetBg = require('../../src/isnetbg');
const { sanitize: sanitizeUrl } = require('../utils/UrlSanitizer');
const { pickAndCopy } = require('../services/InstallPickCopyService');

/**
 * @param {{ getMainWindow: () => (Electron.BrowserWindow|null), appRoot: string }} deps
 */
function register({ getMainWindow, appRoot }) {
  ipcMain.handle('install:openUrl', async (_e, url) => {
    // Defense-in-depth: the sanitizer is the authoritative gate —
    // anything not passing it is dropped before we hand it to the OS.
    // One authoritative call suffices (sanitizeUrl is pure, and the
    // renderer is sandboxed); the OS then applies its own
    // protocol/handler validation.
    const r = sanitizeUrl(url);
    if (!r.ok) return r;
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('install:pickAndCopy', async (event, kind) => {
    try {
      const win = event.sender;
      const showOpenDialog = (opts) => dialog.showOpenDialog(win, opts);
      const r = await pickAndCopy(kind, showOpenDialog, appRoot);
      // Reset detector cache so the next probe sees the new file.
      if (r && r.ok) {
        try { reEsrgan.resetCache && reEsrgan.resetCache(); } catch (_) {}
        try { isNetBg.resetCache && isNetBg.resetCache(); } catch (_) {}
      }
      return r;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('assets:reset', async () => {
    try {
      const fs = require('fs');
      const assetPaths = require('../../src/assetPaths');
      const dir = assetPaths.writableAssetsDir();
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      // Reset caches so detectors rescan for the bundled ones
      try { reEsrgan.resetCache && reEsrgan.resetCache(); } catch (_) {}
      try { isNetBg.resetCache && isNetBg.resetCache(); } catch (_) {}
      const audioBin = require('../../src/audio/AudioBinary');
      try { audioBin.resetCache && audioBin.resetCache(); } catch (_) {}
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

module.exports = { register };
