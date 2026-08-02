// main/services/ArtifactFinalizer.js
// ============================================================================
// AUD-009 fix: Unified artifact validation & finalization.
//
// All generation outputs (base64, URL download, direct body stream) converge
// on this single finalizer. Extensions and MIME types are OUTPUTS of
// validation, not inputs. Provider URL suffix, content-type, o.ext,
// requested format, or model response cannot choose the extension.
//
// Contract:
//   finalize(descriptor, { modality, stageDirectory, signal, limits })
//     -> { stagedPath, extension, mediaType, bytes, sha256, metadata }
//
// The finalizer:
//   1. creates an exclusive random stage file;
//   2. obtains bytes from strict base64 decode, SafeHttpClient.toFile, or
//      a bounded direct body stream;
//   3. detects type from bytes;
//   4. rejects a type outside the requested modality;
//   5. performs modality-specific semantic validation;
//   6. renames the stage file to a stage filename with the validated extension;
//   7. returns a descriptor to OutputTransactionService.
//
// Final filenames: image_<uuid>.png, speech_<uuid>.mp3, video_<uuid>.mp4
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CODES, AppError } = require('../errors/AppError');
const { decodeBase64Strict } = require('./strictBase64');
const { probeMedia } = require('./mediaProbe');

/** Minimum file size for a valid artifact (1 KB). */
const MIN_ARTIFACT_SIZE = 1024;

/**
 * Main-side pixel limit for Sharp operations.
 * 100 megapixels prevents decompression-bomb OOM in the main process.
 */
const SHARP_PIXEL_LIMIT = 100_000_000;

/** Default limits for each modality. */
const DEFAULT_LIMITS = Object.freeze({
  image: Object.freeze({
    maxBytes: 100 * 1024 * 1024,
    maxWidth: 16384,
    maxHeight: 16384,
    maxPixels: 100_000_000,
    maxFrames: 300,
  }),
  audio: Object.freeze({
    maxBytes: 100 * 1024 * 1024,
    maxDurationSec: 3600,
  }),
  video: Object.freeze({
    maxBytes: 512 * 1024 * 1024,
    maxWidth: 7680,
    maxHeight: 4320,
    maxDurationSec: 3600,
  }),
});

/** Modality prefix for final filenames. */
const MODALITY_PREFIX = Object.freeze({ image: 'image', audio: 'speech', video: 'video' });

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
  // M-002 (hhhhu2 audit): AAC ADTS sync word and WebM/Matroska EBML header.
  aac: Buffer.from([0xFF, 0xF1]), // ADTS sync (also 0xFF 0xF9)
  webm: Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), // EBML header (Matroska/WebM)
});

/** Types belonging to each modality. */
const MODALITY_TYPES = Object.freeze({
  image: new Set(['png', 'jpeg', 'webp', 'gif']),
  audio: new Set(['mp3', 'wav', 'flac', 'ogg', 'aac']),
  video: new Set(['mp4', 'webm']),
});

/**
 * Detect media type from file header bytes.
 * @param {Buffer} header - First 16 bytes of the file.
 * @returns {string|null} Detected type or null if unknown.
 */
function detectType(header) {
  if (!header || header.length < 4) return null;
  if (header.length >= 8 && header.slice(0, 8).equals(MAGIC_BYTES.png)) return 'png';
  if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return 'jpeg';
  if (header.length >= 12 && header.slice(0, 4).equals(MAGIC_BYTES.webp) &&
      header.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (header.slice(0, 4).equals(MAGIC_BYTES.gif)) return 'gif';
  // M-002 (hhhhu2 audit): AAC ADTS detection (sync word 0xFFF with
  // layer bits = 00 → 0xFFF1 or 0xFFF9 in first two bytes).
  if (header[0] === 0xFF && (header[1] & 0xF6) === 0xF0) return 'aac';
  if ((header[0] === 0xFF && (header[1] & 0xE0) === 0xE0) ||
      header.slice(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (header.length >= 8 && header.slice(4, 8).equals(MAGIC_BYTES.mp4)) return 'mp4';
  // M-002 (hhhhu2 audit): WebM/Matroska EBML header detection.
  if (header.length >= 4 && header.slice(0, 4).equals(MAGIC_BYTES.webm)) return 'webm';
  if (header.length >= 12 && header.slice(0, 4).equals(MAGIC_BYTES.wav) &&
      header.slice(8, 12).toString('ascii') === 'WAVE') return 'wav';
  if (header.slice(0, 4).equals(MAGIC_BYTES.ogg)) return 'ogg';
  if (header.slice(0, 4).equals(MAGIC_BYTES.flac)) return 'flac';
  return null;
}

/**
 * Check if a buffer starts with the expected magic bytes for a given type.
 * Kept for backward compatibility with existing tests.
 * @param {Buffer} header - First 16 bytes of the file.
 * @param {string} expectedType - One of: png, jpeg, webp, gif, mp3, mp4, wav, ogg, flac
 * @returns {boolean}
 */
function checkMagicBytes(header, expectedType) {
  const detected = detectType(header);
  if (!detected) return false;
  const type = (expectedType || '').toLowerCase();
  if (type === 'jpg') return detected === 'jpeg';
  if (type === 'm4a' || type === 'mov') return detected === 'mp4';
  return detected === type;
}

/** Image types that get a mandatory full decode during finalization. */
const IMAGE_DECODE_TYPES = new Set(['png', 'jpeg', 'webp', 'gif']);

/**
 * AUD-009: Unified artifact finalization.
 *
 * All output sources (base64, URL, body stream) enter through this function.
 * Type is detected from bytes; provider metadata never determines the extension.
 *
 * @param {{ data?: string, url?: string, stagedFile?: string }} descriptor
 *   - data: base64-encoded output
 *   - url: output URL to download via SafeHttpClient
 *   - stagedFile: path to an already-downloaded stage file
 * @param {{
 *   modality: 'image' | 'audio' | 'video',
 *   stageDirectory: string,
 *   signal?: AbortSignal,
 *   limits?: object,
 *   http?: object  // injected SafeHttpClient for URL downloads
 * }} opts
 * @returns {Promise<{stagedPath: string, extension: string, mediaType: string, bytes: number, sha256: string, metadata: object}>}
 */
async function finalize(descriptor, opts) {
  const { modality, stageDirectory, signal, limits: limitsOverride, http } = opts;
  if (!MODALITY_TYPES[modality]) {
    throw new AppError(CODES.INVALID_ARGUMENT, `Unknown modality: ${modality}`);
  }
  const limits = { ...DEFAULT_LIMITS[modality], ...(limitsOverride || {}) };

  // Step 1: Create exclusive random stage file
  const stageId = crypto.randomUUID();
  const rawStagePath = path.join(stageDirectory, `.stage-${stageId}.raw`);

  // Step 2: Obtain bytes
  let bytes;
  let sha256;
  if (descriptor.data) {
    // Base64 path: strict decode BEFORE allocation
    const buffer = decodeBase64Strict(descriptor.data, limits.maxBytes);
    // M-001 (hhhhu2 audit): hash BEFORE zeroing the buffer.
    bytes = buffer.length;
    sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    try {
      fs.writeFileSync(rawStagePath, buffer, { flag: 'wx', mode: 0o600 });
    } finally {
      buffer.fill(0); // best effort zeroing
    }
  } else if (descriptor.url && http) {
    // URL download path: stream to stage file via SafeHttpClient
    const result = await http.toFile(descriptor.url, rawStagePath, {
      signal,
      headers: descriptor.headers || {},
    }, { maxFileBytes: limits.maxBytes });
    bytes = result.bytes;
    sha256 = result.sha256;
  } else if (descriptor.stagedFile) {
    // Already staged (e.g. by SafeHttpClient.toFile called externally)
    const st = fs.statSync(descriptor.stagedFile);
    if (st.size > limits.maxBytes) {
      throw new AppError(CODES.RESPONSE_TOO_LARGE, 'Staged file exceeds byte limit.');
    }
    fs.copyFileSync(descriptor.stagedFile, rawStagePath);
    bytes = st.size;
    sha256 = hashFile(rawStagePath);
  } else {
    throw new AppError(CODES.INVALID_ARGUMENT, 'Descriptor must contain data, url+http, or stagedFile.');
  }

  if (bytes < MIN_ARTIFACT_SIZE) {
    cleanup(rawStagePath);
    throw new AppError(CODES.RESPONSE_INVALID, `Artifact too small (${bytes} bytes).`);
  }

  // Step 3: Detect type from bytes
  const header = readHeader(rawStagePath, 16);
  const detectedType = detectType(header);
  if (!detectedType) {
    cleanup(rawStagePath);
    throw new AppError(CODES.RESPONSE_INVALID, 'Unknown or unsupported media type detected.');
  }

  // Step 4: Reject type outside requested modality
  if (!MODALITY_TYPES[modality].has(detectedType)) {
    cleanup(rawStagePath);
    throw new AppError(CODES.RESPONSE_INVALID,
      `Detected type '${detectedType}' does not match requested modality '${modality}'.`);
  }

  // Step 5: Modality-specific semantic validation
  const metadata = {};
  if (modality === 'image') {
    const decode = await validateImageDecode(rawStagePath, {
      maxWidth: limits.maxWidth,
      maxHeight: limits.maxHeight,
      maxPixels: limits.maxPixels,
      maxFrames: limits.maxFrames,
    });
    if (!decode.ok) {
      cleanup(rawStagePath);
      throw new AppError(CODES.RESPONSE_INVALID, decode.error);
    }
    metadata.width = decode.width;
    metadata.height = decode.height;
    metadata.frames = decode.frames || 1;
  } else {
    // Audio/video: probe with ffprobe
    const probe = await probeMedia(rawStagePath, {
      modality,
      maxDurationSec: limits.maxDurationSec,
      maxWidth: limits.maxWidth,
      maxHeight: limits.maxHeight,
    }, signal);
    if (!probe.ok) {
      cleanup(rawStagePath);
      throw new AppError(CODES.RESPONSE_INVALID, probe.error);
    }
    metadata.duration = probe.duration;
    metadata.format = probe.format;
  }

  // Step 6: Rename stage file to validated extension
  const ext = detectedType === 'jpeg' ? 'jpg' : detectedType;
  const prefix = MODALITY_PREFIX[modality];
  const finalStageName = `${prefix}_${stageId}.${ext}`;
  const finalStagePath = path.join(stageDirectory, finalStageName);
  fs.renameSync(rawStagePath, finalStagePath);

  // Step 7: Return descriptor for OutputTransactionService
  return {
    stagedPath: finalStagePath,
    extension: ext,
    mediaType: detectedType,
    bytes,
    sha256,
    metadata,
  };
}

/**
 * Read the first N bytes of a file.
 * @param {string} filePath
 * @param {number} count
 * @returns {Buffer}
 */
function readHeader(filePath, count) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(count);
    fs.readSync(fd, buf, 0, count, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Compute SHA-256 of a file.
 * @param {string} filePath
 * @returns {string}
 */
function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

/**
 * Best-effort cleanup of a stage file.
 * @param {string} filePath
 */
function cleanup(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

/**
 * Full decode + dimension validation for image artifacts.
 * Uses Sharp to fully decode the image, catching corrupt/truncated files
 * that pass magic-byte checks but fail during actual decompression.
 * Enforces pixel limit to prevent decompression bombs.
 *
 * @param {string} filePath - Path to the image file.
 * @param {{ maxWidth?: number, maxHeight?: number, maxPixels?: number, maxFrames?: number }} [opts]
 * @returns {Promise<{ok: true, width: number, height: number, frames: number} | {ok: false, error: string}>}
 */
async function validateImageDecode(filePath, opts) {
  opts = opts || {};
  let sharp;
  try {
    sharp = require('sharp');
  } catch (_) {
    return { ok: false, error: 'Image decoder (sharp) is unavailable — cannot validate the artifact.' };
  }
  try {
    const maxPixels = opts.maxPixels || SHARP_PIXEL_LIMIT;
    // M-003 (hhhhu2 audit): perform a FULL pixel decode, not metadata-only.
    // .metadata() alone does not force decompression of truncated images.
    // raw().toBuffer() forces full pixel/frame decoding and will throw on
    // corrupt or truncated data. The pixel limit prevents OOM.
    const img = sharp(filePath, {
      limitInputPixels: maxPixels,
      animated: true,
    });
    const meta = await img.metadata();
    if (!meta || !meta.width || !meta.height) {
      return { ok: false, error: 'Image decode produced zero dimensions — file is likely corrupt.' };
    }
    if (opts.maxWidth && meta.width > opts.maxWidth) {
      return { ok: false, error: `Image width ${meta.width} exceeds maximum ${opts.maxWidth}.` };
    }
    if (opts.maxHeight && meta.height > opts.maxHeight) {
      return { ok: false, error: `Image height ${meta.height} exceeds maximum ${opts.maxHeight}.` };
    }
    // Reject excessive animation frames (decompression bomb vector)
    const frames = meta.pages || 1;
    if (opts.maxFrames && frames > opts.maxFrames) {
      return { ok: false, error: `Image has ${frames} frames, exceeding maximum ${opts.maxFrames}.` };
    }
    // M-003: Force full pixel decode to catch truncated/corrupt images that
    // expose valid metadata but fail during actual decompression.
    await sharp(filePath, {
      limitInputPixels: maxPixels,
      animated: true,
    }).raw().toBuffer();
    return { ok: true, width: meta.width, height: meta.height, frames };
  } catch (e) {
    return { ok: false, error: `Image full-decode failed (corrupt or unsupported): ${e.message || e}` };
  }
}

/**
 * Backward-compatible validation/finalization (pre-AUD-009 API).
 *
 * Two modes:
 *   1. Validate-only: { path, expectedType, minSize, fullDecode? }
 *      -> { ok: true } | { ok: false, error }
 *   2. Validate+rename: { tempPath, finalPath, expectedType, minSize }
 *      -> { ok: true, path } | { ok: false, error }
 *
 * Never throws — all failures are returned as { ok: false, error }.
 *
 * @param {object} opts
 * @returns {Promise<{ok: boolean, error?: string, path?: string}>}
 */
async function validateAndFinalize(opts) {
  try {
    const filePath = opts.tempPath || opts.path;
    if (!filePath) return { ok: false, error: 'No path or tempPath provided.' };

    const st = fs.statSync(filePath);
    const minSize = opts.minSize || MIN_ARTIFACT_SIZE;
    if (st.size < minSize) {
      return { ok: false, error: `File too small (${st.size} bytes, minimum ${minSize}).` };
    }

    // Magic byte check
    const header = readHeader(filePath, 16);
    const expectedType = (opts.expectedType || '').toLowerCase();
    if (!checkMagicBytes(header, expectedType)) {
      return { ok: false, error: `File does not match expected magic bytes for '${opts.expectedType}'.` };
    }

    // Full image decode for image types (unless opted out)
    const isImage = IMAGE_DECODE_TYPES.has(detectType(header));
    if (isImage && opts.fullDecode !== false) {
      const decode = await validateImageDecode(filePath, {});
      if (!decode.ok) {
        // Clean up temp file on corrupt artifact
        if (opts.tempPath) {
          try { fs.unlinkSync(opts.tempPath); } catch (_) {}
        }
        return { ok: false, error: decode.error };
      }
    }

    // Rename mode: atomically move tempPath -> finalPath (no-clobber)
    if (opts.tempPath && opts.finalPath) {
      if (fs.existsSync(opts.finalPath)) {
        return { ok: false, error: `Refusing to overwrite existing file: ${opts.finalPath}` };
      }
      // Ensure parent directory exists
      const parentDir = path.dirname(opts.finalPath);
      fs.mkdirSync(parentDir, { recursive: true });
      try {
        fs.renameSync(opts.tempPath, opts.finalPath);
      } catch (e) {
        if (e.code === 'EEXIST' || e.code === 'EPERM') {
          return { ok: false, error: `Refusing to overwrite existing file: ${opts.finalPath}` };
        }
        return { ok: false, error: `Rename failed: ${e.message}` };
      }
      return { ok: true, path: opts.finalPath };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  finalize,
  validateAndFinalize,
  validateImageDecode,
  checkMagicBytes,
  detectType,
  MAGIC_BYTES,
  MIN_ARTIFACT_SIZE,
  SHARP_PIXEL_LIMIT,
  DEFAULT_LIMITS,
  MODALITY_TYPES,
};
