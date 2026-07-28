// tests/unit/main/services/PathGrantService.test.js
// ============================================================================
// R1.1 — PathGrantService unit tests (S1 design contract).
//
// Invariant: Grants sind opaque, canonical, widerrufbar/ablaufbar und
// autorisieren nur die festgelegte strikte Relation. Kein
// Renderer-Wert kann einen neuen Grant minten; jeder Grant kommt aus
// Main.
//
// Tests use injected now / idFactory / realpath so they are
// deterministic (no sleep, no Date.now directly, no random IDs that
// can collide between parallel runs).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const { PathGrantService, OPERATION_TO_CAPABILITY } = require(path.join(ROOT, 'main', 'services', 'PathGrantService'));

// Per-File Temp-Wurzel; jeder Test schreibt NUR hierhin.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-pgs-'));

let clockNow = 1700000000000;
function makeService(overrides = {}) {
  let idCounter = 0;
  return new PathGrantService({
    now: overrides.now || (() => clockNow),
    idFactory: overrides.idFactory || (() => 'grant-id-' + (++idCounter)),
    realpath: overrides.realpath || fs.realpathSync,
  });
}

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// R1.1.A — Opaque grant IDs are unique + non-guessable.
// ---------------------------------------------------------------------------
test('R1.1.A: mintDirectoryGrant returns opaque, monotonic IDs that the renderer cannot guess', () => {
  const svc = makeService();
  const a = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: TMP, capabilities: ['read', 'write'],
  });
  const b = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: TMP, capabilities: ['read', 'write'],
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.grantId, b.grantId, 'two mints must produce distinct IDs');
  // ID format: from injected idFactory, predictable.
  assert.match(a.grantId, /^grant-id-\d+$/);
  assert.match(b.grantId, /^grant-id-\d+$/);
  // Real-world default: randomUUID.
  const realSvc = new PathGrantService();
  const r1 = realSvc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: TMP, capabilities: ['read'],
  });
  const r2 = realSvc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: TMP, capabilities: ['read'],
  });
  assert.match(r1.grantId, /^[0-9a-f-]{36}$/i, 'default factory must use UUIDv4 format');
  assert.notEqual(r1.grantId, r2.grantId);
});

// ---------------------------------------------------------------------------
// R1.1.B.2 — directory-root grant (coversRoot:true) authorizes the
// root itself AND strict descendants. This is the "app-output" use
// case from S1 §3 where the user has explicitly picked the
// directory as the new output destination.
// ---------------------------------------------------------------------------
test('R1.1.B.2: coversRoot grants cover the root itself AND strict descendants', () => {
  const svc = makeService();
  const root = path.join(TMP, 'root-self');
  fs.mkdirSync(root, { recursive: true });
  const child = path.join(root, 'child.png');
  fs.writeFileSync(child, 'x');
  const r = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test root-self',
    path: root, capabilities: ['read', 'write', 'delete'], coversRoot: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.grant.kind, 'directory-root', 'coversRoot:true must produce a directory-root grant');
  // Root itself is now authorised.
  const rootOk = svc.authorize(r.grantId, { operation: 'write', path: root });
  assert.equal(rootOk.ok, true, 'directory-root must authorize the root itself');
  // Strict descendants are still authorised.
  const childOk = svc.authorize(r.grantId, { operation: 'write', path: child });
  assert.equal(childOk.ok, true, 'directory-root must also authorize strict descendants');
  // ".." escape is still rejected.
  const escape = path.join(root, '..', 'outside.txt');
  const esc = svc.authorize(r.grantId, { operation: 'write', path: escape });
  assert.equal(esc.ok, false, 'directory-root must still reject ".." escapes');
});

// ---------------------------------------------------------------------------
// R1.1.B — Directory grant covers strict descendants, never the root.
// ---------------------------------------------------------------------------
test('R1.1.B: directory grant authorizes strict descendants but NOT the root itself', () => {
  const svc = makeService();
  const root = path.join(TMP, 'grant-root');
  fs.mkdirSync(root, { recursive: true });
  const child = path.join(root, 'child.png');
  fs.writeFileSync(child, 'x');
  const r = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: root, capabilities: ['read', 'write', 'delete'],
  });
  assert.equal(r.ok, true);
  const gId = r.grantId;

  // Kind = strict descendant: a child file is OK.
  const childOk = svc.authorize(gId, { operation: 'write', path: child });
  assert.equal(childOk.ok, true, 'child of the grant root must be authorized');
  assert.match(childOk.canonicalPath, /child\.png$/);

  // Root itself is NEVER covered (S1 §2.5: directory grant darf nie
  // sein eigenes Root löschen, umbenennen oder als Move-Quelle verwenden).
  const rootDenied = svc.authorize(gId, { operation: 'delete', path: root });
  assert.equal(rootDenied.ok, false,
    'directory grant must NEVER authorize the root itself (root-delete is forbidden)');
  assert.match(rootDenied.error, /root itself|descendant/i);
});

// ---------------------------------------------------------------------------
// R1.1.C — ".." escape via realpath must be rejected.
// ---------------------------------------------------------------------------
test('R1.1.C: candidate that escapes the grant root via ".." is rejected after realpath resolution', () => {
  const svc = makeService();
  const root = path.join(TMP, 'escape-root');
  fs.mkdirSync(root, { recursive: true });
  // Hand the renderer a string that LOOKS like a child but realpath-
  // resolves to outside the grant. fs.realpathSync resolves "..".
  const escape = path.join(root, '..', 'outside.txt');
  const r = svc.mintDirectoryGrant({
    origin: 'picker-browser-dir', purpose: 'test',
    path: root, capabilities: ['read', 'write'],
  });
  assert.equal(r.ok, true);
  const out = svc.authorize(r.grantId, { operation: 'write', path: escape });
  assert.equal(out.ok, false,
    '"../outside.txt" must be rejected after realpath resolution');
  assert.match(out.error, /descendant|relative|absolute/i);
});

// ---------------------------------------------------------------------------
// R1.1.D — File grant requires exact canonical path (no descendants, no siblings).
// ---------------------------------------------------------------------------
test('R1.1.D: file grant is exact-match only; siblings and parents are rejected', () => {
  const svc = makeService();
  const file = path.join(TMP, 'exact.txt');
  fs.writeFileSync(file, 'x');
  const sibling = path.join(TMP, 'sibling.txt');
  const child = path.join(file, 'nested');
  const r = svc.mintFileGrant({
    origin: 'picker-read-file', purpose: 'test',
    path: file, capabilities: ['read'],
  });
  assert.equal(r.ok, true);
  // Exact canonical path → OK.
  assert.equal(svc.authorize(r.grantId, { operation: 'read', path: file }).ok, true);
  // Sibling → REJECTED.
  assert.equal(svc.authorize(r.grantId, { operation: 'read', path: sibling }).ok, false,
    'file grant must NOT cover siblings');
  // "Descendant" of the file → REJECTED.
  assert.equal(svc.authorize(r.grantId, { operation: 'read', path: child }).ok, false,
    'file grant must NOT cover a nested path');
});

// ---------------------------------------------------------------------------
// R1.1.E — Expired grants reject every operation.
// ---------------------------------------------------------------------------
test('R1.1.E: a grant past its expiresAt returns ok:false on every operation', () => {
  let now = 1700000000000;
  const svc = new PathGrantService({
    now: () => now,
    idFactory: () => 'g-1',
    realpath: fs.realpathSync,
  });
  const root = path.join(TMP, 'expiry');
  fs.mkdirSync(root, { recursive: true });
  const child = path.join(root, 'a.png');
  fs.writeFileSync(child, 'x');
  const r = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: root, capabilities: ['read', 'write'], expiresAt: now + 1000,
  });
  assert.equal(r.ok, true);
  // Within expiry: OK.
  assert.equal(svc.authorize(r.grantId, { operation: 'write', path: child }).ok, true);
  // Advance past expiry.
  now += 1500;
  // Past expiry: REJECTED.
  const expired = svc.authorize(r.grantId, { operation: 'write', path: child });
  assert.equal(expired.ok, false, 'expired grant must reject');
  assert.match(expired.error, /expired/i);
});

// ---------------------------------------------------------------------------
// R1.1.F — Revoked grants reject every operation.
// ---------------------------------------------------------------------------
test('R1.1.F: revoke() flips the grant to rejected for every subsequent authorize()', () => {
  const svc = makeService();
  const root = path.join(TMP, 'revoke');
  fs.mkdirSync(root, { recursive: true });
  const child = path.join(root, 'b.png');
  fs.writeFileSync(child, 'x');
  const r = svc.mintDirectoryGrant({
    origin: 'picker-browser-dir', purpose: 'test',
    path: root, capabilities: ['read', 'write'],
  });
  assert.equal(svc.authorize(r.grantId, { operation: 'write', path: child }).ok, true);
  const rev = svc.revoke(r.grantId);
  assert.equal(rev.ok, true);
  const after = svc.authorize(r.grantId, { operation: 'write', path: child });
  assert.equal(after.ok, false, 'revoked grant must reject');
  assert.match(after.error, /revoked/i);
});

// ---------------------------------------------------------------------------
// R1.1.G — Single-use save-as grants succeed once, then reject.
// ---------------------------------------------------------------------------
test('R1.1.G: single-use save-as grant is consumed on first authorize() and rejects thereafter', () => {
  const svc = makeService();
  const saveAsTarget = path.join(TMP, 'save-as-output.png');
  const r = svc.mintFileGrant({
    origin: 'save-as-target', purpose: 'save canvas',
    path: saveAsTarget, capabilities: ['write'], singleUse: true,
  });
  assert.equal(r.ok, true);
  // First authorize: OK.
  const first = svc.authorize(r.grantId, { operation: 'write', path: saveAsTarget });
  assert.equal(first.ok, true);
  assert.equal(first.canonicalPath, path.resolve(saveAsTarget));
  // Second authorize: REJECTED (already consumed).
  const second = svc.authorize(r.grantId, { operation: 'write', path: saveAsTarget });
  assert.equal(second.ok, false, 'single-use grant must be consumed on first authorize');
  assert.match(second.error, /consumed|already/i);
});

// ---------------------------------------------------------------------------
// R1.1.H — Junction / symlink escape is rejected via realpath resolution.
//
// We inject a realpath that simulates the symlink-following behaviour
// (production fs.realpathSync follows symlinks). This avoids Windows
// admin-rights requirements for fs.symlinkSync and keeps the test
// deterministic across platforms.
// ---------------------------------------------------------------------------
test('R1.1.H: a candidate that follows a symlink to a different directory is rejected (escape via realpath)', () => {
  const grantRoot = path.join(TMP, 'symlink-grant');
  const symlinkedDir = path.join(TMP, 'symlink-evil');
  const symlink = path.join(TMP, 'symlink-link');
  fs.mkdirSync(grantRoot, { recursive: true });
  fs.mkdirSync(symlinkedDir, { recursive: true });
  // Inject a realpath that resolves `symlink` -> `symlinkedDir`
  // (simulating a real symlink without requiring OS-level creation).
  const fakeRealpath = (p) => {
    if (p === symlink || p.startsWith(symlink + path.sep)) {
      const tail = p.slice(symlink.length);
      return symlinkedDir + tail;
    }
    return fs.realpathSync(p);
  };
  const svc = new PathGrantService({
    now: () => clockNow,
    idFactory: () => 'g-H',
    realpath: fakeRealpath,
  });
  // Grant covers `grantRoot`. The candidate goes via the symlink,
  // which realpath resolves into `symlinkedDir` — outside the grant.
  const r = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: grantRoot, capabilities: ['read', 'write'],
  });
  assert.equal(r.ok, true);
  // The symlink path resolves to symlinkedDir/inside.txt. This is
  // NOT a strict descendant of grantRoot, so authorize must reject.
  const escape = svc.authorize(r.grantId, { operation: 'write', path: path.join(symlink, 'inside.txt') });
  assert.equal(escape.ok, false,
    'candidate that follows a symlink to outside the grant root must be rejected after realpath resolution');
  assert.match(escape.error, /descendant|relative/i);

  // And a candidate inside `grantRoot` (no symlink) is fine.
  const child = path.join(grantRoot, 'inside.txt');
  const ok = svc.authorize(r.grantId, { operation: 'write', path: child });
  assert.equal(ok.ok, true,
    'candidate inside the grant root must still authorize after the fake realpath setup');
});

// ---------------------------------------------------------------------------
// R1.1.H.2 — Same symlink root: if the grant IS on the symlink-target,
// the symlink path resolves to the grant root and is authorized.
// ---------------------------------------------------------------------------
test('R1.1.H.2: a candidate that follows a symlink to the grant root itself is authorized', () => {
  const target = path.join(TMP, 'symlink-grant-target');
  const symlink = path.join(TMP, 'symlink-grant-link');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'inside.txt'), 'x');
  const fakeRealpath = (p) => {
    if (p === symlink || p.startsWith(symlink + path.sep)) {
      const tail = p.slice(symlink.length);
      return target + tail;
    }
    return fs.realpathSync(p);
  };
  const svc = new PathGrantService({
    now: () => clockNow,
    idFactory: () => 'g-H2',
    realpath: fakeRealpath,
  });
  const r = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: target, capabilities: ['read', 'write'],
  });
  assert.equal(r.ok, true);
  // Authorize via the symlink path → realpath resolves to target.
  // Since the grant was minted on `target`, the canonical path matches.
  const viaSymlink = svc.authorize(r.grantId, { operation: 'write', path: path.join(symlink, 'inside.txt') });
  assert.equal(viaSymlink.ok, true,
    'a candidate that follows a symlink to the grant target should be authorized');
});

// ---------------------------------------------------------------------------
// R1.1.I — Drive letter case (C: vs c:) is normalised via realpath.
// ---------------------------------------------------------------------------
test('R1.1.I: drive letter case differences (C: vs c:) collapse after realpath', () => {
  const svc = makeService();
  const realpathCalls = [];
  const realRoot = fs.realpathSync(TMP);
  // Inject a realpath that lowercases the drive letter for both the
  // mint and the authorize, so case differences collapse.
  const lowerRealpath = (p) => {
    realpathCalls.push(p);
    const r = fs.realpathSync(p);
    return r.replace(/^([A-Z]):/, (m, d) => d.toLowerCase() + ':');
  };
  const svc2 = new PathGrantService({
    now: () => 1, idFactory: () => 'g', realpath: lowerRealpath,
  });
  const root = realRoot.replace(/^([A-Z]):/, (m, d) => d.toLowerCase() + ':');
  const r = svc2.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: root, capabilities: ['read', 'write'],
  });
  assert.equal(r.ok, true);
  // Pass the original-case path → still works because realpath
  // collapses the case.
  const upper = realRoot.replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ':');
  const child = path.join(upper, 'case.txt');
  const ok = svc2.authorize(r.grantId, { operation: 'write', path: child });
  assert.equal(ok.ok, true,
    'drive-letter case differences must collapse after realpath; both lowercase and uppercase drive letters must work');
  // Suppress unused warnings; svc is referenced for the R1.1.A
  // sibling test pattern; realRoot is referenced for explicitness.
  void svc; void realpathCalls;
});

// ---------------------------------------------------------------------------
// R1.1.J — Missing path with nearest existing parent is canonicalised
// (used for save-as targets that don't exist yet).
// ---------------------------------------------------------------------------
test('R1.1.J: a non-existent candidate path is canonicalised through the nearest existing ancestor', () => {
  const svc = makeService();
  const realRoot = fs.realpathSync(TMP);
  const newFile = path.join(realRoot, 'subdir', 'new.png');
  const r = svc.mintFileGrant({
    origin: 'save-as-target', purpose: 'test',
    path: newFile, capabilities: ['write'],
  });
  assert.equal(r.ok, true, 'save-as with a non-existent target must still mint');
  // Authorize against the same non-existent path.
  const authz = svc.authorize(r.grantId, { operation: 'write', path: newFile });
  assert.equal(authz.ok, true, 'non-existent save-as target must still authorize via ancestor-realpath');
  assert.equal(authz.canonicalPath, path.resolve(newFile));
});

// ---------------------------------------------------------------------------
// R1.1.K — Unknown / empty / revoked grantId is rejected.
// ---------------------------------------------------------------------------
test('R1.1.K: authorize() rejects empty grantId, unknown grantId, and revoked grantId', () => {
  const svc = makeService();
  const root = path.join(TMP, 'K');
  fs.mkdirSync(root, { recursive: true });
  // Empty.
  assert.equal(svc.authorize('', { operation: 'read', path: root }).ok, false);
  // Unknown.
  assert.equal(svc.authorize('nonexistent-id', { operation: 'read', path: root }).ok, false);
  // Revoked.
  const r = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: root, capabilities: ['read'],
  });
  svc.revoke(r.grantId);
  assert.equal(svc.authorize(r.grantId, { operation: 'read', path: path.join(root, 'x') }).ok, false);
});

// ---------------------------------------------------------------------------
// R1.1.L — Unknown operation is rejected (not silently allowed).
// ---------------------------------------------------------------------------
test('R1.1.L: unknown / unsupported operation strings are rejected with a clear error', () => {
  const svc = makeService();
  const root = path.join(TMP, 'L');
  fs.mkdirSync(root, { recursive: true });
  const r = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: root, capabilities: ['read', 'write', 'delete', 'mkdir', 'rename', 'copy', 'move'],
  });
  for (const op of ['', 'format-disk', 'sudo', 'exec', 'eval']) {
    const a = svc.authorize(r.grantId, { operation: op, path: path.join(root, 'x') });
    assert.equal(a.ok, false, 'operation "' + op + '" must be rejected');
    assert.match(a.error, /unknown operation|operation required/);
  }
  // Sanity: every known operation is allowed (since capabilities
  // include all of them).
  for (const op of Object.keys(OPERATION_TO_CAPABILITY)) {
    const a = svc.authorize(r.grantId, { operation: op, path: path.join(root, 'x') });
    assert.equal(a.ok, true, 'known operation "' + op + '" must be authorized when capability is granted');
  }
});

// ---------------------------------------------------------------------------
// R1.1.M — Capability mismatch: a delete on a read-only grant is rejected.
// ---------------------------------------------------------------------------
test('R1.1.M: capability mismatch (e.g. write on a read-only grant) is rejected before path checks', () => {
  const svc = makeService();
  const root = path.join(TMP, 'M');
  fs.mkdirSync(root, { recursive: true });
  const child = path.join(root, 'x');
  const r = svc.mintDirectoryGrant({
    origin: 'picker-read-file', purpose: 'test',
    path: root, capabilities: ['read'],  // read-only
  });
  assert.equal(svc.authorize(r.grantId, { operation: 'write', path: child }).ok, false,
    'write on a read-only grant must be rejected');
  assert.equal(svc.authorize(r.grantId, { operation: 'delete', path: child }).ok, false,
    'delete on a read-only grant must be rejected');
  // read on the root itself: still rejected because root is never covered.
  assert.equal(svc.authorize(r.grantId, { operation: 'read', path: root }).ok, false,
    'root itself is never covered for a directory grant (S1 §2.5)');
});

// ---------------------------------------------------------------------------
// R1.1.N — A candidate that resolves to outside the existing filesystem
// returns error (no exception, no silent allow).
// ---------------------------------------------------------------------------
test('R1.1.N: a candidate path that has no existing ancestor is canonicalised to null and rejected', () => {
  const svc = makeService();
  const root = path.join(TMP, 'N');
  fs.mkdirSync(root, { recursive: true });
  const r = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: root, capabilities: ['write'],
  });
  // A deeply non-existent drive on Windows. On POSIX, /__nonexistent_root__/...
  const ghost = process.platform === 'win32'
    ? 'Z:\\__definitely_not_a_drive__\\foo.png'
    : '/__definitely_not_a_drive__/foo.png';
  const a = svc.authorize(r.grantId, { operation: 'write', path: ghost });
  assert.equal(a.ok, false, 'path with no existing ancestor must be rejected');
  assert.match(a.error, /canonicalize|not found/i);
});

// ---------------------------------------------------------------------------
// R1.1.O — Time injection works: the service does not call Date.now directly.
// ---------------------------------------------------------------------------
test('R1.1.O: clock is injectable; expiry is computed against the injected now()', () => {
  const nows = [100, 200, 300, 400];
  let i = 0;
  const svc = new PathGrantService({
    now: () => nows[i++],
    idFactory: () => 'g-O',
    realpath: fs.realpathSync,
  });
  const root = path.join(TMP, 'O');
  fs.mkdirSync(root, { recursive: true });
  const child = path.join(root, 'x');
  const r = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: root, capabilities: ['write'], expiresAt: 250,
  });
  // First authorize at t=100: OK.
  assert.equal(svc.authorize(r.grantId, { operation: 'write', path: child }).ok, true);
  // Second authorize at t=300: expired.
  const after = svc.authorize(r.grantId, { operation: 'write', path: child });
  assert.equal(after.ok, false);
  assert.match(after.error, /expired/i);
});

// ---------------------------------------------------------------------------
// R1.1.P — Path traversal via "..\\.." is caught at canonicalization.
// ---------------------------------------------------------------------------
test('R1.1.P: a candidate with a deeply nested "..\\.." traversal is rejected (realpath pre-check)', () => {
  const svc = makeService();
  const root = path.join(TMP, 'P');
  fs.mkdirSync(root, { recursive: true });
  const r = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: root, capabilities: ['read', 'write'],
  });
  // The candidate LOOKS like a child but realpath-resolves above the root.
  const traversal = path.join(root, '..', '..', 'evil.txt');
  const a = svc.authorize(r.grantId, { operation: 'read', path: traversal });
  assert.equal(a.ok, false, 'deep "..\\.." traversal must be rejected');
});

// ---------------------------------------------------------------------------
// R1.1.Q — inspect() returns a shallow copy; mutations do not affect the
// internal store. (Defensive: the renderer must not be able to mutate
// a grant by holding a reference.)
// ---------------------------------------------------------------------------
test('R1.1.Q: inspect() returns a defensive copy; mutating it does not affect authorize()', () => {
  const svc = makeService();
  const root = path.join(TMP, 'Q');
  fs.mkdirSync(root, { recursive: true });
  const r = svc.mintDirectoryGrant({
    origin: 'app-output', purpose: 'test',
    path: root, capabilities: ['read'],
  });
  const snap = svc.inspect(r.grantId);
  assert.ok(snap, 'inspect must return the grant');
  // Mutate the snapshot.
  snap.revoked = true;
  snap.capabilities.push('write');
  // Authorize still works because the internal grant was NOT mutated.
  const child = path.join(root, 'a');
  fs.writeFileSync(child, 'x');
  const a = svc.authorize(r.grantId, { operation: 'read', path: child });
  assert.equal(a.ok, true, 'snapshot mutation must not affect the live grant');
  const w = svc.authorize(r.grantId, { operation: 'write', path: child });
  assert.equal(w.ok, false, 'snapshot mutation must not have promoted capabilities');
});

// ---------------------------------------------------------------------------
// R1.1.R — UNC path (\\server\share\dir) preserves the prefix when the
// target does not exist yet. S1 §3: "Drive-Roots, UNC-Shares, Groß-/
// Kleinschreibung und Separatoren werden über die native path-
// Implementierung und realpath behandelt."
// We inject a realpath that resolves \\server\share but not the inner
// dir, then assert the missing inner part is correctly reattached.
// ---------------------------------------------------------------------------
test('R1.1.R: a non-existent UNC path is canonicalised via path.dirname (UNC prefix preserved)', () => {
  // Inject a realpath that knows about a fake share. This avoids
  // requiring an actual SMB server in the test env.
  const shareRoot = '\\\\fake-server\\fake-share';
  const deepTarget = shareRoot + '\\nested\\dir\\file.txt';
  const fakeRealpath = (p) => {
    if (p === shareRoot || p === shareRoot + '\\') return p;
    if (p.startsWith(shareRoot + '\\')) {
      // Simulate: only the share root itself exists.
      if (p === shareRoot + '\\nested' || p === shareRoot + '\\nested\\') {
        const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
      }
      // Allow "nested" or "nested\\dir" or "nested\\dir\\file.txt"
      // to NOT exist (they don't on our fake share).
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    }
    return fs.realpathSync(p);
  };
  const svc = new PathGrantService({
    now: () => clockNow,
    idFactory: () => 'g-R',
    realpath: fakeRealpath,
  });
  // Mint a file grant on the non-existent target. The canonicalise
  // walk should land at the share root and reattach the missing tail.
  const r = svc.mintFileGrant({
    origin: 'save-as-target', purpose: 'test',
    path: deepTarget, capabilities: ['write'],
  });
  assert.equal(r.ok, true, 'mint must succeed even for non-existent UNC target');
  // The grant's canonicalPath must preserve the UNC prefix and the
  // missing tail — it's the same shape as the input, just anchored
  // to the realpath'd share root.
  assert.ok(r.grant.canonicalPath.startsWith(shareRoot),
    'canonical path must keep the UNC prefix; got ' + r.grant.canonicalPath);
  assert.ok(r.grant.canonicalPath.endsWith('\\nested\\dir\\file.txt'),
    'canonical path must reattach the missing tail; got ' + r.grant.canonicalPath);
  // Authorize the same target back — exact file match, so it must
  // authorize (both resolve to the same canonical).
  const a = svc.authorize(r.grantId, { operation: 'write', path: deepTarget });
  assert.equal(a.ok, true, 'exact canonical match must authorize');
});

// ---------------------------------------------------------------------------
// R1.1.S — destroy() and evictExpired() bound the in-memory grant store.
// ---------------------------------------------------------------------------
test('R1.1.S: destroy() clears all grants; evictExpired() removes only expired ones', () => {
  let now = 100;
  let idCounter = 0;
  const svc = new PathGrantService({
    now: () => now,
    idFactory: () => 'g-' + (++idCounter),
    realpath: fs.realpathSync,
  });
  const root = path.join(TMP, 'S');
  fs.mkdirSync(root, { recursive: true });
  // Mint 3 grants: 2 short-lived, 1 long-lived.
  const r1 = svc.mintDirectoryGrant({ origin: 'app-output', purpose: 'a', path: root, capabilities: ['read'], expiresAt: 200 });
  const r2 = svc.mintDirectoryGrant({ origin: 'app-output', purpose: 'b', path: root, capabilities: ['read'], expiresAt: 300 });
  const r3 = svc.mintDirectoryGrant({ origin: 'app-output', purpose: 'c', path: root, capabilities: ['read'], expiresAt: 999 });
  assert.ok(r1.ok && r2.ok && r3.ok);

  // Move to t=250. r1 (expiresAt 200) is expired. r2 + r3 still valid.
  now = 250;
  // Before evict: r1 still in the store (just expired).
  assert.equal(svc.inspect(r1.grantId) !== null, true);
  const removed = svc.evictExpired();
  assert.equal(removed, 1, 'evictExpired must remove exactly r1');
  assert.equal(svc.inspect(r1.grantId), null, 'r1 must be gone after evictExpired');
  assert.ok(svc.inspect(r2.grantId), 'r2 must still be present (not expired)');
  assert.ok(svc.inspect(r3.grantId), 'r3 must still be present (not expired)');

  // destroy() must clear everything.
  const n = svc.destroy();
  assert.equal(n, 2, 'destroy must report 2 remaining grants (r2 + r3)');
  assert.equal(svc.inspect(r2.grantId), null);
  assert.equal(svc.inspect(r3.grantId), null);
  // After destroy, minting must still work.
  const r4 = svc.mintDirectoryGrant({ origin: 'app-output', purpose: 'd', path: root, capabilities: ['read'] });
  assert.equal(r4.ok, true);
});

// ---------------------------------------------------------------------------
// R1.1.T — revoke() and inspect() reject non-string grantId consistently
// with authorize().
// ---------------------------------------------------------------------------
test('R1.1.T: revoke() and inspect() reject empty / non-string grantId', () => {
  const svc = makeService();
  for (const id of [null, undefined, 123, '', {}, []]) {
    assert.equal(svc.revoke(id).ok, false, 'revoke(' + String(id) + ') must return ok:false');
    assert.equal(svc.inspect(id), null, 'inspect(' + String(id) + ') must return null');
  }
});
