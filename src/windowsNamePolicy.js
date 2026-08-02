'use strict';

/**
 * Windows filename policy validation.
 * 
 * AUD-018 fix: Windows treats the part before the first dot as the device stem.
 * Names like CON.txt, NUL.png, COM1.log are reserved device names.
 * 
 * The check applies to the stem before the first dot. Case does not matter.
 * Invalid characters and control characters remain rejected.
 * 
 * Do not silently trim or rewrite invalid user input. Reject it so the
 * path shown in the UI is the path created on disk.
 */

// Windows reserved device names including superscript aliases (¹²³)
// CONIN$ and CONOUT$ are also reserved console device names.
const RESERVED = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

/**
 * Validate a single path segment (filename or directory name).
 * @param {string} value - The name to validate
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function validateSinglePathSegment(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: 'Name is required.' };
  }
  if (value.length > 255) {
    return { ok: false, error: 'Name is too long.' };
  }
  if (value === '.' || value === '..') {
    return { ok: false, error: 'Dot path segments are not allowed.' };
  }
  if (/[\\/]/u.test(value)) {
    return { ok: false, error: 'Path separators are not allowed in a name.' };
  }
  // Windows-reserved characters: < > : " | ? * and control chars 0-31
  if (/[<>:"|?*\u0000-\u001F]/u.test(value)) {
    return { ok: false, error: 'The name contains a Windows-reserved character.' };
  }
  // Windows filenames cannot end in a dot or space
  if (/[. ]$/u.test(value)) {
    return { ok: false, error: 'A Windows filename cannot end in a dot or space.' };
  }

  // Windows treats the part before the first dot as the device stem.
  // Extract stem, strip trailing dots/spaces (Windows normalization), uppercase for comparison.
  const stem = value.split('.', 1)[0].replace(/[. ]+$/u, '').toUpperCase();
  if (RESERVED.test(stem)) {
    return { ok: false, error: 'The name uses a reserved Windows device name.' };
  }
  return { ok: true };
}

/**
 * Assert that a value is a valid single path segment.
 * Throws if invalid.
 * @param {string} value
 * @returns {string} The validated value
 * @throws {Error} If the value is invalid
 */
function assertSinglePathSegment(value) {
  const result = validateSinglePathSegment(value);
  if (!result.ok) throw new Error(result.error);
  return value;
}

module.exports = { validateSinglePathSegment, assertSinglePathSegment, RESERVED };
