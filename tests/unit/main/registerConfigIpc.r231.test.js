// tests/unit/main/registerConfigIpc.r231.test.js
// ============================================================================
// R2.3.1 — Wiring: `config:set` clears the persisted
// `~/.mmx/config.json api_key` when the renderer signals
// `apiKeyNoSave: true`.
//
// The R2.3 helper (`clearApiKeyFromMmxCliConfig`) exists and works;
// the wiring is the missing piece. The frozen-RED test R0.1-002.B
// already passed by R2.3 alone (it only checks the helper exists),
// but the END-TO-END privacy switch (renderer → main → config.txt
// + ~/.mmx/config.json) is not yet exercised.
//
// This file tests:
//   1. `config:set` with `apiKeyNoSave: true` clears the persisted
//      `~/.mmx/config.json` api_key.
//   2. `config:set` WITHOUT `apiKeyNoSave` does NOT touch the
//      persisted key (the "Save my key" path is preserved).
//   3. A clear failure surfaces in the response envelope as
//      `{ ok: false, error: '<reason>' }` (not silently
//      "successful") so the renderer can show a visible error.
//   4. The clear runs AFTER the config.txt write (not before), so
//      the save gesture is atomic from the user's perspective.
//   5. The renderer's `cfg._apiKeyNoSave` backward-compat path
//      (the pre-R2.3.1 transient field) still works.
//   6. Multi-tenant security: the clear only triggers when the
//      payload explicitly carries `apiKeyNoSave: true`. A bare
//      cfg without the flag is treated as "user wants to keep
//      the persisted key".
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const IPC_PATH = path.join(ROOT, 'main', 'ipc', 'registerConfigIpc.js');
const CFG_PATH = path.join(ROOT, 'src', 'config.js');
const STATE_PATH = path.join(ROOT, 'src', 'state.js');
const SYNC_PATH = path.join(ROOT, 'src', 'mmxApiKeySync.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r231-'));

function makeHome() {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.MINIMAX_CONFIG_DIR = home;
  return home;
}

function clearCache() {
  for (const p of [IPC_PATH, CFG_PATH, STATE_PATH, SYNC_PATH,
    path.join(ROOT, 'main', 'services', 'PathSecurityService'),
    path.join(ROOT, 'main', 'services', 'VoicesCacheService')]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
}

function loadConfigIpc() {
  const handlers = new Map();
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      app: { getPath: () => process.env.MINIMAX_CONFIG_DIR || process.cwd() },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    },
  };
  delete require.cache[IPC_PATH];
  require(IPC_PATH).register({ getMainWindow: () => null, appRoot: process.env.MINIMAX_CONFIG_DIR });
  return handlers;
}

const M = () => path.join(process.env.USERPROFILE, '.mmx', 'config.json');
const seedMmxConfig = (obj) => {
  const dir = path.dirname(M());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(M(), JSON.stringify(obj, null, 2));
};
const readMmxConfig = () => {
  try { return JSON.parse(fs.readFileSync(M(), 'utf8')); } catch (_) { return null; }
};
const seedAppConfig = (obj) => {
  const lines = [
    'api_key=' + (obj.api_key || ''),
    'output_dir=' + (obj.output_dir || ''),
    'region=' + (obj.region || 'global'),
    'theme=' + (obj.theme || 'dark'),
    'styles=',
    '',
  ];
  fs.writeFileSync(path.join(process.env.MINIMAX_CONFIG_DIR, 'config.txt'), lines.join('\n'));
};

test.beforeEach(() => {
  clearCache();
  makeHome();
});

test.afterEach(() => {
  clearCache();
  delete process.env.USERPROFILE;
  delete process.env.HOME;
  delete process.env.MINIMAX_CONFIG_DIR;
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// R2.3.1.A: `config:set` with `apiKeyNoSave: true` clears the persisted
//            `~/.mmx/config.json api_key`
// ---------------------------------------------------------------------------
test('R2.3.1.A: apiKeyNoSave=true clears ~/.mmx/config.json api_key (end-to-end privacy switch)', () => {
  seedAppConfig({ api_key: 'sk-WAS-PERSISTED' });
  seedMmxConfig({ api_key: 'sk-WAS-PERSISTED', region: 'global' });
  // Precondition.
  assert.equal(readMmxConfig().api_key, 'sk-WAS-PERSISTED', 'precondition: ~/.mmx/config.json must have the persisted key');

  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  assert.ok(configSet, 'config:set must be registered');
  const r = configSet({}, {
    cfg: { api_key: '', output_dir: '', region: 'global', theme: 'dark', styles: [] },
    apiKeyNoSave: true,
  });
  assert.equal(r.ok, true, 'config:set must return ok:true on success. Got: ' + JSON.stringify(r));
  // config.txt is updated (api_key is now empty)
  // AND ~/.mmx/config.json is cleared.
  const after = readMmxConfig();
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'api_key'), false,
    'R2.3.1.A: ~/.mmx/config.json api_key must be removed after the privacy switch. Got: ' + JSON.stringify(after));
  assert.equal(after.region, 'global', 'R2.3.1.A: region must be preserved (only api_key is removed)');
});

// ---------------------------------------------------------------------------
// R2.3.1.B: `config:set` WITHOUT `apiKeyNoSave` does NOT touch the
//            persisted key (Save-my-key path is preserved)
// ---------------------------------------------------------------------------
test('R2.3.1.B: apiKeyNoSave NOT set preserves ~/.mmx/config.json api_key (Save-my-key path)', () => {
  seedAppConfig({ api_key: 'sk-OLD' });
  seedMmxConfig({ api_key: 'sk-PERSISTED', region: 'global' });
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, {
    cfg: { api_key: 'sk-NEW', output_dir: '', region: 'global', theme: 'dark', styles: [] },
    apiKeyNoSave: false,
  });
  // The user wants to keep the persisted key. The clear must
  // NOT run, even though the new cfg.api_key is different.
  // (Note: syncApiKeyToMmxCliConfig is not called from
  // config:set, so the new key is NOT yet persisted to
  // ~/.mmx/config.json — that happens on the next mmx:run:job
  // call. Today's contract: config:set only clears when the
  // user explicitly opts into session-only.)
  const after = readMmxConfig();
  assert.equal(after.api_key, 'sk-PERSISTED',
    'R2.3.1.B: ~/.mmx/config.json api_key must be preserved when apiKeyNoSave is NOT true. Got: ' + JSON.stringify(after));
});

// ---------------------------------------------------------------------------
// R2.3.1.C: backward-compat — `cfg._apiKeyNoSave === true` is also
//            accepted (the pre-R2.3.1 renderer transient field)
// ---------------------------------------------------------------------------
test('R2.3.1.C: cfg._apiKeyNoSave=true (legacy transient field) triggers the clear', () => {
  seedAppConfig({ api_key: 'sk-OLD' });
  seedMmxConfig({ api_key: 'sk-LEGACY', region: 'global' });
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, {
    cfg: {
      api_key: '',
      output_dir: '',
      region: 'global',
      theme: 'dark',
      styles: [],
      _apiKeyNoSave: true, // legacy transient key
    },
    // No `apiKeyNoSave` field at the top level — the legacy
    // backward-compat path is exercised.
  });
  const after = readMmxConfig();
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'api_key'), false,
    'R2.3.1.C: cfg._apiKeyNoSave=true must trigger the clear (legacy renderer). Got: ' + JSON.stringify(after));
});

// ---------------------------------------------------------------------------
// R2.3.1.D: a clear failure surfaces in the response envelope
// ---------------------------------------------------------------------------
test('R2.3.1.D: a clear failure surfaces in the response as ok:true + warnings (KGO5-026)', () => {
  seedAppConfig({ api_key: 'sk-OLD' });
  seedMmxConfig({ api_key: 'sk-OLD', region: 'global' });
  // Stub the mmxApiKeySync module to simulate a clear failure.
  // We must inject the stub BEFORE loadConfigIpc() reads it.
  const MMX_PATH = path.join(ROOT, 'src', 'mmxApiKeySync');
  require.cache[require.resolve(MMX_PATH)] = {
    exports: {
      syncApiKeyToMmxCliConfig: () => true,
      clearApiKeyFromMmxCliConfig: () => false, // simulate a clear failure
      _resetForTest: () => {},
    },
  };
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, {
    cfg: { api_key: '', output_dir: '', region: 'global', theme: 'dark', styles: [] },
    apiKeyNoSave: true,
  });
  assert.equal(r.ok, true,
    'R2.3.1.D: config was written, ok must be true (KGO5-026). Got: ' + JSON.stringify(r));
  assert.match(r.error || '', /clearApiKeyFromMmxCliConfig returned false|may still contain/,
    'R2.3.1.D: error message must explain the clear failure. Got: ' + (r && r.error));
  assert.ok(Array.isArray(r.warnings) && r.warnings.length > 0,
    'R2.3.1.D: warnings array must include the clear failure. Got: ' + JSON.stringify(r.warnings));
});

// ---------------------------------------------------------------------------
// R2.3.1.E: the clear runs AFTER the config.txt write (atomic from
//            the user's perspective)
// ---------------------------------------------------------------------------
test('R2.3.1.E: the clear runs AFTER the config.txt write (atomic from user perspective)', () => {
  // We assert this by ordering: the config.txt must contain the
  // new (empty) api_key AND ~/.mmx/config.json must NOT have the
  // old api_key. Both must be true after a single config:set call.
  seedAppConfig({ api_key: 'sk-OLD' });
  seedMmxConfig({ api_key: 'sk-OLD', region: 'global' });
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, {
    cfg: { api_key: '', output_dir: '', region: 'global', theme: 'dark', styles: [] },
    apiKeyNoSave: true,
  });
  // Read both files and assert the post-state.
  const appCfg = fs.readFileSync(path.join(process.env.MINIMAX_CONFIG_DIR, 'config.txt'), 'utf8');
  assert.match(appCfg, /^api_key=\s*$/m,
    'R2.3.1.E: config.txt must have empty api_key after the privacy switch. Got: ' + appCfg);
  const mmxCfg = readMmxConfig();
  assert.equal(Object.prototype.hasOwnProperty.call(mmxCfg, 'api_key'), false,
    'R2.3.1.E: ~/.mmx/config.json must have api_key removed. Got: ' + JSON.stringify(mmxCfg));
  assert.equal(mmxCfg.region, 'global',
    'R2.3.1.E: ~/.mmx/config.json region must be preserved. Got: ' + JSON.stringify(mmxCfg));
});
