// src/jobRegistry.js
// R6.6.1: Gemeinsame JobRegistry — shared job registry for ALL backend
// child processes (mmx, Real-ESRGAN, IS-Net/BiRefNet, Inpaint, Sharp).
//
// Before R6.6.1, only mmx.js tracked spawned processes (procsByJobId)
// and supported per-job cancellation. The other backends (realesrgan,
// isnetbg, inpaint, sharp) spawned processes with NO cancel support —
// the renderer's pipelineOps.js cancel() could only set a flag that
// discarded the result AFTER the process finished ("best-effort: the
// spawn can't be killed mid-flight without a jobId").
//
// This module provides a unified registry so ANY backend can:
//   1. Register a spawned child process with a jobId
//   2. Cancel a specific job (SIGTERM → SIGKILL escalation)
//   3. Cancel all jobs (panic button / app shutdown)
//   4. Query active jobs
//   5. Filter stale progress events via runId
//
// Usage (backend wrapper, e.g. realesrgan.js):
//   const { register, unregister } = require('./jobRegistry');
//   const proc = spawn(binary, args);
//   const runId = register(jobId, proc, { backend: 'realesrgan', srcPath, dstPath });
//   proc.on('close', () => { unregister(jobId); ... });
//
// Usage (IPC cancel handler):
//   const { cancel, cancelAll } = require('./jobRegistry');
//   ipcMain.handle('job:cancel', (e, { jobId }) => cancel(jobId));
//
// Run-ID stale-progress filtering:
//   Each register() call returns a unique runId (monotonic counter).
//   Progress events forwarded to the renderer include the runId; the
//   renderer ignores events whose runId doesn't match the current run
//   for that jobId. This prevents a slow stale process from updating
//   the UI after a new run has started for the same jobId.

'use strict';

// Map<jobId, { proc, backend, runId, meta, startedAt }>
const _jobs = new Map();

// Monotonic run-ID counter. Never resets during the app lifetime
// (main process restart resets it, which is fine — the renderer
// also restarts and clears its stale-progress state).
let _nextRunId = 1;

/**
 * Register a spawned child process.
 *
 * @param {string} jobId - Unique job identifier (from renderer's JobRunner).
 * @param {import('child_process').ChildProcess} proc - The spawned process.
 * @param {object} [meta] - Optional metadata (backend, srcPath, dstPath, etc.).
 * @returns {number} runId - Unique run identifier for stale-progress filtering.
 */
function register(jobId, proc, meta) {
  if (!jobId || !proc) return 0;
  const runId = _nextRunId++;
  // If a prior job with the same jobId exists (rare — the renderer
  // should cancel first), kill it before replacing. This prevents
  // orphaned processes when the user rapidly re-runs the same item.
  const prior = _jobs.get(jobId);
  if (prior && prior.proc && !prior.proc.killed) {
    _killWithEscalation(prior.proc);
  }
  _jobs.set(jobId, {
    proc,
    runId,
    backend: (meta && meta.backend) || 'unknown',
    meta: meta || {},
    startedAt: Date.now(),
  });
  return runId;
}

/**
 * Unregister a job (called when the process exits).
 * R6.6.3.AuditFix: proc-aware — if `proc` is provided, only delete
 * the entry if it still references the same ChildProcess. This
 * prevents a stale 'close' event from an old killed proc from
 * deleting a NEWER entry that was registered with the same jobId.
 *
 * @param {string} jobId
 * @param {import('child_process').ChildProcess} [proc] - The process that exited.
 * @returns {boolean} true if the job was registered and removed.
 */
function unregister(jobId, proc) {
  if (proc) {
    const entry = _jobs.get(jobId);
    if (entry && entry.proc !== proc) return false; // stale close event
  }
  return _jobs.delete(jobId);
}

/**
 * Cancel a specific job by jobId.
 * Uses SIGTERM → SIGKILL escalation (2s grace period).
 *
 * @param {string} jobId
 * @returns {boolean} true if the job was found and kill was attempted.
 */
function cancel(jobId) {
  if (!jobId) return false;
  const entry = _jobs.get(jobId);
  if (!entry || !entry.proc) return false;
  if (entry.proc.killed) return true; // already killed
  _killWithEscalation(entry.proc);
  return true;
}

/**
 * Cancel ALL registered jobs (panic button / app shutdown).
 *
 * @returns {number} Number of jobs killed.
 */
function cancelAll() {
  let count = 0;
  for (const entry of _jobs.values()) {
    if (entry.proc && !entry.proc.killed) {
      _killWithEscalation(entry.proc);
      count++;
    }
  }
  _jobs.clear();
  return count;
}

/**
 * Get info about a specific job.
 *
 * @param {string} jobId
 * @returns {object|null} { jobId, runId, backend, meta, startedAt, alive }
 */
function getJob(jobId) {
  const entry = _jobs.get(jobId);
  if (!entry) return null;
  return {
    jobId,
    runId: entry.runId,
    backend: entry.backend,
    meta: entry.meta,
    startedAt: entry.startedAt,
    alive: !entry.proc.killed,
  };
}

/**
 * Get all active jobs.
 *
 * @returns {Array<{ jobId, runId, backend, meta, startedAt, alive }>}
 */
function getActiveJobs() {
  const result = [];
  for (const [jobId, entry] of _jobs) {
    result.push({
      jobId,
      runId: entry.runId,
      backend: entry.backend,
      meta: entry.meta,
      startedAt: entry.startedAt,
      alive: !entry.proc.killed,
    });
  }
  return result;
}

/**
 * Check if a runId is current (not stale) for a given jobId.
 * Used by progress-forwarding code to filter stale events.
 *
 * @param {string} jobId
 * @param {number} runId
 * @returns {boolean} true if the runId matches the current run for jobId.
 */
function isCurrentRun(jobId, runId) {
  const entry = _jobs.get(jobId);
  if (!entry) return false;
  return entry.runId === runId;
}

/**
 * Get the current runId for a jobId.
 *
 * @param {string} jobId
 * @returns {number} runId, or 0 if not registered.
 */
function getRunId(jobId) {
  const entry = _jobs.get(jobId);
  return entry ? entry.runId : 0;
}

/**
 * SIGTERM → SIGKILL escalation.
 * Windows: proc.kill() uses TerminateProcess (can't be caught).
 * macOS/Linux: SIGTERM first, SIGKILL after 2s if still alive.
 *
 * @param {import('child_process').ChildProcess} proc
 */
function _killWithEscalation(proc) {
  try { proc.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill('SIGKILL');
    } catch (_) {}
  }, 2000).unref();
}

/**
 * Reset the registry (for testing).
 */
function _reset() {
  _jobs.clear();
  _nextRunId = 1;
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
