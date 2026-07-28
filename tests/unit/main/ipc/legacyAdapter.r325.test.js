// tests/unit/main/ipc/legacyAdapter.r325.test.js
// ============================================================================
// R3.2.5 — Legacyadapter for the image:optimize IPC (ImageOperationResult
// contract migration, backend='sharp').
//
// The legacy `image:optimize` envelope is
// `{ok, error, outputPath, inputSize, outputSize, savedBytes,
// savedPercent, format, width, height}` — 10 fields. Already has
// `outputPath` (no path-mapping needed) and `error` (no stderr-fallback
// needed). Backend is 'sharp'. The handler has a 3-arg signature
// `(event, srcPath, opts, grantId)` (one fewer arg than isnetbg/upscale
// because no separate dstPath — the optimiser derives it from srcPath
// + format).
//
// Tests:
//   A. happy path: legacy success envelope → backend='sharp', all 9
//      contract fields + 6 extras preserved.
//   B. failure envelope: explicit error → validated, error preserved.
//   C. drift: no error on ok:false → REJECTED with diagnostics.
//   D. wrapInpaintHandler supports 3-arg handler.
//   E. wrapInpaintHandler with backend='sharp' sets r.backend.
//   F. wrapInpaintHandler catches throws from 3-arg handler.
//   G. extras (inputSize, outputSize, savedBytes, etc.) preserved
//      through adapter.
//   H. ok:true + empty error string → error:null in canonical
//      (success path with empty error field).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const { adaptInpaintResult, wrapInpaintHandler } = require(path.join(ROOT, 'main', 'ipc', 'legacyAdapter'));

// ---------------------------------------------------------------------------
// A — happy path
// ---------------------------------------------------------------------------
test('R3.2.5.A: adaptInpaintResult: image:optimize success envelope is valid, backend=sharp', () => {
  const r = adaptInpaintResult({
    ok: true, error: '', outputPath: '/dst.png',
    inputSize: 1000, outputSize: 500, savedBytes: 500, savedPercent: 50,
    format: 'png', width: 100, height: 100,
  }, 'sharp');
  assert.equal(r.ok, true);
  assert.equal(r.outputPath, '/dst.png', 'A: outputPath preserved');
  assert.equal(r.backend, 'sharp', 'A: backend must be "sharp"');
  assert.equal(r.error, null, 'A: error must be null on success (empty string → null)');
  assert.equal(r.inputSize, 1000, 'A: inputSize extra preserved');
  assert.equal(r.outputSize, 500, 'A: outputSize extra preserved');
  assert.equal(r.savedBytes, 500, 'A: savedBytes extra preserved');
  assert.equal(r.savedPercent, 50, 'A: savedPercent extra preserved');
  assert.equal(r.format, 'png', 'A: format extra preserved');
  assert.equal(r.width, 100, 'A: width extra preserved');
  assert.equal(r.height, 100, 'A: height extra preserved');
  assert.equal(r.sourcePath, null);
  assert.equal(r.model, null);
  assert.equal(r.resolvedSettings, null);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.diagnostics, null);
});

// ---------------------------------------------------------------------------
// B — failure envelope: explicit error
// ---------------------------------------------------------------------------
test('R3.2.5.B: adaptInpaintResult: image:optimize failure envelope (explicit error) is valid', () => {
  const r = adaptInpaintResult({
    ok: false, error: 'grant denied', outputPath: null,
    inputSize: 0, outputSize: 0, savedBytes: 0, savedPercent: 0,
    format: '', width: 0, height: 0,
  }, 'sharp');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'grant denied', 'B: explicit error preserved');
  assert.equal(r.outputPath, null);
  assert.equal(r.backend, 'sharp');
});

// ---------------------------------------------------------------------------
// C — drift: no error on ok:false
// ---------------------------------------------------------------------------
test('R3.2.5.C: adaptInpaintResult: drift (ok:false + no error) is rejected', () => {
  // image:optimize's `empty` shape has error: ''. An empty string
  // is treated as null by the normalizer → drift (ok:false requires
  // non-empty error).
  const r = adaptInpaintResult({
    ok: false, error: '', outputPath: null,
    inputSize: 0, outputSize: 0, savedBytes: 0, savedPercent: 0,
    format: '', width: 0, height: 0,
  }, 'sharp');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC envelope drift'),
    'C: error must mention "IPC envelope drift". Got: ' + r.error);
  assert.ok(r._original, 'C: _original must be preserved');
});

// ---------------------------------------------------------------------------
// D — wrapInpaintHandler with 3-arg handler
// ---------------------------------------------------------------------------
test('R3.2.5.D: wrapInpaintHandler supports 3-arg handler (image:optimize signature)', async () => {
  // image:optimize has signature (event, srcPath, opts, grantId) — 3
  // args (one fewer than isnetbg/upscale because no separate dstPath).
  let receivedArgs = null;
  const wrapped = wrapInpaintHandler(
    async (event, srcPath, opts, grantId) => {
      receivedArgs = { event, srcPath, opts, grantId };
      return {
        ok: true, error: '', outputPath: '/dst.png',
        inputSize: 1000, outputSize: 500, savedBytes: 500, savedPercent: 50,
        format: 'png', width: 100, height: 100,
      };
    },
    'sharp',
  );
  const fakeEvent = { sender: { send: () => {} } };
  const fakeOpts = { format: 'png', quality: 80 };
  const r = await wrapped(fakeEvent, '/src.png', fakeOpts, 'grant-1');
  assert.equal(r.ok, true);
  assert.equal(r.outputPath, '/dst.png');
  assert.equal(r.backend, 'sharp');
  // Verify all 3 args were forwarded
  assert.equal(receivedArgs.event, fakeEvent, 'D: event must be forwarded');
  assert.equal(receivedArgs.srcPath, '/src.png', 'D: srcPath must be forwarded');
  assert.deepEqual(receivedArgs.opts, fakeOpts, 'D: opts must be forwarded');
  assert.equal(receivedArgs.grantId, 'grant-1', 'D: grantId must be forwarded');
});

// ---------------------------------------------------------------------------
// E — backend='sharp' sets r.backend
// ---------------------------------------------------------------------------
test('R3.2.5.E: wrapInpaintHandler with backend="sharp" sets r.backend === "sharp"', async () => {
  const wrapped = wrapInpaintHandler(
    async (_e, _src, _opts, _grant) => ({
      ok: true, error: '', outputPath: '/dst.png',
      inputSize: 0, outputSize: 0, savedBytes: 0, savedPercent: 0,
      format: 'png', width: 0, height: 0,
    }),
    'sharp',
  );
  const r = await wrapped({}, '/src.png', {}, 'grant-1');
  assert.equal(r.backend, 'sharp',
    'E: backend param "sharp" must propagate. Got: ' + r.backend);
});

// ---------------------------------------------------------------------------
// F — wrapInpaintHandler catches throws from 3-arg handler
// ---------------------------------------------------------------------------
test('R3.2.5.F: wrapInpaintHandler catches throws from 3-arg handler', async () => {
  const wrapped = wrapInpaintHandler(
    async (_e, _src, _opts, _grant) => {
      throw new Error('sharp boom');
    },
    'sharp',
  );
  const r = await wrapped({}, '/src.png', {}, 'grant-1');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('IPC handler threw') && r.error.includes('sharp boom'),
    'F: error must mention the throw. Got: ' + r.error);
});

// ---------------------------------------------------------------------------
// G — extras preservation
// ---------------------------------------------------------------------------
test('R3.2.5.G: adaptInpaintResult: image:optimize extras (inputSize/outputSize/savedBytes/format/width/height) preserved', () => {
  const r = adaptInpaintResult({
    ok: true, error: '', outputPath: '/dst.png',
    inputSize: 12345, outputSize: 6789, savedBytes: 5556, savedPercent: 45,
    format: 'webp', width: 800, height: 600,
  }, 'sharp');
  assert.equal(r.inputSize, 12345);
  assert.equal(r.outputSize, 6789);
  assert.equal(r.savedBytes, 5556);
  assert.equal(r.savedPercent, 45);
  assert.equal(r.format, 'webp');
  assert.equal(r.width, 800);
  assert.equal(r.height, 600);
});

// ---------------------------------------------------------------------------
// H — ok:true + empty error string → error:null
// ---------------------------------------------------------------------------
test('R3.2.5.H: adaptInpaintResult: ok:true + error:"" → error:null in canonical (empty string normalized)', () => {
  // image:optimize's success envelope has error: '' (empty string
  // for "no error"). The normalizer trims empty strings to null.
  const r = adaptInpaintResult({
    ok: true, error: '', outputPath: '/dst.png',
    inputSize: 1000, outputSize: 500, savedBytes: 500, savedPercent: 50,
    format: 'png', width: 100, height: 100,
  }, 'sharp');
  assert.equal(r.ok, true);
  assert.equal(r.error, null,
    'H: empty string error must normalize to null (success path). Got: ' + JSON.stringify(r.error));
});
