// tests/unit/main/ipc/grantAuthorizer.test.js
// ============================================================================
// R1.5a.6 — unit test for the shared grantAuthorizer helper.
//
// Verifies the contract that all 6 IPC files depend on:
//   - No grantId → {ok:false, error:'grantId is required for <op> on <path>'};
//     authorize() is NOT called (short-circuit on the cheap check first).
//   - Valid grantId → delegates to PathGrantService.authorize with the
//     given operation + path. The service's relation rules + capability
//     checks are exercised end-to-end.
//   - Unknown grantId → service returns 'grant not found' (re-thrown
//     as {ok:false, error}).
//   - Revoked grantId → service returns 'grant revoked' (re-thrown).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const GRANT_AUTHORIZER = path.join(ROOT, 'main', 'ipc', 'grantAuthorizer.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15a6-grantAuth-'));
fs.mkdirSync(TMP, { recursive: true });

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

function loadGrantAuth() {
  for (const p of [GRANT_AUTHORIZER, PATH_GRANT]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  const { defaultService } = require(PATH_GRANT);
  defaultService.destroy();
  return { authorizePath: require(GRANT_AUTHORIZER).authorizePath, defaultService };
}

test('R1.5a.6: authorizePath with no grantId returns ok:false with a grantId-required error', () => {
  const { authorizePath } = loadGrantAuth();
  const r = authorizePath(undefined, 'read', '/some/path');
  assert.equal(r.ok, false);
  assert.match(r.error, /grantId is required/i);
  assert.match(r.error, /read/i, 'the error must name the operation');
  assert.match(r.error, /\/some\/path/, 'the error must name the path');
});

test('R1.5a.6: authorizePath with empty-string grantId is rejected (same as undefined)', () => {
  const { authorizePath } = loadGrantAuth();
  const r = authorizePath('', 'write', '/some/path');
  assert.equal(r.ok, false);
  assert.match(r.error, /grantId is required/i);
});

test('R1.5a.6: authorizePath with non-string grantId is rejected (defensive)', () => {
  const { authorizePath } = loadGrantAuth();
  const r1 = authorizePath(null, 'read', '/x');
  const r2 = authorizePath(123, 'read', '/x');
  const r3 = authorizePath({}, 'read', '/x');
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  assert.equal(r3.ok, false);
});

test('R1.5a.6: authorizePath with a valid file grant for read succeeds', () => {
  const { authorizePath, defaultService } = loadGrantAuth();
  const file = path.join(TMP, 'file.txt');
  fs.writeFileSync(file, 'hi');
  const g = defaultService.mintFileGrant({ origin: 'test', purpose: 'r15a6', path: file, capabilities: ['read', 'write'] });
  assert.equal(g.ok, true);
  const r = authorizePath(g.grantId, 'read', file);
  assert.equal(r.ok, true);
});

test('R1.5a.6: authorizePath with a valid file grant for write succeeds', () => {
  const { authorizePath, defaultService } = loadGrantAuth();
  const file = path.join(TMP, 'file.txt');
  fs.writeFileSync(file, 'hi');
  const g = defaultService.mintFileGrant({ origin: 'test', purpose: 'r15a6', path: file, capabilities: ['read', 'write'] });
  const r = authorizePath(g.grantId, 'write', file);
  assert.equal(r.ok, true);
});

test('R1.5a.6: authorizePath with a directory grant covers strict descendants', () => {
  const { authorizePath, defaultService } = loadGrantAuth();
  const g = defaultService.mintDirectoryGrant({ origin: 'test', purpose: 'r15a6', path: TMP, capabilities: ['read', 'write', 'rename', 'delete', 'mkdir'] });
  const child = path.join(TMP, 'sub', 'file.txt');
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, 'hi');
  const r = authorizePath(g.grantId, 'read', child);
  assert.equal(r.ok, true, 'a directory grant covers strict descendants');
});

test('R1.5a.6: authorizePath with a directory grant does NOT cover the root itself (S1 §2.5)', () => {
  const { authorizePath, defaultService } = loadGrantAuth();
  // coversRoot:false (default) → root is NOT covered
  const g = defaultService.mintDirectoryGrant({ origin: 'test', purpose: 'r15a6', path: TMP, capabilities: ['read', 'write', 'rename', 'delete', 'mkdir'] });
  const r = authorizePath(g.grantId, 'delete', TMP);
  assert.equal(r.ok, false, 'a default directory grant must NOT authorise deletion of the grant root');
});

test('R1.5a.6: authorizePath with a directory-root grant (coversRoot:true) covers the root itself', () => {
  const { authorizePath, defaultService } = loadGrantAuth();
  const g = defaultService.mintDirectoryGrant({ origin: 'test', purpose: 'r15a6', path: TMP, capabilities: ['read', 'write', 'rename', 'delete', 'mkdir'], coversRoot: true });
  const r = authorizePath(g.grantId, 'delete', TMP);
  assert.equal(r.ok, true, 'a directory-root grant (coversRoot:true) covers the root itself');
});

test('R1.5a.6: authorizePath with a read-only grant for write is rejected', () => {
  const { authorizePath, defaultService } = loadGrantAuth();
  const file = path.join(TMP, 'ro.txt');
  fs.writeFileSync(file, 'hi');
  const g = defaultService.mintFileGrant({ origin: 'test', purpose: 'r15a6', path: file, capabilities: ['read'] });
  const r = authorizePath(g.grantId, 'write', file);
  assert.equal(r.ok, false, 'a read-only grant must reject write operations');
});

test('R1.5a.6: authorizePath with an unknown grantId returns grant-not-found', () => {
  const { authorizePath } = loadGrantAuth();
  const r = authorizePath('grant_does_not_exist_xyz', 'read', '/x');
  assert.equal(r.ok, false);
  assert.match(r.error, /grant not found/i);
});

test('R1.5a.6: authorizePath with a revoked grantId returns grant-revoked', () => {
  const { authorizePath, defaultService } = loadGrantAuth();
  const file = path.join(TMP, 'rev.txt');
  fs.writeFileSync(file, 'hi');
  const g = defaultService.mintFileGrant({ origin: 'test', purpose: 'r15a6', path: file, capabilities: ['read', 'write'] });
  defaultService.revoke(g.grantId);
  const r = authorizePath(g.grantId, 'read', file);
  assert.equal(r.ok, false);
  assert.match(r.error, /grant revoked/i);
});

test('R1.5a.6: authorizePath with a file grant for a different path is rejected', () => {
  const { authorizePath, defaultService } = loadGrantAuth();
  const a = path.join(TMP, 'a.txt');
  const b = path.join(TMP, 'b.txt');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');
  const g = defaultService.mintFileGrant({ origin: 'test', purpose: 'r15a6', path: a, capabilities: ['read', 'write'] });
  const r = authorizePath(g.grantId, 'read', b);
  assert.equal(r.ok, false, 'a file grant covers only its exact canonical path');
});
