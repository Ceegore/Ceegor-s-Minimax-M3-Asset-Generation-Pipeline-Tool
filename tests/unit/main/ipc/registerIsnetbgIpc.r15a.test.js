// tests/unit/main/ipc/registerIsnetbgIpc.r15a.test.js
// ============================================================================
// R1.5a.4 (S1 §6 R1.5a) — IS-Net IPC Grant-Contract.
//
// Invarianten:
//   • isnetbg:run requires a `grantId`; the grant must authorise
//     `read` on srcPath AND `write` on dstPath.
//   • isnetbg:available stays ungated (binary check, no path).
//   • isnetbg:download-model stays ungated (model download targets
//     a Main-owned app dir, not a user-supplied path).
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
const ISNETBG_IPC = path.join(ROOT, 'main', 'ipc', 'registerIsnetbgIpc.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
const ISNETBG = path.join(ROOT, 'src', 'isnetbg.js');
const MODEL_REGISTRY = path.join(ROOT, 'src', 'isnetbg', 'modelRegistry.js');
const MODEL_DOWNLOAD = path.join(ROOT, 'src', 'isnetbg', 'modelDownload.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15a4-isnetbg-'));

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---- Helper: load registerIsnetbgIpc with stubbed electron + a
// fresh PathGrantService.defaultService + stubbed isnetbg modules. ----
function loadIpc(isnetbgMock) {
  for (const p of [ISNETBG_IPC, PATH_SECURITY, PATH_GRANT, ISNETBG, MODEL_REGISTRY, MODEL_DOWNLOAD]) {
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
      isPathUnderAny: () => true,
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
  require.cache[require.resolve(ISNETBG)] = {
    exports: isnetbgMock.isnetbg,
  };
  require.cache[require.resolve(MODEL_REGISTRY)] = {
    // KGO7-019: registerIsnetbgIpc now uses resolveModelKeyEx (pure; also
    // reports whether a bogus key was substituted). Keep resolveModelKey
    // in the stub for any other consumer of this cache entry.
    exports: {
      resolveModelKey: (k) => k || 'isnet-general-use',
      resolveModelKeyEx: (k) => {
        const key = k || 'isnet-general-use';
        const requested = (k == null || k === '') ? null : String(k);
        return { key, fellBack: requested !== null && requested !== key, requested };
      },
    },
  };
  require.cache[require.resolve(MODEL_DOWNLOAD)] = {
    exports: {
      async downloadModel() { return { ok: true, path: 'C:\\bin\\models\\isnet-general-use.onnx' }; },
    },
  };
  require(ISNETBG_IPC).register({ appRoot: ROOT });
  return { handlers };
}

function mintDirectoryGrant(svc, dir, opts = {}) {
  return svc.mintDirectoryGrant({
    origin: opts.origin || 'picker-browser-dir',
    purpose: opts.purpose || 'R1.5a.4 test grant',
    path: dir,
    capabilities: opts.capabilities || ['read', 'write', 'rename', 'delete', 'mkdir'],
  });
}

function mintFileGrant(svc, file, opts = {}) {
  return svc.mintFileGrant({
    origin: opts.origin || 'picker-browser-file',
    purpose: opts.purpose || 'R1.5a.4 test file grant',
    path: file,
    capabilities: opts.capabilities || ['read', 'write'],
  });
}

function defaultMock() {
  return {
    isnetbg: {
      isAvailable: () => true,
      getBinaryPath: () => 'C:\\bin\\isnetbg.exe',
      getModelPath: () => 'C:\\bin\\models\\isnet-general-use.onnx',
      probeVersion: () => '1.0.0',
      listModelStatus: () => ({}),
      async run(_srcPath, dstPath) {
        return { ok: true, code: 0, stderr: '', outputPath: dstPath };
      },
    },
  };
}

// ============================================================================
// isnetbg:available — binary check, ungated
// ============================================================================

test('R1.5a.4: isnetbg:available is NOT gated by grantId (binary check)', () => {
  const { handlers } = loadIpc(defaultMock());
  const r = handlers.get('isnetbg:available')();
  assert.equal(r.available, true);
  assert.equal(r.binaryPath, 'C:\\bin\\isnetbg.exe');
  assert.equal(r.modelPresent, true);
  assert.equal(r.version, '1.0.0');
});

// ============================================================================
// isnetbg:run — read on src + write on dst
// ============================================================================

test('R1.5a.4: isnetbg:run with a directory grant covering both src+dst runs successfully', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'isnet-src.png');
  const dst = path.join(TMP, 'isnet-dst.png');
  fs.writeFileSync(src, Buffer.from([0]));
  const dirGrant = mintDirectoryGrant(defaultService, TMP);
  const r = await handlers.get('isnetbg:run')(null, src, dst, {}, dirGrant.grantId);
  assert.equal(r.ok, true, 'isnetbg:run with valid grant must succeed: ' + r.stderr);
  assert.equal(r.code, 0);
  assert.equal(r.outputPath, dst);
});

test('R1.5a.4: isnetbg:run without a grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'no-grant-src.png');
  const dst = path.join(TMP, 'no-grant-dst.png');
  const r = await handlers.get('isnetbg:run')(null, src, dst, {}, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.code, -1);
  assert.equal(r.outputPath, null);
  assert.match(r.stderr, /grantId is required/i);
});

test('R1.5a.4: isnetbg:run with an unknown grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'unk-src.png');
  const dst = path.join(TMP, 'unk-dst.png');
  const r = await handlers.get('isnetbg:run')(null, src, dst, {}, 'grant_does_not_exist_xyz');
  assert.equal(r.ok, false);
  assert.equal(r.code, -1);
  assert.match(r.stderr, /grant/i);
});

test('R1.5a.4: isnetbg:run with read-only grant for src is REJECTED (no write on dst)', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'ro-src.png');
  const dst = path.join(TMP, 'ro-dst.png');
  fs.writeFileSync(src, Buffer.from([0]));
  const grant = mintFileGrant(defaultService, src, { capabilities: ['read'] });
  const r = await handlers.get('isnetbg:run')(null, src, dst, {}, grant.grantId);
  assert.equal(r.ok, false, 'a read-only grant must fail the write-on-dst check');
  assert.equal(r.code, -1);
});

test('R1.5a.4: isnetbg:run with grant for a different path is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'src-other.png');
  const dst = path.join(TMP, 'dst-other.png');
  fs.writeFileSync(src, Buffer.from([0]));
  const otherGrant = mintFileGrant(defaultService, path.join(TMP, 'elsewhere.png'), { capabilities: ['read', 'write'] });
  const r = await handlers.get('isnetbg:run')(null, src, dst, {}, otherGrant.grantId);
  assert.equal(r.ok, false);
  assert.equal(r.code, -1);
});

// ============================================================================
// isnetbg:download-model — Main-owned app dir, ungated
// ============================================================================

test('R1.5a.4: isnetbg:download-model is NOT gated by grantId (Main-owned app dir)', async () => {
  const { handlers } = loadIpc(defaultMock());
  const r = await handlers.get('isnetbg:download-model')({ sender: { send() {} } }, 'isnet-general-use');
  assert.equal(r.ok, true);
  assert.ok(r.path, 'download-model must return a path');
});
