// tests/unit/contracts/contracts.r31pp.test.js
// ============================================================================
// R3.1 PP — Phasenprüfung-of-Phasenprüfung der R3.1 Boundary Contracts.
//
// The base test (contracts.r31.test.js, A-P) covers the documented
// contract: ok/error/canceled/mutual-exclusion/forward-compat/null-and-array
// rejection/never-throws. This file adds the gaps found by walking
// every contract adversarially a second time:
//
//   Q.  ImageOperationResult: a circular `resolvedSettings` object does
//       NOT cause an infinite loop / stack overflow. The validator
//       walks via JSON-safe fallbacks (we don't recurse through
//       resolvedSettings, only through the top-level envelope).
//   R.  FilePickerResult: a `path` field of the wrong type (number,
//       boolean, object) normalizes to null (we trim strings; non-
//       strings are not strings).
//   S.  ProgressEvent: a `pct` of NaN, +Infinity or -Infinity is
//       REJECTED — silently coercing NaN→0 would mask producer bugs.
//   T.  All 4 contracts: error message strings always start with the
//       contract name (so a log search by contract name finds them).
//   U.  All 4 contracts: the SHAPE constant is exactly the documented
//       field list and is a frozen array (immutable).
//   V.  All 4 contracts: validators are PURE — calling with the same
//       input twice yields equal value (no hidden RNG, no Date.now
//       leakage in the *value*, no global state mutation).
//   W.  ImageOperationResult: a string sourcePath with leading /
//       trailing whitespace is trimmed to a clean absolute path.
//   X.  All 4 contracts: validateX({...}) of an object that contains
//       Symbol field values does not throw (Symbols are dropped via
//       typeof check, not "passed through").
//   Y.  ImageOperationResult: warnings is non-empty array preserved
//       verbatim, including duplicate strings (no dedup at this layer;
//       dedup is the consumer's job).
//   Z.  ProgressEvent: phase field is normalized for backward-compat
//       — a missing phase is NOT silently "init" (validator rejects;
//       downstream consumer can default if they want, but the producer
//       must declare intent).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTRACTS = require(path.join(ROOT, 'src', 'contracts'));

function okTrue(r) { return r && r.ok === true && Array.isArray(r.errors) && r.errors.length === 0; }
function okFalse(r) { return r && r.ok === false && Array.isArray(r.errors) && r.errors.length > 0; }

// ---------------------------------------------------------------------------
// Q
// ---------------------------------------------------------------------------
test('R3.1.Q: ImageOperationResult: a circular resolvedSettings does not infinite-loop', () => {
  const circ = { foo: 1 };
  circ.self = circ; // direct cycle
  const v = {
    ok: true, outputPath: '/x.png', error: null,
    resolvedSettings: circ,
  };
  let r;
  try { r = CONTRACTS.validateImageOperationResult(v); }
  catch (e) { assert.fail('Q: validator threw on circular input — ' + e.message); }
  assert.ok(r, 'Q: must return a result object');
  assert.equal(typeof r.ok, 'boolean', 'Q: must return {ok, ...}');
  // The circular object is treated as an object; we keep it as-is
  // (no deep walk into resolvedSettings).
  assert.equal(typeof r.value.resolvedSettings, 'object', 'Q: resolvedSettings must be preserved as object');
});

// ---------------------------------------------------------------------------
// R
// ---------------------------------------------------------------------------
test('R3.1.R: FilePickerResult: path of wrong type (number/boolean/object) normalizes to null', () => {
  for (const bad of [42, true, false, { a: 1 }, [1, 2]]) {
    const r = CONTRACTS.validateFilePickerResult({ ok: true, canceled: false, path: bad, error: null });
    assert.equal(r.value.path, null, 'R: bad path type ' + typeof bad + ' must normalize to null');
  }
  // Whitespace-only string also → null
  const r2 = CONTRACTS.validateFilePickerResult({ ok: true, canceled: false, path: '   ', error: null });
  assert.equal(r2.value.path, null, 'R: whitespace-only path must normalize to null');
  // Empty string also → null
  const r3 = CONTRACTS.validateFilePickerResult({ ok: true, canceled: false, path: '', error: null });
  assert.equal(r3.value.path, null, 'R: empty path must normalize to null');
});

// ---------------------------------------------------------------------------
// S
// ---------------------------------------------------------------------------
test('R3.1.S: ProgressEvent: pct = NaN, +Infinity, -Infinity is REJECTED (not silently coerced)', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const r = CONTRACTS.validateProgressEvent({ phase: 'infer', pct: bad, operation: 'upscale', runId: 'r1' });
    assert.ok(okFalse(r), 'S: pct=' + String(bad) + ' must be rejected. Got: ' + JSON.stringify(r));
    assert.ok(r.errors.some((e) => e.includes('pct') && e.includes('finite')),
              'S: error must mention "pct" and "finite". Got: ' + JSON.stringify(r.errors));
  }
});

// ---------------------------------------------------------------------------
// T
// ---------------------------------------------------------------------------
test('R3.1.T: All 4 contracts: error message strings always start with the contract name', () => {
  // For each validator, force a reject and assert the error message
  // starts with the contract's qualified name.
  const cases = [
    ['ImageOperationResult', CONTRACTS.validateImageOperationResult, { ok: 'not-boolean' }],
    ['FilePickerResult', CONTRACTS.validateFilePickerResult, { ok: 'not-boolean' }],
    ['ProgressEvent', CONTRACTS.validateProgressEvent, { phase: 'x', pct: 'x', operation: '', runId: '' }],
    ['SettingsSnapshot', CONTRACTS.validateSettingsSnapshot, { source: 'x' }],
  ];
  for (const [name, fn, bad] of cases) {
    const r = fn(bad);
    assert.ok(okFalse(r), 'T/' + name + ': must reject. Got: ' + JSON.stringify(r));
    assert.ok(r.errors.every((e) => e.startsWith(name + ':')),
              'T/' + name + ': all errors must start with "' + name + ':". Got: ' + JSON.stringify(r.errors));
  }
});

// ---------------------------------------------------------------------------
// U
// ---------------------------------------------------------------------------
test('R3.1.U: All 4 contracts: SHAPE constant is exactly the documented field list and is frozen', () => {
  // ImageOperationResult
  assert.ok(Object.isFrozen(CONTRACTS.IMAGE_OPERATION_SHAPE), 'U: IMAGE_OPERATION_SHAPE must be frozen');
  assert.deepEqual([...CONTRACTS.IMAGE_OPERATION_SHAPE], [
    'ok', 'sourcePath', 'outputPath', 'backend', 'model',
    'resolvedSettings', 'warnings', 'error', 'diagnostics',
  ], 'U: IMAGE_OPERATION_SHAPE must match the documented 9 fields');
  // FilePickerResult
  assert.ok(Object.isFrozen(CONTRACTS.FILE_PICKER_SHAPE), 'U: FILE_PICKER_SHAPE must be frozen');
  assert.deepEqual([...CONTRACTS.FILE_PICKER_SHAPE], ['ok', 'canceled', 'path', 'error'],
                   'U: FILE_PICKER_SHAPE must match the documented 4 fields');
  // ProgressEvent
  assert.ok(Object.isFrozen(CONTRACTS.PROGRESS_EVENT_SHAPE), 'U: PROGRESS_EVENT_SHAPE must be frozen');
  assert.deepEqual([...CONTRACTS.PROGRESS_EVENT_SHAPE],
                   ['phase', 'pct', 'operation', 'runId', 'message', 'bytesDownloaded', 'bytesTotal'],
                   'U: PROGRESS_EVENT_SHAPE must match the documented 7 fields');
  // SettingsSnapshot
  assert.ok(Object.isFrozen(CONTRACTS.SETTINGS_SNAPSHOT_SHAPE), 'U: SETTINGS_SNAPSHOT_SHAPE must be frozen');
  assert.deepEqual([...CONTRACTS.SETTINGS_SNAPSHOT_SHAPE],
                   ['source', 'backend', 'model', 'options', 'appliedAt', 'profileName'],
                   'U: SETTINGS_SNAPSHOT_SHAPE must match the documented 6 fields');
});

// ---------------------------------------------------------------------------
// V
// ---------------------------------------------------------------------------
test('R3.1.V: All 4 contracts: validators are PURE — equal input yields equal value (no RNG/Date.now leakage)', () => {
  // For SettingsSnapshot, the value contains appliedAt — we set it
  // explicitly so we can compare.
  const s1 = CONTRACTS.validateSettingsSnapshot({
    source: 'user', options: { x: 1 }, appliedAt: '2026-07-16T12:00:00.000Z',
  });
  const s2 = CONTRACTS.validateSettingsSnapshot({
    source: 'user', options: { x: 1 }, appliedAt: '2026-07-16T12:00:00.000Z',
  });
  assert.deepEqual(s1.value, s2.value, 'V: same SettingsSnapshot input must yield equal value');

  // ImageOperationResult with same input → same value
  const i1 = CONTRACTS.validateImageOperationResult({
    ok: true, outputPath: '/x.png', error: null, warnings: ['a', 'b'],
  });
  const i2 = CONTRACTS.validateImageOperationResult({
    ok: true, outputPath: '/x.png', error: null, warnings: ['a', 'b'],
  });
  assert.deepEqual(i1.value, i2.value, 'V: same ImageOperationResult input must yield equal value');

  // FilePickerResult with same input → same value
  const f1 = CONTRACTS.validateFilePickerResult({ ok: true, canceled: true, path: null, error: null });
  const f2 = CONTRACTS.validateFilePickerResult({ ok: true, canceled: true, path: null, error: null });
  assert.deepEqual(f1.value, f2.value, 'V: same FilePickerResult input must yield equal value');

  // ProgressEvent with same input → same value
  const p1 = CONTRACTS.validateProgressEvent({ phase: 'infer', pct: 50, operation: 'upscale', runId: 'r1' });
  const p2 = CONTRACTS.validateProgressEvent({ phase: 'infer', pct: 50, operation: 'upscale', runId: 'r1' });
  assert.deepEqual(p1.value, p2.value, 'V: same ProgressEvent input must yield equal value');
});

// ---------------------------------------------------------------------------
// W
// ---------------------------------------------------------------------------
test('R3.1.W: ImageOperationResult: sourcePath with leading/trailing whitespace is trimmed', () => {
  const r = CONTRACTS.validateImageOperationResult({
    ok: true, outputPath: '/x.png', sourcePath: '   /in/a.png   ', error: null,
  });
  assert.equal(r.value.sourcePath, '/in/a.png', 'W: sourcePath must be trimmed');
  // Empty / whitespace-only → null
  const r2 = CONTRACTS.validateImageOperationResult({
    ok: true, outputPath: '/x.png', sourcePath: '   ', error: null,
  });
  assert.equal(r2.value.sourcePath, null, 'W: whitespace-only sourcePath must normalize to null');
});

// ---------------------------------------------------------------------------
// X
// ---------------------------------------------------------------------------
test('R3.1.X: All 4 contracts: Symbol field values do not throw (Symbols are dropped, not passed through)', () => {
  const sym = Symbol('s');
  const cases = [
    ['ImageOperationResult', CONTRACTS.validateImageOperationResult, {
      ok: true, outputPath: '/x.png', error: null,
      resolvedSettings: sym, // wrong type — Symbol
    }],
    ['FilePickerResult', CONTRACTS.validateFilePickerResult, {
      ok: true, canceled: false, path: sym, error: null, // wrong type
    }],
    ['ProgressEvent', CONTRACTS.validateProgressEvent, {
      phase: sym, pct: 50, operation: 'upscale', runId: 'r1', // wrong type
    }],
    ['SettingsSnapshot', CONTRACTS.validateSettingsSnapshot, {
      source: 'user', options: sym, appliedAt: '2026-01-01T00:00:00.000Z', // wrong type
    }],
  ];
  for (const [name, fn, bad] of cases) {
    let r;
    try { r = fn(bad); } catch (e) {
      assert.fail('X/' + name + ': validator threw on Symbol field value — ' + e.message);
    }
    assert.ok(r, 'X/' + name + ': must return a result object');
    assert.equal(typeof r.ok, 'boolean', 'X/' + name + ': must return {ok, ...}');
  }
});

// ---------------------------------------------------------------------------
// Y
// ---------------------------------------------------------------------------
test('R3.1.Y: ImageOperationResult: warnings is preserved verbatim (no dedup at this layer)', () => {
  const r = CONTRACTS.validateImageOperationResult({
    ok: true, outputPath: '/x.png', error: null,
    warnings: ['a', 'a', 'b', 'a'], // duplicates
  });
  assert.deepEqual(r.value.warnings, ['a', 'a', 'b', 'a'],
                   'Y: warnings must be preserved verbatim (no dedup)');
});

// ---------------------------------------------------------------------------
// Z
// ---------------------------------------------------------------------------
test('R3.1.Z: ProgressEvent: a missing phase is REJECTED (the producer must declare intent)', () => {
  // The validator must REJECT, not silently default to "init" — a
  // missing phase is a producer bug, not a benign case.
  const r = CONTRACTS.validateProgressEvent({ pct: 50, operation: 'upscale', runId: 'r1' });
  assert.ok(okFalse(r), 'Z: missing phase must be rejected. Got: ' + JSON.stringify(r));
  assert.ok(r.errors.some((e) => e.includes('phase')),
            'Z: error must mention "phase". Got: ' + JSON.stringify(r.errors));
  // The *normalized* value still defaults to "init" (for downstream
  // safety), but the envelope is rejected.
  assert.equal(r.value.phase, 'init', 'Z: normalized phase must default to "init" for downstream safety');
});

// ---------------------------------------------------------------------------
// H2 — Audit-fix (R3.2.AuditFix): the new `ok:false && canceled:true` branch
// is documented and tested. This is the REAL cancel envelope produced
// by `file:pick` (user dismissed the dialog). The contract must
// accept it; renderer code should be aware that path/error are null.
// ---------------------------------------------------------------------------
test('R3.1.H2: FilePickerResult cancel branch (NEW from R3.2.AuditFix): ok:false, canceled:true, path:null, error:null', () => {
  const r = CONTRACTS.validateFilePickerResult({ ok: false, canceled: true });
  assert.ok(okTrue(r), 'H2: { ok:false, canceled:true } must validate. Got: ' + JSON.stringify(r));
  assert.equal(r.value.ok, false, 'H2: ok must be false');
  assert.equal(r.value.canceled, true, 'H2: canceled must be true');
  assert.equal(r.value.path, null, 'H2: path must be null');
  assert.equal(r.value.error, null, 'H2: error must be null');
});

test('R3.1.H3: FilePickerResult: `ok:true && canceled:true` branch is also valid (hypothetical, currently unused in real IPC traffic)', () => {
  // This branch represents a state where the picker succeeded in
  // opening a dialog but the user picked no file. Currently no IPC
  // produces this shape, but the contract accepts it for forwards
  // compatibility.
  const r = CONTRACTS.validateFilePickerResult({ ok: true, canceled: true, path: null, error: null });
  assert.ok(okTrue(r), 'H3: { ok:true, canceled:true, path:null, error:null } must validate. Got: ' + JSON.stringify(r));
  assert.equal(r.value.ok, true);
  assert.equal(r.value.canceled, true);
  assert.equal(r.value.path, null);
  assert.equal(r.value.error, null);
});

// ---------------------------------------------------------------------------
// Z2 — Audit-fix (Phasenprüfung-of-Phasenprüfung-of-Phasenprüfung)
// ---------------------------------------------------------------------------
test('R3.1.Z2: SettingsSnapshot: a missing appliedAt is REJECTED AND normalize() does NOT silently inject a fresh Date.now timestamp (purity, audit-fix)', () => {
  // Phasenprüfung audit found that SettingsSnapshot.normalize() used
  // `new Date().toISOString()` as a fallback when appliedAt was missing,
  // making the normalize() non-pure. Fix: appliedAt is now `null` when
  // missing. The validator still REJECTS the envelope (appliedAt is
  // required) but the normalized value is deterministic.
  const r1 = CONTRACTS.validateSettingsSnapshot({ source: 'user', options: { x: 1 } });
  const r2 = CONTRACTS.validateSettingsSnapshot({ source: 'user', options: { x: 1 } });
  // The envelope is rejected (appliedAt is required).
  assert.ok(okFalse(r1), 'Z2: missing appliedAt must be rejected. Got: ' + JSON.stringify(r1));
  assert.ok(okFalse(r2), 'Z2: missing appliedAt must be rejected (second call). Got: ' + JSON.stringify(r2));
  // The normalized value's appliedAt is null (NOT a fresh timestamp).
  assert.equal(r1.value.appliedAt, null,
    'Z2: normalized appliedAt must be null (not new Date().toISOString()) when missing. Got: ' + r1.value.appliedAt);
  assert.equal(r2.value.appliedAt, null,
    'Z2: normalized appliedAt must be null (not new Date().toISOString()) when missing. Got: ' + r2.value.appliedAt);
  // Purity: the two normalized values are equal (no Date.now leakage).
  assert.deepEqual(r1.value, r2.value,
    'Z2: two calls with missing appliedAt must yield equal normalized values (purity)');
});

test('R3.1.Z3: ImageOperationResult: warnings silently drops non-string entries (documented design choice, audit-test)', () => {
  // Audit found that the warnings filter silently drops non-string
  // entries. This is a documented design choice (vs. rejecting the
  // envelope) but the test case was missing. Now documented.
  const r = CONTRACTS.validateImageOperationResult({
    ok: true, outputPath: '/x.png', error: null,
    warnings: ['a', 1, null, { x: 1 }, 'b', true],
  });
  assert.deepEqual(r.value.warnings, ['a', 'b'],
    'Z3: non-string entries in warnings must be silently dropped. Got: ' + JSON.stringify(r.value.warnings));
});

