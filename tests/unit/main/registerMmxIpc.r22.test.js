// tests/unit/main/registerMmxIpc.r22.test.js
// ============================================================================
// R2.2 — Mmx-Credentialresolver (SYS-002, 360° audit design contract §5)
//
// Contract: a single `_resolveCredential(payload)` helper inside
// `main/ipc/registerMmxIpc.js` is the source of truth for the
// credential that `mmx:run` / `mmx:run:job` hands to `runMmx`.
//
//   • payload.sessionOnly === true + non-empty rendererApiKey
//     → { apiKey: <key>, sessionOnly: true }
//   • payload.sessionOnly === true + missing/empty rendererApiKey
//     → { apiKey: null, sessionOnly: true, error: <message> }
//   • payload.sessionOnly !== true (or absent)
//     → read cfg.api_key + persisted apiKeyNoSave
//   • any thrown cfgMod.read() → { apiKey: null, error: ... }
//
// Schreibt NUR in OS-Temp.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const IPC_PATH = path.join(ROOT, 'main', 'ipc', 'registerMmxIpc.js');
const CFG_PATH = path.join(ROOT, 'src', 'config.js');
const STATE_PATH = path.join(ROOT, 'src', 'state.js');

function makeTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r22-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.MINIMAX_CONFIG_DIR = home;
  return home;
}

function clearCache() {
  for (const p of [IPC_PATH, CFG_PATH, STATE_PATH]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
}

function loadIpcWithElectronMock() {
  const handlers = new Map();
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      app: { getPath: () => process.env.MINIMAX_CONFIG_DIR || process.cwd() },
    },
  };
  // mmx.js stub: we don't actually need runMmx to do anything for
  // _resolveCredential tests; we only need the IPC to load.
  require.cache[require.resolve(path.join(ROOT, 'src', 'mmx'))] = {
    exports: {
      runMmx: async () => ({ ok: true, code: 0, stdout: '{}', stderr: '', parsed: {} }),
      cancelAll: () => {}, cancelOne: () => {}, cancelByJobId: () => {},
      resolve: () => ({ command: 'mmx-mock', prefix: [] }),
      probeMmxVersion: () => '1.0.16', SUPPORTED_MMX: { min: '1.0.16', recommended: '1.0.16' },
      compareSemver: () => 0,
    },
  };
  require.cache[require.resolve(path.join(ROOT, 'main', 'services', 'VoicesCacheService'))] = {
    exports: { get: async () => ({ ok: true, voices: [] }) },
  };
  return handlers;
}

test.beforeEach(() => {
  clearCache();
  makeTempHome();
});

test.afterEach(() => {
  clearCache();
  delete process.env.USERPROFILE;
  delete process.env.HOME;
  delete process.env.MINIMAX_CONFIG_DIR;
});

// ---------------------------------------------------------------------------
// R2.2.A: explicit sessionOnly + non-empty rendererApiKey → both honored
// ---------------------------------------------------------------------------
test('R2.2.A: sessionOnly + rendererApiKey yields the in-memory key + sessionOnly:true', () => {
  // Empty config.txt (session-only).
  const home = process.env.MINIMAX_CONFIG_DIR;
  fs.writeFileSync(path.join(home, 'config.txt'),
    ['api_key=', 'output_dir=', 'region=global', 'theme=dark', 'styles=', ''].join('\n'));
  // Important: do NOT register the IPC (we only want the helper).
  // We extract the helper by reading the source and stubbing out
  // the rest. But the simpler approach: register the IPC with the
  // electron mock, then exercise `mmx:run:job` with the payload and
  // inspect what runMmx received.
  const handlers = loadIpcWithElectronMock();
  let capturedOpts = null;
  require.cache[require.resolve(path.join(ROOT, 'src', 'mmx'))] = {
    exports: {
      runMmx: async (opts) => { capturedOpts = opts; return { ok: true, code: 0, stdout: '{}', stderr: '', parsed: {} }; },
      cancelAll: () => {}, cancelOne: () => {}, cancelByJobId: () => {},
      resolve: () => ({ command: 'mmx-mock', prefix: [] }),
      probeMmxVersion: () => '1.0.16', SUPPORTED_MMX: { min: '1.0.16', recommended: '1.0.16' },
      compareSemver: () => 0,
    },
  };
  delete require.cache[IPC_PATH];
  require(IPC_PATH).register({ getMainWindow: () => null, appRoot: home });
  const handler = handlers.get('mmx:run:job');
  assert.ok(handler, 'mmx:run:job must be registered');
  return handler({}, {
    args: ['quota'],
    jobId: 'r22a',
    sessionOnly: true,
    rendererApiKey: 'sk-IN-MEMORY-XYZ',
  }).then((r) => {
    assert.equal(r && r.ok, true, 'handler must succeed; got: ' + JSON.stringify(r));
    assert.equal(capturedOpts && capturedOpts.apiKey, 'sk-IN-MEMORY-XYZ',
      'R2.2: runMmx must receive the rendererApiKey as apiKey. Got: ' + JSON.stringify(capturedOpts));
    assert.equal(capturedOpts && capturedOpts.sessionOnly, true,
      'R2.2: runMmx must receive sessionOnly=true so the key is routed via MMX_API_KEY env, not argv');
  });
});

// ---------------------------------------------------------------------------
// R2.2.B: explicit sessionOnly but empty/missing rendererApiKey → fail-closed
// ---------------------------------------------------------------------------
test('R2.2.B: sessionOnly=true with empty/missing rendererApiKey must fail closed', () => {
  const home = process.env.MINIMAX_CONFIG_DIR;
  fs.writeFileSync(path.join(home, 'config.txt'),
    ['api_key=', 'output_dir=', 'region=global', 'theme=dark', 'styles=', ''].join('\n'));
  const handlers = loadIpcWithElectronMock();
  let capturedOpts = null;
  require.cache[require.resolve(path.join(ROOT, 'src', 'mmx'))] = {
    exports: {
      runMmx: async (opts) => { capturedOpts = opts; return { ok: true, code: 0, stdout: '{}', stderr: '', parsed: {} }; },
      cancelAll: () => {}, cancelOne: () => {}, cancelByJobId: () => {},
      resolve: () => ({ command: 'mmx-mock', prefix: [] }),
      probeMmxVersion: () => '1.0.16', SUPPORTED_MMX: { min: '1.0.16', recommended: '1.0.16' },
      compareSemver: () => 0,
    },
  };
  delete require.cache[IPC_PATH];
  require(IPC_PATH).register({ getMainWindow: () => null, appRoot: home });
  const handler = handlers.get('mmx:run:job');
  return handler({}, {
    args: ['quota'],
    jobId: 'r22b',
    sessionOnly: true,
    // rendererApiKey deliberately absent
  }).then((r) => {
    assert.equal(r && r.ok, false, 'handler must fail when sessionOnly=true without rendererApiKey');
    assert.match(r && r.stderr || '', /sessionOnly=true requires payload\.rendererApiKey/,
      'stderr must mention the missing rendererApiKey. Got: ' + (r && r.stderr));
    assert.equal(capturedOpts, null, 'runMmx must NOT have been called');
  });
});

// ---------------------------------------------------------------------------
// R2.2.C: non-session-only payload → reads cfg.api_key
// ---------------------------------------------------------------------------
test('R2.2.C: non-session-only payload reads the persisted cfg.api_key', () => {
  const home = process.env.MINIMAX_CONFIG_DIR;
  fs.writeFileSync(path.join(home, 'config.txt'),
    ['api_key=sk-PERSISTED', 'output_dir=', 'region=global', 'theme=dark', 'styles=', ''].join('\n'));
  const handlers = loadIpcWithElectronMock();
  let capturedOpts = null;
  require.cache[require.resolve(path.join(ROOT, 'src', 'mmx'))] = {
    exports: {
      runMmx: async (opts) => { capturedOpts = opts; return { ok: true, code: 0, stdout: '{}', stderr: '', parsed: {} }; },
      cancelAll: () => {}, cancelOne: () => {}, cancelByJobId: () => {},
      resolve: () => ({ command: 'mmx-mock', prefix: [] }),
      probeMmxVersion: () => '1.0.16', SUPPORTED_MMX: { min: '1.0.16', recommended: '1.0.16' },
      compareSemver: () => 0,
    },
  };
  delete require.cache[IPC_PATH];
  require(IPC_PATH).register({ getMainWindow: () => null, appRoot: home });
  const handler = handlers.get('mmx:run:job');
  return handler({}, {
    args: ['quota'],
    jobId: 'r22c',
    // sessionOnly deliberately absent
  }).then((r) => {
    assert.equal(r && r.ok, true, 'handler must succeed; got: ' + JSON.stringify(r));
    assert.equal(capturedOpts && capturedOpts.apiKey, 'sk-PERSISTED',
      'R2.2: non-session-only payload reads cfg.api_key. Got: ' + JSON.stringify(capturedOpts));
    assert.equal(capturedOpts && capturedOpts.sessionOnly, false,
      'R2.2: non-session-only payload must NOT set sessionOnly=true');
  });
});

// ---------------------------------------------------------------------------
// R2.2.D: legacy `mmx:run` does NOT honor sessionOnly + rendererApiKey
// (the 4th arg is ignored — session-only must go through `mmx:run:job`).
// ---------------------------------------------------------------------------
test('R2.2.D: legacy `mmx:run` does NOT honor sessionOnly + rendererApiKey (4th arg ignored)', () => {
  const home = process.env.MINIMAX_CONFIG_DIR;
  fs.writeFileSync(path.join(home, 'config.txt'),
    ['api_key=', 'output_dir=', 'region=global', 'theme=dark', 'styles=', ''].join('\n'));
  const handlers = loadIpcWithElectronMock();
  let capturedOpts = null;
  require.cache[require.resolve(path.join(ROOT, 'src', 'mmx'))] = {
    exports: {
      runMmx: async (opts) => { capturedOpts = opts; return { ok: true, code: 0, stdout: '{}', stderr: '', parsed: {} }; },
      cancelAll: () => {}, cancelOne: () => {}, cancelByJobId: () => {},
      resolve: () => ({ command: 'mmx-mock', prefix: [] }),
      probeMmxVersion: () => '1.0.16', SUPPORTED_MMX: { min: '1.0.16', recommended: '1.0.16' },
      compareSemver: () => 0,
    },
  };
  delete require.cache[IPC_PATH];
  require(IPC_PATH).register({ getMainWindow: () => null, appRoot: home });
  const handler = handlers.get('mmx:run');
  assert.ok(handler, 'mmx:run must be registered');
  return handler({}, ['quota'], null, {
    sessionOnly: true,
    rendererApiKey: 'sk-LEGACY-MM-RUN',
  }).then((r) => {
    // `mmx:run` signature is `(_e, args, grantId)` — the 4th arg is
    // ignored. R2.2 left the legacy path on `_resolveCredential(null)`
    // (no payload), so it falls through to cfg.api_key which is empty.
    // The legacy `mmx:run` is not used for session-only; the
    // session-only path goes through `mmx:run:job`. Document this:
    // legacy `mmx:run` keeps the pre-R2.2 behavior.
    // If a future refactor wires session-only into `mmx:run`, this
    // test will fail and the contract must be updated.
    assert.equal(r && r.ok, false,
      'R2.2.D: legacy `mmx:run` does not accept sessionOnly; it reads cfg.api_key. Got ok:true with: ' + JSON.stringify(r));
    // Confirm the 4th arg was indeed ignored — runMmx was NOT called.
    assert.equal(capturedOpts, null, 'R2.2.D: 4th arg must be ignored; runMmx must not be called');
  });
});
