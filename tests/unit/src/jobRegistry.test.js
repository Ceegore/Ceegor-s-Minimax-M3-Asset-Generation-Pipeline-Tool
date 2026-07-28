// tests/unit/src/jobRegistry.test.js
// R6.6.1: Tests for the shared job registry (src/jobRegistry.js).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// Mock child process.
function mockProc() {
  const proc = new EventEmitter();
  proc.killed = false;
  proc.kill = (sig) => {
    proc.killed = true;
    proc.emit('close', sig === 'SIGKILL' ? 1 : 0);
    return true;
  };
  return proc;
}

// Fresh registry per test.
function loadRegistry() {
  delete require.cache[require.resolve('../../../src/jobRegistry.js')];
  return require('../../../src/jobRegistry.js');
}

test('R6.6.1.A: register returns a monotonically increasing runId', () => {
  const reg = loadRegistry();
  const p1 = mockProc();
  const p2 = mockProc();
  const r1 = reg.register('job1', p1, { backend: 'realesrgan' });
  const r2 = reg.register('job2', p2, { backend: 'isnetbg' });
  assert.equal(typeof r1, 'number');
  assert.equal(typeof r2, 'number');
  assert.ok(r2 > r1, 'runId must be monotonically increasing');
});

test('R6.6.1.B: register with invalid args returns 0', () => {
  const reg = loadRegistry();
  assert.equal(reg.register(null, mockProc()), 0);
  assert.equal(reg.register('job1', null), 0);
  assert.equal(reg.register('', mockProc()), 0);
});

test('R6.6.1.C: unregister removes the job', () => {
  const reg = loadRegistry();
  const p = mockProc();
  reg.register('job1', p, { backend: 'test' });
  assert.equal(reg.getJob('job1') !== null, true);
  assert.equal(reg.unregister('job1'), true);
  assert.equal(reg.getJob('job1'), null);
  // Second unregister returns false.
  assert.equal(reg.unregister('job1'), false);
});

test('R6.6.1.D: cancel kills the process', () => {
  const reg = loadRegistry();
  const p = mockProc();
  reg.register('job1', p, { backend: 'test' });
  assert.equal(p.killed, false);
  const result = reg.cancel('job1');
  assert.equal(result, true);
  assert.equal(p.killed, true);
});

test('R6.6.1.E: cancel returns false for unknown jobId', () => {
  const reg = loadRegistry();
  assert.equal(reg.cancel('nonexistent'), false);
  assert.equal(reg.cancel(null), false);
  assert.equal(reg.cancel(''), false);
});

test('R6.6.1.F: cancel returns true for already-killed process', () => {
  const reg = loadRegistry();
  const p = mockProc();
  reg.register('job1', p, { backend: 'test' });
  p.killed = true; // simulate already killed
  assert.equal(reg.cancel('job1'), true);
});

test('R6.6.1.G: cancelAll kills all jobs and clears the registry', () => {
  const reg = loadRegistry();
  const p1 = mockProc();
  const p2 = mockProc();
  const p3 = mockProc();
  reg.register('job1', p1, { backend: 'a' });
  reg.register('job2', p2, { backend: 'b' });
  reg.register('job3', p3, { backend: 'c' });
  const count = reg.cancelAll();
  assert.equal(count, 3);
  assert.equal(p1.killed, true);
  assert.equal(p2.killed, true);
  assert.equal(p3.killed, true);
  assert.equal(reg.getActiveJobs().length, 0);
});

test('R6.6.1.H: getJob returns job info', () => {
  const reg = loadRegistry();
  const p = mockProc();
  const runId = reg.register('job1', p, { backend: 'realesrgan', srcPath: '/a.png' });
  const info = reg.getJob('job1');
  assert.equal(info.jobId, 'job1');
  assert.equal(info.runId, runId);
  assert.equal(info.backend, 'realesrgan');
  assert.equal(info.meta.srcPath, '/a.png');
  assert.equal(info.alive, true);
  assert.equal(typeof info.startedAt, 'number');
});

test('R6.6.1.I: getJob returns null for unknown jobId', () => {
  const reg = loadRegistry();
  assert.equal(reg.getJob('nonexistent'), null);
});

test('R6.6.1.J: getActiveJobs returns all registered jobs', () => {
  const reg = loadRegistry();
  reg.register('job1', mockProc(), { backend: 'a' });
  reg.register('job2', mockProc(), { backend: 'b' });
  const jobs = reg.getActiveJobs();
  assert.equal(jobs.length, 2);
  const ids = jobs.map((j) => j.jobId).sort();
  assert.deepEqual(ids, ['job1', 'job2']);
});

test('R6.6.1.K: isCurrentRun returns true for matching runId', () => {
  const reg = loadRegistry();
  const runId = reg.register('job1', mockProc(), { backend: 'test' });
  assert.equal(reg.isCurrentRun('job1', runId), true);
  assert.equal(reg.isCurrentRun('job1', runId + 1), false);
  assert.equal(reg.isCurrentRun('job1', 0), false);
});

test('R6.6.1.L: isCurrentRun returns false for unknown jobId', () => {
  const reg = loadRegistry();
  assert.equal(reg.isCurrentRun('nonexistent', 1), false);
});

test('R6.6.1.M: getRunId returns the current runId', () => {
  const reg = loadRegistry();
  const runId = reg.register('job1', mockProc(), { backend: 'test' });
  assert.equal(reg.getRunId('job1'), runId);
  assert.equal(reg.getRunId('nonexistent'), 0);
});

test('R6.6.1.N: re-registering the same jobId kills the prior process', () => {
  const reg = loadRegistry();
  const p1 = mockProc();
  const p2 = mockProc();
  reg.register('job1', p1, { backend: 'first' });
  assert.equal(p1.killed, false);
  // Re-register with the same jobId.
  const runId2 = reg.register('job1', p2, { backend: 'second' });
  // Prior process should be killed.
  assert.equal(p1.killed, true);
  // New process is registered.
  const info = reg.getJob('job1');
  assert.equal(info.backend, 'second');
  assert.equal(info.runId, runId2);
});

test('R6.6.1.O: _reset clears the registry (for testing)', () => {
  const reg = loadRegistry();
  reg.register('job1', mockProc(), { backend: 'test' });
  assert.equal(reg.getActiveJobs().length, 1);
  reg._reset();
  assert.equal(reg.getActiveJobs().length, 0);
});

test('R6.6.1.P: cancelAll on empty registry returns 0', () => {
  const reg = loadRegistry();
  assert.equal(reg.cancelAll(), 0);
});

test('R6.6.1.Q: cancelAll does not count already-killed processes', () => {
  const reg = loadRegistry();
  const p1 = mockProc();
  const p2 = mockProc();
  reg.register('job1', p1, { backend: 'a' });
  reg.register('job2', p2, { backend: 'b' });
  p1.killed = true; // simulate already killed
  const count = reg.cancelAll();
  assert.equal(count, 1); // only p2 counted
});

test('R6.6.1.R: proc-aware unregister ignores stale close events (race fix)', () => {
  const reg = loadRegistry();
  const procA = mockProc();
  const procB = mockProc();
  // Register procA, then replace with procB (simulates rapid re-run).
  reg.register('job1', procA, { backend: 'test' });
  reg.register('job1', procB, { backend: 'test' });
  // procA's stale close event fires — should NOT delete procB's entry.
  const deleted = reg.unregister('job1', procA);
  assert.equal(deleted, false, 'stale proc should not delete the new entry');
  assert.ok(reg.getJob('job1'), 'procB entry must survive');
  assert.equal(reg.getJob('job1').alive, true);
  // procB's real close event — should delete.
  const deleted2 = reg.unregister('job1', procB);
  assert.equal(deleted2, true);
  assert.equal(reg.getJob('job1'), null);
});

test('R6.6.1.S: unregister without proc still deletes unconditionally', () => {
  const reg = loadRegistry();
  const p = mockProc();
  reg.register('job1', p, { backend: 'test' });
  const deleted = reg.unregister('job1'); // no proc arg
  assert.equal(deleted, true);
  assert.equal(reg.getJob('job1'), null);
});
