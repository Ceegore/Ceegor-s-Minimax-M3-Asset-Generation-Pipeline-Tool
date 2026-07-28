// tests/unit/main/utils/UrlSanitizer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitize } = require('../../../../main/utils/UrlSanitizer');

test('accepts plain https', () => {
  assert.deepEqual(sanitize('https://example.com/foo'), { ok: true });
});

test('accepts plain http', () => {
  assert.deepEqual(sanitize('http://example.com'), { ok: true });
});

test('rejects non-string', () => {
  assert.equal(sanitize(null).ok, false);
  assert.equal(sanitize(undefined).ok, false);
  assert.equal(sanitize(42).ok, false);
});

test('rejects non-http schemes', () => {
  const r = sanitize('javascript:alert(1)');
  assert.equal(r.ok, false);
  assert.match(r.error, /Only http\(s\) URLs/);
});

test('rejects control characters and newlines', () => {
  assert.equal(sanitize('https://example.com/\n').ok, false);
  assert.equal(sanitize('https://example.com/\r').ok, false);
  assert.equal(sanitize('https://example.com/\x00').ok, false);
});

test('rejects URLs with embedded credentials', () => {
  const r = sanitize('https://user:pass@example.com/');
  assert.equal(r.ok, false);
  assert.match(r.error, /credentials/);
});

test('rejects malformed URLs', () => {
  const r = sanitize('https://[bad::');
  assert.equal(r.ok, false);
  assert.match(r.error, /Malformed URL|control characters|Only http/);
});
