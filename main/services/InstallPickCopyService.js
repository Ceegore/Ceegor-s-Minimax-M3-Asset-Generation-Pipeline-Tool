// main/services/InstallPickCopyService.js
// "Pick file..." universal fallback for the optional-add-ons popup. The user
// already downloaded (or built) the file; this opens the file picker and copies
// it atomically into the destination under ./bin/.
//
// Security: the destination is decided by the main process
// (InstallKindsTable), not the renderer. A compromised renderer cannot target
// C:\Windows.

const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { getSpec, getDestPath } = require('../models/InstallKindsTable');

/**
 * @typedef {(
 *   'realesrgan-binary' | 'isnetbg-binary' | 'isnetbg-model'
 * )} InstallKind
 */

// SEC-013: validate picked file type BEFORE copying into bin/.
// PE executables must start with 'MZ'; ONNX models are protobuf
// (first byte is a varint field tag, typically 0x08). Reject anything
// else to prevent a social-engineering attack where the user is
// tricked into installing a script or DLL.
const MAX_VALIDATION_READ = 512;
function validatePickedFile(srcPath, kind) {
  let header;
  try {
    const fd = fs.openSync(srcPath, 'r');
    header = Buffer.alloc(MAX_VALIDATION_READ);
    const bytesRead = fs.readSync(fd, header, 0, MAX_VALIDATION_READ, 0);
    fs.closeSync(fd);
    header = header.slice(0, bytesRead);
  } catch (e) {
    return { ok: false, error: 'Cannot read file header: ' + String(e.message || e) };
  }
  if (header.length < 2) return { ok: false, error: 'File is too small to be valid.' };
  if (kind === 'realesrgan-binary' || kind === 'isnetbg-binary') {
    // PE executable: must start with MZ (0x4D 0x5A)
    if (header[0] !== 0x4D || header[1] !== 0x5A) {
      return { ok: false, error: 'File does not appear to be a Windows executable (missing MZ header).' };
    }
  } else if (kind === 'isnetbg-model') {
    // ONNX protobuf: first byte should be a field tag (0x08 for field 1, varint).
    // Also accept 0x0A (field 1, length-delimited) for newer IR versions.
    if (header[0] !== 0x08 && header[0] !== 0x0A) {
      return { ok: false, error: 'File does not appear to be an ONNX model (unexpected header byte 0x' + header[0].toString(16) + ').' };
    }
  }
  return { ok: true };
}

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

  // SEC-013: validate file type before installing.
  const validation = validatePickedFile(srcPath, kind);
  if (!validation.ok) return validation;

  // Resolve the destination (H-065: always the writable override dir,
  // <userData>/assets[/<subdir>]/<destName> — never the bundled bin/).
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
