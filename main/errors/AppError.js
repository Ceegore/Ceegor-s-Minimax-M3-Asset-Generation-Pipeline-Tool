'use strict';

/**
 * Stable error codes for typed error handling across the application.
 * Renderer responses use publicError() and never include stack traces,
 * absolute sensitive roots, raw response bodies, or credentials.
 */
const CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  SECURE_STORAGE_UNAVAILABLE: 'SECURE_STORAGE_UNAVAILABLE',
  SECRET_NOT_FOUND: 'SECRET_NOT_FOUND',
  SECRET_CORRUPT: 'SECRET_CORRUPT',
  CREDENTIAL_MIGRATION_INCOMPLETE: 'CREDENTIAL_MIGRATION_INCOMPLETE',
  PATH_GRANT_REQUIRED: 'PATH_GRANT_REQUIRED',
  PATH_GRANT_SCOPE_MISMATCH: 'PATH_GRANT_SCOPE_MISMATCH',
  PATH_INTENT_REQUIRED: 'PATH_INTENT_REQUIRED',
  PATH_INTENT_MISMATCH: 'PATH_INTENT_MISMATCH',
  PATH_LINK_BLOCKED: 'PATH_LINK_BLOCKED',
  OUTPUT_ROOT_NOT_WRITABLE: 'OUTPUT_ROOT_NOT_WRITABLE',
  JOB_ALREADY_RUNNING: 'JOB_ALREADY_RUNNING',
  COST_LIMIT_EXCEEDED: 'COST_LIMIT_EXCEEDED',
  SSRF_BLOCKED: 'SSRF_BLOCKED',
  REDIRECT_BLOCKED: 'REDIRECT_BLOCKED',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  RESPONSE_INVALID: 'RESPONSE_INVALID',
  OUTPUT_TYPE_MISMATCH: 'OUTPUT_TYPE_MISMATCH',
  OUTPUT_LIMIT_EXCEEDED: 'OUTPUT_LIMIT_EXCEEDED',
  OUTPUT_TRANSACTION_FAILED: 'OUTPUT_TRANSACTION_FAILED',
  RELEASE_IDENTITY_MISMATCH: 'RELEASE_IDENTITY_MISMATCH',
  RELEASE_SIGNATURE_INVALID: 'RELEASE_SIGNATURE_INVALID',
});

/**
 * Application error with stable code, retryable flag, and optional details.
 * Tests should assert the `code`, not fragile full message text.
 */
class AppError extends Error {
  /**
   * @param {string} code - One of CODES
   * @param {string} message - Human-readable message
   * @param {{cause?: Error, retryable?: boolean, details?: object}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.details = options.details && typeof options.details === 'object'
      ? options.details : undefined;
  }
}

/**
 * Convert an error to a safe public response for the renderer.
 * Never includes stack traces, absolute sensitive roots, raw response
 * bodies, or credentials.
 * @param {Error} error
 * @returns {{ok: false, code: string, error: string, retryable: boolean}}
 */
function publicError(error) {
  const e = error instanceof AppError
    ? error
    : new AppError(CODES.RESPONSE_INVALID, 'The operation failed.', { cause: error });
  return {
    ok: false,
    code: e.code,
    error: e.message,
    retryable: e.retryable,
  };
}

module.exports = { CODES, AppError, publicError };
