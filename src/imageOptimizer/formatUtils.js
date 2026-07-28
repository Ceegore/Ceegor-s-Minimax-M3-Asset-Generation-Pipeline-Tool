// src/imageOptimizer/formatUtils.js
// Format and quality helpers for the image optimizer.
// Stateless — no sharp dependency in this module (apart from the
// require() initialisation with a fallback).

const path = require('path');

// sharp is a hard dependency (see package.json). The require is
// wrapped in try/catch so a corrupt node_modules tree doesn't crash
// the main process — each export returns a precise error instead.
let sharp = null;
try {
  sharp = require('sharp');
  const { applySharpThreadCap } = require('../cpuGuard');
  applySharpThreadCap(sharp);
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('imageOptimizer: failed to require("sharp"):', e && (e.message || e));
}

const DEFAULT_QUALITY = 82;

// sharp reports AVIF files as format 'heif' (AVIF is technically a
// brand of HEIF — the file uses the HEIF container with the AV1
// codec). Accept both 'avif' (the canonical name) and 'heif' (sharp's
// raw report) as valid input formats; detectRealFormat() normalises
// both to 'avif' for downstream consumers.
const SUPPORTED_INPUT = new Set(['jpeg', 'png', 'webp', 'avif', 'heif']);
const SUPPORTED_OUTPUT = new Set(['jpeg', 'png', 'webp', 'avif']);

// User-friendly aliases. 'jpg' is accepted because the on-disk file
// extension is "jpg", not "jpeg".
const FORMAT_ALIASES = {
  jpg: 'jpeg',
  same: null,
  auto: null,
  source: null,
  input: null,
};

function normaliseFormat(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'keep' || v === 'preserve') return null;
  const aliased = Object.prototype.hasOwnProperty.call(FORMAT_ALIASES, v) ? FORMAT_ALIASES[v] : v;
  if (aliased === null) return null;
  return SUPPORTED_OUTPUT.has(aliased) ? aliased : null;
}

function normaliseQuality(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_QUALITY;
  return Math.max(1, Math.min(100, Math.round(n)));
}

function inferFormatFromPath(p) {
  if (!p) return null;
  const ext = (path.extname(p) || '').replace(/^\./, '').toLowerCase();
  if (ext === 'jpg') return 'jpeg';
  if (SUPPORTED_INPUT.has(ext)) return ext;
  return null;
}

// The file extension is whatever the caller asked mmx to write to
// (e.g. always ".png" for the image tab — the mmx image API has no
// output-format parameter), but mmx writes the CDN's actual bytes
// verbatim, which are sometimes JPEG. sharp reads the real format
// from the file's content (magic bytes), not its extension, so this
// is the source of truth that inferFormatFromPath cannot provide.
//
// sharp reports AVIF as 'heif' (HEIF container with AV1 codec). We
// normalise that to 'avif' so the rest of the pipeline (and the
// format-detection round-trip) can use a single canonical name. The
// `compression === 'av1'` check distinguishes true AVIF from HEIC /
// HEIF (which use HEVC / H.265 — those are still rejected by
// SUPPORTED_INPUT).
async function detectRealFormat(filePath) {
  if (!sharp || !filePath) return null;
  try {
    const fs = require('fs');
    const buf = await fs.promises.readFile(filePath);
    const meta = await sharp(buf).metadata();
    if (!meta || !meta.format) return null;
    const fmt = String(meta.format).toLowerCase();
    if (fmt === 'heif' && meta.compression === 'av1') return 'avif';
    return fmt;
  } catch (e) {
    return null;
  }
}

// jpeg's canonical extension is "jpg" throughout this codebase (see
// the targetFormat->ext mapping below in optimize()).
// AVIF MUST be present: sharp reports AVIF files as the AV1-coded brand of
// HEIF, which detectRealFormat() normalises to 'avif'. Without this entry,
// fixExtensionToMatchContent() looked up EXT_FOR_FORMAT['avif'], got
// undefined, and left an AVIF-content file with a mismatched extension
// (e.g. a .png-named AVIF stayed .png), breaking the "on-disk name always
// reflects the real bytes" guarantee the mmx image path depends on.
const EXT_FOR_FORMAT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', bmp: 'bmp' };

function ensureSharp() {
  if (sharp) return null;
  return (
    'Sharp is not installed. Run `npm install` in the project root to install ' +
    'sharp + libvips (it is a runtime dependency of this project).'
  );
}

function emptyResult(error) {
  return {
    ok: false,
    outputPath: null,
    inputSize: 0,
    outputSize: 0,
    savedBytes: 0,
    savedPercent: 0,
    format: '',
    width: 0,
    height: 0,
    error: error || '',
  };
}

module.exports = {
  sharp,
  DEFAULT_QUALITY,
  SUPPORTED_INPUT,
  SUPPORTED_OUTPUT,
  EXT_FOR_FORMAT,
  normaliseFormat,
  normaliseQuality,
  inferFormatFromPath,
  detectRealFormat,
  ensureSharp,
  emptyResult,
};
