// tests/unit/src/pipeline/pipelineBoardSanitize.test.js
// Feature 3 Layer 1 — the pipeline board sanitiser (src/stateSanitizers.js).
// Guards the "corrupted state.json must never crash or carry a bad spawn arg"
// contract. Mirrors the style of the existing state.test.js sanitizer tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitisePipelineBoard } = require('../../../../src/stateSanitizers');
// PE-014: the removebg default/fallback is the auto-best-compatible model
// (BiRefNet Lite when its file is present + node backend available, else
// IS-Net). Assert against the SAME source of truth the sanitiser uses so the
// test is correct in every environment (CI without the big model files still
// resolves to IS-Net) instead of hardcoding one model.
const { resolveAutoBestModel } = require('../../../../src/isnetbg/binaryDiscovery');

test('sanitisePipelineBoard: missing/garbage input → valid empty board (never throws)', () => {
  for (const bad of [null, undefined, 'oops', 42, [], {}]) {
    const b = sanitisePipelineBoard(bad);
    assert.equal(b.workspace, '');
    assert.deepEqual(b.items, []);
    assert.equal(typeof b.columns, 'object');
    assert.equal(b.columns.upscale.multiplier, 2, 'default multiplier survives');
  }
});

test('sanitisePipelineBoard: clamps model keys against the existing whitelists', () => {
  const b = sanitisePipelineBoard({
    columns: {
      upscale: { multiplier: 99, model: '../../evil', useCanvasFallback: 'yes' },
      removebg: { model: 'rm-rf', useGpu: 'no', skipIfTransparent: 1 },
      crop: { mode: 'lasers', w: -50, anchorX: 'sideways' },
      resize: { width: -10, height: 999999, keepAspect: 'no', sharpen: 0 },
      optimize: { format: 'exe', quality: 999 },
    },
  });
  assert.equal(b.columns.upscale.multiplier, 2, 'multiplier 99 clamped to 2 (range 1-8)');
  assert.equal(b.columns.upscale.model, 'realesrgan-x4plus', 'bad realesrgan model → default');
  assert.equal(b.columns.upscale.useCanvasFallback, false, 'non-true → false');
  assert.equal(b.columns.removebg.model, resolveAutoBestModel(), 'bad isnetbg model → auto-best default');
  assert.equal(b.columns.removebg.useGpu, true, 'useGpu default true (opt-out)');
  assert.equal(b.columns.crop.mode, 'anchor', 'unknown mode → anchor');
  assert.equal(b.columns.crop.w, 0, 'negative w → 0');
  assert.equal(b.columns.crop.anchorX, 'center', 'bad anchor → center');
  // Task 1b: resize clamps.
  assert.equal(b.columns.resize.width, 0, 'negative width → 0');
  assert.equal(b.columns.resize.height, 65500, 'over-cap height clamped to 65500');
  assert.equal(b.columns.resize.keepAspect, true, 'non-false keepAspect → true (default)');
  assert.equal(b.columns.resize.sharpen, true, 'non-false sharpen → true (default)');
  assert.equal(b.columns.optimize.format, 'keep', 'bad format → keep');
  assert.equal(b.columns.optimize.quality, 82, 'quality 999 → 82');
});

test('sanitisePipelineBoard: resize default columns present (Task 1b)', () => {
  const b = sanitisePipelineBoard({});
  assert.ok(b.columns.resize, 'resize column exists in the sanitised defaults');
  assert.equal(b.columns.resize.width, 0);
  assert.equal(b.columns.resize.height, 0);
  assert.equal(b.columns.resize.keepAspect, true);
  assert.equal(b.columns.resize.sharpen, true);
});

test('sanitisePipelineBoard: accepts valid known model keys', () => {
  const b = sanitisePipelineBoard({
    columns: {
      upscale: { multiplier: 4, model: 'realesrgan-x4plus-anime' },
      removebg: { model: 'birefnet-general-lite' },
    },
  });
  assert.equal(b.columns.upscale.multiplier, 4);
  assert.equal(b.columns.upscale.model, 'realesrgan-x4plus-anime');
  assert.equal(b.columns.removebg.model, 'birefnet-general-lite');
});

test('sanitisePipelineBoard: migrates the legacy AnimeVideo model typo and preserves drag crops', () => {
  const b = sanitisePipelineBoard({
    columns: { upscale: { model: 'realesrgan-animevideov3' } },
    items: [{
      id: 'img_drag', files: { original: '/o.png' },
      settings: { crop: { mode: 'drag', x: 37, y: 19, w: 100, h: 80 } },
      settingsOpen: { crop: true },
    }],
  });
  assert.equal(b.columns.upscale.model, 'realesr-animevideov3');
  assert.deepEqual(b.items[0].settings.crop, {
    mode: 'drag', x: 37, y: 19, w: 100, h: 80, anchorX: 'center', anchorY: 'center',
  });
  assert.equal(b.items[0].settingsOpen.crop, true);
});

test('sanitisePipelineBoard: drops items missing id or files.original', () => {
  const b = sanitisePipelineBoard({
    items: [
      { id: 'img_a', column: 'original', files: { original: '/path/a.png' } }, // valid
      { column: 'original', files: { original: '/x' } }, // missing id → drop
      { id: 'img_b', files: {} }, // missing files.original → drop
      { id: 'img_c', files: { original: 123 } }, // non-string original → drop
      { id: 'img_d', column: 'nonsense', files: { original: '/d.png' } }, // bad column → kept, reset to original
    ],
  });
  assert.equal(b.items.length, 2, 'only the valid item + the bad-column one survive');
  assert.ok(b.items.find((i) => i.id === 'img_a'));
  const d = b.items.find((i) => i.id === 'img_d');
  assert.equal(d.column, 'original', 'bad column reset to original');
});

test('sanitisePipelineBoard: keeps only string file paths + clamps history', () => {
  const longHistory = Array.from({ length: 100 }, (_, i) => ({ i }));
  const b = sanitisePipelineBoard({
    items: [{
      id: 'img_x', column: 'upscale', files: {
        original: '/o.png', upscale: '/u.png', bogus: 42, also: null,
      },
      history: longHistory,
      status: 'running', error: 'x'.repeat(1000),
    }],
  });
  const it = b.items[0];
  assert.equal(it.files.original, '/o.png');
  assert.equal(it.files.upscale, '/u.png');
  assert.ok(!('bogus' in it.files), 'non-string file dropped');
  assert.ok(!('also' in it.files));
  assert.ok(it.history.length <= 50, 'history capped at 50');
  assert.equal(it.status, 'running');
  assert.ok(it.error.length <= 500, 'error string clamped');
});

test('sanitisePipelineBoard: hiddenColumns filters to active columns', () => {
  const b = sanitisePipelineBoard({ hiddenColumns: ['upscale', 'import', 'nonsense', 'crop', 'resize'] });
  assert.deepEqual(b.hiddenColumns, ['upscale', 'crop', 'resize'], 'only active columns kept (incl. resize)');
});

// 360° audit fix: a circular reference inside an item's history survived the
// prior slice() (slice copies references) and crashed state.write()'s
// JSON.stringify, orphaning the temp file. The sanitiser must deep-clone
// history to a JSON-safe form.
test('sanitisePipelineBoard: circular history is JSON-safe (no stringify crash)', () => {
  const circ = { a: 1 }; circ.self = circ;
  const b = sanitisePipelineBoard({
    items: [{ id: 'img_c', files: { original: '/c.png' }, history: [circ, { ok: true }] }],
  });
  assert.doesNotThrow(() => JSON.stringify(b), 'board with circular history must be JSON-stringifiable');
  assert.equal(b.items[0].history.length, 1, 'the non-serialisable circular entry is dropped, the plain one kept');
});

// 360° audit fix: per-item settings.<col>.model was shallow-spread verbatim,
// so a malicious model key (which ends up in a spawn argv) survived the
// sanitiser. It must now be whitelisted exactly like the board-level columns.
test('sanitisePipelineBoard: per-item settings model keys are whitelisted', () => {
  const b = sanitisePipelineBoard({
    items: [{
      id: 'img_m', files: { original: '/m.png' },
      settings: {
        removebg: { model: '../../evil-inject', useGpu: 'no' },
        upscale: { model: 'bad-model', multiplier: 99 },
        crop: { anchorX: 'sideways', w: -10 },
        optimize: { format: 'exe', quality: 999 },
      },
    }],
  });
  const s = b.items[0].settings;
  assert.equal(s.removebg.model, resolveAutoBestModel(), 'malicious removebg model → auto-best default');
  assert.equal(s.upscale.model, 'realesrgan-x4plus', 'bad upscale model → default');
  assert.equal(s.upscale.multiplier, 2, 'multiplier 99 clamped');
  assert.equal(s.crop.anchorX, 'center', 'bad anchor → center');
  assert.equal(s.crop.w, 0, 'negative w → 0');
  assert.equal(s.optimize.format, 'keep', 'bad format → keep');
  assert.equal(s.optimize.quality, 82, 'quality 999 → 82');
});

// 360° audit fix: the trash bin kept the OLDEST 200 entries (slice(0,200)),
// silently dropping the newest deletions — exactly the ones the user is most
// likely to Undo. It must keep the NEWEST.
test('sanitisePipelineBoard: trash keeps the NEWEST 200 entries', () => {
  const b = sanitisePipelineBoard({
    trash: Array.from({ length: 205 }, (_, i) => ({ id: 't' + i, ts: i })),
  });
  assert.equal(b.trash.length, 200);
  assert.equal(b.trash[b.trash.length - 1].ts, 204, 'newest entry (ts=204) kept');
  assert.equal(b.trash[0].ts, 5, 'oldest entries dropped, ts starts at 5');
});

// 360° audit fix: trash entries were copied verbatim (slice) with no shape
// validation, so a corrupted trash could carry arbitrary objects. Each entry
// is now reduced to a minimal {id, ts} shape.
test('sanitisePipelineBoard: trash entries are reduced to a minimal safe shape', () => {
  const b = sanitisePipelineBoard({
    trash: [{ id: 't1', ts: 1, malicious: true, files: ['/etc/passwd'] }, 'not-an-object', null, { item: { id: 'nested' }, ts: 2 }],
  });
  // Two valid object entries survive ('not-an-object' and null are dropped).
  assert.equal(b.trash.length, 2, 'non-object entries dropped');
  for (const t of b.trash) {
    assert.ok(typeof t.id === 'string', 'id is a string');
    assert.ok(typeof t.ts === 'number', 'ts is a number');
    assert.ok(!('malicious' in t) && !('files' in t), 'arbitrary keys stripped');
  }
});

// 360° audit fix: items array was uncapped — a runaway import would bloat
// state.json unboundedly. Cap at 1000, keeping the newest.
test('sanitisePipelineBoard: items capped at 1000, newest kept', () => {
  const b = sanitisePipelineBoard({
    items: Array.from({ length: 1005 }, (_, i) => ({ id: 'img_' + i, files: { original: '/o.png' } })),
  });
  assert.equal(b.items.length, 1000);
  assert.equal(b.items[b.items.length - 1].id, 'img_1004', 'newest item kept');
});

// Regression: columnFolders (user-configured per-column output folders) was
// dropped by the sanitiser's return object, so a folder chosen via the 📁
// button never survived an autosave or restart. It must be preserved.
test('sanitisePipelineBoard: columnFolders survives sanitising (persist + restart)', () => {
  const b = sanitisePipelineBoard({
    columnFolders: {
      upscale: 'D:\\Output\\Upscaled',
      resize: 'D:\\Output\\Resized',
      final: 'D:\\Output\\Final',
    },
  });
  assert.equal(b.columnFolders.upscale, 'D:\\Output\\Upscaled');
  assert.equal(b.columnFolders.resize, 'D:\\Output\\Resized');
  assert.equal(b.columnFolders.final, 'D:\\Output\\Final');
});

test('sanitisePipelineBoard: columnFolders rejects invalid keys and non-strings', () => {
  const b = sanitisePipelineBoard({
    columnFolders: {
      resize: 'D:\\Valid',         // valid column, valid path → kept
      nonsense: 'D:\\Bad',         // not a real column → dropped
      crop: 42,                    // non-string → dropped
      crop__proto__: 'evil',       // bad key → dropped
      '   ': 'D:\\EmptyKey',       // empty/whitespace handled
    },
  });
  assert.equal(Object.keys(b.columnFolders).length, 1, 'only the valid resize entry survives');
  assert.equal(b.columnFolders.resize, 'D:\\Valid');
});

test('sanitisePipelineBoard: columnFolders defaults to {} on corrupt/missing input', () => {
  for (const bad of [null, undefined, 'oops', 42, [], {}]) {
    const b = sanitisePipelineBoard(bad);
    assert.deepEqual(b.columnFolders, {}, 'columnFolders is always a clean object');
  }
});
