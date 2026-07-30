// main/ipc/registerFilePickerIpc.js
// IPC-Handler: `file:pick` (Open-File) und `file:saveAs` (Save-As).
// R1.2: Beide Handler minten einen PathGrant (S1 §4) statt
// `pathSecurity.addTrusted` zu rufen. Der Pick-Grant ist read-only
// (exakte Datei), der Save-As-Grant ist single-use write (exakte
// Datei) und wird bei der Copy-Operation konsumiert.
//
// Rückgabe-Form (additive, rückwärtskompatibel):
//   file:pick:   { ok: true, path, grantId, capabilities: ['read'] }
//   file:saveAs: { ok: true, path, grantId, capabilities: ['write'] }
//
// Der `path` bleibt für reine Anzeige- und Lese-Caller erhalten; er
// ist KEIN impliziter Write-Grant. Mutationen benötigen den grantId.

const { ipcMain, dialog } = require('electron');
const pathSecurity = require('../services/PathSecurityService');
const { defaultService: pathGrantService } = require('../services/PathGrantService');
const { wrapFilePickerHandler } = require('./legacyAdapter');
// P1-A (360° Audit H-001): secure IPC wrapper.
const { secureHandle } = require('./secureHandle');

const TITLE_MAX = 200;
const FILTER_NAME_MAX = 100;
const FILTER_EXT_MAX = 20;
const FILTERS_MAX = 20;

/**
 * @param {{ getMainWindow: () => (Electron.BrowserWindow|null) }} deps
 */
function register({ getMainWindow }) {
  // ---------------------------------------------------------------------
  // file:pick — native Open-File dialog, mint a `picker-read-file`
  // grant for the chosen file. No `addTrusted` — the picked path is
  // NOT a write-privilege escalation.
  // R3.2: result passes through the FilePickerResult legacy adapter
  // (validates the 4 contract fields, preserves grantId/capabilities).
  // ---------------------------------------------------------------------
  secureHandle('file:pick', { getMainWindow }, wrapFilePickerHandler(async (_e, opts) => {
    opts = opts || {};
      const title = typeof opts.title === 'string' ? opts.title.slice(0, TITLE_MAX) : 'Select file';
      const filters = Array.isArray(opts.filters) && opts.filters.length
        ? opts.filters
            .filter((f) => f && typeof f === 'object' && typeof f.name === 'string' && Array.isArray(f.extensions))
            .slice(0, FILTERS_MAX)
            .map((f) => ({
              name: String(f.name).slice(0, FILTER_NAME_MAX),
              extensions: f.extensions.map((e) => String(e).slice(0, FILTER_EXT_MAX)),
            }))
        : [{ name: 'All files', extensions: ['*'] }];
      const r = await dialog.showOpenDialog(getMainWindow(), {
        title,
        properties: ['openFile'],
        filters,
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      const pickedPath = r.filePaths[0];

      // R1.2: mint a read-only file grant for the exact path. The
      // grant is consumed by the read consumer (or expires). The
      // path is no longer added to a global trust set.
      const mint = pathGrantService.mintFileGrant({
        origin: 'picker-read-file',
        purpose: 'user picked file for read',
        path: pickedPath,
        capabilities: ['read'],
      });
      if (!mint.ok) return { ok: false, error: mint.error };

      return {
        ok: true,
        path: pickedPath,
        grantId: mint.grantId,
        capabilities: mint.grant.capabilities,
      };
  }));
  // The `try { ... } catch (e) { ... }` wrapper is now provided by
  // wrapFilePickerHandler — IPC-handler-thrown errors are converted to
  // a clean `{ ok: false, error: ... }` envelope.

  // ---------------------------------------------------------------------
  // file:saveAs — native Save-As dialog, mint a `save-as-target`
  // singleUse write grant for the chosen destination, authorize the
  // copy, then return the (consumed) grantId. The grant is
  // intentionally single-use so the renderer cannot reuse the
  // picker result to write a different file.
  // R3.2.AuditFix: result passes through the FilePickerResult legacy
  // adapter (validates the 4 contract fields, preserves grantId/
  // capabilities, catches throws).
  // ---------------------------------------------------------------------
  secureHandle('file:saveAs', { getMainWindow }, wrapFilePickerHandler(async (_e, srcPath) => {
    if (!srcPath || typeof srcPath !== 'string') {
      return { ok: false, error: 'srcPath is required.' };
    }
    if (!pathSecurity.isPathUnderAny(srcPath)) {
      return { ok: false, error: 'Source path is outside the allowed directories.' };
    }
    const fs = require('fs');
    if (!fs.existsSync(srcPath)) {
      return { ok: false, error: 'Source file does not exist.' };
    }
    const path = require('path');
    const ext = path.extname(srcPath).replace(/^\./, '');
    const r = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Save Image As',
      defaultPath: path.basename(srcPath),
      filters: [
        { name: `${ext.toUpperCase()} Files`, extensions: [ext] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const destPath = r.filePath;

    // R1.2: mint a singleUse write grant for the exact destination
    // path. The grant is consumed on the copy below. The renderer
    // can read the grantId to learn what was authorized, but cannot
    // reuse the grant to write a different file (singleUse).
    const mint = pathGrantService.mintFileGrant({
      origin: 'save-as-target',
      purpose: 'user save-as',
      path: destPath,
      capabilities: ['write'],
      singleUse: true,
    });
    if (!mint.ok) return { ok: false, error: mint.error };

    // Authorize the write against the freshly-minted grant BEFORE
    // touching the filesystem. This is the single moment in this
    // handler that is allowed to perform the actual file IO.
    const authz = pathGrantService.authorize(mint.grantId, {
      operation: 'write',
      path: destPath,
    });
    if (!authz.ok) return { ok: false, error: authz.error };

    // MED-048: atomic Save-As — copy to a temp sibling first, then rename.
    // A crash mid-copy no longer leaves a corrupt destination file.
    const tmpDest = destPath + '.tmp-' + Date.now();
    await fs.promises.copyFile(srcPath, tmpDest);
    try {
      await fs.promises.rename(tmpDest, destPath);
    } catch (renameErr) {
      try { await fs.promises.unlink(tmpDest); } catch (_) {}
      throw renameErr;
    }

    return {
      ok: true,
      path: destPath,
      grantId: mint.grantId,
      capabilities: ['write'],
    };
  }));
}

module.exports = { register };
