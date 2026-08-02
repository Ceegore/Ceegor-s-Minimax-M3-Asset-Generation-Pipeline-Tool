// tests/unit/renderer/tabs/batchImportValidatorThrow.h055.test.js
// ============================================================================
// H-055 regression: an EXCEPTION inside the import-time validator must not
// produce a silently-unvalidated executable row. The old code swallowed the
// throw (`catch (_) {}`), so the entry imported WITHOUT `_defective` and the
// BatchGen runner would happily spend a billable request on parameters nobody
// ever checked. Now the infrastructure failure itself marks the row defective
// (the runner skips defective rows), while the import still succeeds so the
// prompt is not lost.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ---- minimal window so batchImportHelper.js + modelSpecs.js load ----
global.window = global;
global.state = { batches: {} };
global.toast = () => {};
global.showModal = () => {};
global.el = () => {};
global.$ = () => null;

require(path.join(ROOT, 'renderer', 'tabs', 'batchImportCompatibility.js'));
require(path.join(ROOT, 'renderer', 'tabs', 'batchImportHelper.js'));
require(path.join(ROOT, 'renderer', 'specs', 'modelSpecs.js'));
const { buildImportedEntry } = global.window.BatchManager;

function withThrowingValidator(err, run) {
  const real = global.window.ModelSpecs.validateValues;
  global.window.ModelSpecs.validateValues = () => { throw err; };
  try { return run(); }
  finally { global.window.ModelSpecs.validateValues = real; }
}

test('H-055: a throwing validator marks the row defective (never silently executable)', () => {
  withThrowingValidator(new Error('spec table exploded'), () => {
    const e = buildImportedEntry('image', 'a cat', { '--aspect-ratio': '16:9' });
    // The prompt is preserved — import itself must not be blocked.
    assert.equal(e.prompt, 'a cat');
    assert.ok(Array.isArray(e._defective) && e._defective.length > 0,
      'row must be defective when validation infrastructure fails');
    assert.ok(e._defective.some((m) => /Validation infrastructure failed/i.test(m)),
      'reason names the infrastructure failure: ' + JSON.stringify(e._defective));
    assert.ok(e._defective.some((m) => /spec table exploded/.test(m)),
      'reason carries the underlying error message');
  });
});

test('H-055: non-Error throw values are stringified into the defect reason', () => {
  withThrowingValidator('plain string throw', () => {
    const e = buildImportedEntry('speech', 'Hello', {});
    assert.ok(Array.isArray(e._defective)
      && e._defective.some((m) => /Validation infrastructure failed: plain string throw/.test(m)),
      JSON.stringify(e._defective));
  });
});

test('H-055: the BatchGen runner skips defective rows (guard still present)', () => {
  // Source-level guard: batchManager's runner must keep skipping rows with a
  // non-empty _defective array. This is the enforcement half of H-055 — if
  // the skip disappears, a defective row would start a billable request.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'batchManager.js'), 'utf8');
  assert.match(src, /_defective\)\s*&&\s*item\._defective\.length/,
    'batchManager must gate execution on item._defective');
  assert.match(src, /skipped — defective/,
    'batchManager must log the defective skip so the user sees why');
});

test('H-055: healthy validation is unaffected by the new error path', () => {
  const e = buildImportedEntry('image', 'a cat', { '--aspect-ratio': '16:9' });
  assert.ok(!e._defective, 'no defect for a valid row (got ' + JSON.stringify(e._defective) + ')');
});
