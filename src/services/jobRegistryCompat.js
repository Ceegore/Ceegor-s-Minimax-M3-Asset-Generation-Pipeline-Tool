// src/services/jobRegistryCompat.js
// ============================================================================
// H-009 (_5 audit): Compatibility shim — exposes the SAME API as the legacy
// src/jobRegistry.js but delegates to the hardened JobController singleton.
//
// This allows a zero-downtime migration: every backend that previously did
//   const jobRegistry = require('./jobRegistry');
// now does
//   const jobRegistry = require('./services/jobRegistryCompat');
// and gets identical behaviour EXCEPT:
//   - Process status is based on 'close' events, NOT proc.killed (HIGH-021)
//   - Registry entries are removed only on actual process exit (HIGH-022)
//   - Duplicate active jobIds are rejected, not silently overwritten (HIGH-023)
//   - cancelAll does NOT clear the map before processes exit (HIGH-022)
//   - Process-tree kill on Windows (taskkill /T /F) and POSIX (kill -pid)
//
// Once all backends are migrated and one release cycle passes, the legacy
// src/jobRegistry.js can be deleted.
// ============================================================================
'use strict';

const { JobController } = require('./JobController');

/**
 * Register a spawned child process.
 * Mirrors the legacy jobRegistry.register(jobId, proc, meta) API.
 *
 * @param {string} jobId - Unique job identifier (from renderer's JobRunner).
 * @param {import('child_process').ChildProcess} proc - The spawned process.
 * @param {object} [meta] - Optional metadata (backend, srcPath, dstPath, etc.).
 * @returns {number} runId - Unique run identifier for stale-progress filtering.
 */
function register(jobId, proc, meta) {
  if (!jobId || !proc) return 0;
  const ctrl = JobController.get();
  try {
    const handle = ctrl.registerProcess(jobId, proc, {
      backend: (meta && meta.backend) || 'unknown',
      meta: meta || {},
    });
    return handle.runId;
  } catch (e) {
    // H-061: if the jobId is already active (EJOBACTIVE), the legacy
    // behaviour was to kill the prior proc and overwrite. The new behaviour
    // rejects — but to avoid breaking callers that don't handle the throw,
    // we cancel the old job, wait a tick, and retry once.
    if (e.code === 'EJOBACTIVE') {
      ctrl.cancel(jobId);
      // The old handle will be removed on 'close'. Give it a moment.
      // In practice, SIGTERM on Windows is immediate (TerminateProcess).
      const oldHandle = ctrl.getJob(jobId);
      if (oldHandle) {
        // Synchronous fallback: if the old proc is already closed (race),
        // retry immediately.
        if (!oldHandle.isAlive) {
          const handle = ctrl.registerProcess(jobId, proc, {
            backend: (meta && meta.backend) || 'unknown',
            meta: meta || {},
          });
          return handle.runId;
        }
        // Register a one-shot retry on close.
        oldHandle.onClose(() => {
          try {
            ctrl.registerProcess(jobId, proc, {
              backend: (meta && meta.backend) || 'unknown',
              meta: meta || {},
            });
          } catch (_) { /* best-effort: the caller's proc is running but unregistered */ }
        });
      }
      // Return 0 to signal "registered asynchronously" — the caller's
      // stale-progress filtering still works because runId 0 never matches
      // a real runId (which starts at 1).
      return 0;
    }
    throw e;
  }
}

/**
 * Unregister a job (called when the process exits).
 * In the JobController model, removal happens automatically on 'close'.
 * This is a no-op kept for API compatibility.
 *
 * @param {string} _jobId
 * @param {import('child_process').ChildProcess} [_proc]
 * @returns {boolean} Always true (the controller handles lifecycle).
 */
function unregister(_jobId, _proc) {
  // JobController removes entries on 'close' event — no manual cleanup needed.
  return true;
}

/**
 * Cancel a specific job by jobId.
 * Uses SIGTERM → SIGKILL escalation with process-tree kill.
 *
 * @param {string} jobId
 * @returns {boolean} true if the job was found and cancel was requested.
 */
function cancel(jobId) {
  if (!jobId) return false;
  const result = JobController.get().cancel(jobId);
  return result.accepted;
}

/**
 * Cancel ALL registered jobs (panic button / app shutdown).
 * Does NOT clear the map — entries are removed on 'close' (HIGH-022 fix).
 *
 * @returns {number} Number of jobs cancel requested.
 */
function cancelAll() {
  return JobController.get().cancelAll();
}

/**
 * Get info about a specific job.
 * Returns the same shape as the legacy jobRegistry.getJob().
 *
 * @param {string} jobId
 * @returns {object|null} { jobId, runId, backend, meta, startedAt, alive }
 */
function getJob(jobId) {
  const handle = JobController.get().getJob(jobId);
  if (!handle) return null;
  return {
    jobId: handle.jobId,
    runId: handle.runId,
    backend: handle.backend,
    meta: handle.meta,
    startedAt: handle.startedAt,
    alive: handle.isAlive,
  };
}

/**
 * Get all active jobs.
 *
 * @returns {Array<{ jobId, runId, backend, meta, startedAt, alive }>}
 */
function getActiveJobs() {
  return JobController.get().getActiveJobs().map((j) => ({
    jobId: j.jobId,
    runId: j.runId,
    backend: j.backend,
    meta: j.meta || {},
    startedAt: j.startedAt,
    alive: j.alive,
  }));
}

/**
 * Check if a runId is current (not stale) for a given jobId.
 *
 * @param {string} jobId
 * @param {number} runId
 * @returns {boolean}
 */
function isCurrentRun(jobId, runId) {
  return JobController.get().isCurrentRun(jobId, runId);
}

/**
 * Get the current runId for a jobId.
 *
 * @param {string} jobId
 * @returns {number} runId, or 0 if not registered.
 */
function getRunId(jobId) {
  return JobController.get().getRunId(jobId);
}

/**
 * Reset the registry (for testing).
 */
function _reset() {
  JobController.get()._reset();
}

module.exports = {
  register,
  unregister,
  cancel,
  cancelAll,
  getJob,
  getActiveJobs,
  isCurrentRun,
  getRunId,
  _reset,
};
