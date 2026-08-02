// tests/unit/main/ipc/registerUpscaleIpc.r15a.test.js
// ============================================================================
// R1.5a.3 (S1 §6 R1.5a) — Upscale IPC Grant-Contract.
//
// Invarianten:
//   • upscale:realesrgan:run requires a `grantId`; the grant must
//     authorise `read` on srcPath AND `write` on dstPath.
//   • upscale:realesrgan:available stays ungated (binary check, no path).
//   • upscale:realesrgan:download stays ungated (downloads into
//     Main-owned app dirs, not user-supplied paths).
//   • Without a grantId (or with an unknown one) the handler returns
//     {ok:false, code:-1, stderr:..., outputPath:null} and does NOT
//     touch the filesystem.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const UPSCALE_IPC = path.join(ROOT, 'main', 'ipc', 'registerUpscaleIpc.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
const REALESRGAN = path.join(ROOT, 'src', 'realesrgan.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15a3-upscale-'));

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---- Helper: load registerUpscaleIpc with stubbed electron + a fresh
// PathGrantService.defaultService + a stubbed realesrgan module. ----
function loadIpc(realesrganMock) {
  for (const p of [UPSCALE_IPC, PATH_SECURITY, PATH_GRANT, REALESRGAN]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  try {
    const { defaultService } = require(PATH_GRANT);
    defaultService.destroy();
  } catch (_) {}
  const handlers = new Map();
  require.cache[require.resolve(PATH_SECURITY)] = {
    exports: {
      getAllowedRoots: () => [TMP],
      isPathUnderAny: () => true, // legacy — not used by R1.5a.3
      isParentUnderAny: () => true,
      addTrusted: () => [],
      setActiveDir: () => null,
      getActiveDir: () => null,
    },
  };
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      app: { getPath: () => TMP },
    },
  };
  require.cache[require.resolve(REALESRGAN)] = {
    exports: realesrganMock,
  };
  require(UPSCALE_IPC).register({ appRoot: ROOT, getMainWindow: () => null });
  return { handlers };
}

function mintDirectoryGrant(svc, dir, opts = {}) {
  return svc.mintDirectoryGrant({
    origin: opts.origin || 'picker-browser-dir',
    purpose: opts.purpose || 'R1.5a.3 test grant',
    path: dir,
    capabilities: opts.capabilities || ['read', 'write', 'rename', 'delete', 'mkdir'],
  });
}

function mintFileGrant(svc, file, opts = {}) {
  return svc.mintFileGrant({
    origin: opts.origin || 'picker-browser-file',
    purpose: opts.purpose || 'R1.5a.3 test file grant',
    path: file,
    capabilities: opts.capabilities || ['read', 'write'],
  });
}

function defaultMock() {
  return {
    isAvailable: () => true,
    getBinaryPath: () => 'C:\\bin\\realesrgan.exe',
    probeVersion: () => '0.2.0',
    resetCache() {},
    async run(_srcPath, dstPath) {
      return { ok: true, code: 0, stderr: '', outputPath: dstPath };
    },
  };
}

// ============================================================================
// upscale:realesrgan:available — binary check, ungated
// ============================================================================

test('R1.5a.3: upscale:realesrgan:available is NOT gated by grantId (binary check)', () => {
  const { handlers } = loadIpc(defaultMock());
  const r = handlers.get('upscale:realesrgan:available')();
  assert.equal(r.available, true);
  assert.equal(r.binaryPath, 'C:\\bin\\realesrgan.exe');
  assert.equal(r.version, '0.2.0');
});

// ============================================================================
// upscale:realesrgan:run — read on src + write on dst
// ============================================================================

test('R1.5a.3: upscale:realesrgan:run with a directory grant covering both src+dst runs successfully', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'upscale-src.png');
  const dst = path.join(TMP, 'upscale-dst.png');
  fs.writeFileSync(src, Buffer.from([0]));
  // P4.1 (DB-H-002/008): the handler now validates the output artifact
  // (existence + size + PNG magic + H-064 full decode); the mocked run()
  // writes nothing, so pre-create a REAL decodable 1x1 PNG at dst.
  fs.writeFileSync(dst, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'));
  // A directory grant for TMP covers BOTH src and dst.
  const dirGrant = mintDirectoryGrant(defaultService, TMP);
  const r = await handlers.get('upscale:realesrgan:run')({ sender: { send() {} } }, src, dst, {}, dirGrant.grantId);
  assert.equal(r.ok, true, 'upscale:run with valid grant must succeed: ' + r.stderr);
  assert.equal(r.code, 0);
  assert.equal(r.outputPath, dst);
});

test('P4.1: upscale:realesrgan:run flips ok:true to a failure when the output PNG was never written', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'p41-src.png');
  const dst = path.join(TMP, 'p41-dst-missing.png');
  fs.writeFileSync(src, Buffer.from([0]));
  const dirGrant = mintDirectoryGrant(defaultService, TMP);
  const r = await handlers.get('upscale:realesrgan:run')({ sender: { send() {} } }, src, dst, {}, dirGrant.grantId);
  assert.equal(r.ok, false, 'ok:true with a missing artifact must be rejected');
  assert.match(String(r.stderr || r.error), /output failed validation/i);
});

test('R1.5a.3: upscale:realesrgan:run without a grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'no-grant-src.png');
  const dst = path.join(TMP, 'no-grant-dst.png');
  const r = await handlers.get('upscale:realesrgan:run')({ sender: { send() {} } }, src, dst, {}, undefined);
  assert.equal(r.ok, false, 'no grantId MUST reject upscale:run');
  assert.equal(r.code, -1);
  assert.equal(r.outputPath, null);
  assert.match(r.stderr, /grantId is required/i);
});

test('R1.5a.3: upscale:realesrgan:run with an unknown grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'unk-src.png');
  const dst = path.join(TMP, 'unk-dst.png');
  const r = await handlers.get('upscale:realesrgan:run')({ sender: { send() {} } }, src, dst, {}, 'grant_does_not_exist_xyz');
  assert.equal(r.ok, false);
  assert.equal(r.code, -1);
  assert.match(r.stderr, /grant/i);
});

test('R1.5a.3: upscale:realesrgan:run with read-only grant for src is REJECTED (no write on dst)', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'ro-src.png');
  const dst = path.join(TMP, 'ro-dst.png');
  fs.writeFileSync(src, Buffer.from([0]));
  const grant = mintFileGrant(defaultService, src, { capabilities: ['read'] });
  const r = await handlers.get('upscale:realesrgan:run')({ sender: { send() {} } }, src, dst, {}, grant.grantId);
  assert.equal(r.ok, false, 'a read-only grant must fail the write-on-dst check');
  assert.equal(r.code, -1);
});

test('R1.5a.3: upscale:realesrgan:run with grant for a different path is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'src-other.png');
  const dst = path.join(TMP, 'dst-other.png');
  fs.writeFileSync(src, Buffer.from([0]));
  // Grant covers a different file.
  const otherGrant = mintFileGrant(defaultService, path.join(TMP, 'elsewhere.png'), { capabilities: ['read', 'write'] });
  const r = await handlers.get('upscale:realesrgan:run')({ sender: { send() {} } }, src, dst, {}, otherGrant.grantId);
  assert.equal(r.ok, false);
  assert.equal(r.code, -1);
});

// ============================================================================
// upscale:realesrgan:download — Main-owned, ungated
// ============================================================================

test('R1.5a.3: upscale:realesrgan:download is NOT gated by grantId (Main-owned app dir)', async () => {
  // We don't need a full download; we just need the handler to be
  // registered and the success path to return without checking
  // grantId. The InstallDownloadService is required at module-load
  // time, so the import path matters; we use the fullToolSweep
  // mock below for the real download flow.
  // Here we just verify the handler exists and runs without grantId.
  // (We do not test the download itself; that is covered by the
  // pre-existing fullToolSweep test.)
  const { handlers } = loadIpc(defaultMock());
  // Stub the InstallDownloadService so the handler can run without
  // hitting the network. (Replace the require.cache entry AFTER loadIpc
  // has registered the handler.)
  const INSTALL_DL = path.join(ROOT, 'main', 'services', 'InstallDownloadService.js');
  require.cache[require.resolve(INSTALL_DL)] = {
    exports: {
      async downloadRealesrgan() { return { ok: true, binDir: 'C:\\bin' }; },
    },
  };
  // We need a fresh handler registration to pick up the new mock.
  for (const p of [UPSCALE_IPC]) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  const handlers2 = new Map();
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers2.set(ch, fn) },
      app: { getPath: () => TMP },
    },
  };
  require(UPSCALE_IPC).register({ appRoot: ROOT, getMainWindow: () => null });
  const r = await handlers2.get('upscale:realesrgan:download')({ sender: { send() {} } });
  assert.equal(r.ok, true);
  assert.equal(r.binDir, 'C:\\bin');
});
