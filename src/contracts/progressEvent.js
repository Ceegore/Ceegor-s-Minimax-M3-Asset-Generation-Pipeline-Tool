// src/contracts/progressEvent.js
// ============================================================================
// R3.1 — Canonical boundary contract for any progress event emitted
// by a backend (download, install, upscale, remove-bg, resize, …)
// and consumed by the renderer (progress bars, status toasts, etc.).
//
// The invariant is:
//
//   pct        is a finite number in [0, 100]
//   phase      is a non-empty string from PHASE_VALUES
//   operation  is a non-empty string
//   runId      is a non-empty string (matches the run that emitted it)
//
//   Consumers MUST use `pct` for fill, `phase` for icon, and `runId`
//   to drop stale events when a new run is started.
//
// Extracted to its own file so the contract is the single source of
// truth and so consumers can `require('./progressEvent')` without
// pulling in any backend module.
// ============================================================================

/**
 * @typedef {'download' | 'verify' | 'extract' | 'init' | 'infer' | 'encode' | 'finalize' | 'done' | 'error'} ProgressPhase
 *
 * @typedef {object} ProgressEvent
 * @property {ProgressPhase} phase       Coarse-grained progress phase (icon/label).
 * @property {number} pct                Percent complete, finite, 0..100.
 * @property {string} operation          The long-running operation (e.g. "upscale", "remove-bg", "resize").
 * @property {string} runId              Stable identifier for the run emitting this event.
 * @property {string|null} message       Optional human-readable status line.
 * @property {number|null} bytesDownloaded  Optional byte counter (for download-ish phases).
 * @property {number|null} bytesTotal       Optional total bytes.
 */

/** Allowlist of coarse progress phases. */
const PHASE_VALUES = new Set([
  'init',
  'download',
  'verify',
  'extract',
  'infer',
  'encode',
  'finalize',
  'done',
  'error',
]);

/** Fields the contract guarantees on a normalized event. */
const SHAPE = Object.freeze([
  'phase', 'pct', 'operation', 'runId', 'message', 'bytesDownloaded', 'bytesTotal',
]);

/**
 * Cheap shape check. Returns true if the value is *plausibly* a
 * `ProgressEvent` (object with the `pct` number). Does not validate
 * invariants — use `validateProgressEvent` for that.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isProgressEvent(v) {
  return !!v && typeof v === 'object' && typeof v.pct === 'number';
}

/**
 * Coerce a value to a finite pct in [0, 100]. NaN/Infinity → 0.
 *
 * @param {*} v
 * @returns {number}
 */
function _coercePct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

/**
 * Normalize a value to the `ProgressEvent` shape.
 *
 * @param {*} v
 * @returns {object}
 */
function normalize(v) {
  const raw = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const phase = (typeof raw.phase === 'string' && PHASE_VALUES.has(raw.phase)) ? raw.phase : 'init';
  const op = (typeof raw.operation === 'string' && raw.operation.trim()) ? raw.operation.trim() : '';
  const runId = (typeof raw.runId === 'string' && raw.runId.trim()) ? raw.runId.trim() : '';
  return {
    phase,
    pct: _coercePct(raw.pct),
    operation: op,
    runId,
    message: (typeof raw.message === 'string' && raw.message.trim()) ? raw.message.trim() : null,
    bytesDownloaded: (typeof raw.bytesDownloaded === 'number' && Number.isFinite(raw.bytesDownloaded))
      ? raw.bytesDownloaded
      : null,
    bytesTotal: (typeof raw.bytesTotal === 'number' && Number.isFinite(raw.bytesTotal))
      ? raw.bytesTotal
      : null,
  };
}

/**
 * Validate a value against the `ProgressEvent` contract.
 * Never throws.
 *
 * @param {*} v
 * @returns {{ok: boolean, value: object, errors: string[]}}
 */
function validateProgressEvent(v) {
  if (v === null || v === undefined) {
    return { ok: false, value: normalize(null), errors: ['ProgressEvent: input is null/undefined'] };
  }
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, value: normalize(v), errors: ['ProgressEvent: input is not a plain object'] };
  }
  const value = normalize(v);
  const errors = [];
  if (typeof v.pct !== 'number' || !Number.isFinite(v.pct)) {
    errors.push('ProgressEvent: field "pct" must be a finite number');
  } else if (v.pct < 0 || v.pct > 100) {
    errors.push('ProgressEvent: field "pct" must be in [0, 100]');
  }
  if (typeof v.phase !== 'string' || !PHASE_VALUES.has(v.phase)) {
    errors.push('ProgressEvent: field "phase" must be one of ' + Array.from(PHASE_VALUES).join(', '));
  }
  if (typeof v.operation !== 'string' || !value.operation) {
    errors.push('ProgressEvent: field "operation" must be a non-empty string');
  }
  if (typeof v.runId !== 'string' || !value.runId) {
    errors.push('ProgressEvent: field "runId" must be a non-empty string');
  }
  return errors.length ? { ok: false, value, errors } : { ok: true, value, errors: [] };
}

module.exports = {
  validateProgressEvent,
  normalize,
  isProgressEvent,
  PHASE_VALUES,
  SHAPE,
};
