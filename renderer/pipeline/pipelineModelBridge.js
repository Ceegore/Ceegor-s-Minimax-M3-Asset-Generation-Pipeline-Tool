// renderer/pipeline/pipelineModelBridge.js
// Exposes the pure pipeline-model constants/helpers to the renderer. The
// renderer can't require('src/...') (contextIsolation, no node integration), so
// this file is a thin mirror of the pure parts of src/pipeline/pipelineModel.js.
// The two MUST stay in lock-step; the unit tests in tests/unit/src/pipeline/
// guard the source-of-truth version.
//
// Kept deliberately small (constants + pure helpers only) so there's nothing to
// drift except the column lists, which change very rarely.

(function () {
  const COLUMN_ORDER = ['original', 'upscale', 'removebg', 'crop', 'resize', 'optimize', 'final'];
  const ACTIVE_COLUMNS = ['upscale', 'removebg', 'crop', 'resize', 'optimize'];
  const STORAGE_COLUMNS = ['original', 'upscale', 'removebg', 'crop', 'resize', 'optimize', 'final'];

  const COLUMN_DEFAULTS = {
    upscale: { multiplier: 2, model: 'realesrgan-x4plus', useCanvasFallback: false },
    // gewv2 GEW-010 fix: default to the higher-quality bundled model.
    removebg: { model: 'birefnet-general-lite', useGpu: true, skipIfTransparent: true },
    crop: { mode: 'anchor', w: 0, h: 0, anchorX: 'center', anchorY: 'center', x: 0, y: 0 },
    resize: { width: 0, height: 0, keepAspect: true, sharpen: true },
    optimize: { format: 'keep', quality: 82, stripMetadata: true },
  };

  // Keep this renderer bridge in lock-step with src/pipeline/pipelineModel.js.
  // The supported ncnn bundle only contains these three models.
  const REALESRGAN_MODELS = ['realesrgan-x4plus', 'realesrgan-x4plus-anime', 'realesr-animevideov3'];
  const REALESRGAN_MODEL_DETAILS = [
    { value: 'realesrgan-x4plus', label: 'Real-ESRGAN x4plus (general-purpose)' },
    { value: 'realesrgan-x4plus-anime', label: 'Real-ESRGAN x4plus anime (illustration)' },
    { value: 'realesr-animevideov3', label: 'Real-ESRGAN anime video v3 (video frames)' },
  ];

  function nextColumn(col) {
    const i = COLUMN_ORDER.indexOf(col);
    return i >= 0 && i < COLUMN_ORDER.length - 1 ? COLUMN_ORDER[i + 1] : null;
  }
  function prevColumn(col) {
    const i = COLUMN_ORDER.indexOf(col);
    return i > 0 ? COLUMN_ORDER[i - 1] : null;
  }
  function resolveSettings(column, itemSettings) {
    const def = COLUMN_DEFAULTS[column] || {};
    const over = (itemSettings && typeof itemSettings === 'object' && itemSettings[column]) || {};
    return Object.assign({}, def, over);
  }

  // These two pure helpers are copied VERBATIM from
  // src/pipeline/pipelineModel.js (the source of truth) so the renderer's name
  // sanitisation + path building can never drift from the main-process side.
  // pipelineCard.build()'s rename modal calls safeBaseName; pipelineOps delegates
  // outPath() here so the file name the renderer computes matches the name the
  // main-process IPC handlers compute (length clamp, ext default, infix, etc.).
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
    // Renderer has no node 'path'; mirror path.resolve's absolute-overrides-root
    // behaviour with string joins (absolute folder → ignore workspace root).
    if (/^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith('/') || folder.startsWith('\\\\')) {
      const folderSep = folder.includes('\\') ? '\\' : '/';
      return [folder.replace(/[\\/]+$/, ''), name].join(folderSep);
    }
    const sep = String(workspace).includes('\\') ? '\\' : '/';
    return [workspace, folder, name].join(sep);
  }

  window.PipelineModel = {
    COLUMN_ORDER, ACTIVE_COLUMNS, STORAGE_COLUMNS, COLUMN_DEFAULTS,
    REALESRGAN_MODELS, REALESRGAN_MODEL_DETAILS,
    nextColumn, prevColumn, resolveSettings, safeBaseName, outPath,
  };
})();
