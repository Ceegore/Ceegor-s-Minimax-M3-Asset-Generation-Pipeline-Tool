// main/ipc/registerStateIpc.js
// IPC handlers: `state:get` / `state:set` / `state:archiveRead` /
// `state:archiveClear` / `state:archiveSize` / `state:archiveDelete`.
// Persists tab settings (per-tab folder, file prefix, Real-ESRGAN model).
//
// R1.4 (S1 §4 "Pipeline und State"): `state:get` no longer calls
// `addTrusted` on any persisted path (workspace OR columnFolders). The
// only Main-owned entry point that mints a workspaceId is the native
// folder-picker flow (or the auto-derived app-output workspace minted
// once at app startup from the Main-registered Config output_dir).
// A renderer-supplied `pipeline.image.workspace` string is NOT promoted
// to a workspaceId; a legacy workspace path that is OUTSIDE the current
// Main-registered Config-Root is reported as `reauthorizationRequired` so
// the renderer can re-prompt the user via the native folder flow.
// (S1 §4: "Ein Legacy-Workspace außerhalb des aktuellen Main-registrierten
//  Config-Roots wird nicht gelöscht und nicht vertraut; er wird als
//  reauthorizationRequired zurückgemeldet. Erst der bestehende native
//  Folder-Flow darf einen neuen Workspace registrieren.")

const { ipcMain } = require('electron');
const stateMod = require('../../src/state');
const cfgMod = require('../../src/config');
const { configDir } = require('../../src/config');
const archive = require('../../src/services/ArchiveService');
const pathUtils = require('../../src/pathUtils');
const { defaultService: workspaceService } = require('../services/WorkspaceService');
// P1-A (360° Audit H-001): secure IPC wrapper.
const { secureHandle } = require('./secureHandle');

/**
 * Return the list of Main-registered Config-Roots. A legacy workspace
 * path that lands INSIDE one of these is safely auto-mintable; a path
 * OUTSIDE all of them is a renderer-supplied (or hand-edited) value
 * that never went through Main's folder flow, so R1.4 refuses to
 * trust it and sets reauthorizationRequired.
 */
function mainRegisteredConfigRoots() {
  const cfg = cfgMod.read();
  const roots = [];
  try {
    const out = cfgMod.effectiveOutputDir(cfg);
    if (out && typeof out === 'string') roots.push(out);
  } catch (_) { /* defaultOutputDir may throw without electron — best effort */ }
  if (cfg && typeof cfg.report_dir === 'string' && cfg.report_dir.trim()) {
    roots.push(cfg.report_dir.trim());
  }
  return roots;
}

/**
 * @param {{ appRoot: string }} deps
 */
function register(deps) {
  const getMainWindow = (deps && typeof deps.getMainWindow === 'function') ? deps.getMainWindow : () => null;
  secureHandle('state:get', { getMainWindow }, () => {
    // R1.4 Phasenpruefung-2: the catch is now NARROW. A read error
    // (corrupt state.json) still returns {} (the state is unrecoverable
    // and the renderer will re-initialise defaults). A MIGRATION error
    // (workspaceService.mint / isPathUnderAny throwing on a weird
    // path) used to also return {}, which would cause the renderer to
    // overwrite the user's valid state.json with defaults — DATA LOSS.
    // Now: read errors return {}; migration errors are caught LOCALLY
    // and set reauthorizationRequired so the user re-prompts, but the
    // underlying state.json is preserved.
    // MED-029: standardized envelope — add ok:true to the returned state
    // object for R3.1 envelope compliance while maintaining backward
    // compatibility (renderer can still access state.tabs directly).
    let s;
    try {
      s = stateMod.read();
    } catch (_) {
      return { ok: false, error: 'state read failed' };
    }
    if (!s || typeof s !== 'object') return { ok: true };
    // MED-029: mark envelope as successful.
    s.ok = true;
    // R1.4: NO addTrusted. The persisted paths in columnFolders
    // and workspace were the security loophole the SYS-001 family
    // tested for. Resolution now goes through WorkspaceService:
    // a workspaceId that Main minted at startup is still valid; a
    // legacy string path (or a workspaceId that no longer resolves)
    // is reported back to the renderer as reauthorizationRequired
    // so the user can re-confirm via the native folder picker.
    if (s.pipeline && s.pipeline.image) {
      const img = s.pipeline.image;
      // Legacy: a string `workspace` path is no longer trusted as
      // a write root. Replace it with a `workspaceId` resolution.
      if (typeof img.workspace === 'string' && img.workspace.trim()) {
        const legacyPath = img.workspace.trim();
        // Local try-catch: any migration error (mint, realpath, stat,
        // isPathUnderAny) sets reauthorizationRequired instead of
        // bubbling up and triggering the outer catch (which would
        // wipe the user's state). The legacy string is ALWAYS dropped
        // afterwards so the renderer never sees a free-form `workspace`
        // path on the way back.
        try {
          const roots = mainRegisteredConfigRoots();
          const isUnderConfig = roots.length > 0 && pathUtils.isPathUnderAny(legacyPath, roots);
          if (isUnderConfig) {
            const m = workspaceService.mint({
              origin: 'app-output-legacy',
              purpose: 'migrated from persisted workspace path inside Config-Root',
              path: legacyPath,
            });
            if (m.ok) {
              img.workspaceId = m.id;
            } else {
              // Mint failed (path vanished, permission, etc.).
              // Set reauthorizationRequired so the renderer prompts.
              img.workspaceId = null;
              img.reauthorizationRequired = true;
            }
          } else {
            // Path is OUTSIDE all Main-registered Config-Roots.
            // Per S1 §4 it MUST NOT be trusted: clear workspaceId
            // and set reauthorizationRequired.
            img.workspaceId = null;
            img.reauthorizationRequired = true;
          }
        } catch (_) {
          // Any unexpected error in the migration (realpath, stat,
          // isPathUnderAny, etc.) → flag for re-prompt. The legacy
          // string is still dropped below; the user's state.json is
          // preserved.
          img.workspaceId = null;
          img.reauthorizationRequired = true;
        }
        // Drop the legacy string. R1.4's invariant: state may
        // store `workspaceId` and `reauthorizationRequired`, never
        // a raw `workspace` path that grants write access.
        delete img.workspace;
      }
      if (typeof img.workspaceId === 'string' && img.workspaceId) {
        try {
          const resolved = workspaceService.resolve(img.workspaceId);
          if (resolved == null) {
            // Persisted id no longer resolves (folder deleted, or
            // fresh session without the id in the registry).
            img.workspaceId = null;
            img.reauthorizationRequired = true;
          }
        } catch (_) {
          // workspaceService.resolve threw (sync I/O error). Treat
          // the id as unresolvable and flag for re-prompt.
          img.workspaceId = null;
          img.reauthorizationRequired = true;
        }
      }
    }
    return s;
  });
  // Type-check the payload BEFORE write() is called so a renderer that
  // sends "tabs" as a string or "fbDirs" as a number fails fast with a
  // clear error instead of writing a half-broken state.json. write()
  // builds a `clean` object from a hard-coded schema (unknown fields
  // are dropped on disk) as the second layer of defence.
  //
  // R1.4: the renderer's state:set payload is sanitised to strip any
  // raw `workspace` path. Only `workspaceId` is accepted as the
  // pipeline-image workspace; a renderer cannot re-introduce a string
  // workspace path that would bypass the WorkspaceService gate.
  secureHandle('state:set', { getMainWindow }, (_e, s) => {
    try {
      if (s != null && typeof s !== 'object') {
        return { ok: false, error: 'state payload must be a plain object.' };
      }
      if (Array.isArray(s)) {
        return { ok: false, error: 'state payload must be a plain object (got an array).' };
      }
      // The renderer's "tabs" sub-object is the biggest one; the
      // rest of the state is small enough to be a top-level
      // primitive. Sanitise the shape so a malformed payload
      // can't crash stateMod.write() deep inside a try/catch.
      if (s && s.tabs != null && (typeof s.tabs !== 'object' || Array.isArray(s.tabs))) {
        return { ok: false, error: 'state.tabs must be a plain object (tab id -> form values).' };
      }
      // R1.4 sanitiser: drop any pipeline.image.workspace string. A
      // compromised renderer that tries to set a free-form path here
      // will have the field stripped before write() persists it. The
      // only legitimate way to set a workspace is the native folder
      // picker (which mints a workspaceId via the WorkspaceService).
      if (s && s.pipeline && s.pipeline.image && typeof s.pipeline.image === 'object') {
        if ('workspace' in s.pipeline.image) {
          delete s.pipeline.image.workspace;
        }
      }
      stateMod.write(s);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  // Archive IPCs. All four return { ok, ... } envelopes.
  secureHandle('state:archiveRead', { getMainWindow }, (_e, opts) => {
    try {
      const r = archive.readChunk(configDir(), opts || {});
      return { ok: true, ...r };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  secureHandle('state:archiveClear', { getMainWindow }, () => {
    try { const removed = archive.clear(configDir()); return { ok: true, removedBytes: removed }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  secureHandle('state:archiveSize', { getMainWindow }, () => {
    try { return { ok: true, bytes: archive.size(configDir()) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  secureHandle('state:archiveDelete', { getMainWindow }, (_e, payload) => {
    try {
      const id = payload && payload.id;
      if (!id || typeof id !== 'string') {
        return { ok: false, error: 'A valid string id is required.' };
      }
      const removed = archive.deleteOne(configDir(), id);
      return { ok: true, removed };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
}

module.exports = { register };
