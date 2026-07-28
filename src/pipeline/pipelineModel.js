// src/pipeline/pipelineModel.js
// Pure helpers for the column-based image workflow.
//
// Everything in this file is PURE (no fs, no Electron, no network): it builds
// workspace paths, sanitises the board state, and defines the column model. The
// main process (IPC handlers) and the renderer both reach for these so the
// on-disk layout + the in-memory model can never drift.
//
// Workspace layout (all under <effectiveOutputDir>/pipeline/image/):
//   original/   img_<id>_<name>.<ext>
//   upscale/    img_<id>_<name>_<M>x.<ext>
//   removebg/   img_<id>_<name>_nobg.png
//   crop/       img_<id>_<name>_cropped.<ext>
//   optimize/   img_<id>_<name>_opt.<ext>
//   final/      img_<id>_<name>.<ext>
//   .thumbs/    <sha1(path)>_<w>.webp   (expendable thumbnail cache)
//   .trash/<id>/  session-scoped soft-delete bin
//   manifest.json  exportable board manifest + disaster-recovery aid
//
// The img_<id>_ prefix guarantees uniqueness + makes the board reconstructable
// from disk alone (see recoverBoard in pipelineModel / the renderer).

const path = require('path');

// Fixed column set + order (intentionally not reorderable). 'import' is
// intake-only (no images live there) and is intentionally NOT in
// STORAGE_COLUMNS. 'original' is the intake queue; 'final' is the output bin.
// 'resize' sits between 'crop' and 'optimize' — a free target resolution step
// (Lanczos3). It's distinct from 'crop' (which cuts a region) and from
// 'upscale' (which multiplies by a fixed factor).
const COLUMN_ORDER = ['original', 'upscale', 'removebg', 'crop', 'resize', 'optimize', 'final'];
const ACTIVE_COLUMNS = ['upscale', 'removebg', 'crop', 'resize', 'optimize']; // columns that run an op
const STORAGE_COLUMNS = ['original', 'upscale', 'removebg', 'crop', 'resize', 'optimize', 'final'];
const STAGE_SUFFIX = {
  original: '',
  upscale: '_{mult}x',
  removebg: '_nobg',
  crop: '_cropped',
  resize: '_resized',
  optimize: '_opt',
  final: '',
};

// Per-column default settings inherited by newly-imported images. The renderer
// deep-merges per-item overrides on top of these. Model keys are whitelisted at
// the sanitiser boundary (sanitisePipelineBoard) so a corrupted state.json can
// never inject an arbitrary spawn arg.
const COLUMN_DEFAULTS = {
  upscale: { multiplier: 2, model: 'realesrgan-x4plus', useCanvasFallback: false },
  // gewv2 GEW-010 fix: default to the higher-quality bundled model
  // (cleaner edges) instead of the fast/lower-quality one.
  removebg: { model: 'birefnet-general-lite', useGpu: true, skipIfTransparent: true },
  crop: { mode: 'anchor', w: 0, h: 0, anchorX: 'center', anchorY: 'center', x: 0, y: 0 },
  // resize defaults. width/height 0 means "no resize target set" — the op
  // then no-ops (copies the source through) like crop with W=H=0. keepAspect
  // mirrors the GIMP/Photoshop chain-link (default ON); sharpen is applied by
  // the engine only on downscale regardless of this flag.
  resize: { width: 0, height: 0, keepAspect: true, sharpen: true },
  optimize: { format: 'keep', quality: 82, stripMetadata: true },
};

// Whitelists (reused, not duplicated). These mirror the existing whitelists in
// src/state.js (realesrganModel), section08 (REAL_ESRGAN_MODELS) and
// src/isnetbg/modelRegistry.js (isKnownModel). Keep them in lock-step.
// These are the models actually included by the supported ncnn-vulkan bundle.
// `realesr-general-x4v3` is a PyTorch model; the ncnn release does not ship
// compatible .param/.bin files for it, so exposing it only creates a broken
// selection in every upscale surface.
const REALESRGAN_MODELS = ['realesrgan-x4plus', 'realesrgan-x4plus-anime', 'realesr-animevideov3'];
const REALESRGAN_MODEL_DETAILS = [
  { value: 'realesrgan-x4plus', label: 'Real-ESRGAN x4plus (general-purpose)' },
  { value: 'realesrgan-x4plus-anime', label: 'Real-ESRGAN x4plus anime (illustration)' },
  { value: 'realesr-animevideov3', label: 'Real-ESRGAN anime video v3 (video frames)' },
];
const OPTIMIZE_FORMATS = ['keep', 'jpeg', 'png', 'webp', 'avif'];
const ANCHOR_AXES = ['left', 'center', 'right'];
const ANCHOR_AYES = ['top', 'center', 'bottom'];

/**
 * Generate a unique, filesystem-safe item id. Not a real ULID, but monotonic-ish
 * (timestamp + random) and safe across sessions. Used as the img_<id>_ prefix.
 */
function newItemId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `img_${ts}${rand}`;
}

/**
 * Sanitize a user-supplied filename into a safe single-path-segment basename.
 * Strips path separators, clamps length, rejects dot/dotdot, keeps extension.
 * This is the ONLY place a user-controlled name reaches a path, so it is strict.
 */
function safeBaseName(name, fallback) {
  if (typeof name !== 'string') return fallback || 'image';
  // Strip directory separators + null bytes; collapse; trim dots/spaces.
  let base = name.replace(/[\\/:]/g, '_').replace(/\0/g, '').trim();
  // Reject pure dot/dotdot / empty → fallback.
  if (!base || base === '.' || base === '..' || /^\.+$/.test(base)) return fallback || 'image';
  // Clamp length (keep room for the id prefix + stage suffix).
  if (base.length > 120) {
    const dot = base.lastIndexOf('.');
    if (dot > 0 && base.length - dot < 16) {
      base = base.slice(0, 120 - (base.length - dot)) + base.slice(dot);
    } else {
      base = base.slice(0, 120);
    }
  }
  return base;
}

/**
 * Build the absolute path for an item's file at a given column.
 *   workspace      abs path to <effectiveOutputDir>/pipeline/image
 *   id             item id (from newItemId)
 *   displayName    original display name (sanitised via safeBaseName)
 *   column         one of STORAGE_COLUMNS
 *   opts           { mult?, ext?, replaceN?, columnFolders? }
 */
function outPath(workspace, id, displayName, column, opts) {
  opts = opts || {};
  let folder = column;
  if (opts.columnFolders && typeof opts.columnFolders[column] === 'string' && opts.columnFolders[column].trim()) {
    folder = opts.columnFolders[column].trim();
  }
  const base = safeBaseName(displayName, 'image');
  const ext = opts.ext ? opts.ext.replace(/^\.+/, '') : (base.includes('.') ? '' : 'png');
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  const useExt = ext || (base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : 'png');
  let infix = '';
  if (column === 'upscale' && opts.mult) infix = `_${opts.mult}x`;
  else if (column === 'removebg') infix = '_nobg';
  else if (column === 'crop') infix = '_cropped';
  else if (column === 'resize') infix = '_resized';
  else if (column === 'optimize') infix = '_opt';
  let name = `${id}_${stem}${infix}`;
  if (opts.replaceN && opts.replaceN > 0) name += `_replace${opts.replaceN}`;
  name += `.${useExt}`;
  // Use path.resolve so absolute overrides (e.g. D:\Output) ignore the workspace root
  return path.resolve(workspace, folder, name);
}

/**
 * The column AFTER the given one in COLUMN_ORDER, or null if this is the last.
 */
function nextColumn(col) {
  const i = COLUMN_ORDER.indexOf(col);
  return i >= 0 && i < COLUMN_ORDER.length - 1 ? COLUMN_ORDER[i + 1] : null;
}

/**
 * The column BEFORE the given one in COLUMN_ORDER, or null if this is the first.
 */
function prevColumn(col) {
  const i = COLUMN_ORDER.indexOf(col);
  return i > 0 ? COLUMN_ORDER[i - 1] : null;
}

/**
 * Deep-merge per-item settings over the column defaults. Item-level keys win;
 * missing keys fall back to the column default. Returns a fresh object.
 */
function resolveSettings(column, itemSettings) {
  const def = COLUMN_DEFAULTS[column] || {};
  const over = (itemSettings && typeof itemSettings === 'object' && itemSettings[column]) || {};
  return { ...def, ...over };
}

module.exports = {
  COLUMN_ORDER, ACTIVE_COLUMNS, STORAGE_COLUMNS, STAGE_SUFFIX, COLUMN_DEFAULTS,
  REALESRGAN_MODELS, REALESRGAN_MODEL_DETAILS, OPTIMIZE_FORMATS, ANCHOR_AXES, ANCHOR_AYES,
  newItemId, safeBaseName, outPath, nextColumn, prevColumn, resolveSettings,
};
