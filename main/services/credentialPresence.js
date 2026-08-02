// main/services/credentialPresence.js
// ============================================================================
// B-006 — ONE Main-side resolver for "does the user have a usable API key?".
//
// Before this fix, the public config DTOs (config:getPublic and the
// config:set response) computed `hasApiKey` ONLY from the persisted
// config.txt api_key. In "Don't save my API key" mode the key lives
// exclusively in the SessionCredentialStore, so every tab's
// `if (!state.config.hasApiKey) return;` guard blocked ALL generation
// even though a perfectly usable session key was present.
//
// Invariant (audit report B-006):
//   hasApiKey === hasPersistedCredential || hasSessionCredential
//
// Every DTO builder that reports key presence to the renderer MUST go
// through this resolver — no local re-derivations.
// ============================================================================
'use strict';

const sessionStore = require('./SessionCredentialStore');

/**
 * Resolve the credential-presence facts for a raw config object.
 * Returns presence booleans + the masked tail for display. NEVER the key.
 *
 * @param {object|null|undefined} cfg - raw config from cfgMod.read()
 * @returns {{hasApiKey: boolean, hasPersistedApiKey: boolean,
 *            hasSessionApiKey: boolean, apiKeyLast4: string}}
 */
function credentialPresence(cfg) {
  const key = (cfg && typeof cfg.api_key === 'string') ? cfg.api_key : '';
  let session = false;
  try { session = sessionStore.hasSessionCredential(); } catch (_) { /* fail closed to persisted-only */ }
  return {
    hasApiKey: key.length > 0 || session,
    hasPersistedApiKey: key.length > 0,
    hasSessionApiKey: session,
    // Only the persisted key has a displayable tail; the session key
    // never leaves Main in any form (not even 4 chars).
    apiKeyLast4: key.length >= 4 ? key.slice(-4) : '',
  };
}

module.exports = { credentialPresence };
