// tests/unit/main/services/WorkspaceService.test.js
// ============================================================================
// R1.4 — WorkspaceService unit tests (S1 §4 "Pipeline und State").
//
// Invariants:
//   • mint() canonicalises the path via realpath; non-existent or
//     non-directory paths are rejected.
//   • mint() is idempotent: a second mint for the same canonical path
//     returns the SAME id (so persisted workspaceIds survive restarts
//     when the path still exists).
//   • resolve() returns null for unknown ids, missing-string ids, or
//     ids whose canonical root no longer exists.
//   • inspect() is a read-only peek; list() is diagnostic only.
//   • destroy() clears the registry.
//   • mint() rejects inputs that are missing origin / purpose / path.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WS = require(path.join(ROOT, 'main', 'services', 'WorkspaceService.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-workspace-svc-'));

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

function newSvc() {
  let counter = 0;
  return new WS.WorkspaceService({
    now: () => 1000 + (counter++),
    idFactory: () => 'ws_test_' + crypto.randomBytes(4).toString('hex'),
    realpath: fs.realpathSync,
  });
}

test('R1.4.A: mint() canonicalises an existing directory and returns an id', () => {
  const svc = newSvc();
  const dir = path.join(TMP, 'A');
  fs.mkdirSync(dir, { recursive: true });
  const r = svc.mint({ origin: 'picker-workspace', purpose: 'A test', path: dir });
  assert.equal(r.ok, true);
  assert.ok(typeof r.id === 'string' && r.id.startsWith('ws_'));
  assert.equal(r.workspace.canonicalPath, fs.realpathSync(dir));
  assert.equal(r.workspace.origin, 'picker-workspace');
});

test('R1.4.B: mint() rejects a non-existent path', () => {
  const svc = newSvc();
  const r = svc.mint({ origin: 'app-output', purpose: 'B test', path: path.join(TMP, 'does-not-exist') });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not exist/i);
});

test('R1.4.C: mint() rejects a file (not a directory)', () => {
  const svc = newSvc();
  const f = path.join(TMP, 'C.txt');
  fs.writeFileSync(f, 'x');
  const r = svc.mint({ origin: 'app-output', purpose: 'C test', path: f });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a directory/i);
});

test('R1.4.D: mint() rejects inputs missing origin / purpose / path', () => {
  const svc = newSvc();
  for (const bad of [{}, { origin: 'x' }, { origin: 'x', purpose: 'y' }]) {
    const r = svc.mint(bad);
    assert.equal(r.ok, false, 'mint(' + JSON.stringify(bad) + ') must be rejected');
  }
});

test('R1.4.E: mint() is idempotent — second mint for the same path returns the same id', () => {
  const svc = newSvc();
  const dir = path.join(TMP, 'E');
  fs.mkdirSync(dir, { recursive: true });
  const r1 = svc.mint({ origin: 'app-output', purpose: 'E test', path: dir });
  const r2 = svc.mint({ origin: 'app-output', purpose: 'E test', path: dir });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r1.id, r2.id, 'idempotent mint must return the same id');
  // lastSeenAt is bumped on the second mint.
  assert.ok(r2.workspace.lastSeenAt >= r1.workspace.lastSeenAt);
});

test('R1.4.F: resolve() returns the canonical path for a known id', () => {
  const svc = newSvc();
  const dir = path.join(TMP, 'F');
  fs.mkdirSync(dir, { recursive: true });
  const r = svc.mint({ origin: 'app-output', purpose: 'F test', path: dir });
  const resolved = svc.resolve(r.id);
  assert.equal(resolved, fs.realpathSync(dir));
});

test('R1.4.G: resolve() returns null for an unknown id', () => {
  const svc = newSvc();
  assert.equal(svc.resolve('ws_does_not_exist'), null);
  assert.equal(svc.resolve(''), null);
  assert.equal(svc.resolve(null), null);
  assert.equal(svc.resolve(42), null);
});

test('R1.4.H: resolve() returns null when the canonical root no longer exists', () => {
  const svc = newSvc();
  const dir = path.join(TMP, 'H-vanish');
  fs.mkdirSync(dir, { recursive: true });
  const r = svc.mint({ origin: 'app-output', purpose: 'H test', path: dir });
  assert.equal(svc.resolve(r.id), fs.realpathSync(dir));
  // Remove the directory out from under the registry.
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(svc.resolve(r.id), null,
    'R1.4: resolve() must return null when the canonical root has been deleted');
});

test('R1.4.I: inspect() is a read-only peek; list() enumerates; destroy() clears', () => {
  const svc = newSvc();
  const dir1 = path.join(TMP, 'I1');
  const dir2 = path.join(TMP, 'I2');
  fs.mkdirSync(dir1, { recursive: true });
  fs.mkdirSync(dir2, { recursive: true });
  const r1 = svc.mint({ origin: 'app-output', purpose: 'I1 test', path: dir1 });
  const r2 = svc.mint({ origin: 'picker-workspace', purpose: 'I2 test', path: dir2 });
  // inspect returns a shallow copy.
  const peek = svc.inspect(r1.id);
  assert.equal(peek.id, r1.id);
  assert.equal(peek.canonicalPath, fs.realpathSync(dir1));
  peek.foo = 'mutate';
  const peek2 = svc.inspect(r1.id);
  assert.equal(peek2.foo, undefined, 'inspect() must return a fresh shallow copy');
  // list() returns both.
  const all = svc.list();
  assert.equal(all.length, 2);
  const ids = all.map((w) => w.id).sort();
  assert.deepEqual(ids, [r1.id, r2.id].sort());
  // destroy() clears.
  assert.equal(svc.destroy(), 2);
  assert.equal(svc.list().length, 0);
  assert.equal(svc.resolve(r1.id), null);
  assert.equal(svc.resolve(r2.id), null);
});

test('R1.4.J: the module-level defaultService is a usable singleton', () => {
  // The defaultService is used by every IPC handler. It must
  // expose mint / resolve / inspect / list / destroy.
  const d = WS.defaultService;
  assert.equal(typeof d.mint, 'function');
  assert.equal(typeof d.resolve, 'function');
  assert.equal(typeof d.inspect, 'function');
  assert.equal(typeof d.list, 'function');
  assert.equal(typeof d.destroy, 'function');
  d.destroy();
  // Mint a workspace for a fresh tmp dir and confirm it resolves.
  const dir = path.join(TMP, 'J');
  fs.mkdirSync(dir, { recursive: true });
  const m = d.mint({ origin: 'app-output', purpose: 'J defaultService', path: dir });
  assert.equal(m.ok, true);
  assert.equal(d.resolve(m.id), fs.realpathSync(dir));
  d.destroy();
});
