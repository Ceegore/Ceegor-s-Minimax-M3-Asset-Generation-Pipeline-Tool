// main/services/SecretStore.js
// ============================================================================
// P1-F (360° Audit H-005, H-006, H-007, H-008, M-026): Secure secret storage.
//
// Secrets (API keys) are stored in the Windows Credential Manager via
// Electron's safeStorage API (which uses DPAPI on Windows). This means:
//   - Secrets are encrypted at rest with the user's Windows credentials
//   - config.txt / providers.json contain only credential_id references
//   - ~/.mmx/config.json uses a temp file with strict ACL, deleted after spawn
//   - The --api-key argv fallback is removed (fail closed instead)
//
// Usage:
//   const { storeSecret, getSecret, deleteSecret } = require('./SecretStore');
//   storeSecret('minimax-api-key', 'sk-...');
//   const key = getSecret('minimax-api-key'); // returns 'sk-...' or null
//   deleteSecret('minimax-api-key');
// ============================================================================
'use strict';

const { safeStorage, app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Directory for encrypted secret blobs (fallback when safeStorage unavailable). */
function _secretsDir() {
  return path.join(app.getPath('userData'), 'secrets');
}

/**
 * Check if secure storage is available.
 * @returns {boolean}
 */
function isSecureStorageAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

/**
 * Store a secret securely.
 * Uses Electron's safeStorage (DPAPI on Windows) to encrypt the value,
 * then writes the encrypted blob to a file in the userData/secrets/ directory.
 *
 * @param {string} key - Identifier for the secret (e.g. 'minimax-api-key').
 * @param {string} value - The secret value to store.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function storeSecret(key, value) {
  if (!key || typeof key !== 'string') return { ok: false, error: 'key required' };
  if (!value || typeof value !== 'string') return { ok: false, error: 'value required' };

  try {
    const dir = _secretsDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const filename = _keyToFilename(key);
    const filepath = path.join(dir, filename);

    let blob;
    if (isSecureStorageAvailable()) {
      // Encrypt with DPAPI (Windows) or Keychain (macOS)
      blob = safeStorage.encryptString(value);
    } else {
      // Fallback: XOR with a machine-derived key (NOT cryptographically secure,
      // but better than plaintext). This path should rarely be hit.
      const machineKey = _deriveMachineKey();
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', machineKey, iv);
      blob = Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final()]);
    }

    // Write with restrictive permissions
    fs.writeFileSync(filepath, blob, { mode: 0o600 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed to store secret: ${e.message}` };
  }
}

/**
 * Retrieve a stored secret.
 * @param {string} key - Identifier for the secret.
 * @returns {string|null} The decrypted value, or null if not found.
 */
function getSecret(key) {
  if (!key || typeof key !== 'string') return null;

  try {
    const filepath = path.join(_secretsDir(), _keyToFilename(key));
    if (!fs.existsSync(filepath)) return null;

    const blob = fs.readFileSync(filepath);

    if (isSecureStorageAvailable()) {
      return safeStorage.decryptString(blob);
    } else {
      // Fallback decryption
      const machineKey = _deriveMachineKey();
      const iv = blob.slice(0, 16);
      const encrypted = blob.slice(16);
      const decipher = crypto.createDecipheriv('aes-256-cbc', machineKey, iv);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    }
  } catch (_) {
    return null;
  }
}

/**
 * Delete a stored secret.
 * @param {string} key - Identifier for the secret.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function deleteSecret(key) {
  if (!key || typeof key !== 'string') return { ok: false, error: 'key required' };

  try {
    const filepath = path.join(_secretsDir(), _keyToFilename(key));
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed to delete secret: ${e.message}` };
  }
}

/**
 * Check if a secret exists (without decrypting it).
 * @param {string} key
 * @returns {boolean}
 */
function hasSecret(key) {
  if (!key || typeof key !== 'string') return false;
  try {
    return fs.existsSync(path.join(_secretsDir(), _keyToFilename(key)));
  } catch (_) {
    return false;
  }
}

/**
 * List all stored secret keys (identifiers only, not values).
 * @returns {string[]}
 */
function listSecretKeys() {
  try {
    const dir = _secretsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.secret'))
      .map((f) => f.replace('.secret', ''));
  } catch (_) {
    return [];
  }
}

/**
 * Convert a key identifier to a safe filename.
 * @param {string} key
 * @returns {string}
 */
function _keyToFilename(key) {
  // Sanitize: only allow alphanumeric, hyphen, underscore
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe + '.secret';
}

/**
 * Derive a machine-specific key for the fallback encryption path.
 * NOT cryptographically secure — just obfuscation for the rare case
 * where DPAPI/Keychain is unavailable.
 * @returns {Buffer} 32-byte key
 */
function _deriveMachineKey() {
  const material = [
    process.env.COMPUTERNAME || '',
    process.env.USERNAME || '',
    process.env.USERPROFILE || '',
    'minimax-asset-tool-fallback',
  ].join('|');
  return crypto.createHash('sha256').update(material).digest();
}

module.exports = {
  storeSecret,
  getSecret,
  deleteSecret,
  hasSecret,
  listSecretKeys,
  isSecureStorageAvailable,
};
