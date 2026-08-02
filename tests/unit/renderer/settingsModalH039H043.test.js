// tests/unit/renderer/settingsModalH039H043.test.js
// ============================================================================
// H-039: thrown pane validator must BLOCK the save (fail-closed).
// H-043: modal builder error must clean up via close() (no permanent jam).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// H-039: validator throw → save blocked
// ---------------------------------------------------------------------------

test('H-039: catch in validate loop sets errs to [msg] (not empty array)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section04_Settings.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // The catch must set errs = [msg] (fail-closed), NOT errs = [].
  assert.match(code, /errs\s*=\s*\[msg\]/,
    'catch must set errs to [msg] so the error propagates to allErrors');
  // Must NOT have the old fail-open pattern.
  assert.doesNotMatch(code, /catch\s*\(e\)\s*\{[^}]*errs\s*=\s*\[\]\s*;?\s*\}/s,
    'old pattern (errs = []) must be gone');
});

test('H-039: toast message includes the thrown error', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section04_Settings.js'), 'utf8');
  assert.match(src, /validate\(\) threw/,
    'toast must mention the validator throw');
});

// ---------------------------------------------------------------------------
// H-043: modal builder throw → close() cleanup
// ---------------------------------------------------------------------------

test('H-043: build(m, close) is wrapped in try/catch with close() cleanup', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section19_Modal.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // The build call must be inside a try block.
  assert.match(code, /try\s*\{\s*build\(m,\s*close\);\s*\}\s*catch/,
    'build(m, close) must be in a try/catch');
  // The catch must call close() for cleanup.
  const catchIdx = code.indexOf('catch (buildErr)');
  assert.ok(catchIdx > 0, 'catch (buildErr) must exist');
  const afterCatch = code.slice(catchIdx, catchIdx + 200);
  assert.match(afterCatch, /close\(\)/,
    'catch must call close() to pop the stack and restore inert/focus');
});

test('H-043: builder error shows a toast and returns null', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section19_Modal.js'), 'utf8');
  assert.match(src, /Modal failed to open/,
    'error toast must be shown on builder failure');
  assert.match(src, /return null;/,
    'showModal must return null on builder failure (not a close fn)');
});
