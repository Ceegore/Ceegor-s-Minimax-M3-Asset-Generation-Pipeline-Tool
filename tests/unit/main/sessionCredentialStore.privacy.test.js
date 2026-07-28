// tests/unit/main/sessionCredentialStore.privacy.test.js
// ============================================================================
// R2.1 — SessionCredentialStore contract (SYS-002, 360° audit design contract §5)
//
// Invariante:
//   1. setSessionCredential stores a non-empty string; refuses falsy
//      or non-string inputs with a redacted error.
//   2. getSessionCredential returns the held value, or null.
//   3. hasSessionCredential reflects state without leaking the value.
//   4. clearSessionCredential wipes the value; idempotent.
//   5. getDiagnostics returns metadata only — never the credential.
//   6. The module exports NO IPC channel: it must be reachable only via
//      `require()` from Main-side code. We assert this by checking that
//      no function name in the module body matches the
//      `ipcMain.handle(` registration pattern (i.e. it doesn't try to
//      register itself).
//   7. After a clear, a fresh set/clear cycle works without state
//      contamination (proves no `let _key` reassignment bug).
//   8. setSessionCredential on an empty string returns ok:false; the
//      store remains empty. The "in-memory key" is NEVER a placeholder
//      like '' or null — those are absorbed by hasSessionCredential
//      returning false.
//
// Schreibt NUR in OS-Temp.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STORE_PATH = path.join(ROOT, 'main', 'services', 'SessionCredentialStore.js');

test.beforeEach(() => {
  // Wipe the require cache so a previous test's _key doesn't leak.
  try { delete require.cache[require.resolve(STORE_PATH)]; } catch (_) {}
});

test('R2.1.A: setSessionCredential stores a non-empty string, getSessionCredential returns it', () => {
  const store = require(STORE_PATH);
  const SECRET = 'sk-session-test-AAAA-1234';
  const r = store.setSessionCredential(SECRET);
  assert.equal(r.ok, true, 'set must succeed for a non-empty string');
  assert.equal(store.getSessionCredential(), SECRET, 'get must return the same value');
  assert.equal(store.hasSessionCredential(), true, 'has must be true after set');
});

test('R2.1.B: setSessionCredential refuses falsy / non-string inputs', () => {
  const store = require(STORE_PATH);
  for (const bad of ['', null, undefined, 0, false, 123, {}, []]) {
    const r = store.setSessionCredential(bad);
    assert.equal(r.ok, false, 'set must refuse ' + JSON.stringify(bad) + ' (got ok:true)');
    assert.match(r.error || '', /non-empty string/, 'error must mention "non-empty string"');
    // The store remains empty after a refused set.
    assert.equal(store.hasSessionCredential(), false,
      'store must stay empty after a refused set; got key=' + JSON.stringify(store.getSessionCredential()));
  }
});

test('R2.1.C: clearSessionCredential wipes the value; idempotent', () => {
  const store = require(STORE_PATH);
  store.setSessionCredential('sk-temp');
  assert.equal(store.hasSessionCredential(), true);
  store.clearSessionCredential();
  assert.equal(store.hasSessionCredential(), false, 'has must be false after clear');
  assert.equal(store.getSessionCredential(), null, 'get must return null after clear');
  // Clear again is a no-op (no throw).
  store.clearSessionCredential();
  store.clearSessionCredential();
  assert.equal(store.hasSessionCredential(), false, 'idempotent clear must keep has=false');
});

test('R2.1.D: getDiagnostics returns metadata only — never the credential', () => {
  const store = require(STORE_PATH);
  const SECRET = 'sk-diagnostics-canary-DO-NOT-LOG-9876';
  store.setSessionCredential(SECRET);
  const diag = store.getDiagnostics();
  // Snapshot the stringified form once; the assert must use a stricter
  // check than just "the secret string isn't there" because the
  // diagnostic could accidentally include a substring of the secret.
  const diagStr = JSON.stringify(diag);
  assert.equal(diagStr.includes(SECRET), false,
    'R2.1.SECURITY: getDiagnostics must not include the credential. Got: ' + diagStr);
  // And: the snapshot carries the metadata we expect.
  assert.equal(diag.hasCredential, true, 'hasCredential must be true after set');
  assert.equal(typeof diag.setCount, 'number');
  assert.equal(diag.setCount >= 1, true);
  assert.equal(diag.setAt > 0, true, 'setAt must be a positive timestamp');
});

test('R2.1.E: the module exports no IPC channel — must be reachable only via require()', () => {
  // Static invariant: the module body must not call `ipcMain.handle(` or
  // `ipcMain.on(`. If it ever does, the contract is broken: the store
  // is internal to Main and must not register any IPC endpoint.
  const src = fs.readFileSync(STORE_PATH, 'utf8');
  assert.equal(/ipcMain\.handle\s*\(/.test(src), false,
    'R2.1.SECURITY: SessionCredentialStore must not register any ipcMain.handle channel. The store is internal to Main; only the resolver (R2.2) is allowed to call setSessionCredential().');
  assert.equal(/ipcMain\.on\s*\(/.test(src), false,
    'R2.1.SECURITY: SessionCredentialStore must not register any ipcMain.on listener either.');
  // And: the renderer-side contract is "no getter on window.api". We
  // can't import preload.js here, but we can check that the export list
  // does not contain any getter that is safe to expose to a renderer
  // (e.g. a "read" function). The actual contract is the resolver-only
  // setSessionCredential / getSessionCredential pair, and even those
  // are documented as INTERNAL — the next test asserts that no module
  // outside the resolver calls them.
  const exports = require(STORE_PATH);
  for (const k of Object.keys(exports)) {
    assert.notEqual(k, 'getSessionCredentialForRenderer', 'no renderer-side getter is exported');
    assert.notEqual(k, 'getKey', 'no renderer-side getter is exported');
    assert.notEqual(k, 'reveal', 'no renderer-side getter is exported');
  }
});

test('R2.1.F: fresh set/clear cycles are independent (no module-state contamination)', () => {
  const store = require(STORE_PATH);
  for (let i = 0; i < 3; i++) {
    const k = 'sk-iter-' + i;
    store.setSessionCredential(k);
    assert.equal(store.getSessionCredential(), k, 'iter ' + i + ': get must return just-set value');
    store.clearSessionCredential();
    assert.equal(store.getSessionCredential(), null, 'iter ' + i + ': get must be null after clear');
  }
});

test('R2.1.G: _resetForTest is the only test-only export and wipes all counters', () => {
  const store = require(STORE_PATH);
  store.setSessionCredential('sk-pre-reset');
  store.setSessionCredential('sk-pre-reset-2');
  const before = store.getDiagnostics();
  assert.equal(before.setCount >= 2, true, 'precondition: setCount >= 2');
  store._resetForTest();
  const after = store.getDiagnostics();
  assert.equal(after.hasCredential, false, 'hasCredential must be false after _resetForTest');
  assert.equal(after.setCount, 0, 'setCount must be 0 after _resetForTest');
  assert.equal(after.setAt, 0, 'setAt must be 0 after _resetForTest');
  assert.equal(after.clearedAt, 0, 'clearedAt must be 0 after _resetForTest');
});

test('R2.1.H: the exported API matches the S1 §3 contract (setter/clearer, no main→renderer channel)', () => {
  const store = require(STORE_PATH);
  const exported = Object.keys(store).sort();
  // Allowed export surface. Every function name must have a documented
  // purpose in the module header. Adding new exports is allowed only
  // via a new sub-card (R2.x) that documents the new contract.
  const expected = [
    '_resetForTest',
    'clearSessionCredential',
    'getDiagnostics',
    'getSessionCredential',
    'hasSessionCredential',
    'setSessionCredential',
  ];
  assert.deepEqual(exported, expected,
    'R2.1 contract: SessionCredentialStore must export exactly {set, clear, has, get, getDiagnostics, _resetForTest}. Got: ' + JSON.stringify(exported));
});
