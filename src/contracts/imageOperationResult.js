// src/contracts/imageOperationResult.js
// ============================================================================
// R3.1 — Canonical boundary contract for any "image operation finished"
// envelope returned by a backend (sharp, realesrgan, isnet, birefnet,
// inpaint, etc.) and consumed by the renderer or by an IPC handler.
//
// The shape is *fixed* — no consumer may guess field names and no
// backend may interpret `null` as success. The invariant is:
//
//   ok === true   ⇒  error === null  AND  outputPath is a non-empty string
//   ok === false  ⇒  error is a non-empty string
//   warnings      is always an array (never null/undefined)
//
//   `validateImageOperationResult(v)` returns
//     { ok: true,  value: <normalized copy> }
//     { ok: false, errors: [...], value: <raw or partial> }
//   and never throws. Callers can rely on it as an IPC-boundary gate.
//
// Extracted to its own file so the contract is the single source of
// truth and so consumers can `require('./imageOperationResult')`
// without pulling in any backend module.
// ============================================================================

/**
 * @typedef {'sharp' | 'realesrgan' | 'isnet' | 'birefnet' | 'inpaint' | 'telea' | null} ImageBackend
 *
 * @typedef {object} ImageOperationResult
 * @property {boolean} ok                              True iff the operation succeeded.
 * @property {string|null} sourcePath                  Absolute source path (or null if not applicable).
 * @property {string|null} outputPath                  Absolute output path (null when ok:false).
 * @property {ImageBackend} backend                    The backend that produced the result (or null on failure).
 * @property {string|null} model                       The model identifier (or null if not applicable).
 * @property {object|null} resolvedSettings            The actual settings applied to the backend.
 * @property {string[]} warnings                       Non-fatal warnings (e.g. "metadata stripped"). Always an array.
 * @property {string|null} error                        Human-readable error message (null on success).
 * @property {object|null} diagnostics                 Optional diagnostics (timings, sizes, model hash, etc.).
 */

/** Allowlist of accepted backend identifiers. */
const BACKEND_VALUES = new Set([
  'sharp',
  'realesrgan',
  'isnet',
  'birefnet',
  'inpaint',
  'telea',
]);

/** Fields the contract guarantees on a normalized result. */
const SHAPE = Object.freeze([
  'ok', 'sourcePath', 'outputPath', 'backend', 'model',
  'resolvedSettings', 'warnings', 'error', 'diagnostics',
]);

/**
 * Cheap shape check. Returns true if the value is *plausibly* an
 * `ImageOperationResult` (object with the `ok` boolean). It does not
 * validate invariants — use `validateImageOperationResult` for that.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isImageOperationResult(v) {
  return !!v && typeof v === 'object' && typeof v.ok === 'boolean';
}

/**
 * Normalize a value to the `ImageOperationResult` shape:
 *   - trims `sourcePath`/`outputPath` strings (empty becomes null)
 *   - coerces `backend` to the allowlist (unknown → null)
 *   - coerces `warnings` to a `string[]` (non-array → [])
 *   - coerces `error` empty to null
 *   - drops unknown fields (forwards-compat safety)
 *
 * @param {*} v
 * @returns {object}
 */
function normalize(v) {
  const raw = (v && typeof v === 'object') ? v : {};
  const trimStr = (s) => (typeof s === 'string') ? (s.trim() || null) : null;
  const backend = (typeof raw.backend === 'string' && BACKEND_VALUES.has(raw.backend))
    ? raw.backend
    : null;
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w) => typeof w === 'string')
    : [];
  const out = {
    ok: !!raw.ok,
    sourcePath: trimStr(raw.sourcePath),
    outputPath: trimStr(raw.outputPath),
    backend,
    model: (typeof raw.model === 'string' && raw.model.trim()) ? raw.model.trim() : null,
    resolvedSettings: (raw.resolvedSettings && typeof raw.resolvedSettings === 'object'
                       && !Array.isArray(raw.resolvedSettings))
      ? raw.resolvedSettings
      : null,
    warnings,
    error: (typeof raw.error === 'string' && raw.error.trim()) ? raw.error.trim() : null,
    diagnostics: (raw.diagnostics && typeof raw.diagnostics === 'object'
                  && !Array.isArray(raw.diagnostics))
      ? raw.diagnostics
      : null,
  };
  return out;
}

/**
 * Validate a value against the `ImageOperationResult` contract.
 * Never throws.
 *
 * @param {*} v
 * @returns {{ok: boolean, value: object, errors: string[]}}
 */
function validateImageOperationResult(v) {
  if (v === null || v === undefined) {
    return { ok: false, value: normalize(null), errors: ['ImageOperationResult: input is null/undefined'] };
  }
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, value: normalize(v), errors: ['ImageOperationResult: input is not a plain object'] };
  }
  if (typeof v.ok !== 'boolean') {
    return { ok: false, value: normalize(v), errors: ['ImageOperationResult: field "ok" must be a boolean'] };
  }
  const value = normalize(v);
  const errors = [];
  if (value.ok === true) {
    if (value.error !== null) {
      errors.push('ImageOperationResult: ok:true requires error:null');
    }
    if (typeof value.outputPath !== 'string' || !value.outputPath) {
      errors.push('ImageOperationResult: ok:true requires a non-empty outputPath');
    }
  } else {
    if (typeof value.error !== 'string' || !value.error) {
      errors.push('ImageOperationResult: ok:false requires a non-empty error');
    }
  }
  if (!Array.isArray(value.warnings)) {
    errors.push('ImageOperationResult: warnings must be an array (got ' + typeof value.warnings + ')');
  }
  return errors.length ? { ok: false, value, errors } : { ok: true, value, errors: [] };
}

module.exports = {
  validateImageOperationResult,
  normalize,
  isImageOperationResult,
  BACKEND_VALUES,
  SHAPE,
};
