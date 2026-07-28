// tests/unit/main/ipc/legacyAdapter.r324.test.js
// ============================================================================
// R3.2.4 — Legacyadapter for the upscale:realesrgan:run IPC
// (ImageOperationResult contract migration, backend='realesrgan').
//
// The legacy `upscale:realesrgan:run` envelope is
// `{ok, code, stderr, outputPath}` — same shape as isnetbg:run
// (R3.2.3), but with backend 'realesrgan'. The handler has a
// 5-arg signature `(event, srcPath, dstPath, opts, grantId)`
// (one more arg than isnetbg because of the progressKey + event
// for `event.sender.send` progress forwarding). `wrapInpaintHandler`
// preserves arity via `...args`.
//
// Tests:
//   A. happy path: legacy `{ok:true, code, stderr, outputPath}` →
//      canonical 9-field envelope, backend='realesrgan'.
//   B. error envelope: `{ok:false, code, stderr, outputPath:null}` →
//      validated, error inferred from stderr.
//   C. drift: no error AND no stderr → REJECTED with diagnostics.
//   D. wrapInpaintHandler supports 5-arg handler (upscale signature).
//   E. wrapInpaintHandler with backend='realesrgan' sets r.backend
//      correctly on 5-arg handler.
//   F. wrapInpaintHandler catches throws from 5-arg handler.
//   G. extras (code, stderr) preserved through adapter.
//   H. ok:true + non-empty stderr → warnings promoted (R3.2.3 Audit-Fix
//      regression check; realsrgan stderr may carry non-fatal
//      CLI output even on success).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const { adaptInpaintResult, wrapInpaintHandler } = require(path.join(ROOT, 'main', 'ipc', 'legacyAdapter'));

// ---------------------------------------------------------------------------
// A — happy path
// ---------------------------------------------------------------------------
test('R3.2.4.A: adaptInpaintResult: realsrgan success envelope is valid, backend=realesrgan', () => {
  const r = adaptInpaintResult({ ok: true, code: 0, stderr: '', outputPath: '/dst.png' }, 'realesrgan');
  assert.equal(r.ok, true);
  assert.equal(r.outputPath, '/dst.png', 'A: outputPath must come from result.outputPath');
  assert.equal(r.backend, 'realesrgan', 'A: backend must be "realesrgan"');
  assert.equal(r.error, null, 'A: error must be null on success');
  assert.equal(r.code, 0, 'A: extras code preserved');
  assert.equal(r.stderr, '', 'A: extras stderr preserved');
  assert.equal(r.sourcePath, null);
  assert.equal(r.model, null);
  assert.equal(r.resolvedSettings, null);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.diagnostics, null);
});

// ---------------------------------------------------------------------------
// B — error envelope
// ---------------------------------------------------------------------------
test('R3.2.4.B: adaptInpaintResult: realsrgan failure envelope uses stderr as error', () => {
  const r = adaptInpaintResult({ ok: false, code: -1, stderr: 'EACCES: permission denied', outputPath: null }, 'realesrgan');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'EACCES: permission denied', 'B: error must fall back to stderr');
  assert.equal(r.outputPath, null);
  assert.equal(r.backend, 'realesrgan');
  assert.equal(r.code, -1);
});

// ---------------------------------------------------------------------------
// C — drift
// ---------------------------------------------------------------------------
test('R3.2.4.C: adaptInpaintResult: drift (no error AND no stderr) is rejected', () => {
  const r = adaptInpaintResult({ ok: false, code: -1, outputPath: null }, 'realesrgan');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC envelope drift'),
    'C: error must mention "IPC envelope drift". Got: ' + r.error);
  assert.ok(r._original, 'C: _original must be preserved');
});

// ---------------------------------------------------------------------------
// D — wrapInpaintHandler with 5-arg handler
// ---------------------------------------------------------------------------
test('R3.2.4.D: wrapInpaintHandler supports 5-arg handler (upscale:realesrgan:run signature)', async () => {
  // upscale:realesrgan:run has signature (event, srcPath, dstPath, opts, grantId)
  // — 5 args total (one more than isnetbg because of progressKey +
  // event.sender.send progress forwarding).
  let receivedArgs = null;
  const wrapped = wrapInpaintHandler(
    async (event, srcPath, dstPath, opts, grantId) => {
      receivedArgs = { event, srcPath, dstPath, opts, grantId };
      return { ok: true, code: 0, stderr: '', outputPath: dstPath };
    },
    'realesrgan',
  );
  const fakeEvent = { sender: { send: () => {} } };
  const fakeOpts = { model: 'realesrgan-x4plus', progressKey: 'k-1' };
  const r = await wrapped(fakeEvent, '/src.png', '/dst.png', fakeOpts, 'grant-1');
  assert.equal(r.ok, true);
  assert.equal(r.outputPath, '/dst.png');
  assert.equal(r.backend, 'realesrgan');
  // Verify all 5 args were forwarded
  assert.equal(receivedArgs.event, fakeEvent, 'D: event must be forwarded');
  assert.equal(receivedArgs.srcPath, '/src.png', 'D: srcPath must be forwarded');
  assert.equal(receivedArgs.dstPath, '/dst.png', 'D: dstPath must be forwarded');
  assert.deepEqual(receivedArgs.opts, fakeOpts, 'D: opts must be forwarded');
  assert.equal(receivedArgs.grantId, 'grant-1', 'D: grantId must be forwarded');
});

// ---------------------------------------------------------------------------
// E — backend='realesrgan' sets r.backend
// ---------------------------------------------------------------------------
test('R3.2.4.E: wrapInpaintHandler with backend="realesrgan" sets r.backend === "realesrgan"', async () => {
  const wrapped = wrapInpaintHandler(
    async (_e, srcPath, dstPath, _opts, _grantId) => ({
      ok: true, code: 0, stderr: '', outputPath: dstPath,
    }),
    'realesrgan',
  );
  const r = await wrapped({ sender: { send: () => {} } }, '/src.png', '/dst.png', {}, 'grant-1');
  assert.equal(r.backend, 'realesrgan',
    'E: backend param "realesrgan" must propagate. Got: ' + r.backend);
});

// ---------------------------------------------------------------------------
// F — wrapInpaintHandler catches throws from 5-arg handler
// ---------------------------------------------------------------------------
test('R3.2.4.F: wrapInpaintHandler catches throws from 5-arg handler', async () => {
  const wrapped = wrapInpaintHandler(
    async (_e, _src, _dst, _opts, _grant) => {
      throw new Error('realesrgan boom');
    },
    'realesrgan',
  );
  const r = await wrapped({ sender: { send: () => {} } }, '/src.png', '/dst.png', {}, 'grant-1');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC handler threw') && r.error.includes('realesrgan boom'),
    'F: error must mention the throw. Got: ' + r.error);
});

// ---------------------------------------------------------------------------
// G — extras preservation
// ---------------------------------------------------------------------------
test('R3.2.4.G: adaptInpaintResult: code/stderr extras are preserved', () => {
  const r = adaptInpaintResult({ ok: true, code: 0, stderr: 'realesrgan model loaded', outputPath: '/dst.png' }, 'realesrgan');
  assert.equal(r.code, 0);
  assert.equal(r.stderr, 'realesrgan model loaded', 'G: stderr preserved (also promoted to warnings — see H)');
  assert.equal(r.outputPath, '/dst.png');
  assert.equal(r.backend, 'realesrgan');
});

// ---------------------------------------------------------------------------
// H — ok:true + non-empty stderr → warnings (R3.2.3.AuditFix regression)
// ---------------------------------------------------------------------------
test('R3.2.4.H: adaptInpaintResult: ok:true + non-empty stderr → warnings promoted (R3.2.3.AuditFix regression)', () => {
  // Realsrgan stderr may carry non-fatal CLI output (model load info,
  // GPU init) even on success. R3.2.3.AuditFix fixed this — without
  // the fix, this would DRIFT.
  const r = adaptInpaintResult({ ok: true, code: 0, stderr: 'GPU initialized', outputPath: '/dst.png' }, 'realesrgan');
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.deepEqual(r.warnings, ['GPU initialized'],
    'H: stderr must be promoted to warnings. Got: ' + JSON.stringify(r.warnings));
});
