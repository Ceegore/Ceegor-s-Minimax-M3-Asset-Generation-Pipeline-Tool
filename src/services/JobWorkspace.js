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

/** H-062: strict ID format — no sanitizing, no replacement, no collisions. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** H-062: ownership manifest file name written into every job directory. */
const MANIFEST_NAME = '.workspace.json';

class JobWorkspace {
  /**
   * @param {string} baseDir - The app's userData directory.
   * @param {string} jobId - Unique job identifier (strict format: [A-Za-z0-9_-]{1,64}).
   * @param {{ maxFiles?: number, maxBytes?: number }} [opts]
   * @throws {Error} If baseDir is empty or jobId does not match the strict format.
   */
  constructor(baseDir, jobId, opts) {
    if (typeof baseDir !== 'string' || !baseDir.trim()) {
      throw new Error('JobWorkspace: baseDir must be a non-empty string.');
    }
    // H-062: reject invalid IDs instead of sanitizing them. Sanitizer-based
    // path identity allowed '' → jobDir === <base>/jobs (cleanup would delete
    // the entire jobs root) and mapped distinct IDs ('a/b' vs 'a:b') to the
    // same directory.
    this._jobId = _validateId(jobId, 'jobId');
    this._baseDir = baseDir;
    this._maxFiles = (opts && opts.maxFiles) || DEFAULT_MAX_FILES;
    this._maxBytes = (opts && opts.maxBytes) || DEFAULT_MAX_BYTES;
    this._jobsRoot = path.join(baseDir, 'jobs');
    this._jobDir = path.join(this._jobsRoot, this._jobId);
    this._committedBytes = 0;
    this._committedFiles = 0;
  }

  /** Get the job root directory. */
  get jobDir() { return this._jobDir; }

  /**
   * Ensure the job root exists and write the ownership manifest.
   * H-062: the manifest records which jobId owns the directory so cleanup
   * can refuse to delete directories it does not own.
   * @returns {string} The job directory path.
   * @throws {Error} If the directory is already owned by a different jobId.
   */
  ensureJobDir() {
    fs.mkdirSync(this._jobDir, { recursive: true });
    const manifestPath = path.join(this._jobDir, MANIFEST_NAME);
    const existing = _readManifest(manifestPath);
    if (existing && existing.jobId !== this._jobId) {
      throw new Error(`JobWorkspace: directory is owned by a different job ("${existing.jobId}").`);
    }
    if (!existing) {
      fs.writeFileSync(manifestPath, JSON.stringify({ jobId: this._jobId, createdAt: Date.now() }));
    }
    return this._jobDir;
  }

  /**
   * Get the run directory path.
   * @param {string|number} runId - Strict format: [A-Za-z0-9_-]{1,64}.
   * @returns {string}
   * @throws {Error} If runId does not match the strict format.
   */
  runDir(runId) {
    return path.join(this._jobDir, 'run_' + _validateId(String(runId), 'runId'));
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
    // H-062: establish ownership (manifest) before creating nested dirs so a
    // later cleanup() recognizes the job directory as ours.
    this.ensureJobDir();
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
    if (!Number.isInteger(attemptNum) || attemptNum < 1) {
      return { ok: false, files: [], error: 'Invalid attempt number.' };
    }
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

    // H-063: pre-flight no-clobber — fs.rename REPLACES an existing target on
    // Windows and POSIX, so check EVERY destination before moving anything.
    fs.mkdirSync(commitDir, { recursive: true });
    for (const f of files) {
      if (fs.existsSync(path.join(commitDir, f))) {
        return { ok: false, files: [], error: `Commit target already exists: ${f}` };
      }
    }

    // H-063: journaled promote — if a rename fails mid-way, move the already-
    // promoted files back so the run is either fully committed or not at all.
    const committed = [];
    const journal = []; // [{ src, dst }] of successfully moved files
    try {
      for (const f of files) {
        const src = path.join(attemptDir, f);
        const dst = path.join(commitDir, f);
        fs.renameSync(src, dst);
        journal.push({ src, dst });
        committed.push(dst);
      }
    } catch (err) {
      // Roll back already-moved files (best-effort, reverse order).
      for (let i = journal.length - 1; i >= 0; i--) {
        try { fs.renameSync(journal[i].dst, journal[i].src); } catch (_) { /* best-effort */ }
      }
      return { ok: false, files: [], error: 'Commit failed mid-transaction (rolled back): ' + err.message };
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
   * H-062: refuses targets outside this job's directory.
   *
   * @param {string|number} runId
   */
  rollback(runId) {
    const rd = this.runDir(runId);
    if (!_isStrictDescendant(this._jobDir, rd)) return;
    _rmSafe(rd);
  }

  /**
   * Full cleanup: remove the entire job directory.
   * Call after job is fully complete and outputs have been delivered.
   * H-062: refuses to delete the jobs root, non-descendant paths, or a
   * directory whose ownership manifest names a different job.
   */
  cleanup() {
    // Containment: the job dir must be a strict descendant of <base>/jobs.
    if (!_isStrictDescendant(this._jobsRoot, this._jobDir)) return;
    if (!fs.existsSync(this._jobDir)) return;
    // Ownership: only delete directories this workspace owns. A missing or
    // foreign manifest means the directory was not created by ensureJobDir
    // for this job — leave it alone.
    const manifest = _readManifest(path.join(this._jobDir, MANIFEST_NAME));
    if (!manifest || manifest.jobId !== this._jobId) return;
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
 * H-062: Validate an ID for use as a directory-name component. Throws on
 * anything outside the strict charset instead of silently rewriting it —
 * sanitizing created collisions ('a/b' and 'a:b' → 'a_b') and allowed the
 * empty ID to alias the jobs root.
 * @param {string} id
 * @param {string} label - For the error message ('jobId'/'runId').
 * @returns {string}
 */
function _validateId(id, label) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`JobWorkspace: invalid ${label} — must match [A-Za-z0-9_-]{1,64}.`);
  }
  return id;
}

/**
 * H-062: True when child is strictly inside parent (never equal, never
 * outside), using a resolved relative-path check.
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function _isStrictDescendant(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Read the ownership manifest (null when missing/unparseable).
 * @param {string} manifestPath
 * @returns {{ jobId: string }|null}
 */
function _readManifest(manifestPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return parsed && typeof parsed.jobId === 'string' ? parsed : null;
  } catch (_) {
    return null;
  }
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

module.exports = { JobWorkspace, DEFAULT_MAX_FILES, DEFAULT_MAX_BYTES, MANIFEST_NAME };
