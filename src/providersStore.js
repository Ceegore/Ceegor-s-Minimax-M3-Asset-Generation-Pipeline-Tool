// src/providersStore.js
// ============================================================================
// Config store for the "Other APIs" tab (non-MiniMax providers).
// Lives in a SEPARATE providers.json next to config.txt — the existing
// config.txt parser (src/config.js) is never touched.
//
// Shape:
//   { providers: [{id, label, kind, baseUrl, apiKey}],
//     selections: { image: {providerId, model}, speech: {...}, ... } }
//
// L-003 (hhhhu3 audit): ONE canonical credential schema for this store.
//   • `credential_id`  — the ONLY persisted credential reference field
//     (points at an encrypted SecretBlobStore blob; owned by
//     ProviderCredentialRepository).
//   • `apiKey`         — legacy plaintext; tolerated ONLY when no
//     credential repository is registered (tests / dev without Main).
//     Never persisted once the repository is active (see write()).
//   • `credentialId` / `_sessionKey` — deprecated variants; normalized
//     or stripped on write. No new code may read them.
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { configDir } = require('./config');   // reuse the SAME dir resolver (call-only)

function file() { return path.join(configDir(), 'providers.json'); }

// H-024 (_5 audit): SecretStore integration via registration (avoids cross-tier
// import). The main process calls registerSecretStore() at startup to inject
// the SecretStore dependency. Without it, keys stay plaintext (tests, dev).
let _secretStore = null;
function registerSecretStore(store) { _secretStore = store; }
function _getSecretStore() { return _secretStore; }

// B-003 fix: ProviderCredentialRepository integration. When registered,
// all key resolution goes through the encrypted blob store instead of
// the legacy SecretStore or plaintext fields.
let _credentialRepo = null;
function registerCredentialRepository(repo) { _credentialRepo = repo; }
function _getCredentialRepo() { return _credentialRepo; }

/** Credential ID for a provider's API key in the SecretStore. */
function _credId(providerId) { return 'provider-' + providerId + '-apikey'; }

// B-004: built-in provider origins are IMMUTABLE. A tampered providers.json
// (or a compromised renderer via providers:set) must never be able to point
// the openrouter/replicate entries — and therefore their Bearer API keys —
// at an attacker-controlled origin. The pin is enforced at read time so it
// holds even against direct on-disk edits. '' means "adapter hardcodes the
// host" (replicate.js pins https://api.replicate.com/v1 itself).
const BUILTIN_ORIGINS = Object.freeze({
  openrouter: { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
  replicate:  { kind: 'replicate',  baseUrl: '' },
});

// RR2-C003 (recheck-2): KIND binding for ALL built-ins. `kind` is the
// adapter selector — a hand-edited providers.json must never be able to
// re-kind a built-in entry (e.g. turning custom-openai into a smuggled
// 'openrouter'-kind provider that bypasses the origin blocks). Unlike
// BUILTIN_ORIGINS this pins ONLY the kind: custom-openai's baseUrl stays
// user-settable (gated by the customProviderUrlsEnabled feature flag).
const BUILTIN_KINDS = Object.freeze({
  openrouter: 'openrouter',
  replicate: 'replicate',
  'custom-openai': 'custom-openai',
});

function _pinBuiltins(d) {
  if (!d || !Array.isArray(d.providers)) return d;
  for (const p of d.providers) {
    if (!p) continue;
    // RR2-C003: re-kind every built-in id back to its bound kind.
    if (BUILTIN_KINDS[p.id]) p.kind = BUILTIN_KINDS[p.id];
    const pin = BUILTIN_ORIGINS[p.id];
    if (!pin) continue;
    p.kind = pin.kind;
    p.baseUrl = pin.baseUrl;
  }
  return d;
}

function _default() {
  return {
    providers: [
      { id: 'openrouter',    label: 'OpenRouter',             kind: 'openrouter',    baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' },
      { id: 'replicate',     label: 'Replicate',              kind: 'replicate',     baseUrl: '',                              apiKey: '' },
      { id: 'custom-openai', label: 'Custom (OpenAI-compat)', kind: 'custom-openai', baseUrl: '',                              apiKey: '' },
    ],
    selections: {
      image:  { providerId: 'openrouter', model: '' },
      speech: { providerId: 'openrouter', model: '', voice: 'alloy', format: 'mp3' },
      music:  { providerId: 'replicate',  model: '' },
      video:  { providerId: 'openrouter', model: '' },
    },
  };
}

function read() {
  // B-004: pin built-in origins on every read — a hand-edited providers.json
  // cannot redirect openrouter/replicate traffic.
  let d;
  try { d = _pinBuiltins(JSON.parse(fs.readFileSync(file(), 'utf8'))); }
  catch (err) {
    // H-036 (_5 audit): a corrupt providers.json must NOT be silently
    // replaced with defaults. Back up the original so the user can recover.
    const p = file();
    try {
      if (fs.existsSync(p)) {
        const backup = p + '.corrupt-' + Date.now();
        fs.copyFileSync(p, backup);
        try { console.error('[providersStore] corrupt providers.json backed up to: ' + backup); } catch (_) {}
      }
    } catch (_) { /* backup failure must not crash the app */ }
    return _default();
  }
  // H-024: one-time migration of plaintext keys to SecretStore.
  _migrateKeys(d);
  return d;
}

/**
 * H-024: migrate plaintext apiKey fields to SecretStore.
 * Atomic per-provider: store → verify → clear JSON field.
 * If SecretStore is unavailable or migration fails, the plaintext key stays.
 * @param {object} d - parsed providers data (mutated in place)
 */
let _migrated = false;
function _migrateKeys(d) {
  if (_migrated) return;
  _migrated = true;
  const store = _getSecretStore();
  if (!store) return; // SecretStore unavailable — keep plaintext
  if (!d || !Array.isArray(d.providers)) return;
  let changed = false;
  for (const p of d.providers) {
    if (!p.apiKey || p.credentialId) continue; // already migrated or no key
    const credId = _credId(p.id);
    const res = store.storeSecret(credId, p.apiKey);
    if (!res.ok) continue; // store failed — keep plaintext
    // Verify read-back before clearing the plaintext.
    const verify = store.getSecret(credId);
    if (verify !== p.apiKey) {
      store.deleteSecret(credId); // roll back
      continue;
    }
    p.credentialId = credId;
    p.apiKey = '';
    changed = true;
  }
  if (changed) {
    // Persist the migrated JSON atomically.
    const p = file();
    const tmp = p + '.tmp-' + randomUUID();
    try {
      fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
      fs.renameSync(tmp, p);
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }
}

function write(d) {
  // V104-H004: defense-in-depth store guard. Even if a future caller skips
  // the providersPayloadSchema gate, a destructive full replacement (empty/
  // missing provider array, dropped built-ins) is refused HERE — throwing
  // before any tmp file is created keeps the persisted store untouched.
  const guard = require('./providersPayloadSchema').validateProvidersSetPayload(d);
  if (!guard.ok) throw new Error('providersStore.write rejected: ' + guard.error);
  // SEC-002: merge API keys from existing config when the incoming
  // payload omits them (renderer sends partial updates without raw keys).
  // B-006 (hhhhu3 audit): when the encrypted credential repository is
  // registered it OWNS all keys — merging raw apiKey from the old file
  // would resurrect plaintext the repository already migrated away.
  const repoActive = !!_getCredentialRepo();
  const existing = read();
  const existingById = new Map(((existing && existing.providers) || [])
    .filter((x) => x && x.id).map((x) => [x.id, x]));
  if (!repoActive && d && Array.isArray(d.providers)) {
    for (const p of d.providers) {
      if (!p.apiKey && p.id) {
        const prev = existingById.get(p.id);
        if (prev && prev.apiKey) p.apiKey = prev.apiKey;
      }
    }
  }
  // RQ-003 fix: with the encrypted credential repository active,
  // credential references are SERVER-OWNED. The renderer's secret-free
  // payload never carries `credential_id`, so a metadata write must
  // PRESERVE the on-disk reference per provider ("empty key = keep
  // existing") instead of replacing it away — the old full-replace
  // dropped the reference and orphaned the encrypted blob. Incoming
  // references are never trusted: they are stripped and re-merged from
  // the persisted store, keyed by provider id.
  if (repoActive && d && Array.isArray(d.providers)) {
    for (const p of d.providers) {
      delete p.credential_id;
      delete p.credentialId;
      const prev = p.id ? existingById.get(p.id) : undefined;
      if (prev && prev.credential_id) p.credential_id = prev.credential_id;
    }
  }
  // M-010 (hhhhu2 audit): normalize credential references. The canonical
  // field is `credential_id` (used by ProviderCredentialRepository).
  // Legacy `credentialId` is migrated on write. `_sessionKey` and raw
  // `apiKey` are stripped — they must never be persisted.
  if (d && Array.isArray(d.providers)) {
    for (const p of d.providers) {
      if (p.credentialId && !p.credential_id) {
        p.credential_id = p.credentialId;
      }
      delete p.credentialId;
      delete p._sessionKey;
      // B-006 (hhhhu3 audit): with the repository active, raw key fields
      // are REJECTED from the metadata store outright — key changes flow
      // exclusively through the typed repository actions (providers:set
      // routes them before this write). Without a repository (tests/dev)
      // the legacy plaintext path stays functional.
      if (repoActive) delete p.apiKey;
      else if (p.credential_id) p.apiKey = '';
    }
  }
  // B-004: normalize built-in origins before persisting so the file on
  // disk never carries a diverged openrouter/replicate baseUrl or kind.
  _pinBuiltins(d);
  const p = file();
  const tmp = p + '.tmp-' + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, p);
}

function provider(id) {
  const d = read();
  const p = (d.providers || []).find((x) => x.id === id);
  if (!p) throw new Error('unknown provider ' + id);
  // B-003 fix: resolve apiKey through ProviderCredentialRepository first.
  const repo = _getCredentialRepo();
  if (repo) {
    try {
      const key = repo.resolveKey(id);
      if (key) { p.apiKey = key; return p; }
    } catch (_) { /* fall through to legacy */ }
  }
  // H-024: resolve apiKey from SecretStore when credentialId is present.
  if (p.credentialId && !p.apiKey) {
    const store = _getSecretStore();
    if (store) {
      const key = store.getSecret(p.credentialId);
      if (key) p.apiKey = key;
    }
  }
  return p;
}

// H-023 (_5 audit): explicit API key deletion. An empty field in the UI
// means "keep existing" (to prevent accidental loss). Deleting requires
// a deliberate, separate action that bypasses the write() merge logic.
function clearApiKey(id) {
  // B-003 fix: clear through ProviderCredentialRepository when available.
  const repo = _getCredentialRepo();
  if (repo) {
    try { repo.clear(id); } catch (_) {}
  }
  const d = read();
  const p = (d.providers || []).find((x) => x.id === id);
  if (!p) throw new Error('unknown provider ' + id);
  // M-010 (hhhhu2 audit): remove ALL credential reference fields so
  // "clear key" cannot leave a resolvable reference behind.
  p.apiKey = '';
  delete p.credentialId;
  delete p.credential_id;
  delete p._sessionKey;
  // Write with a flag that tells write() NOT to merge the old key back.
  const tmp = file() + '.tmp-' + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, file());
  return { ok: true, providerId: id };
}

module.exports = { read, write, provider, clearApiKey, file, _default, BUILTIN_ORIGINS, BUILTIN_KINDS, _pinBuiltins, registerSecretStore, _getSecretStore, _credId, _migrateKeys, registerCredentialRepository, _getCredentialRepo };
