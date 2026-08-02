// tests/unit/renderer/modelSpecs.test.js
// Tests for the authoritative parameter validator (validateValues) that
// gates both live generation and BatchGen imports. Values are the exact
// MiniMax-accepted sets (see renderer/specs/modelSpecs.js header).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// modelSpecs.js is a classic browser script: it attaches its API to
// `window`. Shim a global window, then load it.
global.window = global.window || {};
require(path.join(__dirname, '..', '..', '..', 'renderer', 'specs', 'modelSpecs.js'));
const { validateValues, validateToolCombos } = global.window.ModelSpecs;

const errsOf = (tab, vals, opts) => validateValues(tab, vals, opts).errors;
const ok = (tab, vals, opts) => assert.deepStrictEqual(errsOf(tab, vals, opts), [], `expected no errors for ${JSON.stringify(vals)}`);
const bad = (tab, vals, re, opts) => {
  const e = errsOf(tab, vals, opts);
  assert.ok(e.length > 0, `expected an error for ${JSON.stringify(vals)}`);
  if (re) assert.ok(e.some((x) => re.test(x)), `expected an error matching ${re}; got ${JSON.stringify(e)}`);
};

test('speech: accepts a valid configuration', () => {
  ok('speech', { model: 'speech-2.8-hd', format: 'mp3', 'sample-rate': 32000, bitrate: 128000, channels: 1, speed: 1, volume: 1, pitch: 0, text: 'hi' });
});
test('speech: rejects sample-rate 48000', () => bad('speech', { 'sample-rate': 48000 }, /sample-rate/));
test('speech: rejects volume 0 (must be > 0)', () => bad('speech', { volume: 0 }, /volume/));
test('speech: accepts volume 10, rejects 11', () => { ok('speech', { volume: 10 }); bad('speech', { volume: 11 }, /volume/); });
test('speech: rejects bitrate 192000 for mp3 but ignores it for wav', () => {
  bad('speech', { format: 'mp3', bitrate: 192000 }, /bitrate/);
  ok('speech', { format: 'wav', bitrate: 192000 });
});
test('speech: rejects an unknown model', () => bad('speech', { model: 'speech-9000' }, /model/));
test('speech: accepts speech-01-hd', () => ok('speech', { model: 'speech-01-hd' }));

test('music: accepts a valid configuration', () => {
  ok('music', { model: 'music-2.6', format: 'mp3', 'sample-rate': 44100, bitrate: 256000, lyrics: 'la la' });
});
test('music: rejects sample-rate 22050 and 48000', () => { bad('music', { 'sample-rate': 22050 }); bad('music', { 'sample-rate': 48000 }); });
test('music: rejects bitrate 192000', () => bad('music', { bitrate: 192000 }, /bitrate/));
test('music: instrumental + lyrics is a conflict', () => bad('music', { instrumental: true, lyrics: 'words' }, /instrumental/i));
test('music: lyrics-optimizer + lyrics is a conflict', () => bad('music', { 'lyrics-optimizer': true, lyrics: 'words' }, /auto-lyrics/i));
test('music: lyrics-optimizer requires music-2.6', () => bad('music', { 'lyrics-optimizer': true, model: 'music-2.5+' }, /2\.6/));
test('music: missing lyrics is an error in strict mode but OK in partial', () => {
  bad('music', { model: 'music-2.6' }, /lyrics/i);
  ok('music', { model: 'music-2.6' }, { partial: true });
});
test('music: rejects the removed music-2.0 model', () => bad('music', { model: 'music-2.0' }, /model/));

test('image: accepts a valid configuration', () => {
  ok('image', { 'aspect-ratio': '16:9', n: 2, prompt: 'a cat' });
});
test('image: rejects an unknown aspect ratio', () => bad('image', { 'aspect-ratio': '5:4' }, /aspect/));
test('image: width without height is an error', () => bad('image', { width: 1024 }, /together/i));
test('image: width+height not divisible by 8', () => bad('image', { width: 1000, height: 1001 }, /multiple of 8/));
test('image: custom size is accepted', () => ok('image', { width: 1024, height: 1024 }));
test('image: n out of range', () => { bad('image', { n: 10 }, /n /); ok('image', { n: 9 }); });

test('video: Fast model requires a first frame', () => {
  bad('video', { model: 'MiniMax-Hailuo-2.3-Fast', prompt: 'x' }, /first-frame/);
  ok('video', { model: 'MiniMax-Hailuo-2.3-Fast', prompt: 'x', 'first-frame': 'a.png' });
});
test('video: last-frame requires first-frame', () => bad('video', { model: 'MiniMax-Hailuo-02', 'last-frame': 'b.png' }, /first-frame/));
test('video: rejects an unknown model', () => bad('video', { model: 'Hailuo-9' }, /model/));
test('video: S2V-01 requires a subject image', () => {
  bad('video', { model: 'S2V-01', prompt: 'x' }, /subject/i);
  ok('video', { model: 'S2V-01', prompt: 'x', 'subject-image': 'face.png' });
});
test('video: default T2V model needs no images', () => ok('video', { model: 'MiniMax-Hailuo-2.3', prompt: 'a cat walking' }));

test('unknown keys and missing optional values do not error', () => {
  ok('speech', { text: 'hi', somethingUnknown: 'x' });
  ok('image', { prompt: 'a cat' });
});

// ---------------------------------------------------------------------------
// validateToolCombos — BUG-9-08 (reported 2026-06-25). The MiniMax API
// itself accepts any --n (1-9) × Variants (1-5) combination, but the GUI
// must warn because each variant is a separate mmx call and rapid back-
// to-back calls can trigger rate limits (the user hit this exactly: --n=2
// + Variants=2 → 2nd variant got a silent "mmx exited with code -1").
// ---------------------------------------------------------------------------
const toolErrsOf = (tab, vals, ctx) => validateToolCombos(tab, vals, ctx).errors;
const toolOk = (tab, vals, ctx) => assert.deepStrictEqual(toolErrsOf(tab, vals, ctx), [], `expected no tool-combo errors for ${JSON.stringify({ vals, ctx })}`);
const toolBad = (tab, vals, re, ctx) => {
  const e = toolErrsOf(tab, vals, ctx);
  assert.ok(e.length > 0, `expected a tool-combo error for ${JSON.stringify({ vals, ctx })}`);
  if (re) assert.ok(e.some((x) => re.test(x)), `expected an error matching ${re}; got ${JSON.stringify(e)}`);
};

test('tool-combo: image with --n=1 + Variants=1 is fine', () => {
  toolOk('image', { n: 1 }, { variantsCount: 1 });
  toolOk('image', {}, { variantsCount: 1 });
});
test('tool-combo: image with --n=2 + Variants=2 warns (user-reported case)', () => {
  toolBad('image', { n: 2 }, /--n=2.*Variants=2/i, { variantsCount: 2 });
});
test('tool-combo: image with --n=4 + Variants=3 warns + warns total>9', () => {
  const e = toolErrsOf('image', { n: 4 }, { variantsCount: 3 });
  // Should warn about combo AND total exceeding per-call max
  assert.ok(e.some((x) => /--n=4.*Variants=3/i.test(x)), `expected combo warning; got ${JSON.stringify(e)}`);
  assert.ok(e.some((x) => /exceeds the API/i.test(x)), `expected total warning; got ${JSON.stringify(e)}`);
});
test('tool-combo: image with --n=2 + Variants=1 is fine (only --n is active)', () => {
  toolOk('image', { n: 2 }, { variantsCount: 1 });
});
test('tool-combo: image with --n=1 + Variants=3 is fine (only Variants is active)', () => {
  toolOk('image', { n: 1 }, { variantsCount: 3 });
});
test('tool-combo: image without toolCtx defaults variantsCount to 1', () => {
  toolOk('image', { n: 1 });
  toolOk('image', { n: 2 });
});
test('tool-combo: speech with Variants>3 warns', () => {
  toolBad('speech', {}, /Variants is set to 4/i, { variantsCount: 4 });
  toolOk('speech', {}, { variantsCount: 3 });
});
test('tool-combo: music with Variants>3 warns', () => {
  toolBad('music', {}, /Variants is set to 5/i, { variantsCount: 5 });
});
test('tool-combo: video with Variants>3 warns', () => {
  toolBad('video', {}, /Variants is set to 5/i, { variantsCount: 5 });
});
test('tool-combo: unknown tab returns no errors', () => {
  toolOk('unknown-tab', { n: 99 }, { variantsCount: 99 });
});

// ---------------- H7-020: video resolution registry ----------------
// Each model only supports a subset of resolutions. validateValues must accept
// the supported combos and reject the unsupported ones with a clear message.
const { VIDEO_RESOLUTIONS_BY_MODEL, resolutionsForVideoModel } = global.window.ModelSpecs;

test('H7-020: VIDEO_RESOLUTIONS_BY_MODEL covers all video models', () => {
  for (const m of ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-02', 'S2V-01']) {
    assert.ok(Array.isArray(VIDEO_RESOLUTIONS_BY_MODEL[m]) && VIDEO_RESOLUTIONS_BY_MODEL[m].length, `missing resolution list for ${m}`);
    assert.ok(VIDEO_RESOLUTIONS_BY_MODEL[m].includes('768P'), `every model must at least support 768P (${m})`);
  }
});

test('H7-020: validateValues accepts each model × its allowed resolutions', () => {
  for (const [model, resolutions] of Object.entries(VIDEO_RESOLUTIONS_BY_MODEL)) {
    for (const r of resolutions) {
      // 1080P × 10s is a separate constraint (duration check); use 6s here.
      // Hailuo-2.3-Fast requires a first-frame image (separate rule); supply one.
      // S2V-01 requires a subject-image (separate rule); supply one.
      const vals = { model, resolution: r, duration: 6 };
      if (model === 'MiniMax-Hailuo-2.3-Fast') vals['first-frame'] = 'a.png';
      if (model === 'S2V-01') vals['subject-image'] = 's.png';
      ok('video', vals);
    }
  }
});

test('H7-020: validateValues rejects S2V-01 + 1080P', () => {
  bad('video', { model: 'S2V-01', resolution: '1080P', duration: 6 }, /not supported by S2V-01/);
});

test('H7-020: validateValues rejects Hailuo-2.3-Fast + 512P', () => {
  bad('video', { model: 'MiniMax-Hailuo-2.3-Fast', resolution: '512P', duration: 6 }, /not supported by MiniMax-Hailuo-2.3-Fast/);
});

// H-003 (_5 audit): FL2V mode (first+last frame) does NOT support 512P.
// The old H7-020 test expected 512P to pass; the audit explicitly
// requires it to be blocked.
test('H-003: validateValues rejects Hailuo-02 + 512P in FL2V mode (first+last frame)', () => {
  const { errors } = validateValues('video', { model: 'MiniMax-Hailuo-02', resolution: '512P', duration: 6, 'first-frame': 'a.png', 'last-frame': 'b.png' });
  assert.ok(errors.length > 0, 'FL2V + 512P must be rejected');
  assert.ok(errors.some((e) => /512P/.test(e) && /FL2V|first\+last/i.test(e)), 'error must mention 512P and FL2V');
});

test('H-003: validateValues accepts Hailuo-02 + 512P in I2V mode (first frame only)', () => {
  ok('video', { model: 'MiniMax-Hailuo-02', resolution: '512P', duration: 6, 'first-frame': 'a.png' });
});

test('H7-020: resolutionsForVideoModel returns 768P for an unknown model', () => {
  assert.deepEqual(resolutionsForVideoModel('Unknown-Model'), ['768P']);
});
