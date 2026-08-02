// tests/unit/main/models/InstallKindsTable.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getSpec, getDestPath } = require('../../../../main/models/InstallKindsTable');
const assetPaths = require('../../../../src/assetPaths');

test('getSpec: returns the correct specification for valid install kinds', () => {
  const spec = getSpec('isnetbg-model');
  assert.ok(spec);
  assert.equal(spec.destName, 'isnet-general-use.onnx');
  assert.equal(spec.destSubdir, 'models');
});

test('getSpec: returns null for invalid install kinds', () => {
  const spec = getSpec('non-existent');
  assert.equal(spec, null);
});

// H-065: installs go to the writable override dir (<userData>/assets/...),
// never into the read-only bundled bin/ tree.
test('getDestPath: resolves into the writable override dir under userData', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'installkinds-'));
  const prevConfig = { ...assetPaths.getConfig() };
  assetPaths.init({ userDataPath: tmpDir });
  try {
    const dest = getDestPath('isnetbg-model', '/mock/app/root');
    assert.equal(dest, path.join(tmpDir, 'assets', 'models', 'isnet-general-use.onnx'));
  } finally {
    assetPaths.init(prevConfig);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('getDestPath: returns null when no userDataPath is configured', () => {
  const prevConfig = { ...assetPaths.getConfig() };
  assetPaths.init({ userDataPath: '' });
  try {
    assert.equal(getDestPath('isnetbg-model', '/mock/app/root'), null);
  } finally {
    assetPaths.init(prevConfig);
  }
});

test('getDestPath: returns null for invalid install kinds', () => {
  const dest = getDestPath('non-existent', '/mock/app/root');
  assert.equal(dest, null);
});
