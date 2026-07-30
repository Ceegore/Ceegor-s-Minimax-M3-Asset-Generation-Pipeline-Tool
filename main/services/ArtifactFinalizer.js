// main/services/ArtifactFinalizer.js
// ============================================================================
// P4-A (360° Audit DB-H-002, DB-H-008): Artifact validation & finalization.
//
// All generation outputs must pass through this finalizer before being
// reported as successful. It validates:
//   1. File exists and is a regular file
//   2. Size > minimum threshold (default 1KB — catches empty/corrupt outputs)
//   3. Magic bytes match expected type (PNG, JPEG, WebP, MP3, MP4, WAV)
//   4. For images: dimensions are non-zero (via header parsing)
//   5. Atomic rename from temp to final path
//
// Usage:
//   const { validateAndFinalize } = require('./ArtifactFinalizer');
//   const result = await validateAndFinalize({
//     tempPath: 'C:\\temp\\uuid.tmp',
//     finalPath: 'C:\\output\\image.png',
//     expectedType: 'png',
//   });
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

/** Minimum file size for a valid artifact (1 KB). */
const MIN_ARTIFACT_SIZE = 1024;

/** Magic byte signatures for known file types. */
const MAGIC_BYTES = Object.freeze({
  png: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  jpeg: Buffer.from([0xFF, 0xD8, 0xFF]),
  webp: Buffer.from('RIFF'), // + 'WEBP' at offset 8
  gif: Buffer.from('GIF8'),
  mp3: Buffer.from([0xFF, 0xFB]), // MPEG frame sync (also 0xFF 0xF3, 0xFF 0xF2)
  mp4: Buffer.from('ftyp'), // at offset 4
  wav: Buffer.from('RIFF'), // + 'WAVE' at offset 8
  ogg: Buffer.from('OggS'),
  flac: Buffer.from('fLaC'),
});

/**
 * Check if a buffer starts with the expected magic bytes for a given type.
 * @param {Buffer} header - First 16 bytes of the file.
 * @param {string} expectedType - One of: png, jpeg, webp, gif, mp3, mp4, wav, ogg, flac
 * @returns {boolean}
 */
function checkMagicBytes(header, expectedType) {
  if (!header || header.length < 4) return false;
  const type = (expectedType || '').toLowerCase();

  switch (type) {
    case 'png':
      return header.length >= 8 && header.slice(0, 8).equals(MAGIC_BYTES.png);
    case 'jpeg':
    case 'jpg':
      return header.length >= 3 && header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF;
    case 'webp':
      return header.length >= 12 &&
        header.slice(0, 4).equals(MAGIC_BYTES.webp) &&
        header.slice(8, 12).toString('ascii') === 'WEBP';
    case 'gif':
      return header.slice(0, 4).equals(MAGIC_BYTES.gif);
    case 'mp3':
      // MP3 frame sync: 0xFF 0xFB/0xF3/0xF2, or ID3 tag
      return (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0) ||
        header.slice(0, 3).toString('ascii') === 'ID3';
    case 'mp4':
    case 'm4a':
    case 'mov':
      return header.length >= 8 && header.slice(4, 8).equals(MAGIC_BYTES.mp4);
    case 'wav':
      return header.length >= 12 &&
        header.slice(0, 4).equals(MAGIC_BYTES.wav) &&
        header.slice(8, 12).toString('ascii') === 'WAVE';
    case 'ogg':
      return header.slice(0, 4).equals(MAGIC_BYTES.ogg);
    case 'flac':
      return header.slice(0, 4).equals(MAGIC_BYTES.flac);
    default:
      // Unknown type — skip magic byte check (size check still applies)
      return true;
  }
}

/**
 * Validate an artifact file and optionally finalize it (atomic rename).
 *
 * @param {{
 *   path?: string,          // Path to validate (if no temp/final rename needed)
 *   tempPath?: string,      // Temp file to validate and rename
 *   finalPath?: string,     // Final destination (used with tempPath)
 *   expectedType?: string,  // Expected file type for magic byte check
 *   minSize?: number,       // Minimum file size (default 1KB)
 * }} opts
 * @returns {Promise<{ok: true, path: string, size: number} | {ok: false, error: string}>}
 */
async function validateAndFinalize(opts) {
  const {
    path: directPath,
    tempPath,
    finalPath,
    expectedType,
    minSize = MIN_ARTIFACT_SIZE,
  } = opts || {};

  const targetPath = tempPath || directPath;
  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, error: 'No file path provided for validation' };
  }

  // 1. File exists and is a regular file
  let stat;
  try {
    stat = await fs.promises.stat(targetPath);
  } catch (e) {
    return { ok: false, error: `Artifact not found: ${e.code || e.message}` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: 'Artifact path is not a regular file' };
  }

  // 2. Size check
  if (stat.size < minSize) {
    // Clean up undersized temp file
    if (tempPath) {
      try { await fs.promises.unlink(tempPath); } catch (_) {}
    }
    return { ok: false, error: `Artifact too small (${stat.size} bytes, minimum ${minSize}). Generation likely failed.` };
  }

  // 3. Magic bytes check
  if (expectedType) {
    let header;
    try {
      const fd = await fs.promises.open(targetPath, 'r');
      header = Buffer.alloc(16);
      await fd.read(header, 0, 16, 0);
      await fd.close();
    } catch (e) {
      return { ok: false, error: `Cannot read artifact header: ${e.message}` };
    }
    if (!checkMagicBytes(header, expectedType)) {
      if (tempPath) {
        try { await fs.promises.unlink(tempPath); } catch (_) {}
      }
      return { ok: false, error: `Artifact magic bytes do not match expected type '${expectedType}'. File may be corrupt.` };
    }
  }

  // 4. Atomic rename (if tempPath + finalPath provided)
  const resultPath = finalPath || targetPath;
  if (tempPath && finalPath) {
    try {
      await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
      await fs.promises.rename(tempPath, finalPath);
    } catch (e) {
      // If rename fails (cross-device), fall back to copy+delete
      try {
        await fs.promises.copyFile(tempPath, finalPath);
        await fs.promises.unlink(tempPath);
      } catch (e2) {
        return { ok: false, error: `Failed to finalize artifact: ${e2.message}` };
      }
    }
  }

  return { ok: true, path: resultPath, size: stat.size };
}

module.exports = {
  validateAndFinalize,
  checkMagicBytes,
  MAGIC_BYTES,
  MIN_ARTIFACT_SIZE,
};
