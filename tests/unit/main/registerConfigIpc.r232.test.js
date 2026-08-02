// tests/unit/main/registerConfigIpc.r232.test.js
// ============================================================================
// R2.3.2 — Phasenprüfung-of-Phasenprüfung: adversarial test sweep on the
// R2.3.1 `config:set` privacy-switch wiring.
//
// The R2.3.1 implementation (`4d75f59`) wired the `clearApiKeyFromMmxCliConfig()`
// call into the `config:set` handler. The original R2.3.1 tests
// (`registerConfigIpc.r231.test.js`) cover the happy path + 4 targeted
// scenarios. This file closes 10 adversarial gaps the R2.3.1 pass
// left open:
//
//   E1a: payload is `null`           → must return ok:false (defence: any IPC
//                                       must reject non-object payloads)
//   E1b: payload is a number         → must return ok:false
//   E1c: payload is an array         → must return ok:false (Array.isArray guard)
//   E1d: payload is {cfg: 5}         → must return ok:false (cfg must be object)
//   E1e: payload is {cfg: []}        → must return ok:false (cfg must not be array)
//   E1f: payload.apiKeyNoSave is the
//         string "true"               → must NOT trigger clear (type-strict boolean)
//   E1g: cfg._apiKeyNoSave is the
//         string "true"               → must NOT trigger clear (type-strict boolean)
//   E1h: clear-failure error path
//         must NOT contain the
//         api_key value               → security: no secret in error message
//   E1i: wrapped payload with no
//         `grants` field              → must be backward-compat (no grant check)
//   E1j: output_dir changed but no
//         `grants.output_dir` in a
//         wrapped payload             → must return ok:false (R1.2a grant
//                                       check still works alongside the
//                                       privacy switch)
//
// Pattern (NEW from R2.3.2, cross-project, CRITICAL): the privacy switch
// in R2.3.1 was added on top of an existing grant-check pipeline. The two
// code paths must be independent — a grant failure must surface as a
// grant error, and a privacy-switch failure must surface as a privacy
// error. They must not silently swallow each other.
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
const GRANT_PATH = path.join(ROOT, 'main', 'services', 'PathGrantService');
const VOICES_PATH = path.join(ROOT, 'main', 'services', 'VoicesCacheService');
// B-002 (hhhhu2 audit): config:set routes keys through the
// CredentialRepository + SecretBlobStore; both must be re-loaded per test.
const CRED_REPO_PATH = path.join(ROOT, 'main', 'services', 'CredentialRepository.js');
const SECRET_BLOB_PATH = path.join(ROOT, 'main', 'services', 'SecretBlobStore.js');
const SESSION_STORE_PATH = path.join(ROOT, 'main', 'services', 'SessionCredentialStore.js');
const CRED_PRESENCE_PATH = path.join(ROOT, 'main', 'services', 'credentialPresence.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r232-'));

function makeHome() {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.MINIMAX_CONFIG_DIR = home;
  return home;
}

function clearCache() {
  for (const p of [IPC_PATH, CFG_PATH, STATE_PATH, SYNC_PATH, GRANT_PATH, VOICES_PATH, CRED_REPO_PATH, SECRET_BLOB_PATH, SESSION_STORE_PATH, CRED_PRESENCE_PATH]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
}

function loadConfigIpc(grantMock) {
  const handlers = new Map();
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      app: { getPath: () => process.env.MINIMAX_CONFIG_DIR || process.cwd() },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      // B-002 (hhhhu2 audit): SecretBlobStore persists keys via safeStorage.
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
        decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
      },
    },
  };
  // Optionally inject a grant-service mock BEFORE loadConfigIpc() reads it.
  if (grantMock) {
    require.cache[require.resolve(GRANT_PATH)] = grantMock;
  }
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
const fakeGrantModule = (overrides = {}) => ({
  defaultService: {
    inspect: overrides.inspect || (() => null),
    authorize: overrides.authorize || (() => ({ ok: false, error: 'no grant' })),
    mintDirectoryGrant: overrides.mintDirectoryGrant || (() => ({ ok: false })),
  },
});

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
// E1a: payload is null → must return ok:false
// ---------------------------------------------------------------------------
test('E1a: payload=null returns ok:false (non-object payload guard)', () => {
  seedAppConfig({ api_key: '' });
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, null);
  assert.equal(r.ok, false, 'E1a: payload=null must return ok:false. Got: ' + JSON.stringify(r));
  assert.match(r.error || '', /must be a plain object|null/,
    'E1a: error must explain the payload type. Got: ' + (r && r.error));
});

// ---------------------------------------------------------------------------
// E1b: payload is a number → must return ok:false
// ---------------------------------------------------------------------------
test('E1b: payload=42 returns ok:false (non-object payload guard)', () => {
  seedAppConfig({ api_key: '' });
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, 42);
  assert.equal(r.ok, false, 'E1b: payload=42 must return ok:false. Got: ' + JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// E1c: payload is an array → must return ok:false (Array.isArray guard)
// ---------------------------------------------------------------------------
test('E1c: payload=[1,2,3] returns ok:false (Array.isArray guard)', () => {
  seedAppConfig({ api_key: '' });
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, [1, 2, 3]);
  assert.equal(r.ok, false, 'E1c: payload=array must return ok:false. Got: ' + JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// E1d: payload is {cfg: 5} → must return ok:false (cfg must be a plain object)
// ---------------------------------------------------------------------------
test('E1d: payload={cfg: 5} returns ok:false (cfg must be a plain object)', () => {
  seedAppConfig({ api_key: '' });
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, { cfg: 5 });
  assert.equal(r.ok, false, 'E1d: payload={cfg: 5} must return ok:false. Got: ' + JSON.stringify(r));
  assert.match(r.error || '', /must be a plain object|null/,
    'E1d: error must explain the cfg type. Got: ' + (r && r.error));
});

// ---------------------------------------------------------------------------
// E1e: payload is {cfg: []} → must return ok:false (Array.isArray on cfg)
// ---------------------------------------------------------------------------
test('E1e: payload={cfg: []} returns ok:false (Array.isArray guard on cfg)', () => {
  seedAppConfig({ api_key: '' });
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, { cfg: [] });
  assert.equal(r.ok, false, 'E1e: payload={cfg: []} must return ok:false. Got: ' + JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// E1f: payload.apiKeyNoSave is the STRING "true" → must NOT trigger clear
//      (type-strict boolean — the contract is `true` literal, not truthy)
// ---------------------------------------------------------------------------
test('E1f: apiKeyNoSave="true" (string) does NOT trigger the clear (type-strict boolean)', () => {
  seedAppConfig({ api_key: 'sk-OLD' });
  seedMmxConfig({ api_key: 'sk-MUST-STAY', region: 'global' });
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, {
    cfg: { api_key: '', output_dir: '', region: 'global', theme: 'dark', styles: [] },
    apiKeyNoSave: 'true', // STRING, not boolean — must not trigger
  });
  // The clear must NOT have run.
  const after = readMmxConfig();
  assert.equal(after.api_key, 'sk-MUST-STAY',
    'E1f: apiKeyNoSave="true" (string) must NOT trigger the clear. Got: ' + JSON.stringify(after));
});

// ---------------------------------------------------------------------------
// E1g: cfg._apiKeyNoSave is the STRING "true" → must NOT trigger clear
// ---------------------------------------------------------------------------
test('E1g: cfg._apiKeyNoSave="true" (string) does NOT trigger the clear (type-strict)', () => {
  seedAppConfig({ api_key: 'sk-OLD' });
  seedMmxConfig({ api_key: 'sk-MUST-STAY', region: 'global' });
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, {
    cfg: {
      api_key: '',
      output_dir: '',
      region: 'global',
      theme: 'dark',
      styles: [],
      _apiKeyNoSave: 'true', // STRING, not boolean
    },
  });
  const after = readMmxConfig();
  assert.equal(after.api_key, 'sk-MUST-STAY',
    'E1g: cfg._apiKeyNoSave="true" (string) must NOT trigger the clear. Got: ' + JSON.stringify(after));
});

// ---------------------------------------------------------------------------
// E1h: clear-failure error path must NOT contain the api_key value
//      (security: no secret in the error message)
// ---------------------------------------------------------------------------
test('E1h: clear-failure error message does NOT contain the api_key value', () => {
  const secretKey = 'sk-DEEP-SECRET-DO-NOT-LEAK-12345';
  seedAppConfig({ api_key: '' });
  seedMmxConfig({ api_key: secretKey, region: 'global' });
  // Force the clear to fail by injecting a stub that returns false.
  require.cache[require.resolve(SYNC_PATH)] = {
    exports: {
      syncApiKeyToMmxCliConfig: () => true,
      clearApiKeyFromMmxCliConfig: () => false, // simulate a clear failure
      _resetForTest: () => {},
    },
  };
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, {
    cfg: { api_key: secretKey, output_dir: '', region: 'global', theme: 'dark', styles: [] },
    apiKeyNoSave: true,
  });
  assert.equal(r.ok, true, 'E1h: config was written successfully, ok must be true (KGO5-026)');
    assert.ok(r.warnings && r.warnings.length > 0, 'E1h: privacy warning must be in warnings[]');
  // The error message and warnings must NOT contain the secret key.
  const errorStr = (r.error || '') + ' ' + (Array.isArray(r.warnings) ? r.warnings.join(' ') : '');
  assert.ok(!errorStr.includes(secretKey),
    'E1h: error/warnings must NOT contain the api_key value. Got: ' + errorStr);
  assert.ok(!errorStr.includes('sk-DEEP-SECRET'),
    'E1h: error/warnings must NOT contain any prefix of the secret. Got: ' + errorStr);
});

// ---------------------------------------------------------------------------
// E1i: wrapped payload with no `grants` field is backward-compat
//      (R1.2a grant check is skipped when output_dir is unchanged)
// ---------------------------------------------------------------------------
test('E1i: wrapped payload without grants field is backward-compat when output_dir is unchanged', () => {
  seedAppConfig({ api_key: 'sk-OLD', output_dir: 'C:\\user\\output' });
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, {
    cfg: { api_key: 'sk-NEW', output_dir: 'C:\\user\\output', region: 'global', theme: 'dark', styles: [] },
    apiKeyNoSave: false,
    // no `grants` field — must be backward-compat
  });
  assert.equal(r.ok, true,
    'E1i: wrapped payload without grants must succeed when output_dir is unchanged. Got: ' + JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// E1j: output_dir changed but no grants.output_dir in wrapped payload
//      → must return ok:false (R1.2a grant check still enforced,
//      independent of the privacy switch)
// ---------------------------------------------------------------------------
test('E1j: output_dir changed without grants.output_dir returns ok:false (R1.2a + R2.3.1 independence)', () => {
  seedAppConfig({ api_key: '', output_dir: 'C:\\user\\old' });
  const handlers = loadConfigIpc();
  const configSet = handlers.get('config:set');
  const r = configSet({}, {
    cfg: { api_key: '', output_dir: 'C:\\user\\new', region: 'global', theme: 'dark', styles: [] },
    apiKeyNoSave: false,
    // no `grants` field
  });
  assert.equal(r.ok, false,
    'E1j: output_dir changed without grants must return ok:false. Got: ' + JSON.stringify(r));
  assert.match(r.error || '', /no grant|use config:pickFolder|config-output/,
    'E1j: error must reference the grant requirement. Got: ' + (r && r.error));
});
