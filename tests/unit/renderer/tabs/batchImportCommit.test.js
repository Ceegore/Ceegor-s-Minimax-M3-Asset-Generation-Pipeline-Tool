// tests/unit/renderer/tabs/batchImportCommit.test.js
// H9-011/012/014: source-pattern guards for the import-commit behaviour.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'renderer', 'tabs', 'batchImportHelper.js'),
  'utf8',
);

// H9-011: silent capacity truncation must surface a warning, not report success.
test('H9-011 import surfaces an overflow warning instead of silently truncating', () => {
  assert.match(SRC, /warnIfOverflow/);
  assert.match(SRC, /Queue capacity reached/);
});

// H9-012: a failed queue save must keep the modal open + return false.
test('H9-012 saveImported returns false on failure (modal stays open)', () => {
  assert.match(SRC, /return false/);
  assert.match(SRC, /your parsed batches are still in the review list/);
});
test('H9-012 commit buttons only close() on a successful save', () => {
  // Both overwrite + append must gate close() behind `if (ok)`.
  const closeCalls = (SRC.match(/close\(\)/g) || []).length;
  const gated = (SRC.match(/const ok = await saveImported[\s\S]*?if \(ok\) close\(\)/g) || []).length;
  assert.equal(gated, 2, 'both overwrite + append gate close on a successful save');
  assert.ok(gated <= closeCalls);
});

// H9-014: a prompt/text key in Parameters is dropped (not allowed to override).
test('H9-014 buildImportedEntry drops a prompt key from params + flags it', () => {
  assert.match(SRC, /promptOverrideAttempt/);
  assert.match(SRC, /A "prompt" or "text" key in the Parameters column was ignored/);
});
