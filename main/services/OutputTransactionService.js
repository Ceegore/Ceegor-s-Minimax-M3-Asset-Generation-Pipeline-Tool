'use strict';

/**
 * Output Transaction Service — crash-consistent multi-file output promotion.
 *
 * AUD-011 fix: Sequential rename is atomic only for each file. A durable
 * transaction journal provides deterministic recovery. The precise guarantee
 * is crash-consistent commit or rollback after recovery, not instantaneous
 * multi-file filesystem atomicity.
 *
 * Directory layout:
 *   <userData>/output-transactions/<transactionId>.json   authoritative journal
 *   <authorizedOutputRoot>/.mmas-stage-<transactionId>/   staged files only
 *   <authorizedOutputRoot>/image_<uuid>.png               final files
 *
 * The journal lives under userData (Main-only), never in the output root
 * where a compromised renderer could forge it.
 *
 * States: PREPARING → PREPARED → INSTALLING → COMMITTED → CLEANED
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CODES, AppError } = require('../errors/AppError');
const { isStrictDescendant } = require('./pathRelation');
// Low-level filesystem primitives (atomic journal writes, link-safe path
// checks, hashing, fsync) — split out for the lint size budget.
const { writeJsonSync, isRegularFile, ancestorsAreRegular, hashFileSync, fsyncFile } = require('./transactionFileUtils');

const SCHEMA_VERSION = 1;
const VALID_STATES = Object.freeze([
  'PREPARING', 'PREPARED', 'INSTALLING', 'COMMITTED', 'CLEANED',
  'ROLLBACK_INCOMPLETE', // M-012: cancel failed to fully roll back
]);

class OutputTransactionService {
  /**
   * @param {{ journalDir: string, now?: () => number }} opts
   */
  constructor({ journalDir, now = () => Date.now() }) {
    if (!journalDir || typeof journalDir !== 'string') {
      throw new TypeError('journalDir is required');
    }
    this.journalDir = journalDir;
    this.now = now;
    fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Path to the journal file for a transaction.
   * @param {string} transactionId
   * @returns {string}
   */
  journalPath(transactionId) {
    return path.join(this.journalDir, `${transactionId}.json`);
  }

  /**
   * Create a new transaction in PREPARING state.
   * @param {{ canonicalRoot: string, leaseId: string }} opts
   * @returns {{ transactionId: string, stageDir: string }}
   */
  begin({ canonicalRoot, leaseId }) {
    if (!canonicalRoot || typeof canonicalRoot !== 'string') {
      throw new AppError(CODES.INVALID_ARGUMENT, 'canonicalRoot is required.');
    }
    const transactionId = crypto.randomUUID();
    const stageDir = path.join(canonicalRoot, `.mmas-stage-${transactionId}`);
    fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });

    const journal = {
      schemaVersion: SCHEMA_VERSION,
      transactionId,
      state: 'PREPARING',
      canonicalRoot,
      leaseId: leaseId || null,
      createdAt: this.now(),
      stageDir,
      files: [],
    };
    writeJsonSync(this.journalPath(transactionId), journal);
    return { transactionId, stageDir };
  }

  /**
   * Add a finalized file to the transaction plan.
   * @param {string} transactionId
   * @param {{ stagedPath: string, finalPath: string, bytes: number, sha256: string }} entry
   */
  addFile(transactionId, entry) {
    const journal = this._readJournal(transactionId);
    if (journal.state !== 'PREPARING') {
      throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Cannot add files after PREPARING state.');
    }
    journal.files.push({
      stagedPath: entry.stagedPath,
      finalPath: entry.finalPath,
      bytes: entry.bytes,
      sha256: entry.sha256,
      installed: false,
    });
    writeJsonSync(this.journalPath(transactionId), journal);
  }

  /**
   * Commit the transaction: verify, journal PREPARED, install, verify, COMMITTED, cleanup.
   * @param {string} transactionId
   * @returns {{ committed: true, files: string[] }}
   */
  commit(transactionId) {
    const journal = this._readJournal(transactionId);
    if (journal.state !== 'PREPARING') {
      throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, `Cannot commit from state ${journal.state}.`);
    }
    if (!journal.files.length) {
      throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'No files to commit.');
    }

    // Step 1: Verify canonical root still exists
    if (!fs.existsSync(journal.canonicalRoot)) {
      throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Output root no longer exists.');
    }

    // Step 2-3: Verify path containment
    for (const file of journal.files) {
      if (!isStrictDescendant(journal.stageDir, file.stagedPath)) {
        throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Staged path escapes stage directory.');
      }
      if (!isStrictDescendant(journal.canonicalRoot, file.finalPath)) {
        throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Final path escapes output root.');
      }
    }

    // Step 4: Reject links/reparse points in ancestors
    for (const file of journal.files) {
      if (!ancestorsAreRegular(file.finalPath, journal.canonicalRoot)) {
        throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Ancestor path contains a link/reparse point.');
      }
    }

    // Step 5: Hash and fsync each stage file
    for (const file of journal.files) {
      if (!isRegularFile(file.stagedPath)) {
        throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Staged file is missing or not a regular file.');
      }
      const actualHash = hashFileSync(file.stagedPath);
      if (actualHash !== file.sha256) {
        throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Staged file hash mismatch.');
      }
      const st = fs.statSync(file.stagedPath);
      if (st.size !== file.bytes) {
        throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Staged file size mismatch.');
      }
      fsyncFile(file.stagedPath);
    }

    // Step 6: Write PREPARED journal
    journal.state = 'PREPARED';
    writeJsonSync(this.journalPath(transactionId), journal);

    // Step 7: Change to INSTALLING
    journal.state = 'INSTALLING';
    writeJsonSync(this.journalPath(transactionId), journal);

    // Step 8: Install each file
    // M-011 (hhhhu2 audit): intent-before-action journaling. Mark the file
    // as "installing" in the journal BEFORE the rename so a crash between
    // rename and journal-write is recoverable. Recovery reconciles by
    // checking both staged and final filesystem states.
    for (const file of journal.files) {
      // No-clobber: fail if destination exists
      if (fs.existsSync(file.finalPath)) {
        this._rollbackInstalled(journal);
        throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, `Destination already exists: ${path.basename(file.finalPath)}`);
      }
      // Journal intent BEFORE the destructive rename.
      file.installing = true;
      writeJsonSync(this.journalPath(transactionId), journal);
      try {
        fs.renameSync(file.stagedPath, file.finalPath);
      } catch (renameErr) {
        // Cross-device fallback: copy + delete
        if (renameErr.code === 'EXDEV') {
          fs.copyFileSync(file.stagedPath, file.finalPath);
          fs.unlinkSync(file.stagedPath);
        } else {
          file.installing = false;
          writeJsonSync(this.journalPath(transactionId), journal);
          this._rollbackInstalled(journal);
          throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, `Rename failed: ${renameErr.message}`, { cause: renameErr });
        }
      }
      // fsync containing directory where supported
      try {
        const dirFd = fs.openSync(path.dirname(file.finalPath), 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch (_) { /* Windows */ }
      file.installing = false;
      file.installed = true;
      writeJsonSync(this.journalPath(transactionId), journal);
    }

    // Step 9: Verify every final file
    for (const file of journal.files) {
      if (!isRegularFile(file.finalPath)) {
        throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Post-install verification failed: file missing.');
      }
      const st = fs.statSync(file.finalPath);
      if (st.size !== file.bytes) {
        throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Post-install verification failed: size mismatch.');
      }
      const actualHash = hashFileSync(file.finalPath);
      if (actualHash !== file.sha256) {
        throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Post-install verification failed: hash mismatch.');
      }
    }

    // Step 10: COMMITTED
    journal.state = 'COMMITTED';
    writeJsonSync(this.journalPath(transactionId), journal);

    // Step 11: Remove stage directory
    try { fs.rmSync(journal.stageDir, { recursive: true, force: true }); } catch (_) {}

    // Step 12: Remove journal
    try { fs.unlinkSync(this.journalPath(transactionId)); } catch (_) {}

    return { committed: true, files: journal.files.map((f) => f.finalPath) };
  }

  /**
   * Cancel a transaction before commit.
   * M-012 (hhhhu2 audit): preserve the journal and stage directory when
   * rollback is incomplete, so manual-review evidence is not lost.
   * @param {string} transactionId
   */
  cancel(transactionId) {
    let journal;
    try { journal = this._readJournal(transactionId); } catch (_) { return; }
    if (journal.state === 'COMMITTED' || journal.state === 'CLEANED') return;
    if (journal.state === 'INSTALLING') {
      const rollbackComplete = this._rollbackInstalled(journal);
      if (!rollbackComplete) {
        // M-012: rollback was incomplete — preserve evidence for manual review.
        // Mark the journal so recovery knows this needs attention.
        journal.state = 'ROLLBACK_INCOMPLETE';
        try { writeJsonSync(this.journalPath(transactionId), journal); } catch (_) {}
        return;
      }
    }
    // Remove stage directory
    try { fs.rmSync(journal.stageDir, { recursive: true, force: true }); } catch (_) {}
    // Remove journal
    try { fs.unlinkSync(this.journalPath(transactionId)); } catch (_) {}
  }

  /**
   * Rollback files that have been installed (marked installed:true in journal).
   * Only removes a final path that exactly matches the journal, is under the
   * canonical root, is a regular file, and has the expected size and hash.
   * M-011 (hhhhu2 audit): also reconciles files marked `installing:true`
   * (intent journaled but crash before completion) by checking filesystem state.
   * M-012 (hhhhu2 audit): returns false if any file could not be rolled back.
   * @param {object} journal
   * @returns {boolean} true if all installed files were successfully rolled back
   */
  _rollbackInstalled(journal) {
    let complete = true;
    for (const file of journal.files) {
      // M-011: reconcile files that were mid-install (intent journaled,
      // crash before installed=true). Check if the final file exists.
      if (file.installing && !file.installed) {
        if (isRegularFile(file.finalPath)) {
          // The rename completed but the journal wasn't updated.
          // Verify and remove it.
          try {
            if (!isStrictDescendant(journal.canonicalRoot, file.finalPath)) { complete = false; continue; }
            const st = fs.statSync(file.finalPath);
            if (st.size !== file.bytes) { complete = false; continue; }
            const actualHash = hashFileSync(file.finalPath);
            if (actualHash !== file.sha256) { complete = false; continue; }
            fs.unlinkSync(file.finalPath);
            file.installing = false;
          } catch (_) { complete = false; }
        } else {
          // Rename didn't complete — staged file should still exist.
          file.installing = false;
        }
        continue;
      }
      if (!file.installed) continue;
      try {
        // Verify the path is still under canonical root
        if (!isStrictDescendant(journal.canonicalRoot, file.finalPath)) { complete = false; continue; }
        // Must be a regular file (not a link)
        if (!isRegularFile(file.finalPath)) { complete = false; continue; }
        // Must match expected size and hash
        const st = fs.statSync(file.finalPath);
        if (st.size !== file.bytes) { complete = false; continue; }
        const actualHash = hashFileSync(file.finalPath);
        if (actualHash !== file.sha256) { complete = false; continue; }
        // Safe to remove
        fs.unlinkSync(file.finalPath);
        file.installed = false;
      } catch (_) {
        // If any check fails, leave the file untouched — MANUAL_REVIEW_REQUIRED
        complete = false;
      }
    }
    return complete;
  }

  /**
   * Startup recovery: enumerate journals and recover deterministically.
   * Run before renderer creation.
   * @returns {{ recovered: number, manualReview: number, errors: string[] }}
   */
  recover() {
    const result = { recovered: 0, manualReview: 0, errors: [] };
    let entries;
    try {
      entries = fs.readdirSync(this.journalDir).filter((f) => f.endsWith('.json'));
    } catch (_) { return result; }

    for (const entry of entries) {
      const journalFile = path.join(this.journalDir, entry);
      try {
        const raw = fs.readFileSync(journalFile, 'utf8');
        const journal = JSON.parse(raw);
        // Schema validation
        if (!journal || journal.schemaVersion !== SCHEMA_VERSION || !journal.transactionId) {
          result.errors.push(`Invalid journal schema: ${entry}`);
          continue;
        }
        if (!VALID_STATES.includes(journal.state)) {
          result.errors.push(`Invalid state in journal: ${entry}`);
          continue;
        }
        this._recoverJournal(journal, journalFile, result);
      } catch (err) {
        result.errors.push(`Recovery failed for ${entry}: ${err.message}`);
      }
    }
    return result;
  }

  /**
   * Recover a single journal based on its state.
   * @param {object} journal
   * @param {string} journalFile
   * @param {{ recovered: number, manualReview: number, errors: string[] }} result
   */
  _recoverJournal(journal, journalFile, result) {
    switch (journal.state) {
      case 'PREPARING':
      case 'PREPARED':
        // Never reached INSTALLING — remove stage data and journal
        try { fs.rmSync(journal.stageDir, { recursive: true, force: true }); } catch (_) {}
        try { fs.unlinkSync(journalFile); } catch (_) {}
        result.recovered++;
        break;

      case 'INSTALLING': {
        // Some files may have been installed — rollback those, then clean stage.
        // M-011 (hhhhu2 audit): also reconcile files with installing:true.
        let safe = true;
        for (const file of (journal.files || [])) {
          // Reconcile mid-install files (intent journaled, crash before completion)
          if (file.installing && !file.installed) {
            if (isRegularFile(file.finalPath)) {
              try {
                if (!isStrictDescendant(journal.canonicalRoot, file.finalPath)) { safe = false; break; }
                const st2 = fs.statSync(file.finalPath);
                if (st2.size !== file.bytes) { safe = false; break; }
                const h2 = hashFileSync(file.finalPath);
                if (h2 !== file.sha256) { safe = false; break; }
                fs.unlinkSync(file.finalPath);
              } catch (_) { safe = false; break; }
            }
            continue;
          }
          if (!file.installed) continue;
          try {
            if (!isStrictDescendant(journal.canonicalRoot, file.finalPath)) { safe = false; break; }
            if (!isRegularFile(file.finalPath)) { safe = false; break; }
            const st = fs.statSync(file.finalPath);
            if (st.size !== file.bytes) { safe = false; break; }
            const actualHash = hashFileSync(file.finalPath);
            if (actualHash !== file.sha256) { safe = false; break; }
            fs.unlinkSync(file.finalPath);
          } catch (_) { safe = false; break; }
        }
        if (safe) {
          try { fs.rmSync(journal.stageDir, { recursive: true, force: true }); } catch (_) {}
          try { fs.unlinkSync(journalFile); } catch (_) {}
          result.recovered++;
        } else {
          // M-012: preserve evidence for manual review.
          result.manualReview++;
        }
        break;
      }

      case 'COMMITTED':
        // Outputs are valid — just clean up stage/journal
        try { fs.rmSync(journal.stageDir, { recursive: true, force: true }); } catch (_) {}
        try { fs.unlinkSync(journalFile); } catch (_) {}
        result.recovered++;
        break;

      case 'CLEANED':
        // Should not exist — remove stale journal
        try { fs.unlinkSync(journalFile); } catch (_) {}
        result.recovered++;
        break;

      // M-012 (hhhhu2 audit): ROLLBACK_INCOMPLETE means a previous cancel
      // could not fully roll back. Preserve for manual review.
      case 'ROLLBACK_INCOMPLETE':
        result.manualReview++;
        break;

      default:
        result.manualReview++;
    }
  }

  /**
   * Read and validate a journal from disk.
   * @param {string} transactionId
   * @returns {object}
   */
  _readJournal(transactionId) {
    const journalFile = this.journalPath(transactionId);
    let raw;
    try { raw = fs.readFileSync(journalFile, 'utf8'); } catch (_) {
      throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Transaction journal not found.');
    }
    let journal;
    try { journal = JSON.parse(raw); } catch (_) {
      throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Transaction journal is corrupt.');
    }
    if (!journal || journal.schemaVersion !== SCHEMA_VERSION || journal.transactionId !== transactionId) {
      throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, 'Transaction journal schema mismatch.');
    }
    return journal;
  }
}

module.exports = { OutputTransactionService };
