// main/services/importCapabilityRegistry.js
// Structured capability registry for the import/batch system (H9-001 / H9-002).
//
// WHY THIS EXISTS (H9-001): the previous manual generator scraped inline `//`
// comments out of renderer/specs/modelSpecs.js to populate per-flag
// descriptions. The scraper treated ANY lowercase object key (`type: {`) as a
// currentType switch, and because nested `prompt:` / `lyrics:` objects appear
// BEFORE supportedFlags, currentType was clobbered to `prompt`/`lyrics` — so
// almost every flag description rendered blank. A SOTA model cannot choose
// settings from a document whose descriptions are empty.
//
// WHAT THIS IS: one structured, validated table. Each entry carries the flag,
// a human description, the allowed values / range, the default, and — crucially
// for H9-002 — the alias(es) the live executor / importer accepts, so the
// document, the validator, and the executor agree on a single vocabulary. The
// manual generator renders from this data; validateValues still owns the
// hard API contract.
//
// This is intentionally a Node (main-process) module so generateManual (also
// main) can require it without a DOM. The renderer keeps its own
// modelSpecs.js for the live UI; the two are kept in step by tests.

'use strict';

// Each entry: { flag, desc, allowed?, default?, note?, aliasOf? }
//   aliasOf: when set, this flag is an ACCEPTED ALIAS for another flag (H9-002).
//   The importer resolves aliases to their canonical name before execution.
const CAPABILITIES = {
  image: {
    promptMax: 1500,
    flags: [
      { flag: '--aspect-ratio', desc: 'Output aspect ratio. Overrides width/height when set. 21:9 is image-01 only.', allowed: ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2', '21:9'], default: '1:1' },
      { flag: '--width', desc: 'Custom width (image-01 only). 512–2048, multiple of 8. Must pair with --height; overrides aspect-ratio.', allowed: '512–2048, step 8' },
      { flag: '--height', desc: 'Custom height (image-01 only). 512–2048, multiple of 8. Must pair with --width.', allowed: '512–2048, step 8' },
      { flag: '--n', desc: 'Number of images to generate per call (1–9). Combines with --variants; see the multiplication note.', allowed: '1–9', default: '1' },
      { flag: '--seed', desc: 'Deterministic seed (0 .. 2^31-1). Fixed seed + --variants is rejected (variants re-roll).', allowed: 'integer 0..2147483647' },
      { flag: '--prompt-optimizer', desc: 'Boolean. Let the model refine the prompt before generating.', allowed: ['true', 'false'], default: 'false' },
      { flag: '--aigc-watermark', desc: 'Boolean. Add the platform AIGC watermark.', allowed: ['true', 'false'], default: 'false' },
      { flag: '--subject-reference-file', desc: 'Path to a subject-reference image (image-01 + image-01-live).', aliasOf: '--subject-ref', note: 'The live executor flag is --subject-ref; --subject-reference-file is accepted as an alias.' },
      { flag: '--subject-ref', desc: 'Canonical executor flag for a subject-reference image path. Use this in imports for guaranteed execution.', aliasOf: '--subject-reference-file' },
      { flag: '--subject-reference-type', desc: 'Subject-reference type. Only "character" is supported.', allowed: ['character'] },
      { flag: '--response-format', desc: 'Provider response delivery. "url" (default) or "base64". Does not change the final saved file format.', allowed: ['url', 'base64'], default: 'url' },
      { flag: '--variants', desc: 'Re-runs the generator N times for one prompt (1–5). Note: --n × --variants multiplies the image AND call count.', allowed: '1–5', default: '1' },
      { flag: '--upscale', desc: 'Boolean. Run the bundled Real-ESRGAN 2×/3×/4× upscaler after generation.', allowed: ['true', 'false'], default: 'false' },
      { flag: '--upscale-multiplier', desc: 'Upscale factor when --upscale is true.', allowed: ['2', '3', '4'], default: '2' },
      { flag: '--upscale-model', desc: 'Real-ESRGAN model.', allowed: ['real-esrgan-x4plus', 'real-esrgan-anime-v3', 'canvas-fallback'], default: 'real-esrgan-x4plus' },
      { flag: '--remove-background', desc: 'Boolean. Remove the background to transparency (local IS-Net/BiRefNet, no upload) after generation.', allowed: ['true', 'false'], default: 'false' },
      { flag: '--remove-background-model', desc: 'Background-removal model. BiRefNet Lite gives cleaner edges (~3–8× slower on CPU).', allowed: ['isnet-general-use', 'birefnet-general-lite', 'birefnet-general', 'birefnet-portrait'], default: 'isnet-general-use' },
      { flag: '--crop', desc: 'Crop to an exact WxH rectangle after generation. Format: WxH (e.g. 512x512).', allowed: 'WxH' },
      { flag: '--resize', desc: 'Free resize after generation. Format: WxH (keeps aspect by default).', allowed: 'WxH' },
      { flag: '--optimize-format', desc: 'Re-encode the final image. "keep" preserves the source format.', allowed: ['keep', 'png', 'jpeg', 'webp', 'avif'], default: 'keep' },
      { flag: '--optimize-quality', desc: 'Quality for lossy formats (jpeg/webp/avif).', allowed: '1–100', default: '82' },
      // H9-005: postprocess flags now actually execute via the batch postprocess runner.
      { flag: '--crop', desc: 'Crop to an exact WxH rectangle after generation (batch postprocess). Format: WxH (e.g. 512x512).', allowed: 'WxH' },
      { flag: '--resize', desc: 'Free resize after generation (batch postprocess). Format: WxH.', allowed: 'WxH' },
      { flag: '--strip-metadata', desc: 'Boolean. Strip EXIF/metadata during optimize.', allowed: ['true', 'false'], default: 'true' },
      // H9-013: per-row output naming.
      { flag: '--output-name', desc: 'File-name prefix applied to this row\'s generated files only (overrides the global prefix for this item).', allowed: 'safe filename text' },
    ],
  },
  speech: {
    promptMax: 10000,
    flags: [
      { flag: '--model', desc: 'Speech model. 2.8-hd/turbo are newest; emotion control needs 2.6+.', allowed: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo'], default: 'speech-2.8-hd' },
      { flag: '--voice', desc: 'Voice id from `mmx speech voices` (voice list is model-dependent).', allowed: 'voice id' },
      { flag: '--speed', desc: 'Speech rate.', allowed: '0.5–2.0', default: '1.0' },
      { flag: '--volume', desc: 'Gain.', allowed: '0–10 (exclusiveMin 0)', default: '0' },
      { flag: '--pitch', desc: 'Pitch in semitones.', allowed: '-12..+12', default: '0' },
      { flag: '--format', desc: 'Audio container.', allowed: ['mp3', 'wav', 'pcm', 'flac', 'opus', 'pcmu_raw', 'pcmu_wav'], default: 'mp3' },
      { flag: '--sample-rate', desc: 'Sample rate (Hz).', allowed: [8000, 16000, 22050, 24000, 32000, 44100], default: '32000' },
      { flag: '--bitrate', desc: 'Bitrate. Only affects mp3/opus (wav/pcm/flac are lossless).', allowed: [32000, 64000, 128000, 256000], default: '128000' },
      { flag: '--channels', desc: '1 = mono, 2 = stereo.', allowed: [1, 2], default: '1' },
      { flag: '--language', desc: '2-letter code or "auto" (voice-dependent).', allowed: 'ISO 639-1 or "auto"' },
      { flag: '--subtitles', desc: 'Boolean. Saves a .srt alongside the audio.', allowed: ['true', 'false'], default: 'false' },
      { flag: '--pronunciation', desc: 'Custom pronunciation map (from=to list).', allowed: 'from=to,...' },
      // NOTE: --emotion is documented in MODEL_SPECS but the installed mmx CLI
      // exposes no live control/argv for it, so it is a silent no-op. We do NOT
      // document it here until a real consumer exists (H9-002): documenting a
      // setting the executor ignores can spend a request for nothing.
      { flag: '--variants', desc: 'Re-runs the generator N times for one prompt (1–5).', allowed: '1–5', default: '1' },
      // H9-018: deterministic audio trim as a batch post-step.
      { flag: '--trim-start', desc: 'Trim the generated audio to start at this second (batch postprocess). Pairs with --trim-end.', allowed: 'seconds (float)' },
      { flag: '--trim-end', desc: 'Trim the generated audio to end at this second (batch postprocess). Pairs with --trim-start.', allowed: 'seconds (float)' },
      // H9-013: per-row output naming.
      { flag: '--output-name', desc: 'File-name prefix applied to this row\'s generated files only.', allowed: 'safe filename text' },
    ],
  },
  music: {
    promptMax: 2000,
    lyricsMax: 3500,
    flags: [
      { flag: '--model', desc: 'Music model. 2.6 supports the full feature set (instrumental, lyrics, auto-lyrics).', allowed: ['music-2.6', 'music-2.5+', 'music-2.5'], default: 'music-2.6' },
      { flag: '--lyrics', desc: 'Song lyrics with structure tags ([Verse], [Chorus], …). Max 3500 chars. Required unless --instrumental or --lyrics-optimizer is set.', allowed: 'text ≤ 3500 chars' },
      { flag: '--instrumental', desc: 'Boolean. Generate an instrumental track (no vocals). music-2.5+ / 2.6 only. Cannot combine with --lyrics.', allowed: ['true', 'false'], default: 'false' },
      { flag: '--lyrics-optimizer', desc: 'Boolean. Auto-generate lyrics (music-2.6 only). Cannot combine with --lyrics or --instrumental.', allowed: ['true', 'false'], default: 'false' },
      { flag: '--format', desc: 'Audio container.', allowed: ['mp3', 'wav', 'pcm'], default: 'mp3' },
      { flag: '--sample-rate', desc: 'Sample rate (Hz).', allowed: [16000, 24000, 32000, 44100], default: '44100' },
      { flag: '--bitrate', desc: 'Bitrate.', allowed: [32000, 64000, 128000, 256000], default: '256000' },
      // H9 Phase 6: the music descriptor flags below ARE emitted by the batch
      // argv builder (argvBuilders.js) and accepted by the installed mmx music
      // command. They were previously undocumented here, which violated the
      // H9-002 rule ("every supported executor control must appear in the same
      // registry"). They are now first-class registry entries.
      { flag: '--genre', desc: 'Music genre hint (e.g. "rock", "jazz", "electronic"). Free-form text.', allowed: 'text' },
      { flag: '--mood', desc: 'Mood/atmosphere hint (e.g. "upbeat", "melancholic").', allowed: 'text' },
      { flag: '--vocals', desc: 'Vocal style hint (e.g. "male", "female", "choir").', allowed: 'text' },
      { flag: '--instruments', desc: 'Instrument hints (e.g. "piano, strings, drums").', allowed: 'text' },
      { flag: '--bpm', desc: 'Tempo in beats per minute.', allowed: 'positive integer' },
      { flag: '--key', desc: 'Musical key (e.g. "C major", "A minor").', allowed: 'text' },
      { flag: '--tempo', desc: 'Tempo descriptor (e.g. "allegro", "adagio").', allowed: 'text' },
      { flag: '--structure', desc: 'Song structure hint (e.g. "intro-verse-chorus-verse-chorus-outro").', allowed: 'text' },
      { flag: '--references', desc: 'Reference tracks/artists for style guidance.', allowed: 'text' },
      { flag: '--avoid', desc: 'Elements to avoid in the generation.', allowed: 'text' },
      { flag: '--use-case', desc: 'Intended use case (e.g. "background-music", "jingle").', allowed: 'text' },
      { flag: '--extra', desc: 'Additional free-form instructions.', allowed: 'text' },
      { flag: '--output-format', desc: 'Provider output format. "url" (default) or "hex".', allowed: ['url', 'hex'], default: 'url' },
      { flag: '--aigc-watermark', desc: 'Boolean. Add the platform AIGC watermark.', allowed: ['true', 'false'], default: 'false' },
      { flag: '--variants', desc: 'Re-runs the generator N times for one prompt (1–5).', allowed: '1–5', default: '1' },
      // H9-018: deterministic audio trim as a batch post-step.
      { flag: '--trim-start', desc: 'Trim the generated audio to start at this second (batch postprocess).', allowed: 'seconds (float)' },
      { flag: '--trim-end', desc: 'Trim the generated audio to end at this second (batch postprocess).', allowed: 'seconds (float)' },
      // H9-013: per-row output naming.
      { flag: '--output-name', desc: 'File-name prefix applied to this row\'s generated files only.', allowed: 'safe filename text' },
    ],
  },
  video: {
    promptMax: 2000,
    flags: [
      { flag: '--model', desc: 'Video model. Hailuo-2.3-Fast and S2V-01 have narrower resolution/first-frame support.', allowed: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-02', 'S2V-01'], default: 'MiniMax-Hailuo-2.3' },
      { flag: '--first-frame-image', desc: 'First-frame reference image path. Hailuo-2.3-Fast and Hailuo-02 require it.', aliasOf: '--first-frame', note: 'The live executor flag is --first-frame; --first-frame-image is accepted as an alias.' },
      { flag: '--first-frame', desc: 'Canonical executor flag for the first-frame image path.', aliasOf: '--first-frame-image' },
      { flag: '--last-frame-image', desc: 'Last-frame reference image path (Hailuo-02 only). Also requires a first-frame image.', aliasOf: '--last-frame', note: 'The live executor flag is --last-frame; --last-frame-image is accepted as an alias.' },
      { flag: '--last-frame', desc: 'Canonical executor flag for the last-frame image path.', aliasOf: '--last-frame-image' },
      // --subject-image is the video executor's OWN canonical flag (S2V-01 reads
      // 'subject-image' and sends --subject-image). Do NOT alias it to
      // --subject-ref (that is the IMAGE flag); doing so would silently drop the
      // S2V-01 subject reference.
      { flag: '--subject-image', desc: 'Subject (face) reference image path or URL. REQUIRED for the S2V-01 model.', allowed: 'path or URL' },
      { flag: '--duration', desc: 'Clip length in seconds. 10s is only available at 768P.', allowed: ['6', '10'], default: '6' },
      { flag: '--resolution', desc: 'Output resolution. Per-model subsets apply (see model note).', allowed: ['512P', '768P', '1080P'], default: '768P' },
      { flag: '--prompt-optimizer', desc: 'Boolean. Let the model refine the prompt before generating.', allowed: ['true', 'false'], default: 'false' },
      { flag: '--fast-pretreatment', desc: 'Boolean. Faster first-frame preprocessing (Hailuo-2.3 +Fast / 02).', allowed: ['true', 'false'], default: 'false' },
      { flag: '--poll-interval', desc: 'Seconds between status polls while waiting for the video render.', allowed: 'positive integer', default: '5' },
      { flag: '--variants', desc: 'Re-runs the generator N times for one prompt (1–5).', allowed: '1–5', default: '1' },
      // H9-013: per-row output naming.
      { flag: '--output-name', desc: 'File-name prefix applied to this row\'s generated files only.', allowed: 'safe filename text' },
    ],
  },
};

// Build a flat lookup of every flag the importer should recognize (canonical +
// aliases). Used by the strict importer (H9-008) to reject unknown keys.
function knownFlagsByType() {
  const out = {};
  for (const [type, spec] of Object.entries(CAPABILITIES)) {
    const set = new Set();
    for (const f of spec.flags) {
      set.add(f.flag);
      // The flag without the leading dashes is also a recognized key.
      set.add(f.flag.replace(/^--/, ''));
    }
    // Cross-type keys every row may carry.
    set.add('--prompt'); set.add('prompt');
    set.add('--text'); set.add('text');
    set.add('--variants'); set.add('variants');
    out[type] = set;
  }
  return out;
}

// Resolve a possibly-aliased flag to its canonical name. Returns the input
// unchanged if no alias mapping exists.
function resolveAlias(type, flag) {
  const spec = CAPABILITIES[type];
  if (!spec) return flag;
  const norm = String(flag).replace(/^--+/, '');
  for (const f of spec.flags) {
    if (f.aliasOf && (f.flag === '--' + norm || f.flag === flag)) {
      return f.aliasOf;
    }
  }
  return flag;
}

// Validate that generateManual can load the registry. Throws on a malformed
// entry so a bad edit fails loudly (H9-019: never silently ship a broken doc).
function validate() {
  const errors = [];
  for (const [type, spec] of Object.entries(CAPABILITIES)) {
    if (!Array.isArray(spec.flags)) errors.push(`${type}.flags is not an array`);
    for (const f of spec.flags) {
      if (!f.flag || typeof f.flag !== 'string') errors.push(`${type}: entry missing flag`);
      if (!f.desc || typeof f.desc !== 'string' || f.desc.trim().length < 3) {
        errors.push(`${type} ${f.flag}: desc must be a non-empty string`);
      }
    }
  }
  if (errors.length) throw new Error('importCapabilityRegistry invalid: ' + errors.join('; '));
  return true;
}

module.exports = { CAPABILITIES, knownFlagsByType, resolveAlias, validate };
