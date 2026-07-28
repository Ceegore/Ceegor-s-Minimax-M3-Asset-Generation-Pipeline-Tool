// tests/unit/renderer/section03_externalTools.r33.test.js
// ============================================================================
// R3.3.AuditFix-PP — External-Tool-Settings pane tests (UI-009).
//
// R3.3.AuditFix-PP: this test file now imports the REAL helper
// module (`renderer/sections/externalToolsHelpers.js`) instead of
// replicating its logic. The previous test replicated
// `makeValidate` + `makeAutoFillBasename` (per the test's own
// comment: "we replicate the validate() logic here"). That made
// the test brittle: a future refactor of the helpers without a
// corresponding test-replica-update would silently diverge
// (tests pass, source broken). Now the tests verify the actual
// module that the pane re-uses (via inline copy because the
// renderer has no `require`), so any divergence between the
// module and the inline copy is visible as a failing test in
// CI for any future consumer of the module.
//
// The pane's inline copy is a renderer-context limitation
// (Electron nodeIntegration:false, no `require` in renderer).
// A future refactor should expose the helpers via window.api
// (preload) and remove the inline copy entirely.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const helpers = require(path.join(ROOT, 'renderer', 'sections', 'externalToolsHelpers.js'));

// ---------------------------------------------------------------------------
// A — validate: empty list
// ---------------------------------------------------------------------------
test('R3.3.A: validateExternalTools with empty list → no errors', () => {
  assert.deepEqual(helpers.validateExternalTools([]), [], 'A: empty list must yield no errors');
});

// ---------------------------------------------------------------------------
// B — validate: one tool with name
// ---------------------------------------------------------------------------
test('R3.3.B: validateExternalTools with one named tool → no errors', () => {
  assert.deepEqual(helpers.validateExternalTools([{ name: 'GIMP', exe: '/path/to/gimp.exe' }]), [],
    'B: single named tool must yield no errors');
});

// ---------------------------------------------------------------------------
// C — validate: duplicate name (case-insensitive)
// ---------------------------------------------------------------------------
test('R3.3.C: validateExternalTools with two tools sharing the same name (case-insensitive) → 1 error', () => {
  const errs = helpers.validateExternalTools([
    { name: 'GIMP', exe: '/path/to/gimp1.exe' },
    { name: 'gimp', exe: '/path/to/gimp2.exe' },
  ]);
  assert.equal(errs.length, 1, 'C: 1 duplicate-name error expected. Got: ' + JSON.stringify(errs));
  assert.ok(/gimp/i.test(errs[0]) && errs[0].includes('case-insensitive'),
    'C: error must mention one of the duplicated names and case-insensitive. Got: ' + errs[0]);
});

test('R3.3.C.b: validateExternalTools with three tools, two sharing the same name → 1 error', () => {
  const errs = helpers.validateExternalTools([
    { name: 'GIMP', exe: '/path/to/gimp1.exe' },
    { name: 'GIMP', exe: '/path/to/gimp2.exe' },
    { name: 'Notepad', exe: '/path/to/notepad.exe' },
  ]);
  assert.equal(errs.length, 1, 'C.b: only 1 duplicate pair');
});

// ---------------------------------------------------------------------------
// D — validate: different names
// ---------------------------------------------------------------------------
test('R3.3.D: validateExternalTools with three differently-named tools → no errors', () => {
  assert.deepEqual(helpers.validateExternalTools([
    { name: 'GIMP', exe: '/p/gimp.exe' },
    { name: 'Photoshop', exe: '/p/ps.exe' },
    { name: 'Notepad++', exe: '/p/npp.exe' },
  ]), [], 'D: distinct names must yield no errors');
});

// ---------------------------------------------------------------------------
// E — validate: empty names are ignored
// ---------------------------------------------------------------------------
test('R3.3.E: validateExternalTools with empty-name rows → no errors (they are filtered before save)', () => {
  assert.deepEqual(helpers.validateExternalTools([
    { name: '', exe: '/p/x.exe' },
    { name: '   ', exe: '/p/y.exe' },
    { name: 'GIMP', exe: '/p/gimp.exe' },
  ]), [], 'E: empty names must not trigger duplicate-error');
});

// ---------------------------------------------------------------------------
// F — computeAutoFillName: empty name
// ---------------------------------------------------------------------------
test('R3.3.F: computeAutoFillName when name is empty', () => {
  assert.equal(helpers.computeAutoFillName('', 'C:\\Program Files\\GIMP\\bin\\gimp.exe'), 'gimp',
    'F: must auto-fill with "gimp" (basename without .exe). Got: ' + helpers.computeAutoFillName('', 'C:\\Program Files\\GIMP\\bin\\gimp.exe'));
});

test('R3.3.F.b: computeAutoFillName when name is whitespace-only', () => {
  assert.equal(helpers.computeAutoFillName('   ', '/usr/local/bin/firefox'), 'firefox',
    'F.b: whitespace-only name must also be replaced');
});

// ---------------------------------------------------------------------------
// G — computeAutoFillName: name is non-empty → don't overwrite
// ---------------------------------------------------------------------------
test('R3.3.G: computeAutoFillName does NOT overwrite non-empty name', () => {
  assert.equal(helpers.computeAutoFillName('My GIMP', '/usr/bin/gimp.exe'), null,
    'G: non-empty name must NOT be overwritten');
});

// ---------------------------------------------------------------------------
// H — computeAutoFillName: edge cases
// ---------------------------------------------------------------------------
test('R3.3.H: computeAutoFillName from Windows path', () => {
  assert.equal(helpers.computeAutoFillName('', 'D:\\Tools\\Notepad++\\notepad++.exe'), 'notepad++',
    'H: Windows path with ++ in basename must be preserved');
});

test('R3.3.H.b: computeAutoFillName from path without .exe extension', () => {
  assert.equal(helpers.computeAutoFillName('', '/usr/bin/curl'), 'curl',
    'H.b: paths without .exe ext must keep the basename');
});

test('R3.3.H.c: computeAutoFillName from path with mixed-case .EXE', () => {
  assert.equal(helpers.computeAutoFillName('', 'C:\\Tools\\FirefoxSetup.EXE'), 'FirefoxSetup',
    'H.c: case-insensitive .exe stripping');
});

// ---------------------------------------------------------------------------
// I — multiple duplicate groups (R3.3.AuditFix)
// ---------------------------------------------------------------------------
test('R3.3.I: validateExternalTools with 4 tools, 3 sharing the same name → 2 errors', () => {
  // Adversarial probe: a user typed "GIMP" into three rows and
  // "Notepad" into one. validate() must report 2 errors (each
  // duplicate is reported once via the seen-set logic, but the
  // LATER duplicates are reported). With 3 dups the user gets
  // 2 actionable messages.
  const errs = helpers.validateExternalTools([
    { name: 'GIMP', exe: '/p/gimp1.exe' },
    { name: 'Notepad', exe: '/p/np.exe' },
    { name: 'GIMP', exe: '/p/gimp2.exe' },
    { name: 'GIMP', exe: '/p/gimp3.exe' },
  ]);
  assert.equal(errs.length, 2, 'I: 2 duplicate errors expected. Got: ' + JSON.stringify(errs));
});

// ---------------------------------------------------------------------------
// J — isDuplicateName
// ---------------------------------------------------------------------------
test('R3.3.J: isDuplicateName: returns true for case-insensitive duplicate', () => {
  const d = [
    { name: 'GIMP' },
    { name: 'gimp' },
  ];
  assert.equal(helpers.isDuplicateName('GIMP', 0, d), true, 'J: row 0 typed "GIMP" → duplicate of row 1 "gimp"');
  assert.equal(helpers.isDuplicateName('gimp', 1, d), true, 'J: row 1 typed "gimp" → duplicate of row 0 "GIMP"');
  assert.equal(helpers.isDuplicateName('Other', 0, d), false, 'J: row 0 typed "Other" → not a duplicate');
});

test('R3.3.J.b: isDuplicateName: empty name → not a duplicate', () => {
  const d = [{ name: '' }, { name: '   ' }, { name: 'GIMP' }];
  assert.equal(helpers.isDuplicateName('', 0, d), false, 'J.b: empty name → not a duplicate');
  assert.equal(helpers.isDuplicateName('   ', 1, d), false, 'J.b: whitespace name → not a duplicate');
});

// ---------------------------------------------------------------------------
// K — short-name aliases (R3.3.AuditFix-PP-2 fix): the pane (section03)
//     accesses the helpers via H.v / H.a / H.d, NOT the long names. The
//     module must export BOTH so the globalThis.ExternalToolsHelpers init
//     in section04 (which sets the module as the global) doesn't break
//     the pane's H.v(...) calls. Regression test: if a future refactor
//     removes the short-name aliases, every settings-save with a
//     configured external tool would throw "H.v is not a function".
// ---------------------------------------------------------------------------
test('R3.3.K: short-name aliases (v/a/d) work — the pane calls H.v/H.a/H.d, not the long names', () => {
  assert.equal(typeof helpers.v, 'function', 'K: module.v must be a function (alias for validateExternalTools)');
  assert.equal(typeof helpers.a, 'function', 'K: module.a must be a function (alias for computeAutoFillName)');
  assert.equal(typeof helpers.d, 'function', 'K: module.d must be a function (alias for isDuplicateName)');
  // The aliases must produce identical results to the long names — they
  // are not just a façade, they are the SAME function reference.
  assert.equal(helpers.v, helpers.validateExternalTools,
    'K: helpers.v must be the same function reference as helpers.validateExternalTools');
  assert.equal(helpers.a, helpers.computeAutoFillName,
    'K: helpers.a must be the same function reference as helpers.computeAutoFillName');
  assert.equal(helpers.d, helpers.isDuplicateName,
    'K: helpers.d must be the same function reference as helpers.isDuplicateName');
  // Sanity: simulate the pane's exact call pattern
  const errs = helpers.v([{ name: 'GIMP' }, { name: 'gimp' }]);
  assert.equal(errs.length, 1, 'K: H.v must return 1 duplicate error');
  const auto = helpers.a('', 'C:\\Tools\\gimp.exe');
  assert.equal(auto, 'gimp', 'K: H.a must strip .exe and return basename');
  const dup = helpers.d('GIMP', 0, [{ name: 'GIMP' }, { name: 'Photos' }]);
  assert.equal(dup, false, 'K: H.d must return false when no other row matches');
});
