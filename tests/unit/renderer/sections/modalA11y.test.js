// tests/unit/renderer/sections/modalA11y.test.js
// H7-021 regression guard: the modal manager must wire dialog semantics +
// focus management. We assert against the source so a future refactor that
// drops role/aria-modal/focus-trap is caught even though a full DOM test is
// fragile here (the module has many DOM deps).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'renderer', 'sections', 'section19_Modal.js'),
  'utf8',
);

test('H7-021: showModal sets role="dialog"', () => {
  assert.match(SRC, /setAttribute\(\s*['"]role['"]\s*,\s*['"]dialog['"]\s*\)/);
});

test('H7-021: showModal sets aria-modal="true"', () => {
  assert.match(SRC, /setAttribute\(\s*['"]aria-modal['"]\s*,\s*['"]true['"]\s*\)/);
});

test('H7-021: showModal wires aria-labelledby to the first heading', () => {
  assert.match(SRC, /aria-labelledby/);
  assert.match(SRC, /querySelector\(['"]h1,h2,h3['"]\)/);
});

test('H7-021: showModal installs a Tab focus-trap handler', () => {
  assert.match(SRC, /key\s*(?:!==|===)\s*['"]Tab['"]/, 'expected a Tab-key check for the focus trap');
  assert.match(SRC, /addEventListener\(\s*['"]keydown['"]\s*,\s*focusTrapHandler/);
  assert.match(SRC, /removeEventListener\(\s*['"]keydown['"]\s*,\s*focusTrapHandler/, 'the trap must be detached on close');
});

test('H7-021: showModal moves initial focus into the modal', () => {
  assert.match(SRC, /firstFocusable.*\.focus\(\)/);
});

test('H7-021: help buttons expose an aria-label (section23)', () => {
  const help = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'renderer', 'sections', 'section23_Centralized_help_system.js'),
    'utf8',
  );
  assert.match(help, /['"]aria-label['"]\s*:\s*['"]Show help['"]/);
});

test('H7-021: CSS enforces the 16px help-button target (Issue 11) + 24px toolbar buttons', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'renderer', 'styles.css'),
    'utf8',
  );
  // Issue 11: the help "?" buttons were deliberately downsized from 24px to
  // 16px (explicit user requirement — uniform smaller help buttons). The old
  // H7-021 24px minimum for help buttons is superseded for THIS button class
  // only; toolbar/mini buttons keep their 24px touch target.
  assert.match(css, /\.help-btn[\s\S]*?min-width:\s*16px/);
  assert.match(css, /\.btn-mini[\s\S]*?min-height:\s*24px/);
  assert.match(css, /button:focus-visible/);
});

// H8-003: stacked modals must mark lower modals `inert` so a parent trigger
// (e.g. the editor's Heal button under the heal menu) cannot be clicked again
// and stack duplicates. The fix lives in a single reapply helper.
test('H8-003: showModal has an inert-reapply helper that touches lower modals', () => {
  assert.match(SRC, /_reapplyInert/);
  // It must set `inert` on entries below the top, and clear it on the top.
  assert.match(SRC, /setAttribute\(\s*['"]inert['"]\s*,\s*['"]['"]\s*\)/);
  assert.match(SRC, /removeAttribute\(\s*['"]inert['"]\s*\)/);
});
test('H8-003: stack entries carry their DOM node so inert can be applied', () => {
  // The stack entry must record `el` (the modal node), not just id+close.
  assert.match(SRC, /\{\s*id,\s*close:\s*null,\s*el:\s*m\s*\}/);
});
test('H8-003: _reapplyInert runs on open AND on close', () => {
  assert.match(SRC, /_modalStack\.push\(stackEntry\);\s*\n\s*_modalClose\s*=\s*close;\s*\n\s*_reapplyInert\(\)/);
  assert.match(SRC, /_modalStack\.splice\(idx,\s*1\)[\s\S]*?_reapplyInert\(\)/);
});

// H8-003: the editor sub-modals (heal menu / heal popover / cheatsheet /
// heal-models) must pass a stable id so duplicate mashes no-op via stack dedup.
test('H8-003: editor heal menu carries an id', () => {
  const heal = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'renderer', 'overlays', 'imageEditorHeal.js'),
    'utf8',
  );
  assert.match(heal, /id:\s*['"]ie-heal-menu['"]/);
  assert.match(heal, /id:\s*['"]ie-heal-popover['"]/);
});
test('H8-003: editor cheatsheet carries an id', () => {
  const ov = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'renderer', 'overlays', 'imageEditorCheatsheet.js'),
    'utf8',
  );
  assert.match(ov, /id:\s*['"]ie-cheatsheet['"]/);
});
test('H8-003: heal-models overlay carries an id', () => {
  const s = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'renderer', 'overlays', 'imageEditorSettings.js'),
    'utf8',
  );
  assert.match(s, /id:\s*['"]ie-heal-models['"]/);
});
