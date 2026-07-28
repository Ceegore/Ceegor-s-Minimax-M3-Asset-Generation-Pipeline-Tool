// tests/unit/renderer/utils/FormatUtils.test.js
// Renderer-Utils mit window-Mock.

const test = require('node:test');
const assert = require('node:assert/strict');

// window-Mock VOR dem require.
global.window = global;
require('../../../../renderer/utils/FormatUtils.js');

const { bytesToHuman, secondsToHMS, pad2, isoLocal } = window.FormatUtils;

test('bytesToHuman handles B/KB/MB/GB', () => {
  assert.equal(bytesToHuman(0), '0 B');
  assert.equal(bytesToHuman(512), '512 B');
  assert.equal(bytesToHuman(1024), '1.0 KB');
  assert.equal(bytesToHuman(1024 * 1024), '1.0 MB');
  assert.equal(bytesToHuman(1024 * 1024 * 1024), '1.00 GB');
});

test('bytesToHuman returns em-dash for invalid input', () => {
  assert.equal(bytesToHuman(-1), '—');
  assert.equal(bytesToHuman(NaN), '—');
  assert.equal(bytesToHuman(Infinity), '—');
  assert.equal(bytesToHuman('not a number'), '—');
});

test('secondsToHMS formats MM:SS for sub-hour', () => {
  assert.equal(secondsToHMS(0), '0:00');
  assert.equal(secondsToHMS(5), '0:05');
  assert.equal(secondsToHMS(65), '1:05');
  assert.equal(secondsToHMS(125), '2:05');
});

test('secondsToHMS formats H:MM:SS for ≥ 1 hour', () => {
  assert.equal(secondsToHMS(3600), '1:00:00');
  assert.equal(secondsToHMS(3661), '1:01:01');
  assert.equal(secondsToHMS(7325), '2:02:05');
});

test('pad2 zero-pads single digit', () => {
  assert.equal(pad2(0), '00');
  assert.equal(pad2(5), '05');
  assert.equal(pad2(42), '42');
  assert.equal(pad2(100), '100');
});

test('isoLocal returns 19-char YYYY-MM-DD HH:MM:SS', () => {
  const out = isoLocal(new Date(2025, 0, 5, 3, 4, 5));
  assert.equal(out, '2025-01-05 03:04:05');
});
