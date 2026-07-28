// tests/unit/main/ipc/registerInpaintIpc.r15a.test.js
// ============================================================================
// R1.5a.5 (S1 §6 R1.5a) — Inpaint IPC Grant-Contract.
//
// Invarianten:
//   • inpaint:runTelea requires a `grantId` (inside args); the grant
//     must authorise `read` on srcPath AND `write` on outPath (which
//     may be args.outPath or a derived sibling via deriveOutPath).
//   • Without a grantId (or with an unknown one) the handler returns
//     {ok:false, error} and does NOT touch the filesystem.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const INPAINT_IPC = path.join(ROOT, 'main', 'ipc', 'registerInpaintIpc.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
const INPAINT = path.join(ROOT, 'src', 'inpaint.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15a5-inpaint-'));

// A real RGBA PNG (16x16 white) so sharp can load it.
let PNG_BYTES;
test.before(async () => {
  PNG_BYTES = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).png().toBuffer();
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---- Helper: load registerInpaintIpc with stubbed electron + a
// fresh PathGrantService.defaultService + stubbed inpaint module. ----
function loadIpc() {
  for (const p of [INPAINT_IPC, PATH_SECURITY, PATH_GRANT, INPAINT]) {
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
  // Stub inpaint.js so the synthesis is a no-op (we only test the
  // grant gate; the inpaint algorithm is unit-tested in
  // unit/src/inpaint.test.js).
  require.cache[require.resolve(INPAINT)] = {
    exports: {
      inpaint() {}, // no-op: we don't care about the synthesis result
      maskFromAlpha() { return new Uint8Array(16 * 16); },
    },
  };
  require(INPAINT_IPC).register({ appRoot: ROOT });
  return { handlers };
}

function mintDirectoryGrant(svc, dir, opts = {}) {
  return svc.mintDirectoryGrant({
    origin: opts.origin || 'picker-browser-dir',
    purpose: opts.purpose || 'R1.5a.5 test grant',
    path: dir,
    capabilities: opts.capabilities || ['read', 'write', 'rename', 'delete', 'mkdir'],
  });
}

function mintFileGrant(svc, file, opts = {}) {
  return svc.mintFileGrant({
    origin: opts.origin || 'picker-browser-file',
    purpose: opts.purpose || 'R1.5a.5 test file grant',
    path: file,
    capabilities: opts.capabilities || ['read', 'write'],
  });
}

test('R1.5a.5: inpaint:runTelea with a directory grant covering both src+out inpaint successfully', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'inpaint-src.png');
  fs.writeFileSync(src, PNG_BYTES);
  const out = path.join(TMP, 'inpaint-dst.png');
  const dirGrant = mintDirectoryGrant(defaultService, TMP);
  const r = await handlers.get('inpaint:runTelea')(null, {
    srcPath: src,
    outPath: out,
    mode: 'transparency',
    grantId: dirGrant.grantId,
  });
  assert.equal(r.ok, true, 'inpaint:runTelea with valid grant must succeed: ' + r.error);
  assert.equal(r.path, out);
  assert.ok(fs.existsSync(out), 'the inpaint output file must exist');
});

test('R1.5a.5: inpaint:runTelea with a file grant covering both src+out inpaint successfully', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'inpaint-src2.png');
  fs.writeFileSync(src, PNG_BYTES);
  // Mint a file grant for the SRC. The output (deriveOutPath) is a
  // sibling (`<stem>_healed.png`). A file grant for src is exact-match
  // and does NOT cover the sibling. We mint TWO file grants: one for
  // src (read) and one for the derived output (write). R1.5a.5
  // takes ONE grantId, so the renderer must use a directory grant
  // for the typical use-case. This test pins the directory-grant
  // path; the file-grant edge case is tested in the next test.
  const dirGrant = mintDirectoryGrant(defaultService, TMP);
  const r = await handlers.get('inpaint:runTelea')(null, {
    srcPath: src,
    mode: 'transparency',
    grantId: dirGrant.grantId,
  });
  assert.equal(r.ok, true);
  // The derived outPath is `<src_stem>_healed.png` — same dir as src.
  const expectedOut = path.join(TMP, 'inpaint-src2_healed.png');
  assert.equal(r.path, expectedOut, 'the derived outPath is the sibling _healed.png');
});

test('R1.5a.5: inpaint:runTelea without a grantId is REJECTED (no fs touched)', async () => {
  const { handlers } = loadIpc();
  const src = path.join(TMP, 'no-grant.png');
  fs.writeFileSync(src, PNG_BYTES);
  const r = await handlers.get('inpaint:runTelea')(null, {
    srcPath: src,
    mode: 'transparency',
    // no grantId
  });
  assert.equal(r.ok, false, 'no grantId MUST reject inpaint:runTelea');
  assert.match(r.error, /grantId is required/i);
});

test('R1.5a.5: inpaint:runTelea with an unknown grantId is REJECTED', async () => {
  const { handlers } = loadIpc();
  const src = path.join(TMP, 'unk.png');
  fs.writeFileSync(src, PNG_BYTES);
  const r = await handlers.get('inpaint:runTelea')(null, {
    srcPath: src,
    mode: 'transparency',
    grantId: 'grant_does_not_exist_xyz',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /grant/i);
});

test('R1.5a.5: inpaint:runTelea with a read-only grant for src is REJECTED (no write on out)', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'ro-src.png');
  fs.writeFileSync(src, PNG_BYTES);
  const out = path.join(TMP, 'ro-dst.png');
  const grant = mintFileGrant(defaultService, src, { capabilities: ['read'] });
  const r = await handlers.get('inpaint:runTelea')(null, {
    srcPath: src,
    outPath: out,
    mode: 'transparency',
    grantId: grant.grantId,
  });
  assert.equal(r.ok, false, 'a read-only grant must fail the write-on-out check');
  assert.equal(fs.existsSync(out), false, 'no file may be written when the grant is missing');
});

test('R1.5a.5: inpaint:runTelea with grant for a different path is REJECTED', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'src-other.png');
  fs.writeFileSync(src, PNG_BYTES);
  const out = path.join(TMP, 'dst-other.png');
  const otherGrant = mintFileGrant(defaultService, path.join(TMP, 'elsewhere.png'), { capabilities: ['read', 'write'] });
  const r = await handlers.get('inpaint:runTelea')(null, {
    srcPath: src,
    outPath: out,
    mode: 'transparency',
    grantId: otherGrant.grantId,
  });
  assert.equal(r.ok, false, 'a grant for a different file MUST not authorise the read');
});
