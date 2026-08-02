// tests/unit/renderer/toolFlagValidation.h057h058.test.js
// H-057: accepted tool/postprocess flags (crop/resize/optimize-*/upscale-*/
// remove-background-model/trim-*) previously had NO import-time validator —
// a malformed value (crop:"huge") parsed to null at runtime and the op was
// SILENTLY skipped. validateValues must now flag them so the importer marks
// the row defective.
// H-058: the capability registry documented fictional Real-ESRGAN model
// names ('real-esrgan-x4plus', 'real-esrgan-anime-v3', 'canvas-fallback');
// the executor (src/realesrgan.js) silently falls back to x4plus for unknown
// names, so users got the WRONG network without a hint. The registry now
// carries the canonical executor ids, batchPostprocess normalizes legacy
// aliases and rejects unknown names loudly.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

global.window = global;
global.toast = () => {};
require(path.join(ROOT, 'renderer', 'specs', 'modelSpecs.js'));
require(path.join(ROOT, 'renderer', 'services', 'batchPostprocess.js'));
const { validateValues } = global.window.ModelSpecs;
const { runRowPostprocess } = global.window.BatchPostprocess;
const registry = require(path.join(ROOT, 'main', 'services', 'importCapabilityRegistry'));

const errsOf = (tab, vals, opts) => validateValues(tab, vals, opts).errors;
const ok = (tab, vals, opts) => assert.deepEqual(errsOf(tab, vals, opts), [], `expected no errors for ${JSON.stringify(vals)}`);
const bad = (tab, vals, re, opts) => {
  const e = errsOf(tab, vals, opts);
  assert.ok(e.length > 0, `expected an error for ${JSON.stringify(vals)}`);
  if (re) assert.ok(e.some((x) => re.test(x)), `expected an error matching ${re}; got ${JSON.stringify(e)}`);
};

// ---------------------------------------------------------------------------
// H-058 — registry ↔ executor model-name sync.
// ---------------------------------------------------------------------------

test('H-058: registry REALESRGAN_MODELS matches the executor allowlist in src/realesrgan.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'realesrgan.js'), 'utf8');
  const m = src.match(/REALESRGAN_MODELS\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'src/realesrgan.js must declare a REALESRGAN_MODELS array');
  const executorModels = m[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual([...registry.REALESRGAN_MODELS].sort(), [...executorModels].sort(),
    'registry model list must be exactly the executor model list');
});

test('H-058: the --upscale-model registry entry allows exactly the canonical models', () => {
  const entry = registry.CAPABILITIES.image.flags.find((f) => f.flag === '--upscale-model');
  assert.ok(entry, 'image capability must document --upscale-model');
  assert.deepEqual([...entry.allowed].sort(), [...registry.REALESRGAN_MODELS].sort());
  assert.ok(registry.REALESRGAN_MODELS.includes(entry.default), 'default must be a canonical model');
});

test('H-058: normalizeRealesrganModel maps legacy aliases to canonical executor ids', () => {
  assert.equal(registry.normalizeRealesrganModel('real-esrgan-x4plus'), 'realesrgan-x4plus');
  assert.equal(registry.normalizeRealesrganModel('real-esrgan-anime-v3'), 'realesr-animevideov3');
  assert.equal(registry.normalizeRealesrganModel('realesrgan-x4plus'), 'realesrgan-x4plus');
  assert.equal(registry.normalizeRealesrganModel(' realesr-animevideov3 '), 'realesr-animevideov3');
  // Unknown names pass through unchanged (rejected downstream, not mangled).
  assert.equal(registry.normalizeRealesrganModel('canvas-fallback'), 'canvas-fallback');
});

// ---------------------------------------------------------------------------
// H-058 — runtime normalization + rejection in batchPostprocess.
// ---------------------------------------------------------------------------

function mockUpscaleApi(sawRef) {
  return {
    realesrganAvailable: async () => ({ available: true }),
    realesrganRun: async (_src, dst, opts) => { sawRef.opts = opts; return { ok: true, outputPath: dst }; },
  };
}

test('H-058: legacy alias real-esrgan-x4plus is normalized to the canonical executor id', async () => {
  const saw = {};
  global.window.api = mockUpscaleApi(saw);
  global.window.state = {};
  const r = await runRowPostprocess(['C:\\out\\a.png'],
    { upscale: 'true', upscaleMultiplier: '4', upscaleModel: 'real-esrgan-x4plus' });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(saw.opts.model, 'realesrgan-x4plus', 'executor must receive the canonical id');
});

test('H-058: legacy alias real-esrgan-anime-v3 is normalized to realesr-animevideov3', async () => {
  const saw = {};
  global.window.api = mockUpscaleApi(saw);
  const r = await runRowPostprocess(['C:\\out\\a.png'],
    { upscale: 'true', upscaleMultiplier: '2', upscaleModel: 'real-esrgan-anime-v3' });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(saw.opts.model, 'realesr-animevideov3');
});

test('H-058: unknown upscale-model is rejected loudly (no silent x4plus fallback)', async () => {
  const saw = {};
  global.window.api = mockUpscaleApi(saw);
  const r = await runRowPostprocess(['C:\\out\\a.png'],
    { upscale: 'true', upscaleMultiplier: '4', upscaleModel: 'canvas-fallback' });
  assert.equal(saw.opts, undefined, 'executor must NOT be invoked for an unknown model');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /upscale failed: unknown upscale-model "canvas-fallback"/);
  // R6.3/BGR-024: raw deliverable preserved on failure.
  assert.deepEqual(r.outputs, ['C:\\out\\a.png']);
});

// ---------------------------------------------------------------------------
// H-057 — validateValues tool-flag contract (image).
// ---------------------------------------------------------------------------

test('H-057 image: valid crop/resize WxH forms pass', () => {
  ok('image', { crop: '512x512' });
  ok('image', { resize: '640×480' });        // unicode ×
  ok('image', { crop: ' 1024 x 768 px ' });  // spaces + px suffix
});

test('H-057 image: malformed crop/resize values are flagged (were silently skipped)', () => {
  bad('image', { crop: 'huge' }, /crop .* not a valid WxH/);
  bad('image', { resize: '12' }, /resize .* not a valid WxH/);
  bad('image', { crop: '512x' }, /crop/);
  bad('image', { resize: 'x512' }, /resize/);
});

test('H-057 image: optimize-format enum + optimize-quality range', () => {
  ok('image', { 'optimize-format': 'keep', 'optimize-quality': 82 });
  ok('image', { 'optimize-format': 'webp', 'optimize-quality': 1 });
  bad('image', { 'optimize-format': 'bmp' }, /optimize-format/);
  bad('image', { 'optimize-quality': 0 }, /optimize-quality/);
  bad('image', { 'optimize-quality': 101 }, /optimize-quality/);
  bad('image', { 'optimize-quality': 'high' }, /optimize-quality must be a number/);
});

test('H-057 image: upscale-multiplier enum 2/3/4', () => {
  ok('image', { 'upscale-multiplier': 2 });
  ok('image', { 'upscale-multiplier': '4' });
  bad('image', { 'upscale-multiplier': 5 }, /upscale-multiplier/);
  bad('image', { 'upscale-multiplier': '1.5' }, /upscale-multiplier/);
});

test('H-057/H-058 image: upscale-model accepts canonical + legacy aliases, rejects fiction', () => {
  ok('image', { 'upscale-model': 'realesrgan-x4plus' });
  ok('image', { 'upscale-model': 'realesrgan-x4plus-anime' });
  ok('image', { 'upscale-model': 'realesr-animevideov3' });
  ok('image', { 'upscale-model': 'real-esrgan-x4plus' });      // legacy alias
  ok('image', { 'upscale-model': 'real-esrgan-anime-v3' });    // legacy alias
  bad('image', { 'upscale-model': 'canvas-fallback' }, /upscale-model/);
});

test('H-057 image: remove-background-model enum', () => {
  ok('image', { 'remove-background-model': 'isnet-general-use' });
  ok('image', { 'remove-background-model': 'birefnet-general-lite' });
  bad('image', { 'remove-background-model': 'rembg' }, /remove-background-model/);
});

// ---------------------------------------------------------------------------
// H-057 — validateValues trim contract (speech/music).
// ---------------------------------------------------------------------------

test('H-057 speech: trim pairing + order + numeric', () => {
  ok('speech', { 'trim-start': 0, 'trim-end': 3.5 });
  bad('speech', { 'trim-start': 1 }, /must be set together/);
  bad('speech', { 'trim-end': 5 }, /must be set together/);
  bad('speech', { 'trim-start': 5, 'trim-end': 2 }, /greater than trim-start/);
  bad('speech', { 'trim-start': 2, 'trim-end': 2 }, /greater than trim-start/);
  bad('speech', { 'trim-start': -1, 'trim-end': 3 }, /must be ≥ 0/);
  bad('speech', { 'trim-start': 'abc', 'trim-end': 3 }, /must be numbers/);
});

test('H-057 music: same trim contract (partial mode, as the batch importer calls it)', () => {
  ok('music', { 'trim-start': 0.5, 'trim-end': 30 }, { partial: true });
  bad('music', { 'trim-start': 10 }, /must be set together/, { partial: true });
  bad('music', { 'trim-start': 8, 'trim-end': 4 }, /greater than trim-start/, { partial: true });
});

test('H-057: dash-prefixed keys are normalized like every other validated flag', () => {
  bad('image', { '--crop': 'nope' }, /crop/);
  bad('speech', { '--trim-start': 1 }, /must be set together/);
});
