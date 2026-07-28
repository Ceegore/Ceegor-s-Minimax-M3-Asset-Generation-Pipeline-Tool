// tests/unit/src/isnetbg/modelRegistry.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MODELS,
  DEFAULT_MODEL,
  isKnownModel,
  getModel,
  resolveModelKey,
} = require('../../../../src/isnetbg/modelRegistry');

test('modelRegistry: entries have required fields', () => {
  for (const key of Object.keys(MODELS)) {
    const entry = MODELS[key];
    assert.equal(typeof entry.file, 'string');
    assert.equal(typeof entry.label, 'string');
    assert.equal(typeof entry.inputSize, 'number');
    assert.ok(Array.isArray(entry.mean));
    assert.ok(Array.isArray(entry.std));
    assert.equal(entry.mean.length, 3);
    assert.equal(entry.std.length, 3);
  }
});

test('resolveModelKey: handles known keys', () => {
  assert.equal(resolveModelKey('isnet-general-use'), 'isnet-general-use');
  assert.equal(resolveModelKey('birefnet-general-lite'), 'birefnet-general-lite');
});

test('resolveModelKey: falls back on garbage input', () => {
  assert.equal(resolveModelKey(null), DEFAULT_MODEL);
  assert.equal(resolveModelKey('../../evil'), DEFAULT_MODEL);
  assert.equal(resolveModelKey(42), DEFAULT_MODEL);
  assert.equal(resolveModelKey(undefined), DEFAULT_MODEL);
  assert.equal(resolveModelKey(''), DEFAULT_MODEL);
});

test('getModel: falls back on unknown model key', () => {
  const fallback = getModel('garbage-key');
  assert.equal(fallback, MODELS[DEFAULT_MODEL]);
});
