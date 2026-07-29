// renderer/tabs/argvBuilders.js
// H11-3: pure argv builders for the four generation modalities.
//
// Each builder takes a parsed-row params object (bare kebab-case keys, e.g.
// { prompt: '...', 'aspect-ratio': '16:9', ... }) and a
// context { outputDir, filePrefix, filePrefixForceOnly, styles, slugify,
// uniquePath, nextFreeForcePrefixPath, timestamp } and returns
// { args: string[], outFile: string|null }.
//
// These are PURE — they never touch the DOM. The batch runner calls them +
// window.api.mmxRunJob({ args }) directly, eliminating the "mutate DOM → click
// Generate → restore" loop that caused the inheritance bug (same import file
// giving different results depending on what's open in the UI).
//
// The live-UI Generate handlers still read the DOM directly (their own path);
// these builders are the batch/snapshot path. Comprehensive unit tests
// (tests/unit/renderer/argvBuilders.test.js) keep the two from drifting.

(function () {
  'use strict';

  // --- shared helpers (mirror renderer/utils/tinyUtils.js semantics) ---
  // appendFlag: push `--flag value` when value is truthy and not 'off'.
  function appendFlag(args, flag, val) {
    if (val === null || val === undefined || val === '' || val === 'off') return;
    args.push('--' + flag, String(val));
  }
  // appendBoolFlag: push `--flag` (no value) when val is 'on'/'true'/true.
  function appendBoolFlag(args, flag, val) {
    if (val === 'on' || val === true || val === 'true') args.push('--' + flag);
  }

  // Resolve the style value: look up `styleName` in `ctx.styles` (an array of
  // { name, value }). Returns the value text, or '' if not found / no style.
  function resolveStyle(styleName, ctx) {
    if (!styleName) return '';
    const styles = (ctx && ctx.styles) || [];
    const found = styles.find((s) => s && s.name === styleName);
    return found ? (found.value || '').trim() : '';
  }

  // Compose the final prompt: [styleText, prompt].filter(Boolean).join(', ')
  function composePrompt(params, ctx) {
    const prompt = params.prompt || params.text || '';
    const styleText = resolveStyle(params.style, ctx);
    return [styleText, prompt].filter(Boolean).join(', ');
  }

  // Compute the output file path for one variant. Returns a string path.
  async function computeOutFile(ctx, opts) {
    const { ext, slug, variantTag, altExts } = opts;
    const prefix = (ctx.filePrefix || '').trim();
    const ts = ctx.timestamp();
    if (ctx.filePrefixForceOnly) {
      return ctx.nextFreeForcePrefixPath(ctx.outputDir, ctx.forceCounter, prefix, ext, altExts);
    }
    return ctx.uniquePath(ctx.outputDir, `${prefix}${ts}_${slug}${variantTag}.${ext}`);
  }

  // ---- IMAGE ----
  // params keys (bare): aspect-ratio, width, height, n, seed,
  // prompt-optimizer, aigc-watermark, subject-ref, response-format.
  async function buildImageArgs(params, ctx) {
    const promptText = composePrompt(params, ctx);
    const slug = (ctx.slugify(promptText).slice(0, 60)) || 'image';
    // Variant expansion has exactly one owner: the batch loop (which reads
    // item.variants and calls runVariantDirect once per variant). The
    // builder must only honor an explicit API --n, never re-read `variants`
    // — otherwise variants=4 became 4 loop iterations x --n 4 = 16 outputs.
    const nRaw = params.n || '1';
    const nCount = (nRaw === '' || nRaw === null || nRaw === undefined) ? 1 : Math.max(1, parseInt(nRaw, 10) || 1);
    const variantsCount = nCount;
    const useOutDir = nCount > 1;
    const outDir = ctx.outputDir;

    const args = ['image', 'generate'];
    args.push('--prompt', promptText);
    // image generate has no --model flag in mmx-cli. Ignore a legacy batch
    // row's model field rather than forwarding an unsupported argument.
    appendFlag(args, 'aspect-ratio', params['aspect-ratio']);
    appendFlag(args, 'n', params.n);
    const w = params.width, h = params.height;
    if (w && h) { args.push('--width', String(w)); args.push('--height', String(h)); }
    if (params.seed !== undefined && params.seed !== '' && params.seed !== null) args.push('--seed', String(params.seed));
    appendBoolFlag(args, 'prompt-optimizer', params['prompt-optimizer']);
    appendBoolFlag(args, 'aigc-watermark', params['aigc-watermark']);
    const subjRef = (params['subject-ref'] || '').toString().trim();
    if (subjRef) args.push('--subject-ref', `type=character,image=${subjRef}`);
    appendFlag(args, 'response-format', params['response-format']);
    if (useOutDir) args.push('--out-dir', outDir);

    // Output file (single-file path only; n>1 uses --out-dir)
    let outFile = null;
    if (!useOutDir) {
      const variantTag = variantsCount > 1 ? '_v1' : ''; // caller loops for variants
      outFile = await computeOutFile(ctx, { ext: 'png', slug, variantTag, altExts: ['jpg', 'jpeg', 'webp', 'gif', 'bmp'] });
      args.push('--out', outFile);
    }
    // X3-03: when n>1 the images go to --out-dir with mmx-chosen names, so
    // outFile is null. Expose the dir so the runner can scan it for the new
    // files (otherwise postprocess + pipeline-enqueue get nothing).
    return { args, outFile, outDir: useOutDir ? outDir : null, promptText };
  }

  // ---- SPEECH ----
  async function buildSpeechArgs(params, ctx) {
    const txt = params.prompt || params.text || '';
    const composedText = composePrompt(params, ctx);
    const slug = (ctx.slugify(txt).slice(0, 60)) || 'speech';
    const fmt = (params.format || 'mp3').toString().split('_')[0];
    const ext = fmt;
    const lossyFormat = ['mp3', 'opus'].includes(fmt);

    const args = ['speech', 'synthesize'];
    args.push('--text', composedText);
    appendFlag(args, 'model', params.model);
    appendFlag(args, 'voice', params.voice);
    appendFlag(args, 'speed', params.speed);
    appendFlag(args, 'volume', params.volume);
    appendFlag(args, 'pitch', params.pitch);
    appendFlag(args, 'format', params.format);
    appendFlag(args, 'sample-rate', params['sample-rate']);
    if (lossyFormat) appendFlag(args, 'bitrate', params.bitrate);
    appendFlag(args, 'channels', params.channels);
    if (params.language) args.push('--language', String(params.language));
    appendBoolFlag(args, 'subtitles', params.subtitles);
    const pron = (params.pronunciation || '').toString().trim();
    if (pron) {
      for (const rule of pron.split(',').map((s) => s.trim()).filter(Boolean)) {
        args.push('--pronunciation', rule);
      }
    }

    const variantTag = '';
    const outFile = await computeOutFile(ctx, { ext, slug, variantTag });
    args.push('--out', outFile);
    return { args, outFile, promptText: composedText };
  }

  // ---- MUSIC ----
  async function buildMusicArgs(params, ctx) {
    const promptText = composePrompt(params, ctx);
    const slug = (ctx.slugify(promptText).slice(0, 60)) || 'music';
    const ext = (params['audio-format'] || params.format || 'mp3').toString();
    const fmt = ext.split('_')[0];

    const args = ['music', 'generate'];
    args.push('--prompt', promptText);
    appendFlag(args, 'model', params.model);
    // X3-02: the registry/manual document --lyrics / --instrumental /
    // --lyrics-optimizer as the core music features, but this builder used to
    // drop them silently, so an imported `--instrumental true` produced a
    // normal vocal track. Emit them (the installed mmx music command accepts
    // them). --lyrics is a text value; the other two are booleans.
    if (params.lyrics != null && String(params.lyrics).trim() !== '') {
      args.push('--lyrics', String(params.lyrics));
    }
    appendBoolFlag(args, 'instrumental', params.instrumental);
    appendBoolFlag(args, 'lyrics-optimizer', params['lyrics-optimizer']);
    appendFlag(args, 'genre', params.genre);
    appendFlag(args, 'mood', params.mood);
    appendFlag(args, 'vocals', params.vocals);
    appendFlag(args, 'instruments', params.instruments);
    if (params.bpm !== undefined && params.bpm !== '') args.push('--bpm', String(params.bpm));
    appendFlag(args, 'key', params.key);
    appendFlag(args, 'tempo', params.tempo);
    appendFlag(args, 'structure', params.structure);
    const refs = (params.references || '').toString().trim();
    if (refs) args.push('--references', refs);
    const avoid = (params.avoid || '').toString().trim();
    if (avoid) args.push('--avoid', avoid);
    appendFlag(args, 'use-case', params['use-case']);
    const extra = (params.extra || '').toString().trim();
    if (extra) args.push('--extra', extra);
    // The mmx music command's output-format flag is `--format` (mp3|wav|pcm) —
    // NOT `--audio-format`, which mmx does not recognize and silently ignores.
    // Emitting the wrong name made batch music always fall back to mp3 while
    // the output FILE still took the requested (.wav/.pcm) extension — an mp3
    // payload in a mis-named container. The interactive musicTab already uses
    // `--format`; match it. We still read either row-key as the VALUE. (X1-F8)
    appendFlag(args, 'format', params['audio-format'] || params.format);
    appendFlag(args, 'sample-rate', params['sample-rate']);
    if (['mp3'].includes(fmt)) appendFlag(args, 'bitrate', params.bitrate);
    appendBoolFlag(args, 'aigc-watermark', params['aigc-watermark']);
    if (params['output-format'] && params['output-format'] !== 'hex') {
      args.push('--output-format', params['output-format']);
    }

    const variantTag = '';
    const outFile = await computeOutFile(ctx, { ext, slug, variantTag });
    args.push('--out', outFile);
    return { args, outFile, promptText };
  }

  // ---- VIDEO ----
  async function buildVideoArgs(params, ctx) {
    const promptText = composePrompt(params, ctx);
    const slug = (ctx.slugify(promptText).slice(0, 60)) || 'video';

    const args = ['video', 'generate'];
    args.push('--prompt', promptText);
    appendFlag(args, 'model', params.model);
    const ff = (params['first-frame'] || '').toString().trim();
    if (ff) args.push('--first-frame', ff);
    const lf = (params['last-frame'] || '').toString().trim();
    if (lf) args.push('--last-frame', lf);
    const si = (params['subject-image'] || '').toString().trim();
    if (si) args.push('--subject-image', si);

    const variantTag = '';
    const outFile = await computeOutFile(ctx, { ext: 'mp4', slug, variantTag });
    // BGR-001/003 fix: push --download BEFORE duration/resolution/prompt-optimizer/
    // fast-pretreatment. mmx-cli 1.0.16 doesn't declare those flags for
    // `video generate`; an unknown boolean flag swallows the next token,
    // which was --download, causing the output path to be lost.
    // Video uses --download (NOT --out) for its output path.
    args.push('--download', outFile);
    const isSupported = (f) => !(window.CapabilityGuard && typeof window.CapabilityGuard.isFlagSupported === 'function') || window.CapabilityGuard.isFlagSupported('video', f);
    if (isSupported('--duration')) appendFlag(args, 'duration', params.duration);
    if (isSupported('--resolution')) appendFlag(args, 'resolution', params.resolution);
    if (isSupported('--prompt-optimizer')) appendBoolFlag(args, 'prompt-optimizer', params['prompt-optimizer']);
    if (isSupported('--fast-pretreatment')) appendBoolFlag(args, 'fast-pretreatment', params['fast-pretreatment']);
    appendFlag(args, 'poll-interval', params['poll-interval']);
    return { args, outFile, promptText };
  }

  // Dispatcher: buildArgs('image', params, ctx) → buildImageArgs(params, ctx)
  async function buildArgs(tabKey, params, ctx) {
    switch (tabKey) {
      case 'image': return buildImageArgs(params, ctx);
      case 'speech': return buildSpeechArgs(params, ctx);
      case 'music': return buildMusicArgs(params, ctx);
      case 'video': return buildVideoArgs(params, ctx);
      default: throw new Error('Unknown tab: ' + tabKey);
    }
  }

  window.ArgvBuilders = { buildArgs, buildImageArgs, buildSpeechArgs, buildMusicArgs, buildVideoArgs };
})();
