// tests/unit/src/pipeline/pipelineResizeSanitizer.qa.test.js
// Phase 5 (adversarial QA) — closes the narrow gaps the existing
// pipelineBoardSanitize.test.js leaves in the resize column:
//   - NaN / float / string / boolean coercion for width & height
//   - explicit keepAspect:false / sharpen:false are preserved (not reset to true)
//   - columnFolders.resize path string is kept + sanitised
//   - per-item settings.resize is sanitised identically to the board column
//   - resize STORAGE membership (a resize'd file is a persisted storage column)

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitisePipelineBoard } = require('../../../../src/stateSanitizers');
const pm = require('../../../../src/pipeline/pipelineModel');

test('resize dims: NaN → 0, float → floored, "123" → 123, true → 0', () => {
  const b = sanitisePipelineBoard({
    columns: { resize: { width: NaN, height: 123.9 } },
  });
  assert.equal(b.columns.resize.width, 0, 'NaN → 0');
  assert.equal(b.columns.resize.height, 123, '123.9 floored to 123');

  const b2 = sanitisePipelineBoard({ columns: { resize: { width: '456', height: true } } });
  assert.equal(b2.columns.resize.width, 456, '"456" parsed to 456');
  assert.equal(b2.columns.resize.height, 0, 'true → parseInt(true)=NaN → 0');
});

test('resize dims: negative → 0; exact 65500 kept; 65501 clamped', () => {
  const b = sanitisePipelineBoard({ columns: { resize: { width: -1, height: 65500 } } });
  assert.equal(b.columns.resize.width, 0);
  assert.equal(b.columns.resize.height, 65500, 'boundary 65500 preserved');

  const b2 = sanitisePipelineBoard({ columns: { resize: { width: 65501, height: 65501 } } });
  assert.equal(b2.columns.resize.width, 65500);
  assert.equal(b2.columns.resize.height, 65500);
});

test('resize flags: explicit keepAspect:false + sharpen:false are PRESERVED', () => {
  // The contract is `!== false` → a genuine false must round-trip, not be reset.
  const b = sanitisePipelineBoard({ columns: { resize: { width: 100, height: 100, keepAspect: false, sharpen: false } } });
  assert.equal(b.columns.resize.keepAspect, false);
  assert.equal(b.columns.resize.sharpen, false);
  // And non-false values still coerce to true.
  const b2 = sanitisePipelineBoard({ columns: { resize: { keepAspect: 'no', sharpen: 0 } } });
  assert.equal(b2.columns.resize.keepAspect, true);
  assert.equal(b2.columns.resize.sharpen, true);
});

test('resize column: defaults are width=0/height=0 (no-op) when fully absent', () => {
  const b = sanitisePipelineBoard({});
  assert.deepEqual(b.columns.resize, { width: 0, height: 0, keepAspect: true, sharpen: true });
});

test('per-item settings.resize is sanitised identically to the board column', () => {
  const b = sanitisePipelineBoard({
    items: [{
      id: 'img_r', files: { original: '/o.png' },
      settings: { resize: { width: -50, height: 999999, keepAspect: false } },
    }],
  });
  const r = b.items[0].settings.resize;
  assert.equal(r.width, 0, 'negative → 0 at item level too');
  assert.equal(r.height, 65500, 'over-cap → 65500 at item level too');
  assert.equal(r.keepAspect, false, 'explicit false preserved at item level');
});

test('STORAGE_COLUMNS / COLUMN_ORDER include resize in the correct position', () => {
  // Guards against an accidental reorder that would misroute files.
  assert.equal(pm.COLUMN_ORDER.indexOf('resize'), 4, 'resize is the 5th column (index 4)');
  assert.equal(pm.COLUMN_ORDER.indexOf('crop') + 1, pm.COLUMN_ORDER.indexOf('resize'), 'resize follows crop');
  assert.equal(pm.COLUMN_ORDER.indexOf('resize') + 1, pm.COLUMN_ORDER.indexOf('optimize'), 'optimize follows resize');
  assert.ok(pm.STORAGE_COLUMNS.includes('resize'), 'resize is a persisted storage column');
  assert.ok(pm.ACTIVE_COLUMNS.includes('resize'), 'resize runs an op');
});

test('resolveSettings(resize) returns the column defaults', () => {
  const s = pm.resolveSettings('resize', undefined);
  assert.equal(s.width, 0);
  assert.equal(s.height, 0);
  assert.equal(s.keepAspect, true);
  assert.equal(s.sharpen, true);
  // per-item override merges over defaults
  const s2 = pm.resolveSettings('resize', { resize: { width: 512 } });
  assert.equal(s2.width, 512, 'override applied');
  assert.equal(s2.keepAspect, true, 'default fills the rest');
});

test('outPath: resize uses the _resized infix + respects replaceN', () => {
  const path = require('path');
  const ws = 'C:/ws';
  const id = 'img_x';
  const base = pm.outPath(ws, id, 'a.png', 'resize');
  assert.equal(base, path.join(ws, 'resize', 'img_x_a_resized.png'));
  const rep = pm.outPath(ws, id, 'a.png', 'resize', { replaceN: 2 });
  assert.equal(rep, path.join(ws, 'resize', 'img_x_a_resized_replace2.png'));
});
