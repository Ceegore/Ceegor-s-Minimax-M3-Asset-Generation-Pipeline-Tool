// src/providersPayloadSchema.js
// ============================================================================
// V104-H004 (release requalification 1.0.4): STRICT payload schema for
// `providers:set`. The old handler accepted ANY shape — an empty or
// duplicate-id payload could wipe the provider store, and a malformed
// full replacement could orphan credential blobs. Every full-replacement
// payload must now pass this validator BEFORE any store write or key
// operation happens (atomic rejection: nothing is committed on failure).
//
// Rules:
//   • payload must be a plain object
//   • `providers` must be a NON-EMPTY array of entries
//   • every entry: plain object, unique string id (bounded charset/length),
//     optional typed label/kind/baseUrl/apiKey/keyAction fields
//   • ALL built-in providers (BUILTIN_PROVIDER_IDS) must be present —
//     a "full replacement" that drops a built-in would wipe its persisted
//     credential reference and orphan its encrypted blob
//   • `selections` (when present) must be a plain object whose entries
//     carry a string providerId and string metadata fields
//
// Pure validator: returns { ok: true } or { ok: false, error }. No IO,
// no electron — safe to unit-test and reuse from the store's own guard.
// ============================================================================
'use strict';

// Kept in sync with src/providersStore.BUILTIN_ORIGINS + the custom-openai
// default. Declared here (not imported) to keep this module dependency-free.
const BUILTIN_PROVIDER_IDS = Object.freeze(['openrouter', 'replicate', 'custom-openai']);

const MAX_PROVIDERS = 64;
const MAX_ID_LEN = 64;
const MAX_LABEL_LEN = 128;
const MAX_URL_LEN = 2048;
const MAX_KEY_LEN = 4096;
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const KEY_ACTIONS = ['keep', 'replace', 'session', 'clear'];

function fail(error) { return { ok: false, error }; }

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function checkEntry(p, idx, seenIds) {
  const where = 'providers[' + idx + ']';
  if (!isPlainObject(p)) return fail(where + ' must be an object.');
  if (typeof p.id !== 'string' || !p.id.trim()) {
    return fail(where + ' must have a non-empty string "id".');
  }
  if (p.id.length > MAX_ID_LEN) return fail(where + ': "id" exceeds ' + MAX_ID_LEN + ' characters.');
  if (!ID_RE.test(p.id)) {
    return fail(where + ': "id" may only contain letters, digits, "-" and "_".');
  }
  if (seenIds.has(p.id)) return fail('Duplicate provider id "' + p.id + '".');
  seenIds.add(p.id);
  if (p.label !== undefined && (typeof p.label !== 'string' || p.label.length > MAX_LABEL_LEN)) {
    return fail('Provider "' + p.id + '": "label" must be a string of at most ' + MAX_LABEL_LEN + ' characters.');
  }
  if (p.kind !== undefined && typeof p.kind !== 'string') {
    return fail('Provider "' + p.id + '": "kind" must be a string.');
  }
  if (p.baseUrl !== undefined && (typeof p.baseUrl !== 'string' || p.baseUrl.length > MAX_URL_LEN)) {
    return fail('Provider "' + p.id + '": "baseUrl" must be a string of at most ' + MAX_URL_LEN + ' characters.');
  }
  if (p.apiKey !== undefined && (typeof p.apiKey !== 'string' || p.apiKey.length > MAX_KEY_LEN)) {
    return fail('Provider "' + p.id + '": "apiKey" must be a string of at most ' + MAX_KEY_LEN + ' characters.');
  }
  if (p.keyAction !== undefined && !KEY_ACTIONS.includes(p.keyAction)) {
    return fail('Provider "' + p.id + '": keyAction must be one of ' + KEY_ACTIONS.join(', ') + '.');
  }
  return null;
}

function checkSelection(name, sel, providerIds) {
  if (!isPlainObject(sel)) return fail('selections.' + name + ' must be an object.');
  if (typeof sel.providerId !== 'string' || !sel.providerId.trim()) {
    return fail('selections.' + name + ' must have a non-empty string "providerId".');
  }
  if (!providerIds.has(sel.providerId)) {
    return fail('selections.' + name + ' references unknown provider "' + sel.providerId + '".');
  }
  for (const field of ['model', 'voice', 'format', 'prompt']) {
    if (sel[field] !== undefined && typeof sel[field] !== 'string') {
      return fail('selections.' + name + '."' + field + '" must be a string.');
    }
  }
  return null;
}

/**
 * Strict validation of a full `providers:set` replacement payload.
 * @param {*} data - raw IPC payload
 * @returns {{ ok: boolean, error?: string }}
 */
function validateProvidersSetPayload(data) {
  if (!isPlainObject(data)) return fail('providers:set payload must be an object.');
  if (!Array.isArray(data.providers)) return fail('providers:set payload must include a "providers" array.');
  if (data.providers.length === 0) {
    return fail('providers:set refuses an empty "providers" array — a full replacement must not wipe the store.');
  }
  if (data.providers.length > MAX_PROVIDERS) {
    return fail('providers:set payload exceeds the ' + MAX_PROVIDERS + '-provider cap.');
  }
  const seenIds = new Set();
  for (let i = 0; i < data.providers.length; i++) {
    const err = checkEntry(data.providers[i], i, seenIds);
    if (err) return err;
  }
  for (const id of BUILTIN_PROVIDER_IDS) {
    if (!seenIds.has(id)) {
      return fail('providers:set full replacement must include the built-in provider "' + id + '".');
    }
  }
  if (data.selections !== undefined) {
    if (!isPlainObject(data.selections)) return fail('"selections" must be an object.');
    for (const [name, sel] of Object.entries(data.selections)) {
      const err = checkSelection(name, sel, seenIds);
      if (err) return err;
    }
  }
  return { ok: true };
}

module.exports = { validateProvidersSetPayload, BUILTIN_PROVIDER_IDS };
