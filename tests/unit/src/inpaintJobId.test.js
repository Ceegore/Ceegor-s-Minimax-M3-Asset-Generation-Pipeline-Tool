// tests/unit/src/inpaintJobId.test.js
// R6.6.4: Inpaint (LaMa/MI-GAN) jobId integration — verifies that runOnnx()
// registers the spawned process with the shared jobRegistry and unregisters
// on exit/error/timeout.
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

// Load src/inpaint/index.js with mocked child_process.spawn + assetPaths.
function loadWithMocks(mockSpawn) {
  const realLoad = Module._load;
  const assetPathsMock = {
    resolveAsset: (sub, file) => path.join('C:\\fake\\bin', sub || '', file || ''),
    getConfig: () => ({ appRoot: 'C:\\fake', resourcesPath: 'C:\\fake\\res', userDataPath: 'C:\\fake\\ud' }),
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'child_process') {
      return { spawn: mockSpawn, spawnSync: () => ({ status: 1, stdout: '' }) };
    }
    if (request === 'fs') {
      const realFs = realLoad.call(this, request, parent, isMain);
      return Object.assign({}, realFs, { existsSync: () => true });
    }
    if (request === '../assetPaths' || request.endsWith('assetPaths')) {
      return assetPathsMock;
    }
    return realLoad.call(this, request, parent, isMain);
  };
  const inpaintPath = require.resolve(path.join(ROOT, 'src', 'inpaint', 'index.js'));
  const regPath = require.resolve(path.join(ROOT, 'src', 'jobRegistry.js'));
  delete require.cache[inpaintPath];
  delete require.cache[regPath];
  try {
    const inpaint = require(inpaintPath);
    const jobRegistry = require(regPath);
    return { inpaint, jobRegistry };
  } finally {
    Module._load = realLoad;
  }
}

test('R6.6.4.A: runOnnx with jobId registers proc in jobRegistry', async () => {
  const mockProc = createMockProc();
  const { inpaint, jobRegistry } = loadWithMocks(() => mockProc);
  jobRegistry._reset();

  const p = inpaint.runOnnx('C:\\fake\\src.png', 'C:\\fake\\mask.png', 'C:\\fake\\dst.png', { jobId: 'inpaint-job-1' });
  const job = jobRegistry.getJob('inpaint-job-1');
  assert.ok(job, 'job should be registered while running');
  assert.equal(job.backend, 'inpaint-onnx');

  mockProc.emit('close', 0);
  await p;
  assert.equal(jobRegistry.getJob('inpaint-job-1'), null, 'unregistered after close');
});

test('R6.6.4.B: runOnnx without jobId does NOT register', async () => {
  const mockProc = createMockProc();
  const { inpaint, jobRegistry } = loadWithMocks(() => mockProc);
  jobRegistry._reset();

  const p = inpaint.runOnnx('C:\\fake\\src.png', 'C:\\fake\\mask.png', 'C:\\fake\\dst.png', {});
  assert.equal(jobRegistry.getActiveJobs().length, 0);
  mockProc.emit('close', 0);
  await p;
});

test('R6.6.4.C: cancel via jobRegistry kills the inpaint proc', async () => {
  const mockProc = createMockProc();
  const { inpaint, jobRegistry } = loadWithMocks(() => mockProc);
  jobRegistry._reset();

  const p = inpaint.runOnnx('C:\\fake\\src.png', 'C:\\fake\\mask.png', 'C:\\fake\\dst.png', { jobId: 'cancel-inpaint' });
  assert.equal(mockProc.killed, false);

  const cancelled = jobRegistry.cancel('cancel-inpaint');
  assert.equal(cancelled, true);
  assert.equal(mockProc.killed, true);

  mockProc.emit('close', 1);
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(jobRegistry.getJob('cancel-inpaint'), null);
});

test('R6.6.4.D: proc error unregisters the job', async () => {
  const mockProc = createMockProc();
  const { inpaint, jobRegistry } = loadWithMocks(() => mockProc);
  jobRegistry._reset();

  const p = inpaint.runOnnx('C:\\fake\\src.png', 'C:\\fake\\mask.png', 'C:\\fake\\dst.png', { jobId: 'err-inpaint' });
  assert.ok(jobRegistry.getJob('err-inpaint'));

  mockProc.emit('error', new Error('ENOENT'));
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(jobRegistry.getJob('err-inpaint'), null);
});

test('R6.6.4.E: cancelAll kills inpaint proc', async () => {
  const mockProc = createMockProc();
  const { inpaint, jobRegistry } = loadWithMocks(() => mockProc);
  jobRegistry._reset();

  const p = inpaint.runOnnx('C:\\fake\\src.png', 'C:\\fake\\mask.png', 'C:\\fake\\dst.png', { jobId: 'panic-inpaint' });
  const count = jobRegistry.cancelAll();
  assert.equal(count, 1);
  assert.equal(mockProc.killed, true);

  mockProc.emit('close', 1);
  await p;
  assert.equal(jobRegistry.getActiveJobs().length, 0);
});

test('R6.6.4.F: re-register same jobId kills prior inpaint proc', async () => {
  const procA = createMockProc();
  const procB = createMockProc();
  let callCount = 0;
  const { inpaint, jobRegistry } = loadWithMocks(() => {
    callCount++;
    return callCount === 1 ? procA : procB;
  });
  jobRegistry._reset();

  const pA = inpaint.runOnnx('C:\\fake\\src.png', 'C:\\fake\\mask.png', 'C:\\fake\\dst.png', { jobId: 'rerun-inpaint' });
  assert.equal(procA.killed, false);

  // Second run with same jobId kills procA.
  const pB = inpaint.runOnnx('C:\\fake\\src.png', 'C:\\fake\\mask.png', 'C:\\fake\\dst.png', { jobId: 'rerun-inpaint' });
  assert.equal(procA.killed, true, 'prior proc should be killed on re-register');

  // procA stale close — should NOT delete procB's entry.
  procA.emit('close', 1);
  await pA;
  assert.ok(jobRegistry.getJob('rerun-inpaint'), 'procB entry must survive stale close');

  procB.emit('close', 0);
  await pB;
  assert.equal(jobRegistry.getJob('rerun-inpaint'), null);
});

test('R6.6.4.G: model auto selects lama-big for large areaShare (R664-1 fix)', async () => {
  let spawnedArgs = null;
  const mockProc = createMockProc();
  const { inpaint, jobRegistry } = loadWithMocks((exe, args) => {
    spawnedArgs = args;
    return mockProc;
  });
  jobRegistry._reset();

  // areaShare > 0.15 should select 'lama-big' when model is 'auto'.
  const p = inpaint.runOnnx('C:\\fake\\src.png', 'C:\\fake\\mask.png', 'C:\\fake\\dst.png', { model: 'auto', areaShare: 0.25 });
  assert.ok(spawnedArgs, 'spawn should have been called');
  const modelIdx = spawnedArgs.indexOf('--model');
  assert.ok(modelIdx >= 0, '--model flag must be present');
  assert.equal(spawnedArgs[modelIdx + 1], 'lama-big', 'auto + large area must select lama-big');
  mockProc.emit('close', 0);
  await p;
});

test('R6.6.4.H: model auto selects migan for small areaShare', async () => {
  let spawnedArgs = null;
  const mockProc = createMockProc();
  const { inpaint, jobRegistry } = loadWithMocks((exe, args) => {
    spawnedArgs = args;
    return mockProc;
  });
  jobRegistry._reset();

  const p = inpaint.runOnnx('C:\\fake\\src.png', 'C:\\fake\\mask.png', 'C:\\fake\\dst.png', { model: 'auto', areaShare: 0.05 });
  const modelIdx = spawnedArgs.indexOf('--model');
  assert.equal(spawnedArgs[modelIdx + 1], 'migan', 'auto + small area must select migan');
  mockProc.emit('close', 0);
  await p;
});
