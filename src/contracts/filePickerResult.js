// src/contracts/filePickerResult.js
// ============================================================================
// R3.1 — Canonical boundary contract for any "user picked a file (or
// canceled)" envelope returned by a file-picker IPC handler.
// R3.2.AuditFix — added 4th branch (ok:false && canceled:true) for the
// REAL cancel envelope produced by `file:pick`.
//
// The invariant is (4 branches):
//
//   ok:true,  canceled:false  ⇒  path is a non-empty string, error:null
//                              (success: user picked a file)
//   ok:true,  canceled:true   ⇒  path:null, error:null
//                              (hypothetical: dialog opened, no file selected
//                              — currently unused in real IPC traffic)
//   ok:false, canceled:true   ⇒  path:null, error:null
//                              (cancel: user dismissed the dialog —
//                              the REAL cancel envelope from `file:pick`)
//   ok:false, canceled:false  ⇒  error is a non-empty string, path:null
//                              (real failure: EACCES, ENOENT, etc.)
//
//   `path` and `error` are mutually exclusive. Consumers MUST check
//   `result.ok` first, then `result.canceled` for the cancel branch.
//
// Extracted to its own file so the contract is the single source of
// truth and so consumers can `require('./filePickerResult')` without
// pulling in any IPC handler module.
// ============================================================================

/**
 * @typedef {object} FilePickerResult
 * @property {boolean} ok          True iff the picker returned a usable answer.
 * @property {boolean} canceled    True iff the user dismissed the dialog. Set on both success-cancel (hypothetical, currently unused) and failure-cancel (the REAL cancel envelope from `file:pick`).
 * @property {string|null} path    Absolute path the user picked (null on cancel or error).
 * @property {string|null} error   Human-readable error message (null on success/cancel).
 */

/** Fields the contract guarantees on a normalized result. */
const SHAPE = Object.freeze(['ok', 'canceled', 'path', 'error']);

/**
 * Cheap shape check. Returns true if the value is *plausibly* a
 * `FilePickerResult` (object with the `ok` boolean). Does not
 * validate invariants — use `validateFilePickerResult` for that.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isFilePickerResult(v) {
  return !!v && typeof v === 'object' && typeof v.ok === 'boolean';
}

/**
 * Normalize a value to the `FilePickerResult` shape:
 *   - trims `path` (empty → null) and `error` (empty → null)
 *   - coerces `canceled` to a boolean
 *
 * @param {*} v
 * @returns {object}
 */
function normalize(v) {
  const raw = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const path = (typeof raw.path === 'string' && raw.path.trim()) ? raw.path.trim() : null;
  const error = (typeof raw.error === 'string' && raw.error.trim()) ? raw.error.trim() : null;
  return {
    ok: !!raw.ok,
    canceled: !!raw.canceled,
    path,
    error,
  };
}

/**
 * Validate a value against the `FilePickerResult` contract.
 * Never throws.
 *
 * @param {*} v
 * @returns {{ok: boolean, value: object, errors: string[]}}
 */
function validateFilePickerResult(v) {
  if (v === null || v === undefined) {
    return { ok: false, value: normalize(null), errors: ['FilePickerResult: input is null/undefined'] };
  }
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, value: normalize(v), errors: ['FilePickerResult: input is not a plain object'] };
  }
  if (typeof v.ok !== 'boolean') {
    return { ok: false, value: normalize(v), errors: ['FilePickerResult: field "ok" must be a boolean'] };
  }
  const value = normalize(v);
  const errors = [];
  if (value.ok === true) {
    if (value.error !== null) {
      errors.push('FilePickerResult: ok:true requires error:null');
    }
    if (value.canceled === true) {
      if (value.path !== null) {
        errors.push('FilePickerResult: canceled:true requires path:null');
      }
    } else if (typeof value.path !== 'string' || !value.path) {
      errors.push('FilePickerResult: ok:true && canceled:false requires a non-empty path');
    }
  } else {
    // ok:false branches:
    //   (a) canceled:true  → user dismissed the dialog → error:null, path:null
    //   (b) real failure   → error is non-empty, path:null
    if (value.canceled === true) {
      if (value.error !== null) {
        errors.push('FilePickerResult: canceled:true requires error:null');
      }
      if (value.path !== null) {
        errors.push('FilePickerResult: canceled:true requires path:null');
      }
    } else {
      if (typeof value.error !== 'string' || !value.error) {
        errors.push('FilePickerResult: ok:false && canceled:false requires a non-empty error');
      }
      if (value.path !== null) {
        errors.push('FilePickerResult: ok:false requires path:null (path+error are mutually exclusive)');
      }
    }
  }
  return errors.length ? { ok: false, value, errors } : { ok: true, value, errors: [] };
}

module.exports = {
  validateFilePickerResult,
  normalize,
  isFilePickerResult,
  SHAPE,
};
