// tests/unit/main/providersCredential.rq102.test.js
// ============================================================================
// Release-qualification 1.0.2 remediation (RQ-102 bundle) regression suite.
//
//  - RQ-003: a keep-key settings save (secret-free renderer payload) must
//    PRESERVE the persisted credential_id; untrusted incoming credential
//    references are stripped; the preserved reference must still resolve.
//  - RQ-006: ProviderCredentialRepository.getPublic() must NOT report
//    hasKey=true for a corrupt/missing blob; corrupt state is actionable.
//  - RQ-007: providers:set returns a TYPED committed/partial/failed
//    outcome instead of a false ok=true success on partial key failure.
//
// This file is also the kill suite for the directed mutants M1/M2/M3/M5
// in scripts/mutation-test.js.
// ============================================================================
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ---- Isolate config to a temp dir ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq102-prov-'));
process.env.MINIMAX_CONFIG_DIR = tmpDir;

// ---- Stub electron (ipcMain captures handlers; app.getPath -> temp) ----
const handlers = new Map();
const fakeIpcMain = {
  handle: (channel, fn) => handlers.set(channel, fn),
  removeHandler: (channel) => handlers.delete(channel),
};
const userData = path.join(tmpDir, 'userData');
fs.mkdirSync(userData, { recursive: true });

// Purge project modules so they pick up the env override + stubs below.
// (Runs BEFORE the stubs are installed: node_modules lives under ROOT.)
for (const key of Object.keys(require.cache)) {
  if (key.startsWith(ROOT) && key !== __filename) delete require.cache[key];
}

require.cache[require.resolve('electron')] = {
  exports: {
    app: { getPath: (k) => (k === 'userData' ? userData : tmpDir), isPackaged: false },
    ipcMain: fakeIpcMain,
  },
};

// Grants are not under test here — always authorize.
require.cache[require.resolve('../../../main/ipc/grantAuthorizer')] = {
  exports: { authorizePath: () => ({ ok: true }) },
};
// No network: SSRF policy stubbed green (urlPolicy is covered by its own
// unit tests); keeps this suite deterministic offline.
require.cache[require.resolve('../../../src/providers/urlPolicy')] = {
  exports: {
    validateProviderUrl: () => ({ ok: true }),
    validateOutputUrl: () => ({ ok: true }),
    validateProviderUrlWithDns: async () => ({ ok: true }),
  },
};

const providersStore = require('../../../src/providersStore');
const { ProviderCredentialRepository } = require('../../../main/services/ProviderCredentialRepository');
const { register } = require('../../../main/ipc/registerProvidersIpc');
register({ getMainWindow: () => null });

function providersFile() { return path.join(tmpDir, 'providers.json'); }
function readDisk() { return JSON.parse(fs.readFileSync(providersFile(), 'utf8')); }

// Default-shaped store with a persisted credential reference for
// openrouter — the state right after the user saved an API key.
function seedStoreWithKey() {
  fs.writeFileSync(providersFile(), JSON.stringify({
    providers: [
      { id: 'openrouter', label: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', credential_id: 'blob-or-1' },
      { id: 'replicate', label: 'Replicate', kind: 'replicate', baseUrl: '' },
      { id: 'custom-openai', label: 'Custom (OpenAI-compat)', kind: 'custom-openai', baseUrl: '' },
    ],
    selections: { image: { providerId: 'openrouter', model: '' } },
  }, null, 2));
}

// Renderer-shaped secret-free payload: the settings dialog sends back
// every provider WITHOUT apiKey/credential_id (empty key input = keep).
function keepKeyPayload() {
  return {
    providers: [
      { id: 'openrouter', label: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
      { id: 'replicate', label: 'Replicate', kind: 'replicate', baseUrl: '' },
      { id: 'custom-openai', label: 'Custom (OpenAI-compat)', kind: 'custom-openai', baseUrl: '' },
    ],
    selections: { image: { providerId: 'openrouter', model: 'img-m' } },
  };
}

function makeBlobStore(initial) {
  const blobs = new Map(initial || []);
  return {
    blobs,
    writeNew: (ns, value) => { const id = ns + '-blob-' + (blobs.size + 1); blobs.set(id, value); return { id }; },
    read: (id) => {
      if (!blobs.has(id)) { const e = new Error('missing'); e.code = 'SECRET_NOT_FOUND'; throw e; }
      return { value: blobs.get(id) };
    },
    remove: (id) => { blobs.delete(id); return { removed: true }; },
    exists: (id) => blobs.has(id),
  };
}

// Programmable repo stub for the IPC-level tests.
function makeRepoStub() {
  const stub = {
    publicStates: {},        // providerId -> credentialState
    failReplace: new Set(),  // providerIds whose replacePersisted throws
    calls: [],
    getPublic() {
      const d = providersStore.read();
      return (d.providers || []).map((p) => {
        const state = stub.publicStates[p.id] || 'none';
        return { id: p.id, credentialState: state, hasKey: state === 'persisted' || state === 'session' };
      });
    },
    replacePersisted(id, value) {
      stub.calls.push(['replace', id, value]);
      if (stub.failReplace.has(id)) throw new Error('blob store unavailable');
      stub.publicStates[id] = 'persisted';
    },
    useSessionOnly(id, value) { stub.calls.push(['session', id, value]); stub.publicStates[id] = 'session'; },
    clear(id) { stub.calls.push(['clear', id]); stub.publicStates[id] = 'none'; },
    resolveKey(id) { return stub.publicStates[id] === 'persisted' ? 'sk-stub' : null; },
  };
  return stub;
}

beforeEach(() => {
  providersStore.registerCredentialRepository(null);
  try { fs.unlinkSync(providersFile()); } catch (_) {}
});
afterEach(() => { providersStore.registerCredentialRepository(null); });

// ============================================================================
// RQ-003 — keep-key save must preserve the persisted credential reference
// ============================================================================

test('RQ-003: keep-key write() preserves credential_id when repo is active (kills M1)', () => {
  seedStoreWithKey();
  providersStore.registerCredentialRepository({ resolveKey: () => 'sk-stored' });

  providersStore.write(keepKeyPayload()); // renderer sends NO credential refs

  const d = readDisk();
  const or = d.providers.find((p) => p.id === 'openrouter');
  assert.equal(or.credential_id, 'blob-or-1',
    'keep-key save must not drop the persisted credential reference');
  assert.equal(d.selections.image.model, 'img-m', 'metadata updates still land');
});

test('RQ-003: untrusted incoming credential references are stripped', () => {
  seedStoreWithKey();
  providersStore.registerCredentialRepository({ resolveKey: () => null });

  const payload = keepKeyPayload();
  payload.providers[1].credential_id = 'attacker-blob';   // spoofed reference
  payload.providers[2].credentialId = 'attacker-legacy';  // legacy variant
  providersStore.write(payload);

  const d = readDisk();
  assert.equal(d.providers.find((p) => p.id === 'replicate').credential_id, undefined,
    'a forged credential_id must never be persisted');
  assert.equal(d.providers.find((p) => p.id === 'custom-openai').credentialId, undefined);
  assert.equal(d.providers.find((p) => p.id === 'custom-openai').credential_id, undefined);
  // The legitimate persisted reference still survives the same write.
  assert.equal(d.providers.find((p) => p.id === 'openrouter').credential_id, 'blob-or-1');
});

test('RQ-003: preserved reference still resolves the stored key end-to-end', () => {
  seedStoreWithKey();
  const store = makeBlobStore([['blob-or-1', 'sk-stored']]);
  const repo = new ProviderCredentialRepository({ blobStore: store, providersPath: providersFile() });
  providersStore.registerCredentialRepository(repo);

  providersStore.write(keepKeyPayload()); // the RQ-003 repro save

  const p = providersStore.provider('openrouter');
  assert.equal(p.apiKey, 'sk-stored', 'the preserved credential must still resolve');
  assert.equal(repo.getPublic().find((x) => x.id === 'openrouter').credentialState, 'persisted');
});

test('B-006: raw apiKey never reaches providers.json while repo is active (kills M2)', () => {
  seedStoreWithKey();
  providersStore.registerCredentialRepository({ resolveKey: () => null });

  const payload = keepKeyPayload();
  payload.providers[2].apiKey = 'sk-leak'; // should be rejected, not persisted
  providersStore.write(payload);

  const d = readDisk();
  for (const p of d.providers) {
    assert.equal(p.apiKey, undefined, 'no raw key material may be persisted');
    assert.equal(p._sessionKey, undefined);
  }
});

// ============================================================================
// RQ-006 — corrupt credential must NOT report hasKey=true
// ============================================================================

test('RQ-006: corrupt blob reports hasKey=false with actionable state (kills M3)', () => {
  const p = path.join(tmpDir, 'repo-rq006.json');
  fs.writeFileSync(p, JSON.stringify({ providers: [
    { id: 'dead', credential_id: 'blob-missing' },
    { id: 'live', credential_id: 'blob-ok' },
    { id: 'none' },
  ], selections: {} }));
  const store = makeBlobStore([['blob-ok', 'sk-live']]);
  const repo = new ProviderCredentialRepository({ blobStore: store, providersPath: p });

  const pub = repo.getPublic();
  const dead = pub.find((x) => x.id === 'dead');
  const live = pub.find((x) => x.id === 'live');
  const none = pub.find((x) => x.id === 'none');
  assert.equal(dead.credentialState, 'corrupt');
  assert.equal(dead.hasKey, false, 'a corrupt/missing blob is NOT a usable key');
  assert.equal(live.credentialState, 'persisted');
  assert.equal(live.hasKey, true);
  assert.equal(none.credentialState, 'none');
  assert.equal(none.hasKey, false);
});

test('M-006: session-only keys resolve and report state (kills M5)', () => {
  const p = path.join(tmpDir, 'repo-session.json');
  fs.writeFileSync(p, JSON.stringify({ providers: [{ id: 's1' }], selections: {} }));
  const repo = new ProviderCredentialRepository({ blobStore: makeBlobStore(), providersPath: p });

  repo.useSessionOnly('s1', 'sk-session-only');
  assert.equal(repo.resolveKey('s1'), 'sk-session-only', 'session keys must resolve');
  const pub = repo.getPublic().find((x) => x.id === 's1');
  assert.equal(pub.credentialState, 'session');
  assert.equal(pub.hasKey, true);
});

test('M-005 belt-and-braces: replacePersisted rollback removes the fresh blob (kills M4)', () => {
  const p = path.join(tmpDir, 'repo-m4.json');
  fs.writeFileSync(p, JSON.stringify({ providers: [{ id: 'x' }], selections: {} }));
  const store = makeBlobStore();
  const repo = new ProviderCredentialRepository({ blobStore: store, providersPath: p });
  repo._writeStore = () => { throw new Error('disk gone'); };

  assert.throws(() => repo.replacePersisted('x', 'sk-new'), /disk gone/);
  assert.equal(store.blobs.size, 0, 'the fresh blob must not be orphaned');
});

test('M-005 belt-and-braces: migrateLegacy rollback removes the blob (kills M6)', () => {
  const p = path.join(tmpDir, 'repo-m6.json');
  fs.writeFileSync(p, JSON.stringify({ providers: [{ id: 'm', apiKey: 'sk-plain' }], selections: {} }));
  const store = makeBlobStore();
  const repo = new ProviderCredentialRepository({ blobStore: store, providersPath: p });
  repo._writeStore = () => { throw new Error('disk gone'); };

  const res = repo.migrateLegacy();
  assert.equal(res.failed, 1);
  assert.equal(store.blobs.size, 0, 'the rolled-back blob must not be orphaned');
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).providers[0].apiKey, 'sk-plain',
    'plaintext is retained for retry');
});

// ============================================================================
// RQ-006/007 at the IPC boundary
// ============================================================================

test('RQ-006: getPublic DTO surfaces corrupt state to the renderer', () => {
  seedStoreWithKey();
  const stub = makeRepoStub();
  stub.publicStates.openrouter = 'corrupt';
  providersStore.registerCredentialRepository(stub);

  const r = handlers.get('providers:getPublic')({});
  assert.equal(r.ok, true);
  const or = r.providers.find((p) => p.id === 'openrouter');
  assert.equal(or.credentialState, 'corrupt');
  assert.equal(or.hasKey, false);
  assert.equal(or.apiKeyLast4, '', 'encrypted/corrupt keys never expose a tail');
});

test('RQ-006: listModels fails fast with repair guidance for a corrupt key', async () => {
  seedStoreWithKey();
  const stub = makeRepoStub();
  stub.publicStates.openrouter = 'corrupt';
  providersStore.registerCredentialRepository(stub);

  const r = await handlers.get('providers:listModels')({}, { providerId: 'openrouter' });
  assert.equal(r.ok, false);
  assert.match(r.error, /corrupt or unreadable/);
  assert.match(r.error, /re-enter the key/);
});

test('RQ-006: generate refuses to spend money on a corrupt key', async () => {
  seedStoreWithKey();
  const stub = makeRepoStub();
  stub.publicStates.openrouter = 'corrupt';
  providersStore.registerCredentialRepository(stub);

  const r = await handlers.get('providers:generate')({}, {
    jobId: 'rq006-1', modality: 'image', providerId: 'openrouter',
    model: 'm', prompt: 'p', params: {}, outDir: path.join(tmpDir, 'out-rq006'), grantId: 'g1',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /corrupt or unreadable/);
});

test('RQ-007: committed outcome on clean save', async () => {
  seedStoreWithKey();
  const stub = makeRepoStub();
  providersStore.registerCredentialRepository(stub);

  const payload = keepKeyPayload();
  payload.providers[0].apiKey = 'sk-new-key';
  const r = await handlers.get('providers:set')({}, payload);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'committed');
  assert.equal(r.warnings, undefined);
  assert.deepEqual(stub.calls, [['replace', 'openrouter', 'sk-new-key']]);
});

test('RQ-007: partial outcome when one of several key ops fails', async () => {
  seedStoreWithKey();
  const stub = makeRepoStub();
  stub.failReplace.add('replicate');
  providersStore.registerCredentialRepository(stub);

  const payload = keepKeyPayload();
  payload.providers[0].apiKey = 'sk-one';
  payload.providers[1].apiKey = 'sk-two';
  const r = await handlers.get('providers:set')({}, payload);
  assert.equal(r.ok, true, 'metadata IS committed');
  assert.equal(r.status, 'partial');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /replicate.*replace failed/);
  assert.ok(r.error && r.error.length > 0, 'renderer-visible error must be set');
});

test('RQ-007: failed outcome when every key op fails', async () => {
  seedStoreWithKey();
  const stub = makeRepoStub();
  stub.failReplace.add('replicate');
  providersStore.registerCredentialRepository(stub);

  const payload = keepKeyPayload();
  payload.providers[1].apiKey = 'sk-two';
  const r = await handlers.get('providers:set')({}, payload);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'failed');
  assert.equal(r.warnings.length, 1);
});

test('RQ-003/RQ-007: renderer keep-key save via IPC preserves the reference', async () => {
  seedStoreWithKey();
  const stub = makeRepoStub();
  stub.publicStates.openrouter = 'persisted';
  providersStore.registerCredentialRepository(stub);

  const r = await handlers.get('providers:set')({}, keepKeyPayload()); // exact repro
  assert.equal(r.ok, true);
  assert.equal(r.status, 'committed');
  assert.equal(stub.calls.length, 0, 'keep must not trigger any key operation');
  assert.equal(readDisk().providers.find((p) => p.id === 'openrouter').credential_id, 'blob-or-1',
    'credential reference survives an IPC keep-key save');
});

test('RQ-007: DTO status fields round-tripped by the renderer are not persisted', async () => {
  seedStoreWithKey();
  const stub = makeRepoStub();
  providersStore.registerCredentialRepository(stub);

  const payload = keepKeyPayload();
  payload.providers[0].hasKey = true;
  payload.providers[0].credentialState = 'persisted';
  payload.providers[0].apiKeyLast4 = '1234';
  await handlers.get('providers:set')({}, payload);

  const or = readDisk().providers.find((p) => p.id === 'openrouter');
  assert.equal(or.hasKey, undefined);
  assert.equal(or.credentialState, undefined);
  assert.equal(or.apiKeyLast4, undefined);
});

test('cleanup', () => {
  providersStore.registerCredentialRepository(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MINIMAX_CONFIG_DIR;
});
