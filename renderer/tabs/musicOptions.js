// renderer/tabs/musicOptions.js
// R7.4: shared pure MusicGenerationOptions collector.
//
// Single source of truth for mapping music-tab DOM control values → the
// bare-kebab params object consumable by ArgvBuilders.buildMusicArgs.
// Both the interactive tab (musicTab.js) and the batch/direct path
// (argvBuilders.js) use the SAME flag set; this collector ensures the
// interactive path never drifts from the batch builder's contract.
//
// Usage (interactive tab):
//   const params = window.MusicOptions.collect({ model, prompt, lyrics,
//     instrumental, lyricsOptimizer, genre, mood, ... });
//   // params is a bare-kebab object: { model, prompt, lyrics,
//   //   'instrumental': true/false, 'lyrics-optimizer': true/false, ... }
//
// The collector is PURE (no DOM reads) — the caller extracts DOM values
// and passes them as a flat object. This keeps the function unit-testable
// and reusable by the batch import path (follow-up ticket).

(function () {
  'use strict';

  // collect(opts) → bare-kebab params object for buildMusicArgs.
  // `opts` fields (all optional except prompt):
  //   model, prompt, genre, mood, vocals, instruments, bpm, key, tempo,
  //   structure, references, avoid, useCase, extra, format, sampleRate,
  //   bitrate, aigcWatermark, outputFormat,
  //   lyrics, instrumental, lyricsOptimizer
  function collect(opts) {
    opts = opts || {};
    const p = {};
    if (opts.model) p.model = opts.model;
    if (opts.prompt) p.prompt = opts.prompt;
    // R7.4 core: lyrics / instrumental / lyrics-optimizer.
    if (opts.lyrics != null && String(opts.lyrics).trim() !== '') {
      p.lyrics = String(opts.lyrics).trim();
    }
    if (opts.instrumental) p.instrumental = true;
    if (opts.lyricsOptimizer) p['lyrics-optimizer'] = true;
    // Standard music params.
    if (opts.genre) p.genre = opts.genre;
    if (opts.mood) p.mood = opts.mood;
    if (opts.vocals) p.vocals = opts.vocals;
    if (opts.instruments) p.instruments = opts.instruments;
    if (opts.bpm !== undefined && opts.bpm !== '') p.bpm = opts.bpm;
    if (opts.key) p.key = opts.key;
    if (opts.tempo) p.tempo = opts.tempo;
    if (opts.structure) p.structure = opts.structure;
    if (opts.references && String(opts.references).trim()) p.references = String(opts.references).trim();
    if (opts.avoid && String(opts.avoid).trim()) p.avoid = String(opts.avoid).trim();
    if (opts.useCase) p['use-case'] = opts.useCase;
    if (opts.extra && String(opts.extra).trim()) p.extra = String(opts.extra).trim();
    if (opts.format) p.format = opts.format;
    if (opts.sampleRate) p['sample-rate'] = opts.sampleRate;
    if (opts.bitrate) p.bitrate = opts.bitrate;
    if (opts.aigcWatermark) p['aigc-watermark'] = true;
    if (opts.outputFormat && opts.outputFormat !== 'hex') p['output-format'] = opts.outputFormat;
    return p;
  }

  // isModelSupported(flag, model) → boolean.
  // Convenience wrapper around MODEL_SPECS.music.perRowOverrides for the
  // tab's model-change listener (disable/gray unsupported controls).
  function isModelSupported(flag, model) {
    const specs = window.MODEL_SPECS || (window.ModelSpecs && window.ModelSpecs.MODEL_SPECS);
    if (!specs || !specs.music || !specs.music.perRowOverrides) return true;
    const ov = specs.music.perRowOverrides[flag];
    if (!ov || !ov.supportedForModels) return true;
    return ov.supportedForModels.has(model);
  }

  // syncRowDisable(model, rows) — disable/enable ParamRow controls based
  // on model support. Called by the music tab's model-change listener.
  // `rows` is a map: { '--instrumental': rowObj, '--lyrics-optimizer': rowObj }.
  function syncRowDisable(model, rows) {
    for (const flag of Object.keys(rows)) {
      const row = rows[flag];
      if (!row || !row.row) continue;
      const supported = isModelSupported(flag, model);
      const inputs = row.row.querySelectorAll('input, select, textarea, button');
      for (const el of inputs) { el.disabled = !supported; }
      row.row.style.opacity = supported ? '' : '0.45';
      row.row.title = supported ? '' : (flag + ' is not supported on ' + model);
    }
  }

  window.MusicOptions = { collect, isModelSupported, syncRowDisable };
})();
