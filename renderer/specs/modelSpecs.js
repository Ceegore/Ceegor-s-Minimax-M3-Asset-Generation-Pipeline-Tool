// renderer/specs/modelSpecs.js
// Per-model spec registry + validation helpers.
//
// Single source of truth for what each model accepts. Each tab
// builds its form from one of these specs; the spec also drives
// per-row validation (max chars, max value, min value) and the
// "show only supported parameters" rule.
//
// The values below are pulled from the official MiniMax API
// documentation at https://platform.minimax.io/docs/api-reference/
// (image / video / music / speech tabs). Adding a new model
// here is the only change required — every parameter row in the
// corresponding tab consults this table to decide whether to be
// shown, what its max is, and how to format the help text.
//
// Schema for each entry:
//   prompt: { max: <chars>, help: <human-readable> }
//   supportedFlags: [<string>, ...] — only these --flags are sent.
//     Rows whose label doesn't appear here are NOT rendered.
//   perRowOverrides: optional map of flag → { max, min, step }
//     used by a few rows whose numeric range is tighter than the
//     generic input type definition.
//
// To verify a value is in range the renderer does TWO things:
//   1. The number <input> gets min/max attributes (already does).
//   2. Before mmx is called, validateAgainstSpec() re-checks every
//      row against the spec and short-circuits with a toast if
//      anything is out of range.

const MODEL_SPECS = {
  image: {
    label: 'Image generation',
    prompt: { max: 1500, help: 'Up to 1500 characters (hard limit).' },
    supportedFlags: [
      '--prompt',           // mandatory; the textarea above the parameters grid
      '--aspect-ratio',     // 1:1 (default) / 16:9 / 9:16 / 4:3 / 3:4 / 2:3 / 3:2 / 21:9
      '--n',                // 1–9 (renderer clamps to 4)
      '--width',            // 512–2048 multiple of 8
      '--height',           // 512–2048 multiple of 8
      '--seed',             // 0 .. 2^31-1
      '--prompt-optimizer', // boolean
      '--aigc-watermark',   // boolean
      '--subject-reference-file',
      '--subject-reference-type', // 'character' (only supported value)
    ],
  },
  speech: {
    label: 'Speech generation',
    prompt: { max: 10000, help: 'Up to 10 000 characters (hard limit).' },
    supportedFlags: [
      '--model',      // speech-2.8-hd / speech-2.8-turbo / speech-2.6-hd / speech-2.6-turbo / speech-02-hd / speech-02-turbo / speech-2.6 / speech-02
      '--voice',      // voice id (loaded from `mmx speech voices`)
      '--speed',      // 0.5–2.0, step 0.05, default 1.0
      '--volume',     // 0–10, step 1, default 0
      '--pitch',      // -12..+12 semitones, step 1, default 0
      '--format',     // mp3 / wav / pcm / flac / opus / pcmu_raw / pcmu_wav
      '--sample-rate',// 8000/16000/22050/24000/32000/44100
      '--bitrate',    // 32000..320000
      '--channels',   // 1 / 2
      '--language',   // 2-letter code or 'auto' (voice-dependent)
      '--subtitles',  // boolean (saves .srt alongside audio)
      '--pronunciation', // from=to list
      '--emotion',    // happy/sad/angry/fearful/surprised/disgusted/neutral
      '--text',       // the textarea; mandatory
    ],
    perRowOverrides: {
      // speech-2.6 and below do NOT support --emotion. The
      // renderer hides the row when one of those models is
      // selected.
      '--emotion': {
        supportedForModels: new Set(['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo']),
        note: 'Emotion control is only available on the 2.6+ speech models.',
      },
      // --bitrate only applies to compressed formats (mp3 / opus).
      '--bitrate': {
        supportedForFormats: new Set(['mp3', 'opus']),
        note: 'Bitrate only affects MP3 / Opus; WAV / PCM / FLAC are lossless.',
      },
    },
  },
  music: {
    label: 'Music generation',
    prompt: { max: 2000, help: 'Up to 2 000 characters (hard limit).' },
    lyrics: { max: 3500, help: 'Up to 3 500 characters. Required unless is_instrumental or lyrics_optimizer is enabled.' },
    supportedFlags: [
      '--model',              // music-2.0 / music-2.5 / music-2.5+ / music-2.6
      '--prompt',             // mandatory, 10–2000 chars
      '--lyrics',             // 10–3000 chars (2.6 supports 3500); not needed for instrumental
      '--instrumental',       // boolean, music-2.5+ / music-2.6
      '--lyrics-optimizer',   // boolean (music-2.6)
      '--sample-rate',        // 8000/16000/22050/24000/32000/44100 (music-2.0 supports 8000)
      '--bitrate',            // 32000/64000/128000/256000
      '--format',             // mp3 (default) / wav / pcm
      '--genre', '--mood', '--vocals', '--instruments', '--bpm', '--key', '--tempo', '--structure', '--references', '--avoid', '--use-case', '--extra', '--output-format', '--aigc-watermark',
    ],
    perRowOverrides: {
      // music-2.0 does NOT support --instrumental, --lyrics, or
      // --lyrics-optimizer. music-2.5 supports --lyrics but not
      // --lyrics-optimizer. Only music-2.6 supports all three.
      '--instrumental': {
        supportedForModels: new Set(['music-2.5', 'music-2.5+', 'music-2.6']),
        note: 'Instrumental mode is supported on music-2.5 / 2.5+ / 2.6 only.',
      },
      '--lyrics-optimizer': {
        supportedForModels: new Set(['music-2.6']),
        note: 'Auto-lyrics is supported on music-2.6 only.',
      },
      '--lyrics': {
        // music-2.0 supports lyrics but the model often ignores
        // them. The renderer keeps the row visible but flags it.
        note: 'music-2.5 / 2.6 honor --lyrics reliably; music-2.0 may ignore them.',
      },
    },
  },
  video: {
    label: 'Video generation',
    prompt: { max: 2000, help: 'Up to 2 000 characters (hard limit).' },
    supportedFlags: [
      '--model',                   // MiniMax-Hailuo-2.3 / MiniMax-Hailuo-02 / S2V-01
      '--prompt',                  // mandatory, 1–2000 chars
      '--first-frame-image',       // image path or URL
      '--last-frame-image',        // image path or URL (Hailuo-02 only)
      '--subject-image',           // S2V-01 only
      '--duration',                // 6 (always) or 10 (768p only)
      '--resolution',              // 768p / 1080p (1080p = 6s only on 2.3 / 02)
      '--prompt-optimizer',        // boolean
      '--fast-pretreatment',       // boolean (Hailuo-2.3 + Hailuo-02)
    ],
    perRowOverrides: {
      '--first-frame-image': {
        supportedForModels: new Set(['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-02']),
        note: 'MiniMax-Hailuo-2.3-Fast and MiniMax-Hailuo-02 require a first-frame image.',
      },
      '--last-frame-image': {
        supportedForModels: new Set(['MiniMax-Hailuo-02']),
        note: 'Last-frame image is supported on MiniMax-Hailuo-02 only (first+last frame interpolation).',
      },
      '--subject-image': {
        supportedForModels: new Set(['S2V-01']),
        note: 'Subject-image (face reference) is supported on S2V-01 only.',
      },
      '--duration': {
        // 10 s is only available at 768P. The renderer drops the
        // 10 option from the dropdown when 1080P is selected.
        dependsOnResolution: true,
        note: '10-second duration is only available at 768P.',
      },
      '--resolution': {
        // Kept in sync with VIDEO_RESOLUTIONS_BY_MODEL below (X1-F7: was stale).
        allowedForModels: {
          'MiniMax-Hailuo-2.3':       new Set(['768P', '1080P']),
          'MiniMax-Hailuo-2.3-Fast': new Set(['768P']),     // fast model only supports 768p
          'MiniMax-Hailuo-02':       new Set(['512P', '768P', '1080P']),
          'S2V-01':                  new Set(['768P']),     // S2V-01 only 768p
        },
        note: 'MiniMax-Hailuo-2.3-Fast and S2V-01 only support 768P.',
      },
      '--fast-pretreatment': {
        supportedForModels: new Set(['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-02']),
        note: 'Fast-pretreatment is supported on Hailuo-2.3 (+Fast) and Hailuo-02.',
      },
    },
  },
};

// Look up the per-model override for a row. Returns null if
// the row is generally supported for the tab but has no
// per-model restriction. Used by buildParamRow (to decide
// whether to render the row at all) and by the gen handler
// (to short-circuit before the request is sent).
function getRowSpec(tabKey, flag, currentModel, currentResolution) {
  const tab = MODEL_SPECS[tabKey];
  if (!tab || !tab.perRowOverrides) return null;
  const ov = tab.perRowOverrides[flag];
  if (!ov) return null;
  // Resolution-dependent rows: pick the option that matches
  // the current resolution dropdown value (used for the
  // video tab's --duration row, where the 10s option is
  // only valid at 768P).
  if (ov.dependsOnResolution && currentResolution && ov.resolutionOverrides) {
    return ov.resolutionOverrides[currentResolution] || ov;
  }
  return ov;
}

// Validate every value in the per-tab state against the spec.
// Returns an array of error strings (empty = OK). Called by the
// gen handler right before the request is sent so the user never
// gets a cryptic 400 from the API.
function validateTabAgainstSpec(tabKey, params, currentModel, currentResolution, isFlagVisibleForCurrentModel) {
  const errs = [];
  const tab = MODEL_SPECS[tabKey];
  if (!tab) return errs;
  for (const flag of tab.supportedFlags || []) {
    const param = params && params[flag];
    if (!param) continue;
    const v = param.getValue ? param.getValue() : (param.value ?? param.el?.value);
    if (v == null || v === '' || v === 'off') continue;
    // Skip flags that aren't visible for the current model.
    if (!isFlagVisibleForCurrentModel(tabKey, flag, currentModel, currentResolution, getRowSpec)) {
      errs.push(`${flag} is not supported on ${currentModel}. Switch models or hide this row.`);
      continue;
    }
    // Number range checks (only meaningful for numeric rows;
    // the buildParamRow already sets HTML min/max attributes
    // for native validation, but we re-check here so the
    // user sees a precise toast instead of a silent clamp).
    if (typeof v === 'number' || (typeof v === 'string' && /^-?\d/.test(v))) {
      const ov = tab.perRowOverrides && tab.perRowOverrides[flag];
      if (ov && ov.max != null && Number(v) > ov.max) {
        errs.push(`${flag} = ${v} exceeds max ${ov.max} for ${currentModel || 'this model'}.`);
      }
      if (ov && ov.min != null && Number(v) < ov.min) {
        errs.push(`${flag} = ${v} below min ${ov.min} for ${currentModel || 'this model'}.`);
      }
    }
    // Prompt max length (the textarea above the parameters
    // grid; the counter already colours itself red when over).
    if (flag === '--prompt' && tab.prompt && tab.prompt.max) {
      const len = String(v).length;
      if (len > tab.prompt.max) {
        errs.push(`Prompt is ${len} characters; max for ${tab.label} is ${tab.prompt.max}.`);
      }
    }
    if (flag === '--lyrics' && tab.lyrics && tab.lyrics.max) {
      const len = String(v).length;
      if (len > tab.lyrics.max) {
        errs.push(`Lyrics is ${len} characters; max for ${currentModel || 'this model'} is ${tab.lyrics.max}.`);
      }
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Authoritative allowed-value tables + a single pure validator.
//
// Sourced from the official MiniMax API docs + the mmx CLI schema
// (platform.minimax.io/docs/api-reference/{image,speech-t2a-http,music-
// generation,video-generation}). These are the values the API actually
// accepts — sending anything else returns "invalid params … is not
// allowed" and burns a request for nothing.
//
// validateValues(tabKey, values) is the ONE checker used by:
//   - each tab's Generate handler (pre-flight warning before spending a
//     request), and
//   - the BatchGen importer / runner (entries that fail are imported but
//     marked defective and skipped until the user repairs them).
// It takes a plain { flag: value } object (keys with or without leading
// dashes, any case) so it works for both the live form and parsed batch
// rows, and returns { errors: string[] } — empty means valid.
// ---------------------------------------------------------------------------
const MMX_ALLOWED = {
  image: {
    'aspect-ratio': ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2', '21:9'],
    'response-format': ['url', 'base64'],
    n: { min: 1, max: 9, integer: true },
    width: { min: 512, max: 2048, step: 8, integer: true },
    height: { min: 512, max: 2048, step: 8, integer: true },
    promptMax: 1500,
  },
  speech: {
    model: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo'],
    format: ['mp3', 'pcm', 'flac', 'wav', 'pcmu_raw', 'pcmu_wav', 'opus'],
    'sample-rate': [8000, 16000, 22050, 24000, 32000, 44100],
    bitrate: [32000, 64000, 128000, 256000],
    channels: [1, 2],
    speed: { min: 0.5, max: 2.0 },
    volume: { min: 0, max: 10, exclusiveMin: true }, // (0, 10]
    pitch: { min: -12, max: 12, integer: true },
    textMax: 10000,
  },
  music: {
    model: ['music-2.6', 'music-2.5+', 'music-2.5'],
    format: ['mp3', 'wav', 'pcm'],
    'sample-rate': [16000, 24000, 32000, 44100],
    bitrate: [32000, 64000, 128000, 256000],
    'output-format': ['hex', 'url'],
    promptMax: 2000,
    lyricsMax: 3500,
  },
  video: {
    model: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-02', 'S2V-01'],
    // FUNC-013: duration is a discrete enum per (mode, model, resolution),
    // NOT a continuous range. The allowed values are validated by
    // validateVideoParams() in ContractRegistry. The UI shows only the
    // valid durations for the current selection.
    duration: [6, 10],
    // The UNION of every model's supported resolutions. Each individual model
    // only supports a SUBSET (see VIDEO_RESOLUTIONS_BY_MODEL) — validateValues
    // enforces that subset against the selected model.
    resolution: ['512P', '768P', '1080P'],
    promptMax: 2000,
  },
};

// Per-model resolution allowlist — the single source of truth consumed by both
// the video tab's dynamic dropdown and validateValues. Mirrors the
// MODEL_SPECS.video.perRowOverrides['--resolution'].allowedForModels table but
// is exported as its own constant so the tab + validator + tests can import it
// without reaching into the per-row-override structure.
const VIDEO_RESOLUTIONS_BY_MODEL = {
  'MiniMax-Hailuo-2.3':       ['768P', '1080P'],
  // FUNC-015: Fast model supports 1080P (with 6s duration only).
  'MiniMax-Hailuo-2.3-Fast':  ['768P', '1080P'],
  // FUNC-014: Hailuo-02 supports 512P only for T2V/I2V, NOT for FL2V.
  // The FL2V restriction is enforced by durationsForVideoSelection().
  'MiniMax-Hailuo-02':        ['512P', '768P', '1080P'],
  'S2V-01':                   ['768P'],
};
const VIDEO_DEFAULT_RESOLUTION = '768P';
function resolutionsForVideoModel(model) {
  const list = VIDEO_RESOLUTIONS_BY_MODEL[model];
  return (Array.isArray(list) && list.length) ? list.slice() : ['768P'];
}
// Also used as a hint for which models support a given resolution, so the
// dropdown labels can stay accurate.
window.VIDEO_RESOLUTIONS_BY_MODEL = VIDEO_RESOLUTIONS_BY_MODEL;
window.resolutionsForVideoModel = resolutionsForVideoModel;
window.VIDEO_DEFAULT_RESOLUTION = VIDEO_DEFAULT_RESOLUTION;

function _mmxNorm(values) {
  const o = {};
  for (const [k, val] of Object.entries(values || {})) {
    if (val === undefined) continue;
    o[String(k).replace(/^--+/, '').toLowerCase()] = val;
  }
  return o;
}
function _mmxNum(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : NaN; }
function _mmxTruthy(v) { return v === true || v === 1 || v === '1' || v === 'true' || v === 'on' || v === 'yes'; }

// opts.partial = true → only validate the values that ARE present (skip
// "required-but-missing" rules). Used for BatchGen entries, which omit
// any param they inherit from the tab's current (already-valid) form
// settings; only the explicit overrides are checked.
function validateValues(tabKey, values, opts) {
  const partial = !!(opts && opts.partial);
  const errors = [];
  const A = MMX_ALLOWED[tabKey];
  if (!A) return { errors };
  const v = _mmxNorm(values);
  const enumCheck = (key, allowed) => {
    if (allowed && v[key] != null && v[key] !== '' && !allowed.map(String).includes(String(v[key]))) {
      errors.push(`${key} "${v[key]}" is not allowed — use one of: ${allowed.join(', ')}.`);
    }
  };
  const rangeCheck = (key, spec) => {
    const n = _mmxNum(v[key]);
    if (n == null) return;
    if (Number.isNaN(n)) { errors.push(`${key} must be a number.`); return; }
    if (spec.min != null && (spec.exclusiveMin ? n <= spec.min : n < spec.min)) errors.push(`${key} ${n} is below the minimum ${spec.exclusiveMin ? '(must be > ' + spec.min + ')' : spec.min}.`);
    if (spec.max != null && n > spec.max) errors.push(`${key} ${n} exceeds the maximum ${spec.max}.`);
    if (spec.integer && !Number.isInteger(n)) errors.push(`${key} must be a whole number.`);
    if (spec.step && Number.isFinite(n) && Math.abs(n % spec.step) > 1e-9) errors.push(`${key} ${n} must be a multiple of ${spec.step}.`);
  };
  enumCheck('model', A.model);

  if (tabKey === 'image') {
    enumCheck('aspect-ratio', A['aspect-ratio']);
    enumCheck('response-format', A['response-format']);
    rangeCheck('n', A.n); rangeCheck('width', A.width); rangeCheck('height', A.height);
    const hasW = v.width != null && v.width !== '';
    const hasH = v.height != null && v.height !== '';
    if (hasW !== hasH) errors.push('Width and height must be set together (or both left blank).');
    if (v.prompt && String(v.prompt).length > A.promptMax) errors.push(`Prompt is ${String(v.prompt).length} chars; max for image is ${A.promptMax}.`);
  } else if (tabKey === 'speech') {
    enumCheck('format', A.format); enumCheck('sample-rate', A['sample-rate']); enumCheck('channels', A.channels);
    rangeCheck('speed', A.speed); rangeCheck('volume', A.volume); rangeCheck('pitch', A.pitch);
    const fmt = String(v.format || 'mp3');
    if (v.bitrate != null && v.bitrate !== '' && ['mp3', 'opus'].includes(fmt) && !A.bitrate.includes(Number(v.bitrate))) {
      errors.push(`bitrate ${v.bitrate} is not allowed — use one of: ${A.bitrate.join(', ')}.`);
    }
    const text = v.text != null ? v.text : v.prompt;
    if (text && String(text).length > A.textMax) errors.push(`Text is ${String(text).length} chars; max for speech is ${A.textMax}.`);
  } else if (tabKey === 'music') {
    enumCheck('format', A.format); enumCheck('sample-rate', A['sample-rate']); enumCheck('output-format', A['output-format']);
    if (v.bitrate != null && v.bitrate !== '' && !A.bitrate.includes(Number(v.bitrate))) {
      errors.push(`bitrate ${v.bitrate} is not allowed — use one of: ${A.bitrate.join(', ')}.`);
    }
    const instrumental = _mmxTruthy(v.instrumental);
    const optimizer = _mmxTruthy(v['lyrics-optimizer']);
    const hasLyrics = !!(v.lyrics && String(v.lyrics).trim()) || !!(v['lyrics-file'] && String(v['lyrics-file']).trim());
    if (instrumental && hasLyrics) errors.push('Instrumental mode cannot be combined with custom lyrics.');
    if (optimizer && hasLyrics) errors.push('Auto-lyrics (lyrics-optimizer) cannot be combined with custom lyrics.');
    if (optimizer && instrumental) errors.push('Auto-lyrics (lyrics-optimizer) cannot be combined with instrumental mode.');
    if (optimizer && v.model && String(v.model) !== 'music-2.6') errors.push('Auto-lyrics (lyrics-optimizer) requires the music-2.6 model.');
    if (instrumental && String(v.model) === 'music-2.5') errors.push('Instrumental mode requires music-2.5+ or music-2.6.');
    if (v.prompt && String(v.prompt).length > A.promptMax) errors.push(`Prompt is ${String(v.prompt).length} chars; max for music is ${A.promptMax}.`);
    if (v.lyrics && String(v.lyrics).length > A.lyricsMax) errors.push(`Lyrics is ${String(v.lyrics).length} chars; max is ${A.lyricsMax}.`);
    // Required-but-missing: only meaningful for the live form. A batch
    // entry that omits the mode inherits the tab's (valid) mode, so skip.
    if (!partial && !instrumental && !optimizer && !hasLyrics) errors.push('Music needs lyrics — provide lyrics, or enable instrumental / auto-lyrics.');
  } else if (tabKey === 'video') {
    enumCheck('resolution', A.resolution);
    rangeCheck('duration', A.duration);
    // Model-aware resolution check (H7-020): each model only supports a subset
    // of the union above. If the selected resolution isn't valid for the
    // selected model, flag it with a precise message instead of letting the
    // mmx CLI return a generic 400.
    if (v.resolution && v.model) {
      const allowedForModel = resolutionsForVideoModel(String(v.model));
      if (!allowedForModel.includes(String(v.resolution))) {
        errors.push(`--resolution ${v.resolution} is not supported by ${v.model}. Use one of: ${allowedForModel.join(', ')}.`);
      }
    }
    const hasFirst = !!(v['first-frame'] || v['first-frame-image']);
    const hasLast = !!(v['last-frame'] || v['last-frame-image']);
    const hasSubject = !!(v['subject-image']);
    if (String(v.model) === 'MiniMax-Hailuo-2.3-Fast' && !hasFirst) errors.push('MiniMax-Hailuo-2.3-Fast requires a first-frame image.');
    if (hasLast && !hasFirst) errors.push('A last-frame image also requires a first-frame image.');
    // S2V-01 is the subject-reference model — the API rejects it without
    // a subject image ("param 'subject_reference' is required").
    if (String(v.model) === 'S2V-01' && !hasSubject) errors.push('The S2V-01 model requires a subject reference image (set --subject-image, or switch to MiniMax-Hailuo-2.3 for text-to-video).');
    // 1080P caps at 6 s (10 s is only available at 768P). Without this
    // check the renderer accepts e.g. --duration 10 --resolution 1080P
    // and the mmx CLI returns a generic 400 ("invalid params").
    if (String(v.resolution) === '1080P' && _mmxNum(v.duration) === 10) {
      errors.push('--duration 10 is only available at 768P (1080P caps at 6 s). Switch to 768P or pick --duration 6.');
    }
    if (v.prompt && String(v.prompt).length > A.promptMax) errors.push(`Prompt is ${String(v.prompt).length} chars; max for video is ${A.promptMax}.`);
  }
  return { errors };
}

// Tool-level combo validator. Checks things the MiniMax API itself
// accepts (so they wouldn't show up in validateValues) but that the
// GUI warns the user about because they tend to surprise or cost API
// quota. Currently:
//   - image: --n (per-call count) combined with the Variants dropdown
//     (re-spawns mmx N times) multiplies the image count and the
//     mmx-call count. A user who sets --n=2 + Variants=2 expects 2
//     images and instead burns 4 API calls (and may hit rate limits
//     on the rapid back-to-back requests). Warn, don't block.
//   - all tabs: a high Variants value (>3) is allowed but burns quota
//     and increases the chance of a rate-limit failure mid-batch.
//
// `toolCtx` carries GUI state that validateValues() doesn't see
// (variantsCount). Passing {} keeps this safe to call from older
// call sites that only have the mmx-API values.
function validateToolCombos(tabKey, values, toolCtx) {
  const errors = [];
  toolCtx = toolCtx || {};
  const v = _mmxNorm(values || {});
  if (tabKey === 'image') {
    const n = _mmxNum(v.n);
    const variants = Math.max(1, Math.floor(Number(toolCtx.variantsCount) || 1));
    if (n != null && !Number.isNaN(n) && n > 1 && variants > 1) {
      const total = n * variants;
      errors.push(
        `--n=${n} combined with Variants=${variants} will spawn ${variants} ` +
        `mmx calls, each requesting ${n} images, for a total of ${total} ` +
        `images. Multiple rapid mmx calls can trigger rate limits. Consider ` +
        `using just one of --n or Variants.`
      );
    }
    // Total-image budget: anything beyond 9 images (the per-call
    // maximum) is technically allowed by the API but is a strong
    // signal the user misread the controls. Warn so they can
    // adjust before burning quota.
    if (variants > 1) {
      const total = (n != null && !Number.isNaN(n) ? n : 1) * variants;
      if (total > 9) {
        errors.push(
          `Total images (--n × Variants = ${total}) exceeds the API's ` +
          `per-call maximum of 9 and will consume ${total} API credits.`
        );
      }
    }
  } else if (tabKey === 'speech' || tabKey === 'music' || tabKey === 'video') {
    const variants = Math.max(1, Math.floor(Number(toolCtx.variantsCount) || 1));
    if (variants > 3) {
      errors.push(
        `Variants is set to ${variants}. This will spawn ${variants} ` +
        `${tabKey} generation calls in rapid succession and may trigger ` +
        `API rate limits.`
      );
    }
  }
  return { errors };
}

// Live pre-generation guard. Runs validateValues AND validateToolCombos
// (if a toolCtx is provided) and, if anything looks problematic, warns
// the user with the specific reasons and lets them decide (OK = generate
// anyway, Cancel = stop). Deliberately does NOT hard-block — a false
// positive must never lock the user out of generating. Returns true when
// generation should proceed.
function _preflightModal(lead, errors, canOverride) {
  if (typeof showModal !== 'function') return Promise.resolve(canOverride !== false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer, close) => {
      if (settled) return;
      settled = true;
      try { close(); } catch (_) {}
      resolve(answer);
    };
    showModal((m, close) => {
      const panel = el('div', { class: 'preflight-confirm' });
      panel.append(el('h3', {}, canOverride === false ? 'Generation blocked' : 'Check generation settings'), el('p', {}, lead));
      const list = el('ul');
      for (const error of errors) list.appendChild(el('li', {}, error));
      // FUNC-016: hard errors have NO "Generate anyway" button.
      if (canOverride === false) {
        const ok = el('button', { class: 'primary' }, 'OK');
        ok.addEventListener('click', () => finish(false, close));
        panel.append(list, el('div', { class: 'actions' }, [ok]));
      } else {
        const cancel = el('button', {}, 'Cancel');
        const proceed = el('button', { class: 'primary' }, 'Generate anyway');
        cancel.addEventListener('click', () => finish(false, close));
        proceed.addEventListener('click', () => finish(true, close));
        panel.append(list, el('div', { class: 'actions' }, [cancel, proceed]));
      }
      m.appendChild(panel);
    }, { onClose: () => { if (!settled) { settled = true; resolve(false); } } });
  });
}

async function mmxPreflightConfirm(tabKey, values, toolCtx) {
  try {
    const apiErrors = (validateValues(tabKey, values) || {}).errors || [];
    const toolErrors = (validateToolCombos(tabKey, values, toolCtx) || {}).errors || [];
    // FUNC-016: API errors are HARD blocks (no "Generate anyway").
    // Tool warnings are confirmable (user can override).
    if (apiErrors.length) {
      // Hard block: show errors with NO override option.
      const lead = 'These settings will be rejected by the MiniMax API. Fix them before generating:';
      const canOverride = false;
      return _preflightModal(lead, apiErrors, canOverride);
    }
    if (toolErrors.length) {
      // Confirmable: tool-level warnings with "Generate anyway" option.
      const lead = 'Heads up — these settings may produce unexpected results:';
      return _preflightModal(lead, toolErrors, true);
    }
  } catch (_) { /* never block generation on a validator bug */ }
  return true;
}

window.ModelSpecs = { MODEL_SPECS, MMX_ALLOWED, VIDEO_RESOLUTIONS_BY_MODEL, VIDEO_DEFAULT_RESOLUTION, resolutionsForVideoModel, getRowSpec, validateTabAgainstSpec, validateValues, validateToolCombos, mmxPreflightConfirm };
