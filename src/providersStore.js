// src/providersStore.js
// ============================================================================
// Config store for the "Other APIs" tab (non-MiniMax providers).
// Lives in a SEPARATE providers.json next to config.txt — the existing
// config.txt parser (src/config.js) is never touched.
//
// Shape:
//   { providers: [{id, label, kind, baseUrl, apiKey}],
//     selections: { image: {providerId, model}, speech: {...}, ... } }
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

function _pinBuiltins(d) {
  if (!d || !Array.isArray(d.providers)) return d;
  for (const p of d.providers) {
    const pin = p && BUILTIN_ORIGINS[p.id];
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
  // SEC-002: merge API keys from existing config when the incoming
  // payload omits them (renderer sends partial updates without raw keys).
  const existing = read();
  if (d && Array.isArray(d.providers) && Array.isArray(existing.providers)) {
    for (const p of d.providers) {
      if (!p.apiKey && p.id) {
        const prev = existing.providers.find((x) => x.id === p.id);
        if (prev && prev.apiKey) p.apiKey = prev.apiKey;
      }
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
      // Raw apiKey is only tolerated during migration; the encrypted
      // blob store is the canonical source. Clear it if credential_id exists.
      if (p.credential_id) p.apiKey = '';
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

module.exports = { read, write, provider, clearApiKey, file, _default, BUILTIN_ORIGINS, registerSecretStore, _getSecretStore, _credId, _migrateKeys, registerCredentialRepository, _getCredentialRepo };
