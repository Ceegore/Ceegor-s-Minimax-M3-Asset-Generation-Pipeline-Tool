// main/services/WorkspaceService.js
// ============================================================================
// R1.4 — Main-owned workspace registry (S1 design contract).
//
// The renderer's persisted `pipeline.image.workspace` was a free-form
// absolute path string. S1 §4 "Pipeline und State" replaces it with a
// `workspaceId` whose canonical root is Main-owned and registered through
// the native folder-picker flow (or auto-derived from a Main-registered
// Config output_dir). A renderer-supplied string MUST NOT become a
// workspace; only Main can mint a workspaceId.
//
// WorkspaceService is the single place that knows the mapping
// `workspaceId -> canonical root`. IPC handlers resolve the id through
// this service before touching the filesystem; if the id is unknown, the
// handler returns `{ ok:false, error: 'reauthorizationRequired' }` so the
// renderer can re-prompt the user via the native folder flow (R1.5a +
// R1.6).
//
// The registry is in-memory and session-scoped (S1 §3: directory grants
// are discarded at session end). A persisted `workspaceId` that the user
// re-opens gets a freshly-minted entry; the canonical root must still
// exist and be reachable, or the resolution returns reauthorizationRequired.
//
// MED-027: Workspace IDs are opaque, session-scoped identifiers minted by
// the main process. After an app restart, persisted workspaceIds no longer
// resolve; the renderer must re-authorize via the native folder picker flow.
// ============================================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * @typedef {Object} Workspace
 * @property {string} id            - opaque id (e.g. 'ws_<uuid>')
 * @property {string} origin        - who minted it: 'app-output' | 'picker-workspace' | 'config-output'
 * @property {string} purpose       - free-form label for diagnostics
 * @property {string} canonicalPath - realpath of the directory at mint time
 * @property {number} createdAt
 * @property {number} lastSeenAt
 */

class WorkspaceService {
  /**
   * @param {{
   *   now?: () => number,
   *   idFactory?: () => string,
   *   realpath?: (p: string) => string,
   * }} [opts]
   */
  constructor(opts = {}) {
    this._now = opts.now || (() => Date.now());
    this._idFactory = opts.idFactory || (() => 'ws_' + crypto.randomUUID());
    this._realpath = opts.realpath || fs.realpathSync;
    /** @type {Map<string, Workspace>} */
    this._byId = new Map();
    /** @type {Map<string, string>} canonicalPath (case-folded on Windows) -> id (reverse lookup) */
    this._byPath = new Map();
  }

  /**
   * MED-028: On Windows, paths are case-insensitive. Normalize the key
   * for the reverse lookup map so that 'C:\Users\Foo' and 'c:\users\foo'
   * map to the same workspace.
   * @param {string} canonicalPath
   * @returns {string}
   */
  _pathKey(canonicalPath) {
    return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
  }

  /**
   * Mint a new workspace. The path is canonicalised (realpath) and must
   * exist as a directory; non-existent or non-directory paths return
   * {ok:false, error}. A path that already has a workspace returns the
   * EXISTING id (idempotent mint) — re-minting the same path keeps the
   * original id so persisted state still resolves.
   *
   * @param {{origin: string, purpose: string, path: string}} spec
   * @returns {{ok:true, id:string, workspace:Workspace} | {ok:false, error:string}}
   */
  mint(spec) {
    if (!spec || typeof spec !== 'object') return { ok: false, error: 'spec required' };
    const { origin, purpose, path: p } = spec;
    if (!origin || typeof origin !== 'string') return { ok: false, error: 'origin required' };
    if (!purpose || typeof purpose !== 'string') return { ok: false, error: 'purpose required' };
    if (!p || typeof p !== 'string') return { ok: false, error: 'path required' };
    let canonical;
    try {
      canonical = this._realpath(p);
    } catch (_) {
      return { ok: false, error: 'path does not exist: ' + p };
    }
    let st;
    try { st = fs.statSync(canonical); } catch (_) {
      return { ok: false, error: 'path could not be stat\'d: ' + canonical };
    }
    if (!st.isDirectory()) {
      return { ok: false, error: 'path is not a directory: ' + canonical };
    }
    // Idempotent: if we already minted a workspace for this canonical
    // path, return the existing id. The renderer's persisted state
    // continues to resolve after a restart.
    // MED-028: use case-folded key on Windows.
    const existing = this._byPath.get(this._pathKey(canonical));
    if (existing) {
      const ws = this._byId.get(existing);
      if (ws) {
        ws.lastSeenAt = this._now();
        return { ok: true, id: existing, workspace: ws };
      }
    }
    const id = this._idFactory();
    /** @type {Workspace} */
    const ws = {
      id, origin, purpose, canonicalPath: canonical,
      createdAt: this._now(), lastSeenAt: this._now(),
    };
    this._byId.set(id, ws);
    // MED-028: store with case-folded key on Windows.
    this._byPath.set(this._pathKey(canonical), id);
    return { ok: true, id, workspace: ws };
  }

  /**
   * Resolve a workspaceId to its canonical root. Returns null if the id
   * is unknown OR if the canonical root no longer exists (e.g. the user
   * deleted the folder between sessions). The IPC layer translates the
   * null result into `{ ok:false, error: 'reauthorizationRequired' }`.
   *
   * @param {string} id
   * @returns {string|null}
   */
  resolve(id) {
    if (!id || typeof id !== 'string') return null;
    const ws = this._byId.get(id);
    if (!ws) return null;
    // Re-verify the canonical root still exists at resolve time. This
    // catches a user who deleted the folder between the original mint
    // and the current call.
    try {
      const st = fs.statSync(ws.canonicalPath);
      if (!st.isDirectory()) return null;
    } catch (_) {
      return null;
    }
    ws.lastSeenAt = this._now();
    return ws.canonicalPath;
  }

  /**
   * Look up the workspace record (read-only). Returns null if unknown.
   * @param {string} id
   * @returns {Workspace|null}
   */
  inspect(id) {
    if (!id || typeof id !== 'string') return null;
    const ws = this._byId.get(id);
    if (!ws) return null;
    return Object.assign({}, ws);
  }

  /**
   * Diagnostic: enumerate all workspaces. Not part of the IPC surface.
   * @returns {Workspace[]}
   */
  list() {
    return Array.from(this._byId.values()).map((w) => Object.assign({}, w));
  }

  /**
   * Destroy the service. Clears all workspaces. Call this on app shutdown
   * (S1 §3: directory grants are discarded at session end).
   * @returns {number} the number of workspaces discarded
   */
  destroy() {
    const n = this._byId.size;
    this._byId.clear();
    this._byPath.clear();
    return n;
  }
}

// Module-level default instance. IPC handlers share THIS instance so a
// workspaceId minted by Main (e.g. config-output auto-mint) is visible to
// every consumer (state IPC, pipeline IPC, file browser).
const defaultService = new WorkspaceService();

module.exports = {
  WorkspaceService,
  defaultService,
};
