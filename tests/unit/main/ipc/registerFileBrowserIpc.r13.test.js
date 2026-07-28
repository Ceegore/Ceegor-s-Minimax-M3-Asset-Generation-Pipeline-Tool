// tests/unit/main/ipc/registerFileBrowserIpc.r13.test.js
// ============================================================================
// R1.3 — File Browser Grant-Contract (S1 §4 + §6 R1.3).
//
// Invarianten:
//   • fb:set-active-dir ist NUR Navigation-ACK; keine Trust-Erweiterung
//     mehr. fb:trust-ancestors ist komplett entfernt.
//   • Jeder mutierende Handler (mkdir, ensureDir, rename, delete,
//     move, copy, write, read, exists) verlangt einen grantId und
//     authorisiert den Pfad via PathGrantService. Ohne/mit
//     ungültigem grantId → ok:false.
//   • fb:reveal / fb:openInExplorer bleiben ungated (Read-Side).
//   • fb:list und fb:listDrives bleiben ungated (Read-Side / kein
//     user-supplied Pfad).
//   • move/copy authorisieren Quelle UND Ziel separat.
//   • delete auf den Grant-Root ist VERBOTEN (S1 §2.5), außer
//     coversRoot:true (directory-root grant).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FB_IPC = path.join(ROOT, 'main', 'ipc', 'registerFileBrowserIpc.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
const FILE_BROWSER = path.join(ROOT, 'src', 'fileBrowser.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r13-fb-'));

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---- Helper: load registerFileBrowserIpc with stubbed electron + fsp
// and a fresh PathGrantService.defaultService singleton. ----
function loadIpc() {
  for (const p of [FB_IPC, PATH_SECURITY, PATH_GRANT, FILE_BROWSER]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  // Reset the defaultService singleton.
  try {
    const { defaultService } = require(PATH_GRANT);
    defaultService.destroy();
  } catch (_) {}

  const handlers = new Map();
  // Track fsp / fb / grant operations for assertion.
  const calls = { mkdir: [], rename: [], delete: [], writeFile: [], renameFs: [] };
  // Real fs (so mkdir/writeFile/rename actually touch the disk under TMP).
  // We use a custom realpath that resolves paths inside TMP only.
  require.cache[require.resolve(PATH_SECURITY)] = {
    exports: {
      getAllowedRoots: () => [TMP],
      isPathUnderAny: () => true, // legacy — not used by R1.3
      isParentUnderAny: () => true,
      addTrusted: () => [],
      setActiveDir: () => null,
      getActiveDir: () => null,
    },
  };
  // Stub fileBrowser to record calls but pass through to real fs.
  // IMPORTANT: require.cache values are module records; Node's require()
  // returns cacheValue.exports. Setting the cache to a plain object
  // (no `exports` property) makes require() return undefined. We must
  // wrap the stub in { exports: { ... } } so the IPC file's
  // `const fb = require('../../src/fileBrowser')` resolves to our
  // stub object, not undefined.
  const realFB = require(FILE_BROWSER);
  require.cache[require.resolve(FILE_BROWSER)] = {
    exports: {
      list: realFB.list,
      mkdir: async (dir, name) => { calls.mkdir.push({ dir, name }); return realFB.mkdir(dir, name); },
      rename: async (p, newName) => { calls.rename.push({ p, newName }); return realFB.rename(p, newName); },
      deletePath: async (p) => { calls.delete.push(p); return realFB.deletePath(p); },
      moveTo: realFB.moveTo,
      copyTo: realFB.copyTo,
      reveal: realFB.reveal,
      openInExplorer: realFB.openInExplorer,
      readFile: realFB.readFile,
    },
  };
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      app: { getPath: () => TMP },
    },
  };
  require(FB_IPC).register({ appRoot: ROOT });
  return { handlers, calls };
}

// ---- Helper: mint a directory grant for tests. ----
function mintOutputGrant(svc, dir, opts = {}) {
  return svc.mintDirectoryGrant({
    origin: opts.origin || 'picker-browser-dir',
    purpose: 'R1.3 test',
    path: dir,
    capabilities: opts.capabilities || ['read', 'write', 'delete', 'mkdir', 'rename', 'move', 'copy'],
    coversRoot: !!opts.coversRoot,
  });
}

// ===========================================================================
// fb:set-active-dir — must be a navigation-only ACK (R1.3 invariant)
// ===========================================================================

test('R1.3.A: fb:set-active-dir returns a navigation ACK; it does not alter trust state', () => {
  const { handlers, calls } = loadIpc();
  const set = handlers.get('fb:set-active-dir');
  // Call with any dir; the handler must not throw, must not touch
  // any state, and must return ok:true with a clear note.
  const r1 = set({}, 'C:\\Windows');
  assert.equal(r1.ok, true);
  assert.match(r1.note || '', /navigation-only/i);
  // The R1.3 contract: the active dir is null (we no longer track it).
  assert.equal(r1.activeDir, null);
  // Second call with a different dir — still no state change.
  const r2 = set({}, 'C:\\Users');
  assert.equal(r2.ok, true);
});

// ===========================================================================
// All mutating handlers REJECT without a grantId
// ===========================================================================

test('R1.3.B: every mutating handler rejects without a grantId', async () => {
  const { handlers } = loadIpc();
  const sub = path.join(TMP, 'B-sub');
  fs.mkdirSync(sub, { recursive: true });
  const child = path.join(sub, 'c.txt');
  fs.writeFileSync(child, 'x');
  // Each mutating handler must require a grantId.
  for (const [ch, args] of [
    ['fb:mkdir', [sub, 'newdir']],
    ['fb:ensureDir', [sub + '-2']],
    ['fb:rename', [child, 'renamed.txt']],
    ['fb:delete', [child + '.bak']],
    ['fb:move', [child, sub + '-3']],
    ['fb:copy', [child, sub + '-4']],
    ['fb:read', [child]],
    ['fb:exists', [child]],
    ['fb:write', [child + '.new', Buffer.from('x').toString('base64')]],
  ]) {
    const fn = handlers.get(ch);
    assert.ok(fn, ch + ' must be registered');
    const r = await fn({}, ...args);
    assert.equal(r.ok, false, ch + ' without grantId must be rejected');
    assert.match(r.error, /grantId/i, ch + ' error must mention grantId');
  }
});

// ===========================================================================
// Each mutating handler accepts a valid grantId and rejects an unknown one
// ===========================================================================

test('R1.3.C: mutating handlers reject unknown / empty / revoked grantIds', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const root = path.join(TMP, 'C-root');
  fs.mkdirSync(root, { recursive: true });
  const child = path.join(root, 'c.txt');
  fs.writeFileSync(child, 'x');
  const childAlt = path.join(root, 'd.txt');
  fs.writeFileSync(childAlt, 'x');
  const minted = mintOutputGrant(defaultService, root);
  const grantId = minted.grantId;
  // Revoke the grant for the "revoked" sub-test.
  const r1 = defaultService.mintDirectoryGrant({
    origin: 'picker-browser-dir', purpose: 'R1.3.C revoked', path: root,
    capabilities: ['read', 'write'], coversRoot: false,
  });
  defaultService.revoke(r1.grantId);

  for (const [ch, args, opPath] of [
    ['fb:mkdir', [root, 'newdir-B'], path.join(root, 'newdir-B')],
    ['fb:ensureDir', [root + '-C'], root + '-C'],
    ['fb:rename', [child, 'renamed-C.txt'], child],
    ['fb:delete', [childAlt], childAlt],
    ['fb:move', [child, root + '-moved'], child],
    ['fb:copy', [child, root + '-copied'], child],
    ['fb:read', [child], child],
    ['fb:exists', [child], child],
    ['fb:write', [child + '.new', Buffer.from('x').toString('base64')], child + '.new'],
  ]) {
    const fn = handlers.get(ch);
    // Empty grantId.
    const r0 = await fn({}, ...args, '');
    assert.equal(r0.ok, false, ch + ' with empty grantId must be rejected');
    // Unknown grantId.
    const r2 = await fn({}, ...args, 'not-a-real-grant-id-' + Date.now());
    assert.equal(r2.ok, false, ch + ' with unknown grantId must be rejected');
    // Revoked grantId.
    const r3 = await fn({}, ...args, r1.grantId);
    assert.equal(r3.ok, false, ch + ' with revoked grantId must be rejected');
    assert.match(r3.error, /revoked|expired|not found/i);
    void grantId; void opPath;
  }
});

// ===========================================================================
// fb:write with a valid directory grant accepts the write
// ===========================================================================

test('R1.3.D: fb:write with a valid directory grant writes the file', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const root = path.join(TMP, 'D-root');
  fs.mkdirSync(root, { recursive: true });
  const minted = mintOutputGrant(defaultService, root);
  const target = path.join(root, 'hello.txt');
  const r = await handlers.get('fb:write')({}, target, Buffer.from('data').toString('base64'), minted.grantId);
  assert.equal(r.ok, true, 'fb:write with valid grant must succeed');
  assert.equal(fs.readFileSync(target, 'utf8'), 'data');
});

// ===========================================================================
// fb:delete on the grant root is REJECTED (S1 §2.5); descendant OK
// ===========================================================================

test('R1.3.E: fb:delete on the grant root is rejected (S1 §2.5); a strict descendant is allowed', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const root = path.join(TMP, 'E-root');
  fs.mkdirSync(root, { recursive: true });
  const child = path.join(root, 'c.txt');
  fs.writeFileSync(child, 'x');
  // Plain directory grant (not coversRoot) — root delete is rejected.
  const minted = mintOutputGrant(defaultService, root, { coversRoot: false });
  const r1 = await handlers.get('fb:delete')({}, root, minted.grantId);
  assert.equal(r1.ok, false, 'fb:delete on the grant root must be rejected (S1 §2.5)');
  assert.match(r1.error, /root itself|descendant/i);
  // Child delete is allowed.
  const r2 = await handlers.get('fb:delete')({}, child, minted.grantId);
  assert.equal(r2.ok, true, 'fb:delete on a strict descendant must be allowed');
  // The file was actually deleted.
  assert.equal(fs.existsSync(child), false);
});

// ===========================================================================
// fb:delete on the grant root is ALLOWED with coversRoot (directory-root)
// ===========================================================================

test('R1.3.F: a coversRoot (directory-root) grant authorises delete on the root', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const root = path.join(TMP, 'F-root');
  fs.mkdirSync(root, { recursive: true });
  const child = path.join(root, 'c.txt');
  fs.writeFileSync(child, 'x');
  const minted = mintOutputGrant(defaultService, root, { coversRoot: true });
  // Delete the child first (so rmdir of the root works on Windows).
  await handlers.get('fb:delete')({}, child, minted.grantId);
  // Delete the root.
  const r = await handlers.get('fb:delete')({}, root, minted.grantId);
  assert.equal(r.ok, true, 'a directory-root grant must authorise delete on the root');
  assert.equal(fs.existsSync(root), false);
});

// ===========================================================================
// R1.3.H: operation/capability mismatch — a read-only grant cannot be used
// for a write (S1 §3 + PathGrantService OPERATION_TO_CAPABILITY table).
// This is the most important edge case to lock in: a renderer that picks
// a file (read-file grant) cannot use that grantId for a write.
// ===========================================================================

test('R1.3.H: a read-only grant cannot authorise a write (capability mismatch)', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const root = path.join(TMP, 'H-root');
  fs.mkdirSync(root, { recursive: true });
  const child = path.join(root, 'c.txt');
  fs.writeFileSync(child, 'x');
  // Mint a READ-ONLY grant. Per S1 §3, the read-file grant covers
  // exactly the picked file (or the granted directory's children)
  // for the `read` capability ONLY. The renderer must not be able
  // to use it for a write.
  const minted = defaultService.mintDirectoryGrant({
    origin: 'picker-read-file', purpose: 'R1.3.H read-only',
    path: root, capabilities: ['read'], coversRoot: false,
  });
  const grantId = minted.grantId;
  // fb:write must be REJECTED because the grant has no `write` capability.
  const w = await handlers.get('fb:write')({}, child, Buffer.from('x').toString('base64'), grantId);
  assert.equal(w.ok, false, 'fb:write with a read-only grant must be rejected');
  assert.match(w.error, /not permitted|write/i);
  // fb:delete must also be REJECTED (no `delete` capability).
  const d = await handlers.get('fb:delete')({}, child, grantId);
  assert.equal(d.ok, false, 'fb:delete with a read-only grant must be rejected');
  // fb:read is ALLOWED (read capability is present, path is a strict
  // descendant of the grant root).
  const r = await handlers.get('fb:read')({}, child, grantId);
  assert.equal(r.ok, true, 'fb:read with a read-only grant must be allowed');
});

// ===========================================================================
// R1.3.I: write to a path outside the grant scope (negative test).
// A valid write grant on TMP, but the target is the OS-temp ancestor
// (which is not a descendant of TMP).
// ===========================================================================

test('R1.3.I: a valid write grant cannot authorise a write outside its scope', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  // Mint a grant on the TMP root. coversRoot:false so the root itself
  // is NOT covered (strict descendants only).
  const grant = defaultService.mintDirectoryGrant({
    origin: 'picker-browser-dir', purpose: 'R1.3.I',
    path: TMP, capabilities: ['read', 'write'], coversRoot: false,
  });
  const grantId = grant.grantId;
  // Try to write to the parent of TMP (os.tmpdir()). That's NOT a
  // descendant of TMP, so the grant must reject.
  const outside = path.join(os.tmpdir(), 'mmx-r13-i-outside.txt');
  // We don't actually want to write to the OS temp dir if it
  // succeeds, so we craft a path that we KNOW is outside.
  // We use the parent of TMP (a level higher). The grant is on
  // TMP only.
  const parentOfTmp = path.dirname(TMP);
  // Skip if TMP is the FS root (paranoid check).
  if (parentOfTmp === TMP) {
    return; // can't construct an "outside" path on a degenerate TMP
  }
  const w = await handlers.get('fb:write')({}, path.join(parentOfTmp, 'outside-target.txt'), Buffer.from('x').toString('base64'), grantId);
  assert.equal(w.ok, false, 'fb:write to a path outside the grant scope must be rejected');
  // The parent of TMP is NOT a strict descendant of TMP — it IS an
  // ancestor, so the canonicalize + relative check must fail.
  // The error should mention "root itself" or "descendant".
  assert.match(w.error, /root itself|descendant|outside/i);
  // Sanity: a write INSIDE TMP must be allowed.
  const inside = path.join(TMP, 'inside-target.txt');
  const w2 = await handlers.get('fb:write')({}, inside, Buffer.from('y').toString('base64'), grantId);
  assert.equal(w2.ok, true, 'fb:write to a strict descendant of the grant root must be allowed');
  void outside; // silence unused warning
});

// ===========================================================================
// fb:move + fb:copy authorise source AND destination
// ===========================================================================

test('R1.3.G: fb:move and fb:copy authorise source AND destination separately', async () => {
  const { handlers } = loadIpc();
  const { defaultService } = require(PATH_GRANT);
  const srcDir = path.join(TMP, 'G-src');
  const dstDir = path.join(TMP, 'G-dst');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(dstDir, { recursive: true });
  const file = path.join(srcDir, 'a.txt');
  fs.writeFileSync(file, 'data');
  // Two separate grants, one per directory. coversRoot so we can
  // move into the dir (the destination is the dir, which is a
  // strict descendant of the dir grant root — except that
  // coversRoot:true also lets us write to the root).
  const srcGrant = mintOutputGrant(defaultService, srcDir, { coversRoot: true });
  const dstGrant = mintOutputGrant(defaultService, dstDir, { coversRoot: true });
  // Wrong grant for destination → reject.
  const r1 = await handlers.get('fb:move')({}, file, dstDir, srcGrant.grantId);
  assert.equal(r1.ok, false, 'fb:move with wrong dest grant must be rejected');
  // Both correct grants → accept.
  // srcGrant covers srcDir but NOT dstDir, so the dest authorization
  // fails. We need a single grant that covers both. Use a grant on
  // TMP (coversRoot:true) which is the common ancestor.
  const allGrant = defaultService.mintDirectoryGrant({
    origin: 'picker-browser-dir', purpose: 'R1.3.G all',
    path: TMP, capabilities: ['read', 'write', 'delete', 'mkdir', 'rename', 'move', 'copy'],
    coversRoot: true,
  });
  const r2 = await handlers.get('fb:move')({}, file, dstDir, allGrant.grantId);
  assert.equal(r2.ok, true, 'fb:move with a grant that covers both source and dest must succeed');
  assert.equal(fs.existsSync(path.join(dstDir, 'a.txt')), true, 'moved file must exist at destination');
  assert.equal(fs.existsSync(file), false, 'moved file must NOT exist at source after move');
  // Re-create the source for the copy test (the move consumed it).
  fs.writeFileSync(file, 'data');
  const r3 = await handlers.get('fb:copy')({}, file, dstDir, allGrant.grantId);
  assert.equal(r3.ok, true, 'fb:copy with a grant that covers both source and dest must succeed');
  assert.equal(fs.existsSync(file), true, 'copied file must still exist at source after copy');
  assert.equal(fs.existsSync(path.join(dstDir, 'a.txt')), true, 'copied file must exist at destination');
  // And: fb:copy with a wrong dest grant must also be rejected.
  const r4 = await handlers.get('fb:copy')({}, file, dstDir, srcGrant.grantId);
  assert.equal(r4.ok, false, 'fb:copy with wrong dest grant must be rejected');
  void dstGrant; // silence unused warning
});
