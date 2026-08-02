'use strict';

/**
 * Transactional credential repository for the primary MiniMax API key.
 * 
 * AUD-001 fix: Store the primary key through SecretBlobStore, persist only
 * a random credential identifier in config.txt, and do not permanently
 * synchronize the key into .mmx/config.json.
 * 
 * Implementation note: after the reference commits, legacy cleanup failure
 * returns cleanupPending:true rather than throwing a generic failed replacement.
 * The UI must show "new key active; cleanup required" and must not retry
 * replacement, which would create unnecessary new blobs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const cfgMod = require('../../src/config');
const blobs = require('./SecretBlobStore');
const session = require('./SessionCredentialStore');
const { clearApiKeyFromMmxCliConfig } = require('../../src/mmxApiKeySync');
const { CODES, AppError } = require('../errors/AppError');

/**
 * Get the directory for the credential cleanup queue.
 * @returns {string}
 */
function cleanupQueueDir() {
  return path.join(app.getPath('userData'), 'credential-cleanup-v1');
}

/**
 * Queue a secret ID for deferred cleanup.
 * @param {string} id - Secret ID to queue
 */
function queueCleanup(id) {
  if (!id) return;
  const dir = cleanupQueueDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const digest = crypto.createHash('sha256').update(id).digest('hex');
  const target = path.join(dir, digest + '.json');
  try {
    fs.writeFileSync(target, JSON.stringify({
      schemaVersion: 1,
      id,
      notBefore: Date.now() + 24 * 60 * 60 * 1000, // 24-hour grace period
      createdAt: Date.now(),
    }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
}

/**
 * Get the persisted credential reference from config.
 * @returns {string} The credential ID or empty string
 */
function persistedReference() {
  const cfg = cfgMod.read();
  return typeof cfg.api_credential_id === 'string' ? cfg.api_credential_id : '';
}

/**
 * Resolve the primary API key from session or persisted storage.
 * @returns {{apiKey: string|null, sessionOnly: boolean}}
 */
function resolvePrimary() {
  const sessionValue = session.getSessionCredential();
  if (sessionValue) return { apiKey: sessionValue, sessionOnly: true };
  const id = persistedReference();
  if (!id) return { apiKey: null, sessionOnly: false };
  return { apiKey: blobs.read(id).value, sessionOnly: false };
}

/**
 * Replace the persisted credential with a new value.
 * @param {string} value - The new API key
 * @returns {{hasApiKey: true, persisted: true, cleanupPending: boolean}}
 * @throws {AppError} On failure
 */
function replacePersisted(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(CODES.INVALID_ARGUMENT, 'API key is required.');
  }
  const oldId = persistedReference();
  const { id: newId } = blobs.writeNew('minimax-primary', value.trim());
  const cfg = cfgMod.read();
  cfg.api_key = ''; // tolerated only in-memory during migration
  cfg.api_credential_id = newId;
  try {
    cfgMod.write(cfg); // atomic reference swap
  } catch (error) {
    try { blobs.remove(newId); } catch (_) {}
    throw error;
  }

  session.clearSessionCredential();
  // M-008 (hhhhu2 audit): separate transaction success from cleanup status.
  // Cleanup failures must never convert a committed replacement into a
  // generic failure. Wrap all cleanup in try/catch and report via
  // cleanupPending.
  let cleanupPending = false;
  if (oldId && oldId !== newId) {
    try { blobs.remove(oldId); } catch (_) { queueCleanup(oldId); cleanupPending = true; }
  }
  if (clearApiKeyFromMmxCliConfig() !== true) cleanupPending = true;
  return { hasApiKey: true, persisted: true, cleanupPending };
}

/**
 * Switch to session-only mode with a new value.
 * @param {string} value - The API key
 * @returns {{hasApiKey: true, persisted: false, cleanupPending: boolean}}
 * @throws {AppError} On failure
 */
function useSessionOnly(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(CODES.INVALID_ARGUMENT, 'API key is required.');
  }
  const oldId = persistedReference();
  session.setSessionCredential(value.trim());
  const cfg = cfgMod.read();
  cfg.api_key = '';
  cfg.api_credential_id = '';
  try {
    cfgMod.write(cfg); // persisted reference is removed before old blob cleanup
  } catch (error) {
    session.clearSessionCredential();
    throw error;
  }
  let cleanupPending = false;
  if (oldId) {
    // M-008/M-009 (hhhhu2 audit): cleanup failures are reported via
    // cleanupPending, never thrown. Deferred blob cleanup is included.
    try { blobs.remove(oldId); } catch (_) { queueCleanup(oldId); cleanupPending = true; }
  }
  if (clearApiKeyFromMmxCliConfig() !== true) cleanupPending = true;
  return { hasApiKey: true, persisted: false, cleanupPending };
}

/**
 * Clear all credential references.
 * @returns {{hasApiKey: false, cleanupPending: boolean}}
 */
function clearPrimary() {
  const oldId = persistedReference();
  const cfg = cfgMod.read();
  cfg.api_key = '';
  cfg.api_credential_id = '';
  cfgMod.write(cfg); // stop all future resolution first
  session.clearSessionCredential();

  let cleanupPending = false;
  if (oldId) {
    try { blobs.remove(oldId); } catch (_) { queueCleanup(oldId); cleanupPending = true; }
  }
  if (clearApiKeyFromMmxCliConfig() !== true) cleanupPending = true;
  return { hasApiKey: false, cleanupPending };
}

/**
 * Migrate a legacy plaintext api_key from config to secure storage.
 * @returns {{migrated: boolean, hasApiKey?: boolean, persisted?: boolean, cleanupPending?: boolean}}
 * @throws {AppError} If both legacy and secure fields are present
 */
function migrateLegacy() {
  const cfg = cfgMod.read();
  const legacy = typeof cfg.api_key === 'string' ? cfg.api_key.trim() : '';
  if (!legacy) return { migrated: false };
  if (cfg.api_credential_id) {
    throw new AppError(CODES.CREDENTIAL_MIGRATION_INCOMPLETE, 'Both legacy and secure credential fields are present.');
  }
  const result = replacePersisted(legacy);
  return { migrated: true, ...result };
}

module.exports = {
  resolvePrimary,
  replacePersisted,
  useSessionOnly,
  clearPrimary,
  migrateLegacy,
  queueCleanup,
};
