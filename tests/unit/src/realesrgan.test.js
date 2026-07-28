// tests/unit/src/realesrgan.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const {
  isAvailable,
  getBinaryPath,
  resetCache,
} = require('../../../src/realesrgan');

test('realesrgan: findBinary resolves binary in workspace', () => {
  resetCache();
  const available = isAvailable();
  const binaryPath = getBinaryPath();
  
  if (available) {
    assert.ok(binaryPath, 'Binary path should be non-null when available');
    assert.ok(path.isAbsolute(binaryPath), 'Binary path should be absolute');
    assert.ok(fs.existsSync(binaryPath), 'Binary path should exist');
  } else {
    assert.equal(binaryPath, null, 'Binary path should be null when unavailable');
  }
});

test('realesrgan: resetCache clears resolution states', () => {
  resetCache();
  const availableFirst = isAvailable();
  resetCache();
  const availableSecond = isAvailable();
  assert.equal(availableFirst, availableSecond);
});
