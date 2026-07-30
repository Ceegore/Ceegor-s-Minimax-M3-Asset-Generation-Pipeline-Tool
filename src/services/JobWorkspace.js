// src/services/JobWorkspace.js
// ============================================================================
// Shared Component 1D: Transactional Job Workspace.
//
// Per-job/run/attempt directory lifecycle with validation, commit, rollback,
// and cleanup. Ensures that:
//   - Each retry attempt writes to its own isolated directory (FUNC-017)
//   - Cancel cleanup only touches run-owned temps (FUNC-018)
//   - Provider outputs land in temp first, validated before publish (HIGH-005)
//   - --out-dir outputs are inventoried and validated (HIGH-010)
//   - Aggregate output budget enforced (HIGH-024)
//   - Partial outputs cleaned on error (MED-009, MED-043)
//   - Write-probe before billable submit (FUNC-030)
//
// Directory structure:
//   <baseDir>/jobs/<jobId>/<runId>/attempt_<n>/  (working temp)
//   <baseDir>/jobs/<jobId>/<runId>/committed/    (validated outputs)
//
// Usage:
//   const { JobWorkspace } = require('./JobWorkspace');
//   const ws = new JobWorkspace(baseDir, jobId);
//   const attemptDir = ws.createAttempt(runId, 1);
//   // ... write files to attemptDir ...
//   ws.commit(runId, expectedCount);  // validates & promotes
//   // or
//   ws.rollback(runId);  // deletes attempt dirs
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Default maximum number of output files per job. */
const DEFAULT_MAX_FILES = 50;
/** Default maximum total bytes per job (2 GB). */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

class JobWorkspace {
  /**
   * @param {string} baseDir - The app's userData directory.
   * @param {string} jobId - Unique job identifier.
   * @param {{ maxFiles?: number, maxBytes?: number }} [opts]
   */
  constructor(baseDir, jobId, opts) {
    this._baseDir = baseDir;
    this._jobId = jobId;
    this._maxFiles = (opts && opts.maxFiles) || DEFAULT_MAX_FILES;
    this._maxBytes = (opts && opts.maxBytes) || DEFAULT_MAX_BYTES;
    this._jobDir = path.join(baseDir, 'jobs', _sanitizeId(jobId));
    this._committedBytes = 0;
    this._committedFiles = 0;
  }

  /** Get the job root directory. */
  get jobDir() { return this._jobDir; }

  /**
   * Ensure the job root exists.
   * @returns {string} The job directory path.
   */
  ensureJobDir() {
    fs.mkdirSync(this._jobDir, { recursive: true });
    return this._jobDir;
  }

  /**
   * Get the run directory path.
   * @param {string|number} runId
   * @returns {string}
   */
  runDir(runId) {
    return path.join(this._jobDir, 'run_' + _sanitizeId(String(runId)));
  }

  /**
   * Create an isolated attempt directory for a retry.
   * FUNC-017: each attempt gets its own directory so failed attempts
   * don't pollute the successful attempt's file inventory.
   *
   * @param {string|number} runId
   * @param {number} attemptNum - 1-based attempt number.
   * @returns {string} Absolute path to the attempt directory.
   */
  createAttempt(runId, attemptNum) {
    const dir = path.join(this.runDir(runId), 'attempt_' + attemptNum);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Get the committed (final validated) output directory for a run.
   * @param {string|number} runId
   * @returns {string}
   */
  committedDir(runId) {
    return path.join(this.runDir(runId), 'committed');
  }

  /**
   * FUNC-030: Write-probe — verify the target directory is writable
   * BEFORE spending API credits. Creates and deletes a tiny temp file.
   *
   * @param {string} targetDir - Directory to probe.
   * @returns {{ ok: boolean, error?: string }}
   */
  static writeProbe(targetDir) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      const probePath = path.join(targetDir, '.write_probe_' + crypto.randomBytes(4).toString('hex'));
      fs.writeFileSync(probePath, 'probe', { flag: 'wx' });
      fs.unlinkSync(probePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Target directory is not writable: ${err.code || err.message}` };
    }
  }

  /**
   * Check aggregate output budget before writing more files.
   * HIGH-024: enforce max file count and total byte budget.
   *
   * @param {number} additionalBytes - Bytes about to be written.
   * @param {number} [additionalFiles=1] - Number of files about to be written.
   * @returns {{ ok: boolean, error?: string }}
   */
  checkBudget(additionalBytes, additionalFiles) {
    additionalFiles = additionalFiles || 1;
    if (this._committedFiles + additionalFiles > this._maxFiles) {
      return { ok: false, error: `Output file limit exceeded (${this._maxFiles} max per job).` };
    }
    if (this._committedBytes + additionalBytes > this._maxBytes) {
      return { ok: false, error: `Output size limit exceeded (${Math.round(this._maxBytes / 1024 / 1024)} MB max per job).` };
    }
    return { ok: true };
  }

  /**
   * Commit files from an attempt directory to the committed directory.
   * Only the files from the SUCCESSFUL attempt are promoted.
   *
   * @param {string|number} runId
   * @param {number} attemptNum - The successful attempt number.
   * @param {{ expectedCount?: number, validateFn?: (filePath: string) => boolean }} [opts]
   * @returns {{ ok: boolean, files: string[], error?: string }}
   */
  commit(runId, attemptNum, opts) {
    opts = opts || {};
    const attemptDir = path.join(this.runDir(runId), 'attempt_' + attemptNum);
    const commitDir = this.committedDir(runId);

    if (!fs.existsSync(attemptDir)) {
      return { ok: false, files: [], error: 'Attempt directory does not exist.' };
    }

    // List files in the attempt directory
    let files;
    try {
      files = fs.readdirSync(attemptDir).filter((f) => {
        const stat = fs.statSync(path.join(attemptDir, f));
        return stat.isFile();
      });
    } catch (err) {
      return { ok: false, files: [], error: 'Failed to read attempt directory: ' + err.message };
    }

    // Validate expected count
    if (opts.expectedCount != null && files.length !== opts.expectedCount) {
      return { ok: false, files: [], error: `Expected ${opts.expectedCount} output files but found ${files.length}.` };
    }

    // Validate each file
    if (opts.validateFn) {
      for (const f of files) {
        if (!opts.validateFn(path.join(attemptDir, f))) {
          return { ok: false, files: [], error: `Validation failed for output file: ${f}` };
        }
      }
    }

    // Check budget
    let totalSize = 0;
    for (const f of files) {
      totalSize += fs.statSync(path.join(attemptDir, f)).size;
    }
    const budget = this.checkBudget(totalSize, files.length);
    if (!budget.ok) return { ok: false, files: [], error: budget.error };

    // Promote: move files to committed directory
    fs.mkdirSync(commitDir, { recursive: true });
    const committed = [];
    for (const f of files) {
      const src = path.join(attemptDir, f);
      const dst = path.join(commitDir, f);
      fs.renameSync(src, dst);
      committed.push(dst);
    }

    this._committedBytes += totalSize;
    this._committedFiles += files.length;

    // Clean up other attempt directories (partial failures)
    this._cleanupFailedAttempts(runId, attemptNum);

    return { ok: true, files: committed };
  }

  /**
   * Rollback: delete all attempt directories for a run (cancel/cleanup).
   * FUNC-018: only touches run-owned directories.
   *
   * @param {string|number} runId
   */
  rollback(runId) {
    const rd = this.runDir(runId);
    _rmSafe(rd);
  }

  /**
   * Full cleanup: remove the entire job directory.
   * Call after job is fully complete and outputs have been delivered.
   */
  cleanup() {
    _rmSafe(this._jobDir);
  }

  /**
   * Remove failed attempt directories (keep the successful one).
   * @private
   */
  _cleanupFailedAttempts(runId, successAttempt) {
    const rd = this.runDir(runId);
    try {
      const entries = fs.readdirSync(rd);
      for (const entry of entries) {
        if (entry.startsWith('attempt_') && entry !== 'attempt_' + successAttempt) {
          _rmSafe(path.join(rd, entry));
        }
      }
    } catch (_) { /* best-effort */ }
  }
}

/**
 * Sanitize an ID for use as a directory name.
 * @param {string} id
 * @returns {string}
 */
function _sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Safely remove a directory recursively (best-effort, never throws).
 * @param {string} dirPath
 */
function _rmSafe(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (_) { /* best-effort cleanup */ }
}

module.exports = { JobWorkspace, DEFAULT_MAX_FILES, DEFAULT_MAX_BYTES };
