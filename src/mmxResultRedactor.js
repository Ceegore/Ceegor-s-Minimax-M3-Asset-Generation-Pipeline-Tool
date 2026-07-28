// src/mmxResultRedactor.js
// ============================================================================
// R2.4 — Centralise every "redact a runMmx result" code path into a
// single helper. The redaction contract is:
//
//   • `redactArgv(args)` — strip / replace any api_key-shaped value in
//     the spawn argv (single-token `--api-key=`, two-token
//     `--api-key VALUE`, plus the Authorization / MMX_API_KEY env
//     forms). The output is suitable for `r.argv` in IPC envelopes
//     and for log forwarding.
//
//   • `redactCmdLine(s)` — same as `redactArgv([s])[0]` but
//     string-friendly (the full `$ cmd arg1 arg2` line).
//
//   • `redactStderrChunk(s)` — string-friendly; safe to call on
//     every stdout / stderr chunk before forwarding to the
//     renderer's log pane / IPC chunk stream.
//
//   • `redactRunMmxResult(r)` — wrap a whole runMmx result envelope
//     (`{ ok, code, stderr, argv, command, … }`) so any string field
//     in the envelope is redacted. The `argv` field is also walked
//     as an array.
//
// Extracted to its own file so src/mmx.js can stay under its frozen
// 542-LOC SIZE-BUDGET.
// ============================================================================

const { deepRedact, redactString } = require('./deepRedactor');

/**
 * Redact a runMmx result envelope so it can safely be returned via
 * IPC / written to the log. The original is NOT mutated; a new
 * object is returned.
 *
 * @param {object} r - runMmx result envelope
 * @returns {object}  a deep-redacted copy
 */
function redactRunMmxResult(r) {
  if (!r || typeof r !== 'object') return r;
  return deepRedact(r);
}

/**
 * Redact a single string chunk. Pass-through for non-strings.
 */
function redactStderrChunk(s) {
  return redactString(s);
}

/**
 * Redact an argv array (the spawn arguments) so the IPC envelope
 * and the onLog stream never carry the raw key. The original
 * array is NOT mutated.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
function redactArgv(argv) {
  if (!Array.isArray(argv)) return argv;
  return deepRedact(argv);
}

/**
 * Redact a `$ cmd arg1 arg2` command-line string.
 */
function redactCmdLine(cmdLine) {
  return redactString(cmdLine);
}

module.exports = { redactRunMmxResult, redactStderrChunk, redactArgv, redactCmdLine };
