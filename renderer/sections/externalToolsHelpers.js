// renderer/sections/externalToolsHelpers.js
// ============================================================================
// R3.3.AuditFix-PP — External-Tools pane helpers (pure functions, R3.3).
//
// The settings pane (section03_Settings_tab_panes.js) embeds two
// pieces of pure logic in a closure: name-duplicate validation
// and exe-basename auto-fill. Extracted to this module so:
//   1. The pane can `require` them (single source of truth).
//   2. Tests can import + invoke the REAL logic (no replica).
//   3. Future cards can re-use them (e.g. a CLI that validates
//      external_tools before saving config.txt).
//
// R3.3.AuditFix (this card) — the original R3.3 tests REPLICATED
// this logic in `makeValidate` / `makeAutoFillBasename` instead
// of importing the real code. That meant a future refactor of
// the pane (without updating the test replica) would silently
// diverge: tests would still pass, the source would be wrong.
// Now the tests import these helpers directly, so they
// automatically stay in sync with the pane.
// ============================================================================

'use strict';

/**
 * Validate a list of external-tool draft entries. Returns an
 * array of human-readable error messages; empty array means
 * the draft is valid.
 *
 * Currently checks:
 *   - case-insensitive duplicate display name (UI-009 Soll-Punkt 3)
 *
 * @param {Array<{name?: string}>} toolsDraft
 * @returns {string[]}
 */
function validateExternalTools(toolsDraft) {
  const errs = [];
  const seen = new Set();
  for (let i = 0; i < toolsDraft.length; i++) {
    const n = (toolsDraft[i] && toolsDraft[i].name || '').trim().toLowerCase();
    if (n && seen.has(n)) {
      errs.push('Two external tools share the same display name: "' + toolsDraft[i].name.trim() + '" (case-insensitive).');
    } else if (n) {
      seen.add(n);
    }
  }
  return errs;
}

/**
 * Compute the auto-fill display name for a freshly picked .exe.
 * Returns null when the user has already typed a name (don't
 * overwrite); returns the basename without the .exe extension
 * (case-insensitive) when the name field is empty.
 *
 * UI-009 Soll-Punkt 2: "Basename ohne `.exe` automatisch in
 * leeres bzw. noch auto-generiertes Namensfeld".
 *
 * @param {string} currentName  the value currently in the name input
 * @param {string} pickedPath  the absolute path the user picked
 * @returns {string|null}      the auto-filled name, or null to skip
 */
function computeAutoFillName(currentName, pickedPath) {
  if (currentName && currentName.trim()) return null;
  return (String(pickedPath || '').split(/[\\/]/).pop() || '').replace(/\.exe$/i, '');
}

/**
 * Test if a name is a case-insensitive duplicate of another row.
 * Used by the pane to mark the name input as `.invalid` on the
 * fly (R3.3 visual feedback).
 *
 * @param {string} name           the value to test
 * @param {number} selfIdx        the row's own index (excluded)
 * @param {Array<{name?: string}>} toolsDraft
 * @returns {boolean}
 */
function isDuplicateName(name, selfIdx, toolsDraft) {
  const n = (name || '').trim().toLowerCase();
  if (!n) return false;
  return toolsDraft.some((t, j) => j !== selfIdx && (t && t.name || '').trim().toLowerCase() === n);
}

const _exports = {
  validateExternalTools,
  computeAutoFillName,
  isDuplicateName,
  // R3.3.AuditFix-PP-2 (fix): short-name aliases. The pane
  // (section03_Settings_tab_panes.js) accesses the helpers via
  // `H.v` / `H.a` / `H.d` to keep the call sites short. The
  // inline-fallback in section03 also uses these short keys,
  // so the module must export BOTH long names (for tests + future
  // consumers) AND short names (for the existing pane code).
  // Without this, the previous R3.3.AuditFix-PP-2 globalThis
  // init would silently break the pane: every validate() would
  // throw `H.v is not a function`, the section04 try/catch would
  // toast an error, and the duplicate-name check would never
  // surface to the user.
  v: validateExternalTools,
  a: computeAutoFillName,
  d: isDuplicateName,
};
// Node/CommonJS context (tests, require()).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = _exports;
}
// Browser context (<script> tag) — KGO4-012.
if (typeof globalThis !== 'undefined') {
  globalThis.ExternalToolsHelpers = _exports;
}
