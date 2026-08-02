// main/services/batchUnitsGate.js
// ============================================================================
// H-046 (_5 audit) — Main-side authoritative billable-units cost cap.
//
// The `batch_max_units` cap (config.txt, clamped 1..10000, default 200) used
// to be enforced ONLY by the renderer's batchManager gate — and even that was
// broken: the public config DTO never carried the field, so the renderer
// computed `parseInt(undefined) || 200` and a user-configured cap was
// silently replaced by 200. A manipulated (or simply buggy) renderer could
// bypass the cap entirely because Main never checked it.
//
// This service is the ONE Main-side authority:
//   • clampBatchMaxUnits(raw) — the canonical clamp, shared with the public
//     config DTOs so the safe numeric field can't drift out of sync again.
//   • maxBatchUnits()        — reads the authoritative config.txt value.
//   • checkMmxUnits(args)    — pre-spawn gate for mmx generation calls:
//     units = the `--n` value (default 1). Applied to image/speech/music/
//     video subcommands in BOTH mmx:run and mmx:run:job.
//   • checkProviderUnits(params) — pre-submit gate for providers:generate:
//     units = params.n / params.num_outputs (default 1).
//
// The renderer keeps its aggregate items×variants×n estimate gate for good
// UX (it can block a whole queue before the first paid call), but it is no
// longer the protection boundary — every individual paid call is re-checked
// here against the authoritative config, so `batch_max_units=3` blocks a
// 4-unit request in the live, batch, direct AND provider paths even with a
// manipulated renderer.
// ============================================================================

const cfgMod = require('../../src/config');

// Mirrors src/config.js parse() and main/models/ConfigSchema.js sanitize():
// integers 1..10000; garbage/absent falls back to the default 200.
function clampBatchMaxUnits(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10000) : 200;
}

// The authoritative cap, read fresh from config.txt on every call so a
// Settings save takes effect immediately (no cached stale cap).
function maxBatchUnits() {
  try {
    const cfg = cfgMod.read();
    return clampBatchMaxUnits(cfg && cfg.batch_max_units);
  } catch (_) {
    return 200; // unreadable config: fall back to the safe default
  }
}

// Subcommands that spend paid generation quota. quota/voices/etc. are free
// and never gated here.
const GENERATION_SUBCOMMANDS = new Set(['image', 'speech', 'music', 'video']);

/**
 * Pre-spawn cost gate for an mmx CLI call.
 * @param {string[]} args - the sanitized argv (args[0] = subcommand).
 * @returns {string|null} an error message when the call would exceed the
 *   cap, else null (allowed).
 */
function checkMmxUnits(args) {
  if (!Array.isArray(args) || !GENERATION_SUBCOMMANDS.has(args[0])) return null;
  let units = 1;
  const i = args.indexOf('--n');
  if (i !== -1) {
    const n = parseInt(args[i + 1], 10);
    // A malformed --n value is left for the CLI's own validation; only a
    // parseable count participates in the cost check.
    if (Number.isFinite(n) && n > 0) units = n;
  }
  const cap = maxBatchUnits();
  if (units > cap) {
    return `mmx: this call would generate ${units} billable unit(s) — over the ${cap}-unit limit (batch_max_units in config.txt). Lower --n or raise the limit.`;
  }
  return null;
}

/**
 * Pre-submit cost gate for a cloud-provider generation request.
 * @param {object|null|undefined} params - req.params from providers:generate.
 * @returns {string|null} an error message when the request would exceed the
 *   cap, else null (allowed).
 */
function checkProviderUnits(params) {
  let units = 1;
  if (params && typeof params === 'object') {
    const raw = params.n !== undefined ? params.n : params.num_outputs;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) units = n;
  }
  const cap = maxBatchUnits();
  if (units > cap) {
    return `provider: this request would generate ${units} billable unit(s) — over the ${cap}-unit limit (batch_max_units in config.txt). Lower n/num_outputs or raise the limit.`;
  }
  return null;
}

module.exports = { clampBatchMaxUnits, maxBatchUnits, checkMmxUnits, checkProviderUnits };
