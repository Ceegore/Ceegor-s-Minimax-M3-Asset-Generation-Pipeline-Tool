// src/mmxArgSanitizer.js
// ============================================================================
// R2.4 — Strip any `--api-key=VALUE` or `--api-key VALUE` that the renderer
// may have smuggled into its `args`. Without this, a malicious or buggy
// renderer could put the api key in the spawn argv — and on Windows, any
// local process can read every other process's argv via WMI for the
// entire call duration.
//
// Extracted to its own file (closes R0.1-003.B and the related H7-013
// scan) so src/mmx.js can stay under its frozen 542-LOC SIZE-BUDGET.
//
// Note: this is purely a defence against a renderer that TRIES to
// bypass the SessionCredentialStore flow. The legitimate API key
// routing (--api-key argv fallback when ~/.mmx sync fails) still runs
// in its own controlled block in runMmx — that path uses the Main-side
// `apiKey` parameter, not the renderer's `args`.
// ============================================================================

/**
 * Strip any `--api-key=VALUE` (single-token = form) or `--api-key VALUE`
 * (two-token form) that the renderer may have smuggled into its `args`.
 * Returns a new array; the original is left untouched so the caller can
 * still inspect it (e.g. for IPC logging).
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function stripRendererSuppliedApiKey(args) {
  if (!Array.isArray(args)) return args;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === 'string') {
      // Single-token form: "--api-key=VALUE"
      if (/^--api(-?)key=/i.test(a)) {
        continue;
      }
      // Two-token form: "--api-key" followed by "VALUE"
      if (/^--api(-?)key$/i.test(a)) {
        i++;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

module.exports = { stripRendererSuppliedApiKey };
