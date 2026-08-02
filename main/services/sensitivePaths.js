'use strict';

/**
 * Sensitive path policy for grant blocking.
 *
 * Extracted from PathGrantService.js to satisfy the 500-line hard limit.
 *
 * HIGH-013: completed blocklist with additional system/credential paths.
 * H-028 (_5 audit): split into DEEP (root + all descendants blocked) and
 * SELF (only the exact root blocked, descendants like Documents are fine).
 */

const path = require('path');
const { isStrictDescendant } = require('./pathRelation');

// DEEP: credential stores + critical system dirs — NO descendant is ever
// a legitimate grant target.
const SENSITIVE_DEEP = (() => {
  const roots = [
    'C:\\Recovery',
    'C:\\System Volume Information',
    'C:\\$Recycle.Bin',
    // QA-fix (H-028 completion): system directories where NO subdirectory
    // is ever a legitimate grant target. The audit explicitly requires
    // C:\Windows\Temp\asset.png to be blocked — SELF-only was insufficient.
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
  ];
  try {
    const userProfile = process.env.USERPROFILE || process.env.HOME;
    if (userProfile) {
      roots.push(path.join(userProfile, '.ssh'));
      roots.push(path.join(userProfile, '.gnupg'));
      roots.push(path.join(userProfile, '.aws'));
      roots.push(path.join(userProfile, '.kube'));
      roots.push(path.join(userProfile, '.docker'));
    }
  } catch (_) {}
  try {
    const sysRoot = process.env.SYSTEMROOT || process.env.SystemRoot;
    if (sysRoot) {
      roots.push(path.join(sysRoot, 'System32'));
      roots.push(path.join(sysRoot, 'SysWOW64'));
    }
  } catch (_) {}
  roots.push('/etc', '/root', '/boot', '/dev', '/private', '/var/lib');
  return roots.map((r) => path.resolve(r).toLowerCase());
})();

// SELF-only: block granting the exact root, but allow user-chosen
// subdirectories (e.g. C:\Users\me\Documents\MyAssets, or temp dirs
// under AppData\Local\Temp). These are too broad for descendant blocking
// because the tool legitimately needs temp/output paths under them.
const SENSITIVE_SELF = (() => {
  const roots = [
    'C:\\',
  ];
  try {
    const userProfile = process.env.USERPROFILE || process.env.HOME;
    if (userProfile) {
      roots.push(userProfile);
      roots.push(path.join(userProfile, 'AppData'));
    }
  } catch (_) {}
  return roots.map((r) => path.resolve(r).toLowerCase());
})();

/**
 * Check if a canonical path IS a sensitive root or is INSIDE one.
 * H-028 (_5 audit): DEEP roots block the root AND every descendant
 * (system dirs, credential dirs). SELF roots block only the exact
 * root (user profile, drive root) — subdirectories are allowed.
 * Uses path.relative() for boundary-safe containment: a similarly-
 * named path (e.g. C:\WindowsBackup) is NOT a descendant of C:\Windows.
 * @param {string} canonicalPath - Lowercase canonical path.
 * @returns {boolean}
 */
function isSensitiveRoot(canonicalPath) {
  const lower = canonicalPath.toLowerCase();
  // DEEP: block root + all descendants.
  // AUD-017 fix: use segment-aware relation check instead of startsWith('..')
  for (const root of SENSITIVE_DEEP) {
    if (lower === root) return true;
    if (isStrictDescendant(root, lower)) return true;
  }
  // SELF: block only the exact root.
  for (const root of SENSITIVE_SELF) {
    if (lower === root) return true;
  }
  return false;
}

module.exports = { SENSITIVE_DEEP, SENSITIVE_SELF, isSensitiveRoot };
