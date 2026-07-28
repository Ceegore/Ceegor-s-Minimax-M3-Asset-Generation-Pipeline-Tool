// main/services/PathGrantService.js
// R1.1 — Main-owned opaque path-grant service (S1 design contract).
// A renderer-supplied string MUST NOT mint a write/read grant.
// Grants are minted by Main (picker, app-output, workspace),
// referenced by opaque IDs, and authorize candidates by canonical
// realpath. File grant → exact match. Directory grant → strict
// descendant (S1 §2.5). Directory-root grant (coversRoot:true) →
// self + descendants (the app-output / config-output use case).
// Time, IDs, and realpath are injectable for deterministic testing.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const OPERATION_TO_CAPABILITY = Object.freeze({
  read: 'read', write: 'write', delete: 'delete', mkdir: 'mkdir',
  rename: 'rename', copy: 'copy', move: 'move',
});

/**
 * @typedef {Object} Grant
 * @property {string} id
 * @property {string} origin
 * @property {string} purpose
 * @property {'directory'|'directory-root'|'file'} kind
 * @property {string} canonicalPath
 * @property {string[]} capabilities
 * @property {number} createdAt
 * @property {number|null} expiresAt
 * @property {boolean} singleUse
 * @property {boolean} revoked
 * @property {boolean} [consumed]
 * @property {number} [consumedAt]
 */

class PathGrantService {
  /**
   * @param {{
   *   now?: () => number,
   *   idFactory?: () => string,
   *   realpath?: (p: string) => string,
   * }} [opts]
   */
  constructor(opts = {}) {
    this._now = opts.now || (() => Date.now());
    this._idFactory = opts.idFactory || (() => crypto.randomUUID());
    this._realpath = opts.realpath || fs.realpathSync;
    /** @type {Map<string, Grant>} */
    this._grants = new Map();
  }

  /**
   * Resolve a path to its canonical (realpath'd) absolute form.
   * If the path does not exist, the nearest existing ancestor is
   * realpath'd and the leaf is reattached. Returns null if no
   * existing ancestor can be found.
   *
   * UNC paths (\\server\share\...) and drive paths (C:\) are walked
   * via path.dirname / path.basename so the UNC prefix and drive
   * letter are preserved. Manual string-split would lose them.
   * @param {string} p
   * @returns {string|null}
   */
  _canonicalize(p) {
    if (typeof p !== 'string' || !p) return null;
    let resolved;
    try {
      resolved = this._realpath(p);
    } catch (_) {
      // Non-existent path (e.g. save-as target). Walk up via
      // path.dirname which preserves UNC, drive, and root semantics
      // on every platform. The accumulate pattern reattaches the
      // missing tail (the parts that don't exist yet) below the
      // deepest existing ancestor.
      let acc = p;
      let tail = '';
      let deepest = null;
      let safety = 256; // bound the walk to defend against pathological inputs
      while (acc && safety-- > 0) {
        try {
          deepest = this._realpath(acc);
          break;
        } catch (_) {
          const base = path.basename(acc);
          if (!base || base === acc) break; // reached the root or made no progress
          tail = base + (tail ? path.sep + tail : '');
          acc = path.dirname(acc);
        }
      }
      if (!deepest) return null;
      // path.join normalises the trailing separator (no double
      // slashes, no '//' on POSIX) and preserves the UNC/drive
      // prefix of the ancestor.
      resolved = tail ? path.join(deepest, tail) : deepest;
    }
    return resolved;
  }

  /**
   * Case-aware equality for two canonicalized paths. NTFS is
   * case-insensitive, so a grant minted for `C:\Out\A.mp4` must match a
   * candidate `c:\out\a.mp4`. Both sides are already canonicalized
   * (realpath where it exists), so comparing the case-folded forms is
   * safe on win32 and avoids false rejections for not-yet-existing write
   * targets whose missing-tail casing differs. On case-sensitive
   * filesystems we keep strict equality.
   * @param {string} a
   * @param {string} b
   * @returns {boolean}
   */
  _pathsEqual(a, b) {
    if (a === b) return true;
    if (process.platform !== 'win32') return false;
    return a.toLowerCase() === b.toLowerCase();
  }

  /**
   * Validate the common mint spec (origin, purpose, path, capabilities)
   * and return either a {ok:true, ...} payload or {ok:false, error}.
   * Centralises the input validation so the two mint functions stay
   * symmetric and any new validation rule is added in one place.
   * @returns {{ok:true, origin:string, purpose:string, canonical:string, capabilities:string[], expiresAt:number|null, coversRoot:boolean} | {ok:false, error:string}}
   */
  _validateMintSpec(spec) {
    if (!spec || typeof spec !== 'object') return { ok: false, error: 'spec required' };
    const { origin, purpose, path: p, capabilities, expiresAt = null, coversRoot = false } = spec;
    if (!origin || typeof origin !== 'string') return { ok: false, error: 'origin required' };
    if (!purpose || typeof purpose !== 'string') return { ok: false, error: 'purpose required' };
    if (!p || typeof p !== 'string') return { ok: false, error: 'path required' };
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      return { ok: false, error: 'capabilities (non-empty array) required' };
    }
    const canonical = this._canonicalize(p);
    if (!canonical) return { ok: false, error: 'path could not be canonicalized: ' + p };
    return {
      ok: true, origin, purpose, canonical,
      capabilities: [...capabilities],
      expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
      coversRoot: !!coversRoot,
    };
  }

  /**
   * Mint a directory grant. Default scope = strict descendants (S1
   * §2.5: the root itself is never covered). Pass `coversRoot:true`
   * to also authorise the root (app-output / config-output use case).
   * @param {{origin:string, purpose:string, path:string, capabilities:string[], expiresAt?:number|null, coversRoot?:boolean}} spec
   * @returns {{ok:true, grantId:string, grant:Grant} | {ok:false, error:string}}
   */
  mintDirectoryGrant(spec) {
    const v = this._validateMintSpec(spec);
    if (!v.ok) return v;
    const id = this._idFactory();
    /** @type {Grant} */
    const grant = {
      id, origin: v.origin, purpose: v.purpose,
      kind: v.coversRoot ? 'directory-root' : 'directory',
      canonicalPath: v.canonical,
      capabilities: v.capabilities,
      createdAt: this._now(),
      expiresAt: v.expiresAt,
      singleUse: false, revoked: false,
    };
    this._grants.set(id, grant);
    return { ok: true, grantId: id, grant };
  }

  /**
   * Mint a file grant. Use singleUse:true for save-as targets so the
   * grant is consumed on the first successful authorize().
   * @param {{origin:string, purpose:string, path:string, capabilities:string[], singleUse?:boolean, expiresAt?:number|null}} spec
   * @returns {{ok:true, grantId:string, grant:Grant} | {ok:false, error:string}}
   */
  mintFileGrant(spec) {
    const v = this._validateMintSpec(spec);
    if (!v.ok) return v;
    const id = this._idFactory();
    /** @type {Grant} */
    const grant = {
      id, origin: v.origin, purpose: v.purpose, kind: 'file',
      canonicalPath: v.canonical,
      capabilities: v.capabilities,
      createdAt: this._now(),
      expiresAt: v.expiresAt,
      singleUse: !!(spec && spec.singleUse), revoked: false,
    };
    this._grants.set(id, grant);
    return { ok: true, grantId: id, grant };
  }

  /**
   * Authorize an operation against a grant.
   * @param {string} grantId
   * @param {{operation:string, path:string}} spec
   * @returns {{ok:true, canonicalPath:string} | {ok:false, error:string}}
   */
  authorize(grantId, spec) {
    if (!grantId || typeof grantId !== 'string') return { ok: false, error: 'grantId required' };
    if (!spec || typeof spec !== 'object') return { ok: false, error: 'spec required' };
    const { operation, path: candidatePath } = spec;
    if (!operation) return { ok: false, error: 'operation required' };
    if (!candidatePath || typeof candidatePath !== 'string') return { ok: false, error: 'path required' };

    const grant = this._grants.get(grantId);
    if (!grant) return { ok: false, error: 'grant not found' };
    if (grant.revoked) return { ok: false, error: 'grant revoked' };
    if (grant.consumed) return { ok: false, error: 'grant already consumed (single-use)' };
    if (grant.expiresAt != null && this._now() > grant.expiresAt) {
      return { ok: false, error: 'grant expired' };
    }
    const requiredCap = OPERATION_TO_CAPABILITY[operation];
    if (!requiredCap) return { ok: false, error: 'unknown operation: ' + operation };
    if (!grant.capabilities.includes(requiredCap)) {
      return { ok: false, error: 'operation "' + operation + '" not permitted by grant capabilities (' + grant.capabilities.join(',') + ')' };
    }
    const candidateCanonical = this._canonicalize(candidatePath);
    if (!candidateCanonical) return { ok: false, error: 'path could not be canonicalized: ' + candidatePath };

    if (grant.kind === 'file') {
      if (!this._pathsEqual(candidateCanonical, grant.canonicalPath)) {
        return { ok: false, error: 'file grant covers only its exact canonical path' };
      }
    } else if (grant.kind === 'directory') {
      // Strict descendants only. S1 §2.5: the root itself is never
      // covered. path.relative returns '' for the same path, an
      // absolute path for cross-drive, and a leading '..' for any
      // escape. The dir-bypass + isAbsolute + startsWith('..')
      // triple-check covers all three failure modes.
      const rel = path.relative(grant.canonicalPath, candidateCanonical);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, error: 'directory grant covers only strict descendants, not the root itself' };
      }
    } else if (grant.kind === 'directory-root') {
      // Self + strict descendants. The root is covered (so the
      // app-output / config-output use case can authorise the new
      // output destination) AND any strict descendant (so writes
      // inside the directory are also authorised). This is the
      // explicit "app-output" branch of the S1 §3 table where
      // "Root löschen/umbenennen" is allowed.
      if (!this._pathsEqual(candidateCanonical, grant.canonicalPath)) {
        const rel = path.relative(grant.canonicalPath, candidateCanonical);
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
          return { ok: false, error: 'directory-root grant covers only the root itself and its strict descendants' };
        }
      }
    } else {
      return { ok: false, error: 'unknown grant kind: ' + grant.kind };
    }

    if (grant.singleUse) {
      grant.consumed = true;
      grant.consumedAt = this._now();
    }

    return { ok: true, canonicalPath: candidateCanonical };
  }

  /**
   * Revoke a grant. Future authorize() calls will return error.
   * @param {string} grantId
   * @returns {{ok:true} | {ok:false, error:string}}
   */
  revoke(grantId) {
    if (!grantId || typeof grantId !== 'string') return { ok: false, error: 'grantId required' };
    const grant = this._grants.get(grantId);
    if (!grant) return { ok: false, error: 'grant not found' };
    grant.revoked = true;
    return { ok: true };
  }

  /**
   * Diagnostic peek at a grant (no side effects). Returns a shallow
   * copy of the stored grant, or null if the grant is unknown.
   * @param {string} grantId
   * @returns {Grant|null}
   */
  inspect(grantId) {
    if (!grantId || typeof grantId !== 'string') return null;
    const g = this._grants.get(grantId);
    if (!g) return null;
    return Object.assign({}, g, { capabilities: [...g.capabilities] });
  }

  /**
   * Evict expired grants. Returns the number of grants removed.
   * Use this in long-running processes to bound the in-memory
   * grant store. Time is read via the injected now() so the result
   * is deterministic in tests.
   * @param {number} [now] override now() for this call
   * @returns {number}
   */
  evictExpired(now) {
    const t = typeof now === 'number' ? now : this._now();
    let removed = 0;
    for (const [id, g] of this._grants) {
      if (g.expiresAt != null && t > g.expiresAt) {
        this._grants.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Destroy the service. Clears all grants; subsequent mint calls
   * start a fresh store. Call this on app shutdown (S1 §3: directory
   * grants are discarded at session end).
   * @returns {number} the number of grants discarded
   */
  destroy() {
    const n = this._grants.size;
    this._grants.clear();
    return n;
  }

  /**
   * Test/diagnostic helper: clear all grants. Not part of the public
   * surface — the renderer must never reach this.
   */
  _resetForTest() {
    this._grants.clear();
  }
}

// Module-level default instance. IPC handlers share THIS instance so a
// grantId minted in `file:pick` is visible to `fb:write` in R1.3.
const defaultService = new PathGrantService();

module.exports = {
  PathGrantService,
  OPERATION_TO_CAPABILITY,
  defaultService,
};
