// tests/unit/src/isnetbg/binaryDiscovery.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assetPaths = require('../../../../src/assetPaths');

const {
  findModelPath,
  findBinary,
  pickBackend,
  resetCache,
} = require('../../../../src/isnetbg/binaryDiscovery');

test('findModelPath: resolves a bundled model without requiring release assets in the source checkout', () => {
  const originalConfig = assetPaths.getConfig();
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-model-path-'));
  const modelDir = path.join(appRoot, 'bin', 'models');
  const expectedPath = path.join(modelDir, 'isnet-general-use.onnx');

  try {
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(expectedPath, 'test fixture');
    assetPaths.init({ appRoot, resourcesPath: '', userDataPath: '' });

    const modelPath = findModelPath();
    assert.equal(modelPath, expectedPath);
    assert.ok(path.isAbsolute(modelPath), 'Model path should be absolute');
    assert.ok(fs.existsSync(modelPath), 'Resolved model path should actually exist on disk');
  } finally {
    assetPaths.init(originalConfig);
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
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
