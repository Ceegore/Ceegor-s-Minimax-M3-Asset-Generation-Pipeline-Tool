'use strict';

/**
 * Provider Credential Repository — transactional credential management
 * for "Other APIs" providers (OpenRouter, Replicate, custom).
 *
 * AUD-002 fix: Provider credential lifecycle was broken — keys were stored
 * in plaintext in providers.json, reads mutated state, and there was no
 * atomic replace/clear/migrate path.
 *
 * This repository:
 * - Stores provider API keys as immutable encrypted blobs via SecretBlobStore
 * - providers.json holds only credential_id references, never raw keys
 * - Provides typed read/replace/clear operations with crash-safe ordering
 * - Returns secret-free DTOs for renderer consumption
 */

const fs = require('fs');
const path = require('path');
const { CODES, AppError } = require('../errors/AppError');

class ProviderCredentialRepository {
  /**
   * @param {{
   *   blobStore: object,       // SecretBlobStore instance
   *   providersPath: string,   // Path to providers.json
   * }} opts
   */
  constructor({ blobStore, providersPath }) {
    if (!blobStore) throw new TypeError('blobStore is required');
    if (!providersPath) throw new TypeError('providersPath is required');
    this.blobStore = blobStore;
    this.providersPath = providersPath;
    // M-006 (hhhhu2 audit): in-memory map for session-only keys.
    // Session keys are never persisted to disk; they live here until
    // the process exits or the key is explicitly cleared/replaced.
    /** @type {Map<string, string>} providerId -> apiKey */
    this._sessionKeys = new Map();
  }

  /**
   * Read the providers store (metadata only, no secrets).
   * @returns {object} Parsed providers.json
   */
  _readStore() {
    try {
      return JSON.parse(fs.readFileSync(this.providersPath, 'utf8'));
    } catch (_) {
      return { providers: [], selections: {} };
    }
  }

  /**
   * Write the providers store atomically.
   * @param {object} data
   */
  _writeStore(data) {
    const json = JSON.stringify(data, null, 2);
    const tmp = this.providersPath + '.tmp';
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.renameSync(tmp, this.providersPath);
  }

  /**
   * Get a secret-free public DTO for all providers.
   * @returns {Array<{id: string, label: string, kind: string, baseUrl: string, hasKey: boolean, credentialState: string}>}
   */
  getPublic() {
    const store = this._readStore();
    return (store.providers || []).map((p) => {
      let credentialState = 'none';
      if (p.credential_id) {
        try {
          credentialState = this.blobStore.exists(p.credential_id) ? 'persisted' : 'corrupt';
        } catch (_) {
          credentialState = 'corrupt';
        }
      } else if (this._sessionKeys.has(p.id)) {
        // M-007 (hhhhu2 audit): check the in-memory session map, not a
        // field on the disk object that was never persisted.
        credentialState = 'session';
      }
      return {
        id: p.id,
        label: p.label || p.id,
        kind: p.kind || '',
        baseUrl: p.baseUrl || '',
        hasKey: credentialState !== 'none',
        credentialState,
      };
    });
  }

  /**
   * Resolve the API key for a provider (for internal Main use only).
   * Never returns the key to the renderer.
   * @param {string} providerId
   * @returns {string|null} The decrypted API key or null
   */
  resolveKey(providerId) {
    const store = this._readStore();
    const provider = (store.providers || []).find((p) => p.id === providerId);
    if (!provider) return null;

    // Try persisted credential
    if (provider.credential_id) {
      try {
        const { value } = this.blobStore.read(provider.credential_id);
        return value;
      } catch (e) {
        if (e.code === CODES.SECRET_NOT_FOUND || e.code === CODES.SECRET_CORRUPT) {
          return null;
        }
        throw e;
      }
    }

    // M-006 (hhhhu2 audit): resolve session-only key from the in-memory map.
    if (this._sessionKeys.has(providerId)) return this._sessionKeys.get(providerId);
    return null;
  }

  /**
   * Replace the persisted API key for a provider.
   * Crash-safe: write new blob first, then swap reference, then clean old.
   * @param {string} providerId
   * @param {string} apiKey
   */
  replacePersisted(providerId, apiKey) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new AppError(CODES.INVALID_ARGUMENT, 'API key is required.');
    }

    const store = this._readStore();
    const provider = (store.providers || []).find((p) => p.id === providerId);
    if (!provider) {
      throw new AppError(CODES.INVALID_ARGUMENT, `Provider "${providerId}" not found.`);
    }

    // Step 1: Write new blob
    const { id: newId } = this.blobStore.writeNew(`provider-${providerId}`, apiKey);

    // Step 2: Swap reference in store
    const oldId = provider.credential_id || null;
    provider.credential_id = newId;
    delete provider.apiKey; // Remove any legacy plaintext
    delete provider._sessionKey;
    this._writeStore(store);

    // Step 3: Clean old blob (best-effort, non-blocking)
    if (oldId && oldId !== newId) {
      try { this.blobStore.remove(oldId); } catch (_) {}
    }
  }

  /**
   * Use a session-only key (not persisted to disk).
   * M-006 (hhhhu2 audit): stores the key in the repository-owned in-memory
   * map so that resolveKey() can find it on subsequent calls.
   * @param {string} providerId
   * @param {string} apiKey
   */
  useSessionOnly(providerId, apiKey) {
    const store = this._readStore();
    const provider = (store.providers || []).find((p) => p.id === providerId);
    if (!provider) {
      throw new AppError(CODES.INVALID_ARGUMENT, `Provider "${providerId}" not found.`);
    }
    // Store in the in-memory session map (never written to disk).
    this._sessionKeys.set(providerId, apiKey);
    // Remove any persisted credential reference — session mode replaces it.
    if (provider.credential_id) {
      const oldId = provider.credential_id;
      delete provider.credential_id;
      delete provider.apiKey;
      this._writeStore(store);
      try { this.blobStore.remove(oldId); } catch (_) {}
    }
  }

  /**
   * Clear the API key for a provider (both persisted and session).
   * @param {string} providerId
   */
  clear(providerId) {
    const store = this._readStore();
    const provider = (store.providers || []).find((p) => p.id === providerId);
    if (!provider) return;

    const oldId = provider.credential_id || null;
    delete provider.credential_id;
    delete provider.apiKey;
    delete provider._sessionKey;
    this._writeStore(store);

    // M-006: also clear the in-memory session key.
    this._sessionKeys.delete(providerId);

    // Clean old blob
    if (oldId) {
      try { this.blobStore.remove(oldId); } catch (_) {}
    }
  }

  /**
   * Migrate legacy plaintext apiKey fields to encrypted blobs.
   * Called once during startup or on first access.
   * @returns {{ migrated: number, failed: number }}
   */
  migrateLegacy() {
    const store = this._readStore();
    let migrated = 0;
    let failed = 0;
    let dirty = false;

    for (const provider of (store.providers || [])) {
      if (provider.apiKey && typeof provider.apiKey === 'string' && provider.apiKey.length > 0) {
        try {
          const { id: blobId } = this.blobStore.writeNew(`provider-${provider.id}`, provider.apiKey);
          provider.credential_id = blobId;
          delete provider.apiKey;
          dirty = true;
          migrated++;
        } catch (_) {
          failed++;
        }
      }
    }

    if (dirty) this._writeStore(store);
    return { migrated, failed };
  }
}

module.exports = { ProviderCredentialRepository };
