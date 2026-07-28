// tests/unit/main/ipc/legacyAdapter.r32.test.js
// ============================================================================
// R3.2 — Legacyadapter (filePicker IPC migration) unit tests.
//
// The adapter wraps the file:pick IPC handler so the result passes
// through `validateFilePickerResult` before reaching the renderer.
// IPC-specific fields (grantId, capabilities) are preserved as
// extensions of the contract.
//
// What the test asserts:
//   A. happy path: a valid handler result passes through unchanged
//      (with the 4 contract fields normalized)
//   B. cancel envelope: { ok:false, canceled:true } is valid
//   C. error envelope: { ok:false, error: '...' } is valid
//   D. happy path with extras: grantId + capabilities preserved
//   E. drift: missing path on ok:true is rejected (clean error envelope)
//   F. drift: both canceled AND error on ok:true is rejected
//   G. drift: both path AND error on ok:false is rejected
//   H. null/undefined input → clean error envelope
//   I. wrapFilePickerHandler: handler throw → clean error envelope
//   J. wrapFilePickerHandler: handler success → adapted result
//   K. wrapFilePickerHandler: handler returns drift → clean error
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const { adaptFilePickerResult, wrapFilePickerHandler } = require(path.join(ROOT, 'main', 'ipc', 'legacyAdapter'));

// ---------------------------------------------------------------------------
// A — happy path (no extension fields)
// ---------------------------------------------------------------------------
test('R3.2.A: adaptFilePickerResult: happy path (ok:true + path) passes through unchanged', () => {
  // The adapter is a VALIDATOR, not a transformer. The original IPC
  // shape is preserved so the renderer (not updated in R3.2 per
  // spec) keeps working.
  const input = { ok: true, path: '/x/y.png' };
  const r = adaptFilePickerResult(input);
  assert.equal(r.ok, true);
  assert.equal(r.path, '/x/y.png');
  // The adapter must NOT add fields the IPC didn't send.
  assert.equal(r.canceled, undefined,
    'A: adapter must NOT add canceled field. Got: ' + JSON.stringify(r));
  assert.equal(r.error, undefined,
    'A: adapter must NOT add error field. Got: ' + JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// B — cancel envelope
// ---------------------------------------------------------------------------
test('R3.2.B: adaptFilePickerResult: cancel envelope is valid + preserved as-is', () => {
  const input = { ok: false, canceled: true };
  const r = adaptFilePickerResult(input);
  assert.equal(r.ok, false);
  assert.equal(r.canceled, true);
  // The adapter does NOT inject the missing `path: null` / `error: null`
  // — that's the contract's NORMALIZED form, not the IPC's shape.
  assert.equal(r.path, undefined);
  assert.equal(r.error, undefined);
});

// ---------------------------------------------------------------------------
// C — error envelope
// ---------------------------------------------------------------------------
test('R3.2.C: adaptFilePickerResult: error envelope is valid + preserved as-is', () => {
  const input = { ok: false, error: 'EACCES' };
  const r = adaptFilePickerResult(input);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'EACCES');
  assert.equal(r.path, undefined);
  assert.equal(r.canceled, undefined);
});

// ---------------------------------------------------------------------------
// D — happy path with extras (grantId + capabilities preserved)
// ---------------------------------------------------------------------------
test('R3.2.D: adaptFilePickerResult: happy path preserves IPC-specific extension fields (grantId + capabilities)', () => {
  const r = adaptFilePickerResult({
    ok: true, path: '/x.png',
    grantId: 'g-123', capabilities: ['read'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.path, '/x.png');
  assert.equal(r.grantId, 'g-123');
  assert.deepEqual(r.capabilities, ['read']);
});

// ---------------------------------------------------------------------------
// E — drift: missing path on ok:true
// ---------------------------------------------------------------------------
test('R3.2.E: adaptFilePickerResult: drift (ok:true + no path) is rejected with clean error envelope', () => {
  const r = adaptFilePickerResult({ ok: true });
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === 'string' && r.error.includes('IPC envelope drift'),
    'E: error must mention "IPC envelope drift". Got: ' + r.error);
  assert.ok(r.error.includes('path') || r.error.includes('non-empty'),
    'E: error must mention the path invariant. Got: ' + r.error);
  // Original preserved for diagnostics.
  assert.ok(r._original, 'E: original result must be preserved in _original for diagnostics');
});

// ---------------------------------------------------------------------------
// F — drift: both canceled:true AND error set on ok:true
// ---------------------------------------------------------------------------
test('R3.2.F: adaptFilePickerResult: drift (ok:true + canceled:true + error) is rejected', () => {
  const r = adaptFilePickerResult({ ok: true, canceled: true, path: '/x.png', error: 'leftover' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC envelope drift'));
  assert.ok(r.error.includes('error:null'),
    'F: error must mention the "ok:true requires error:null" invariant. Got: ' + r.error);
});

// ---------------------------------------------------------------------------
// G — drift: both path AND error set on ok:false
// ---------------------------------------------------------------------------
test('R3.2.G: adaptFilePickerResult: drift (ok:false + path set + error) is rejected', () => {
  const r = adaptFilePickerResult({ ok: false, path: '/x.png', error: 'oops' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC envelope drift'));
  assert.ok(r.error.includes('path:null') || r.error.includes('mutually exclusive'),
    'G: error must mention the mutual-exclusion invariant. Got: ' + r.error);
});

// ---------------------------------------------------------------------------
// H — null / undefined input
// ---------------------------------------------------------------------------
test('R3.2.H: adaptFilePickerResult: null / undefined input → clean error envelope', () => {
  const r1 = adaptFilePickerResult(null);
  assert.equal(r1.ok, false);
  assert.ok(r1.error.includes('null/undefined'),
    'H: error must mention null/undefined. Got: ' + r1.error);
  const r2 = adaptFilePickerResult(undefined);
  assert.equal(r2.ok, false);
  assert.ok(r2.error.includes('null/undefined'),
    'H: error must mention null/undefined. Got: ' + r2.error);
  // Non-object (e.g. array) also rejected.
  const r3 = adaptFilePickerResult([1, 2, 3]);
  assert.equal(r3.ok, false);
  assert.ok(r3.error.includes('non-object'),
    'H: error must mention non-object. Got: ' + r3.error);
});

// ---------------------------------------------------------------------------
// I — wrapFilePickerHandler: handler throw
// ---------------------------------------------------------------------------
test('R3.2.I: wrapFilePickerHandler: handler that throws → clean error envelope (no raw exception leak)', async () => {
  const wrapped = wrapFilePickerHandler(async () => {
    throw new Error('handler boom');
  });
  const r = await wrapped({}, {});
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC handler threw') && r.error.includes('handler boom'),
    'I: error must mention the throw. Got: ' + r.error);
});

// ---------------------------------------------------------------------------
// J — wrapFilePickerHandler: happy path
// ---------------------------------------------------------------------------
test('R3.2.J: wrapFilePickerHandler: handler that returns a valid result → adapted result', async () => {
  const wrapped = wrapFilePickerHandler(async () => ({
    ok: true, path: '/x.png', grantId: 'g-1', capabilities: ['read'],
  }));
  const r = await wrapped({}, {});
  assert.equal(r.ok, true);
  assert.equal(r.path, '/x.png');
  assert.equal(r.grantId, 'g-1');
  assert.deepEqual(r.capabilities, ['read']);
});

// ---------------------------------------------------------------------------
// K — wrapFilePickerHandler: handler returns drift
// ---------------------------------------------------------------------------
test('R3.2.K: wrapFilePickerHandler: handler that returns a drifted shape → clean error envelope', async () => {
  const wrapped = wrapFilePickerHandler(async () => ({
    ok: true, /* missing path */ grantId: 'g-1',
  }));
  const r = await wrapped({}, {});
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC envelope drift'),
    'K: drift must produce a clean error envelope. Got: ' + r.error);
  // The original drifted shape is preserved under _original for diagnostics.
  assert.ok(r._original && r._original.grantId === 'g-1',
    'K: original (drifted) shape must be preserved in _original');
});
