// tests/unit/main/models/InstallKindsTable.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { getSpec, getDestPath } = require('../../../../main/models/InstallKindsTable');

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

test('getDestPath: resolves output directory under appRoot/bin', () => {
  const appRoot = '/mock/app/root';
  const dest = getDestPath('isnetbg-model', appRoot);
  assert.equal(dest, path.normalize('/mock/app/root/bin/models/isnet-general-use.onnx'));
});

test('getDestPath: returns null for invalid install kinds', () => {
  const dest = getDestPath('non-existent', '/mock/app/root');
  assert.equal(dest, null);
});
