// tests/unit/main/ipc/legacyAdapter.r322.test.js
// ============================================================================
// R3.2.2 — Legacyadapter for the inpaint:runOnnx IPC (ImageOperationResult
// contract migration). R3.2.2.AuditFix extended the adapter with a
// `backend` parameter (default 'inpaint', overridable to 'telea' for
// the inpaint:runTelea IPC) so the same adapter works for both
// backends. R3.2.2.AuditFix also fixed `diagnostics` to be preserved
// (was hardcoded null, violated "Adapter is VALIDATOR not
// TRANSFORMER" pattern).
//
// The legacy `inpaint:runOnnx` envelope is `{ ok, path, error, code, stderr }`
// — uses `path` (not `outputPath`). The contract requires 9 fields:
// `{ ok, sourcePath, outputPath, backend, model, resolvedSettings,
// warnings, error, diagnostics }`. The adapter maps `path` →
// `outputPath` and sets the other contract fields to sensible
// defaults (warnings: [], sourcePath: null, etc.).
//
// Inpaint is non-interactive — there is no cancel branch (unlike
// file:pick).
//
// Tests:
//   A. happy path: legacy `{ ok:true, path }` → canonical 9-field
//      envelope with `path` alias preserved (renderer compatibility).
//   B. error envelope: `{ ok:false, error }` → validated
//   C. inpaint failure with stderr context (real runOnnx failure shape)
//   D. drift: `ok:true` without `path` → REJECTED
//   E. drift: `ok:false` without `error` → REJECTED
//   F. null / undefined / array input → clean error envelope
//   G. wrapInpaintHandler catches handler throws
//   H. wrapInpaintHandler passt valid result durch
//   I. wrapInpaintHandler catches handler-returned drift
//   J. backend parameter: wrapInpaintHandler(h, 'telea') → r.backend === 'telea'
//      (R3.2.2.AuditFix; the parameter is the only differentiator
//      between the runOnnx and runTelea envelopes)
//   K. extras preservation: width/height from runTelea are preserved
//      through the adapter (not dropped — "Adapter is VALIDATOR not
//      TRANSFORMER" pattern)
//   L. diagnostics preservation: result.diagnostics (object) is
//      preserved on the contract's diagnostics field
//      (R3.2.2.AuditFix; was hardcoded null in the original R3.2.2)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const { adaptInpaintResult, wrapInpaintHandler } = require(path.join(ROOT, 'main', 'ipc', 'legacyAdapter'));

// ---------------------------------------------------------------------------
// A — happy path
// ---------------------------------------------------------------------------
test('R3.2.2.A: adaptInpaintResult: happy path maps legacy {ok:true, path} to canonical 9-field envelope', () => {
  const r = adaptInpaintResult({ ok: true, path: '/x.png' });
  assert.equal(r.ok, true);
  assert.equal(r.path, '/x.png', 'A: legacy `path` field must be preserved (renderer compat)');
  assert.equal(r.outputPath, '/x.png', 'A: contract `outputPath` must be set to the same value');
  assert.equal(r.backend, 'inpaint', 'A: backend must default to "inpaint"');
  assert.equal(r.model, null, 'A: model must default to null');
  assert.equal(r.resolvedSettings, null, 'A: resolvedSettings must default to null');
  assert.deepEqual(r.warnings, [], 'A: warnings must default to []');
  assert.equal(r.error, null, 'A: error must be null on success');
  assert.equal(r.diagnostics, null, 'A: diagnostics must default to null');
  assert.equal(r.sourcePath, null, 'A: sourcePath must default to null (legacy envelope has no sourcePath)');
});

// ---------------------------------------------------------------------------
// B — error envelope
// ---------------------------------------------------------------------------
test('R3.2.2.B: adaptInpaintResult: error envelope is valid', () => {
  const r = adaptInpaintResult({ ok: false, error: 'EACCES' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'EACCES');
  assert.equal(r.outputPath, null, 'B: outputPath must be null on failure');
});

// ---------------------------------------------------------------------------
// C — inpaint failure with stderr context (real runOnnx failure shape)
// ---------------------------------------------------------------------------
test('R3.2.2.C: adaptInpaintResult: inpaint failure with stderr context is valid', () => {
  // The real inpaint IPC failure shape is `{ ok: false, error: msg }` —
  // there's no user-cancel branch because inpaint is non-interactive.
  const r = adaptInpaintResult({ ok: false, error: 'inpaint failed: mask too small' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'inpaint failed: mask too small');
  assert.equal(r.outputPath, null);
  assert.equal(r.backend, 'inpaint');
});

// ---------------------------------------------------------------------------
// D — drift: ok:true without path
// ---------------------------------------------------------------------------
test('R3.2.2.D: adaptInpaintResult: drift (ok:true without path) is rejected with clean error envelope', () => {
  const r = adaptInpaintResult({ ok: true });
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === 'string' && r.error.includes('IPC envelope drift'),
    'D: error must mention "IPC envelope drift". Got: ' + r.error);
  assert.ok(r.error.includes('outputPath') || r.error.includes('non-empty'),
    'D: error must mention outputPath invariant. Got: ' + r.error);
  assert.ok(r._original, 'D: original result must be preserved in _original');
});

// ---------------------------------------------------------------------------
// E — drift: ok:false without error
// ---------------------------------------------------------------------------
test('R3.2.2.E: adaptInpaintResult: drift (ok:false without error) is rejected with clean error envelope', () => {
  const r = adaptInpaintResult({ ok: false });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC envelope drift'),
    'E: error must mention drift. Got: ' + r.error);
});

// ---------------------------------------------------------------------------
// F — null / undefined / array
// ---------------------------------------------------------------------------
test('R3.2.2.F: adaptInpaintResult: null / undefined / array input → clean error envelope', () => {
  const r1 = adaptInpaintResult(null);
  assert.equal(r1.ok, false);
  assert.ok(r1.error.includes('null/undefined'));
  const r2 = adaptInpaintResult(undefined);
  assert.equal(r2.ok, false);
  assert.ok(r2.error.includes('null/undefined'));
  const r3 = adaptInpaintResult([1, 2, 3]);
  assert.equal(r3.ok, false);
  assert.ok(r3.error.includes('non-object'));
});

// ---------------------------------------------------------------------------
// G — wrapInpaintHandler: handler throw
// ---------------------------------------------------------------------------
test('R3.2.2.G: wrapInpaintHandler: handler that throws → clean error envelope', async () => {
  const wrapped = wrapInpaintHandler(async () => {
    throw new Error('inpaint boom');
  });
  const r = await wrapped({}, {});
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC handler threw') && r.error.includes('inpaint boom'),
    'G: error must mention the throw. Got: ' + r.error);
});

// ---------------------------------------------------------------------------
// H — wrapInpaintHandler: happy path
// ---------------------------------------------------------------------------
test('R3.2.2.H: wrapInpaintHandler: handler that returns a valid result → adapted result', async () => {
  const wrapped = wrapInpaintHandler(async () => ({ ok: true, path: '/x.png' }));
  const r = await wrapped({}, {});
  assert.equal(r.ok, true);
  assert.equal(r.path, '/x.png');
  assert.equal(r.outputPath, '/x.png');
  assert.equal(r.backend, 'inpaint');
});

// ---------------------------------------------------------------------------
// I — wrapInpaintHandler: handler returns drift
// ---------------------------------------------------------------------------
test('R3.2.2.I: wrapInpaintHandler: handler that returns a drifted shape → clean error envelope', async () => {
  const wrapped = wrapInpaintHandler(async () => ({
    ok: true, /* missing path */ grantId: 'g-1',
  }));
  const r = await wrapped({}, {});
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC envelope drift'),
    'I: drift must produce a clean error envelope. Got: ' + r.error);
  assert.ok(r._original && r._original.grantId === 'g-1',
    'I: original (drifted) shape must be preserved in _original');
});

// ---------------------------------------------------------------------------
// J — backend parameter (R3.2.2.AuditFix)
// ---------------------------------------------------------------------------
test('R3.2.2.J: wrapInpaintHandler backend param: "telea" sets r.backend === "telea" (R3.2.2.AuditFix)', async () => {
  const wrapped = wrapInpaintHandler(async () => ({ ok: true, path: '/x.png' }), 'telea');
  const r = await wrapped({}, {});
  assert.equal(r.ok, true);
  assert.equal(r.backend, 'telea',
    'J: backend param "telea" must propagate to r.backend. Got: ' + r.backend);
  assert.equal(r.path, '/x.png');
  assert.equal(r.outputPath, '/x.png');
});

test('R3.2.2.J.b: wrapInpaintHandler backend param: "inpaint" sets r.backend === "inpaint"', async () => {
  const wrapped = wrapInpaintHandler(async () => ({ ok: true, path: '/x.png' }), 'inpaint');
  const r = await wrapped({}, {});
  assert.equal(r.backend, 'inpaint',
    'J.b: backend param "inpaint" must propagate. Got: ' + r.backend);
});

test('R3.2.2.J.c: adaptInpaintResult: backend param "telea" sets backend field directly', () => {
  const r = adaptInpaintResult({ ok: true, path: '/x.png' }, 'telea');
  assert.equal(r.backend, 'telea',
    'J.c: adaptInpaintResult with backend="telea" must set backend field. Got: ' + r.backend);
});

// ---------------------------------------------------------------------------
// K — extras preservation (R3.2.2.AuditFix; "Adapter is VALIDATOR not TRANSFORMER")
// ---------------------------------------------------------------------------
test('R3.2.2.K: adaptInpaintResult: extras (width, height) from runTelea are preserved', () => {
  // runTelea returns { ok, path, width, height } — the adapter must
  // preserve the original fields (renderer compat) AND add the
  // canonical 9-field shape on top.
  const r = adaptInpaintResult({ ok: true, path: '/x.png', width: 100, height: 200 }, 'telea');
  assert.equal(r.ok, true);
  assert.equal(r.path, '/x.png');
  assert.equal(r.outputPath, '/x.png');
  assert.equal(r.width, 100, 'K: width extra must be preserved');
  assert.equal(r.height, 200, 'K: height extra must be preserved');
  assert.equal(r.backend, 'telea');
});

// ---------------------------------------------------------------------------
// L — diagnostics preservation (R3.2.2.AuditFix; was hardcoded null)
// ---------------------------------------------------------------------------
test('R3.2.2.L: adaptInpaintResult: result.diagnostics (object) is preserved on contract diagnostics field', () => {
  // R3.2.2.AuditFix: diagnostics was hardcoded null in the original
  // R3.2.2, which violated "Adapter is VALIDATOR not TRANSFORMER".
  // A handler that returns diagnostics must see them on the
  // canonical envelope.
  const diag = { timingMs: 1234, modelHash: 'abc' };
  const r = adaptInpaintResult({ ok: true, path: '/x.png', diagnostics: diag }, 'telea');
  assert.deepEqual(r.diagnostics, diag,
    'L: diagnostics must be preserved from result. Got: ' + JSON.stringify(r.diagnostics));
});

test('R3.2.2.L.b: adaptInpaintResult: result.diagnostics (non-object: number) is dropped to null', () => {
  // non-object diagnostics: normalizer drops (per contract: "object | null")
  const r = adaptInpaintResult({ ok: true, path: '/x.png', diagnostics: 42 }, 'telea');
  assert.equal(r.diagnostics, null,
    'L.b: non-object diagnostics must normalize to null. Got: ' + r.diagnostics);
});
