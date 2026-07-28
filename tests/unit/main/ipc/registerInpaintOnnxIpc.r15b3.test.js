// tests/unit/main/ipc/registerInpaintOnnxIpc.r15b3.test.js
// ============================================================================
// R1.5b.3 — InpaintOnnx IPC grant migration (S1 §6 R1.5b).
//
// Invarianten (S1 §3 + §4 + §6 R1.5b):
//   • `inpaint:runOnnx` requires a `grantId` (passed as a named
//     field inside `args`, same pattern as R1.5a.5's
//     `inpaint:runTelea`). The grant must authorise 'read' on
//     srcPath AND 'write' on outPath (or the derived sibling if
//     outPath is omitted).
//   • Without a grantId (or with an unknown / revoked one) the
//     handler returns `{ok:false, error}` and does NOT touch the
//     filesystem (no mask write, no outPath write).
//   • A directory grant for dirname(srcPath) covers the src +
//     mask (sibling) + derived outPath (sibling) triplet.
//   • The 3 model management handlers
//     (`inpaint:modelsAvailable`, `inpaint:replaceModel`,
//     `inpaint:restoreModel`) are unchanged: no grant required
//     (the model paths are fully Main-derived from a fixed
//     MODELS list + assetPaths.writableAssetsDir()).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const INPAINT_ONNX_IPC = path.join(ROOT, 'main', 'ipc', 'registerInpaintOnnxIpc.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
const ASSET_PATHS = path.join(ROOT, 'src', 'assetPaths.js');
const INPAINT_INDEX = path.join(ROOT, 'src', 'inpaint', 'index.js');
const INPAINT_JS = path.join(ROOT, 'src', 'inpaint.js');
const MODEL_REGISTRY = path.join(ROOT, 'src', 'inpaint', 'modelRegistry.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15b3-inpaint-'));

// A real RGBA PNG (16x16 white) so the mask write + outPath write
// can be exercised end-to-end if needed.
let PNG_BYTES;
test.before(async () => {
  PNG_BYTES = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).png().toBuffer();
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---- Helper: load the IPC with mocked electron + inpaint + assetPaths. ----
function loadIpc({ inpaintRunOnnxImpl } = {}) {
  // R1.5b.3: also clear src/inpaint.js (the re-export module
  // that requires src/inpaint/index.js). Without this, the
  // cached inpaint.js holds a stale reference to the real
  // src/inpaint/index.js and the IPC's `inpaint.runOnnx` call
  // bypasses our mock.
  for (const p of [INPAINT_ONNX_IPC, PATH_GRANT, ASSET_PATHS, INPAINT_INDEX, INPAINT_JS, MODEL_REGISTRY]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  try {
    const { defaultService } = require(PATH_GRANT);
    defaultService.destroy();
  } catch (_) {}
  const handlers = new Map();
  const calls = { inpaintRunOnnx: [] };

  // Mock electron.
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      app: { getPath: () => path.join(TMP, 'fake-userData') },
    },
  };

  // Mock assetPaths so writableAssetsDir() + resolveAsset() point
  // into TMP (where the inpaint override model would live).
  require.cache[require.resolve(ASSET_PATHS)] = {
    exports: {
      writableAssetsDir: () => path.join(TMP, 'assets'),
      resolveAsset: (kind, file) => {
        if (kind === 'models') return path.join(TMP, 'assets', 'models', file);
        return null;
      },
      getConfig: () => ({ appRoot: ROOT, resourcesPath: ROOT, userDataPath: TMP }),
    },
  };

  // Mock src/inpaint/index.js (the runOnnx function lives here;
  // the IPC's `const inpaint = require('../../src/inpaint')` does
  // NOT re-export runOnnx — a pre-existing bug — so the test
  // stubs the function directly via require.cache).
  require.cache[require.resolve(INPAINT_INDEX)] = {
    exports: {
      runOnnx: async (src, mask, dst, opts) => {
        calls.inpaintRunOnnx.push({ src, mask, dst, opts });
        if (inpaintRunOnnxImpl) return inpaintRunOnnxImpl(src, mask, dst, opts);
        // Default no-op stub: simulate a successful inpaint by
        // writing a tiny placeholder file at dst. The test
        // exercises the grant gate; the inpaint algorithm is
        // unit-tested in tests/unit/src/inpaint.test.js.
        try { fs.writeFileSync(dst, PNG_BYTES); } catch (_) {}
        return { ok: true, code: 0, stderr: '', outputPath: dst };
      },
      findModelPath: (file) => path.join(TMP, 'assets', 'models', file),
    },
  };

  // Pre-populate the PathGrantService cache AFTER the cache
  // clear (R1.5a.6 fix). The lazy require in grantAuthorizer
  // hits the cache at handler-call time.
  const defaultServiceMock = {
    authorize: (grantId, spec) => {
      if (!grantId) return { ok: false, error: 'grantId required' };
      if (grantId === 'unknown') return { ok: false, error: 'grant not found' };
      if (grantId === 'revoked') return { ok: false, error: 'grant revoked' };
      if (!spec || typeof spec.path !== 'string') return { ok: false, error: 'path required' };
      return { ok: true, canonicalPath: spec.path };
    },
    mintDirectoryGrant: ({ path: p, capabilities, coversRoot }) => ({
      ok: true,
      grantId: 'mock-dir-grant-' + (p || '').replace(/[^a-zA-Z0-9]/g, '_') + (coversRoot ? '-root' : ''),
      grant: { kind: coversRoot ? 'directory-root' : 'directory', path: p, capabilities: capabilities || ['read', 'write'] },
    }),
    mintFileGrant: ({ path: p, capabilities }) => ({
      ok: true,
      grantId: 'mock-file-grant-' + (p || '').replace(/[^a-zA-Z0-9]/g, '_'),
      grant: { kind: 'file', path: p, capabilities: capabilities || ['read', 'write'] },
    }),
    revoke: () => ({ ok: true }),
    destroy: () => 0,
  };
  require.cache[require.resolve(PATH_GRANT)] = {
    exports: { defaultService: defaultServiceMock },
  };

  require(INPAINT_ONNX_IPC).register({ appRoot: ROOT });
  return { handlers, calls, defaultServiceMock, TMP };
}

function makeFakePng(name = 'src.png') {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, PNG_BYTES);
  return f;
}

function deriveOnnxOut(srcPath, suffix = '_resynthesized') {
  // Mirror the IPC's deriveOutPath() logic exactly.
  const dot = srcPath.lastIndexOf('.');
  const ext = dot >= 0 ? srcPath.slice(dot) : '.png';
  const base = dot >= 0 ? srcPath.slice(0, dot) : srcPath;
  return base + suffix + ext;
}

// ===========================================================================
// inpaint:runOnnx — grant contract
// ===========================================================================

test('R1.5b.3: inpaint:runOnnx rejects when no grantId is supplied', async () => {
  const { handlers } = loadIpc();
  const src = makeFakePng('a.png');
  const r = await handlers.get('inpaint:runOnnx')(null, {
    srcPath: src,
    maskB64: PNG_BYTES.toString('base64'),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /grantId is required/i);
});

test('R1.5b.3: inpaint:runOnnx rejects when grantId is a non-string', async () => {
  const { handlers } = loadIpc();
  const src = makeFakePng('b.png');
  const r1 = await handlers.get('inpaint:runOnnx')(null, { srcPath: src, maskB64: 'x', grantId: null });
  const r2 = await handlers.get('inpaint:runOnnx')(null, { srcPath: src, maskB64: 'x', grantId: 123 });
  const r3 = await handlers.get('inpaint:runOnnx')(null, { srcPath: src, maskB64: 'x', grantId: {} });
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  assert.equal(r3.ok, false);
});

test('R1.5b.3: inpaint:runOnnx succeeds with a valid directory grant covering src + derived outPath', async () => {
  const { handlers, calls } = loadIpc();
  const src = makeFakePng('dirgrant.png');
  const out = deriveOnnxOut(src, '_resynthesized');
  const grantId = 'mock-dir-grant-' + TMP.replace(/[^a-zA-Z0-9]/g, '_');
  const r = await handlers.get('inpaint:runOnnx')(null, {
    srcPath: src,
    maskB64: PNG_BYTES.toString('base64'),
    grantId,
  });
  assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
  assert.equal(r.path, out, 'derived outPath is the sibling of src');
  assert.equal(calls.inpaintRunOnnx.length, 1, 'inpaint.runOnnx must be called exactly once');
  // The IPC passes src + mask + outPath to the inpaint engine.
  assert.equal(calls.inpaintRunOnnx[0].src, src);
  assert.equal(calls.inpaintRunOnnx[0].dst, out);
  // The mask path is a sibling of src (in dirname(src)).
  assert.ok(calls.inpaintRunOnnx[0].mask.startsWith(path.dirname(src)),
    'mask path is a sibling of src');
  // The output file exists on disk (the stub wrote it).
  assert.ok(fs.existsSync(out), 'the inpaint output file must exist');
});

test('R1.5b.3: inpaint:runOnnx authorises src with operation "read" and outPath with operation "write"', async () => {
  const { handlers, defaultServiceMock } = loadIpc();
  const origAuthz = defaultServiceMock.authorize;
  const seen = [];
  defaultServiceMock.authorize = (grantId, spec) => {
    seen.push({ grantId, op: spec && spec.operation, path: spec && spec.path });
    return origAuthz(grantId, spec);
  };
  const src = makeFakePng('op.png');
  const out = path.join(TMP, 'op-out.png');
  const r = await handlers.get('inpaint:runOnnx')(null, {
    srcPath: src,
    outPath: out,
    maskB64: PNG_BYTES.toString('base64'),
    grantId: 'g1',
  });
  assert.equal(r.ok, true);
  // The handler authorises src (read) AND outPath (write) at minimum.
  const readCall = seen.find((c) => c.path === src);
  const writeCall = seen.find((c) => c.path === out);
  assert.ok(readCall, 'must authorise srcPath');
  assert.equal(readCall.op, 'read');
  assert.ok(writeCall, 'must authorise outPath');
  assert.equal(writeCall.op, 'write');
});

test('R1.5b.3: inpaint:runOnnx rejects when grant does not authorise srcPath', async () => {
  const { handlers, defaultServiceMock } = loadIpc();
  const origAuthz = defaultServiceMock.authorize;
  defaultServiceMock.authorize = (grantId, spec) => {
    if (spec && typeof spec.path === 'string' && spec.path.includes('evil')) {
      return { ok: false, error: 'outside grant scope' };
    }
    return origAuthz(grantId, spec);
  };
  const r = await handlers.get('inpaint:runOnnx')(null, {
    srcPath: path.join(TMP, 'evil-src.png'),
    maskB64: 'x',
    grantId: 'g1',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /not authorised/i);
  assert.match(r.error, /Source path/i);
});

test('R1.5b.3: inpaint:runOnnx rejects when grant does not authorise outPath', async () => {
  const { handlers, defaultServiceMock } = loadIpc();
  const origAuthz = defaultServiceMock.authorize;
  defaultServiceMock.authorize = (grantId, spec) => {
    if (spec && spec.operation === 'write' && spec.path && spec.path.includes('evil')) {
      return { ok: false, error: 'outside grant scope' };
    }
    return origAuthz(grantId, spec);
  };
  const src = makeFakePng('good-src.png');
  const r = await handlers.get('inpaint:runOnnx')(null, {
    srcPath: src,
    outPath: path.join(TMP, 'evil-out.png'),
    maskB64: 'x',
    grantId: 'g1',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /not authorised/i);
  assert.match(r.error, /Output path/i);
});

test('R1.5b.3: inpaint:runOnnx rejects when grantId is unknown', async () => {
  const { handlers } = loadIpc();
  const src = makeFakePng('unk.png');
  const r = await handlers.get('inpaint:runOnnx')(null, {
    srcPath: src,
    maskB64: 'x',
    grantId: 'unknown',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /not authorised|not found/i);
});

test('R1.5b.3: inpaint:runOnnx rejects when grantId is revoked', async () => {
  const { handlers, defaultServiceMock } = loadIpc();
  const origAuthz = defaultServiceMock.authorize;
  defaultServiceMock.authorize = (grantId, spec) => {
    if (grantId === 'revoked') return { ok: false, error: 'grant revoked' };
    return origAuthz(grantId, spec);
  };
  const src = makeFakePng('rev.png');
  const r = await handlers.get('inpaint:runOnnx')(null, {
    srcPath: src,
    maskB64: 'x',
    grantId: 'revoked',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /not authorised|revoked/i);
});

test('R1.5b.3: inpaint:runOnnx returns the legacy "Source path required." error before the grant check', async () => {
  const { handlers } = loadIpc();
  // No srcPath. The handler must fail with the legacy error
  // (NOT a grant error) so the user-facing surface is unchanged.
  const r = await handlers.get('inpaint:runOnnx')(null, { maskB64: 'x', grantId: 'g1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Source path required/i);
});

test('R1.5b.3: inpaint:runOnnx returns the legacy "mask required" error before the grant check', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('inpaint:runOnnx')(null, { srcPath: '/x.png', grantId: 'g1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /mask \(base64 PNG\) is required/i);
});

test('R1.5b.3: inpaint:runOnnx does NOT write a mask file when the grant check fails', async () => {
  const { handlers, calls } = loadIpc();
  const src = makeFakePng('nomask.png');
  // Use a real (empty) tmpDir snapshot before the call.
  const before = new Set(fs.readdirSync(TMP));
  const r = await handlers.get('inpaint:runOnnx')(null, {
    srcPath: src,
    maskB64: 'x',
    grantId: 'unknown', // unknown grant → grant check fails
  });
  assert.equal(r.ok, false);
  // No new file should have been written (the mask file is the
  // first thing the legacy handler wrote before the grant check).
  const after = new Set(fs.readdirSync(TMP));
  const newFiles = [...after].filter((f) => !before.has(f));
  // Filter out the legit test files (e.g. nomask.png was already
  // there before the call). Only fail if a mask-shaped file was
  // created.
  const maskFiles = newFiles.filter((f) => f.includes('.ie_inpaint_mask_'));
  assert.equal(maskFiles.length, 0, `mask file was written despite grant failure: ${maskFiles.join(', ')}`);
  // Also assert the inpaint engine was NOT called.
  assert.equal(calls.inpaintRunOnnx.length, 0, 'inpaint.runOnnx must not be called on grant failure');
});

// ===========================================================================
// inpaint:modelsAvailable — unchanged (no grant required)
// ===========================================================================

test('R1.5b.3: inpaint:modelsAvailable is unchanged — no grantId required', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('inpaint:modelsAvailable')();
  // The handler returns the per-model availability; the contract
  // is that the call succeeds (no grant check). The exact
  // structure depends on the MODELS catalog, so we just assert
  // ok:true.
  assert.equal(r.ok, true);
  assert.ok(r.models, 'must return the models map');
});

// ===========================================================================
// inpaint:restoreModel — unchanged (no grant required, modelKey is opaque)
// ===========================================================================

test('R1.5b.3: inpaint:restoreModel with a known model key is unchanged (no grantId required)', async () => {
  const { handlers } = loadIpc();
  // Get a known model key from the modelRegistry.
  const reg = require(MODEL_REGISTRY);
  const firstKey = Object.keys(reg.MODELS)[0];
  // Ensure the override file does not exist (so the call is a
  // no-op unlink). The handler returns ok:true either way.
  const r = await handlers.get('inpaint:restoreModel')(null, firstKey);
  assert.equal(r.ok, true);
});

test('R1.5b.3: inpaint:restoreModel with an unknown model key returns ok:false', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('inpaint:restoreModel')(null, 'totally-unknown-model');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown model/i);
});
