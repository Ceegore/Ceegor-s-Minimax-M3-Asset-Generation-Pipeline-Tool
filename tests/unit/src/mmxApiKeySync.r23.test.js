// tests/unit/src/mmxApiKeySync.r23.test.js
// ============================================================================
// R2.3 — `mmxApiKeySync.clearApiKeyFromMmxCliConfig` (SYS-002)
//
// Contract (design contract §5 SYS-002, Soll):
//   • Atomically remove only the `api_key` field; preserve every
//     other field (region, model, custom_cli_args, …).
//   • Missing file → no-op, return true.
//   • File without `api_key` → no-op, return true.
//   • File with `api_key` → read, delete, atomic temp+rename write.
//   • Invalidate the in-memory cache so a subsequent
//     syncApiKeyToMmxCliConfig() does NOT no-op.
//   • Never throw. Return true on success, false on I/O error.
//
// Schreibt NUR in OS-Temp.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SYNC_PATH = path.join(__dirname, '..', '..', '..', 'src', 'mmxApiKeySync.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r23-'));

function freshHome() {
  // Each test gets a fresh subdir so they don't pollute each other.
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  return home;
}

function freshSync() {
  try { delete require.cache[require.resolve(SYNC_PATH)]; } catch (_) {}
  return require(SYNC_PATH);
}

test.beforeEach(() => {
  freshHome();
  freshSync()._resetForTest();
});

test.afterEach(() => {
  delete process.env.USERPROFILE;
  delete process.env.HOME;
  freshSync()._resetForTest();
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const M = () => path.join(process.env.USERPROFILE, '.mmx', 'config.json');
const seedConfig = (obj) => {
  const dir = path.dirname(M());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(M(), JSON.stringify(obj, null, 2));
};
const readConfig = () => {
  try { return JSON.parse(fs.readFileSync(M(), 'utf8')); } catch (_) { return null; }
};

// ---------------------------------------------------------------------------
// R2.3.A: missing ~/.mmx/config.json → no-op, return true
// ---------------------------------------------------------------------------
test('R2.3.A: missing config file is a no-op (return true, no file created)', () => {
  const sync = freshSync();
  const r = sync.clearApiKeyFromMmxCliConfig();
  assert.equal(r, true);
  assert.equal(fs.existsSync(M()), false, 'must not create the file just to clear a missing key');
});

// ---------------------------------------------------------------------------
// R2.3.B: existing config WITHOUT api_key → no-op, return true
// ---------------------------------------------------------------------------
test('R2.3.B: existing config without api_key is a no-op (return true, file preserved)', () => {
  seedConfig({ region: 'global', model: 'image-01', custom_cli_args: ['--no-banner'] });
  const before = readConfig();
  const sync = freshSync();
  const r = sync.clearApiKeyFromMmxCliConfig();
  assert.equal(r, true);
  const after = readConfig();
  assert.deepEqual(after, before, 'file must be byte-identical (no-op)');
});

// ---------------------------------------------------------------------------
// R2.3.C: existing config WITH api_key → key removed, other fields preserved
// ---------------------------------------------------------------------------
test('R2.3.C: existing config with api_key: key removed, other fields preserved', () => {
  seedConfig({
    api_key: 'sk-OLD-PERSISTED',
    region: 'global',
    model: 'image-01',
    custom_cli_args: ['--no-banner'],
  });
  const sync = freshSync();
  const r = sync.clearApiKeyFromMmxCliConfig();
  assert.equal(r, true);
  const after = readConfig();
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'api_key'), false,
    'api_key must be removed; got: ' + JSON.stringify(after));
  assert.equal(after.region, 'global', 'region must be preserved');
  assert.equal(after.model, 'image-01', 'model must be preserved');
  assert.deepEqual(after.custom_cli_args, ['--no-banner'], 'custom_cli_args must be preserved');
});

// ---------------------------------------------------------------------------
// R2.3.D: clear invalidates the in-memory cache so a subsequent
//         syncApiKeyToMmxCliConfig() with a new key does NOT no-op
// ---------------------------------------------------------------------------
test('R2.3.D: clear invalidates the sync cache so a new sync call actually writes', () => {
  const sync = freshSync();
  seedConfig({ api_key: 'sk-OLD', region: 'global' });
  // Sync the old key so the cache is populated.
  const r1 = sync.syncApiKeyToMmxCliConfig('sk-OLD');
  assert.equal(r1, true);
  // Clear (also wipes the cache).
  const r2 = sync.clearApiKeyFromMmxCliConfig();
  assert.equal(r2, true);
  // Now sync a NEW key. The cache must NOT no-op this.
  const r3 = sync.syncApiKeyToMmxCliConfig('sk-NEW-AFTER-CLEAR');
  assert.equal(r3, true);
  const after = readConfig();
  assert.equal(after.api_key, 'sk-NEW-AFTER-CLEAR',
    'R2.3.D: api_key must be the new key (not the old one) after clear+sync');
});

// ---------------------------------------------------------------------------
// R2.3.E: clear + clear is idempotent
// ---------------------------------------------------------------------------
test('R2.3.E: calling clear twice in a row is idempotent', () => {
  const sync = freshSync();
  seedConfig({ api_key: 'sk-OLD', region: 'global' });
  assert.equal(sync.clearApiKeyFromMmxCliConfig(), true);
  assert.equal(sync.clearApiKeyFromMmxCliConfig(), true);
  const after = readConfig();
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'api_key'), false);
  assert.equal(after.region, 'global');
});

// ---------------------------------------------------------------------------
// R2.3.F: clear on a corrupt (non-JSON) file returns false (no exception)
// ---------------------------------------------------------------------------
test('R2.3.F: clear on a corrupt (non-JSON) file returns false and does not throw', () => {
  const dir = path.dirname(M());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(M(), 'this is not json{{{');
  const sync = freshSync();
  let caught = null;
  let r = null;
  try { r = sync.clearApiKeyFromMmxCliConfig(); } catch (e) { caught = e; }
  assert.equal(caught, null, 'clear must not throw; caught: ' + (caught && caught.message));
  assert.equal(r, false, 'corrupt config must return false so the caller can surface an error');
});

// ---------------------------------------------------------------------------
// R2.3.G: clear on a non-object JSON (string / number / array) returns false
// ---------------------------------------------------------------------------
test('R2.3.G: clear on a non-object JSON returns false and does not throw', () => {
  const sync = freshSync();
  for (const bad of ['just-a-string', 42, [1, 2, 3], null]) {
    const dir = path.dirname(M());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(M(), JSON.stringify(bad));
    let caught = null;
    let r = null;
    try { r = sync.clearApiKeyFromMmxCliConfig(); } catch (e) { caught = e; }
    assert.equal(caught, null, 'must not throw for ' + JSON.stringify(bad));
    assert.equal(r, false, 'non-object config must return false (got: ' + r + ')');
  }
});

// ---------------------------------------------------------------------------
// R2.3.H: atomic write — clear uses temp+rename, no partial writes
//         (we can't easily simulate a crash mid-write, but we can
//         verify the temp file is cleaned up if the rename fails)
// ---------------------------------------------------------------------------
test('R2.3.H: clear uses a temp+rename pattern (no partial writes on success)', () => {
  const sync = freshSync();
  seedConfig({ api_key: 'sk-OLD', region: 'global' });
  // After a successful clear, no .tmp-* files should remain in ~/.mmx.
  sync.clearApiKeyFromMmxCliConfig();
  const dir = path.dirname(M());
  const leftovers = fs.readdirSync(dir).filter((n) => /\.tmp-/.test(n));
  assert.deepEqual(leftovers, [], 'no .tmp-* leftover after successful clear');
});

// ---------------------------------------------------------------------------
// R2.3.I: the new function is exported (R0.1-002.B's hard contract)
// ---------------------------------------------------------------------------
test('R2.3.I: the clear/remove helper is exported (closes R0.1-002.B)', () => {
  const sync = freshSync();
  const hasRemove = (typeof sync.clearApiKeyFromMmxCliConfig === 'function')
    || (typeof sync.removeApiKeyFromMmxCliConfig === 'function')
    || (typeof sync.purgePersistedKey === 'function');
  assert.equal(hasRemove, true,
    'R2.3: mmxApiKeySync must export a clear/remove helper. R0.1-002.B contract.');
});
