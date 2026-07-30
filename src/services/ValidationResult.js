// src/services/ValidationResult.js
// ============================================================================
// Shared Component 1C: Typed Validation Result.
//
// Separates hard errors (non-overridable) from confirmable warnings and
// informational messages. This is the single result type used by all
// validators (modelSpecs, ContractRegistry, pipeline, audio, etc).
//
// FUNC-016 fix: API-contract violations are `errors` and CANNOT be
// overridden with "Generate anyway". Only `warnings` are confirmable.
//
// Usage:
//   const { ValidationResult } = require('./ValidationResult');
//   const vr = new ValidationResult();
//   vr.error('Duration 7 is not allowed.');       // hard block
//   vr.warning('High variant count may hit rate limits.'); // confirmable
//   if (!vr.canProceed) { /* block UI */ }
//
// Section 21.1 rules:
//   ERROR   = provably invalid API/file/model/grant contract → NOT overridable.
//   WARNING = cost, quality risk, rate-limit probability → confirmable.
//   INFO    = pure explanation, no decision required.
// ============================================================================
'use strict';

class ValidationResult {
  constructor() {
    /** @type {string[]} Hard errors — generation MUST NOT proceed. */
    this.errors = [];
    /** @type {string[]} Warnings — user may confirm and proceed. */
    this.warnings = [];
    /** @type {string[]} Informational messages — no action needed. */
    this.info = [];
  }

  /**
   * Add a hard error (non-overridable).
   * @param {string} msg
   * @returns {this}
   */
  error(msg) {
    if (msg) this.errors.push(msg);
    return this;
  }

  /**
   * Add a confirmable warning.
   * @param {string} msg
   * @returns {this}
   */
  warning(msg) {
    if (msg) this.warnings.push(msg);
    return this;
  }

  /**
   * Add an informational message.
   * @param {string} msg
   * @returns {this}
   */
  addInfo(msg) {
    if (msg) this.info.push(msg);
    return this;
  }

  /**
   * Merge another ValidationResult or plain {errors, warnings, info} into this one.
   * @param {ValidationResult|{errors?: string[], warnings?: string[], info?: string[]}} other
   * @returns {this}
   */
  merge(other) {
    if (!other) return this;
    const errs = other.errors || [];
    const warns = other.warnings || [];
    const infos = other.info || [];
    for (const e of errs) this.error(e);
    for (const w of warns) this.warning(w);
    for (const i of infos) this.addInfo(i);
    return this;
  }

  /**
   * Merge a legacy {errors: string[]} object (from old validateValues).
   * All items become hard errors.
   * @param {{errors?: string[]}} legacy
   * @returns {this}
   */
  mergeLegacyErrors(legacy) {
    if (legacy && Array.isArray(legacy.errors)) {
      for (const e of legacy.errors) this.error(e);
    }
    return this;
  }

  /** True if there are NO hard errors (warnings are OK). */
  get canProceed() {
    return this.errors.length === 0;
  }

  /** True if there are hard errors. */
  get hasErrors() {
    return this.errors.length > 0;
  }

  /** True if there are warnings (but maybe no errors). */
  get hasWarnings() {
    return this.warnings.length > 0;
  }

  /** True if completely clean (no errors, no warnings). */
  get isClean() {
    return this.errors.length === 0 && this.warnings.length === 0;
  }

  /** All messages combined (for logging/display). */
  get allMessages() {
    return [...this.errors, ...this.warnings, ...this.info];
  }

  /**
   * Serialize to a plain object (for IPC transport).
   * @returns {{ ok: boolean, errors: string[], warnings: string[], info: string[] }}
   */
  toJSON() {
    return {
      ok: this.canProceed,
      errors: this.errors.slice(),
      warnings: this.warnings.slice(),
      info: this.info.slice(),
    };
  }

  /**
   * Create from a plain object (e.g. received over IPC).
   * @param {{ errors?: string[], warnings?: string[], info?: string[] }} obj
   * @returns {ValidationResult}
   */
  static from(obj) {
    const vr = new ValidationResult();
    if (obj) {
      for (const e of (obj.errors || [])) vr.error(e);
      for (const w of (obj.warnings || [])) vr.warning(w);
      for (const i of (obj.info || [])) vr.addInfo(i);
    }
    return vr;
  }
}

module.exports = { ValidationResult };
