'use strict';

/**
 * Strict bounded base64 decoding.
 * 
 * AUD-009/AUD-010 fix: A strict canonical decoder validates alphabet,
 * padding, exact decoded length, and canonical round-trip before allocation.
 * 
 * The decoder must run before Buffer.from() can allocate an unbounded result.
 */

// Canonical base64 alphabet with optional padding
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/**
 * Decode a base64 string with strict validation and size limits.
 * @param {string} input - The base64 string to decode
 * @param {number} maxBytes - Maximum allowed decoded bytes
 * @param {{allowWhitespace?: boolean}} [options] - Options
 * @returns {Buffer} The decoded buffer
 * @throws {TypeError} If input is not a string or maxBytes is invalid
 * @throws {Error} If payload is empty, malformed, too large, or non-canonical
 */
function decodeBase64Strict(input, maxBytes, options = {}) {
  if (typeof input !== 'string') throw new TypeError('base64 input must be a string');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer');
  }

  // Optionally strip whitespace (for multi-line base64)
  const compact = options.allowWhitespace === true
    ? input.replace(/[\t\n\r ]+/gu, '')
    : input;
  
  if (compact.length === 0) throw new Error('base64 payload is empty');
  
  // Validate canonical base64 format
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) {
    throw new Error('base64 payload is malformed');
  }

  // Calculate exact decoded size from padding
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const exactBytes = (compact.length / 4) * 3 - padding;
  
  // Check size limit BEFORE allocation
  if (exactBytes > maxBytes) {
    const error = new Error(`decoded payload exceeds ${maxBytes} bytes`);
    error.code = 'RESPONSE_TOO_LARGE';
    throw error;
  }

  // Decode and verify canonical round-trip
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.length !== exactBytes || buffer.toString('base64') !== compact) {
    buffer.fill(0); // Best-effort zeroing
    throw new Error('base64 payload is non-canonical or corrupt');
  }
  return buffer;
}

module.exports = { decodeBase64Strict };
