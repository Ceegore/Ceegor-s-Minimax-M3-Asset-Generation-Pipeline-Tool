// src/mmxApiKeySync.js
// Syncs the API key into mmx-cli's own ~/.mmx/config.json. The state
// variables (mtime, size, last hash) persist across runMmx() calls so a
// re-sync is skipped when the key is unchanged AND the config file hasn't
// been touched. Tracking mtime+size means an external `mmx config set` is
// detected even when the in-memory hash matches.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const crypto = require('crypto');

let _lastSyncedKeyHash = '';
let _lastSyncedConfigMtime = 0;
let _lastSyncedConfigSize = -1;

function _homeDir() {
  return process.env.USERPROFILE || process.env.HOME
    || (os.userInfo && os.userInfo().homedir);
}

function syncApiKeyToMmxCliConfig(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return false;
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  const home = _homeDir();
  if (!home) return false;
  const mmxDir = path.join(home, '.mmx');
  const mmxCfg = path.join(mmxDir, 'config.json');
  let needsVerify = hash !== _lastSyncedKeyHash;
  if (!needsVerify) {
    try {
      const st = fs.statSync(mmxCfg);
      if (st.mtimeMs !== _lastSyncedConfigMtime || st.size !== _lastSyncedConfigSize) {
        needsVerify = true;
      }
    } catch (_) {
      needsVerify = true;
    }
  }
  if (!needsVerify) return true;
  try {
    if (!fs.existsSync(mmxDir)) fs.mkdirSync(mmxDir, { recursive: true });
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(mmxCfg, 'utf8')); } catch (_) {}
    if (existing && typeof existing === 'object' && existing.api_key === apiKey) {
      _lastSyncedKeyHash = hash;
      try {
        const st = fs.statSync(mmxCfg);
        _lastSyncedConfigMtime = st.mtimeMs;
        _lastSyncedConfigSize = st.size;
      } catch (_) { /* file vanished */ }
      return true;
    }
    existing = (existing && typeof existing === 'object') ? existing : {};
    existing.api_key = apiKey;
    const tmp = mmxCfg + '.tmp-' + randomUUID();
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
    try { fs.chmodSync(tmp, 0o600); } catch (_) { /* Windows: noop */ }
    fs.renameSync(tmp, mmxCfg);
    _lastSyncedKeyHash = hash;
    try {
      const st = fs.statSync(mmxCfg);
      _lastSyncedConfigMtime = st.mtimeMs;
      _lastSyncedConfigSize = st.size;
    } catch (_) { /* give up */ }
    return true;
  } catch (_) {
    return false;
  }
}

// R2.3 — clear the persisted API key from `~/.mmx/config.json`. Used
// when the user toggles "Don't save" (apiKeyNoSave=true) so a
// previously-persisted key in mmx's own config does NOT survive the
// privacy switch.
//
// Contract (design contract §5 SYS-002, Soll):
//   • Atomically remove only the `api_key` field; preserve every
//     other field (region, model, custom_cli_args, …).
//   • If `~/.mmx/config.json` doesn't exist → no-op, return true.
//   • If the file exists but has no `api_key` field → no-op, return
//     true (the file is already in the desired state).
//   • If the file exists and has an `api_key` field → read it,
//     delete the field, atomic temp+rename write.
//   • Invalidate the in-memory cache (`_lastSyncedKeyHash`) so a
//     subsequent `syncApiKeyToMmxCliConfig(...)` call does NOT
//     no-op on the stale "this key was already synced" assumption.
//   • Never throw. Return true on success, false on any I/O error
//     (so the caller can surface a visible error to the user
//     instead of silently failing the privacy switch — see
//     design contract §14.3 R2.3: "Failure sichtbar und Privacywechsel
//     nicht fälschlich als erfolgreich markiert").
function clearApiKeyFromMmxCliConfig() {
  const home = _homeDir();
  if (!home) return false;
  const mmxDir = path.join(home, '.mmx');
  const mmxCfg = path.join(mmxDir, 'config.json');
  // No file → nothing to clear. Don't create an empty file just to
  // have an "official" cleared state; the user's HOME is left as-is.
  if (!fs.existsSync(mmxCfg)) {
    // Still invalidate the in-memory cache (e.g. if mmxApiKeySync
    // had a previously-synced key, a session-only user would still
    // be in the "key not persisted" state).
    _lastSyncedKeyHash = '';
    return true;
  }
  let existing;
  try {
    const raw = fs.readFileSync(mmxCfg, 'utf8');
    existing = JSON.parse(raw);
  } catch (_) {
    // Corrupt or unreadable config: return false so the caller can
    // surface an error. The user has a worse problem than session
    // privacy; they have a broken mmx config.
    return false;
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    // Non-object config (string, number, array, null). Same as
    // corrupt — surface the failure.
    return false;
  }
  // Already cleared? No-op.
  if (!Object.prototype.hasOwnProperty.call(existing, 'api_key')) {
    _lastSyncedKeyHash = '';
    return true;
  }
  // Atomically delete the field. We use a temp+rename so a crash
  // mid-write cannot leave a half-cleared config on disk.
  delete existing.api_key;
  const tmp = mmxCfg + '.tmp-' + randomUUID();
  try {
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
    try { fs.chmodSync(tmp, 0o600); } catch (_) { /* Windows: noop */ }
    fs.renameSync(tmp, mmxCfg);
  } catch (_) {
    // Best-effort cleanup of the temp file so a future retry
    // doesn't see a stale .tmp-… left over.
    try { fs.unlinkSync(tmp); } catch (__) {}
    return false;
  }
  // Invalidate the in-memory cache so a subsequent
  // syncApiKeyToMmxCliConfig() call doesn't no-op on the old
  // assumption. The next sync call will hash the new (empty)
  // config and find it stale → re-write.
  _lastSyncedKeyHash = '';
  try {
    const st = fs.statSync(mmxCfg);
    _lastSyncedConfigMtime = st.mtimeMs;
    _lastSyncedConfigSize = st.size;
  } catch (_) { /* file vanished between rename and stat — fine */ }
  return true;
}

// Test hook: clears the in-memory cache between tests so a previous
// test's HOME doesn't leak into the next.
function _resetForTest() {
  _lastSyncedKeyHash = '';
  _lastSyncedConfigMtime = 0;
  _lastSyncedConfigSize = -1;
}

module.exports = { syncApiKeyToMmxCliConfig, clearApiKeyFromMmxCliConfig, _resetForTest };

