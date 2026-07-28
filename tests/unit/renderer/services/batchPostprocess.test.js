// tests/unit/renderer/services/batchPostprocess.test.js
// X1-F5: runRowPostprocess must return the real on-disk `outputs` paths for
// every applied op, not just human-readable `applied` labels — the direct
// batch runner uses `outputs` to replace its outFiles so pipeline-enqueue
// and the returned outFile reflect the post-processed result.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

global.window = global;
require(path.join(ROOT, 'renderer', 'services', 'batchPostprocess.js'));
const { runRowPostprocess } = global.window.BatchPostprocess;

test('remove-background op returns its dst path in outputs', async () => {
  global.window.api = {
    isnetbgRun: async (_src, dst) => ({ ok: true, dst }),
  };
  const r = await runRowPostprocess(['C:\\out\\a.png'], { removeBackground: 'true' });
  assert.deepEqual(r.outputs, ['C:\\out\\a_nobg.png']);
  assert.equal(r.errors.length, 0);
});

// X2 follow-up: the image:resize / image:optimize IPCs take the destination
// as `outputPath` and return it as `r.outputPath`. batchPostprocess previously
// used the WRONG key `dst` + read `r.path`, so the IPC ignored it (wrote to its
// own default sibling) and the propagated path was a phantom that didn't exist.
test('resize op passes outputPath (NOT dst) and records r.outputPath; keeps source ext', async () => {
  let sawOpts = null;
  global.window.api = {
    resizeImage: async (_src, opts) => { sawOpts = opts; return { ok: true, outputPath: opts.outputPath }; },
  };
  const r = await runRowPostprocess(['C:\\out\\a.jpg'], { resize: '100x100' });
  assert.ok(sawOpts && typeof sawOpts.outputPath === 'string', 'must pass the IPC key `outputPath`');
  assert.equal(sawOpts.dst, undefined, 'must NOT pass the ignored `dst` key');
  // Resize keeps the source format → the dst must keep the source extension.
  assert.deepEqual(r.outputs, ['C:\\out\\a_resize.jpg']);
  assert.equal(r.errors.length, 0);
});

test('optimize op passes outputPath (NOT dst) and records r.outputPath', async () => {
  let sawOpts = null;
  global.window.api = {
    optimizeImage: async (_src, opts) => { sawOpts = opts; return { ok: true, outputPath: opts.outputPath }; },
  };
  const r = await runRowPostprocess(['C:\\out\\a.png'], { optimizeFormat: 'webp', optimizeQuality: '80' });
  assert.ok(sawOpts && typeof sawOpts.outputPath === 'string', 'must pass the IPC key `outputPath`');
  assert.equal(sawOpts.dst, undefined, 'must NOT pass the ignored `dst` key');
  assert.deepEqual(r.outputs, ['C:\\out\\a.webp']);
  assert.equal(r.errors.length, 0);
});

test('optimize op with format=keep runs in place (format:null, outputPath===src) — mirrors interactive doOptimize', async () => {
  let sawOpts = null;
  global.window.api = {
    optimizeImage: async (_src, opts) => { sawOpts = opts; return { ok: true, outputPath: opts.outputPath }; },
  };
  const r = await runRowPostprocess(['C:\\out\\a.png'], { optimizeFormat: 'keep', optimizeQuality: '70' });
  assert.ok(sawOpts, 'optimizer must be invoked for format=keep (was previously skipped entirely)');
  assert.equal(sawOpts.format, null, 'format=keep must pass format:null (preserve source format)');
  assert.equal(sawOpts.outputPath, 'C:\\out\\a.png', 'format=keep must optimize in place (outputPath === src)');
  assert.deepEqual(r.outputs, ['C:\\out\\a.png']);
  assert.equal(r.errors.length, 0);
});

test('a failed op preserves the raw input path in outputs (R6.3: partial failure behält raw finalPath)', async () => {
  global.window.api = {
    isnetbgRun: async () => ({ ok: false, error: 'model missing' }),
  };
  const r = await runRowPostprocess(['C:\\out\\a.png'], { removeBackground: 'true' });
  assert.equal(r.outputs.length, 1, 'R6.3: one input → one output even on failure');
  assert.deepEqual(r.outputs, ['C:\\out\\a.png'], 'R6.3: failed op → raw input path preserved');
  assert.equal(r.errors.length, 1);
});

test('no matching ops passes the raw file through (R6.3: Ein Input bleibt genau ein Result)', async () => {
  global.window.api = {};
  const r = await runRowPostprocess(['C:\\out\\a.png'], {});
  assert.deepEqual(r.outputs, ['C:\\out\\a.png'], 'R6.3: no ops → raw file passes through as output');
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.errors, []);
});

// ============================================================================
// R6.3 — Per-input Resultliste: 1:1 input/output guarantee.
// ============================================================================

test('R6.3.A: multiple files all succeed → outputs.length === files.length (1:1)', async () => {
  global.window.api = {
    isnetbgRun: async (_src, dst) => ({ ok: true, dst }),
  };
  const r = await runRowPostprocess(
    ['C:\\out\\a.png', 'C:\\out\\b.png', 'C:\\out\\c.png'],
    { removeBackground: 'true' }
  );
  assert.equal(r.outputs.length, 3, 'R6.3.A: 3 inputs → 3 outputs');
  assert.deepEqual(r.outputs, [
    'C:\\out\\a_nobg.png',
    'C:\\out\\b_nobg.png',
    'C:\\out\\c_nobg.png',
  ]);
  assert.equal(r.errors.length, 0);
});

test('R6.3.B: mixed success/failure → outputs.length === files.length (1:1, failed keeps raw)', async () => {
  let callCount = 0;
  global.window.api = {
    isnetbgRun: async (_src, dst) => {
      callCount++;
      // First call succeeds, second fails.
      if (callCount === 1) return { ok: true, dst };
      return { ok: false, error: 'gpu exploded' };
    },
  };
  const r = await runRowPostprocess(
    ['C:\\out\\a.png', 'C:\\out\\b.png'],
    { removeBackground: 'true' }
  );
  assert.equal(r.outputs.length, 2, 'R6.3.B: 2 inputs → 2 outputs regardless of failure');
  assert.equal(r.outputs[0], 'C:\\out\\a_nobg.png', 'R6.3.B: first file succeeded → processed path');
  assert.equal(r.outputs[1], 'C:\\out\\b.png', 'R6.3.B: second file failed → raw path preserved');
  assert.equal(r.errors.length, 1);
});

test('R6.3.C: chain partial failure (op1 ok, op2 fails) → last successful intermediate preserved (BGR-024)', async () => {
  global.window.api = {
    isnetbgRun: async (_src, dst) => ({ ok: true, dst }),
    resizeImage: async () => ({ ok: false, error: 'sharp crashed' }),
  };
  const r = await runRowPostprocess(
    ['C:\\out\\a.png'],
    { removeBackground: 'true', resize: '100x100' }
  );
  assert.equal(r.outputs.length, 1, 'R6.3.C: 1 input → 1 output');
  // BGR-024 fix: the output is the LAST SUCCESSFUL intermediate (_nobg.png),
  // not the raw input. This way, if upscale+removeBg succeed but crop fails,
  // the user keeps the removeBg output (not the raw).
  assert.equal(r.outputs[0], 'C:\\out\\a_nobg.png',
    'R6.3.C: partial chain failure → last successful intermediate (not raw input)');
  assert.equal(r.errors.length, 1);
  assert.ok(r.applied.length >= 1, 'R6.3.C: the successful op is still recorded in applied');
});

test('R6.3.D: invalid entries (null, non-string) are skipped, valid ones still 1:1', async () => {
  global.window.api = {};
  const r = await runRowPostprocess(
    [null, 'C:\\out\\a.png', undefined, 42, 'C:\\out\\b.png'],
    {}
  );
  // Only 2 valid string entries → 2 outputs.
  assert.equal(r.outputs.length, 2, 'R6.3.D: only valid string entries produce outputs');
  assert.deepEqual(r.outputs, ['C:\\out\\a.png', 'C:\\out\\b.png']);
});

test('R6.3.E: empty files array → empty outputs (no crash)', async () => {
  global.window.api = {};
  const r = await runRowPostprocess([], {});
  assert.deepEqual(r.outputs, []);
  assert.deepEqual(r.errors, []);
});

// ============================================================================
// gewv2 GEW-009 / GEW-011 — batch upscale model + remove-bg GPU knob.
// ============================================================================

test('GEW-009: upscale with no row model defaults to realesrgan-x4plus (general photos), NOT the anime/video model', async () => {
  let sawOpts = null;
  global.window.api = {
    realesrganAvailable: async () => ({ available: true }),
    realesrganRun: async (_src, dst, opts) => { sawOpts = opts; return { ok: true, outputPath: dst }; },
    imageMetadata: async () => ({ ok: true, width: 512, height: 512 }),
    resizeImage: async (_src, _opts) => ({ ok: true, outputPath: _opts.outputPath }),
    fbDelete: async () => {},
  };
  const r = await runRowPostprocess(['C:\\out\\a.png'], { upscale: 'true' });
  assert.equal(sawOpts.model, 'realesrgan-x4plus', 'GEW-009: default upscale model must be x4plus, not the hardcoded anime/video model');
  assert.equal(r.errors.length, 0);
});

test('GEW-009: upscale honors an explicit per-row upscaleModel override', async () => {
  let sawOpts = null;
  global.window.api = {
    realesrganAvailable: async () => ({ available: true }),
    realesrganRun: async (_src, dst, opts) => { sawOpts = opts; return { ok: true, outputPath: dst }; },
    imageMetadata: async () => ({ ok: true, width: 512, height: 512 }),
    resizeImage: async (_src, _opts) => ({ ok: true, outputPath: _opts.outputPath }),
    fbDelete: async () => {},
  };
  const r = await runRowPostprocess(['C:\\out\\a.png'], { upscale: 'true', upscaleModel: 'realesrgan-x4plus-anime' });
  assert.equal(sawOpts.model, 'realesrgan-x4plus-anime', 'GEW-009: explicit row upscaleModel must be honored');
  assert.equal(r.errors.length, 0);
});

test('GEW-009: upscale falls back to window.state.realesrganModel when no row override is set', async () => {
  let sawOpts = null;
  global.window.api = {
    realesrganAvailable: async () => ({ available: true }),
    realesrganRun: async (_src, dst, opts) => { sawOpts = opts; return { ok: true, outputPath: dst }; },
    imageMetadata: async () => ({ ok: true, width: 512, height: 512 }),
    resizeImage: async (_src, _opts) => ({ ok: true, outputPath: _opts.outputPath }),
    fbDelete: async () => {},
  };
  global.window.state = { realesrganModel: 'realesrgan-x4plus-anime' };
  try {
    const r = await runRowPostprocess(['C:\\out\\a.png'], { upscale: 'true' });
    assert.equal(sawOpts.model, 'realesrgan-x4plus-anime', 'GEW-009: falls back to the app-wide upscale model preference');
    assert.equal(r.errors.length, 0);
  } finally { delete global.window.state; }
});

test('GEW-011: remove-bg honors an explicit per-row removeBackgroundUseGpu:false override', async () => {
  let sawOpts = null;
  global.window.api = {
    isnetbgRun: async (_src, dst, opts) => { sawOpts = opts; return { ok: true, dst }; },
  };
  const r = await runRowPostprocess(['C:\\out\\a.png'], { removeBackground: 'true', removeBackgroundUseGpu: 'false' });
  assert.equal(sawOpts.useGpu, false, 'GEW-011: explicit false must be honored (not silently forced true/false)');
  assert.equal(r.errors.length, 0);
});

test('GEW-011: remove-bg honors an explicit per-row removeBackgroundUseGpu:true override', async () => {
  let sawOpts = null;
  global.window.api = {
    isnetbgRun: async (_src, dst, opts) => { sawOpts = opts; return { ok: true, dst }; },
  };
  const r = await runRowPostprocess(['C:\\out\\a.png'], { removeBackground: 'true', removeBackgroundUseGpu: true });
  assert.equal(sawOpts.useGpu, true, 'GEW-011: explicit true must be honored');
  assert.equal(r.errors.length, 0);
});

test('GEW-011: remove-bg with no row override falls back to window.state.removeBackgroundUseGpu', async () => {
  let sawOpts = null;
  global.window.api = {
    isnetbgRun: async (_src, dst, opts) => { sawOpts = opts; return { ok: true, dst }; },
  };
  global.window.state = { removeBackgroundUseGpu: false };
  try {
    const r = await runRowPostprocess(['C:\\out\\a.png'], { removeBackground: 'true' });
    assert.equal(sawOpts.useGpu, false, 'GEW-011: falls back to the app-wide GPU preference, not a hardcoded false');
    assert.equal(r.errors.length, 0);
  } finally { delete global.window.state; }
});
