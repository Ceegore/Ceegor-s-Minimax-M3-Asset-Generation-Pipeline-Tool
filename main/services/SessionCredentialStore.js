// main/services/SessionCredentialStore.js
// ============================================================================
// R2.1 — Session-only API-key storage (SYS-002, 360° audit design contract §5)
//
// Invariante:
//   • Wenn der Nutzer "Don't save" für den API-Key wählt, existiert der
//     Key NUR in diesem In-Memory-Store. Er wird NIEMALS persistiert
//     (config.txt bleibt mit api_key='' zurück) und NIEMALS an die
//     Renderer-Seite zurückgegeben.
//   • Der Store wird beim App-Quit / Window-Close defensiv gewipt,
//     sodass ein Process-Dump / Crash-Dump den Key nicht enthält.
//   • Die einzigen legitimen Konsumenten von getSessionCredential() sind
//     Main-seitige Resolver. Der Schlüssel bleibt bis zum App-Ende oder bis
//     zum Wechsel zurück in den persistenten Modus im Main-Speicher.
//
// IPC-Contract (S1 §3, by extension):
//   • Es gibt KEINEN IPC-Channel, der getSessionCredential() exponiert.
//     `preload.js` darf den Store nicht auf `window.api.*` mappen.
//   • Setter ist NICHT über IPC erreichbar: nur Main-Code (Resolver,
//     Lifecycle-Hooks) ruft setSessionCredential(). Der Renderer
//     liefert den Key im mmx:run:job-Payload (R2.2) und der Handler
//     ruft den Setter intern auf.
//
// Test-Hooks: `_resetForTest()` ist nur für unit-Tests; nicht über IPC.
// ============================================================================

let _key = null;
let _setAt = 0;
let _setCount = 0;
let _clearedAt = 0;

/**
 * Store a session-only credential in memory. Returns {ok:false, error:...}
 * for non-string or empty inputs (the store refuses to remember a useless
 * value — better to fail fast than to silently store a falsy placeholder).
 *
 * Side effects: increments _setCount, updates _setAt. Does NOT log the
 * key in any form (the only call sites are internal Main resolvers; the
 * error path returns a redacted error string).
 *
 * @param {string} key
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function setSessionCredential(key) {
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, error: 'session credential must be a non-empty string' };
  }
  _key = key;
  _setAt = Date.now();
  _setCount += 1;
  return { ok: true };
}

/**
 * Wipe the in-memory credential. Safe to call when no credential is set.
 * Idempotent. Updates _clearedAt for diagnostics.
 */
function clearSessionCredential() {
  _key = null;
  _clearedAt = Date.now();
}

/**
 * Returns true iff a session credential is currently held.
 * Renderer-safe (returns a boolean, not the key).
 *
 * @returns {boolean}
 */
function hasSessionCredential() {
  return _key !== null && _key.length > 0;
}

/**
 * INTERNAL — Main-side resolver only.
 *
 * Returns the held credential, or null. The caller is responsible for
 * Use the value only for a Main-owned API call. Never return it to renderer.
 *
 * This function is exported because the resolver lives in a different
 * module (`main/ipc/registerMmxIpc.js`, R2.2) and needs to read the
 * store. It must never be exposed through `window.api.*`.
 *
 * @returns {string|null}
 */
function getSessionCredential() {
  return _key;
}

/**
 * Read-only diagnostic snapshot. Returns metadata ONLY — never the
 * credential itself. Used by `mmx:diagnose` (R2.4) to confirm the
 * session-mode is active without leaking the key value.
 *
 * @returns {{hasCredential: boolean, setCount: number, setAt: number, clearedAt: number}}
 */
function getDiagnostics() {
  return {
    hasCredential: hasSessionCredential(),
    setCount: _setCount,
    setAt: _setAt,
    clearedAt: _clearedAt,
  };
}

/**
 * Test hook: wipe all in-memory state. Not exported through any IPC.
 * Use in `test.beforeEach` so a prior test's credential doesn't leak.
 */
function _resetForTest() {
  _key = null;
  _setAt = 0;
  _setCount = 0;
  _clearedAt = 0;
}

module.exports = {
  setSessionCredential,
  clearSessionCredential,
  hasSessionCredential,
  getSessionCredential,
  getDiagnostics,
  _resetForTest,
};
