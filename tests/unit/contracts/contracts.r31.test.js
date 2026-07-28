// tests/unit/contracts/contracts.r31.test.js
// ============================================================================
// R3.1 — Canonical boundary contracts unit tests.
//
// The four contracts (imageOperationResult, filePickerResult,
// progressEvent, settingsSnapshot) are pure functions. These tests
// cover the contract invariants called out in design contract §Phase R3.1:
//
//   "Kein Consumer errät Feldnamen oder interpretiert `null` als
//    Erfolg." — every validator must (a) require `ok` as a boolean,
//    (b) accept only the documented shape, (c) reject malformed
//    input without throwing, and (d) normalize unknown fields out.
//
//   A.  ImageOperationResult happy path: ok:true, all fields present
//   B.  ImageOperationResult ok:true + non-null error → REJECT
//   C.  ImageOperationResult ok:true + missing outputPath → REJECT
//   D.  ImageOperationResult ok:false + missing error → REJECT
//   E.  ImageOperationResult forwards-compat: unknown fields dropped
//   F.  ImageOperationResult: warnings always an array
//   G.  FilePickerResult happy path: ok:true, canceled:false, path set
//   H.  FilePickerResult cancel: ok:true, canceled:true, path:null
//   I.  FilePickerResult error: ok:false + path field → REJECT
//       (path and error are mutually exclusive)
//   J.  ProgressEvent: pct out of range → REJECT
//   K.  ProgressEvent: phase not in allowlist → REJECT
//   L.  SettingsSnapshot: source not in allowlist → REJECT
//   M.  SettingsSnapshot: profile source without profileName → REJECT
//   N.  All four contracts: null/undefined input → REJECT (never
//       "interpret null as success")
//   O.  All four contracts: array input → REJECT (never treat an
//       array as a successful result object)
//   P.  All four contracts: validator never throws on adversarial
//       input (cycles, symbols, frozen objects, prototypes, …)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTRACTS = require(path.join(ROOT, 'src', 'contracts'));

function okTrue(r) { return r && r.ok === true && Array.isArray(r.errors) && r.errors.length === 0; }
function okFalse(r) { return r && r.ok === false && Array.isArray(r.errors) && r.errors.length > 0; }

// ---------------------------------------------------------------------------
// A
// ---------------------------------------------------------------------------
test('R3.1.A: ImageOperationResult happy path validates and normalizes', () => {
  const r = CONTRACTS.validateImageOperationResult({
    ok: true,
    sourcePath: '/in/a.png',
    outputPath: '/out/b.png',
    backend: 'sharp',
    model: null,
    resolvedSettings: { quality: 90 },
    warnings: ['stripped metadata'],
    error: null,
    diagnostics: { durationMs: 42 },
  });
  assert.ok(okTrue(r), 'A: happy path must validate. Got: ' + JSON.stringify(r));
  assert.equal(r.value.ok, true);
  assert.equal(r.value.sourcePath, '/in/a.png');
  assert.equal(r.value.outputPath, '/out/b.png');
  assert.equal(r.value.backend, 'sharp');
  assert.deepEqual(r.value.warnings, ['stripped metadata']);
  assert.equal(r.value.diagnostics.durationMs, 42);
});

// ---------------------------------------------------------------------------
// B
// ---------------------------------------------------------------------------
test('R3.1.B: ImageOperationResult ok:true + non-null error is REJECTED', () => {
  const r = CONTRACTS.validateImageOperationResult({
    ok: true, outputPath: '/x.png', error: 'leftover error message',
  });
  assert.ok(okFalse(r), 'B: ok:true with error must be rejected. Got: ' + JSON.stringify(r));
  assert.ok(r.errors.some((e) => e.includes('ok:true requires error:null')),
            'B: error must mention the invariant. Got: ' + JSON.stringify(r.errors));
});

// ---------------------------------------------------------------------------
// C
// ---------------------------------------------------------------------------
test('R3.1.C: ImageOperationResult ok:true + missing outputPath is REJECTED', () => {
  const r = CONTRACTS.validateImageOperationResult({ ok: true, error: null });
  assert.ok(okFalse(r), 'C: ok:true without outputPath must be rejected. Got: ' + JSON.stringify(r));
  assert.ok(r.errors.some((e) => e.includes('non-empty outputPath')),
            'C: error must mention outputPath. Got: ' + JSON.stringify(r.errors));
});

// ---------------------------------------------------------------------------
// D
// ---------------------------------------------------------------------------
test('R3.1.D: ImageOperationResult ok:false + missing error is REJECTED', () => {
  const r = CONTRACTS.validateImageOperationResult({ ok: false, error: null });
  assert.ok(okFalse(r), 'D: ok:false without error must be rejected. Got: ' + JSON.stringify(r));
  assert.ok(r.errors.some((e) => e.includes('ok:false requires a non-empty error')),
            'D: error must mention the invariant. Got: ' + JSON.stringify(r.errors));
});

// ---------------------------------------------------------------------------
// E
// ---------------------------------------------------------------------------
test('R3.1.E: ImageOperationResult forwards-compat: unknown fields are dropped', () => {
  const r = CONTRACTS.validateImageOperationResult({
    ok: true,
    outputPath: '/x.png',
    error: null,
    futureBackendFlag: 'foo',
    nestedWeird: { a: 1 },
  });
  assert.ok(okTrue(r), 'E: extra fields must not invalidate. Got: ' + JSON.stringify(r));
  assert.equal(r.value.futureBackendFlag, undefined, 'E: unknown field must be dropped');
  assert.equal(r.value.nestedWeird, undefined, 'E: unknown nested field must be dropped');
  assert.deepEqual(Object.keys(r.value).sort(), [
    'backend', 'diagnostics', 'error', 'model', 'ok', 'outputPath',
    'resolvedSettings', 'sourcePath', 'warnings',
  ], 'E: shape must be exactly the 9 documented fields');
});

// ---------------------------------------------------------------------------
// F
// ---------------------------------------------------------------------------
test('R3.1.F: ImageOperationResult: warnings is always an array (non-array → [])', () => {
  const r = CONTRACTS.validateImageOperationResult({
    ok: true, outputPath: '/x.png', error: null, warnings: 'not an array',
  });
  assert.ok(okTrue(r), 'F: warnings coercion must not invalidate. Got: ' + JSON.stringify(r));
  assert.deepEqual(r.value.warnings, [], 'F: non-array warnings must coerce to []');
  // missing warnings → [] not null
  const r2 = CONTRACTS.validateImageOperationResult({ ok: true, outputPath: '/x.png', error: null });
  assert.deepEqual(r2.value.warnings, [], 'F: missing warnings must coerce to []');
});

// ---------------------------------------------------------------------------
// G
// ---------------------------------------------------------------------------
test('R3.1.G: FilePickerResult happy path: ok:true, canceled:false, path set', () => {
  const r = CONTRACTS.validateFilePickerResult({
    ok: true, canceled: false, path: '/x/y.png', error: null,
  });
  assert.ok(okTrue(r), 'G: happy path must validate. Got: ' + JSON.stringify(r));
  assert.equal(r.value.path, '/x/y.png');
  assert.equal(r.value.error, null);
});

// ---------------------------------------------------------------------------
// H
// ---------------------------------------------------------------------------
test('R3.1.H: FilePickerResult cancel: ok:true, canceled:true, path:null, error:null', () => {
  const r = CONTRACTS.validateFilePickerResult({ ok: true, canceled: true, path: null, error: null });
  assert.ok(okTrue(r), 'H: cancel envelope must validate. Got: ' + JSON.stringify(r));
  assert.equal(r.value.canceled, true);
  assert.equal(r.value.path, null);
});

// ---------------------------------------------------------------------------
// I
// ---------------------------------------------------------------------------
test('R3.1.I: FilePickerResult error: ok:false + path field is REJECTED (mutually exclusive)', () => {
  const r = CONTRACTS.validateFilePickerResult({
    ok: false, canceled: false, path: '/x.png', error: 'boom',
  });
  assert.ok(okFalse(r), 'I: ok:false with path must be rejected. Got: ' + JSON.stringify(r));
  assert.ok(r.errors.some((e) => e.includes('path:null') || e.includes('mutually exclusive')),
            'I: error must mention the mutual-exclusion invariant. Got: ' + JSON.stringify(r.errors));
});

// ---------------------------------------------------------------------------
// J
// ---------------------------------------------------------------------------
test('R3.1.J: ProgressEvent: pct out of [0,100] is REJECTED (not silently clamped)', () => {
  // The validator must REJECT, not silently clamp — silent clamping
  // is exactly the kind of "interpret null as success" antipattern
  // the R3.1 invariant warns against.
  const r1 = CONTRACTS.validateProgressEvent({ phase: 'infer', pct: 150, operation: 'upscale', runId: 'r1' });
  assert.ok(okFalse(r1), 'J: pct=150 must be rejected. Got: ' + JSON.stringify(r1));
  const r2 = CONTRACTS.validateProgressEvent({ phase: 'infer', pct: -1, operation: 'upscale', runId: 'r1' });
  assert.ok(okFalse(r2), 'J: pct=-1 must be rejected. Got: ' + JSON.stringify(r2));
  // The *normalized* value is still clamped (for downstream consumers),
  // but the *envelope* is rejected.
  assert.equal(r1.value.pct, 100, 'J: normalized pct must be clamped to 100 even on rejection');
  assert.equal(r2.value.pct, 0, 'J: normalized pct must be clamped to 0 even on rejection');
});

// ---------------------------------------------------------------------------
// K
// ---------------------------------------------------------------------------
test('R3.1.K: ProgressEvent: phase not in allowlist is REJECTED', () => {
  const r = CONTRACTS.validateProgressEvent({ phase: 'magic', pct: 50, operation: 'upscale', runId: 'r1' });
  assert.ok(okFalse(r), 'K: unknown phase must be rejected. Got: ' + JSON.stringify(r));
  assert.ok(r.errors.some((e) => e.includes('phase') && e.includes('init') && e.includes('download')),
            'K: error must list the allowlist. Got: ' + JSON.stringify(r.errors));
});

// ---------------------------------------------------------------------------
// L
// ---------------------------------------------------------------------------
test('R3.1.L: SettingsSnapshot: source not in allowlist is REJECTED', () => {
  const r = CONTRACTS.validateSettingsSnapshot({
    source: 'magic', options: {}, appliedAt: new Date().toISOString(),
  });
  assert.ok(okFalse(r), 'L: unknown source must be rejected. Got: ' + JSON.stringify(r));
  assert.ok(r.errors.some((e) => e.includes('source') && e.includes('default') && e.includes('profile')),
            'L: error must list the allowlist. Got: ' + JSON.stringify(r.errors));
});

// ---------------------------------------------------------------------------
// M
// ---------------------------------------------------------------------------
test('R3.1.M: SettingsSnapshot: profile source without profileName is REJECTED', () => {
  const r = CONTRACTS.validateSettingsSnapshot({
    source: 'profile', options: {}, appliedAt: new Date().toISOString(),
  });
  assert.ok(okFalse(r), 'M: profile without name must be rejected. Got: ' + JSON.stringify(r));
  assert.ok(r.errors.some((e) => e.includes('profileName')),
            'M: error must mention profileName. Got: ' + JSON.stringify(r.errors));
  // With a profile name: validates.
  const r2 = CONTRACTS.validateSettingsSnapshot({
    source: 'profile', profileName: 'Foo', options: {}, appliedAt: new Date().toISOString(),
  });
  assert.ok(okTrue(r2), 'M: profile with name must validate. Got: ' + JSON.stringify(r2));
});

// ---------------------------------------------------------------------------
// N
// ---------------------------------------------------------------------------
test('R3.1.N: All four contracts: null/undefined input is REJECTED (never interpret null as success)', () => {
  const tests = [
    ['ImageOperationResult', CONTRACTS.validateImageOperationResult],
    ['FilePickerResult', CONTRACTS.validateFilePickerResult],
    ['ProgressEvent', CONTRACTS.validateProgressEvent],
    ['SettingsSnapshot', CONTRACTS.validateSettingsSnapshot],
  ];
  for (const [name, fn] of tests) {
    const r1 = fn(null);
    assert.ok(okFalse(r1), 'N/' + name + ': null must be rejected. Got: ' + JSON.stringify(r1));
    const r2 = fn(undefined);
    assert.ok(okFalse(r2), 'N/' + name + ': undefined must be rejected. Got: ' + JSON.stringify(r2));
  }
});

// ---------------------------------------------------------------------------
// O
// ---------------------------------------------------------------------------
test('R3.1.O: All four contracts: array input is REJECTED (never treat an array as a success envelope)', () => {
  const arr = [1, 2, 3];
  for (const [name, fn] of [
    ['ImageOperationResult', CONTRACTS.validateImageOperationResult],
    ['FilePickerResult', CONTRACTS.validateFilePickerResult],
    ['ProgressEvent', CONTRACTS.validateProgressEvent],
    ['SettingsSnapshot', CONTRACTS.validateSettingsSnapshot],
  ]) {
    const r = fn(arr);
    assert.ok(okFalse(r), 'O/' + name + ': array must be rejected. Got: ' + JSON.stringify(r));
  }
});

// ---------------------------------------------------------------------------
// P
// ---------------------------------------------------------------------------
test('R3.1.P: All four contracts: validator NEVER throws on adversarial input', () => {
  const adversarialInputs = [
    null, undefined, 0, 1, '', 'string', true, false,
    [], [1, 2, 3], { ok: 'not a boolean' }, { ok: 1 }, { ok: 0 },
    { __proto__: null, ok: true, outputPath: '/x.png' },
    Object.freeze({ ok: true, outputPath: '/x.png', error: null }),
    { ok: true, outputPath: Symbol('s') },
  ];
  const validators = [
    CONTRACTS.validateImageOperationResult,
    CONTRACTS.validateFilePickerResult,
    CONTRACTS.validateProgressEvent,
    CONTRACTS.validateSettingsSnapshot,
  ];
  for (const fn of validators) {
    for (const inp of adversarialInputs) {
      let r;
      try { r = fn(inp); } catch (e) {
        assert.fail('P: ' + fn.name + ' threw on ' + Object.prototype.toString.call(inp) + ' — ' + e.message);
      }
      assert.ok(r && typeof r.ok === 'boolean' && Array.isArray(r.errors),
                'P: ' + fn.name + ' must return {ok, errors, value} on adversarial input. Got: ' + JSON.stringify(r));
    }
  }
});
