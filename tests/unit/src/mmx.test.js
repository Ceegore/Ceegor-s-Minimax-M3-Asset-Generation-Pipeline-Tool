// tests/unit/src/mmx.test.js
// Regression tests for bug-fix H4/Phase1 (_temp4.md): JobRunner.cancel(jobId)
// needs to kill exactly ONE mmx child process, not every in-flight
// generation. src/mmx.js already tracked every spawned proc in a Set
// (currentGenProcs) for the panic-button cancelAll() — these tests cover
// the NEW jobId-keyed tracking (procsByJobId) and cancelByJobId().
//
// resolve() (the node.exe / mmx-cli path lookup) is made to succeed
// deterministically by mocking fs.existsSync, rather than depending on a
// real mmx-cli install on the test machine. The resolved "command" is
// intentionally bogus (nothing real listens on that path) — runMmx still
// calls child_process.spawn() synchronously and gets back a real
// ChildProcess object immediately (Node does not throw synchronously for
// an unspawnable command; the ENOENT surfaces async via the 'error'
// event), which is enough to exercise the tracking/cancel logic for real
// without needing mmx-cli, an API key, or a real subprocess that does
// anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MMX_PATH = path.join(ROOT, 'src', 'mmx.js');

function freshMmx(t) {
  delete require.cache[MMX_PATH];
  // fs.existsSync is accessed as a property (fs.existsSync(...)) inside
  // src/mmx.js, not destructured at require-time, so mocking it on the
  // shared `fs` module object DOES affect src/mmx.js's internal calls.
  t.mock.method(fs, 'existsSync', () => true);
  return require(MMX_PATH);
}

test('runMmx tracks the spawned proc by jobId, and cancelByJobId kills only that job (H4)', async (t) => {
  const mmx = freshMmx(t);
  const p1 = mmx.runMmx({ args: ['image', '--prompt', 'x'], apiKey: 'sk-test', jobId: 'job-A' });
  const p2 = mmx.runMmx({ args: ['music', '--prompt', 'y'], apiKey: 'sk-test', jobId: 'job-B' });
  // spawn() runs synchronously inside runMmx (before the ENOENT 'error'
  // event has a chance to fire), so both procs must be tracked
  // immediately — Promise constructors execute their body synchronously.
  assert.equal(mmx.getActiveProcs().length, 2, 'both jobs must be tracked immediately after runMmx() is called');

  const killedA = mmx.cancelByJobId('job-A');
  assert.equal(killedA, true, 'cancelByJobId must report success for a tracked jobId');

  // job-B must be unaffected by cancelling job-A.
  const stillActive = mmx.getActiveProcs();
  assert.equal(stillActive.length, 2, 'killing one proc does not remove it from the Set until the close/error event fires');

  const [r1, r2] = await Promise.all([p1, p2]);
  // Both eventually resolve (ENOENT for the bogus command, or killed) —
  // either way runMmx must resolve, not hang.
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  // After both procs have closed, tracking must be fully cleaned up.
  assert.equal(mmx.getActiveProcs().length, 0);
});

test('cancelByJobId returns false for an unknown or already-finished jobId (no-op, not an error)', async (t) => {
  const mmx = freshMmx(t);
  assert.equal(mmx.cancelByJobId('never-existed'), false);
  assert.equal(mmx.cancelByJobId(), false);
  assert.equal(mmx.cancelByJobId(null), false);

  const r = await mmx.runMmx({ args: ['image'], apiKey: 'sk-test', jobId: 'job-done' });
  void r;
  // The proc has closed (resolved) and untracked itself by now.
  assert.equal(mmx.cancelByJobId('job-done'), false, 'a finished job must no longer be cancellable');
});

test('cancelByJobId does NOT affect a job that was started without a jobId (legacy mmxRun)', async (t) => {
  const mmx = freshMmx(t);
  const legacy = mmx.runMmx({ args: ['image'], apiKey: 'sk-test' }); // no jobId
  assert.equal(mmx.getActiveProcs().length, 1, 'the legacy call is still tracked in the panic-button Set');
  // It was never given a jobId, so nothing can target it by jobId.
  assert.equal(mmx.cancelByJobId('job-that-does-not-exist'), false);
  await legacy;
});

test('runMmx without a jobId never populates the jobId-keyed map (cancelByJobId stays a no-op for it)', async (t) => {
  const mmx = freshMmx(t);
  const r = await mmx.runMmx({ args: ['image'], apiKey: 'sk-test' });
  void r;
  // cancelAll (the panic button) must still work regardless of jobId.
  const p = mmx.runMmx({ args: ['image'], apiKey: 'sk-test' });
  assert.equal(mmx.getActiveProcs().length, 1);
  mmx.cancelAll();
  await p;
  assert.equal(mmx.getActiveProcs().length, 0);
});

test('cancelAll() also clears the jobId-keyed map (procsByJobId)', async (t) => {
  const mmx = freshMmx(t);
  const p = mmx.runMmx({ args: ['image'], apiKey: 'sk-test', jobId: 'job-Z' });
  assert.equal(mmx.getActiveProcs().length, 1);
  mmx.cancelAll();
  // cancelByJobId on a proc that cancelAll() already killed (but whose
  // close/error event hasn't fired yet) should still be a safe no-op —
  // cancelOne() guards on currentGenProcs.has(proc) internally, but the
  // jobId map itself is cleared synchronously by cancelAll().
  assert.equal(mmx.cancelByJobId('job-Z'), false, 'procsByJobId must be cleared by cancelAll(), not just currentGenProcs');
  await p;
});
