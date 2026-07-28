// tests/unit/src/realesrganJobId.test.js
// R6.6.2: Real-ESRGAN jobId integration — verifies that run() registers
// the spawned process with the shared jobRegistry and unregisters on exit.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// Mock child process that emits controllable events.
function createMockProc() {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.killed = false;
  proc.kill = (sig) => { proc.killed = true; proc._lastSignal = sig; };
  proc._lastSignal = null;
  return proc;
}

// Load realesrgan.js with a mocked child_process.spawn.
function loadWithMockSpawn(mockSpawn) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'child_process') {
      return { spawn: mockSpawn, spawnSync: () => ({ status: 1, stdout: '' }) };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  // Clear cached realesrgan + jobRegistry so they reload with the mock.
  const resrPath = require.resolve(path.join(ROOT, 'src', 'realesrgan.js'));
  const regPath = require.resolve(path.join(ROOT, 'src', 'jobRegistry.js'));
  delete require.cache[resrPath];
  delete require.cache[regPath];
  try {
    const realesrgan = require(resrPath);
    const jobRegistry = require(regPath);
    return { realesrgan, jobRegistry };
  } finally {
    Module._load = realLoad;
  }
}

test('R6.6.2.A: run() with jobId registers proc in jobRegistry', async () => {
  const mockProc = createMockProc();
  const { realesrgan, jobRegistry } = loadWithMockSpawn(() => mockProc);
  jobRegistry._reset();

  const p = realesrgan.run('C:\\fake\\src.png', 'C:\\fake\\dst.png', { jobId: 'test-job-1' });
  // The proc should now be registered.
  const job = jobRegistry.getJob('test-job-1');
  assert.ok(job, 'job should be registered while running');
  assert.equal(job.backend, 'realesrgan');
  assert.equal(job.alive, true);

  // Simulate successful close.
  mockProc.emit('close', 0);
  await p;
  // After close, the job should be unregistered.
  assert.equal(jobRegistry.getJob('test-job-1'), null, 'job should be unregistered after close');
});

test('R6.6.2.B: run() without jobId does NOT register in jobRegistry', async () => {
  const mockProc = createMockProc();
  const { realesrgan, jobRegistry } = loadWithMockSpawn(() => mockProc);
  jobRegistry._reset();

  const p = realesrgan.run('C:\\fake\\src.png', 'C:\\fake\\dst.png', {});
  assert.equal(jobRegistry.getActiveJobs().length, 0, 'no job should be registered');
  mockProc.emit('close', 0);
  await p;
});

test('R6.6.2.C: cancel via jobRegistry kills the realesrgan proc', async () => {
  const mockProc = createMockProc();
  const { realesrgan, jobRegistry } = loadWithMockSpawn(() => mockProc);
  jobRegistry._reset();

  const p = realesrgan.run('C:\\fake\\src.png', 'C:\\fake\\dst.png', { jobId: 'cancel-me' });
  assert.equal(mockProc.killed, false);

  const cancelled = jobRegistry.cancel('cancel-me');
  assert.equal(cancelled, true);
  assert.equal(mockProc.killed, true);
  assert.equal(mockProc._lastSignal, 'SIGTERM');

  // Simulate the proc exiting after being killed.
  mockProc.emit('close', 1);
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(jobRegistry.getJob('cancel-me'), null);
});

test('R6.6.2.D: proc error unregisters the job', async () => {
  const mockProc = createMockProc();
  const { realesrgan, jobRegistry } = loadWithMockSpawn(() => mockProc);
  jobRegistry._reset();

  const p = realesrgan.run('C:\\fake\\src.png', 'C:\\fake\\dst.png', { jobId: 'err-job' });
  assert.ok(jobRegistry.getJob('err-job'), 'registered before error');

  mockProc.emit('error', new Error('ENOENT'));
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(jobRegistry.getJob('err-job'), null, 'unregistered after error');
});

test('R6.6.2.E: cancelAll kills realesrgan proc', async () => {
  const mockProc = createMockProc();
  const { realesrgan, jobRegistry } = loadWithMockSpawn(() => mockProc);
  jobRegistry._reset();

  const p = realesrgan.run('C:\\fake\\src.png', 'C:\\fake\\dst.png', { jobId: 'panic-job' });
  const count = jobRegistry.cancelAll();
  assert.equal(count, 1);
  assert.equal(mockProc.killed, true);

  mockProc.emit('close', 1);
  await p;
  assert.equal(jobRegistry.getActiveJobs().length, 0);
});

test('R6.6.2.F: re-register same jobId kills prior proc', async () => {
  const proc1 = createMockProc();
  const proc2 = createMockProc();
  let callCount = 0;
  const { realesrgan, jobRegistry } = loadWithMockSpawn(() => {
    callCount++;
    return callCount === 1 ? proc1 : proc2;
  });
  jobRegistry._reset();

  const p1 = realesrgan.run('C:\\fake\\a.png', 'C:\\fake\\a_out.png', { jobId: 'same-id' });
  assert.equal(proc1.killed, false);

  // Second run with same jobId should kill the first.
  const p2 = realesrgan.run('C:\\fake\\b.png', 'C:\\fake\\b_out.png', { jobId: 'same-id' });
  assert.equal(proc1.killed, true, 'prior proc should be killed on re-register');

  proc1.emit('close', 1);
  proc2.emit('close', 0);
  await p1;
  await p2;
});

test('R6.6.2.G: progress callback still fires with jobId active', async () => {
  const mockProc = createMockProc();
  const { realesrgan, jobRegistry } = loadWithMockSpawn(() => mockProc);
  jobRegistry._reset();

  const progressValues = [];
  const p = realesrgan.run('C:\\fake\\src.png', 'C:\\fake\\dst.png', {
    jobId: 'prog-job',
    onProgress: (pct) => progressValues.push(pct),
  });

  // Simulate progress on stderr.
  mockProc.stderr.emit('data', Buffer.from('25.0%\n'));
  mockProc.stderr.emit('data', Buffer.from('50,5%\n'));
  mockProc.emit('close', 0);
  await p;

  assert.deepEqual(progressValues, [25, 50.5]);
});
