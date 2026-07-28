// renderer/services/grantCache.js
// ============================================================================
// R1.5a.follow-up Phase 2 — Renderer-side grant cache.
//
// R1.5a grant-checkpoint contract: every mutating IPC handler
// (image:optimize, image:resize, image:fixExtension, fb:write,
// fb:delete, inpaint:runTelea, inpaint:runOnnx, ...) requires a
// Main-minted grantId (passed as an explicit arg). R1.5a.follow-up
// Phase 1 added the pathGrant:mint IPC that lets the renderer
// request a grant for a (path, operation) pair.
//
// This module is a thin renderer-side cache that maps
// `'<path>\x00<operation>'` to a grantId, so the renderer doesn't
// need to mint a new grant for every mutation call on the same
// path. The cache is process-local (no IPC) and bounded (FIFO
// eviction) to keep memory footprint low.
//
// Usage (renderer):
//   const grantId = await window.GrantCache.ensurePathGrant('/path/to/file.png', 'read');
//   await window.api.optimizeImage(srcPath, opts, grantId);
//
// The IPC's operation allowlist (read|write|delete|mkdir|rename
// |copy|move) is enforced server-side in pathGrant:mint; the
// cache passes the operation through unchanged. A renderer that
// passes an invalid operation gets a {ok: false, error: ...}
// from the IPC, NOT a throw, so the caller is responsible for
// checking the return value.
//
// Eviction: a FIFO Map with cap 256 (configurable). When the
// cap is hit, the oldest entry is dropped AND the associated
// grant is revoked server-side (R1.5a.follow-up Phase 5). The
// grant is multi-use and the PathGrantService does not auto-
// expire it; without the revoke-on-evict, repeated edits on
// >256 distinct paths would leak grants in PathGrantService
// until app restart. R1.5a.follow-up Phase 5 closes the leak.
//
// PRE-1 fix (2026-07-21): Converted from CommonJS module.exports
// to IIFE + window.GrantCache for sandboxed renderer compatibility.
// The renderer runs with nodeIntegration:false, sandbox:true, so
// require() is not available. This file is now loaded via <script>
// tag and exposes its API via window.GrantCache.

(function () {
'use strict';

const MAX_ENTRIES = 256;

const _cache = new Map(); // key -> { grantId, createdAt }
const _mintPromises = new Map(); // R8: key -> in-flight mint promise (per-key de-dupe; a single slot was overwritten by a concurrent mint for a DIFFERENT key, letting a third call mint a duplicate grant)

function _key(path, operation, opts) {
  // NUL byte (\x00) is a safe separator (not allowed in Windows
  // paths, not allowed in JSON strings without escaping, and
  // not used by the IPC protocol). For R1.5a.follow-up Phase 6
  // we also include the kind + capabilities in the key so that
  // file-grant-with-read and directory-grant-with-read-write
  // are distinct cache entries (a directory grant cannot
  // substitute for a file grant in the same cache slot).
  // KGO6-014: canonicalize opts with sorted keys so semantically
  // identical option objects produce the same cache key regardless
  // of property insertion order.
  const optsStr = opts ? JSON.stringify(opts, Object.keys(opts).sort()) : '';
  return path + '\x00' + operation + '\x00' + optsStr;
}

function _evictIfNeeded() {
  while (_cache.size > MAX_ENTRIES) {
    const firstKey = _cache.keys().next().value;
    const evicted = _cache.get(firstKey);
    _cache.delete(firstKey);
    // Best-effort revoke: don't await, don't throw. If the
    // IPC fails (e.g. main process is shutting down), the
    // grant stays until the next app restart — same
    // behaviour as before this fix.
    if (evicted && evicted.grantId && window.api && typeof window.api.revokeGrant === 'function') {
      try { window.api.revokeGrant(evicted.grantId); } catch (_) {}
    }
  }
}

/**
 * Ensure a grantId is available for the given (path, operation)
 * pair. Mints a new grant via `window.api.mintGrant` if none is
 * cached. Returns the grantId on success, or `{ok: false, error}`
 * (with no throw) on failure so the caller can show a single
 * toast and abort the workflow.
 *
 * R1.5a.follow-up Phase 6: optional `opts` (3rd arg) lets the
 * caller request a directory grant + multi-capability grant.
 * This is required for the read-source + write-sibling pattern
 * used by optimize/resize/inpaint/removeBg (a file grant on the
 * source does not cover the output sibling). See
 * `preload.js:mintGrant` for the full contract.
 *
 * @param {string} path
 * @param {'read'|'write'|'delete'|'mkdir'|'rename'|'copy'|'move'} operation
 * @param {{kind?: 'file'|'directory', capabilities?: string[]}} [opts]
 * @returns {Promise<string|{ok: false, error: string}>}
 */
async function ensurePathGrant(path, operation, opts) {
  if (!path || typeof path !== 'string') {
    return { ok: false, error: 'ensurePathGrant: path required' };
  }
  if (!operation || typeof operation !== 'string') {
    return { ok: false, error: 'ensurePathGrant: operation required' };
  }
  const k = _key(path, operation, opts);
  const cached = _cache.get(k);
  if (cached) return cached.grantId;
  // De-dupe concurrent mints for the same key (two parallel
  // optimize calls on the same path share a single mint).
  if (_mintPromises.has(k)) {
    return _mintPromises.get(k);
  }
  const promise = (async () => {
    if (!window.api || !window.api.mintGrant) {
      return { ok: false, error: 'ensurePathGrant: window.api.mintGrant is not available' };
    }
    const r = await window.api.mintGrant(path, operation, opts);
    if (!r || !r.ok) {
      return { ok: false, error: (r && r.error) || 'mintGrant returned no envelope' };
    }
    _cache.set(k, { grantId: r.grantId, createdAt: Date.now() });
    _evictIfNeeded();
    return r.grantId;
  })();
  _mintPromises.set(k, promise);
  try {
    return await promise;
  } finally {
    _mintPromises.delete(k);
  }
}

/**
 * Drop a cached grantId (e.g. when the workflow completes and
 * the renderer wants to free server-side state). Does NOT
 * revoke the grant server-side; the caller should invoke
 * window.api.revokeGrant(id) separately if needed.
 * @param {string} path
 * @param {string} operation
 */
function dropPathGrant(path, operation, opts) {
  _cache.delete(_key(path, operation, opts));
}

/**
 * Drop all cached grantIds. Used by the test harness and by
 * settings changes that invalidate the trust set.
 */
function clearPathGrants() {
  _cache.clear();
}

/**
 * R1.5a.follow-up Phase 5: revoke every cached grantId AND
 * clear the cache. Used by the renderer's onBeforeQuit handler
 * to free server-side state when the app shuts down. Best-
 * effort: revoke calls are fire-and-forget; the renderer may
 * be torn down before they reach the main process. Any
 * un-revoked grants are reaped on the next app restart (the
 * PathGrantService singleton is process-local).
 *
 * @returns {Promise<{revoked: number, failed: number}>} stats
 */
async function revokeAllAndClear() {
  const ids = [];
  for (const entry of _cache.values()) ids.push(entry.grantId);
  _cache.clear();
  let revoked = 0; let failed = 0;
  if (window.api && typeof window.api.revokeGrant === 'function') {
    for (const id of ids) {
      try {
        const r = await window.api.revokeGrant(id);
        if (r && r.ok) revoked++; else failed++;
      } catch (_) { failed++; }
    }
  }
  return { revoked, failed };
}

// PRE-1 fix: expose via window.GrantCache for sandboxed renderer.
// Also keep module.exports for Node.js test compatibility.
window.GrantCache = {
  ensurePathGrant,
  dropPathGrant,
  clearPathGrants,
  revokeAllAndClear,
  MAX_ENTRIES,
};

// Node.js test compatibility (tests run with global.window = global).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = window.GrantCache;
}

})();
