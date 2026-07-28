// tests/unit/src/isnetbg/binaryDiscovery.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const {
  findModelPath,
  findBinary,
  pickBackend,
  resetCache,
} = require('../../../../src/isnetbg/binaryDiscovery');

test('findModelPath: resolves the model path correctly in local dev mode', () => {
  const modelPath = findModelPath();
  assert.ok(modelPath, 'Model path should be resolved');
  assert.ok(path.isAbsolute(modelPath), 'Model path should be absolute');
  assert.ok(modelPath.endsWith('isnet-general-use.onnx'), 'Model path should end with the correct filename');
  assert.ok(fs.existsSync(modelPath), 'Resolved model path should actually exist on disk');
});

test('findBinary: returns a string (path) or null', () => {
  resetCache();
  const binaryPath = findBinary();
  if (binaryPath) {
    assert.equal(typeof binaryPath, 'string');
    assert.ok(path.isAbsolute(binaryPath));
    assert.ok(fs.existsSync(binaryPath));
  } else {
    assert.equal(binaryPath, null);
  }
});

test('pickBackend: chooses an available backend', () => {
  resetCache();
  const backend = pickBackend();
  // Since onnxruntime-node is installed in this workspace, pickBackend should resolve to either 'binary' or 'node'.
  assert.ok(['binary', 'node'].includes(backend), 'Backend should be binary or node');
});

test('resetCache: resets the cached backend and path resolution', () => {
  resetCache();
  const backendFirst = pickBackend();
  resetCache();
  const backendSecond = pickBackend();
  assert.equal(backendFirst, backendSecond);
});
