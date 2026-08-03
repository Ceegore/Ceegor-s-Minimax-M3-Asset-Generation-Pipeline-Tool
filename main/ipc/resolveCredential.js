// main/ipc/resolveCredential.js
// ============================================================================
// R2.2 — single source of truth for the credential that `mmx:run` /
// `mmx:run:job` hands to `runMmx`. Extracted out of registerMmxIpc.js
// so the IPC registrar stays under its frozen 384-line SIZE-BUDGET.
//
// Contract (design contract §5 SYS-002, Soll):
//
//   • If the payload carries `rendererApiKey` (a non-empty string)
//     AND `sessionOnly: true`, the resolver uses the renderer-supplied
//     key for THIS call only and routes it through the session bootstrap
//     (never ~/.mmx/config.json). The persisted config.txt api_key
//     is irrelevant here; it stays empty for session-only users.
//
//   • If the payload carries `sessionOnly: true` but NO
//     rendererApiKey (or an empty one), the resolver returns
//     `{ apiKey: null, sessionOnly: true, error }` so the IPC
//     handler can fail closed. We do NOT silently fall back to the
//     empty cfg.api_key (that would be the legacy "No API key
//     configured" path that breaks session-only mode entirely).
//
//   • Otherwise (no sessionOnly in payload), the resolver reads
//     `cfg.api_key` and respects the persisted `apiKeyNoSave` toggle
//     via `_isSessionOnly()`. This preserves the pre-R2.2 behaviour
//     for non-session-only users.
//
//   • Any thrown cfgMod.read() (corrupt config, missing file) yields
//     `{ apiKey: null, sessionOnly: false, error }` so the IPC
//     handler can return a fail-closed envelope.
//
// The resolver never throws out. A caller forgetting to pass the key
// is a recoverable error, surfaced as `{ apiKey: null, error }`.
//
// The deps-injection parameter is optional. When `deps` is omitted
// (the normal call site in registerMmxIpc.js), the resolver reads
// `src/config` + `src/state` itself. When `deps` is provided (unit
// tests), the resolver uses the injected modules so a test can mock
// the persisted config without touching the real files.
// ============================================================================

function _isSessionOnlyFromState(stateMod) {
  try { return !!(stateMod && stateMod.read && stateMod.read().apiKeyNoSave); } catch (_) { return false; }
}

// Deps are re-required on EVERY call (cheap: require.cache hit) instead of
// memoized. Tests swap Module._load per scenario, and a module-level cache
// would pin the FIRST loaded config/state/session modules for the whole
// process, silently leaking stale mocks across scenarios.
function _loadDeps() {
  return {
    cfgMod: require('../../src/config'),
    stateMod: require('../../src/state'),
    sessionStore: require('../services/SessionCredentialStore'),
    credentialRepo: require('../services/CredentialRepository'),
  };
}

/**
 * @param {object} payload - The IPC payload (may be null for `mmx:run`,
 *                           which has no payload — only `mmx:run:job`
 *                           uses the sessionOnly / rendererApiKey fields).
 * @param {object} [deps]  - Optional `{ cfgMod, stateMod }` for tests.
 * @returns {{ apiKey: string|null, sessionOnly: boolean, error?: string }}
 */
function resolveCredential(payload, deps) {
  const _deps = deps || _loadDeps();
  const explicit = !!(payload && payload.sessionOnly === true);
  const rendererKey = (payload && typeof payload.rendererApiKey === 'string') ? payload.rendererApiKey.trim() : '';
  if (explicit) {
    if (!rendererKey) {
      return { apiKey: null, sessionOnly: true, error: 'mmx:run payload.sessionOnly=true requires payload.rendererApiKey (a non-empty string)' };
    }
    return { apiKey: rendererKey, sessionOnly: true };
  }
  try {
    const cfg = _deps.cfgMod.read();
    const persistedSessionOnly = _isSessionOnlyFromState(_deps.stateMod);
    const sessionKey = _deps.sessionStore && _deps.sessionStore.getSessionCredential
      ? _deps.sessionStore.getSessionCredential() : null;
    if (sessionKey) return { apiKey: sessionKey, sessionOnly: true };
    if (persistedSessionOnly) {
      return { apiKey: null, sessionOnly: true, error: 'No session API key configured. Re-enter it in Settings.' };
    }
    // B-002 fix: resolve through CredentialRepository (encrypted blob store)
    // instead of reading plaintext cfg.api_key directly. The repository
    // handles both the new credential_id path and legacy fallback.
    // Snapshot the legacy key BEFORE the migration attempt: migration
    // clears cfg.api_key in-memory before its config write commits, and a
    // config module returning a shared object would otherwise leave the
    // fallback below with an empty key after a failed migration.
    const legacyKey = cfg && typeof cfg.api_key === 'string' ? cfg.api_key : '';
    if (_deps.credentialRepo) {
      try {
        const resolved = _deps.credentialRepo.resolvePrimary();
        if (resolved.apiKey) return resolved;
      } catch (_) { /* fall through */ }
      // H-006 (hhhhu3 audit): migrate a legacy plaintext key ON DEMAND.
      // Startup migration (main/index.js) covers the normal boot; this
      // second chance covers setups where it was skipped or failed. After
      // a successful migration the key resolves from the encrypted store —
      // plaintext is never actively used while it can still be migrated.
      try {
        const migrated = _deps.credentialRepo.migrateLegacy();
        if (migrated && migrated.migrated) {
          const resolved = _deps.credentialRepo.resolvePrimary();
          if (resolved.apiKey) return resolved;
        }
      } catch (_) { /* fall through to legacy path */ }
    }
    // Last-resort legacy fallback (e.g. encrypted storage unavailable or
    // deps-injected tests without a repository). Migration failures keep
    // the user functional instead of stranding the key.
    return { apiKey: legacyKey || null, sessionOnly: false };
  } catch (_) {
    return { apiKey: null, sessionOnly: false, error: 'mmx: failed to read persisted config' };
  }
}

// Test hook kept for API compatibility; deps are no longer memoized, so there
// is nothing to reset.
function _resetForTest() {}

module.exports = { resolveCredential, _resetForTest };
