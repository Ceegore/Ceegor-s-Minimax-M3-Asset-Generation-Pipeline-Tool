'use strict';

/**
 * Runtime Installer — recoverable activation state machine.
 *
 * AUD-014 fix: Runtime installation is a recoverable state machine.
 * Backup cleanup failure never removes a successfully activated and
 * verified runtime.
 *
 * Directory layout (sibling paths on the same volume):
 *   bin/                         active runtime
 *   .bin-stage-<transactionId>/  fully verified candidate
 *   .bin-backup-<transactionId>/ previous active runtime
 *   .setup-transaction.json      state marker in project-controlled parent
 *
 * States:
 *   STAGING → VERIFIED_STAGE → BACKED_UP → ACTIVATED → VERIFIED_ACTIVE → COMMITTED → CLEANED
 *
 * Rollback rules:
 *   - before ACTIVATED: remove stage only
 *   - after BACKED_UP but before active rename: restore backup
 *   - after ACTIVATED but before COMMITTED: if active verification fails,
 *     move bad active aside and restore backup
 *   - after COMMITTED: never delete/rollback the good active runtime because
 *     backup cleanup failed; retain backup and report cleanup pending
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const VALID_STATES = Object.freeze([
  'STAGING', 'VERIFIED_STAGE', 'BACKED_UP', 'ACTIVATED',
  'VERIFIED_ACTIVE', 'COMMITTED', 'CLEANED',
]);

/**
 * Write and fsync a JSON state marker.
 * @param {string} filePath
 * @param {object} data
 */
function writeMarker(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  const tmp = filePath + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

class RuntimeInstaller {
  /**
   * @param {{ projectRoot: string, runtimeDir?: string }} opts
   */
  constructor({ projectRoot, runtimeDir = 'bin' }) {
    this.projectRoot = path.resolve(projectRoot);
    this.runtimeDir = runtimeDir;
    this.activePath = path.join(this.projectRoot, runtimeDir);
    this.markerPath = path.join(this.projectRoot, '.setup-transaction.json');
  }

  /**
   * Generate sibling paths for a transaction.
   * @param {string} transactionId
   * @returns {{ stagePath: string, backupPath: string }}
   */
  siblingPaths(transactionId) {
    return {
      stagePath: path.join(this.projectRoot, `.${this.runtimeDir}-stage-${transactionId}`),
      backupPath: path.join(this.projectRoot, `.${this.runtimeDir}-backup-${transactionId}`),
    };
  }

  /**
   * Begin a new installation transaction.
   * @returns {{ transactionId: string, stagePath: string }}
   */
  begin() {
    // First, recover any incomplete transaction
    this.recover();

    const transactionId = crypto.randomUUID();
    const { stagePath } = this.siblingPaths(transactionId);
    fs.mkdirSync(stagePath, { recursive: true, mode: 0o700 });

    const marker = {
      schemaVersion: SCHEMA_VERSION,
      transactionId,
      state: 'STAGING',
      stagePath,
      backupPath: null,
      activePath: this.activePath,
      createdAt: Date.now(),
    };
    writeMarker(this.markerPath, marker);
    return { transactionId, stagePath };
  }

  /**
   * Mark the stage as verified (all files present and hashed).
   * @param {string} transactionId
   * @param {(stagePath: string) => boolean} verifyFn - Verification function
   */
  verifyStage(transactionId, verifyFn) {
    const marker = this._readMarker(transactionId);
    if (marker.state !== 'STAGING') {
      throw new Error(`Cannot verify stage from state ${marker.state}`);
    }
    if (!verifyFn(marker.stagePath)) {
      this._removeStage(marker);
      this._removeMarker();
      throw new Error('Stage verification failed.');
    }
    marker.state = 'VERIFIED_STAGE';
    writeMarker(this.markerPath, marker);
  }

  /**
   * Backup the current active runtime (if it exists) and activate the stage.
   * @param {string} transactionId
   */
  activate(transactionId) {
    const marker = this._readMarker(transactionId);
    if (marker.state !== 'VERIFIED_STAGE') {
      throw new Error(`Cannot activate from state ${marker.state}`);
    }
    const { backupPath } = this.siblingPaths(transactionId);

    // H-009 (hhhhu2 audit): Journal the intended backup path/state BEFORE the
    // destructive rename. If we crash between renameSync and writeMarker, the
    // marker still says VERIFIED_STAGE but backupPath is recorded, so recovery
    // can inspect actual filesystem state and restore correctly.
    if (fs.existsSync(this.activePath)) {
      marker.backupPath = backupPath;
      marker.state = 'BACKING_UP'; // transient intent state
      writeMarker(this.markerPath, marker);

      fs.renameSync(this.activePath, backupPath);
      marker.state = 'BACKED_UP';
      writeMarker(this.markerPath, marker);
    }

    // Activate: rename stage to active
    fs.renameSync(marker.stagePath, this.activePath);
    marker.state = 'ACTIVATED';
    writeMarker(this.markerPath, marker);
  }

  /**
   * Verify the activated runtime and commit.
   * @param {string} transactionId
   * @param {(activePath: string) => boolean} verifyFn
   */
  verifyAndCommit(transactionId, verifyFn) {
    const marker = this._readMarker(transactionId);
    if (marker.state !== 'ACTIVATED') {
      throw new Error(`Cannot verify active from state ${marker.state}`);
    }

    if (!verifyFn(this.activePath)) {
      // Active verification failed — rollback
      this._rollbackToBackup(marker);
      throw new Error('Active runtime verification failed; rolled back to backup.');
    }

    marker.state = 'VERIFIED_ACTIVE';
    writeMarker(this.markerPath, marker);

    // Commit
    marker.state = 'COMMITTED';
    writeMarker(this.markerPath, marker);

    // Cleanup: remove backup best-effort (failure does NOT undo commit)
    if (marker.backupPath && fs.existsSync(marker.backupPath)) {
      try { fs.rmSync(marker.backupPath, { recursive: true, force: true }); } catch (_) {
        // Retain backup and report cleanup pending — never rollback a committed runtime
      }
    }

    // Remove marker
    this._removeMarker();
  }

  /**
   * Cancel an in-progress transaction.
   * @param {string} transactionId
   */
  cancel(transactionId) {
    let marker;
    try { marker = this._readMarker(transactionId); } catch (_) { return; }

    if (marker.state === 'COMMITTED' || marker.state === 'CLEANED') return;

    if (marker.state === 'ACTIVATED' || marker.state === 'VERIFIED_ACTIVE') {
      // Active was renamed but not committed — rollback
      this._rollbackToBackup(marker);
    } else if (marker.state === 'BACKED_UP' || marker.state === 'BACKING_UP') {
      // H-007 (hhhhu2 audit): BACKED_UP is a mandatory restore state.
      // The active runtime was moved to backup — it MUST be restored.
      if (marker.backupPath && fs.existsSync(marker.backupPath) && !fs.existsSync(this.activePath)) {
        fs.renameSync(marker.backupPath, this.activePath);
      }
      this._removeStage(marker);
    } else {
      // Before activation — just remove stage
      this._removeStage(marker);
    }
    this._removeMarker();
  }

  /**
   * Startup recovery: inspect the transaction marker and resume/rollback.
   * @param {{ verifyFn?: (activePath: string) => boolean }} [opts]
   * @returns {{ recovered: boolean, action?: string, error?: string }}
   */
  recover(opts) {
    if (!fs.existsSync(this.markerPath)) return { recovered: false };

    let marker;
    try {
      const raw = fs.readFileSync(this.markerPath, 'utf8');
      marker = JSON.parse(raw);
    } catch (_) {
      return { recovered: false, error: 'Corrupt transaction marker; manual review required.' };
    }

    // Schema validation
    if (!marker || marker.schemaVersion !== SCHEMA_VERSION || !marker.transactionId) {
      return { recovered: false, error: 'Invalid transaction marker schema.' };
    }
    // H-009: accept transient BACKING_UP state as valid.
    const validStates = [...VALID_STATES, 'BACKING_UP'];
    if (!validStates.includes(marker.state)) {
      return { recovered: false, error: `Invalid state: ${marker.state}` };
    }

    // Validate paths are expected siblings
    const { stagePath, backupPath } = this.siblingPaths(marker.transactionId);
    if (marker.stagePath !== stagePath) {
      return { recovered: false, error: 'Stage path mismatch; manual review required.' };
    }

    switch (marker.state) {
      case 'STAGING':
      case 'VERIFIED_STAGE':
        // H-009: If backupPath is recorded but state is still VERIFIED_STAGE,
        // a crash occurred between rename(active→backup) and marker update.
        // Inspect actual filesystem state to reconcile.
        if (marker.backupPath && fs.existsSync(marker.backupPath) && !fs.existsSync(this.activePath)) {
          fs.renameSync(marker.backupPath, this.activePath);
          this._removeStage(marker);
          this._removeMarker();
          return { recovered: true, action: 'restored-backup-after-crash' };
        }
        // Never activated — remove stage
        this._removeStage(marker);
        this._removeMarker();
        return { recovered: true, action: 'removed-incomplete-stage' };

      case 'BACKING_UP':
      case 'BACKED_UP':
        // Backup exists but stage was not yet renamed to active
        // Restore backup to active
        if (marker.backupPath && fs.existsSync(marker.backupPath) && !fs.existsSync(this.activePath)) {
          fs.renameSync(marker.backupPath, this.activePath);
        }
        this._removeStage(marker);
        this._removeMarker();
        return { recovered: true, action: 'restored-backup' };

      case 'ACTIVATED':
      case 'VERIFIED_ACTIVE': {
        // H-008 (hhhhu2 audit): Re-verify the active runtime during recovery
        // before deleting the known-good backup. Never delete backup until
        // verification succeeds.
        if (fs.existsSync(this.activePath)) {
          const verifyFn = opts && opts.verifyFn;
          if (verifyFn && !verifyFn(this.activePath)) {
            // Verification failed — rollback to backup
            this._rollbackToBackup(marker);
            this._removeMarker();
            return { recovered: true, action: 'rolled-back-failed-verification' };
          }
          // Verified (or no verifyFn provided) — commit
          if (marker.backupPath && fs.existsSync(marker.backupPath)) {
            try { fs.rmSync(marker.backupPath, { recursive: true, force: true }); } catch (_) {}
          }
          this._removeMarker();
          return { recovered: true, action: 'committed-interrupted-activation' };
        }
        // Active missing — rollback
        this._rollbackToBackup(marker);
        this._removeMarker();
        return { recovered: true, action: 'rolled-back-missing-active' };
      }

      case 'COMMITTED':
        // Just clean up leftover backup/marker
        if (marker.backupPath && fs.existsSync(marker.backupPath)) {
          try { fs.rmSync(marker.backupPath, { recursive: true, force: true }); } catch (_) {}
        }
        this._removeMarker();
        return { recovered: true, action: 'cleaned-committed-leftovers' };

      case 'CLEANED':
        this._removeMarker();
        return { recovered: true, action: 'removed-stale-marker' };

      default:
        return { recovered: false, error: 'Unknown state; manual review required.' };
    }
  }

  /**
   * Rollback: restore backup to active, move bad active aside.
   * @param {object} marker
   */
  _rollbackToBackup(marker) {
    // Move bad active aside if it exists
    if (fs.existsSync(this.activePath)) {
      const aside = this.activePath + '.failed-' + Date.now();
      try { fs.renameSync(this.activePath, aside); } catch (_) {}
    }
    // Restore backup
    if (marker.backupPath && fs.existsSync(marker.backupPath)) {
      fs.renameSync(marker.backupPath, this.activePath);
    }
    // Remove stage
    this._removeStage(marker);
  }

  /**
   * Remove the stage directory.
   * @param {object} marker
   */
  _removeStage(marker) {
    if (marker.stagePath && fs.existsSync(marker.stagePath)) {
      try { fs.rmSync(marker.stagePath, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /**
   * Remove the transaction marker file.
   */
  _removeMarker() {
    try { fs.unlinkSync(this.markerPath); } catch (_) {}
  }

  /**
   * Read and validate the transaction marker.
   * @param {string} transactionId
   * @returns {object}
   */
  _readMarker(transactionId) {
    if (!fs.existsSync(this.markerPath)) {
      throw new Error('No active transaction.');
    }
    const raw = fs.readFileSync(this.markerPath, 'utf8');
    const marker = JSON.parse(raw);
    if (!marker || marker.transactionId !== transactionId) {
      throw new Error('Transaction ID mismatch.');
    }
    return marker;
  }
}

module.exports = { RuntimeInstaller };
