// hhhhu3 audit Phase 3 regression tests.
//
// Covers:
//  - H-009: commitKeyAction() performs EXACTLY ONE config write per action
//    (replace / clear / keep), strips plaintext, and rolls back a fresh blob
//    when the commit fails.
//  - H-008: cleanup failures never convert a committed replace into a
//    failure (cleanupPending instead of throw).
//  - M-005: ProviderCredentialRepository removes the fresh blob and restores
//    prior state when the providers.json metadata write fails
//    (replacePersisted / useSessionOnly / per-provider migrateLegacy).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

let TMP;
let HOME;
let USER_DATA;
let configWriteCount;
let configWriteImpl;

function purgeProjectCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ROOT) && key !== __filename) delete require.cache[key];
  }
}

function installElectronMock() {
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle() {}, on() {} },
      app: { getPath: () => USER_DATA },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: { showItemInFolder() {}, openPath: async () => '', openExternal: async () => {} },
      BrowserWindow: class BrowserWindow {},
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
        decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
      },
    },
  };
}

// Load src/config with a counting write spy. CredentialRepository requires
// the same cached module instance, so the spy observes every commit.
function loadConfigWithSpy() {
  const cfgMod = require(path.join(ROOT, 'src', 'config.js'));
  const realWrite = cfgMod.write;
  cfgMod.write = (cfg) => {
    configWriteCount += 1;
    if (configWriteImpl) return configWriteImpl(cfg);
    return realWrite(cfg);
  };
  return cfgMod;
}

function loadRepo() {
  return require(path.join(ROOT, 'main', 'services', 'CredentialRepository.js'));
}

function secretFiles() {
  const dir = path.join(USER_DATA, 'secrets-v1');
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return []; }
}

test.beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hhhhu3-cred-'));
  HOME = path.join(TMP, 'home');
  USER_DATA = path.join(TMP, 'userData');
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  process.env.MINIMAX_CONFIG_DIR = HOME;
  process.env.USERPROFILE = HOME;
  process.env.HOME = HOME;
  configWriteCount = 0;
  configWriteImpl = null;
  purgeProjectCache();
  installElectronMock();
});

test.afterEach(() => {
  configWriteImpl = null;
  purgeProjectCache();
  delete require.cache[require.resolve('electron')];
  delete process.env.MINIMAX_CONFIG_DIR;
  delete process.env.USERPROFILE;
  delete process.env.HOME;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('H-009: replace commits with exactly one config write and strips plaintext', () => {
  loadConfigWithSpy();
  const repo = loadRepo();

  const result = repo.commitKeyAction({ action: 'replace', value: 'sk-new', config: { region: 'global' } });
  assert.equal(result.hasApiKey, true);
  assert.equal(result.persisted, true);
  assert.equal(configWriteCount, 1, 'replace must perform exactly one config write');

  const cfg = require(path.join(ROOT, 'src', 'config.js')).read();
  assert.equal(cfg.api_key, '', 'plaintext must never be persisted');
  assert.ok(cfg.api_credential_id, 'the credential reference must be set');
  assert.equal(secretFiles().length, 1, 'exactly one encrypted blob must exist');

  // The committed reference resolves through the encrypted store.
  const resolved = repo.resolvePrimary();
  assert.equal(resolved.apiKey, 'sk-new');
  assert.equal(resolved.sessionOnly, false);
});

test('H-009: replace-then-replace removes the old blob and still writes once', () => {
  loadConfigWithSpy();
  const repo = loadRepo();

  repo.commitKeyAction({ action: 'replace', value: 'sk-one', config: {} });
  const firstId = require(path.join(ROOT, 'src', 'config.js')).read().api_credential_id;

  configWriteCount = 0;
  const second = repo.commitKeyAction({ action: 'replace', value: 'sk-two', config: {} });
  assert.equal(configWriteCount, 1);
  assert.equal(second.cleanupPending, false, 'cleanup must succeed in a clean home');

  const cfg = require(path.join(ROOT, 'src', 'config.js')).read();
  assert.notEqual(cfg.api_credential_id, firstId, 'replacement must mint a fresh blob id');
  assert.equal(secretFiles().length, 1, 'the previous blob must be removed');
  assert.equal(repo.resolvePrimary().apiKey, 'sk-two');
});

test('H-009: clear removes the reference in its single write before blob cleanup', () => {
  loadConfigWithSpy();
  const repo = loadRepo();
  repo.commitKeyAction({ action: 'replace', value: 'sk-gone', config: {} });

  configWriteCount = 0;
  const result = repo.commitKeyAction({ action: 'clear', config: {} });
  assert.equal(result.hasApiKey, false);
  assert.equal(configWriteCount, 1, 'clear must perform exactly one config write');

  const cfg = require(path.join(ROOT, 'src', 'config.js')).read();
  assert.equal(cfg.api_key, '');
  assert.equal(cfg.api_credential_id || '', '');
  assert.equal(secretFiles().length, 0, 'the blob must be removed');
  assert.equal(repo.resolvePrimary().apiKey, null);
});

test('H-009: keep re-commits settings with the existing reference and strips plaintext', () => {
  loadConfigWithSpy();
  const repo = loadRepo();
  repo.commitKeyAction({ action: 'replace', value: 'sk-stays', config: {} });
  const id = require(path.join(ROOT, 'src', 'config.js')).read().api_credential_id;

  configWriteCount = 0;
  const result = repo.commitKeyAction({ action: 'keep', config: { api_key: 'smuggled', theme: 'dark' } });
  assert.equal(result.hasApiKey, true);
  assert.equal(configWriteCount, 1);

  const cfg = require(path.join(ROOT, 'src', 'config.js')).read();
  assert.equal(cfg.api_key, '', 'keep must strip any smuggled plaintext');
  assert.equal(cfg.api_credential_id, id, 'keep must preserve the existing reference');
  assert.equal(cfg.theme, 'dark', 'non-credential settings survive the re-commit');
});

test('H-009: a failed commit rolls back the fresh blob and leaves config untouched', () => {
  loadConfigWithSpy();
  const repo = loadRepo();

  configWriteImpl = () => { throw new Error('disk full'); };
  assert.throws(
    () => repo.commitKeyAction({ action: 'replace', value: 'sk-fail', config: {} }),
    /disk full/,
  );

  assert.equal(secretFiles().length, 0, 'the fresh blob must be rolled back');
  const cfg = require(path.join(ROOT, 'src', 'config.js')).read();
  assert.equal(cfg.api_credential_id || '', '', 'no reference may be committed');
  assert.equal(repo.resolvePrimary().apiKey, null);
});

test('H-008: replace succeeds even when legacy cleanup is unavailable (cleanupPending)', () => {
  loadConfigWithSpy();
  const repo = loadRepo();
  repo.commitKeyAction({ action: 'replace', value: 'sk-first', config: {} });

  // Simulate a committed replace whose old-blob cleanup fails: the blob file
  // becomes an unremovable directory, so fs.unlinkSync throws EISDIR/EPERM.
  const oldId = require(path.join(ROOT, 'src', 'config.js')).read().api_credential_id;
  const blobPath = path.join(USER_DATA, 'secrets-v1', oldId + '.json');
  fs.rmSync(blobPath);
  fs.mkdirSync(blobPath); // unlinkSync on a directory fails on every platform

  const result = repo.commitKeyAction({ action: 'replace', value: 'sk-second', config: {} });
  assert.equal(result.hasApiKey, true, 'a committed replace must not be reported as failed');
  assert.equal(result.persisted, true);
  assert.equal(result.cleanupPending, true, 'cleanup failure is reported via cleanupPending');
  assert.equal(repo.resolvePrimary().apiKey, 'sk-second');
});

test('M-005: provider replacePersisted removes the fresh blob when the metadata write fails', () => {
  const { ProviderCredentialRepository } = require(path.join(ROOT, 'main', 'services', 'ProviderCredentialRepository.js'));
  const providersPath = path.join(TMP, 'providers.json');
  fs.writeFileSync(providersPath, JSON.stringify({ providers: [{ id: 'openrouter', label: 'OpenRouter' }], selections: {} }));

  const blobs = new Map();
  const removed = [];
  const blobStore = {
    writeNew: (ns, value) => { const id = ns + '-blob-' + (blobs.size + 1); blobs.set(id, value); return { id }; },
    read: (id) => ({ value: blobs.get(id) }),
    remove: (id) => { removed.push(id); blobs.delete(id); return { removed: true }; },
    exists: (id) => blobs.has(id),
  };
  const repo = new ProviderCredentialRepository({ blobStore, providersPath });
  repo._writeStore = () => { throw new Error('metadata write failed'); };

  assert.throws(() => repo.replacePersisted('openrouter', 'sk-prov'), /metadata write failed/);
  assert.equal(blobs.size, 0, 'the orphan blob must be removed');
  assert.deepEqual(removed, ['provider-openrouter-blob-1']);
  const onDisk = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
  assert.equal(onDisk.providers[0].credential_id, undefined, 'the store must keep its prior state');
});

test('M-005: provider replacePersisted commits blob + reference and cleans the old blob', () => {
  const { ProviderCredentialRepository } = require(path.join(ROOT, 'main', 'services', 'ProviderCredentialRepository.js'));
  const providersPath = path.join(TMP, 'providers.json');
  fs.writeFileSync(providersPath, JSON.stringify({ providers: [{ id: 'replicate', apiKey: 'sk-legacy' }], selections: {} }));

  const blobs = new Map();
  const blobStore = {
    writeNew: (ns, value) => { const id = ns + '-blob-' + (blobs.size + 1); blobs.set(id, value); return { id }; },
    read: (id) => ({ value: blobs.get(id) }),
    remove: (id) => { blobs.delete(id); return { removed: true }; },
    exists: (id) => blobs.has(id),
  };
  const repo = new ProviderCredentialRepository({ blobStore, providersPath });

  repo.replacePersisted('replicate', 'sk-new');
  const onDisk = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
  assert.ok(onDisk.providers[0].credential_id, 'the reference must be persisted');
  assert.equal(onDisk.providers[0].apiKey, undefined, 'legacy plaintext must be stripped');
  assert.equal(repo.resolveKey('replicate'), 'sk-new');

  // Second replace swaps the reference and removes the previous blob.
  const firstId = onDisk.providers[0].credential_id;
  repo.replacePersisted('replicate', 'sk-newer');
  const after = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
  assert.notEqual(after.providers[0].credential_id, firstId);
  assert.equal(blobs.size, 1, 'the previous blob must be cleaned');
  assert.equal(repo.resolveKey('replicate'), 'sk-newer');
});

test('M-005: useSessionOnly reverts the session map when the metadata write fails', () => {
  const { ProviderCredentialRepository } = require(path.join(ROOT, 'main', 'services', 'ProviderCredentialRepository.js'));
  const providersPath = path.join(TMP, 'providers.json');
  fs.writeFileSync(providersPath, JSON.stringify({ providers: [{ id: 'p1', credential_id: 'provider-p1-old' }], selections: {} }));

  const blobStore = {
    writeNew: () => ({ id: 'x' }),
    read: () => ({ value: 'v' }),
    remove: () => ({ removed: true }),
    exists: () => true,
  };
  const repo = new ProviderCredentialRepository({ blobStore, providersPath });
  repo._writeStore = () => { throw new Error('write failed'); };

  assert.throws(() => repo.useSessionOnly('p1', 'sk-session'), /write failed/);
  assert.equal(repo.resolveKey('p1'), 'v', 'resolution must stay consistent with the on-disk reference');
  const pub = repo.getPublic();
  assert.equal(pub[0].credentialState, 'persisted', 'the reverted session map must not leak state');
});

test('M-005: migrateLegacy commits per provider and rolls back on write failure', () => {
  const { ProviderCredentialRepository } = require(path.join(ROOT, 'main', 'services', 'ProviderCredentialRepository.js'));
  const providersPath = path.join(TMP, 'providers.json');
  fs.writeFileSync(providersPath, JSON.stringify({
    providers: [
      { id: 'a', apiKey: 'sk-a' },
      { id: 'b', apiKey: 'sk-b' },
    ],
    selections: {},
  }));

  const blobs = new Map();
  const blobStore = {
    writeNew: (ns, value) => { const id = ns + '-blob-' + (blobs.size + 1); blobs.set(id, value); return { id }; },
    read: (id) => ({ value: blobs.get(id) }),
    remove: (id) => { blobs.delete(id); return { removed: true }; },
    exists: (id) => blobs.has(id),
  };
  const repo = new ProviderCredentialRepository({ blobStore, providersPath });

  // Fail ONLY the second metadata write: provider A commits, provider B
  // rolls back (blob removed, plaintext retained on disk for a retry).
  let writeCalls = 0;
  const realWrite = repo._writeStore.bind(repo);
  repo._writeStore = (data) => {
    writeCalls += 1;
    if (writeCalls === 2) throw new Error('second write fails');
    return realWrite(data);
  };

  const result = repo.migrateLegacy();
  assert.equal(result.migrated, 1);
  assert.equal(result.failed, 1);

  const onDisk = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
  const a = onDisk.providers.find((p) => p.id === 'a');
  const b = onDisk.providers.find((p) => p.id === 'b');
  assert.ok(a.credential_id, 'provider A must be migrated');
  assert.equal(a.apiKey, undefined);
  assert.equal(b.apiKey, 'sk-b', 'provider B must keep its plaintext for retry');
  assert.equal(b.credential_id, undefined);
  assert.equal(blobs.size, 1, 'the rolled-back blob must not be orphaned');
});
