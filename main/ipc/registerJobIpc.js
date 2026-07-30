// main/ipc/registerJobIpc.js
// R6.6.1: Unified job cancellation IPC.
//
// Before R6.6.1, only mmx jobs could be cancelled (via mmx:cancel).
// The other backends (Real-ESRGAN, IS-Net, Inpaint, Sharp) had NO
// cancel support — the renderer's pipelineOps.js cancel() could only
// set a flag that discarded the result AFTER the process finished.
//
// This handler exposes a unified `job:cancel` IPC that routes through
// the shared jobRegistry. Backends register their spawned processes
// with the registry (R6.6.2-R6.6.5), and this handler kills them.
//
// The existing `mmx:cancel` IPC remains unchanged (it routes through
// src/mmx.js#cancelByJobId). Once all backends are migrated to the
// jobRegistry (R6.6.2-R6.6.5), mmx:cancel can be deprecated in favor
// of job:cancel.

'use strict';

const { ipcMain } = require('electron');
const jobRegistry = require('../../src/jobRegistry');
// P1-A (360° Audit H-001): secure IPC wrapper.
const { secureHandle } = require('./secureHandle');

/**
 * @param {{ getMainWindow: () => (Electron.BrowserWindow|null) }} _deps
 */
function register(deps) {
  const getMainWindow = (deps && typeof deps.getMainWindow === 'function') ? deps.getMainWindow : () => null;
  // Cancel a specific job by jobId.
  // Returns { ok: true } if the job was found and kill was attempted,
  // { ok: false, error } if the job was not found.
  secureHandle('job:cancel', { getMainWindow }, (_event, opts) => {
    const jobId = opts && opts.jobId;
    if (!jobId) return { ok: false, error: 'Missing jobId' };
    const found = jobRegistry.cancel(jobId);
    if (!found) return { ok: false, error: 'Job not found or already finished' };
    return { ok: true };
  });

  // Cancel ALL registered jobs (panic button / app shutdown).
  // Returns { ok: true, count } where count is the number of jobs killed.
  secureHandle('job:cancel-all', { getMainWindow }, () => {
    const count = jobRegistry.cancelAll();
    return { ok: true, count };
  });

  // Query active jobs (for debugging / ActiveJobsWidget extension).
  // Returns { ok: true, jobs: [...] }.
  secureHandle('job:list', { getMainWindow }, () => {
    // P5 (M-039): never hand the renderer the job `meta` — backends store
    // srcPath/dstPath there, so passing it through leaked absolute file
    // paths to any renderer caller. Project only the fields a job widget
    // needs; the paths stay main-side.
    const jobs = jobRegistry.getActiveJobs().map((j) => ({
      jobId: j.jobId,
      runId: j.runId,
      backend: j.backend,
      startedAt: j.startedAt,
      alive: j.alive,
    }));
    return { ok: true, jobs };
  });
}

module.exports = { register };
