// main/services/transactionRecoveryUtils.js
// ============================================================================
// M-010 (hhhhu3 audit): recovery-time validation helpers for
// OutputTransactionService, split out for the lint size budget.
//
// A corrupted or forged journal must never turn startup recovery into a
// dangerous recursive delete. These helpers enforce strict shape rules and
// link-safety BEFORE any recursive filesystem operation.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { isStrictDescendant } = require('./pathRelation');

/** Strict shape rules for recovery-time journals (M-010). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/i;

/**
 * M-010: link-safe directory check via lstat. A symlinked stage directory
 * must never be the target of a recursive delete.
 * @param {string} p
 * @returns {boolean}
 */
function isRealDirectory(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory();
  } catch (_) { return false; }
}

/**
 * M-010: fully validate a journal recovered from disk BEFORE any recursive
 * filesystem operation. Returns null when valid, an error string otherwise.
 * @param {object} journal
 * @returns {string|null}
 */
function validateRecoveryJournal(journal) {
  if (!UUID_RE.test(journal.transactionId)) {
    return 'transactionId is not a UUID';
  }
  if (!journal.canonicalRoot || typeof journal.canonicalRoot !== 'string' ||
      !path.isAbsolute(journal.canonicalRoot)) {
    return 'canonicalRoot is missing or not absolute';
  }
  // The stage directory must be exactly the expected shape below the root.
  const expectedStage = path.join(journal.canonicalRoot, `.mmas-stage-${journal.transactionId}`);
  if (journal.stageDir !== expectedStage) {
    return 'stageDir does not match the expected .mmas-stage-<transactionId> shape';
  }
  if (!Array.isArray(journal.files)) return 'files is not an array';
  for (const file of journal.files) {
    if (!file || typeof file !== 'object') return 'file entry is malformed';
    if (typeof file.stagedPath !== 'string' || !isStrictDescendant(journal.stageDir, file.stagedPath)) {
      return 'stagedPath escapes the stage directory';
    }
    if (typeof file.finalPath !== 'string' || !isStrictDescendant(journal.canonicalRoot, file.finalPath)) {
      return 'finalPath escapes the canonical root';
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) return 'file bytes is malformed';
    if (typeof file.sha256 !== 'string' || !SHA_RE.test(file.sha256)) return 'file sha256 is malformed';
  }
  return null;
}

module.exports = { isRealDirectory, validateRecoveryJournal };
