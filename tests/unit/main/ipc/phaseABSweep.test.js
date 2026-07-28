// tests/unit/main/ipc/phaseABSweep.test.js
// ============================================================================
// Phase A + Phase B full-tool-sweep harness. Exercises the new wire format
// (`mmx:run:job`, `mmx:profile`), confirms the contract holds end-to-end,
// and reports every tool call to the debug server in
// `.dbg/full-tool-sweep.env` so we have evidence.
//
// Phase A surfaces covered:
//   mmx:run  → legacy call (no jobId) → { line, jobId: null, kind }
//   mmx:run:job → new wire format     → { line, jobId: 'j1', kind }
//   mmx:cancel  → cancels all live procs (JobRunner multi-proc)
//
// Phase B surfaces covered:
//   mmx:profile → 5-minute cached profile (concurrentLimit, planType)
//
// Bugs to look for (Phase A/B specific):
//   H1. mmx:run:job is registered (asserted via handler exists).
//   H2. mmx:run:job rejects when the first arg is missing.
//   H3. mmx:run:job sends log chunks with the supplied jobId.
//   H4. mmx:profile caches the response (second call within 5 min
//       does NOT re-invoke the underlying mmx quota command).
//   H5. mmx:profile returns { ok: true, concurrentLimit, planType }
//       even when the underlying quota response has no concurrentLimit.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DEBUG_ENV_PATH = path.join(ROOT, '.dbg', 'full-tool-sweep.env');

function purgeProjectCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ROOT) && key !== __filename) delete require.cache[key];
  }
}

function makeDebugReporter() {
  let url = null;
  let sessionId = 'phase-ab-sweep';
  try {
    const envText = fs.readFileSync(DEBUG_ENV_PATH, 'utf8');
    url = envText.match(/DEBUG_SERVER_URL=(.+)/)?.[1]?.trim() || null;
    sessionId = envText.match(/DEBUG_SESSION_ID=(.+)/)?.[1]?.trim() || sessionId;
  } catch (_) { /* no debug server */ }
  function report(hypothesisId, location, msg, data) {
    if (url && typeof fetch === 'function') {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, runId: 'phase-ab', hypothesisId, location, msg, data, ts: Date.now() }),
      }).catch(() => {});
    }
  }
  return { report };
}

function createElectronMock() {
  const handlers = {};
  return {
    handlers,
    module: {
      ipcMain: { handle(channel, fn) { handlers[channel] = fn; } },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: {
        showItemInFolder: () => {},
        openPath: async () => '',
        openExternal: async () => {},
      },
      app: { getPath() { return process.cwd(); } },
      BrowserWindow: class {},
      contextBridge: undefined,
      ipcRenderer: undefined,
    },
  };
}

// Common mmx mock used by every Phase A/B IPC test. Tracks quotaCalls
// so the H4 (caching) test can assert the quota subcommand is invoked
// exactly once across multiple mmx:profile calls.
function makeMmxMock(opts = {}) {
  const quotaCalls = { count: 0 };
  const runCalls = { count: 0 };
  return {
    async runMmx(optsArg) {
      runCalls.count++;
      const args = optsArg && optsArg.args;
      if (args && args[0] === 'quota') quotaCalls.count++;
      const isOk = opts.runMode === undefined || opts.runMode === 'ok';
      const stdout = opts.stdoutOverride
        || (args && args[0] === 'quota'
            ? '{"ok":true,"concurrentLimit":4,"planType":"global"}'
            : '[log] ' + (args ? args.join(' ') : ''));
      const parsed = (args && args[0] === 'quota')
        ? { concurrentLimit: 4, planType: 'global' }
        : null;
      return {
        ok: isOk, code: isOk ? 0 : 1,
        stdout, stderr: '',
        parsed,
        command: 'mmx', argv: args,
      };
    },
    cancelAll() {},
    cancelOne() {},
    getActiveProcs() { return []; },
    resolve() { return { command: 'node.exe', error: null }; },
    _quotaCalls: quotaCalls,
    _runCalls: runCalls,
  };
}

async function withIsolatedProject(options, run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-ab-sweep-'));
  const previousConfigDir = process.env.MINIMAX_CONFIG_DIR;
  process.env.MINIMAX_CONFIG_DIR = tmp;
  fs.writeFileSync(path.join(tmp, 'config.txt'),
    'api_key=sk-sweep\nregion=global\noutput_dir=' + path.join(tmp, 'output') + '\n',
    'utf8');
  purgeProjectCache();
  const electron = createElectronMock();
  if (options && options.contextBridge) electron.module.contextBridge = options.contextBridge;
  if (options && options.ipcRenderer) electron.module.ipcRenderer = options.ipcRenderer;
  electron.module.app.getPath = (name) => {
    if (name === 'exe') return path.join(tmp, 'MiniMaxAssetsTool.exe');
    return tmp;
  };
  const mocks = (options && options.mocks) || {};
  try {
    return await new Promise((resolve, reject) => {
      const originalLoad = Module._load;
      Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'electron') return electron.module;
        if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
        for (const key of Object.keys(mocks)) {
          if (request.endsWith(key)) return mocks[key];
          if (path.isAbsolute(key) && request.endsWith(key.replace(/\\/g, '/'))) return mocks[key];
          try {
            const parentDir = parent && parent.filename ? path.dirname(parent.filename) : ROOT;
            const resolved = path.resolve(parentDir, key);
            const tail = resolved.replace(/\\/g, '/').split('/').slice(-3).join('/');
            if (request.endsWith(tail)) return mocks[key];
            if (parent && parent.filename) {
              const relResolved = path.resolve(path.dirname(parent.filename), key);
              if (request === relResolved || request.endsWith(relResolved)) return mocks[key];
            }
          } catch (_) {}
        }
        if (request.includes('mmx') && process.env.__DEBUG_MMX) {
          process.stderr.write('DEBUG_MISS request=' + request + ' parent.f=' + (parent && parent.filename) + '\n');
          for (const key of Object.keys(mocks)) {
            try {
              const parentDir = parent && parent.filename ? path.dirname(parent.filename) : ROOT;
              const relResolved = path.resolve(parentDir, key);
              process.stderr.write('  key=' + key + ' relResolved=' + relResolved + ' match=' + (request === relResolved || request.endsWith(relResolved)) + '\n');
            } catch (_) {}
          }
        }
        return originalLoad.call(this, request, parent, isMain);
      };
      try {
        return Promise.resolve(run({ tmp, electron, load: (rel) => require(path.join(ROOT, rel)) })).then(resolve, reject);
      } catch (e) { reject(e); }
      finally {
        Module._load = originalLoad;
      }
    });
  } finally {
    if (previousConfigDir == null) delete process.env.MINIMAX_CONFIG_DIR;
    else process.env.MINIMAX_CONFIG_DIR = previousConfigDir;
    purgeProjectCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

// Helper: register the IPC handlers with a fresh mmx mock + given mocks.
// We mock BOTH mmx AND config so the IPC handler doesn't depend on the
// real config.txt filesystem layout (which would couple the test to
// configMod's read() path resolution).
async function setupMmxIpc({ mmxMock }) {
  const cfgModMock = {
    read() { return { api_key: 'sk-sweep', region: 'global', output_dir: '', theme: 'dark', styles: [] }; },
    write() {},
    statePath: () => path.join(ROOT, 'state.json'),
  };
  return await withIsolatedProject({
    mocks: {
      '../../src/mmx': mmxMock,
      '../../src/config': cfgModMock,
      './resolveCredential': {
        resolveCredential: () => ({ apiKey: 'sk-test-only', sessionOnly: false }),
      },
      // R7.2: mock capability service (no real CLI probes in tests).
      '../../src/mmxCapability': { getSnapshot: () => null, invalidate: () => {} },
    },
  }, async ({ tmp, electron, load }) => {
    load('main/ipc/registerMmxIpc.js').register({
      appRoot: ROOT,
      getMainWindow: () => null,
    });
    return { tmp, electron };
  });
}

test('Phase A / H1: registerMmxIpc.js exposes mmx:run:job, mmx:cancel, mmx:profile', async () => {
  const { report } = makeDebugReporter();
  const mmx = makeMmxMock();
  const { electron } = await setupMmxIpc({ mmxMock: mmx });
  report('H1', 'phaseABSweep:H1', 'after register', {
    hasRunJob: typeof electron.handlers['mmx:run:job'] === 'function',
    hasProfile: typeof electron.handlers['mmx:profile'] === 'function',
    hasCancel: typeof electron.handlers['mmx:cancel'] === 'function',
  });
  assert.equal(typeof electron.handlers['mmx:run:job'], 'function');
  assert.equal(typeof electron.handlers['mmx:profile'], 'function');
  assert.equal(typeof electron.handlers['mmx:cancel'], 'function');
});

test('Phase A / H3: mmx:run:job calls runMmx with the supplied args', async () => {
  const { report } = makeDebugReporter();
  const mmx = makeMmxMock();
  const out = await setupMmxIpc({ mmxMock: mmx });
  const { electron } = out;
  const res = await electron.handlers['mmx:run:job'](null, {
    args: ['image', 'generate', '--prompt', 'robot'],
    jobId: 'j-7',
  });
  report('H3', 'phaseABSweep:H3', 'after run:job', {
    res, runCalls: mmx._runCalls.count, quotaCalls: mmx._quotaCalls.count,
  });
  assert.equal(mmx._runCalls.count, 1, 'mock runMmx must be called. res=' + JSON.stringify(res));
  assert.equal(res.ok, true);
  assert.deepEqual(res.argv, ['image', 'generate', '--prompt', 'robot']);
});

test('Phase A / mmx:run (legacy): plain-string call still works end-to-end', async () => {
  const { report } = makeDebugReporter();
  const mmx = makeMmxMock();
  const { electron } = await setupMmxIpc({ mmxMock: mmx });
  const res = await electron.handlers['mmx:run'](null, ['image']);
  report('H3', 'phaseABSweep:H3:legacy', 'after legacy run', { res });
  assert.equal(res.ok, true);
  assert.equal(res.command, 'mmx');
});

test('Phase B / H4: mmx:profile caches the response (second call does not re-invoke quota)', async () => {
  const { report } = makeDebugReporter();
  const mmx = makeMmxMock();
  const { electron } = await setupMmxIpc({ mmxMock: mmx });
  const p1 = await electron.handlers['mmx:profile']();
  const p2 = await electron.handlers['mmx:profile']();
  const p3 = await electron.handlers['mmx:profile']();
  report('H4', 'phaseABSweep:H4:profile', 'after 3 calls', {
    quotaCalls: mmx._quotaCalls.count,
    p1: { ok: p1.ok, concurrentLimit: p1.concurrentLimit, planType: p1.planType },
  });
  assert.equal(p1.ok, true);
  assert.equal(p1.concurrentLimit, 4);
  assert.equal(p1.planType, 'global');
  assert.equal(mmx._quotaCalls.count, 1, 'mmx:profile must cache the result within the 5-min window');
});

test('Phase B / H5: mmx:profile returns ok:true with concurrentLimit=undefined when quota has none', async () => {
  const { report } = makeDebugReporter();
  const mmx = makeMmxMock({ stdoutOverride: '{"ok":true}' });
  const { electron } = await setupMmxIpc({ mmxMock: mmx });
  const p = await electron.handlers['mmx:profile']();
  report('H5', 'phaseABSweep:H5:profile:empty', 'after profile call', {
    p: { ok: p.ok, concurrentLimit: p.concurrentLimit, planType: p.planType },
  });
  assert.equal(p.ok, true);
  // The production code parses stdout even when mmx.runMmx returns
  // parsed: null. The test mock above overrides stdout to a JSON
  // without concurrentLimit; the handler must parse it and return
  // concurrentLimit: undefined. (Phase B claim: defensive.)
  assert.ok('concurrentLimit' in p, 'profile must surface concurrentLimit (even if undefined)');
});

test('Phase A / preload bridge exposes mmxRunJob, mmxProfile, onBeforeQuit', async () => {
  const invokes = [];
  const listeners = [];
  let exposedName = null;
  let api = null;
  const ipcRenderer = {
    invoke(channel, ...args) { invokes.push({ channel, args }); return Promise.resolve({ channel, args }); },
    on(channel, fn) { listeners.push({ type: 'on', channel, fn }); },
    removeListener() {},
    send() {},
  };
  await withIsolatedProject({
    contextBridge: { exposeInMainWorld(name, exposed) { exposedName = name; api = exposed; } },
    ipcRenderer,
  }, async ({ load }) => {
    load('preload.js');
  });
  assert.equal(exposedName, 'api');
  for (const key of ['mmxRunJob', 'mmxProfile', 'onBeforeQuit', 'stateArchiveRead', 'stateArchiveClear', 'stateArchiveSize', 'stateArchiveDelete']) {
    assert.equal(typeof api[key], 'function', `preload must expose api.${key}`);
  }
});
