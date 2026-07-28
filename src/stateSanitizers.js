// src/stateSanitizers.js
// The state.json field sanitisers, extracted from src/state.js so that file
// stays under the lint 500-line cap. These run on BOTH the write path
// (state.write) and the read path (state.read) so a hand-edited or corrupted
// state.json can never land bogus values in the renderer.
//
// Keep these functions PURE: no fs, no Electron, no side effects. They take
// an untrusted value and return a trusted, clamped/whitelisted copy.

// The pipelineAdvancedSettings sanitiser. Uses `Number.isFinite(n = Number(x))
// ? Math.round(n) : <default>` rather than `Math.round(Number(x)) || <default>`,
// which rejected 0 for the zero-valid fields (mp3Quality 0 = highest quality,
// webpEffort 0 = fastest, pngCompressionLevel 0 = fastest, etc.). 0 is accepted
// as long as it is in range.
function sanitisePipelineAdvancedSettings(input) {
  if (!input || typeof input !== 'object') {
    return {
      realesrgan: { tileSize: 0, ttaMode: false, gpuId: 'auto' },
      isnetbg: { intraOpNumThreads: 0, interOpNumThreads: 0, executionMode: 'sequential', postClean: true, featherPx: 1, defringe: true, refine: true },
      optimize: {
        jpegChromaSubsampling: '4:2:0', jpegMozjpeg: true,
        pngCompressionLevel: 9, pngPalette: false,
        webpMode: 'lossy', webpEffort: 6,
        avifEffort: 9, avifChromaSubsampling: '4:4:4',
      },
      audio: {
        silenceThresholdDb: -50, minSilenceMs: 50,
        mp3Quality: 2, oggQuality: 6, opusBitrate: '128k', m4aBitrate: '192k',
      },
    };
  }
  // Parse a number from any input, returning `fallback` when the result is
  // non-finite OR outside [min, max]. Unlike `Number(x) || default`, this
  // accepts an explicit 0. null / undefined / '' are treated as "missing"
  // -> fallback (so a hand-edited `mp3Quality: null` keeps the documented
  // default).
  function nOr(value, min, max, fallback) {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const r = Math.round(n);
    if (r < min || r > max) return fallback;
    return r;
  }
  const r = input.realesrgan && typeof input.realesrgan === 'object' ? input.realesrgan : {};
  const i = input.isnetbg && typeof input.isnetbg === 'object' ? input.isnetbg : {};
  const o = input.optimize && typeof input.optimize === 'object' ? input.optimize : {};
  const a = input.audio && typeof input.audio === 'object' ? input.audio : {};
  // opusBitrate / m4aBitrate whitelist. The overlay only offers the
  // documented set, so accepting any `/^\d+k$/` value lets a corrupted
  // write sneak in 500k (or 1k, 9999k) which the AudioCutter would
  // forward to ffmpeg. We narrow the regex to the union of the overlay's
  // options to keep the persisted value in lock-step with what the UI can
  // re-select.
  const ALLOWED_OPUS_BITRATES = ['64k', '96k', '128k', '160k', '192k', '256k'];
  const ALLOWED_M4A_BITRATES = ['96k', '128k', '160k', '192k', '256k', '320k'];
  return {
    realesrgan: {
      // Valid tile set is {0=auto} ∪ [32,4096] (the binary rejects <32);
      // 1..31 / out-of-range -> 0 (auto).
      tileSize: (() => { const t = nOr(r.tileSize, 0, 4096, 0); return (t === 0 || (t >= 32 && t <= 4096)) ? t : 0; })(),
      ttaMode: r.ttaMode === true,
      // GPU id whitelist is [0,15] so multi-GPU rigs can pin a real device;
      // else 'auto'.
      gpuId: (r.gpuId === 'auto' || (/^\d+$/.test(String(r.gpuId)) && Number(r.gpuId) >= 0 && Number(r.gpuId) <= 15)) ? String(r.gpuId) : 'auto',
    },
    isnetbg: {
      intraOpNumThreads: nOr(i.intraOpNumThreads, 0, 64, 0),
      interOpNumThreads: nOr(i.interOpNumThreads, 0, 64, 0),
      executionMode: ['sequential', 'parallel'].includes(i.executionMode) ? i.executionMode : 'sequential',
      // PE-015: postprocess opts (edge cleanup control).
      postClean: i.postClean !== false,
      featherPx: nOr(i.featherPx, 0, 8, 1),
      defringe: i.defringe !== false,
      // Issue 6: guided-filter matte refinement (default ON).
      refine: i.refine !== false,
    },
    optimize: {
      jpegChromaSubsampling: ['4:2:0', '4:4:4'].includes(o.jpegChromaSubsampling) ? o.jpegChromaSubsampling : '4:2:0',
      jpegMozjpeg: o.jpegMozjpeg !== false,
      pngCompressionLevel: nOr(o.pngCompressionLevel, 0, 9, 9),
      pngPalette: o.pngPalette === true,
      webpMode: ['lossy', 'lossless', 'nearLossless'].includes(o.webpMode) ? o.webpMode : 'lossy',
      webpEffort: nOr(o.webpEffort, 0, 6, 6),
      avifEffort: nOr(o.avifEffort, 0, 9, 9),
      avifChromaSubsampling: ['4:4:4', '4:2:0'].includes(o.avifChromaSubsampling) ? o.avifChromaSubsampling : '4:4:4',
    },
    audio: {
      silenceThresholdDb: nOr(a.silenceThresholdDb, -100, 0, -50),
      minSilenceMs: nOr(a.minSilenceMs, 0, 10000, 50),
      mp3Quality: nOr(a.mp3Quality, 0, 9, 2),
      oggQuality: nOr(a.oggQuality, 0, 10, 6),
      opusBitrate: ALLOWED_OPUS_BITRATES.includes(a.opusBitrate) ? a.opusBitrate : '128k',
      m4aBitrate: ALLOWED_M4A_BITRATES.includes(a.m4aBitrate) ? a.m4aBitrate : '192k',
    },
  };
}

// The autoCutSettings sanitiser. Runs on BOTH read and write paths so a
// hand-edited or corrupted state.json with a bogus longSegmentPolicy /
// out-of-range threshold can't reach the renderer's auto-cut config inputs.
// The UI fields (thresholdDb / minSilenceMs / fade / format) are NOT covered
// by the pure sanitizeAutoCutRules helper (which only handles the planning
// rules), so they are clamped/whitelisted here.
function sanitiseAutoCutSettings(input) {
  const { sanitizeAutoCutRules } = require('./audio/AudioAutoCutPlan');
  const base = (input && typeof input === 'object') ? input : {};
  return {
    ...sanitizeAutoCutRules(base),
    thresholdDb: (() => {
      const n = Number(base.thresholdDb);
      return Number.isFinite(n) ? Math.max(-80, Math.min(-10, n)) : -35;
    })(),
    minSilenceMs: (() => {
      const n = Number(base.minSilenceMs);
      return Number.isFinite(n) ? Math.max(50, Math.min(5000, n)) : 250;
    })(),
    fade: base.fade === true,
    format: ['wav', 'mp3', 'ogg', 'opus', 'flac', 'm4a', 'aac'].includes(base.format)
      ? base.format
      : 'wav',
  };
}

// The pipeline board sanitiser. A corrupted state.json must NEVER crash the
// app or yield a board with dangling paths / bad model keys (model keys end up
// in spawn argv). We coerce the shape, whitelist enums against the SAME model
// whitelists the rest of the app uses, and drop items that are structurally
// broken (missing id / missing files.original). Never throws — always returns
// a valid board object.
function sanitisePipelineBoard(input) {
  const model = require('./pipeline/pipelineModel');
  const {
    COLUMN_DEFAULTS, STORAGE_COLUMNS, ACTIVE_COLUMNS,
    REALESRGAN_MODELS, OPTIMIZE_FORMATS, ANCHOR_AXES, ANCHOR_AYES,
  } = model;

  const DEFAULT_COLUMNS = {};
  for (const c of ACTIVE_COLUMNS) DEFAULT_COLUMNS[c] = { ...COLUMN_DEFAULTS[c] };

  // Per-active-column settings sanitiser. Used for BOTH the board-level column
  // defaults AND per-item overrides — per-item settings[c] must go through the
  // SAME whitelisting (model keys end up in a spawn argv, so this is the
  // load-bearing whitelist).
  function clampColSettings(column, src) {
    src = (src && typeof src === 'object') ? src : {};
    if (column === 'upscale') {
      // Migration for the typo shipped by earlier versions. Preserve the
      // user's intended video model instead of silently falling back to x4plus.
      const model = src.model === 'realesrgan-animevideov3'
        ? 'realesr-animevideov3'
        : src.model;
      let mult = parseInt(src.multiplier, 10);
      if (!(Number.isFinite(mult) && mult >= 1 && mult <= 8)) mult = 2;
      return {
        multiplier: mult,
        model: REALESRGAN_MODELS.includes(model) ? model : 'realesrgan-x4plus',
        useCanvasFallback: src.useCanvasFallback === true,
      };
    } else if (column === 'removebg') {
      let isKnown = false;
      try { isKnown = require('./isnetbg/modelRegistry').isKnownModel(src.model); } catch (_) { isKnown = false; }
      let autoBest = 'isnet-general-use';
      try { autoBest = require('./isnetbg/binaryDiscovery').resolveAutoBestModel(); } catch (_) { /* keep fallback */ }
      return {
        model: (typeof src.model === 'string' && isKnown) ? src.model : autoBest,
        useGpu: src.useGpu !== false,
        skipIfTransparent: src.skipIfTransparent !== false,
        // PE-015: per-column postprocess overrides.
        postClean: src.postClean !== false,
        featherPx: (() => { const n = Number(src.featherPx); return Number.isFinite(n) ? Math.max(0, Math.min(8, Math.round(n))) : 1; })(),
        defringe: src.defringe !== false,
        // Issue 6: guided-filter matte refinement (default ON).
        refine: src.refine !== false,
      };
    } else if (column === 'crop') {
      const clampOffset = (v) => Math.max(0, parseInt(v, 10) || 0);
      return {
        mode: src.mode === 'drag' ? 'drag' : 'anchor',
        w: Math.max(0, parseInt(src.w, 10) || 0),
        h: Math.max(0, parseInt(src.h, 10) || 0),
        anchorX: ANCHOR_AXES.includes(src.anchorX) ? src.anchorX : 'center',
        anchorY: ANCHOR_AYES.includes(src.anchorY) ? src.anchorY : 'center',
        x: clampOffset(src.x),
        y: clampOffset(src.y),
      };
    } else if (column === 'resize') {
      // Free-target resolution. width/height clamp to [0,65500] (0 = no
      // target -> op no-ops). keepAspect mirrors the GIMP/Photoshop chain
      // (default ON); sharpen is a hint the engine honours only on downscale.
      const clampDim = (v) => {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < 0) return 0;
        return Math.min(65500, n);
      };
      return {
        width: clampDim(src.width),
        height: clampDim(src.height),
        keepAspect: src.keepAspect !== false,
        sharpen: src.sharpen !== false,
      };
    } else if (column === 'optimize') {
      let q = parseInt(src.quality, 10);
      if (!(Number.isFinite(q) && q >= 1 && q <= 100)) q = 82;
      return {
        format: OPTIMIZE_FORMATS.includes(src.format) ? src.format : 'keep',
        quality: q,
        stripMetadata: src.stripMetadata !== false,
      };
    }
    return {};
  }

  function clampCols(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return DEFAULT_COLUMNS;
    for (const c of ACTIVE_COLUMNS) {
      out[c] = clampColSettings(c, raw[c]);
    }
    return out;
  }

  // Deep-clone a value to a JSON-safe form. Drops circular references + any
  // non-serialisable values that would crash state.write()'s JSON.stringify
  // (a circular history array would survive slice() and crash every
  // subsequent autosave, orphaning the temp file).
  function jsonSafe(value) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { return null; }
  }

  function clampItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (!raw.files || typeof raw.files !== 'object') return null;
    // The current column must be a known storage column; default to 'original'.
    let column = STORAGE_COLUMNS.includes(raw.column) ? raw.column : 'original';
    // files map: only keep string values (paths). original is required.
    const files = {};
    if (typeof raw.files.original === 'string' && raw.files.original) {
      files.original = raw.files.original;
    } else {
      return null; // an item without an original file is unrecoverable here
    }
    for (const k of Object.keys(raw.files)) {
      if (k !== 'original' && typeof raw.files[k] === 'string' && raw.files[k]) {
        files[k] = raw.files[k];
      }
    }
    // settings: run each per-active-column override through the SAME whitelisting
    // as the board-level columns (model keys, clamps, etc.).
    const settings = {};
    if (raw.settings && typeof raw.settings === 'object') {
      for (const c of ACTIVE_COLUMNS) {
        if (raw.settings[c] && typeof raw.settings[c] === 'object') {
          settings[c] = clampColSettings(c, raw.settings[c]);
        }
      }
    }
    // history: JSON-safe-clone the last 50 entries (drops circular refs that
    // would crash JSON.stringify on the next autosave).
    let history = [];
    if (Array.isArray(raw.history)) {
      const tail = raw.history.slice(-50);
      history = tail.map(jsonSafe).filter((v) => v && typeof v === 'object');
    }
    return {
      id: raw.id,
      column,
      name: (typeof raw.name === 'string' && raw.name) ? raw.name.slice(0, 200) : 'image',
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      files,
      settings,
      history,
      settingsOpen: (raw.settingsOpen && typeof raw.settingsOpen === 'object')
        ? Object.fromEntries(ACTIVE_COLUMNS.map((c) => [c, raw.settingsOpen[c] === true]))
        : {},
      status: ['idle', 'running', 'error', 'missing'].includes(raw.status) ? raw.status : 'idle',
      error: (typeof raw.error === 'string') ? raw.error.slice(0, 500) : null,
    };
  }

  // Soft-delete bin entry: only keep a minimal, JSON-safe shape (the renderer
  // pushes the full item object; we don't need its files/settings to persist).
  function clampTrashItem(raw) {
    const safe = jsonSafe(raw);
    if (!safe || typeof safe !== 'object') return null;
    return {
      id: (typeof safe.id === 'string') ? safe.id : (typeof safe.item === 'object' && safe.item && safe.item.id) ? safe.item.id : 'unknown',
      ts: Number.isFinite(safe.ts) ? safe.ts : Date.now(),
    };
  }

  if (!input || typeof input !== 'object') {
    return { workspace: '', columns: DEFAULT_COLUMNS, hiddenColumns: [], columnFolders: {}, items: [], trash: [], counter: 0 };
  }
  // Items: cap at a generous ceiling so a runaway import can't bloat state.json
  // unboundedly (every autosave serialises the whole board). Keep the NEWEST.
  const MAX_ITEMS = 1000;
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const clamped = rawItems.map(clampItem).filter(Boolean);
  const items = clamped.length > MAX_ITEMS ? clamped.slice(-MAX_ITEMS) : clamped;
  // Trash: keep the NEWEST 200 (slice(-200)), not the oldest — the newest
  // deletions are the ones the user is most likely to Undo. Each entry is
  // shape-validated so a corrupted trash can't carry arbitrary objects.
  const trash = (Array.isArray(input.trash) ? input.trash : [])
    .slice(-200)
    .map(clampTrashItem)
    .filter(Boolean);
  // Per-column custom output folders: a map of column-id -> absolute path.
  // Keys must be valid storage columns; values are clamped strings. Without
  // this, a user-configured folder is silently dropped on every autosave and
  // never survives a restart.
  const columnFolders = {};
  if (input.columnFolders && typeof input.columnFolders === 'object' && !Array.isArray(input.columnFolders)) {
    for (const [col, dir] of Object.entries(input.columnFolders)) {
      if (STORAGE_COLUMNS.includes(col) && typeof dir === 'string' && dir.trim()) {
        columnFolders[col] = dir.slice(0, 1024);
      }
    }
  }
  return {
    // R1.4 (S1 §4 "Pipeline und State"): persist only the
    // Main-minted workspaceId, never a free-form `workspace` path.
    // The legacy `workspace` string is migrated by registerStateIpc
    // BEFORE the sanitiser sees it (see state:get in
    // main/ipc/registerStateIpc.js); the sanitiser still echoes
    // `workspace` back when a legacy install persisted one, so the
    // IPC can detect and migrate it, but the round-tripped value
    // is NEVER used as a write authorisation (the IPC drops it on
    // the way back to the renderer).
    workspace: (typeof input.workspace === 'string') ? input.workspace : '',
    workspaceId: (typeof input.workspaceId === 'string' && input.workspaceId.trim())
      ? input.workspaceId.trim().slice(0, 256)
      : null,
    reauthorizationRequired: input.reauthorizationRequired === true,
    columns: clampCols(input.columns),
    hiddenColumns: Array.isArray(input.hiddenColumns)
      ? input.hiddenColumns.filter((c) => ACTIVE_COLUMNS.includes(c))
      : [],
    columnFolders,
    items,
    trash,
    counter: Number.isFinite(input.counter) ? Math.max(0, Math.floor(input.counter)) : 0,
  };
}

// Per-field whitelists for the model-key + settings fields
// (removeBackgroundModel, realesrganModel, optimizeSettings, upscaleSettings)
// applied on the READ path. The write path already whitelists these in
// state.write(); this helper applies the SAME whitelists on read so a
// hand-edited state.json can't land a malicious removeBackgroundModel in the
// renderer before any save runs the write-side sanitiser. It never throws and
// only touches fields it recognises (unknown future fields pass through).
// Mirrors the per-field logic in state.write() — keep the two in lock-step.
function sanitiseScalarStateFields(raw) {
  if (!raw || typeof raw !== 'object') return;
  const { isKnownModel } = require('./isnetbg/modelRegistry');
  // removeBackgroundModel: ends up in a spawn argv → whitelist against the
  // model registry (same check write() uses).
  if (raw.removeBackgroundModel != null) {
    let autoBest = 'isnet-general-use';
    try { autoBest = require('./isnetbg/binaryDiscovery').resolveAutoBestModel(); } catch (_) { /* keep fallback */ }
    raw.removeBackgroundModel = isKnownModel(raw.removeBackgroundModel)
      ? raw.removeBackgroundModel
      : autoBest; // PE-014: auto-best-compatible
  }
  // realesrganModel: ends up in a spawn argv. write() only trims + caps length,
  // so we mirror that here (src/realesrgan.js whitelists at the spawn boundary).
  if (raw.realesrganModel != null) {
    raw.realesrganModel = (typeof raw.realesrganModel === 'string' && raw.realesrganModel.trim())
      ? raw.realesrganModel.trim().slice(0, 64)
      : 'realesrgan-x4plus';
  }
  // optimizeSettings: format + quality + booleans. Mirrors write()'s clamps so a
  // corrupted quality=0 (which sharp rejects) or a bogus format can't reach libvips.
  if (raw.optimizeSettings && typeof raw.optimizeSettings === 'object') {
    const o = raw.optimizeSettings;
    o.enabled = !!o.enabled;
    o.quality = Math.max(1, Math.min(100, Math.round(Number(o.quality) || 82)));
    o.format = ['keep', 'jpeg', 'png', 'webp', 'avif'].includes(o.format) ? o.format : 'keep';
    o.stripMetadata = o.stripMetadata !== false;
  }
  // upscaleSettings: multiplier + crop anchors. Mirrors write()'s clamps/whitelists.
  if (raw.upscaleSettings && typeof raw.upscaleSettings === 'object') {
    const u = raw.upscaleSettings;
    u.multiplier = Math.max(1, Math.min(8, parseInt(u.multiplier, 10) || 2)); // KGO8-008: bound it, like the pipeline column does
    u.autoCrop = !!u.autoCrop;
    u.cropWidth = Math.max(0, parseInt(u.cropWidth, 10) || 0);
    u.cropHeight = Math.max(0, parseInt(u.cropHeight, 10) || 0);
    u.cropAnchorX = ['left', 'center', 'right'].includes(u.cropAnchorX) ? u.cropAnchorX : 'center';
    u.cropAnchorY = ['top', 'center', 'bottom'].includes(u.cropAnchorY) ? u.cropAnchorY : 'center';
  }
  // Booleans that gate behaviour: coerce so a corrupted string can't reach the
  // renderer as a truthy non-boolean (matches write()'s coercion for each).
  if (raw.removeBackgroundEnabled != null) raw.removeBackgroundEnabled = !!raw.removeBackgroundEnabled;
  if (raw.removeBackgroundUseGpu != null) raw.removeBackgroundUseGpu = raw.removeBackgroundUseGpu !== false;
}

module.exports = {
  sanitisePipelineAdvancedSettings,
  sanitiseAutoCutSettings,
  sanitisePipelineBoard,
  sanitiseScalarStateFields,
};
