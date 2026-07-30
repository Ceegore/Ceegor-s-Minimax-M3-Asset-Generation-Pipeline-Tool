// src/services/OperationResult.js
// ============================================================================
// Shared Component 1F: Stage-aware OperationResult.
//
// Structured result type for multi-stage operations (pipeline, batch,
// provider generation). Each stage reports its own status; the overall
// result is derived from stage outcomes.
//
// Covers: MED-050, MED-012, FUNC-031.
//
// Rules (Section 21.3):
//   - Required stage failure → overall 'partial' or 'failed'
//   - Best-effort stage failure → warning, overall can still be 'ok'
//   - Pipeline import top-level ok derived from item results (MED-012)
//   - Fully transparent remove-BG = stage error, not warning (FUNC-031)
//
// Usage:
//   const { OperationResult } = require('./OperationResult');
//   const op = new OperationResult('image-generation');
//   op.addStage('generate', 'ok');
//   op.addStage('background-removal', 'error', 'Output is fully transparent');
//   op.addDeliverable('/path/to/output.png');
//   // op.ok === false (required stage failed)
// ============================================================================
'use strict';

/** Stage statuses. */
const STAGE_STATUS = Object.freeze({
  OK: 'ok',
  ERROR: 'error',
  SKIPPED: 'skipped',
  WARNING: 'warning',
});

/** Overall operation statuses. */
const OP_STATUS = Object.freeze({
  OK: 'ok',
  PARTIAL: 'partial',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

class OperationResult {
  /**
   * @param {string} operation - Name/type of the operation (e.g. 'pipeline-run').
   */
  constructor(operation) {
    this.operation = operation || 'unknown';
    /** @type {Array<{ name: string, status: string, error?: string, required: boolean }>} */
    this.stages = [];
    /** @type {string[]} Paths/URLs of delivered output files. */
    this.deliverables = [];
    /** @type {string[]} Non-fatal warnings. */
    this.warnings = [];
    /** @type {string|null} Overall status (computed). */
    this._statusOverride = null;
  }

  /**
   * Record a stage result.
   * @param {string} name - Stage name (e.g. 'upscale', 'remove-bg').
   * @param {string} status - One of STAGE_STATUS values.
   * @param {string} [error] - Error detail if status is 'error'.
   * @param {{ required?: boolean }} [opts] - Whether this stage is required (default true).
   * @returns {this}
   */
  addStage(name, status, error, opts) {
    const required = opts && opts.required !== undefined ? opts.required : true;
    this.stages.push({ name, status, error: error || undefined, required });
    return this;
  }

  /**
   * Add a delivered output file.
   * @param {string} filePath
   * @returns {this}
   */
  addDeliverable(filePath) {
    if (filePath) this.deliverables.push(filePath);
    return this;
  }

  /**
   * Add a warning.
   * @param {string} msg
   * @returns {this}
   */
  addWarning(msg) {
    if (msg) this.warnings.push(msg);
    return this;
  }

  /**
   * Force overall status (e.g. 'cancelled' from user action).
   * @param {string} status
   */
  setStatus(status) {
    this._statusOverride = status;
  }

  /**
   * Compute overall status from stages.
   * MED-050: required stage failure → not ok.
   * @returns {string} One of OP_STATUS values.
   */
  get status() {
    if (this._statusOverride) return this._statusOverride;

    const hasRequiredError = this.stages.some((s) => s.status === STAGE_STATUS.ERROR && s.required);
    const hasAnyError = this.stages.some((s) => s.status === STAGE_STATUS.ERROR);
    const hasOkStage = this.stages.some((s) => s.status === STAGE_STATUS.OK);

    if (hasRequiredError) return OP_STATUS.FAILED;
    if (hasAnyError && hasOkStage) return OP_STATUS.PARTIAL;
    if (hasAnyError) return OP_STATUS.FAILED;
    return OP_STATUS.OK;
  }

  /** True if the operation succeeded (all required stages ok). */
  get ok() {
    return this.status === OP_STATUS.OK;
  }

  /** True if partially successful (some stages failed but deliverables exist). */
  get partial() {
    return this.status === OP_STATUS.PARTIAL;
  }

  /**
   * MED-012: Derive top-level ok from item results.
   * Used by pipeline import to avoid reporting ok:true when all items failed.
   *
   * @param {Array<{ ok: boolean }>} items - Individual item results.
   * @returns {{ ok: boolean, partial: boolean, succeeded: number, failed: number }}
   */
  static deriveFromItems(items) {
    if (!items || !items.length) return { ok: false, partial: false, succeeded: 0, failed: 0 };
    const succeeded = items.filter((i) => i.ok).length;
    const failed = items.length - succeeded;
    return {
      ok: failed === 0,
      partial: succeeded > 0 && failed > 0,
      succeeded,
      failed,
    };
  }

  /**
   * Serialize for IPC transport.
   * @returns {object}
   */
  toJSON() {
    return {
      operation: this.operation,
      status: this.status,
      ok: this.ok,
      stages: this.stages.slice(),
      deliverables: this.deliverables.slice(),
      warnings: this.warnings.slice(),
    };
  }
}

module.exports = { OperationResult, STAGE_STATUS, OP_STATUS };
