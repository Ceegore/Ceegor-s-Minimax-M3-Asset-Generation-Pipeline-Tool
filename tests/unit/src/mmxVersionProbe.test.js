// tests/unit/src/mmxVersionProbe.test.js
// H9-003: mmx-cli version probe + semver comparator.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareSemver, SUPPORTED_MMX } = require('../../../src/mmx');

test('H9-003 compareSemver orders versions correctly', () => {
  assert.equal(compareSemver('1.0.16', '1.0.16'), 0);
  assert.equal(compareSemver('1.0.17', '1.0.16'), 1);
  assert.equal(compareSemver('1.0.15', '1.0.16'), -1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0-beta'), 0); // non-numeric suffix ignored
});

test('H9-003 compareSemver handles missing/NaN versions', () => {
  // Missing versions sort below everything.
  assert.equal(compareSemver(null, '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0', null), 1);
  assert.equal(compareSemver(undefined, undefined), 0);
});

test('H9-003 SUPPORTED_MMX declares a minimum + recommended version', () => {
  assert.ok(typeof SUPPORTED_MMX.min === 'string' && /^\d+\.\d+\.\d+$/.test(SUPPORTED_MMX.min));
  assert.ok(typeof SUPPORTED_MMX.recommended === 'string');
});

test('H9-003 probeMmxVersion is exported and cacheable', () => {
  const { probeMmxVersion } = require('../../../src/mmx');
  assert.equal(typeof probeMmxVersion, 'function');
  // Calling it must not throw even when mmx isn't installed (returns null).
  const v = probeMmxVersion();
  assert.ok(v === null || typeof v === 'string');
});
