// tests/unit/renderer/utils/fileUrl.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
require('../../../../renderer/utils/fileUrl.js');
const { fileUrl } = window.FileUrl;

test('fileUrl: empty / null returns empty string', () => {
  assert.equal(fileUrl(''), '');
  assert.equal(fileUrl(null), '');
  assert.equal(fileUrl(undefined), '');
});

test('fileUrl: Windows backslashes are normalized to forward slashes', () => {
  assert.equal(fileUrl('C:\\Users\\me\\file.png'), 'file:///C:/Users/me/file.png');
});

test('fileUrl: produces exactly 3 slashes after "file:"', () => {
  // POSIX path starting with /
  const u = fileUrl('/home/me/file.png');
  assert.equal(u, 'file:///home/me/file.png');
  assert.ok(!u.startsWith('file:////'), 'must not have 4 slashes');
});

test('fileUrl: # is escaped to %23', () => {
  const u = fileUrl('/tmp/render#001.png');
  assert.ok(u.includes('%23'), 'should escape #');
  assert.ok(!u.includes('#'), 'should not contain raw #');
});

test('fileUrl: ? is escaped to %3F', () => {
  const u = fileUrl('/tmp/file?v=2.png');
  assert.ok(u.includes('%3F'), 'should escape ?');
  assert.ok(!u.includes('?'), 'should not contain raw ?');
});

test('fileUrl: spaces are encoded as %20', () => {
  const u = fileUrl('/tmp/my file.png');
  assert.ok(u.includes('%20'), 'should encode space');
});
