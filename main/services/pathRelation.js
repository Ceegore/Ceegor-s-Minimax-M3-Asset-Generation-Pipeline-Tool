'use strict';

/**
 * Canonical path relationship helpers.
 * 
 * This helper operates only on paths already canonicalized by the
 * ancestor-walk logic in PathGrantService. It must replace every
 * manual path.relative() plus startsWith('..') branch, including
 * sensitive-root checks.
 * 
 * AUD-017 fix: A path escapes a root only when path.relative(root, candidate) is:
 * - exactly '..';
 * - begins with '..' followed by the platform path separator;
 * - or is absolute, indicating a different drive/root.
 * 
 * '..foo', '...cache', and '..2026' are ordinary descendant names
 * and must remain valid.
 */

const path = require('path');

/**
 * Case-fold a path for comparison. NTFS is case-insensitive.
 * @param {string} p
 * @returns {string}
 */
function fold(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Determine the relationship between a canonical root and a canonical candidate.
 * @param {string} canonicalRoot - Already canonicalized root path
 * @param {string} canonicalCandidate - Already canonicalized candidate path
 * @returns {'equal' | 'descendant' | 'outside'}
 */
function relation(canonicalRoot, canonicalCandidate) {
  if (typeof canonicalRoot !== 'string' || !canonicalRoot) {
    throw new TypeError('canonicalRoot must be a non-empty string');
  }
  if (typeof canonicalCandidate !== 'string' || !canonicalCandidate) {
    throw new TypeError('canonicalCandidate must be a non-empty string');
  }

  const root = fold(path.resolve(canonicalRoot));
  const candidate = fold(path.resolve(canonicalCandidate));
  if (root === candidate) return 'equal';

  const rel = path.relative(root, candidate);
  // AUD-017: segment-aware escape check
  // - rel === '..' means direct parent
  // - rel.startsWith('..' + path.sep) means ancestor escape
  // - path.isAbsolute(rel) means cross-drive/root
  const escapes = rel === '..'
    || rel.startsWith('..' + path.sep)
    || path.isAbsolute(rel);
  return escapes ? 'outside' : 'descendant';
}

/**
 * Check if candidate is equal to or a descendant of root.
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
function isEqualOrDescendant(root, candidate) {
  return relation(root, candidate) !== 'outside';
}

/**
 * Check if candidate is a strict descendant of root (not equal).
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
function isStrictDescendant(root, candidate) {
  return relation(root, candidate) === 'descendant';
}

module.exports = { relation, isEqualOrDescendant, isStrictDescendant };
