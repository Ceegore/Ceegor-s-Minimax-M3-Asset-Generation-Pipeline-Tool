// main/ipc/grantAuthorizer.js
// ============================================================================
// R1.5a.6 — shared IPC helper for grant-based path authorisation.
//
// Extracted from the duplicated `_authorizePath(grantId, operation, path)`
// helpers in:
//   - main/ipc/registerFileBrowserIpc.js (R1.3, the original)
//   - main/ipc/registerImageIpc.js (R1.5a.1)
//   - main/ipc/registerAudioIpc.js (R1.5a.2)
//   - main/ipc/registerUpscaleIpc.js (R1.5a.3)
//   - main/ipc/registerIsnetbgIpc.js (R1.5a.4)
//   - main/ipc/registerInpaintIpc.js (R1.5a.5)
//
// Behaviour:
//   - No grantId (or a non-string grantId) → {ok: false, error:
//     'grantId is required for <operation> on <path>'} (the handler
//     does NOT touch the filesystem).
//   - Valid grantId → delegates to PathGrantService.defaultService.authorize
//     with the given operation + path. The service's relation rules
//     (file-exact, directory-strict-descendant, directory-root-self-or-
//     descendant) and capability checks (read / write / rename / delete /
//     mkdir / copy / move) are enforced there.
//
// Why a shared module:
//   - Without this, a future fix to the grant-authorisation contract
//     would need to be applied in 6 places. A bug fix in one helper
//     but not the others is a SILENT security regression (the
//     "coincidental pass" pattern at the module level: one IPC
//     accepts a grant the other rejects, depending on which
//     helper copy is wrong).
//   - This module is the single source of truth for the
//     "no grantId → reject" + "unknown grantId → reject" contract
//     that R1.3 / R1.5a established. All 6 IPCs now use the same
//     error message format, the same gating, the same short-circuit
//     behaviour.
//
// Why a LAZY require (not module-level capture):
//   - The test harness (loadIpc() in every R1.x test file) clears
//     PathGrantService from the require cache and rebuilds the
//     defaultService singleton between tests. If grantAuthorizer
//     captured the defaultService at module load, it would hold a
//     stale reference after the test cleared the cache — the IPC
//     would authorise against the OLD defaultService, not the new
//     one. The require() at the top of the file is therefore
//     INTENTIONALLY inside the function (lazy lookup), so the
//     lookup always goes through Node's require cache and sees the
//     current defaultService. In production the singleton is
//     stable, so the per-call lookup is just a cached require hit
//     (~10ns overhead; negligible vs the ~microsecond cost of the
//     authorisation itself).
// ============================================================================

/**
 * Authorize a single path against a grant. Returns the canonical
 * path on success or `{ok:false, error}` on rejection.
 *
 * The grant kind's relation rule (file-exact, directory-strict-descendant,
 * directory-root-self-or-descendant) is enforced by PathGrantService.
 *
 * @param {string|undefined|null} grantId  The Main-minted grant id.
 * @param {string} operation              One of 'read' | 'write' | 'delete' |
 *                                        'mkdir' | 'rename' | 'copy' | 'move'.
 * @param {string} p                      The path to authorise.
 * @returns {{ok:true, [key:string]:any} | {ok:false, error:string}}
 */
function authorizePath(grantId, operation, p) {
  if (!grantId || typeof grantId !== 'string') {
    return { ok: false, error: 'grantId is required for ' + operation + ' on ' + p };
  }
  // Lazy require: see "Why a LAZY require" above. The lookup always
  // returns the CURRENT defaultService (after the test harness
  // clears the cache + rebuilds the singleton, the new instance is
  // returned on the next call).
  const { defaultService: pathGrantService } = require('../services/PathGrantService');
  return pathGrantService.authorize(grantId, { operation, path: p });
}

module.exports = { authorizePath };
