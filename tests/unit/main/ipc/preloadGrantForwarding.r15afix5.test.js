// tests/unit/main/ipc/preloadGrantForwarding.r15afix5.test.js
// ============================================================================
// R1.5a.follow-up Phase 5 — Integration tests for the REAL preload→IPC
// pipeline.
//
// Background: the R1.5a preload signatures for image:optimize,
// image:resize, image:fixExtension, upscale:realesrgan:run, and
// isnetbg:run were 2-or-3-arg — the grantId arg was silently dropped
// at the preload layer. The handler always received `undefined` and
// returned `{ok: false, error: 'grantId is required for read on <path>'}`
// for every production preload→IPC call. R1.5a.follow-up Phases 1-4b
// fixed the renderer-callsites (section07, section08Helpers,
// batchPostprocess, imageEditorHeal, imageEditorActions, pipelineImport,
// pipelineReport) to mint a grantId and pass it to the preload — but
// the preload was still dropping it.
//
// This test loads the REAL preload.js + the REAL `image:optimize`,
// `image:resize`, `image:fixExtension`, `upscale:realesrgan:run`,
// `isnetbg:run`, and `inpaint:runTelea`/`inpaint:runOnnx` handlers
// from main/ipc/register*.js, and asserts that a grantId passed to
// the preload's exposed function arrives intact at the handler.
//
// What is mocked: only the electron IPC transport (contextBridge +
// ipcRenderer). What is NOT mocked: the preload, the IPC handlers,
// the grant authoriser, the path grant service, the legacy adapter.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const SETTINGS_PATH = path.join(ROOT, 'settings.json');
const ORIGINAL_SETTINGS = (() => {
  try { return fs.readFileSync(SETTINGS_PATH, 'utf8'); } catch { return null; }
})();

async function writeConfig({ outputDir, allowedRoots }) {
  const cfg = {
    api_key: '',
    output_dir: outputDir,
    region: 'global',
    allowed_roots: allowedRoots,
  };
  await fsp.writeFile(SETTINGS_PATH, JSON.stringify(cfg, null, 2));
}

async function withTempDir(fn) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'r15afix5-'));
  const outputDir = path.join(tmp, 'output');
  const trustDir = path.join(tmp, 'trust');
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.mkdir(trustDir, { recursive: true });
  // Copy a tiny PNG into the trust dir (so image:optimize has a real
  // source to read). 1×1 transparent PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const src = path.join(trustDir, 'src.png');
  await fsp.writeFile(src, png);
  try {
    return await fn({ tmp, outputDir, trustDir, src });
  } finally {
    try { await fsp.rm(tmp, { recursive: true, force: true }); } catch {}
  }
}

function purgeProjectCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ROOT) && key !== __filename) delete require.cache[key];
  }
}

// Run `body` with `Module._load` patched to return our mock electron
// module. Inside `body`, preload.js and the IPC handlers see the mock
// electron (no real Electron install required). Outside `body`,
// Module._load is restored to the original.
async function withMockedElectron(electronMock, body) {
  purgeProjectCache();
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return await body();
  } finally {
    Module._load = originalLoad;
  }
}

function makeIpcMainMock() {
  const handlers = {};
  return {
    handle(channel, fn) { handlers[channel] = fn; },
    getHandler(channel) { return handlers[channel]; },
  };
}

// Boot the real preload + the real IPC handlers in a shared
// module-cache, with mocked electron. Returns the api object
// (the preload's `exposeInMainWorld('api', ...)`) and a
// grantId that the test can use to call the api.
async function bootHarness(cfg) {
  await writeConfig({ outputDir: cfg.outputDir, allowedRoots: [cfg.trustDir, cfg.outputDir] });
  const ipcMain = makeIpcMainMock();
  const invokes = [];
  const electron = {
    ipcMain: { handle: ipcMain.handle.bind(ipcMain) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { showItemInFolder: () => {}, openPath: async () => '', openExternal: async () => {} },
    app: { getPath: () => cfg.tmp },
    BrowserWindow: class BrowserWindow {},
    contextBridge: { exposeInMainWorld(_name, exposed) { return exposed; } },
    ipcRenderer: {
      invoke(channel, ...args) {
        invokes.push({ channel, args });
        const h = ipcMain.getHandler(channel);
        if (h) return Promise.resolve(h({}, ...args));
        return Promise.resolve({ ok: false, error: 'no handler for ' + channel });
      },
      on() {}, removeListener() {}, send() {},
    },
  };
  return withMockedElectron(electron, async () => {
    const pathSecurity = require(path.join(ROOT, 'main', 'services', 'PathSecurityService.js'));
    const pathGrant = require(path.join(ROOT, 'main', 'services', 'PathGrantService.js'));
    pathSecurity.setActiveDir(cfg.trustDir);
    const grant = pathGrant.defaultService.mintFileGrant({
      origin: 'integration-test', purpose: 'test', path: cfg.trustDir,
      capabilities: ['read', 'write', 'delete', 'mkdir', 'rename', 'copy', 'move'],
      singleUse: false, coversRoot: true,
    });
    assert.ok(grant && grant.ok, 'integration-test: trusted-root grant must mint');
    const grantId = grant.grantId;

    require(path.join(ROOT, 'main', 'ipc', 'registerImageIpc.js')).register({ appRoot: cfg.tmp });
    require(path.join(ROOT, 'main', 'ipc', 'registerInpaintIpc.js')).register({ appRoot: cfg.tmp });
    require(path.join(ROOT, 'main', 'ipc', 'registerInpaintOnnxIpc.js')).register({ appRoot: cfg.tmp });
    require(path.join(ROOT, 'main', 'ipc', 'registerUpscaleIpc.js')).register({ appRoot: cfg.tmp });
    require(path.join(ROOT, 'main', 'ipc', 'registerIsnetbgIpc.js')).register({ appRoot: cfg.tmp });
    require(path.join(ROOT, 'main', 'ipc', 'registerPathGrantIpc.js')).register({ appRoot: cfg.tmp });

    // Capture the api object via contextBridge mock.
    let api = null;
    electron.contextBridge = { exposeInMainWorld(_name, exposed) { api = exposed; } };
    require(path.join(ROOT, 'preload.js'));
    assert.ok(api, 'preload must call contextBridge.exposeInMainWorld with the api object');
    return { api, grantId, invokes, src: cfg.src, trustDir: cfg.trustDir, outputDir: cfg.outputDir };
  });
}

test('R1.5a.follow-up.5.A: image:optimize forwards grantId (3-arg handler signature)', async () => {
  await withTempDir(async (cfg) => {
    const h = await bootHarness(cfg);
    const r = await h.api.optimizeImage(h.src, { quality: 60 }, h.grantId);
    if (r && r.error) {
      assert.ok(!/grantId is required/.test(r.error),
        'handler must NOT report "grantId is required" — preload dropped the grantId. Error: ' + r.error);
    }
    const opt = h.invokes.find((i) => i.channel === 'image:optimize');
    assert.ok(opt, 'image:optimize IPC must have been invoked');
    assert.equal(opt.args.length, 3, 'image:optimize must receive 3 args (srcPath, opts, grantId)');
    assert.equal(opt.args[2], h.grantId, 'image:optimize arg[2] must be the grantId the preload was given');
  });
});

test('R1.5a.follow-up.5.B: image:resize forwards grantId', async () => {
  await withTempDir(async (cfg) => {
    const h = await bootHarness(cfg);
    const r = await h.api.resizeImage(h.src, { width: 8, height: 8 }, h.grantId);
    if (r && r.error) {
      assert.ok(!/grantId is required/.test(r.error),
        'handler must NOT report "grantId is required". Error: ' + r.error);
    }
    const inv = h.invokes.find((i) => i.channel === 'image:resize');
    assert.ok(inv, 'image:resize IPC must have been invoked');
    assert.equal(inv.args.length, 3, 'image:resize must receive 3 args (srcPath, opts, grantId)');
    assert.equal(inv.args[2], h.grantId, 'image:resize arg[2] must be the grantId');
  });
});

test('R1.5a.follow-up.5.C: image:fixExtension forwards grantId', async () => {
  await withTempDir(async (cfg) => {
    const h = await bootHarness(cfg);
    const r = await h.api.fixImageExtension(h.src, h.grantId);
    if (r && r.error) {
      assert.ok(!/grantId is required/.test(r.error),
        'handler must NOT report "grantId is required". Error: ' + r.error);
    }
    const inv = h.invokes.find((i) => i.channel === 'image:fixExtension');
    assert.ok(inv, 'image:fixExtension IPC must have been invoked');
    assert.equal(inv.args.length, 2, 'image:fixExtension must receive 2 args (filePath, grantId)');
    assert.equal(inv.args[1], h.grantId, 'image:fixExtension arg[1] must be the grantId');
  });
});

test('R1.5a.follow-up.5.D: upscale:realesrgan:run forwards grantId (4-arg handler signature)', async () => {
  await withTempDir(async (cfg) => {
    const h = await bootHarness(cfg);
    const dst = path.join(h.outputDir, 'realesrgan-out.png');
    // realesrganRun spawns the binary, so we don't expect it to
    // succeed in the test env (no binary). The test only
    // asserts the IPC contract.
    const _r = await h.api.realesrganRun(h.src, dst, { model: 'realesrgan-x4plus' }, h.grantId);
    const inv = h.invokes.find((i) => i.channel === 'upscale:realesrgan:run');
    assert.ok(inv, 'upscale:realesrgan:run IPC must have been invoked');
    assert.equal(inv.args.length, 4, 'upscale:realesrgan:run must receive 4 args (srcPath, dstPath, opts, grantId)');
    assert.equal(inv.args[3], h.grantId, 'upscale:realesrgan:run arg[3] must be the grantId');
  });
});

test('R1.5a.follow-up.5.E: isnetbg:run forwards grantId (4-arg handler signature)', async () => {
  await withTempDir(async (cfg) => {
    const h = await bootHarness(cfg);
    const dst = path.join(h.outputDir, 'isnet-out.png');
    const _r = await h.api.isnetbgRun(h.src, dst, { useGpu: false }, h.grantId);
    const inv = h.invokes.find((i) => i.channel === 'isnetbg:run');
    assert.ok(inv, 'isnetbg:run IPC must have been invoked');
    assert.equal(inv.args.length, 4, 'isnetbg:run must receive 4 args (srcPath, dstPath, opts, grantId)');
    assert.equal(inv.args[3], h.grantId, 'isnetbg:run arg[3] must be the grantId');
  });
});

test('R1.5a.follow-up.5.F: inpaint:runTelea args-object carries grantId (single-arg handler signature)', async () => {
  await withTempDir(async (cfg) => {
    const h = await bootHarness(cfg);
    // The inpaint handlers take a single args object whose
    // `grantId` field is the grant. The preload signature is
    // `(args)`, so the renderer must put grantId INTO args.
    const _r = await h.api.inpaintRunTelea({ srcPath: h.src, mode: 'transparency', grantId: h.grantId });
    const inv = h.invokes.find((i) => i.channel === 'inpaint:runTelea');
    assert.ok(inv, 'inpaint:runTelea IPC must have been invoked');
    assert.equal(inv.args.length, 1, 'inpaint:runTelea must receive 1 arg (the args object)');
    assert.equal(inv.args[0].grantId, h.grantId, 'inpaint:runTelea args.grantId must be the grantId');
  });
});

test('R1.5a.follow-up.5.F.b: inpaint:runOnnx args-object carries grantId (symmetric to runTelea)', async () => {
  await withTempDir(async (cfg) => {
    const h = await bootHarness(cfg);
    // Symmetric to test F — inpaint:runOnnx uses the same
    // args-object pattern. Defends against a future refactor
    // that drops the grantId field when routing through the
    // ONNX path.
    const _r = await h.api.inpaintRunOnnx({ srcPath: h.src, mode: 'transparency', grantId: h.grantId });
    const inv = h.invokes.find((i) => i.channel === 'inpaint:runOnnx');
    assert.ok(inv, 'inpaint:runOnnx IPC must have been invoked');
    assert.equal(inv.args.length, 1, 'inpaint:runOnnx must receive 1 arg (the args object)');
    assert.equal(inv.args[0].grantId, h.grantId, 'inpaint:runOnnx args.grantId must be the grantId');
  });
});

test('R1.5a.follow-up.5.G: REGRESSION — without grantId, the handler rejects (proves the gate is active)', async () => {
  // Negative-control: call the preload function WITHOUT a grantId.
  // The handler must reject with "grantId is required ..." —
  // proving the gate is actually enforced at the handler layer.
  await withTempDir(async (cfg) => {
    const h = await bootHarness(cfg);
    const r = await h.api.optimizeImage(h.src, { quality: 60 });
    assert.ok(r && r.error, 'handler must return {ok:false, error:...} when grantId is missing');
    assert.ok(/grantId is required/.test(r.error),
      'handler must reject with "grantId is required" when grantId is missing. Got: ' + r.error);
  });
});

// ---------------------------------------------------------------------------
// R1.5a.follow-up Phase 6: directory-grant + multi-capability (THE production
// flow). The R1.5a.follow-up Phases 1-4b renderer-callsites minted FILE
// grants with a SINGLE capability ('read'); the handler's write-check on
// the sibling output then failed with "operation 'write' not permitted by
// grant capabilities (read)". Phase 6 introduces directory-grant +
// multi-capability (read+write) so a single grant covers BOTH the
// source-read AND the sibling-output-write. This test verifies the
// end-to-end flow through the real preload + real handlers.
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.6.T: directory-grant + read+write covers the production source-read + sibling-output-write flow', async () => {
  await withTempDir(async (cfg) => {
    const h = await bootHarness(cfg);
    // 1) The renderer mints a DIRECTORY grant on the PARENT of the
    // source with capabilities ['read', 'write'] (via the preload's
    // mintGrant IPC). This is the exact pattern every Phase 6
    // callsite uses.
    const parentDir = cfg.trustDir;  // the parent of cfg.src
    const m = await h.api.mintGrant(parentDir, 'read', {
      kind: 'directory',
      capabilities: ['read', 'write'],
    });
    assert.equal(m.ok, true, 'T: directory+multi-cap mint must succeed: ' + (m && m.error));
    const dirGrantId = m.grantId;
    // 2) The renderer calls image:optimize with the directory grant.
    // The handler's authorize() check must accept BOTH the source
    // (read) AND the sibling output (write).
    const siblingOut = cfg.src.replace(/\.png$/, '_optimized.png');
    const r = await h.api.optimizeImage(cfg.src, { quality: 60, outputPath: siblingOut }, dirGrantId);
    // The handler may legitimately fail with a non-grant error
    // (e.g. sharp not installed, image corrupt) — those are
    // downstream concerns, not the Phase 6 contract. The Phase 6
    // contract is: the grant-check MUST accept the directory+multi-cap
    // pattern. We assert that the grant-check did NOT reject (any
    // of the three known grant-related failure modes), regardless
    // of downstream success. This is a "Phase 6 did its job"
    // assertion, not a "handler returned ok" assertion.
    if (r && r.error) {
      // R1.5a Phase 6 fix #1: capability-mismatch.
      assert.ok(!/operation "write" not permitted/.test(r.error),
        'T: handler must NOT reject with capability-mismatch. Error: ' + r.error);
      // R1.5a Phase 5: missing-grantId.
      assert.ok(!/grantId is required/.test(r.error),
        'T: handler must NOT reject with missing-grantId. Error: ' + r.error);
      // R1.5a Phase 6 fix #2: file-grant on a directory path covers
      // only the exact path, not the sibling. The directory grant
      // must be in effect, so this error must NOT appear either.
      assert.ok(!/file grant covers only its exact canonical path/.test(r.error),
        'T: handler must NOT reject with file-grant-only-covers-exact-path (proves the directory grant is in effect, not a file grant). Error: ' + r.error);
      assert.ok(!/directory grant covers only strict descendants, not the root itself/.test(r.error),
        'T: handler must NOT reject with directory-root-mismatch. Error: ' + r.error);
    }
    // 3) Verify the IPC was invoked with the directory grantId at
    // the right position.
    const opt = h.invokes.find((i) => i.channel === 'image:optimize');
    assert.ok(opt, 'T: image:optimize must have been invoked');
    assert.equal(opt.args[2], dirGrantId, 'T: arg[2] must be the directory grantId');
  });
});

// Cleanup: restore the original settings.json on test exit
// (run after all tests in this file complete).
test('__cleanup: restore settings.json', async () => {
  if (ORIGINAL_SETTINGS == null) {
    try { await fsp.unlink(SETTINGS_PATH); } catch {}
  } else {
    await fsp.writeFile(SETTINGS_PATH, ORIGINAL_SETTINGS);
  }
  purgeProjectCache();
});
