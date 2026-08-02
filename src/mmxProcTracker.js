// src/mmxProcTracker.js
// ============================================================================
// Process tracking + kill/cancel logic for src/mmx.js.
// Extracted to keep mmx.js under its frozen 542-LOC SIZE-BUDGET.
//
// Track every active mmx proc so individual jobs can be cancelled on demand.
// The renderer runs multiple jobs in parallel (one per tab + secondary jobs
// for post-processing), so a single-slot tracker no longer works. We track
// the whole Set and expose cancelOne(proc) / getActiveProcs() / cancelAll()
// helpers. cancelAll() remains the "panic" button.
// ============================================================================
'use strict';

const currentGenProcs = new Set();
// Map<jobId, proc> alongside the Set above, populated only when
// runMmx({..., jobId}) is given one. Lets JobRunner.cancel(jobId) kill exactly
// that job's proc instead of every in-flight generation.
const procsByJobId = new Map();

function getActiveProcs() {
  return Array.from(currentGenProcs);
}

// SIGKILL escalation. Windows is fine (proc.kill uses TerminateProcess which
// can't be caught), but on macOS/Linux a mmx child that catches SIGTERM
// survives. Send SIGTERM, then SIGKILL after 2s, mirroring the isnetbg
// timeout pattern. We tag the proc as user-canceled so the close handler can
// resolve with { canceled: true } instead of a bare code:null error (H7-025).
function _killWithEscalation(proc, opts) {
  if (opts && opts.userCanceled && proc) {
    try { proc._canceledByUser = true; } catch (_) {}
  }
  // BUG FIX: the old code checked `proc.killed` to decide whether to
  // escalate to SIGKILL. However, Node.js sets proc.killed = true as
  // soon as kill('SIGTERM') is successfully CALLED (signal sent), NOT
  // when the process actually exits. A child that catches SIGTERM and
  // keeps running would have proc.killed === true, so the SIGKILL
  // escalation never fired. Fix: track actual exit via 'exit' event.
  let _exited = false;
  proc.once('exit', () => { _exited = true; });
  try { proc.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => {
    try {
      // Only escalate if the proc is still running. On Windows
      // TerminateProcess already reaped the proc so _exited is true.
      if (!_exited) proc.kill('SIGKILL');
    } catch (_) {}
  }, 2000).unref();
}

function cancelOne(proc) {
  if (!proc) return false;
  if (!currentGenProcs.has(proc)) return false;
  _killWithEscalation(proc, { userCanceled: true });
  return true;
}

function cancelByJobId(jobId) {
  if (!jobId) return false;
  const proc = procsByJobId.get(jobId);
  if (!proc) return false;
  return cancelOne(proc);
}

function cancelAll() {
  for (const p of currentGenProcs) {
    _killWithEscalation(p, { userCanceled: true });
  }
  currentGenProcs.clear();
  procsByJobId.clear();
}

module.exports = {
  currentGenProcs,
  procsByJobId,
  getActiveProcs,
  killWithEscalation: _killWithEscalation,
  cancelOne,
  cancelByJobId,
  cancelAll,
};
