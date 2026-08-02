// tests/unit/src/services/JobController.h061.test.js
// ============================================================================
// H-061 regression: registerProcess must NEVER displace a live handle.
// The old behaviour (cancel + overwrite) removed a still-running process from
// the registry — it kept running but was invisible to getJob/cancelAll.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { JobController, STATE } = require('../../../../src/services/JobController');

/** Fake child process: EventEmitter with pid + a kill() that ignores signals. */
function fakeProc(pid) {
  const p = new EventEmitter();
  p.pid = pid || 4242;
  p.killCalls = [];
  p.kill = (sig) => { p.killCalls.push(sig); return true; }; // SIGTERM-ignoring
  return p;
}

test('H-061: second registerProcess for a live jobId throws EJOBACTIVE', () => {
  const ctrl = new JobController();
  const oldProc = fakeProc(1);
  const handle = ctrl.registerProcess('job-a', oldProc, { backend: 'mmx' });
  assert.equal(handle.state, STATE.RUNNING);

  const newProc = fakeProc(2);
  assert.throws(
    () => ctrl.registerProcess('job-a', newProc),
    (err) => err.code === 'EJOBACTIVE' && /already active/.test(err.message)
  );

  // The ORIGINAL process must still be observable and cancellable.
  assert.equal(ctrl.getJob('job-a'), handle);
  const active = ctrl.getActiveJobs();
  assert.equal(active.length, 1);
  assert.equal(active[0].runId, handle.runId);
  assert.equal(active[0].alive, true);
  ctrl._reset();
});

test('H-061: rejection also applies while cancel is in flight (SIGTERM ignored)', () => {
  const ctrl = new JobController();
  const oldProc = fakeProc(1);
  const handle = ctrl.registerProcess('job-b', oldProc);

  // Cancel — the fake proc ignores SIGTERM, so no close event fires.
  ctrl.cancel('job-b');
  assert.equal(handle.state, STATE.TERMINATING);
  assert.equal(handle.isAlive, true);
  assert.deepEqual(oldProc.killCalls, ['SIGTERM']);

  // Still alive → still rejected. The zombie stays visible until it closes.
  assert.throws(() => ctrl.registerProcess('job-b', fakeProc(2)), /EJOBACTIVE|already active/);
  assert.equal(ctrl.getJob('job-b'), handle, 'zombie must remain in the registry');

  // cancelAll still sees it (RUNNING/CANCEL_REQUESTED filter excludes
  // TERMINATING by design, but the handle itself is still registered).
  assert.equal(ctrl.getActiveJobs().length, 1);
  ctrl._reset();
});

test('H-061: after the old process closes, re-registration succeeds with a new runId', () => {
  const ctrl = new JobController();
  const oldProc = fakeProc(1);
  const oldHandle = ctrl.registerProcess('job-c', oldProc);
  const oldRunId = oldHandle.runId;

  let closed = false;
  oldHandle.onClose(() => { closed = true; });
  oldProc.emit('close', 0, null);
  assert.equal(closed, true);
  assert.equal(oldHandle.state, STATE.EXITED);
  assert.equal(ctrl.getJob('job-c'), null, 'closed handle removed from registry');

  const newProc = fakeProc(2);
  const newHandle = ctrl.registerProcess('job-c', newProc);
  assert.notEqual(newHandle.runId, oldRunId);
  assert.equal(ctrl.getJob('job-c'), newHandle);
  assert.equal(ctrl.isCurrentRun('job-c', newHandle.runId), true);
  assert.equal(ctrl.isCurrentRun('job-c', oldRunId), false);
  ctrl._reset();
});

test('H-061: late close of an old handle never deletes the new registration', () => {
  const ctrl = new JobController();
  const oldProc = fakeProc(1);
  ctrl.registerProcess('job-d', oldProc);
  oldProc.emit('close', 1, null); // old slot freed

  const newProc = fakeProc(2);
  const newHandle = ctrl.registerProcess('job-d', newProc);

  // A duplicate/spurious close from the OLD process must not evict the new
  // handle (identity check in the close listener).
  oldProc.emit('close', 1, null);
  assert.equal(ctrl.getJob('job-d'), newHandle);
  ctrl._reset();
});
