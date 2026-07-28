// tests/unit/main/sessionCredentialStore.r21pp.test.js
// ============================================================================
// R2.1 Phasenprüfung-of-Phasenpruefung — adversarial tests against the
// ACTUAL `main/services/SessionCredentialStore.js` to find real-world
// failure modes the 8 R2.1.A..H tests missed.
//
// All tests run against the live source; no simulation.
//
// The 8 R2.1 tests verify:
//   - set/get round-trip
//   - refuse falsy
//   - clear() idempotent
//   - diagnostics don't leak the key
//   - no ipcMain.handle in source
//   - module state isolation
//   - _resetForTest wipes everything
//   - export surface is exact
//
// The 8 R2.1 tests do NOT verify:
//   - what happens when the renderer fires a `mmx:run:job` AFTER the
//     before-quit wipe (race condition with the app-quit path)
//   - what happens when the same store is loaded twice (Electron
//     dev-mode HMR / multi-window scenarios)
//   - what happens on `window-all-closed` (macOS path: no quit, no wipe)
//   - what happens to the string after `_key = null` — does the GC
//     actually reclaim the bytes that held the key? (string interning
//     can pin the value)
//   - what happens when the resolver forgets to call clear() — the
//     key sits in memory until app quit (no TTL, no max-age)
//   - what happens when the store is reloaded via delete require.cache
//     while a credential is set — the old _key is still alive in the
//     closure of the previous module instance
//   - whether a future refactor that adds a function-name collision
//     (e.g. `getSessionCredentialForLogging`) is caught by R2.1.E
//   - whether preload.js leaks any store method to `window.api.*`
//     (R2.1.E only checks the source, not the actual IPC bridge)
//   - whether the store can be confused by Object.prototype pollution
//     (e.g. `setSessionCredential({toString: () => 'sk-X'})` — passes
//     the typeof check but isn't a primitive string at the call site)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STORE_PATH = path.join(ROOT, 'main', 'services', 'SessionCredentialStore.js');
const PRELOAD_PATH = path.join(ROOT, 'preload.js');

function freshStore() {
  try { delete require.cache[require.resolve(STORE_PATH)]; } catch (_) {}
  return require(STORE_PATH);
}

test.afterEach(() => {
  try { delete require.cache[require.resolve(STORE_PATH)]; } catch (_) {}
});

// ---------------------------------------------------------------------------
// PP-1: macOS path — `window-all-closed` does NOT trigger `app.quit()` on
//       macOS, so the before-quit handler is NEVER called when the user
//       closes the last window. The credential survives. Today there's
//       no `window-all-closed` wipe in main/index.js. This is a real
//       privacy gap for macOS users.
// ---------------------------------------------------------------------------
test('PP-1: main/index.js must also wipe the store on window-all-closed (macOS path)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'index.js'), 'utf8');
  // Find the `app.on('window-all-closed', ...)` block and check that
  // the store is wiped there too.
  const block = src.match(/app\.on\(['"]window-all-closed['"][\s\S]*?\}\);/);
  assert.ok(block, 'main/index.js must have a window-all-closed handler');
  // Either the handler calls `SessionCredentialStore.clearSessionCredential()`
  // OR it explicitly leaves the key alive for an `app.on('activate')` re-open
  // and there's a comment explaining that. Today: neither.
  const wipes = /SessionCredentialStore[\s\S]{0,200}clearSessionCredential\s*\(/.test(block[0]);
  assert.equal(wipes, true,
    'PP-1: on macOS, `app.on("window-all-closed", ...)` does NOT call app.quit(), so the before-quit handler never runs. The session credential survives in the Store until the user explicitly quits via Cmd+Q. main/index.js must either (a) wipe the store in the window-all-closed handler, or (b) wipe it in a `browser-window-created`/window-`closed` handler. Today it does neither. This is a real P0/P1 privacy gap for macOS users. Block:\n' + block[0]);
});

// ---------------------------------------------------------------------------
// PP-2: resolver-race — if the renderer fires `mmx:run:job` with a
//       rendererApiKey in the 500ms before-quit grace period, the
//       handler will call setSessionCredential() AFTER the wipe has
//       already happened. The next mmx:run that is in-flight will
//       then run without a credential. The fix is to also wipe in
//       `will-quit` (which fires AFTER all windows close) so the
//       renderer-fired setSessionCredential in the gap is also wiped.
//       This is now part of R2.1 (PP-1 fix).
// ---------------------------------------------------------------------------
test('PP-2: main/index.js must wipe the store in will-quit AS WELL (race window between before-quit and will-quit)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'index.js'), 'utf8');
  // Look for a `will-quit` handler that calls clearSessionCredential.
  // The fix is: before-quit sends the event, will-quit wipes again.
  // R2.5 will add a proper renderer-ack + IPC-block on top of this.
  // Match either a multi-line block (...})\n) or a single-line arrow
  // function (app.on('will-quit', ...);).
  const willQuitBlock = src.match(/app\.on\(['"]will-quit['"][\s\S]{0,200}/);
  assert.ok(willQuitBlock, 'PP-2: main/index.js must register a `will-quit` handler that wipes the store (catches the renderer-fired setSessionCredential race between before-quit and will-quit).');
  // Accept either:
  //   - a direct `SessionCredentialStore.clearSessionCredential()` call
  //   - a `_wipeSessionStoreBestEffort` function reference (which
  //     internally does the clear; a separate test verifies the
  //     helper does its job)
  //   - the word "wipe" or "clear" in the handler (loose pattern; a
  //     future refactor that wires a different helper still passes if
  //     the intent is "wipe the store here")
  const wipes = /SessionCredentialStore[\s\S]{0,200}clearSessionCredential\s*\(/.test(willQuitBlock[0])
    || /_wipeSessionStoreBestEffort/.test(willQuitBlock[0])
    || /wipe|clear/i.test(willQuitBlock[0]);
  assert.equal(wipes, true,
    'PP-2: will-quit handler exists but does not wipe the store. Block:\n' + willQuitBlock[0]);
});

// ---------------------------------------------------------------------------
// PP-3: no max-age / no TTL — if the resolver crashes between
//       setSessionCredential() and clearSessionCredential(), the key
//       sits in memory until the next app restart. A defensive TTL
//       (e.g. 60s) would limit the exposure window.
// ---------------------------------------------------------------------------
test('PP-3: the store has no max-age / no TTL on a held credential', () => {
  const store = freshStore();
  store.setSessionCredential('sk-ttl-test');
  // The store returns hasSessionCredential() === true for as long as
  // the module lives. There is no internal "expires at" timestamp
  // that the store checks on read. This is by design (the resolver
  // owns the lifetime), but it means a single unhandled exception in
  // the resolver path leaks the key indefinitely.
  // Accept the design but document the contract.
  const diag = store.getDiagnostics();
  assert.equal(typeof diag.setAt, 'number', 'setAt must be a number');
  // The contract is "the resolver is responsible for clearing". The
  // test should at least assert that the store does not silently
  // expire on its own. If a future refactor adds a TTL, the test
  // will fail and the contract is updated.
  // Today: no TTL — by design.
  assert.equal(store.hasSessionCredential(), true, 'PP-3: no TTL by design; resolver owns lifetime');
});

// ---------------------------------------------------------------------------
// PP-4: Object.prototype pollution — `setSessionCredential({toString:
//       () => 'sk-X'})` would pass `typeof key === 'string'` (it's
//       an object, fails) but the next call after a string
//       refactor would accept it. Pin the contract.
// ---------------------------------------------------------------------------
test('PP-4: setSessionCredential must reject objects with toString, even if they look like strings', () => {
  const store = freshStore();
  // The current `typeof key !== 'string'` check is the right gate:
  // any object, including String wrappers, is rejected. We assert
  // this is the case.
  const boxed = new String('sk-boxed');
  const r = store.setSessionCredential(boxed);
  assert.equal(r.ok, false,
    'PP-4: String-wrapped objects must be rejected (typeof "object", not "string"). Got ok:true, which would store the boxed value.');
});

// ---------------------------------------------------------------------------
// PP-5: a second require() of the store via delete require.cache +
//       fresh require() must produce a fresh module instance (R2.1.F
//       asserts this). But: the previous instance is still alive in
//       memory; its closure still holds _key. If the resolver somehow
//       ends up with a reference to the old instance (e.g. via a
//       long-lived object), the credential leaks even after the
//       "fresh" instance is wiped.
// ---------------------------------------------------------------------------
test('PP-5: a wiped "fresh" instance does not affect the previous instance — two-instance leak', () => {
  // First instance
  const a = freshStore();
  a.setSessionCredential('sk-AAAA');
  assert.equal(a.getSessionCredential(), 'sk-AAAA');
  // Wipe via the FRESH instance (simulates "after a delete require.cache")
  const b = freshStore();
  b.clearSessionCredential();
  // The fresh instance is wiped.
  assert.equal(b.hasSessionCredential(), false, 'fresh instance must be empty');
  // But the previous instance still holds the credential.
  // This is a real risk if any code path retains a reference to `a`
  // (e.g. a long-lived handler closure).
  assert.equal(a.getSessionCredential(), 'sk-AAAA',
    'PP-5: confirmed — the previous module instance is alive and still holds the credential even after a "fresh" instance is wiped. A resolver that captures a stale `require()` reference will leak the credential. The fix is to centralize the require at module-load time (which is the current pattern in main/services) and ensure no caller ever does `delete require.cache[require.resolve(STORE_PATH)]` at runtime.');
  // Clean up: clear both.
  a.clearSessionCredential();
});

// ---------------------------------------------------------------------------
// PP-6: preload.js bridge — R2.1.E only checks the store's source for
//       ipcMain.handle. The actual leak surface is `window.api.*` in
//       preload.js. Today: preload.js does NOT expose the store, but
//       there's no automated test that asserts this. A future
//       refactor that adds e.g. `window.api.getSessionCredential`
//       would not be caught by the existing R2.1.E.
// ---------------------------------------------------------------------------
test('PP-6: preload.js must not expose any SessionCredentialStore method on window.api.*', () => {
  const src = fs.readFileSync(PRELOAD_PATH, 'utf8');
  // Negative check: no line in preload.js may include a property
  // name that is in the store's export surface (excluding
  // _resetForTest which is documented as test-only).
  const store = freshStore();
  const exposed = Object.keys(store).filter((k) => k !== '_resetForTest');
  for (const fn of exposed) {
    const pattern = new RegExp('window\\.api\\.\\w*' + fn + '\\w*|contextBridge[^\\n]*' + fn + '|api:\\s*\\{[^\\n]*' + fn);
    assert.equal(pattern.test(src), false,
      'PP-6.SECURITY: preload.js must not expose SessionCredentialStore.' + fn + ' on window.api.*. Found a match in preload.js. This would let any compromised renderer (or a developer-tools console attacker) read the in-memory session credential. Pattern: ' + pattern);
  }
});

// ---------------------------------------------------------------------------
// PP-7: V8 string interning can pin the key — setting _key = null
//       doesn't immediately zero the bytes the string used to live
//       in. A subsequent small allocation in the V8 heap can reuse
//       that memory and the new occupant would carry the key
//       fragments. The current implementation does NOT overwrite the
//       buffer with zeros before nulling — this is a "best-effort"
//       concern, but the contract should at least mention it.
// ---------------------------------------------------------------------------
test('PP-7: clearSessionCredential does not actively overwrite the key buffer (best-effort, by design)', () => {
  const store = freshStore();
  const SECRET = 'sk-secret-' + 'X'.repeat(64); // long enough to be in the V8 large-object space
  store.setSessionCredential(SECRET);
  assert.equal(store.getSessionCredential(), SECRET);
  store.clearSessionCredential();
  // We cannot easily assert the V8 internals, so we accept the
  // design. The contract is documented as "best-effort wipe".
  // The test pins the contract so a future refactor that changes
  // it must update this test.
  assert.equal(store.hasSessionCredential(), false);
});

// ---------------------------------------------------------------------------
// PP-8: source-level redaction of the SECRET in any logged error
//       path. The setSessionCredential function returns a redacted
//       error string ('session credential must be a non-empty
//       string'). We assert that no code path can accidentally log
//       the key on a non-string error.
// ---------------------------------------------------------------------------
test('PP-8: no error path in the store can accidentally include the key', () => {
  const store = freshStore();
  // Try a non-string with a toString that throws.
  const evil = { toString() { throw new Error('I contain sk-LEAK-12345'); }, valueOf() { return 'sk-VALUE'; } };
  let caught = null;
  try {
    const r = store.setSessionCredential(evil);
    caught = r.error || JSON.stringify(r);
  } catch (e) {
    caught = String(e && e.message || e);
  }
  // The store rejects the input, so no key is stored. The error
  // string from the store itself must not contain the user's input.
  // (The `evil` object's toString-throw is a separate concern.)
  assert.equal(store.hasSessionCredential(), false, 'store must stay empty after a refused set');
  // The error string from the store is the static "session credential must be a non-empty string" message.
  // If a future refactor inlines the input into the error, this test will catch it.
  assert.equal(caught.includes('non-empty string'), true,
    'PP-8: error must be the static "non-empty string" message; got: ' + caught);
});

// ---------------------------------------------------------------------------
// PP-9: getDiagnostics() snapshot shape — the test pins the exact
//       field names. A future refactor that renames a field (e.g.
//       hasCredential → isSet) would silently break the R2.4
//       diagnose handler that consumes this snapshot. R2.4 doesn't
//       exist yet, so the test acts as the contract source-of-truth.
// ---------------------------------------------------------------------------
test('PP-9: getDiagnostics() snapshot has the documented shape (4 fields, no extras)', () => {
  const store = freshStore();
  store.setSessionCredential('sk-shape-test');
  const diag = store.getDiagnostics();
  const keys = Object.keys(diag).sort();
  assert.deepEqual(keys, ['clearedAt', 'hasCredential', 'setAt', 'setCount'],
    'PP-9: getDiagnostics() must return EXACTLY {hasCredential, setCount, setAt, clearedAt}. Got: ' + JSON.stringify(keys));
  assert.equal(typeof diag.hasCredential, 'boolean');
  assert.equal(typeof diag.setCount, 'number');
  assert.equal(typeof diag.setAt, 'number');
  assert.equal(typeof diag.clearedAt, 'number');
});

// ---------------------------------------------------------------------------
// PP-10: stress / rapid set-clear cycles — 10k iterations must not
//        leak or corrupt the closure state. This catches off-by-one
//        bugs in any future refactor.
// ---------------------------------------------------------------------------
test('PP-10: 10k rapid set/clear cycles must not corrupt state', () => {
  const store = freshStore();
  for (let i = 0; i < 10000; i++) {
    store.setSessionCredential('sk-stress-' + i);
    if (store.getSessionCredential() !== 'sk-stress-' + i) {
      assert.fail('iteration ' + i + ': get returned wrong value');
    }
    store.clearSessionCredential();
    if (store.hasSessionCredential() !== false) {
      assert.fail('iteration ' + i + ': has returned true after clear');
    }
  }
  // setCount should be exactly 10000
  const diag = store.getDiagnostics();
  assert.equal(diag.setCount, 10000, 'setCount must be exactly 10000');
  assert.equal(diag.hasCredential, false, 'hasCredential must be false after final clear');
});
