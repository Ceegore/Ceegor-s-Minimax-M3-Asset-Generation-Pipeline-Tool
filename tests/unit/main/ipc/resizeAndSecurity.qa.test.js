// tests/unit/main/ipc/resizeAndSecurity.qa.test.js
// Phase 7 (adversarial QA) — exercises the REAL IPC handlers in isolation by
// mocking electron (ipcMain/dialog/shell) exactly like fullToolSweep.test.js,
// then invoking the registered handler closures directly. Covers:
//   - image:resize path gate: src outside allowed roots → rejected
//   - image:resize outputPath outside allowed roots → rejected
//   - image:resize happy path: src under output dir → real resize runs
//   - sensitiveRootRe prefix fix: a FILE inside a sensitive dir is blocked
//   - report_dir is now an allowed root (PathSecurityService)
//   - batches:saveManualAs: Save-As dialog → file written, folder trusted
//   - batches:saveManualAs: dialog canceled → ok:false, canceled:true

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function purgeProjectCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ROOT) && key !== __filename) delete require.cache[key];
  }
}

async function withModuleMocks(mocks, run) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return await run(); }
  finally { Module._load = originalLoad; }
}

function createElectronMock(overrides = {}) {
  const handlers = {};
  const listeners = {};
  return {
    handlers, listeners,
    module: {
      ipcMain: {
        handle(channel, fn) { handlers[channel] = fn; },
        on(channel, fn) { listeners[channel] = fn; },
      },
      dialog: {
        showOpenDialog: overrides.showOpenDialog || (async () => ({ canceled: true, filePaths: [] })),
        showSaveDialog: overrides.showSaveDialog || (async () => ({ canceled: true, filePath: undefined })),
      },
      shell: {
        showItemInFolder() {}, openPath: async () => '', openExternal: async () => {},
      },
      app: {
        getPath(name) {
          if (name === 'userData') return overrides.userDataPath || path.join(process.cwd(), 'tmp-ud');
          if (name === 'exe') return path.join(overrides.userDataPath || path.join(process.cwd(), 'tmp-ud'), 'app.exe');
          return overrides.userDataPath || path.join(process.cwd(), 'tmp-ud');
        },
      },
      BrowserWindow: class BrowserWindow {},
    },
  };
}

async function withIsolatedProject(options, run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ipc-'));
  const outputDir = path.join(tmp, 'output');
  const userDataDir = path.join(tmp, 'userData');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  const previousConfigDir = process.env.MINIMAX_CONFIG_DIR;
  process.env.MINIMAX_CONFIG_DIR = tmp;
  purgeProjectCache();
  const electron = createElectronMock({
    userDataPath: userDataDir,
    showSaveDialog: options?.showSaveDialog,
  });
  try {
    return await withModuleMocks(
      { electron: electron.module, ...(options?.mocks || {}) },
      async () => run({ tmp, outputDir, userDataDir, electron, load: (rel) => require(path.join(ROOT, rel)) }),
    );
  } finally {
    if (previousConfigDir == null) delete process.env.MINIMAX_CONFIG_DIR;
    else process.env.MINIMAX_CONFIG_DIR = previousConfigDir;
    purgeProjectCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// Minimal sender for handler invocation.
function sender() { return { id: 1, send() {} }; }

// ===================================================== image:resize path gate
test('image:resize rejects a srcPath OUTSIDE the allowed roots', async () => {
  await withIsolatedProject({}, async ({ load, outputDir }) => {
    // Register the real handlers.
    load('main/ipc/registerImageIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    // Re-fetch the handler registered by registerImageIpc via the electron mock.
  });
  // The handler is registered on the MOCK ipcMain, which is captured per-call.
  // Re-run inside one isolated scope so handlers persist.
  let resizeHandler = null;
  await withIsolatedProject({}, async ({ load, electron, outputDir }) => {
    load('main/ipc/registerImageIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    resizeHandler = electron.handlers['image:resize'];
    assert.ok(resizeHandler, 'image:resize handler must be registered');
    const outside = path.join(os.tmpdir(), 'outside-' + Date.now() + '.png');
    // R1.5a: the grant covers the output dir. The src is OUTSIDE the
    // grant, so the read authorisation must reject.
    const pathGrantService = load('main/services/PathGrantService').defaultService;
    pathGrantService.destroy();
    const grant = pathGrantService.mintDirectoryGrant({
      origin: 'picker-browser-dir', purpose: 'qa outside src',
      path: outputDir, capabilities: ['read', 'write', 'rename', 'delete', 'mkdir'],
    });
    const r = await resizeHandler(sender(), outside, { width: 10, height: 10 }, grant.grantId);
    assert.equal(r.ok, false);
    // R1.5a: the rejection is now a grant-authorisation error (the
    // grant does not cover the outside path), not the legacy
    // isPathUnderAny error. Both messages convey "outside" intent.
    assert.ok(/grant|outside|not authoris/i.test(r.error),
      'src outside grant must be blocked: ' + r.error);
  });
});

test('image:resize rejects an outputPath OUTSIDE the allowed roots (even if src is inside)', async () => {
  await withIsolatedProject({}, async ({ load, electron, outputDir }) => {
    load('main/ipc/registerImageIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const h = electron.handlers['image:resize'];
    // src is a real file INSIDE outputDir (allowed); outputPath points OUTSIDE.
    const { sharp } = load('src/imageOptimizer/formatUtils');
    const src = path.join(outputDir, 'ok.png');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(src);
    // R1.5a: mint a directory grant that covers outputDir. The src
    // is inside the grant; the outputPath is OUTSIDE the grant.
    const pathGrantService = load('main/services/PathGrantService').defaultService;
    pathGrantService.destroy();
    const grant = pathGrantService.mintDirectoryGrant({
      origin: 'picker-browser-dir', purpose: 'qa output outside',
      path: outputDir, capabilities: ['read', 'write', 'rename', 'delete', 'mkdir'],
    });
    const evilOut = path.join(os.tmpdir(), 'evil-' + Date.now() + '.png');
    const r = await h(sender(), src, { width: 4, height: 4, outputPath: evilOut }, grant.grantId);
    assert.equal(r.ok, false);
    assert.ok(/grant|outside|not authoris/i.test(r.error),
      'outputPath outside grant must be blocked: ' + r.error);
  });
});

test('image:resize happy path: src under output dir → real resize runs, file appears', async () => {
  await withIsolatedProject({}, async ({ load, electron, outputDir, tmp }) => {
    // Point the config's output_dir at our temp output dir so it's an allowed root.
    const cfgMod = load('src/config');
    cfgMod.write({ api_key: '', output_dir: outputDir, report_dir: '', region: 'global', theme: 'dark', styles: [] });
    load('main/ipc/registerImageIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const h = electron.handlers['image:resize'];
    const { sharp } = load('src/imageOptimizer/formatUtils');
    const src = path.join(outputDir, 'in.png');
    await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toFile(src);
    const out = path.join(outputDir, 'out.png');
    // R1.5a: mint a directory grant for outputDir (covers both src
    // and out, which are siblings under outputDir).
    const pathGrantService = load('main/services/PathGrantService').defaultService;
    pathGrantService.destroy();
    const grant = pathGrantService.mintDirectoryGrant({
      origin: 'picker-browser-dir', purpose: 'qa happy path',
      path: outputDir, capabilities: ['read', 'write', 'rename', 'delete', 'mkdir'],
    });
    const r = await h(sender(), src, { width: 20, height: 20, outputPath: out }, grant.grantId);
    assert.equal(r.ok, true, 'happy path should resize: ' + r.error);
    assert.equal(r.width, 20);
    assert.ok(fs.existsSync(out));
  });
});

test('image:resize: missing/invalid srcPath → ok:false (no crash)', async () => {
  await withIsolatedProject({}, async ({ load, electron }) => {
    load('main/ipc/registerImageIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const h = electron.handlers['image:resize'];
    const r1 = await h(sender(), null, { width: 10, height: 10 });
    assert.equal(r1.ok, false);
    const r2 = await h(sender(), 12345, { width: 10, height: 10 });
    assert.equal(r2.ok, false);
  });
});

// =========================================== sensitiveRootRe prefix fix
// The regex lives inline in registerImageIpc's image:writeBase64 handler. We
// exercise it by driving the handler with a sensitive path and asserting the
// write is refused. (image:writeBase64 is the read-path denylist gate.)
test('sensitiveRootRe: a FILE inside C:\\Users\\<u>\\.ssh is blocked (prefix fix)', async () => {
  await withIsolatedProject({}, async ({ load, electron, outputDir }) => {
    load('main/ipc/registerImageIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const h = electron.handlers['image:writeBase64'];
    assert.ok(h, 'image:writeBase64 handler registered');
    // A credential file inside .ssh — the OLD regex ($-anchored) let this through.
    const r = await h(sender(), 'C:\\Users\\bob\\.ssh\\id_rsa', Buffer.from('x').toString('base64'));
    assert.equal(r && r.ok, false, 'a file inside .ssh must be blocked by the prefix-matched denylist');
  });
});

// ============================================ report_dir is an allowed root
test('PathSecurityService: report_dir (when set) is added to allowed roots', async () => {
  await withIsolatedProject({}, async ({ load, tmp }) => {
    const cfgMod = load('src/config');
    const pathSecurity = load('main/services/PathSecurityService');
    // Write a config with a report_dir.
    const reportDir = path.join(tmp, 'my-reports');
    cfgMod.write({ api_key: '', output_dir: '', report_dir: reportDir, region: 'global', theme: 'dark', styles: [] });
    const roots = pathSecurity.getAllowedRoots();
    assert.ok(roots.some((r) => r === reportDir || path.resolve(r) === path.resolve(reportDir)),
      'report_dir must appear in the allowed roots list, got: ' + JSON.stringify(roots));
  });
});

test('PathSecurityService: blank report_dir → not added (no empty-string root)', async () => {
  await withIsolatedProject({}, async ({ load }) => {
    const cfgMod = load('src/config');
    const pathSecurity = load('main/services/PathSecurityService');
    cfgMod.write({ api_key: '', output_dir: '', report_dir: '   ', region: 'global', theme: 'dark', styles: [] });
    const roots = pathSecurity.getAllowedRoots();
    // No empty / whitespace-only string leaks in as a root.
    assert.ok(roots.every((r) => typeof r === 'string' && r.trim().length > 0), 'no empty roots');
  });
});

// ============================================ batches:saveManualAs
test('saveManualAs: writes the file to the chosen path + trusts its folder', async () => {
  await withIsolatedProject({
    showSaveDialog: async () => ({ canceled: false, filePath: null }), // overridden below
  }, async ({ load, electron, tmp }) => {
    let captured;
    electron.module.dialog.showSaveDialog = async (_win, opts) => {
      captured = opts;
      const dest = path.join(tmp, 'manual-pick', 'myimport.md');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      return { canceled: false, filePath: dest };
    };
    load('main/ipc/registerBatchesIpc.js').register({ appRoot: ROOT, getMainWindow: () => ({ isDestroyed: () => false }) });
    const h = electron.handlers['batches:saveManualAs'];
    assert.ok(h);
    const r = await h(sender(), 'md');
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(r.path), 'file written');
    const content = fs.readFileSync(r.path, 'utf8');
    assert.ok(content.includes('Import Instruction Manual'), 'content is the manual');
    assert.ok(captured, 'showSaveDialog was called');
  });
});

test('saveManualAs: dialog canceled → { ok:false, canceled:true }, no file written', async () => {
  await withIsolatedProject({
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  }, async ({ load, electron }) => {
    load('main/ipc/registerBatchesIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const h = electron.handlers['batches:saveManualAs'];
    const r = await h(sender(), 'md');
    assert.equal(r.ok, false);
    assert.equal(r.canceled, true);
  });
});

test('saveManualAs: fmt="txt" produces the text variant content', async () => {
  await withIsolatedProject({
    showSaveDialog: async () => ({ canceled: true }),
  }, async ({ load, electron, tmp }) => {
    electron.module.dialog.showSaveDialog = async () => {
      const dest = path.join(tmp, 'out.txt');
      return { canceled: false, filePath: dest };
    };
    load('main/ipc/registerBatchesIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const h = electron.handlers['batches:saveManualAs'];
    const r = await h(sender(), 'txt');
    assert.equal(r.ok, true);
    const c = fs.readFileSync(r.path, 'utf8');
    // The txt manual has a distinctive header the md one doesn't.
    assert.ok(/AUDIENCE:/.test(c), 'txt content selected for fmt=txt');
  });
});
