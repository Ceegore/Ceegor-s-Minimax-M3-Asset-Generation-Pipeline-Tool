// src/batches.js
// Per-tab batch storage for BatchGen. Lives in batches.json next to config.txt.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
// Bug-fix #6 (2026-06-19): route through configDir() so batches.json
// honours MINIMAX_CONFIG_DIR and the exe/cwd fallback chain the
// same way config.txt does. Previously batches.json always landed
// next to the exe, which split storage when a launcher set the
// override (config in one place, batches in another).
const { configDir } = require('./config');

// H9 Phase 1: versioned schema. The on-disk envelope carries a schemaVersion
// so future migrations can detect and upgrade old formats. Version 1 is the
// initial versioned format; version 0 (implicit) is the legacy bare-queues
// object ({ image: [], speech: [], ... }) without a wrapper.
const SCHEMA_VERSION = 1;

function batchesPath() {
  return path.join(configDir(), 'batches.json');
}

function defaultBatches() {
  return { image: [], speech: [], music: [], video: [] };
}

function normalize(raw) {
  const out = defaultBatches();
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(out)) {
    const v = raw[k];
    if (Array.isArray(v)) {
      // The renderer now stores two entry shapes per tab:
      //   1. Legacy: a non-empty trimmed string (the prompt itself).
      //   2. Snapshot: an object { prompt, settings, ts, label, upscale? }
      //      captured via the "+ Add" button next to Generate. These
      //      carry the per-entry form state so the BatchGen runner can
      //      re-apply the exact settings at run time.
      // We MUST preserve both shapes — silently dropping objects (the
      // old behaviour) meant a snapshot entry queued right before the
      // user closed the app would vanish on next launch, and they'd
      // have no idea why their batch was suddenly empty.
      out[k] = v
        .filter((e) => {
          if (typeof e === 'string') return e.trim().length > 0;
          if (e && typeof e === 'object' && typeof e.prompt === 'string' && e.prompt.trim().length > 0) return true;
          return false;
        })
        // Cap each string entry at 8000 chars and each object entry's
        // prompt at the same limit. Defends against a corrupted /
        // malicious batches.json that tries to inject a multi-MB
        // prompt into the CLI argv.
        .map((e) => {
          if (typeof e === 'string') return e.trim().slice(0, 8000);
          return Object.assign({}, e, { prompt: e.prompt.trim().slice(0, 8000) });
        })
        .slice(0, 100);
    }
  }
  return out;
}

// H-053: recovery latch. When batches.json cannot be interpreted (parse
// failure or a FUTURE schemaVersion we must not guess at), read() used to
// silently return empty defaults — and the next autosave would then WIPE
// every queue by overwriting the (still recoverable) file with `[]`s.
// Now the unreadable file is preserved as `batches.json.corrupt-<ts>` and
// write() refuses (coded error EBATCHRECOVERY) until the recovery has been
// explicitly acknowledged. The latch is NOT auto-cleared by a later
// successful read: the in-memory state was seeded with empty defaults, so
// unblocking writes silently would still wipe the (now fixed) file.
let _recovery = null; // { reason, backupPath, at, error }

function _enterRecovery(p, reason, err) {
  if (_recovery) return; // already latched — don't stack backups on every read
  let backupPath = null;
  try {
    backupPath = p + '.corrupt-' + Date.now();
    fs.copyFileSync(p, backupPath);
    console.error('[batches] unreadable (' + reason + '), backed up to', backupPath, err);
  } catch (_) {
    // Backup may fail (read-only fs) — the recovery path itself must not
    // crash; the write() block below still protects the original file.
    backupPath = null;
  }
  _recovery = { reason, backupPath, at: Date.now(), error: String((err && err.message) || err || '') };
}

function pendingRecovery() {
  return _recovery ? Object.assign({}, _recovery) : null;
}

function acknowledgeRecovery() {
  const had = !!_recovery;
  _recovery = null;
  return had;
}

function read() {
  const p = batchesPath();
  if (!fs.existsSync(p)) return defaultBatches();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    // H-053: a FUTURE schemaVersion is fail-closed — a newer app wrote this
    // file and we must not reinterpret (or later overwrite) it as v1.
    if (raw && typeof raw.schemaVersion === 'number' && raw.schemaVersion > SCHEMA_VERSION) {
      _enterRecovery(p, 'newer-schema', new Error('schemaVersion ' + raw.schemaVersion + ' > supported ' + SCHEMA_VERSION));
      return defaultBatches();
    }
    // H9 Phase 1: support both the legacy bare-queues format (no
    // schemaVersion) and the versioned envelope ({ schemaVersion, queues }).
    const queues = (raw && typeof raw.schemaVersion === 'number' && raw.queues)
      ? raw.queues
      : raw;
    return normalize(queues);
  } catch (e) {
    _enterRecovery(p, 'parse-failed', e);
    return defaultBatches();
  }
}

function write(batches) {
  // H-053: while an unacknowledged recovery is pending, ANY write would
  // clobber the user's only on-disk copy with empty defaults. Fail loudly.
  if (_recovery) {
    const err = new Error(
      'batches.json is in recovery (' + _recovery.reason + '); refusing to overwrite until the recovery is acknowledged.'
      + (_recovery.backupPath ? ' Backup: ' + _recovery.backupPath : ''));
    err.code = 'EBATCHRECOVERY';
    throw err;
  }
  const p = batchesPath();
  const clean = normalize(batches);
  // H9 Phase 1: write in the versioned envelope format. read() still
  // understands the legacy bare-queues format for backward compat.
  const envelope = { schemaVersion: SCHEMA_VERSION, queues: clean };
  // Atomic write: write to a temp file then rename. Avoids a corrupt
  // batches.json if the process is killed mid-write.
  const tmp = p + '.tmp-' + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  return clean;
}

module.exports = {
  read,
  write,
  batchesPath,
  defaultBatches,
  SCHEMA_VERSION,
  // H-053 recovery contract (consumed by registerBatchesIpc).
  pendingRecovery,
  acknowledgeRecovery,
};
