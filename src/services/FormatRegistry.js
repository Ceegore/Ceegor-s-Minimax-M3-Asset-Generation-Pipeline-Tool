// src/services/FormatRegistry.js
// ============================================================================
// Shared Component 1A: Artifact & Format Registry.
//
// Single source of truth for codec, container, extension, MIME, magic bytes,
// decoder hint, FFmpeg muxer, and file-browser filter category for every
// format the tool produces or consumes.
//
// Covers audit findings: FUNC-008, FUNC-020, FUNC-021, FUNC-023, FUNC-028,
// FUNC-029, HIGH-026, MED-018.
//
// Usage:
//   const { getFormat, fromMagic, fromExtension, allExtsByCategory, canStreamCopy } = require('./FormatRegistry');
//   const fmt = getFormat('pcmu_wav'); // { ext:'wav', container:'wav', ... }
//   const detected = fromMagic(buffer); // detect format from bytes
// ============================================================================
'use strict';

/**
 * @typedef {Object} FormatEntry
 * @property {string} id - Unique format identifier (e.g. 'png', 'pcmu_wav').
 * @property {string} category - 'image' | 'audio' | 'video'.
 * @property {string|null} apiValue - Value sent to APIs (null if not API-facing).
 * @property {string} codec - Codec name (e.g. 'pcm_s16le', 'h264', 'png').
 * @property {string} container - Container format (e.g. 'wav', 'mp4', 'raw').
 * @property {string} ext - File extension WITHOUT dot (e.g. 'wav', 'png').
 * @property {string} mime - MIME type.
 * @property {number[][]} magicBytes - Array of byte sequences (offset 0 unless noted).
 * @property {number} [magicOffset] - Offset for magic bytes (default 0).
 * @property {string|null} ffmpegMuxer - FFmpeg muxer name (null = auto from container).
 * @property {string|null} decoderHint - 'sharp' | 'ffprobe' | 'canvas' | null.
 * @property {boolean} animated - Whether format supports animation.
 * @property {boolean} selfDescribing - Whether the format carries its own metadata (sample rate, dims, etc).
 */

/** @type {Map<string, FormatEntry>} */
const FORMATS = new Map();

function _register(entry) {
  FORMATS.set(entry.id, Object.freeze(entry));
}

// ---- IMAGE FORMATS ----

_register({
  id: 'png', category: 'image', apiValue: 'png', codec: 'png', container: 'png',
  ext: 'png', mime: 'image/png',
  magicBytes: [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  ffmpegMuxer: null, decoderHint: 'sharp', animated: false, selfDescribing: true,
});

_register({
  id: 'jpeg', category: 'image', apiValue: 'jpeg', codec: 'mjpeg', container: 'jpeg',
  ext: 'jpg', mime: 'image/jpeg',
  magicBytes: [[0xFF, 0xD8, 0xFF]],
  ffmpegMuxer: null, decoderHint: 'sharp', animated: false, selfDescribing: true,
});

_register({
  id: 'webp', category: 'image', apiValue: 'webp', codec: 'webp', container: 'webp',
  ext: 'webp', mime: 'image/webp',
  magicBytes: [[0x52, 0x49, 0x46, 0x46]], // RIFF....WEBP (check offset 8 for WEBP)
  magicOffset: 0,
  ffmpegMuxer: null, decoderHint: 'sharp', animated: true, selfDescribing: true,
});

_register({
  id: 'avif', category: 'image', apiValue: 'avif', codec: 'av1', container: 'isobmff',
  ext: 'avif', mime: 'image/avif',
  magicBytes: [], // ftyp box at offset 4 — use special detection
  ffmpegMuxer: null, decoderHint: 'sharp', animated: true, selfDescribing: true,
});

_register({
  id: 'gif', category: 'image', apiValue: 'gif', codec: 'gif', container: 'gif',
  ext: 'gif', mime: 'image/gif',
  magicBytes: [[0x47, 0x49, 0x46, 0x38]], // GIF8
  ffmpegMuxer: null, decoderHint: 'sharp', animated: true, selfDescribing: true,
});

_register({
  id: 'bmp', category: 'image', apiValue: null, codec: 'bmp', container: 'bmp',
  ext: 'bmp', mime: 'image/bmp',
  magicBytes: [[0x42, 0x4D]], // BM
  ffmpegMuxer: null, decoderHint: 'sharp', animated: false, selfDescribing: true,
});

_register({
  id: 'tiff', category: 'image', apiValue: null, codec: 'tiff', container: 'tiff',
  ext: 'tiff', mime: 'image/tiff',
  magicBytes: [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]], // II* or MM*
  ffmpegMuxer: null, decoderHint: 'sharp', animated: false, selfDescribing: true,
});

// ---- AUDIO FORMATS ----

_register({
  id: 'mp3', category: 'audio', apiValue: 'mp3', codec: 'mp3', container: 'mp3',
  ext: 'mp3', mime: 'audio/mpeg',
  magicBytes: [[0x49, 0x44, 0x33], [0xFF, 0xFB], [0xFF, 0xF3], [0xFF, 0xF2]], // ID3 or frame sync
  ffmpegMuxer: 'mp3', decoderHint: 'ffprobe', animated: false, selfDescribing: true,
});

_register({
  id: 'wav', category: 'audio', apiValue: 'wav', codec: 'pcm_s16le', container: 'wav',
  ext: 'wav', mime: 'audio/wav',
  magicBytes: [[0x52, 0x49, 0x46, 0x46]], // RIFF....WAVE
  ffmpegMuxer: 'wav', decoderHint: 'ffprobe', animated: false, selfDescribing: true,
});

_register({
  id: 'flac', category: 'audio', apiValue: 'flac', codec: 'flac', container: 'flac',
  ext: 'flac', mime: 'audio/flac',
  magicBytes: [[0x66, 0x4C, 0x61, 0x43]], // fLaC
  ffmpegMuxer: 'flac', decoderHint: 'ffprobe', animated: false, selfDescribing: true,
});

_register({
  id: 'opus', category: 'audio', apiValue: 'opus', codec: 'opus', container: 'ogg',
  ext: 'opus', mime: 'audio/opus',
  magicBytes: [[0x4F, 0x67, 0x67, 0x53]], // OggS
  ffmpegMuxer: 'ogg', decoderHint: 'ffprobe', animated: false, selfDescribing: true,
});

_register({
  id: 'aac', category: 'audio', apiValue: null, codec: 'aac', container: 'adts',
  ext: 'aac', mime: 'audio/aac',
  magicBytes: [[0xFF, 0xF1], [0xFF, 0xF9]],
  ffmpegMuxer: 'adts', decoderHint: 'ffprobe', animated: false, selfDescribing: true,
});

_register({
  id: 'm4a', category: 'audio', apiValue: null, codec: 'aac', container: 'mp4',
  ext: 'm4a', mime: 'audio/mp4',
  magicBytes: [], // ftyp box — use special detection
  ffmpegMuxer: 'ipod', decoderHint: 'ffprobe', animated: false, selfDescribing: true,
});

_register({
  id: 'pcm', category: 'audio', apiValue: 'pcm', codec: 'pcm_s16le', container: 'raw',
  ext: 'pcm', mime: 'audio/L16',
  magicBytes: [], // raw PCM has no magic
  ffmpegMuxer: 's16le', decoderHint: 'ffprobe', animated: false, selfDescribing: false,
});

// FUNC-008 fix: pcmu_raw and pcmu_wav are DISTINCT formats.
_register({
  id: 'pcmu_raw', category: 'audio', apiValue: 'pcmu_raw', codec: 'pcm_mulaw', container: 'raw',
  ext: 'ulaw', mime: 'audio/basic',
  magicBytes: [], // raw mulaw has no magic
  ffmpegMuxer: 'mulaw', decoderHint: 'ffprobe', animated: false, selfDescribing: false,
});

_register({
  id: 'pcmu_wav', category: 'audio', apiValue: 'pcmu_wav', codec: 'pcm_mulaw', container: 'wav',
  ext: 'wav', mime: 'audio/wav',
  magicBytes: [[0x52, 0x49, 0x46, 0x46]], // RIFF....WAVE
  ffmpegMuxer: 'wav', decoderHint: 'ffprobe', animated: false, selfDescribing: true,
});

// ---- VIDEO FORMATS ----

_register({
  id: 'mp4', category: 'video', apiValue: 'mp4', codec: 'h264', container: 'mp4',
  ext: 'mp4', mime: 'video/mp4',
  magicBytes: [], // ftyp box at offset 4
  ffmpegMuxer: 'mp4', decoderHint: 'ffprobe', animated: true, selfDescribing: true,
});

_register({
  id: 'webm', category: 'video', apiValue: null, codec: 'vp9', container: 'matroska',
  ext: 'webm', mime: 'video/webm',
  magicBytes: [[0x1A, 0x45, 0xDF, 0xA3]], // EBML header
  ffmpegMuxer: 'webm', decoderHint: 'ffprobe', animated: true, selfDescribing: true,
});

// ---- LOOKUP HELPERS ----

// M-059: an ISO-BMFF file whose ftyp brands don't definitively identify the
// content. The major brand alone (isom/mp42/…) does NOT determine the
// category — an AAC-audio M4A written by many encoders carries 'isom', and
// classifying it as video/mp4 mis-routes it. Callers must use ffprobe (see
// decoderHint) to determine the actual streams/codec. Deliberately NOT
// registered in FORMATS: it is a detection result, not a producible format.
const ISOBMFF_AMBIGUOUS = Object.freeze({
  id: 'isobmff', category: 'ambiguous', apiValue: null, codec: null, container: 'isobmff',
  ext: 'mp4', mime: 'application/octet-stream',
  magicBytes: [], ffmpegMuxer: null, decoderHint: 'ffprobe', animated: false, selfDescribing: true,
});

/**
 * Get a format entry by its ID.
 * @param {string} id
 * @returns {FormatEntry|null}
 */
function getFormat(id) {
  return FORMATS.get(id) || null;
}

/**
 * Detect format from magic bytes in a buffer.
 * @param {Buffer|Uint8Array} buf - At least the first 16 bytes of the file.
 * @returns {FormatEntry|null}
 */
function fromMagic(buf) {
  if (!buf || buf.length < 4) return null;

  // Special: ISO Base Media File Format (ftyp box) — AVIF, MP4, M4A
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    if (brand === 'avif' || brand === 'avis') return FORMATS.get('avif');
    if (brand === 'M4A ' || brand === 'M4B ') return FORMATS.get('m4a');
    // M-059: the major brand is not definitive — scan the ftyp compatible
    // brands (offset 16 onwards, 4 bytes each, within the box size at bytes
    // 0-3) when the caller supplied more than the first 16 bytes.
    const boxSize = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
    const scanEnd = Math.min(buf.length, boxSize >= 16 ? boxSize : buf.length);
    for (let off = 16; off + 4 <= scanEnd; off += 4) {
      const b = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
      if (b === 'avif' || b === 'avis') return FORMATS.get('avif');
      if (b === 'M4A ' || b === 'M4B ') return FORMATS.get('m4a');
    }
    // M-059: isom/mp4x/dash/MSNV and every other brand say "ISO-BMFF
    // container" but NOT what's inside (an isom-brand M4A is audio, not
    // video). Return the ambiguous entry instead of defaulting to mp4;
    // ffprobe must decide the real category.
    return ISOBMFF_AMBIGUOUS;
  }

  // Special: WEBP needs RIFF + offset-8 check
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    const sub = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    if (sub === 'WEBP') return FORMATS.get('webp');
    if (sub === 'WAVE') return FORMATS.get('wav');
  }

  // General magic-byte scan
  for (const entry of FORMATS.values()) {
    if (!entry.magicBytes || !entry.magicBytes.length) continue;
    const offset = entry.magicOffset || 0;
    for (const magic of entry.magicBytes) {
      if (buf.length < offset + magic.length) continue;
      let match = true;
      for (let i = 0; i < magic.length; i++) {
        if (buf[offset + i] !== magic[i]) { match = false; break; }
      }
      if (match) return entry;
    }
  }
  return null;
}

/**
 * Look up a format by file extension (without dot).
 * @param {string} ext - e.g. 'png', 'wav', 'ulaw'
 * @returns {FormatEntry|null}
 */
function fromExtension(ext) {
  if (!ext) return null;
  const lower = String(ext).toLowerCase().replace(/^\./, '');
  // Direct ID match first
  if (FORMATS.has(lower)) return FORMATS.get(lower);
  // Search by ext field
  for (const entry of FORMATS.values()) {
    if (entry.ext === lower) return entry;
  }
  // Aliases
  const aliases = { jpg: 'jpeg', jpeg: 'jpeg', tif: 'tiff', ulaw: 'pcmu_raw', mulaw: 'pcmu_raw' };
  if (aliases[lower]) return FORMATS.get(aliases[lower]) || null;
  return null;
}

/**
 * Get all extensions grouped by category.
 * @returns {{ image: string[], audio: string[], video: string[] }}
 */
function allExtsByCategory() {
  const result = { image: [], audio: [], video: [] };
  const seen = { image: new Set(), audio: new Set(), video: new Set() };
  for (const entry of FORMATS.values()) {
    if (!seen[entry.category].has(entry.ext)) {
      seen[entry.category].add(entry.ext);
      result[entry.category].push(entry.ext);
    }
  }
  return result;
}

/**
 * Determine if stream-copy (no re-encode) is safe given source codec and
 * destination container. Used by Audio Cutter (FUNC-009, FUNC-010).
 *
 * @param {string} srcCodec - e.g. 'mp3', 'pcm_s16le', 'flac'
 * @param {string} dstContainer - e.g. 'wav', 'mp3', 'mp4'
 * @returns {boolean}
 */
function canStreamCopy(srcCodec, dstContainer) {
  if (!srcCodec || !dstContainer) return false;
  // Codec must be natively supported by the destination container.
  const COMPAT = {
    wav: new Set(['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_mulaw', 'pcm_alaw', 'adpcm_ms']),
    mp3: new Set(['mp3']),
    flac: new Set(['flac']),
    ogg: new Set(['opus', 'vorbis']),
    mp4: new Set(['aac', 'h264', 'h265', 'vp9', 'av1', 'opus']),
    adts: new Set(['aac']),
    raw: new Set(['pcm_s16le', 'pcm_mulaw', 'pcm_alaw']),
    s16le: new Set(['pcm_s16le']),
    mulaw: new Set(['pcm_mulaw']),
  };
  const allowed = COMPAT[dstContainer];
  if (!allowed) return false;
  return allowed.has(srcCodec);
}

/**
 * Get all format entries (for building file-browser filters, etc).
 * @returns {FormatEntry[]}
 */
function allFormats() {
  return Array.from(FORMATS.values());
}

module.exports = {
  getFormat,
  fromMagic,
  fromExtension,
  allExtsByCategory,
  canStreamCopy,
  allFormats,
  FORMATS,
  ISOBMFF_AMBIGUOUS,
};
