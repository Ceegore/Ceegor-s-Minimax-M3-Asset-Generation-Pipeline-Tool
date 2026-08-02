// tests/unit/src/isnetbgJobId.test.js
// R6.6.3: IS-Net/BiRefNet jobId integration — verifies that run() registers
// the spawned process with the shared jobRegistry and unregisters on exit.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function createMockProc() {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.killed = false;
  proc.kill = (sig) => { proc.killed = true; proc._lastSignal = sig; };
  proc._lastSignal = null;
  return proc;
}

// Load isnetbg.js with mocked child_process.spawn and mocked binaryDiscovery.
function loadWithMocks(mockSpawn, backend) {
  const realLoad = Module._load;
  const discoveryMock = {
    findModelPath: () => 'C:\\fake\\models\\isnet-general-use.onnx',
    findBinary: () => (backend === 'binary' ? 'C:\\fake\\isnetbg.exe' : null),
    pickBackend: () => backend,
    resetCache: () => {},
    checkNodeBackendAvailable: () => true,
    listModelStatus: () => [],
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'child_process') {
      return { spawn: mockSpawn, spawnSync: () => ({ status: 1, stdout: '' }) };
    }
    if (request === './isnetbg/binaryDiscovery' || request.endsWith('binaryDiscovery')) {
      return discoveryMock;
    }
    return realLoad.call(this, request, parent, isMain);
  };
  const isnetPath = require.resolve(path.join(ROOT, 'src', 'isnetbg.js'));
  const regPath = require.resolve(path.join(ROOT, 'src', 'services', 'jobRegistryCompat.js'));
  const ctrlPath = require.resolve(path.join(ROOT, 'src', 'services', 'JobController.js'));
  delete require.cache[isnetPath];
  delete require.cache[regPath];
  delete require.cache[ctrlPath];
  try {
    const isnetbg = require(isnetPath);
    const jobRegistry = require(regPath);
    return { isnetbg, jobRegistry };
  } finally {
    Module._load = realLoad;
  }
}

test('R6.6.3.A: runBinary with jobId registers proc in jobRegistry', async () => {
  const mockProc = createMockProc();
  const { isnetbg, jobRegistry } = loadWithMocks(() => mockProc, 'binary');
  jobRegistry._reset();

  const p = isnetbg.run('C:\\fake\\src.png', 'C:\\fake\\dst.png', { jobId: 'isnet-job-1' });
  const job = jobRegistry.getJob('isnet-job-1');
  assert.ok(job, 'job should be registered while running');
  assert.equal(job.backend, 'isnetbg');

  mockProc.emit('close', 0);
  await p;
  assert.equal(jobRegistry.getJob('isnet-job-1'), null, 'unregistered after close');
});

test('R6.6.3.B: runNode with jobId registers proc in jobRegistry', async () => {
  const mockProc = createMockProc();
  const { isnetbg, jobRegistry } = loadWithMocks(() => mockProc, 'node');
  jobRegistry._reset();

  const p = isnetbg.run('C:\\fake\\src.png', 'C:\\fake\\dst.png', { jobId: 'node-job-1' });
  const job = jobRegistry.getJob('node-job-1');
  assert.ok(job, 'job should be registered while running');
  assert.equal(job.backend, 'isnetbg-node');

  mockProc.emit('close', 0);
  await p;
  assert.equal(jobRegistry.getJob('node-job-1'), null, 'unregistered after close');
});

test('R6.6.3.C: cancel via jobRegistry kills the isnetbg proc', async () => {
  const mockProc = createMockProc();
  const { isnetbg, jobRegistry } = loadWithMocks(() => mockProc, 'node');
  jobRegistry._reset();

  const p = isnetbg.run('C:\\fake\\src.png', 'C:\\fake\\dst.png', { jobId: 'cancel-isnet' });
  assert.equal(mockProc.killed, false);

  const cancelled = jobRegistry.cancel('cancel-isnet');
  assert.equal(cancelled, true);
  assert.equal(mockProc.killed, true);

  mockProc.emit('close', 1);
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(jobRegistry.getJob('cancel-isnet'), null);
});

test('R6.6.3.D: proc error unregisters the job', async () => {
  const mockProc = createMockProc();
  const { isnetbg, jobRegistry } = loadWithMocks(() => mockProc, 'node');
  jobRegistry._reset();

  const p = isnetbg.run('C:\\fake\\src.png', 'C:\\fake\\dst.png', { jobId: 'err-isnet' });
  assert.ok(jobRegistry.getJob('err-isnet'));

  mockProc.emit('error', new Error('ENOENT'));
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(jobRegistry.getJob('err-isnet'), null);
});

test('R6.6.3.E: run without jobId does NOT register', async () => {
  const mockProc = createMockProc();
  const { isnetbg, jobRegistry } = loadWithMocks(() => mockProc, 'node');
  jobRegistry._reset();

  const p = isnetbg.run('C:\\fake\\src.png', 'C:\\fake\\dst.png', {});
  assert.equal(jobRegistry.getActiveJobs().length, 0);
  mockProc.emit('close', 0);
  await p;
});

test('R6.6.3.F: cancelAll kills isnetbg proc', async () => {
  const mockProc = createMockProc();
  const { isnetbg, jobRegistry } = loadWithMocks(() => mockProc, 'binary');
  jobRegistry._reset();

  const p = isnetbg.run('C:\\fake\\src.png', 'C:\\fake\\dst.png', { jobId: 'panic-isnet' });
  const count = jobRegistry.cancelAll();
  assert.equal(count, 1);
  assert.equal(mockProc.killed, true);

  mockProc.emit('close', 1);
  await p;
  assert.equal(jobRegistry.getActiveJobs().length, 0);
});
