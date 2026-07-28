// tests/unit/main/ipc/legacyAdapter.r323.test.js
// ============================================================================
// R3.2.3 — Legacyadapter for the isnetbg:run IPC (ImageOperationResult
// contract migration, backend='isnet').
//
// The legacy `isnetbg:run` envelope is `{ok, code, stderr, outputPath}` —
// already uses `outputPath` (not `path`), so the adapter does NOT need
// a path-mapping step. The legacy failure shape uses `stderr` (not
// `error`) to report the failure reason; the adapter falls back to
// `result.stderr` when `result.error` is absent (R3.2.3 Audit-Fix).
//
// The isnetbg:run handler has a 4-arg signature
// `(srcPath, dstPath, opts, grantId)` (not the single-`args`-object
// form used by inpaint:runOnnx); `wrapInpaintHandler` preserves arity
// via `...args` so both signatures are supported by the same adapter.
//
// Tests:
//   A. happy path: legacy `{ok:true, code, stderr, outputPath}` →
//      canonical 9-field envelope, backend='isnet'.
//   B. error envelope: `{ok:false, code, stderr, outputPath:null}` →
//      validated, error inferred from stderr.
//   C. error wins over stderr: when both are present, error is used.
//   D. drift: no error AND no stderr → REJECTED with diagnostics.
//   E. wrapInpaintHandler with 4-arg handler (isnetbg signature).
//   F. wrapInpaintHandler with 1-arg handler (inpaint compat).
//   G. wrapInpaintHandler catches throws from 4-arg handler.
//   H. wrapInpaintHandler catches throws from 1-arg handler.
//   I. wrapInpaintHandler with backend='isnet' on 4-arg handler
//      sets r.backend === 'isnet' (R3.2.2.AuditFix pattern).
//   J. extras preservation: result.code preserved through adapter
//      (not part of contract; preserved by spread).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const { adaptInpaintResult, wrapInpaintHandler } = require(path.join(ROOT, 'main', 'ipc', 'legacyAdapter'));

// ---------------------------------------------------------------------------
// A — happy path
// ---------------------------------------------------------------------------
test('R3.2.3.A: adaptInpaintResult: isnetbg success envelope is valid, backend=isnet', () => {
  const r = adaptInpaintResult({ ok: true, code: 0, stderr: '', outputPath: '/dst.png' }, 'isnet');
  assert.equal(r.ok, true);
  assert.equal(r.outputPath, '/dst.png', 'A: outputPath must come from result.outputPath (already canonical)');
  assert.equal(r.backend, 'isnet', 'A: backend must be "isnet"');
  assert.equal(r.error, null, 'A: error must be null on success');
  assert.equal(r.code, 0, 'A: extras code must be preserved');
  assert.equal(r.stderr, '', 'A: extras stderr must be preserved');
  assert.equal(r.sourcePath, null);
  assert.equal(r.model, null);
  assert.equal(r.resolvedSettings, null);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.diagnostics, null);
});

// ---------------------------------------------------------------------------
// B — error envelope: stderr inferred
// ---------------------------------------------------------------------------
test('R3.2.3.B: adaptInpaintResult: isnetbg failure envelope uses stderr as error', () => {
  const r = adaptInpaintResult({ ok: false, code: -1, stderr: 'permission denied', outputPath: null }, 'isnet');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'permission denied', 'B: error must fall back to stderr when error is absent');
  assert.equal(r.outputPath, null);
  assert.equal(r.backend, 'isnet');
  assert.equal(r.code, -1, 'B: extras code must be preserved');
  assert.equal(r.stderr, 'permission denied', 'B: extras stderr must be preserved (for diagnostics)');
});

// ---------------------------------------------------------------------------
// C — error wins over stderr
// ---------------------------------------------------------------------------
test('R3.2.3.C: adaptInpaintResult: explicit error wins over stderr', () => {
  const r = adaptInpaintResult({ ok: false, error: 'explicit', code: -1, stderr: 'stderr msg', outputPath: null }, 'isnet');
  assert.equal(r.error, 'explicit', 'C: explicit error must take precedence over stderr');
  assert.equal(r.stderr, 'stderr msg', 'C: stderr still preserved as extra');
});

// ---------------------------------------------------------------------------
// D — drift: no error AND no stderr
// ---------------------------------------------------------------------------
test('R3.2.3.D: adaptInpaintResult: drift (no error AND no stderr) is rejected', () => {
  const r = adaptInpaintResult({ ok: false, code: -1, outputPath: null }, 'isnet');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC envelope drift'),
    'D: error must mention "IPC envelope drift". Got: ' + r.error);
  assert.ok(r._original, 'D: original result must be preserved in _original');
});

// ---------------------------------------------------------------------------
// E — wrapInpaintHandler with 4-arg handler
// ---------------------------------------------------------------------------
test('R3.2.3.E: wrapInpaintHandler supports 4-arg handler (isnetbg signature)', async () => {
  const wrapped = wrapInpaintHandler(
    async (_e, srcPath, dstPath, opts, grantId) => ({
      ok: true, code: 0, stderr: '',
      outputPath: dstPath,
    }),
    'isnet',
  );
  const r = await wrapped({}, '/src.png', '/dst.png', { useGpu: true }, 'grant-1');
  assert.equal(r.ok, true);
  assert.equal(r.outputPath, '/dst.png', 'E: handler receives correct args');
  assert.equal(r.backend, 'isnet');
});

// ---------------------------------------------------------------------------
// F — wrapInpaintHandler with 1-arg handler (inpaint compat)
// ---------------------------------------------------------------------------
test('R3.2.3.F: wrapInpaintHandler supports 1-arg handler (inpaint compat — R3.2.2)', async () => {
  // The R3.2.2 callers use (e, args) signature. After the R3.2.3
  // `...args` refactor of wrapInpaintHandler, both signatures
  // must continue to work.
  const wrapped = wrapInpaintHandler(async (_e, args) => ({
    ok: true, path: args.srcPath,
  }), 'inpaint');
  const r = await wrapped({}, { srcPath: '/x.png' });
  assert.equal(r.ok, true);
  assert.equal(r.path, '/x.png');
  assert.equal(r.outputPath, '/x.png');
  assert.equal(r.backend, 'inpaint');
});

// ---------------------------------------------------------------------------
// G — wrapInpaintHandler catches 4-arg handler throws
// ---------------------------------------------------------------------------
test('R3.2.3.G: wrapInpaintHandler catches throws from 4-arg handler', async () => {
  const wrapped = wrapInpaintHandler(
    async (_e, srcPath, _dstPath, _opts, _grantId) => {
      throw new Error('isnetbg boom');
    },
    'isnet',
  );
  const r = await wrapped({}, '/src.png', '/dst.png', {}, 'grant-1');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC handler threw') && r.error.includes('isnetbg boom'),
    'G: error must mention the throw. Got: ' + r.error);
});

// ---------------------------------------------------------------------------
// H — wrapInpaintHandler catches 1-arg handler throws (regression check)
// ---------------------------------------------------------------------------
test('R3.2.3.H: wrapInpaintHandler still catches throws from 1-arg handler (R3.2.2 compat)', async () => {
  const wrapped = wrapInpaintHandler(async () => {
    throw new Error('inpaint boom');
  });
  const r = await wrapped({}, {});
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('inpaint boom'),
    'H: error must mention the throw. Got: ' + r.error);
});

// ---------------------------------------------------------------------------
// I — backend='isnet' sets r.backend correctly (R3.2.2.AuditFix pattern)
// ---------------------------------------------------------------------------
test('R3.2.3.I: wrapInpaintHandler with backend="isnet" sets r.backend === "isnet"', async () => {
  const wrapped = wrapInpaintHandler(
    async (_e, srcPath, dstPath, _opts, _grantId) => ({
      ok: true, code: 0, stderr: '', outputPath: dstPath,
    }),
    'isnet',
  );
  const r = await wrapped({}, '/src.png', '/dst.png', {}, 'grant-1');
  assert.equal(r.backend, 'isnet',
    'I: backend param "isnet" must propagate. Got: ' + r.backend);
});

// ---------------------------------------------------------------------------
// J — extras preservation (code, stderr) through adapter
// ---------------------------------------------------------------------------
test('R3.2.3.J: adaptInpaintResult: code/stderr extras are preserved (not dropped)', () => {
  const r = adaptInpaintResult({ ok: true, code: 42, stderr: 'harmless warning', outputPath: '/dst.png' }, 'isnet');
  assert.equal(r.code, 42, 'J: code extra must be preserved (not part of contract, but legacy compat)');
  assert.equal(r.stderr, 'harmless warning', 'J: stderr extra must be preserved (for diagnostics)');
  assert.equal(r.outputPath, '/dst.png');
  assert.equal(r.backend, 'isnet');
});

// ---------------------------------------------------------------------------
// K — success-stderr → warnings (R3.2.3.AuditFix)
// ---------------------------------------------------------------------------
test('R3.2.3.K: adaptInpaintResult: ok:true + non-empty stderr → warnings promoted, error:null (R3.2.3.AuditFix)', () => {
  // Without the R3.2.3.AuditFix, the stderr-fallback would have set
  // error=stderr, and the validator would REJECT (ok:true requires
  // error:null). With the fix, stderr is promoted to warnings.
  const r = adaptInpaintResult({ ok: true, code: 0, stderr: 'Model loaded successfully', outputPath: '/dst.png' }, 'isnet');
  assert.equal(r.ok, true);
  assert.equal(r.error, null, 'K: error must be null on success even with non-empty stderr');
  assert.deepEqual(r.warnings, ['Model loaded successfully'],
    'K: stderr must be promoted to warnings array. Got: ' + JSON.stringify(r.warnings));
});

test('R3.2.3.L: adaptInpaintResult: ok:true + empty stderr → no warnings (empty stderr not promoted)', () => {
  // An empty stderr string is a falsy "no warning" signal, not a
  // real warning. The promotion must skip empty values.
  const r = adaptInpaintResult({ ok: true, code: 0, stderr: '', outputPath: '/dst.png' }, 'isnet');
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, [], 'L: empty stderr must not be promoted. Got: ' + JSON.stringify(r.warnings));
  assert.equal(r.error, null);
});

test('R3.2.3.M: adaptInpaintResult: ok:false + error+stderr → error wins, warnings empty (no promotion on failure)', () => {
  // On failure, stderr was the error-source; explicit error wins.
  // stderr is NOT promoted to warnings (it's the error-message).
  const r = adaptInpaintResult({ ok: false, error: 'explicit', code: -1, stderr: 'stderr msg', outputPath: null }, 'isnet');
  assert.equal(r.error, 'explicit', 'M: explicit error must win');
  assert.deepEqual(r.warnings, [], 'M: stderr on failure is not promoted to warnings. Got: ' + JSON.stringify(r.warnings));
  assert.equal(r.stderr, 'stderr msg', 'M: stderr preserved as extra (for diagnostics)');
});
