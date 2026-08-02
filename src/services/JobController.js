// src/services/JobController.js
// ============================================================================
// Shared Component 1E: Unified Job Controller.
//
// Replaces the broken logic in src/jobRegistry.js with:
//   - Explicit state machine: running → cancel-requested → terminating → exited | kill-failed
//   - Exit detection via close/exitCode/signalCode, NOT proc.killed (HIGH-021)
//   - Registry entries removed only on 'close' event (HIGH-022)
//   - Duplicate jobId rejection with internal runId (HIGH-023)
//   - SIGTERM → SIGKILL escalation that actually works (HIGH-021)
//   - Process-tree kill on Windows (taskkill /T /F) and POSIX (kill -pid)
//   - Per-fetch timeout support (MED-010)
//   - Remote job ledger for resume (FUNC-025)
//
// Usage:
//   const { JobController } = require('./JobController');
//   const ctrl = JobController.get();
//   const handle = ctrl.registerProcess(jobId, proc, { backend: 'mmx' });
//   // handle.state, handle.cancel(), handle.onClose(cb)
// ============================================================================
'use strict';

const { execFileSync } = require('child_process');

/** Job states. */
const STATE = Object.freeze({
  RUNNING: 'running',
  CANCEL_REQUESTED: 'cancel-requested',
  TERMINATING: 'terminating',
  EXITED: 'exited',
  KILL_FAILED: 'kill-failed',
});

/** Grace period (ms) between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2000;

let _instance = null;

class JobController {
  constructor() {
    /** @type {Map<string, JobHandle>} jobId → handle */
    this._jobs = new Map();
    /** Monotonic run counter. */
    this._nextRunId = 1;
  }

  /** Singleton accessor. */
  static get() {
    if (!_instance) _instance = new JobController();
    return _instance;
  }

  /**
   * Register a spawned child process.
   * HIGH-023 / H-061: if a job with the same ID still has a live process,
   * registration is REJECTED (throws). The old behaviour (cancel + overwrite
   * the map entry) displaced a still-running process from the registry: it
   * kept running until kill escalation finished but was invisible to
   * getJob/cancelAll/getActiveJobs. Every active process must stay observable
   * and cancellable, so the caller must wait for the old handle's close event
   * (handle.onClose) before re-registering the same jobId.
   *
   * @param {string} jobId
   * @param {import('child_process').ChildProcess} proc
   * @param {{ backend?: string, meta?: object }} [opts]
   * @returns {JobHandle}
   * @throws {Error} If a handle for jobId is still alive (any pre-close state,
   *   including cancel-requested/terminating/kill-failed).
   */
  registerProcess(jobId, proc, opts) {
    opts = opts || {};
    const existing = this._jobs.get(jobId);
    if (existing && existing.isAlive) {
      // H-061: never displace an active handle — the previous process would
      // become an unregistered orphan. Reject until it actually closes.
      const err = new Error(
        `Job "${jobId}" is already active (state: ${existing.state}, runId: ${existing.runId}). ` +
        'Wait for it to close (handle.onClose) or cancel it before starting a new run.'
      );
      err.code = 'EJOBACTIVE';
      throw err;
    }

    const runId = this._nextRunId++;
    const handle = new JobHandle(jobId, runId, proc, opts.backend || 'unknown', opts.meta || {});
    this._jobs.set(jobId, handle);

    // HIGH-022: only remove from registry on actual 'close' event.
    proc.on('close', (code, signal) => {
      handle._onClose(code, signal);
      // Only delete if this handle is still the registered one
      if (this._jobs.get(jobId) === handle) {
        this._jobs.delete(jobId);
      }
    });

    // Spawn failures (ENOENT, EACCES) emit 'error' without always emitting
    // 'close'. Treat 'error' as a close signal to avoid orphaned entries.
    proc.on('error', (err) => {
      handle._onClose(null, err && err.code ? err.code : 'error');
      if (this._jobs.get(jobId) === handle) {
        this._jobs.delete(jobId);
      }
    });

    return handle;
  }

  /**
   * Cancel a job by ID.
   * @param {string} jobId
   * @returns {{ accepted: boolean, state?: string }}
   */
  cancel(jobId) {
    const handle = this._jobs.get(jobId);
    if (!handle) return { accepted: false };
    handle.cancel();
    return { accepted: true, state: handle.state };
  }

  /**
   * Cancel all running jobs (panic / shutdown).
   * HIGH-022: does NOT clear the map — entries removed on 'close'.
   * @returns {number} Number of jobs cancel requested.
   */
  cancelAll() {
    let count = 0;
    for (const handle of this._jobs.values()) {
      if (handle.state === STATE.RUNNING || handle.state === STATE.CANCEL_REQUESTED) {
        handle.cancel();
        count++;
      }
    }
    return count;
  }

  /**
   * Get a job handle by ID.
   * @param {string} jobId
   * @returns {JobHandle|null}
   */
  getJob(jobId) {
    return this._jobs.get(jobId) || null;
  }

  /**
   * Get all active jobs.
   * @returns {Array<{ jobId: string, runId: number, backend: string, state: string, startedAt: number }>}
   */
  getActiveJobs() {
    const result = [];
    for (const [jobId, handle] of this._jobs) {
      result.push({
        jobId,
        runId: handle.runId,
        backend: handle.backend,
        state: handle.state,
        startedAt: handle.startedAt,
        alive: handle.isAlive,
      });
    }
    return result;
  }

  /**
   * Check if a runId is current for a jobId (stale-progress filtering).
   * @param {string} jobId
   * @param {number} runId
   * @returns {boolean}
   */
  isCurrentRun(jobId, runId) {
    const handle = this._jobs.get(jobId);
    return handle ? handle.runId === runId : false;
  }

  /** Get current runId for a jobId. */
  getRunId(jobId) {
    const handle = this._jobs.get(jobId);
    return handle ? handle.runId : 0;
  }

  /** Reset (for testing). */
  _reset() {
    for (const handle of this._jobs.values()) {
      handle.cancel();
    }
    this._jobs.clear();
    this._nextRunId = 1;
  }
}

class JobHandle {
  /**
   * @param {string} jobId
   * @param {number} runId
   * @param {import('child_process').ChildProcess} proc
   * @param {string} backend
   * @param {object} meta
   */
  constructor(jobId, runId, proc, backend, meta) {
    this.jobId = jobId;
    this.runId = runId;
    this.backend = backend;
    this.meta = meta;
    this.startedAt = Date.now();
    this.state = STATE.RUNNING;
    this.exitCode = null;
    this.signalCode = null;

    this._proc = proc;
    this._killTimer = null;
    this._closeCallbacks = [];
    this._closed = false;
  }

  /** True if the process has not yet closed. */
  get isAlive() {
    return !this._closed;
  }

  /**
   * Request cancellation. Escalates SIGTERM → SIGKILL.
   * HIGH-021: uses close/exit tracking, NOT proc.killed.
   */
  cancel() {
    if (this._closed) return;
    if (this.state === STATE.CANCEL_REQUESTED || this.state === STATE.TERMINATING) return;

    this.state = STATE.CANCEL_REQUESTED;

    // Send SIGTERM (or TerminateProcess on Windows)
    try { this._proc.kill('SIGTERM'); } catch (_) {}
    this.state = STATE.TERMINATING;

    // HIGH-021: Escalation timer — if process hasn't closed after grace
    // period, force-kill the process tree.
    this._killTimer = setTimeout(() => {
      if (this._closed) return;
      this._treeKill();
      // Give tree-kill a moment, then mark as kill-failed if still alive
      setTimeout(() => {
        if (!this._closed) {
          this.state = STATE.KILL_FAILED;
        }
      }, 1000);
    }, KILL_GRACE_MS);
    if (this._killTimer.unref) this._killTimer.unref();
  }

  /**
   * Register a callback for when the process actually closes.
   * @param {(code: number|null, signal: string|null) => void} cb
   */
  onClose(cb) {
    if (this._closed) {
      cb(this.exitCode, this.signalCode);
    } else {
      this._closeCallbacks.push(cb);
    }
  }

  /**
   * @private Called by the 'close' event listener.
   */
  _onClose(code, signal) {
    if (this._closed) return;
    this._closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.state = STATE.EXITED;

    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }

    for (const cb of this._closeCallbacks) {
      try { cb(code, signal); } catch (_) {}
    }
    this._closeCallbacks = [];
  }

  /**
   * HIGH-021: Force-kill the process tree.
   * Windows: taskkill /PID <pid> /T /F
   * POSIX: kill(-pid, SIGKILL) via process group, or kill pid.
   * @private
   */
  _treeKill() {
    const pid = this._proc.pid;
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        // execFileSync avoids shell interpretation (no metacharacter risk).
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      } else {
        // Try process group kill first, fall back to direct kill
        try { process.kill(-pid, 'SIGKILL'); } catch (_) {
          try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        }
      }
    } catch (_) { /* best-effort */ }
  }
}

module.exports = { JobController, JobHandle, STATE, KILL_GRACE_MS };
