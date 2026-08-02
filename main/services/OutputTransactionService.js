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

const SCHEMA_VERSION = 1;
const VALID_STATES = Object.freeze([
  'PREPARING', 'PREPARED', 'INSTALLING', 'COMMITTED', 'CLEANED',
]);

/**
 * Atomically write and fsync a JSON file.
 * @param {string} filePath
 * @param {object} data
 */
function writeJsonSync(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  const tmp = filePath + '.tmp-' + crypto.randomUUID().slice(0, 8);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, json);
    try { fs.fsyncSync(fd); } catch (_) { /* best-effort on Windows */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  // fsync the containing directory where supported
  try {
    const dirFd = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (_) { /* Windows may not support directory fsync */ }
}

/**
 * Verify a path is a regular file (not a link/reparse point).
 * @param {string} filePath
 * @returns {boolean}
 */
function isRegularFile(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    return st.isFile();
  } catch (_) { return false; }
}

/**
 * Verify no ancestor in the chain is a symlink/reparse point.
 * @param {string} filePath
 * @param {string} stopAt - Ancestor at which to stop checking
 * @returns {boolean}
 */
function ancestorsAreRegular(filePath, stopAt) {
  let current = path.dirname(filePath);
  const stop = path.resolve(stopAt);
  while (current.length > stop.length) {
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) return false;
    } catch (_) { return false; }
    current = path.dirname(current);
  }
  return true;
}

/**
 * Compute SHA-256 of a file synchronously.
 * @param {string} filePath
 * @returns {string} hex digest
 */
function hashFileSync(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.slice(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Fsync a file by path (best-effort on Windows where EPERM is common).
 * @param {string} filePath
 */
function fsyncFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (e) {
    // EPERM/EIO on Windows temp/network paths is non-fatal.
    if (e.code !== 'EPERM' && e.code !== 'EIO' && e.code !== 'ENOTSUP') throw e;
  }
}

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
    for (const file of journal.files) {
      // No-clobber: fail if destination exists
      if (fs.existsSync(file.finalPath)) {
        this._rollbackInstalled(journal);
        throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, `Destination already exists: ${path.basename(file.finalPath)}`);
      }
      try {
        fs.renameSync(file.stagedPath, file.finalPath);
      } catch (renameErr) {
        // Cross-device fallback: copy + delete
        if (renameErr.code === 'EXDEV') {
          fs.copyFileSync(file.stagedPath, file.finalPath);
          fs.unlinkSync(file.stagedPath);
        } else {
          this._rollbackInstalled(journal);
          throw new AppError(CODES.OUTPUT_TRANSACTION_FAILED, `Rename failed: ${renameErr.message}`, { cause: renameErr });
        }
      }
      // fsync containing directory where supported
      try {
        const dirFd = fs.openSync(path.dirname(file.finalPath), 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch (_) { /* Windows */ }
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
   * @param {string} transactionId
   */
  cancel(transactionId) {
    let journal;
    try { journal = this._readJournal(transactionId); } catch (_) { return; }
    if (journal.state === 'COMMITTED' || journal.state === 'CLEANED') return;
    if (journal.state === 'INSTALLING') {
      this._rollbackInstalled(journal);
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
   * @param {object} journal
   */
  _rollbackInstalled(journal) {
    for (const file of journal.files) {
      if (!file.installed) continue;
      try {
        // Verify the path is still under canonical root
        if (!isStrictDescendant(journal.canonicalRoot, file.finalPath)) continue;
        // Must be a regular file (not a link)
        if (!isRegularFile(file.finalPath)) continue;
        // Must match expected size and hash
        const st = fs.statSync(file.finalPath);
        if (st.size !== file.bytes) continue;
        const actualHash = hashFileSync(file.finalPath);
        if (actualHash !== file.sha256) continue;
        // Safe to remove
        fs.unlinkSync(file.finalPath);
        file.installed = false;
      } catch (_) {
        // If any check fails, leave the file untouched — MANUAL_REVIEW_REQUIRED
      }
    }
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
        // Some files may have been installed — rollback those, then clean stage
        let safe = true;
        for (const file of (journal.files || [])) {
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
