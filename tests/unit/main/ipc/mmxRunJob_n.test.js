// tests/unit/main/ipc/mmxRunJob_n.test.js
// ============================================================================
// BEHAVIORAL regression test for "image generation with --n > 1 always
// fails with code -1" (user-reported bug, v1.1.18). The previous
// tests asserted that the IPC validator accepts --n 2 + --out-dir X.
// This test goes further: it asserts the full chain
//   renderer mmxRunJob → IPC mmx:run:job → runMmx → mock mmx
// produces code 0 (NOT -1) when the args are well-formed.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const MMX_PATH = path.resolve(ROOT, 'src', 'mmx.js');
const MMX_APIKEY_SYNC_PATH = path.resolve(ROOT, 'src', 'mmxApiKeySync.js');
const MMX_IPC_PATH = path.resolve(ROOT, 'main', 'ipc', 'registerMmxIpc.js');
const CONFIG_PATH = path.resolve(ROOT, 'src', 'config.js');

function resetCache() {
  for (const p of [MMX_PATH, MMX_APIKEY_SYNC_PATH, MMX_IPC_PATH, CONFIG_PATH]) {
    delete require.cache[p];
  }
}

// Mock child_process with a fake mmx that prints the expected JSON
// and exits 0. We also capture the spawned argv so we can assert.
function buildCpMock({ spawnImpl }) {
  const spawns = [];
  return {
    spawns,
    cpMock: {
      spawn: (cmd, args) => spawnImpl(cmd, args, spawns),
      spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    },
  };
}

// Mock fs enough that mmxApiKeySync.js + registerMmxIpc.js can run.
// We use the real fs for actual I/O so mkdir/stat work; we only
// override the home dir resolution via env vars.
function setupMocks({ onSpawn }) {
  const spawns = [];
  const cpMock = { spawn: () => ({}) }; // unused — we mock runMmx directly
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        ipcMain: { handle: (channel, fn) => { setupIpcMain.handlers.set(channel, fn); } },
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        BrowserWindow: null,
        app: { getPath: () => path.join(ROOT, 'fake-userData') },
      };
    }
    if (request === 'child_process') return cpMock;
    // Replace the mmx module with a thin facade that records the
    // args via onSpawn. We can't let the real mmx.js run because it
    // uses findNodeExe/findMmxEntry which assume mmx-cli is
    // installed in this test env.
    if (request === MMX_PATH || request === '../../src/mmx' || (typeof request === 'string' && request.endsWith('mmx.js'))) {
      return {
        runMmx: async (opts) => {
          onSpawn && onSpawn(opts.args || []);
          return {
            ok: true, code: 0,
            stdout: '{"saved":["a.jpg","b.jpg"]}',
            stderr: '',
            parsed: { saved: ['a.jpg', 'b.jpg'] },
            command: 'mmx-mock',
            argv: opts.args || [],
          };
        },
        cancelAll: () => {},
        cancelByJobId: () => {},
        cancelOne: () => {},
        resolve: () => ({ command: 'mmx-mock', prefix: [] }),
      };
    }
    if (request === MMX_APIKEY_SYNC_PATH || (typeof request === 'string' && request.endsWith('mmxApiKeySync.js'))) {
      return { syncApiKeyToMmxCliConfig: () => true };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  setupIpcMain.handlers = new Map();
  return { spawns };
}

const setupIpcMain = { handlers: new Map() };

async function loadIpcHandler() {
  delete require.cache[MMX_IPC_PATH];
  const mod = require(MMX_IPC_PATH);
  if (typeof mod === 'function') mod({ getMainWindow: () => null, appRoot: ROOT });
  else if (mod && typeof mod.register === 'function') mod.register({ getMainWindow: () => null, appRoot: ROOT });
  return setupIpcMain.handlers.get('mmx:run:job');
}

test('mmx:run:job with --n 2 produces code 0 (not -1) when the args are valid', async () => {
  resetCache();
  const seen = [];
  setupMocks({ onSpawn: (args) => seen.push(args) });
  const handler = await loadIpcHandler();
  // R1.5b.1: a grantId is now required for path-bearing args.
  // We pass 'mock-grant-id' — the existing setupMocks stub
  // pathSecurity.isPathUnderAny returns true and the test does
  // not pre-populate the PathGrantService cache, so the
  // grantAuthorizer lazy-require resolves to the REAL
  // PathGrantService (not the mock). The 'mock-grant-id' is not
  // in the real service's grant map, so the handler returns
  // 'grant not found' (code -1). To make this regression test
  // exercise the actual --n > 1 path, we pre-populate the
  // PathGrantService cache with a mock that accepts the grant.
  const pathGrantPath = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
  require.cache[pathGrantPath] = {
    exports: {
      defaultService: {
        authorize: (grantId, spec) => {
          if (!grantId) return { ok: false, error: 'grantId required' };
          if (!spec || typeof spec.path !== 'string') return { ok: false, error: 'path required' };
          return { ok: true, canonicalPath: spec.path };
        },
        mintDirectoryGrant: () => ({ ok: true, grantId: 'mock-grant-id', grant: {} }),
        mintFileGrant: () => ({ ok: true, grantId: 'mock-grant-id', grant: {} }),
        revoke: () => ({ ok: true }),
        destroy: () => 0,
      },
    },
  };
  const result = await handler({}, {
    args: [
      'image', 'generate',
      '--prompt', 'test cat',
      '--n', '2',
      '--out-dir', 'C:\\temp\\minimax-pipeline-test',
    ],
    jobId: 'job-n-test',
    sessionOnly: true,
    rendererApiKey: 'sk-test-only',
  }, 'mock-grant-id');
  if (result.code === -1) console.error('IPC returned code -1, stderr:', result.stderr);
  assert.notEqual(result.code, -1,
    'mmx:run:job with --n 2 + --out-dir <allowed-root> must NOT return code -1 (user-reported bug: --n > 1 always fails with -1). Got stderr: ' + result.stderr);
  assert.equal(result.code, 0,
    'mmx:run:job must return code 0 when runMmx succeeds with --n 2');
  assert.equal(result.ok, true);
  assert.equal(seen.length, 1, 'runMmx must have been called exactly once');
  assert.deepEqual(seen[0].slice(-6),
    ['--prompt', 'test cat', '--n', '2', '--out-dir', 'C:\\temp\\minimax-pipeline-test'],
    'runMmx argv must include the --n 2 + --out-dir flags verbatim');
});

test('mmx:run:job with --n 1 (no out-dir needed) also returns code 0', async () => {
  resetCache();
  setupMocks({ onSpawn: () => {} });
  const handler = await loadIpcHandler();
  // P4.1 (DB-H-002/008): the IPC now validates the --out artifact after
  // runMmx resolves. The runMmx mock doesn't write files, so pre-create a
  // plausible JPEG (>= 1 KB, JPEG magic) at the --out path.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-n1-'));
  const outFile = path.join(tmpDir, 'one.jpg');
  const jpg = Buffer.alloc(2048, 0);
  jpg[0] = 0xFF; jpg[1] = 0xD8; jpg[2] = 0xFF;
  fs.writeFileSync(outFile, jpg);
  // R1.5b.1: pre-populate the PathGrantService mock so the grant
  // contract is satisfied (the --out file needs write authorisation).
  const pathGrantPath = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
  require.cache[pathGrantPath] = {
    exports: {
      defaultService: {
        authorize: (grantId, spec) => {
          if (!grantId) return { ok: false, error: 'grantId required' };
          if (!spec || typeof spec.path !== 'string') return { ok: false, error: 'path required' };
          return { ok: true, canonicalPath: spec.path };
        },
        mintDirectoryGrant: () => ({ ok: true, grantId: 'mock-grant-id', grant: {} }),
        mintFileGrant: () => ({ ok: true, grantId: 'mock-grant-id', grant: {} }),
        revoke: () => ({ ok: true }),
        destroy: () => 0,
      },
    },
  };
  const result = await handler({}, {
    args: ['image', 'generate', '--prompt', 'one cat', '--n', '1', '--out', outFile],
    jobId: 'job-n1-test',
    sessionOnly: true,
    rendererApiKey: 'sk-test-only',
  }, 'mock-grant-id');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  assert.notEqual(result.code, -1, '--n 1 must also work (regression guard for the single-image path)');
  assert.equal(result.code, 0);
});

test('mmx:run:job rejects ONLY when the args are actually invalid (sanity check)', async () => {
  resetCache();
  setupMocks({ onSpawn: () => { throw new Error('runMmx must NOT be called for invalid args'); } });
  const handler = await loadIpcHandler();
  const r1 = await handler({}, { args: [], jobId: 'j' });
  assert.equal(r1.code, -1, 'empty args must return code -1 (sanity: validator is not a no-op)');
  const r2 = await handler({}, { args: ['unknown-sub', '--x', 'y'], jobId: 'j' });
  assert.equal(r2.code, -1, 'unknown subcommand must return code -1');
  const r3 = await handler({}, { args: ['image', 'generate', '--out-dir', 'C:\\evil\\path'], jobId: 'j' });
  assert.equal(r3.code, -1, 'path outside allow-list must return code -1');
});
