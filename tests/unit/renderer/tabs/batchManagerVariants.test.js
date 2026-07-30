// tests/unit/renderer/tabs/batchManagerVariants.test.js
// H9-004: BatchGen must own variant expansion. The previous code looped
// currentVariantsCount times AND left the tab's own variants selector at the
// user's value, so each click ALSO multiplied → up to 16 calls for variants=4.
// Source-pattern guard: BatchGen must force the tab selector to '1' for the
// whole run (and restore it in the finally block).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'renderer', 'tabs', 'batchManager.js'),
  'utf8',
);

test('H9-004 BatchGen forces the tab variants selector to 1 during the run', () => {
  // The fix sets variantsSel.value = '1' + dispatches change right after reading
  // the saved value, so the tab's own variant loop doesn't multiply on top of
  // BatchGen's per-item loop.
  assert.match(SRC, /variantsSel\.value = '1'/);
  assert.match(SRC, /variantsSel\.dispatchEvent\(new Event\(['"]change['"]/);
});

test('H9-004 BatchGen restores the saved variants selector in finally', () => {
  // The original user value must be restored when the run ends.
  assert.match(SRC, /if \(variantsSel\) variantsSel\.value = savedVariants/);
});

test('H9-004 BatchGen reads a per-item variants override (single source of truth)', () => {
  // currentVariantsCount is derived per-item from item.variants / item['--variants'].
  assert.match(SRC, /item\.variants \|\| item\['--variants'\]/);
  assert.match(SRC, /currentVariantsCount = Math\.max\(1,\s*Math\.min\(5/);
});

// ---- H9-016: Stop cancels the active child + concurrent-start guard ----
test('H9-016 the Stop handler cancels the running child (R5 M1: targeted via JobRunner, not global mmxCancel)', () => {
  // The Stop handler must kill the ACTIVE CHILD mmx job, but ONLY this tab's.
  // The old global window.api.mmxCancel() killed every in-flight generation on
  // every tab (R5 M1). The targeted path cancels the tab's wip JobRunner
  // job(s), which route mmxCancel({jobId}) to just that proc.
  assert.match(SRC, /window\.JobRunner\.jobsForTab\(tabKey\)/);
  assert.match(SRC, /window\.JobRunner\.cancel\(j\.id\)/);
  // The global panic-cancel must be gone from the Stop path.
  assert.doesNotMatch(SRC, /window\.api\.mmxCancel\(\)/);
});
test('H9-016 startBatchGen guards against a concurrent start with a per-queue lock', () => {
  assert.match(SRC, /_batchRunningByTab/);
  assert.match(SRC, /A \$\{tabKey\} batch is already running/);
  // and the lock is released in the outer finally.
  assert.match(SRC, /window\._batchRunningByTab\[tabKey\] = false/);
});

// ---- H9-017: per-item try/finally + auto-remove aggregates all variants ----
test('H9-017 the variant loop is wrapped in a per-item try/catch/finally', () => {
  assert.match(SRC, /let itemAllVariantsOk = true/);
  assert.match(SRC, /catch \(itemErr\)/);
  assert.match(SRC, /end per-item finally/);
});
test('H9-017 auto-remove only fires when every variant succeeded', () => {
  // The condition must check itemAllVariantsOk, not just looksOk on the last variant.
  assert.match(SRC, /autoRemove && vi === currentVariantsCount - 1 && itemAllVariantsOk/);
  // and a failed variant flips the aggregate flag.
  assert.match(SRC, /itemAllVariantsOk = false/);
});

// ---- R6.5: expectedCalls must use a locally-scoped default variants count ----
test('R6.5 expectedCalls reads the tab variants selector BEFORE the reduce (not the runFn-scoped variantsCount)', () => {
  // The bug was: expectedCalls referenced `variantsCount` which is defined
  // INSIDE runFn (line ~243), but expectedCalls is calculated BEFORE runFn
  // is called. This would cause a ReferenceError at runtime.
  // The fix: read the tab's variants selector into a local `_dv` variable
  // BEFORE the reduce, so the calculation is self-contained.
  assert.match(SRC, /const _vr = .*querySelector\(['"]\.variants-select['"]\)/,
    'R6.5: must read .variants-select before expectedCalls');
  assert.match(SRC, /const _dv = _vr \? Math\.max\(1,\s*Math\.min\(5/,
    'R6.5: must compute _dv (default variants) from the selector');
  assert.match(SRC, /: _dv;/,
    'R6.5: expectedCalls reduce must use _dv (not the runFn-scoped variantsCount)');
  // Ensure the OLD bug pattern is NOT present (variantsCount in expectedCalls).
  // P4.3 moved the reduce into computeExpectedCalls, so the guarded block runs
  // from the function to the skipConfirm gate in startBatchGen.
  const expectedCallsBlock = SRC.slice(SRC.indexOf('function computeExpectedCalls'), SRC.indexOf('if (!opts.skipConfirm && expectedCalls > 1'));
  assert.ok(!expectedCallsBlock.includes(': variantsCount'),
    'R6.5: expectedCalls must NOT reference the runFn-scoped variantsCount');
});
