// main/services/InstallPickCopyService.js
// "Pick file..." universal fallback for the optional-add-ons popup. The user
// already downloaded (or built) the file; this opens the file picker and copies
// it atomically into the destination under ./bin/.
//
// Security: the destination is decided by the main process
// (InstallKindsTable), not the renderer. A compromised renderer cannot target
// C:\Windows.

const fsp = require('fs').promises;
const path = require('path');
const { randomUUID } = require('crypto');

const { getSpec, getDestPath } = require('../models/InstallKindsTable');

/**
 * @typedef {(
 *   'realesrgan-binary' | 'isnetbg-binary' | 'isnetbg-model'
 * )} InstallKind
 */

/**
 * @param {string} kind
 * @param {(opts: object) => Promise<{canceled: boolean, filePaths: string[]}>} showOpenDialog
 *   Injected via DI — typically `dialog.showOpenDialog` from Electron. Tests
 *   can pass a stub.
 * @param {string} appRoot
 * @returns {Promise<{ok: boolean, destPath?: string, kind?: InstallKind, canceled?: boolean, error?: string}>}
 */
async function pickAndCopy(kind, showOpenDialog, appRoot) {
  const spec = getSpec(kind);
  if (!spec) return { ok: false, error: 'Unknown install kind: ' + String(kind) };

  // Open the file picker.
  const r = await showOpenDialog({
    title: spec.title,
    properties: ['openFile'],
    filters: spec.filters,
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const srcPath = r.filePaths[0];

  // Resolve the destination (always <appRoot>/bin[/<subdir>]/<destName>).
  const destPath = getDestPath(kind, appRoot);
  if (!destPath) return { ok: false, error: 'Failed to resolve destination for ' + kind };

  // Atomic copy (tmp + rename).
  const destDir = path.dirname(destPath);
  try {
    await fsp.mkdir(destDir, { recursive: true });
    const tmp = destPath + '.tmp-' + randomUUID();
    await fsp.copyFile(srcPath, tmp);
    try {
      await fsp.rename(tmp, destPath);
    } catch (renameErr) {
      try { await fsp.unlink(tmp); } catch {}
      throw renameErr;
    }
    return { ok: true, destPath, kind };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { pickAndCopy };
