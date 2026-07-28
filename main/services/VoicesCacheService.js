// main/services/VoicesCacheService.js
// Cache for the MiniMax API voice list, keyed **per API key**. A single
// module-global cache would never invalidate on key change, so a user with two
// accounts would get the first key's voices for the second.

const path = require('path');
const fs = require('fs');
const { runMmx } = require('../../src/mmx');

/** @type {Map<string, Array>} key = api_key || ''; value = Voice[] */
const voicesCache = new Map();

/**
 * Returns the voice list for the given API key.
 * 1. Cache hit -> return immediately.
 * 2. Cache miss + key set -> live API (`mmx speech voices`).
 * 3. Cache miss + no key -> bundled `voices.json` (fallback).
 *
 * @param {string} apiKey
 * @returns {Promise<Array>}
 */
async function get(apiKey, opts) {
  const cacheKey = apiKey || '';
  if (voicesCache.has(cacheKey)) return voicesCache.get(cacheKey);

  // Live API.
  let apiFailed = false;
  if (apiKey) {
    // Honor session-only mode: when the user opted out of persisting the key,
    // route it via the ephemeral MMX_API_KEY env var instead of syncing it to
    // ~/.mmx/config.json (which would break the "never touches disk" promise).
    // The caller (registerMmxIpc mmx:voices) reads state.apiKeyNoSave and
    // passes sessionOnly through here. (360°-sweep fix, same class as H7-022.)
    const sessionOnly = !!(opts && opts.sessionOnly);
    try {
      const r = await runMmx({ args: ['speech', 'voices'], apiKey, sessionOnly, onLog: () => {} });
      if (r.ok) {
        const parsed = r.parsed;
        if (Array.isArray(parsed) && parsed.length) {
          voicesCache.set(cacheKey, parsed);
          return parsed;
        }
        if (typeof parsed === 'string') {
          try {
            const v = JSON.parse(parsed);
            if (Array.isArray(v) && v.length) {
              voicesCache.set(cacheKey, v);
              return v;
            }
          } catch { /* fallthrough */ }
        }
      } else {
        apiFailed = true;
      }
    } catch (_) {
      apiFailed = true;
    }
  }

  // Fallback to bundled voices.json.
  try {
    const candidates = [
      path.join(__dirname, '..', '..', 'voices.json'),
      path.join(__dirname, '..', '..', 'src', 'voices.json'),
      path.join(process.resourcesPath || '', 'voices.json'),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) {
        const v = JSON.parse(fs.readFileSync(c, 'utf8'));
        if (Array.isArray(v) && v.length) {
          voicesCache.set(cacheKey, v);
          return v;
        }
      }
    }
  } catch { /* ignore */ }

  // Cache an empty result ONLY when the failure mode is stable (no key +
  // no bundled file). If the live API failed transiently (network blip,
  // rate limit), do NOT cache — the next call should retry the API instead
  // of serving a permanent empty list for the session.
  if (!apiFailed) voicesCache.set(cacheKey, []);
  return [];
}

/**
 * Full reset. Call on config:set with a new API key.
 */
function reset() {
  voicesCache.clear();
}

module.exports = { get, reset };
