// tests/unit/src/pipeline/pipelineModel.test.js
// Feature 3 Layer 1 — pure helpers for the Pipeline board model.
// These are fully Node-runnable (no Electron, no fs) and guard the path-naming
// + sanitisation contracts that the workspace layout + disaster recovery depend on.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  COLUMN_ORDER, ACTIVE_COLUMNS, STORAGE_COLUMNS,
  REALESRGAN_MODELS, newItemId, safeBaseName, outPath, nextColumn, prevColumn, resolveSettings,
} = require('../../../../src/pipeline/pipelineModel');

test('upscale model registry contains only models shipped by the supported ncnn bundle', () => {
  assert.deepEqual(REALESRGAN_MODELS, [
    'realesrgan-x4plus', 'realesrgan-x4plus-anime', 'realesr-animevideov3',
  ]);
});

test('column model: fixed order, import is NOT a storage column', () => {
  // Task 1b: 'resize' sits between 'crop' and 'optimize'.
  assert.deepEqual(COLUMN_ORDER, ['original', 'upscale', 'removebg', 'crop', 'resize', 'optimize', 'final']);
  assert.ok(!STORAGE_COLUMNS.includes('import'), 'import is intake-only');
  assert.ok(ACTIVE_COLUMNS.every((c) => STORAGE_COLUMNS.includes(c)));
  assert.ok(STORAGE_COLUMNS.includes('resize'), 'resize is a storage column');
  assert.ok(ACTIVE_COLUMNS.includes('resize'), 'resize is an active column');
});

test('newItemId: unique, safe charset, starts with img_', () => {
  const a = newItemId();
  const b = newItemId();
  assert.notEqual(a, b, 'two ids differ');
  assert.ok(a.startsWith('img_'), 'prefix is img_');
  assert.match(a, /^img_[a-z0-9]+$/, 'filesystem-safe charset only');
});

test('safeBaseName: strips path separators, rejects dot/dotdot, clamps length', () => {
  // Slashes become underscores; the result is a single safe segment (no dir climb).
  assert.equal(safeBaseName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeBaseName('..'), 'image', 'pure dotdot → fallback');
  assert.equal(safeBaseName('.'), 'image', 'pure dot → fallback');
  assert.equal(safeBaseName(''), 'image', 'empty → fallback');
  assert.equal(safeBaseName(null), 'image', 'non-string → fallback');
  assert.equal(safeBaseName('good.png'), 'good.png');
  // null bytes stripped
  assert.equal(safeBaseName('a\0b.png'), 'ab.png');
  // length clamp keeps extension
  const long = 'x'.repeat(200) + '.png';
  const clamped = safeBaseName(long);
  assert.ok(clamped.length <= 120, 'clamped to <= 120');
  assert.ok(clamped.endsWith('.png'), 'extension preserved after clamp');
});

test('outPath: builds per-column paths with the correct stage suffix', () => {
  const ws = 'C:/out/pipeline/image';
  const id = 'img_abc';
  const name = 'hero.png';
  assert.equal(outPath(ws, id, name, 'original'), path.join(ws, 'original', 'img_abc_hero.png'));
  assert.equal(outPath(ws, id, name, 'upscale', { mult: 2 }), path.join(ws, 'upscale', 'img_abc_hero_2x.png'));
  assert.equal(outPath(ws, id, name, 'removebg'), path.join(ws, 'removebg', 'img_abc_hero_nobg.png'));
  assert.equal(outPath(ws, id, name, 'crop'), path.join(ws, 'crop', 'img_abc_hero_cropped.png'));
  assert.equal(outPath(ws, id, name, 'resize'), path.join(ws, 'resize', 'img_abc_hero_resized.png'));
  assert.equal(outPath(ws, id, name, 'optimize'), path.join(ws, 'optimize', 'img_abc_hero_opt.png'));
  // replaceN infix (the GIMP round-trip)
  assert.equal(
    outPath(ws, id, name, 'crop', { replaceN: 1 }),
    path.join(ws, 'crop', 'img_abc_hero_cropped_replace1.png')
  );
  // A malicious name with path separators can't escape the column folder: the
  // separators are turned into underscores by safeBaseName, so the built path
  // stays a single segment under <ws>/<column>/.
  const evil = outPath(ws, id, '../evil.png', 'original');
  assert.ok(!evil.includes('../') && !evil.includes('..\\'), 'no parent traversal in the built path');
});

test('nextColumn / prevColumn: walk the order, null at the ends', () => {
  assert.equal(nextColumn('original'), 'upscale');
  assert.equal(nextColumn('upscale'), 'removebg');
  assert.equal(nextColumn('crop'), 'resize', 'crop now advances to resize');
  assert.equal(nextColumn('resize'), 'optimize', 'resize advances to optimize');
  assert.equal(nextColumn('final'), null, 'last column has no next');
  assert.equal(prevColumn('original'), null, 'first column has no prev');
  assert.equal(prevColumn('final'), 'optimize');
  assert.equal(prevColumn('optimize'), 'resize', 'optimize prev is now resize');
  assert.equal(nextColumn('nonsense'), null, 'unknown column → null');
});

test('resolveSettings: per-item overrides win over column defaults', () => {
  const s = resolveSettings('upscale', { upscale: { multiplier: 4 } });
  assert.equal(s.multiplier, 4, 'override applied');
  assert.equal(s.model, 'realesrgan-x4plus', 'default fills in the rest');
  assert.equal(s.useCanvasFallback, false, 'default boolean fills in');
  // no overrides at all → full defaults
  const s2 = resolveSettings('crop', undefined);
  assert.equal(s2.mode, 'anchor');
  assert.equal(s2.anchorX, 'center');
});
