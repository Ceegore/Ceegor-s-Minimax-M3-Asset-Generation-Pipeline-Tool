// tests/unit/main/services/InstallDownloadService.test.js
// Regression tests for bug-fix S2 (_temp4.md): the Real-ESRGAN zip
// downloaded from GitHub had no integrity check before extraction — a
// replaced upstream asset or a corrupted/tampered transfer would be
// silently extracted and later spawned as a native binary. These tests
// mock the network transport (HttpsRedirect) and the unzip step
// (PowerShellSpawner) so no real download or extraction happens, while
// exercising the REAL checksum-comparison logic in
// InstallDownloadService.downloadRealesrgan.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SERVICE_PATH = path.join(ROOT, 'main', 'services', 'InstallDownloadService.js');

const assetPaths = require('../../../../src/assetPaths');
assetPaths.init({ userDataPath: path.join(os.tmpdir(), 'mmx-mock-user-data') });

function purgeServiceCache() {
  delete require.cache[SERVICE_PATH];
  delete require.cache[path.join(ROOT, 'main', 'services', 'HttpsRedirect.js')];
  delete require.cache[path.join(ROOT, 'main', 'utils', 'PowerShellSpawner.js')];
}

// Mirrors the Module._load patching technique already used in
// tests/unit/main/ipc/fullToolSweep.test.js. Keyed by the EXACT request
// string InstallDownloadService.js uses, so the mock is only applied to
// requires made from that file.
async function withMocks(mocks, run) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  purgeServiceCache();
  try {
    return await run();
  } finally {
    Module._load = originalLoad;
    purgeServiceCache();
  }
}

function fakeIncomingMessage(buf) {
  const { Readable } = require('stream');
  const r = new Readable({ read() {} });
  r.statusCode = 200;
  r.headers = { 'content-length': String(buf.length) };
  process.nextTick(() => { r.push(buf); r.push(null); });
  return r;
}

test('sha256OfFile computes the correct digest for known content (cross-checked against node crypto)', async () => {
  const { sha256OfFile } = require(SERVICE_PATH);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'esrgan-sha-'));
  try {
    const p = path.join(dir, 'sample.bin');
    const content = Buffer.from('the quick brown fox jumps over the lazy dog'.repeat(1000), 'utf8');
    await fsp.writeFile(p, content);
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    const actual = await sha256OfFile(p);
    assert.equal(actual, expected);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('downloadRealesrgan rejects on checksum mismatch and does NOT extract (S2)', async () => {
  const expandCalls = [];
  const fakeBytes = Buffer.from('definitely not the real realesrgan zip', 'utf8');
  await withMocks({
    './HttpsRedirect': { httpsGetFollowingRedirects: async () => fakeIncomingMessage(fakeBytes) },
    '../utils/PowerShellSpawner': { expandArchive: async (zip, dest) => { expandCalls.push([zip, dest]); } },
  }, async () => {
    const { downloadRealesrgan } = require(SERVICE_PATH);
    const appRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'esrgan-approot-'));
    try {
      const events = [];
      const r = await downloadRealesrgan(appRoot, (e) => events.push(e));
      assert.equal(r.ok, false);
      assert.match(r.error, /checksum/i);
      assert.deepEqual(expandCalls, [], 'extraction must never run when the checksum does not match');
      assert.ok(events.some((e) => e.phase === 'verify' && e.status === 'starting'));
      // the "verify: done" event only fires on a MATCH — must be absent here.
      assert.ok(!events.some((e) => e.phase === 'verify' && e.status === 'done'));
      assert.equal(fs.existsSync(path.join(appRoot, 'bin')), false, 'bin/ must not be created when verification fails');
    } finally {
      await fsp.rm(appRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

test('downloadRealesrgan proceeds to extraction when the checksum matches (via the expectedSha256 DI seam)', async () => {
  const expandCalls = [];
  const fakeBytes = Buffer.from('a stand-in for the real 45MB release zip', 'utf8');
  const matchingHash = crypto.createHash('sha256').update(fakeBytes).digest('hex');
  await withMocks({
    './HttpsRedirect': { httpsGetFollowingRedirects: async () => fakeIncomingMessage(fakeBytes) },
    '../utils/PowerShellSpawner': { expandArchive: async (zip, dest) => { expandCalls.push([zip, dest]); } },
  }, async () => {
    const { downloadRealesrgan } = require(SERVICE_PATH);
    const appRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'esrgan-approot-'));
    try {
      const events = [];
      const r = await downloadRealesrgan(appRoot, (e) => events.push(e), { expectedSha256: matchingHash });
      assert.equal(r.ok, true);
      assert.equal(r.error, undefined);
      assert.equal(r.binDir, assetPaths.writableAssetsDir());
      assert.equal(expandCalls.length, 1);
      // v1.1 (audit L12): extraction now goes into a temp staging dir
      // (NOT bin/ directly), then files are moved into bin/. This
      // prevents a half-extracted bin/ from mixing with the retry.
      // The staging dir is under os.tmpdir() with an mmx-bin-stage-* prefix.
      assert.ok(expandCalls[0][1].includes('mmx-bin-stage'),
        `expandArchive dest must be the staging dir, got: ${expandCalls[0][1]}`);
      // bin/ must exist (the move step created it).
      assert.ok(fs.existsSync(assetPaths.writableAssetsDir()), 'bin/ must be created after extraction + move');
      assert.ok(events.some((e) => e.phase === 'verify' && e.status === 'starting'));
      assert.ok(events.some((e) => e.phase === 'verify' && e.status === 'done'));
      assert.ok(events.some((e) => e.phase === 'extract' && e.status === 'done'));
    } finally {
      await fsp.rm(appRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

test('downloadRealesrgan deletes the temp zip after a checksum mismatch (no leftover unverified file)', async () => {
  const fakeBytes = Buffer.from('tampered bytes', 'utf8');
  let capturedTmpZip = null;
  await withMocks({
    './HttpsRedirect': { httpsGetFollowingRedirects: async () => fakeIncomingMessage(fakeBytes) },
    '../utils/PowerShellSpawner': { expandArchive: async () => {} },
  }, async () => {
    const { downloadRealesrgan } = require(SERVICE_PATH);
    const appRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'esrgan-approot-'));
    try {
      // Snapshot tmpdir contents before/after to find the zip the
      // function created internally (its path isn't returned to us).
      const before = new Set(fs.readdirSync(os.tmpdir()));
      const r = await downloadRealesrgan(appRoot, () => {});
      assert.equal(r.ok, false);
      const after = fs.readdirSync(os.tmpdir());
      const newRealesrganFiles = after.filter((f) => f.startsWith('realesrgan-') && !before.has(f));
      assert.deepEqual(newRealesrganFiles, [], 'no realesrgan-*.zip temp file must survive a checksum mismatch');
      void capturedTmpZip;
    } finally {
      await fsp.rm(appRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

test('RE_ESRGAN_ZIP_SHA256 is a well-formed 64-character lowercase hex SHA-256', () => {
  const { RE_ESRGAN_ZIP_SHA256 } = require(SERVICE_PATH);
  assert.match(RE_ESRGAN_ZIP_SHA256, /^[0-9a-f]{64}$/);
});
