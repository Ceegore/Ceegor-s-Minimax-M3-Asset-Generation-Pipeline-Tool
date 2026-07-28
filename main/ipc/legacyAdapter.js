// main/ipc/legacyAdapter.js
// ============================================================================
// R3.2 — Legacyadapter: bridge between Main-side IPC handlers that use
// the legacy `{ ok, path, grantId, capabilities, error }` envelope and
// the canonical `FilePickerResult` contract from src/contracts/.
//
// The adapter:
//   1. Validates the IPC result's 4 contract fields (`ok`, `canceled`,
//      `path`, `error`) against `validateFilePickerResult` — drift is
//      caught BEFORE the result reaches the renderer.
//   2. Preserves the IPC-specific extension fields (`grantId`,
//      `capabilities`) — these are not part of the contract but the
//      renderer uses them for grant authorisation (R1.2 Path Grants).
//   3. Returns a clean error envelope on drift (with the validation
//      errors joined into the `error` field) — the renderer sees a
//      visible failure instead of a malformed envelope.
//
// Per R3.2 spec: "Adapter dürfen `path`→`outputPath` lesen, aber intern
// nur kanonisch ausgeben. Pro Karte genau ein IPC ... kein
// Consumerupdate in derselben Karte." The adapter is the single place
// where the contract-vs-legacy reconciliation happens. The IPC handler
// is wrapped: the inner `try { ... } catch (e) { ... }` is removed
// (the wrap provides equivalent throw-catching) and the result is
// passed through `adaptFilePickerResult` before reaching the renderer.
// ============================================================================

const { validateFilePickerResult } = require('../../src/contracts/filePickerResult');
const { validateImageOperationResult } = require('../../src/contracts/imageOperationResult');

/**
 * Validate an IPC handler's return value against the FilePickerResult
 * contract. Preserves the 4 contract fields and any extra IPC-specific
 * fields (grantId, capabilities, etc.). On drift, returns a clean error
 * envelope with the validation errors in the `error` field.
 *
 * @param {object} result  The IPC handler's return value.
 * @returns {object}      The result, possibly patched (extra fields preserved).
 */
function adaptFilePickerResult(result) {
  // Defensive: a handler that throws synchronously or returns null
  // gets a clean error envelope instead of leaking undefined.
  if (result === null || result === undefined) {
    return { ok: false, error: 'IPC returned null/undefined (no envelope)' };
  }
  if (typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, error: 'IPC returned non-object: ' + typeof result };
  }
  // Extract the 4 contract fields and validate.
  const validated = validateFilePickerResult({
    ok: result.ok,
    canceled: result.canceled,
    path: result.path,
    error: result.error,
  });
  if (!validated.ok) {
    // Drift detected. The renderer gets a visible failure, not a
    // malformed envelope. The original result is preserved under
    // `_original` for diagnostics (not part of the contract).
    return {
      ok: false,
      error: 'IPC envelope drift: ' + validated.errors.join('; '),
      _original: result,
    };
  }
  // Validated: the IPC's envelope matches the 4 contract fields. We
  // return the ORIGINAL result (preserving the IPC's exact shape,
  // including missing fields) — the adapter is a VALIDATOR, not a
  // transformer. The renderer is not updated in R3.2 (per spec: "kein
  // Consumerupdate in derselben Karte"), so we must not add fields
  // the IPC didn't send.
  return result;
}

/**
 * Wrap an async IPC handler so its return value passes through
 * `adaptFilePickerResult` before reaching the renderer. The wrapper
 * catches synchronous throws and rejected promises and returns a
 * clean error envelope — never lets a raw exception leak to IPC.
 *
 * @param {Function} handler  Async IPC handler (e, args) => Promise<object>
 * @returns {Function}        Wrapped handler.
 */
function wrapFilePickerHandler(handler) {
  return async function wrappedHandler(e, args) {
    try {
      const result = await handler(e, args);
      return adaptFilePickerResult(result);
    } catch (err) {
      return { ok: false, error: 'IPC handler threw: ' + (err && err.message || err) };
    }
  };
}

/**
 * Adapt a legacy `{ ok, path, error, canceled }` inpaint-IPC envelope
 * to the canonical `ImageOperationResult` contract. The contract
 * requires 9 fields; the legacy IPC sends 3-4. On drift, returns a
 * clean error envelope with `_original` for diagnostics.
 *
 * Mapping:
 *   - `path` (legacy) → `outputPath` (contract)
 *   - missing fields default to `null` (or empty array for `warnings`)
 *   - `ok:true` requires `outputPath` non-empty; `ok:false` requires
 *     `error` non-empty
 *   - `backend` is taken from the `backend` parameter (NOT hardcoded)
 *     so the same adapter works for both runOnnx (inpaint) and
 *     runTelea (telea). R3.2.2.AuditFix: previously hardcoded to
 *     'inpaint', which was a contract violation if used for telea.
 *
 * @param {object} result          The IPC handler's return value.
 * @param {string} [backend='inpaint']  The contract backend value ('inpaint'|'telea').
 * @returns {object}              The result, possibly patched (extra fields preserved).
 */
function adaptInpaintResult(result, backend = 'inpaint') {
  if (result === null || result === undefined) {
    return { ok: false, error: 'IPC returned null/undefined (no envelope)' };
  }
  if (typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, error: 'IPC returned non-object: ' + typeof result };
  }
  // Map legacy `path` field to contract `outputPath`. Other
  // contract fields default to null/empty (handled by the validator).
  // R3.2.2.AuditFix: `diagnostics` is preserved from `result.diagnostics`
  // (not hardcoded null) — the adapter is a VALIDATOR, not a
  // TRANSFORMER, and silently dropping a diagnostics object would
  // violate that pattern. The normalizer drops non-object values
  // (numbers, strings, etc.) to `null` per the contract.
  // R3.2.3: `error` falls back to `result.stderr` for legacy handlers
  // that report failures via `stderr` instead of an explicit `error`
  // field (e.g. `isnetbg:run` envelope is `{ok, code, stderr,
  // outputPath}`). If both are absent, the validator REJECTS the
  // envelope (ok:false requires a non-empty error) — the original
  // result is preserved in `_original` for diagnostics.
  // R3.2.3.AuditFix: the stderr-fallback is ONLY active for
  // `ok:false` results. For `ok:true` results, a non-empty `stderr`
  // is treated as a non-fatal warning (promoted to `warnings`),
  // not as an `error` (which would violate the ok:true invariant).
  const isFailure = result.ok === false;
  const errorFromResult = (typeof result.error === 'string' && result.error.trim())
    ? result.error
    : (isFailure && typeof result.stderr === 'string' && result.stderr.trim())
      ? result.stderr
      : null;
  // R3.2.3.AuditFix: on success, non-empty stderr is treated as a
  // warning, not an error. This handles the isnetbg:run shape where
  // stderr may carry non-fatal CLI output (model load info, etc.)
  // even when the operation succeeded.
  // KGO7-010: keep machine noise OUT of `warnings[]`. A successful ONNX
  // run always prints ANSI-coloured onnxruntime chatter ("Some nodes were
  // not assigned to the preferred execution providers…") to stderr. Now
  // that the renderer surfaces `warnings[]` to the user as toasts
  // (KGO7-006), promoting that verbatim would spray ORT internals — ANSI
  // escapes and all — on EVERY successful background removal. Only text a
  // human should read belongs in `warnings[]`; the raw stream is still
  // available on `stderr` for diagnostics.
  const humanStderr = (typeof result.stderr === 'string' ? result.stderr : '')
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/\[[WIV]:onnxruntime/.test(t)) return false;
      if (/VerifyEachNodeIsAssignedToAnEp|Rerunning with verbose output/.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();
  const stderrWarnings = (humanStderr && !isFailure && !errorFromResult)
    ? [humanStderr]
    : [];
  // KGO9-002: MERGE, never replace. The handler's own structured warnings used
  // to be destroyed here: `validated.value` is spread OVER `result` at the end
  // of this function, so a `warnings` array built from stderr alone (usually
  // []) overwrote whatever the handler returned. image:optimize is routed
  // through this adapter, so its "re-encoding would have produced a LARGER
  // file; the original was kept" notice never reached the renderer — measured
  // `warnings: []` at the IPC boundary while the module returned the message,
  // which also made the reportIpcWarnings() call on that path a no-op.
  // image:resize is NOT adapted, which is why its clamp notice always arrived.
  const ownWarnings = Array.isArray(result.warnings)
    ? result.warnings.filter((w) => typeof w === 'string' && w.trim())
    : [];
  const warningsFromResult = [...ownWarnings, ...stderrWarnings];
  const validated = validateImageOperationResult({
    ok: result.ok,
    sourcePath: null,           // inpaint doesn't expose sourcePath
    outputPath: result.path || result.outputPath,  // legacy `path` OR already-canonical `outputPath`
    backend,                    // R3.2.2.AuditFix: parametrised, not hardcoded
    model: null,                // inpaint IPC doesn't expose model
    resolvedSettings: null,     // not exposed in legacy envelope
    warnings: warningsFromResult,  // R3.2.3.AuditFix: stderr-as-warning on success
    error: errorFromResult,     // R3.2.3: stderr fallback (only on failure)
    diagnostics: result.diagnostics,  // R3.2.2.AuditFix: preserved (was null)
  });
  if (!validated.ok) {
    return {
      ok: false,
      error: 'IPC envelope drift: ' + validated.errors.join('; '),
      _original: result,
    };
  }
  // Validated: preserve the legacy fields the renderer might still use
  // (e.g. `path` is the original IPC field name; consumers may
  // expect it on the wire). R3.2 spec: "kein Consumerupdate in
  // derselben Karte" — so we keep `path` as an alias.
  return { ...result, ...validated.value, outputPath: validated.value.outputPath, path: result.path };
}

/**
 * Wrap an async inpaint-IPC handler so its return value passes
 * through `adaptInpaintResult`. Throws are caught and converted to a
 * clean `{ok: false, error}` envelope.
 *
 * R3.2.2.AuditFix: the `backend` parameter makes the wrapper
 * reusable for both runOnnx (inpaint) and runTelea (telea). Each
 * caller specifies its own backend identifier so the contract's
 * `backend` field reflects the real operation, not a hardcoded
 * default.
 *
 * R3.2.3: handler arity is preserved via `...args` so multi-arg
 * handlers (e.g. `isnetbg:run` with 4 positional args
 * `(srcPath, dstPath, opts, grantId)`) can be wrapped the same way
 * as single-arg handlers (e.g. `inpaint:runOnnx` with one
 * `(args)` object). No existing caller's argument shape changes
 * (inpaint:runOnnx / inpaint:runTelea continue to pass `(e, args)`).
 *
 * @param {Function} handler         Async IPC handler.
 * @param {string} [backend='inpaint']  The contract backend value.
 * @returns {Function}               Wrapped handler.
 */
function wrapInpaintHandler(handler, backend = 'inpaint') {
  return async function wrappedHandler(...args) {
    try {
      const result = await handler(...args);
      return adaptInpaintResult(result, backend);
    } catch (err) {
      return { ok: false, error: 'IPC handler threw: ' + (err && err.message || err) };
    }
  };
}

module.exports = {
  adaptFilePickerResult,
  wrapFilePickerHandler,
  adaptInpaintResult,
  wrapInpaintHandler,
};
