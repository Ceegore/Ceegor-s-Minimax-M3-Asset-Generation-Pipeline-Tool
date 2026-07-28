// tests/unit/main/ipc/registerImageIpc.r15a.test.js
// ============================================================================
// R1.5a (S1 §6 R1.5a) — Image IPC Grant-Contract.
//
// Invarianten:
//   • image:optimize, image:resize, image:fixExtension, image:writeBase64
//     each require a `grantId` parameter (last position). The grant is
//     authorised through PathGrantService.
//   • image:optimize: read on srcPath; write on opts.outputPath (when
//     provided) OR write on srcPath (in-place rewrite).
//   • image:resize: same as image:optimize.
//   • image:fixExtension: write on filePath (rename is write-class).
//   • image:writeBase64: write on outPath.
//   • Without a grantId (or with an unknown one) the handler returns
//     {ok:false, error} and does NOT touch the filesystem.
//   • image:refExists is unchanged (read-only existence probe; already
//     protected by the sensitive-dir denylist).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const IMAGE_IPC = path.join(ROOT, 'main', 'ipc', 'registerImageIpc.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15a-image-'));

// Make a real PNG (16x16 white square) via sharp so the file is
// libvips-loadable. Some tests write a copy on disk; we keep the
// master bytes for writeBase64's payload.
let PNG_BYTES;
test.before(async () => {
  PNG_BYTES = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---- Helper: load registerImageIpc with stubbed electron + a fresh
// PathGrantService.defaultService. Each test calls this fresh so the
// registry is empty and grantId ids are deterministic per test. ----
function loadIpc() {
  for (const p of [IMAGE_IPC, PATH_SECURITY, PATH_GRANT]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  // Reset the defaultService singleton so each test starts clean.
  try {
    const { defaultService } = require(PATH_GRANT);
    defaultService.destroy();
  } catch (_) {}

  const handlers = new Map();
  require.cache[require.resolve(PATH_SECURITY)] = {
    exports: {
      getAllowedRoots: () => [TMP],
      isPathUnderAny: () => true, // legacy — not used by R1.5a
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
  require(IMAGE_IPC).register({ appRoot: ROOT });
  return { handlers };
}

function mintDirectoryGrant(svc, dir, opts = {}) {
  return svc.mintDirectoryGrant({
    origin: opts.origin || 'picker-browser-dir',
    purpose: opts.purpose || 'R1.5a test grant',
    path: dir,
    capabilities: opts.capabilities || ['read', 'write', 'rename', 'delete', 'mkdir'],
  });
}

function mintFileGrant(svc, file, opts = {}) {
  return svc.mintFileGrant({
    origin: opts.origin || 'picker-browser-file',
    purpose: opts.purpose || 'R1.5a test file grant',
    path: file,
    capabilities: opts.capabilities || ['read', 'write'],
  });
}

// ============================================================================
// image:optimize
// ============================================================================

test('R1.5a: image:optimize with a read+write grant for the source optimises in place', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'optimize-inplace.png');
  fs.writeFileSync(src, PNG_BYTES);
  const grant = mintFileGrant(defaultService, src);
  assert.equal(grant.ok, true);
  const out = await handlers.get('image:optimize')({}, src, {}, grant.grantId);
  assert.equal(out.ok, true, 'in-place optimize must succeed: ' + out.error);
  assert.ok(out.outputPath, 'outputPath should be returned');
  // The file at src still exists (in-place rewrite).
  assert.ok(fs.existsSync(src), 'in-place optimize must not delete the source');
});

test('R1.5a: image:optimize with a grant for the output path (different from source) writes there', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'src-for-output.png');
  const dst = path.join(TMP, 'subdir', 'opt.png');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(src, PNG_BYTES);
  // Two separate grants: a read grant for src, a write grant for dst.
  // (R1.5a takes ONE grantId, so the renderer must mint a directory
  // grant that covers BOTH paths.)
  const dirGrant = mintDirectoryGrant(defaultService, TMP);
  const out = await handlers.get('image:optimize')({}, src, { outputPath: dst }, dirGrant.grantId);
  assert.equal(out.ok, true, 'optimize-with-output must succeed: ' + out.error);
  assert.equal(out.outputPath, dst, 'outputPath must be the explicit destination');
  assert.ok(fs.existsSync(dst), 'the destination file must be written');
});

test('R1.5a: image:optimize without a grantId is REJECTED (no fs touched)', async () => {
  const { handlers } = loadIpc();
  const src = path.join(TMP, 'no-grant.png');
  fs.writeFileSync(src, PNG_BYTES);
  const out = await handlers.get('image:optimize')({}, src, {}, undefined);
  assert.equal(out.ok, false, 'no grantId MUST reject the call');
  assert.match(out.error, /grantId is required/i,
    'R1.5a: the error must explicitly mention the missing grantId');
});

test('R1.5a: image:optimize with an unknown grantId is REJECTED', async () => {
  const { handlers } = loadIpc();
  const src = path.join(TMP, 'unknown-grant.png');
  fs.writeFileSync(src, PNG_BYTES);
  const out = await handlers.get('image:optimize')({}, src, {}, 'grant_does_not_exist_xyz');
  assert.equal(out.ok, false, 'unknown grantId MUST reject the call');
});

// ============================================================================
// image:resize
// ============================================================================

test('R1.5a: image:resize with a read+write grant for the source resizes in place', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'resize-inplace.png');
  fs.writeFileSync(src, PNG_BYTES);
  const grant = mintFileGrant(defaultService, src);
  assert.equal(grant.ok, true);
  const out = await handlers.get('image:resize')({}, src, { width: 4, height: 4 }, grant.grantId);
  assert.equal(out.ok, true, 'in-place resize must succeed: ' + out.error);
  assert.ok(out.outputPath, 'outputPath should be returned');
  assert.ok(fs.existsSync(src), 'in-place resize must not delete the source');
});

test('R1.5a: image:resize with a grant for the output path writes there', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'src-for-resize.png');
  const dst = path.join(TMP, 'subdir2', 'resized.png');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(src, PNG_BYTES);
  const dirGrant = mintDirectoryGrant(defaultService, TMP);
  const out = await handlers.get('image:resize')({}, src, { width: 4, height: 4, outputPath: dst }, dirGrant.grantId);
  assert.equal(out.ok, true, 'resize-with-output must succeed: ' + out.error);
  assert.equal(out.outputPath, dst);
  assert.ok(fs.existsSync(dst), 'the destination file must be written');
});

test('R1.5a: image:resize without a grantId is REJECTED', async () => {
  const { handlers } = loadIpc();
  const src = path.join(TMP, 'no-grant-resize.png');
  fs.writeFileSync(src, PNG_BYTES);
  const out = await handlers.get('image:resize')({}, src, { width: 4, height: 4 });
  assert.equal(out.ok, false, 'no grantId MUST reject the call');
  assert.match(out.error, /grantId is required/i);
});

test('R1.5a: image:resize with an unknown grantId is REJECTED', async () => {
  const { handlers } = loadIpc();
  const src = path.join(TMP, 'unknown-grant-resize.png');
  fs.writeFileSync(src, PNG_BYTES);
  const out = await handlers.get('image:resize')({}, src, { width: 4, height: 4 }, 'grant_does_not_exist_xyz');
  assert.equal(out.ok, false);
});

// ============================================================================
// image:fixExtension
// ============================================================================

test('R1.5a: image:fixExtension with a write grant renames a mismatched-extension file', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  // Create a PNG saved with a .jpg extension (the fixExtension
  // contract: detect actual format, rename to match).
  const src = path.join(TMP, 'fixme.jpg');
  fs.writeFileSync(src, PNG_BYTES);
  const grant = mintFileGrant(defaultService, src);
  assert.equal(grant.ok, true);
  const out = await handlers.get('image:fixExtension')({}, src, grant.grantId);
  // Phasenpruefung-of-Phasenpruefung (F-PP-R1.5a.1-B, LOW): the
  // previous test only checked `out.ok === true`, which would also
  // pass if fixExtension was a no-op. Strengthen the assertion: the
  // rename MUST actually happen (out.renamed === true), the old path
  // MUST be gone, and the new path MUST exist.
  assert.equal(out.ok, true, 'fixExtension with grant must succeed: ' + out.error);
  assert.equal(out.renamed, true,
    'R1.5a Phasenpruefung: fixExtension must actually rename the file (was: only checked out.ok)');
  assert.notEqual(out.path, src,
    'R1.5a Phasenpruefung: out.path must point to the renamed file, not the original');
  assert.ok(fs.existsSync(out.path),
    'R1.5a Phasenpruefung: the renamed file must exist at out.path');
  assert.equal(fs.existsSync(src), false,
    'R1.5a Phasenpruefung: the original (mismatched-extension) file must be gone after the rename');
  assert.equal(out.fromExt, 'jpg', 'fromExt must be the original extension');
  assert.equal(out.toExt, 'png', 'toExt must be the detected real format');
});

test('R1.5a: image:fixExtension without a grantId is REJECTED', async () => {
  const { handlers } = loadIpc();
  const src = path.join(TMP, 'fixme-no-grant.jpg');
  fs.writeFileSync(src, PNG_BYTES);
  const out = await handlers.get('image:fixExtension')({}, src, undefined);
  assert.equal(out.ok, false, 'no grantId MUST reject fixExtension');
  assert.match(out.error, /grantId is required/i);
});

test('R1.5a: image:fixExtension with an unknown grantId is REJECTED', async () => {
  const { handlers } = loadIpc();
  const src = path.join(TMP, 'fixme-unknown-grant.jpg');
  fs.writeFileSync(src, PNG_BYTES);
  const out = await handlers.get('image:fixExtension')({}, src, 'grant_does_not_exist_xyz');
  assert.equal(out.ok, false);
});

// ============================================================================
// image:writeBase64
// ============================================================================

test('R1.5a: image:writeBase64 with a write grant atomically writes the payload', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const outPath = path.join(TMP, 'editor-export.png');
  const grant = mintFileGrant(defaultService, outPath);
  assert.equal(grant.ok, true);
  const base64 = PNG_BYTES.toString('base64');
  const r = await handlers.get('image:writeBase64')({}, outPath, base64, grant.grantId);
  assert.equal(r.ok, true, 'writeBase64 with grant must succeed: ' + r.error);
  assert.ok(fs.existsSync(outPath), 'the file must be written');
  // No .tmp-* leftover after a successful atomic write.
  const left = fs.readdirSync(TMP).filter((n) => n.includes('.tmp-'));
  assert.equal(left.length, 0, 'atomic write must not leave .tmp- files behind: ' + left.join(','));
});

test('R1.5a: image:writeBase64 without a grantId is REJECTED (no file created)', async () => {
  const { handlers } = loadIpc();
  const outPath = path.join(TMP, 'editor-export-no-grant.png');
  const base64 = PNG_BYTES.toString('base64');
  const r = await handlers.get('image:writeBase64')({}, outPath, base64, undefined);
  assert.equal(r.ok, false, 'no grantId MUST reject writeBase64');
  assert.match(r.error, /grantId is required/i);
  assert.equal(fs.existsSync(outPath), false, 'no file may be created when the grant is missing');
});

test('R1.5a: image:writeBase64 with an unknown grantId is REJECTED', async () => {
  const { handlers } = loadIpc();
  const outPath = path.join(TMP, 'editor-export-unknown.png');
  const base64 = PNG_BYTES.toString('base64');
  const r = await handlers.get('image:writeBase64')({}, outPath, base64, 'grant_does_not_exist_xyz');
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(outPath), false);
});

// ============================================================================
// image:refExists — read-only, ungated (unchanged in R1.5a)
// ============================================================================

test('R1.5a: image:refExists is NOT gated by grantId (read-only existence check)', async () => {
  const { handlers } = loadIpc();
  // image:refExists uses a sensitive-dir denylist (AppData, Program
  // Files, etc.). The default TMP is under AppData\Local\Temp which
  // would be rejected. Use a non-sensitive temp location instead.
  const safeTmp = fs.mkdtempSync(path.join(ROOT, 'mmx-r15a-refexists-'));
  try {
    const ref = path.join(safeTmp, 'reference.png');
    fs.writeFileSync(ref, PNG_BYTES);
    // No grantId is passed — image:refExists does not take one and
    // does not consult PathGrantService. The existing sensitive-dir
    // denylist is the gate.
    const r = await handlers.get('image:refExists')({}, ref);
    assert.equal(r.ok, true);
    assert.equal(r.exists, true, 'a real PNG path in a non-sensitive dir must report exists:true');
  } finally {
    try { fs.rmSync(safeTmp, { recursive: true, force: true }); } catch (_) {}
  }
});
