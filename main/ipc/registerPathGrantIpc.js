// main/ipc/registerPathGrantIpc.js
// ============================================================================
// R1.5a.follow-up — Renderer-side grant minting helper.
//
// R1.5a introduced the grant-checkpoint contract: every mutating
// IPC handler (fb:write, fb:delete, image:optimize, image:resize,
// image:fixExtension, inpaint:runTelea, inpaint:runOnnx, …)
// requires a `grantId` (Main-minted) that authorises the operation
// on the target path. The R1.5a implementation expected the
// renderer to mint grants via `file:pick` (which auto-mints a
// directory grant for the picked folder) or via app-output (the
// `output_dir` is grant-minted at app start).
//
// In practice, the renderer-callsites in `preload.js` +
// `renderer/overlays/imageEditorHeal.js` +
// `renderer/sections/section07_Image_optimisation___compression.js`
// + ... did NOT pass a `grantId` to the mutation IPCs. The
// handler's grant check then returns
// `{ok: false, error: 'grantId is required for read on <path>'}`.
// R1.5a tests pass because they call the handler directly with
// a mint'd grantId, bypassing the preload→IPC pipeline. The
// production flow was effectively broken for these callsites.
//
// R1.5a.follow-up closes the gap with a new IPC `pathGrant:mint`
// that lets the renderer request a Main-minted grant for a
// specific (path, operation) pair BEFORE the mutation call. The
// renderer is responsible for caching the grantId (so the same
// grant can be reused across multiple operations on the same
// path, e.g. "read src.png + write dst.png").
//
// IPC contract (R1.5a.follow-up, added):
//   pathGrant:mint  — window.api.mintGrant(path, operation, opts?)
//     args:
//       (path: string,
//        operation: 'read'|'write'|'delete'|'mkdir'|'rename'|'copy'|'move',
//        opts?: { kind?: 'file'|'directory', capabilities?: string[] })
//     returns: { ok: true, grantId: string }
//            | { ok: false, error: string }
//     Notes (R1.5a.follow-up Phase 6):
//       - opts.kind: 'file' (default) mints a file grant for the
//         path. 'directory' mints a directory grant (the renderer
//         uses this for optimize/resize/inpaint/removeBg where the
//         output is a SIBLING of the source — a file grant on the
//         source would not cover the output path).
//       - opts.capabilities: array of capabilities to mint. Default
//         is `[operation]`. The renderer uses this when it needs
//         both 'read' AND 'write' on the same path (e.g. for
//         in-place optimize, or for the read+write check in the
//         image:optimize handler).
//       - Backward-compat: if opts is omitted, the IPC mints a
//         file grant with `capabilities: [operation]`. Existing
//         callers (R1.5a.follow-up Phases 1-4b) are unaffected.
//   pathGrant:revoke — window.api.revokeGrant(grantId)
//     args: (grantId: string)
//     returns: { ok: true } | { ok: false, error: string }
//
// Security model (per S1 §3, R1.2 design contract):
//   - The renderer supplies the PATH, the OPERATION, and
//     optionally the KIND and CAPABILITIES. The Main process
//     still decides the actual authorization — the renderer can
//     only REQUEST, not grant. The trust-root check (see below)
//     rejects any path outside the user's picked folders.
//   - For now, the simplest safe policy is: a `mintGrant(path,
//     op)` call returns a FILE grant for `path` with exactly the
//     requested capability. A `mintGrant(path, op, {kind:
//     'directory'})` call returns a DIRECTORY grant for `path`
//     (the path is a directory in this case, typically the
//     parent of the file the renderer wants to operate on).
//   - The grant is multi-use until revoked. The renderer is
//     expected to revoke after a workflow completes (or let the
//     service's TTL handle cleanup). Future cards may add
//     single-use grants for higher-stakes operations.

const { ipcMain } = require('electron');
const pathGrantService = require('../services/PathGrantService');
const pathSecurity = require('../services/PathSecurityService');
// Issue-6 fix: config access + canonicalisation helpers for the
// config-root fast-path and the rejection diagnostics below.
const cfgMod = require('../../src/config');
const pathUtils = require('../../src/pathUtils');
// P1-A (360° Audit H-001): secure IPC wrapper.
const { secureHandle } = require('./secureHandle');

const VALID_OPERATIONS = new Set([
  'read', 'write', 'delete', 'mkdir', 'rename', 'copy', 'move',
]);

function bad(msg) { return { ok: false, error: msg }; }

/**
 * @param {{ appRoot: string }} _deps
 */
function register(deps) {
  const getMainWindow = (deps && typeof deps.getMainWindow === 'function') ? deps.getMainWindow : () => null;
  secureHandle('pathGrant:mint', { getMainWindow }, (_e, p, operation, opts) => {
    if (typeof p !== 'string' || !p.trim()) {
      return bad('Path is required.');
    }
    if (!VALID_OPERATIONS.has(operation)) {
      return bad('Operation must be one of: ' + Array.from(VALID_OPERATIONS).join(', '));
    }
    // R1.5a.follow-up Phase 6: parse opts (kind + capabilities).
    // Both are optional; defaults preserve the R1.5a.follow-up
    // Phase 1-4b behavior (file grant with single capability).
    let kind = 'file';
    let capabilities = [operation];
    // R7.5: coversRoot lets the renderer request a directory-ROOT grant
    // (kind 'directory-root', coversRoot:true) that authorises the grant
    // path ITSELF plus its descendants — the config-output use case. A
    // plain directory grant never covers the root (S1 §2.5), so the
    // generation flow (ensureSubDir → fb:ensureDir on the output_dir
    // root, mmx --out-dir write on the root) requires coversRoot:true.
    // Only meaningful with kind:'directory'; rejected for file grants.
    let coversRoot = false;
    // Audit-fix: only accept plain objects. typeof [] === 'object'
    // and typeof Promise.resolve() === 'object' in JS, so a buggy
    // renderer that passes an array or promise would otherwise
    // silently fall through with default capabilities (silent
    // capability-mismatch later, hard to debug). Test S covers
    // the primitive-number case; this is the object-shaped
    // edge case.
    if (opts && Object.getPrototypeOf(opts) === Object.prototype) {
      if (opts.kind != null) {
        if (opts.kind !== 'file' && opts.kind !== 'directory') {
          return bad('opts.kind must be "file" or "directory".');
        }
        kind = opts.kind;
      }
      if (opts.capabilities != null) {
        if (!Array.isArray(opts.capabilities) || opts.capabilities.length === 0) {
          return bad('opts.capabilities must be a non-empty array.');
        }
        for (const c of opts.capabilities) {
          if (!VALID_OPERATIONS.has(c)) {
            return bad('opts.capabilities contains invalid value: ' + c);
          }
        }
        capabilities = opts.capabilities.slice();
      }
      if (opts.coversRoot != null) {
        if (typeof opts.coversRoot !== 'boolean') {
          return bad('opts.coversRoot must be a boolean.');
        }
        coversRoot = opts.coversRoot;
      }
    }
    // R1.5a.follow-up AuditFix: trust-root check (CRITICAL security
    // fix). Before this, any renderer-process could mint a grant
    // for ANY path on the filesystem (e.g. C:\Windows\System32
    // \notepad.exe) by calling `window.api.mintGrant(path, 'read')`.
    // That bypassed the S1 §3 trust-root contract (only the user
    // — via native pickers, config, or app-output — is allowed
    // to authorise a path). The grantId, once minted, was usable
    // by every R1.5a mutation handler. Result: any compromised
    // renderer could read sensitive system files (pre-existing
    // SYS-001 risk surface re-opened, broader than the original
    // fb:set-active-dir surface).
    //
    // Fix: reject any path that is NOT under the current trust
    // roots (output_dir + trustedPickPaths + activeDir — the same
    // set that gates the mutation handlers via
    // PathSecurityService.getAllowedRoots). The renderer is
    // expected to ask the user to pick the file/folder first
    // (via file:pick, which auto-trusts the parent), and only
    // then mint a grant for it. mintGrant is a follow-up to a
    // trust gesture, not a trust gesture by itself.
    //
    // Issue-6 hardening (two parts):
    //  1. Config-root fast-path: the config's own output_dir /
    //     report_dir are inherently trusted (Main-owned, read fresh
    //     from config.txt). Accept an EXACT canonical match against
    //     them even when the realpath-based isPathUnderAny diverged
    //     (e.g. a not-yet-existing directory whose separator style
    //     differs from the config value). Only exact root identity
    //     is fast-pathed — descendants still go through the full
    //     realpath check so symlink escapes stay rejected.
    //  2. Diagnostics: on rejection, log the path AND the allowed
    //     roots and return them in the error so the mismatch is
    //     visible in renderer-error.log / the toast instead of a
    //     bare "not in an allowed root".
    let trustOk = pathSecurity.isPathUnderAny(p);
    if (!trustOk) {
      const pCanon = pathUtils.canon(pathUtils.normalize(p) || '');
      const cfgRoots = [];
      try {
        const c = cfgMod.read();
        const eff = cfgMod.effectiveOutputDir(c);
        if (eff) cfgRoots.push(eff);
        if (c && typeof c.report_dir === 'string' && c.report_dir.trim()) cfgRoots.push(c.report_dir.trim());
      } catch (_) { /* config unreadable — no fast-path */ }
      trustOk = pCanon !== '' && cfgRoots.some((r) => pathUtils.canon(pathUtils.normalize(r) || '') === pCanon);
    }
    if (!trustOk) {
      const roots = (() => { try { return pathSecurity.getAllowedRoots(); } catch (_) { return []; } })();
      try {
        console.error('[pathGrant:mint] REJECTED path="' + p + '" op=' + operation + ' — allowed roots: [' + roots.join(', ') + ']');
      } catch (_) { /* logging must never break the handler */ }
      // P5 (M-038): the returned error must NOT echo the allowed roots —
      // that handed a compromised renderer the user's full drive/folder
      // layout. The detail stays main-side (console.error above) for
      // forensics; the renderer gets a generic, actionable message.
      return bad('Path is not in an allowed root. Folder authorizations reset when the app restarts — re-select the folder via the file browser\'s \uD83D\uDCC2 button, or check Settings → Output directory.');
    }
    // R1.5a.follow-up: explicit capability allowlist (defence-in-depth
    // — PathGrantService.mintFileGrant does NOT validate capability
    // values, so a malicious renderer could mint a grant with
    // capabilities: ['arbitrary-capability'] and bypass the
    // service-side check). Restrict to the 7 valid operations.
    // (Validation already done above; capabilities is guaranteed
    // to be an array of valid values.)
    let result;
    const mintSpec = {
      origin: 'renderer-mint',
      purpose: operation + ' on ' + p,
      path: p,
      capabilities,
      singleUse: false,
    };
    if (kind === 'directory') {
      // Directory grant: the renderer is asking for read+write
      // on a DIRECTORY (typically the parent of the source file),
      // so a single grant covers both the source file (for read)
      // and the output sibling (for write). The handler's
      // authorize() check then accepts both paths as long as
      // they're under the grant's canonical path. With
      // coversRoot:true the grant ALSO covers the directory itself
      // (kind 'directory-root') — required for fb:ensureDir on the
      // output_dir root and mmx --out-dir writes on the root.
      mintSpec.coversRoot = coversRoot;
      result = pathGrantService.defaultService.mintDirectoryGrant(mintSpec);
    } else {
      if (coversRoot) {
        return bad('opts.coversRoot is only valid with kind "directory".');
      }
      result = pathGrantService.defaultService.mintFileGrant(mintSpec);
    }
    if (!result || !result.ok) {
      return bad('Failed to mint grant for ' + p + ': ' + ((result && result.error) || 'unknown error'));
    }
    return { ok: true, grantId: result.grantId };
  });

  secureHandle('pathGrant:revoke', { getMainWindow }, (_e, grantId) => {
    if (typeof grantId !== 'string' || !grantId.trim()) {
      return bad('GrantId is required.');
    }
    // R1.5a.follow-up AuditFix: propagate the service's return
    // value. Previously, revoke() returned {ok: false, error:
    // 'grant not found'} for a non-existent grantId, but the IPC
    // silently returned {ok: true} — a renderer that typo'd a
    // grantId would think the revoke succeeded even though no
    // grant was actually revoked (silent state-drift).
    const r = pathGrantService.defaultService.revoke(grantId);
    if (r && r.ok === false) {
      return bad('Failed to revoke grant: ' + (r.error || 'unknown error'));
    }
    return { ok: true };
  });
}

module.exports = { register };
