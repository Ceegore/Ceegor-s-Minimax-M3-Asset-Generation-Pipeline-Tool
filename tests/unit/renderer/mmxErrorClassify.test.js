// tests/unit/renderer/mmxErrorClassify.test.js
// ============================================================================
// Bug-fix (reported by user, this round): a --subject-ref reference image
// that doesn't exist on disk made the image tab spawn mmx (which failed with
// a cryptic "File system error: ENOENT … reference.jpeg") and then RETRY it
// 3 more times with exponential backoff — turning one clear, permanent
// failure into a confusing, slow, 4×-repeated one.
//
// The fix adds an 'input' classification for file-not-found / bad-input
// errors and an isRetryableMmxError() helper the retry loops consult so
// permanent failures (auth / quota / input) are surfaced immediately and
// never retried. These tests load the ACTUAL production functions out of
// renderer/app.js (via vm, brace-matched extraction — same pattern as
// realCodeHarness.test.js) so a regression in the real source fails here.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
// Lexer-aware extractor (handles the unbalanced `{` inside classifyMmxError's
// regex character classes — see tests/unit/_fnExtract.js).
const { extractFnSrc } = require(path.join(ROOT, 'tests', 'unit', '_fnExtract'));

function load() {
  const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const classifySrc = extractFnSrc(appSrc, 'function classifyMmxError(r, msg) {');
  const retrySrc = extractFnSrc(appSrc, 'function isRetryableMmxError(r, msg) {');
  const context = vm.createContext({});
  vm.runInContext(`${classifySrc}\n${retrySrc}\nglobalThis.classifyMmxError = classifyMmxError; globalThis.isRetryableMmxError = isRetryableMmxError;`, context);
  return { classifyMmxError: context.classifyMmxError, isRetryableMmxError: context.isRetryableMmxError };
}

// The exact error the user saw in the field (reference image missing).
const REF_MISSING = {
  code: 1,
  stderr: '',
  stdout: JSON.stringify({ error: { code: 1, message: "File system error: ENOENT: no such file or directory, open 'C:\\\\Users\\\\Example\\\\Downloads\\\\generated-image.jpeg'", hint: 'File or directory not found.' } }),
};

test('classifyMmxError tags a missing reference image (ENOENT) as input, not network', () => {
  const { classifyMmxError } = load();
  assert.equal(classifyMmxError(REF_MISSING, REF_MISSING.stdout), 'input');
});

test('classifyMmxError: file-not-found phrasings all classify as input', () => {
  const { classifyMmxError } = load();
  for (const msg of [
    'ENOENT: no such file or directory',
    'File system error: ENOENT',
    'file or directory not found',
    'no such file or directory, open',
  ]) {
    assert.equal(classifyMmxError({ stderr: msg }, msg), 'input', `expected input for: ${msg}`);
  }
});

test('classifyMmxError: auth / rate / quota / network / server / unknown still classify correctly', () => {
  const { classifyMmxError } = load();
  assert.equal(classifyMmxError({ stderr: 'HTTP 401 unauthorized' }, ''), 'auth');
  assert.equal(classifyMmxError({ stderr: 'rate limit, too many requests (429)' }, ''), 'rate');
  assert.equal(classifyMmxError({ stderr: 'quota exhausted, not in plan' }, ''), 'quota');
  assert.equal(classifyMmxError({ stderr: 'ENOTFOUND dns lookup failed' }, ''), 'network');
  assert.equal(classifyMmxError({ stderr: 'system error (HTTP 200)' }, ''), 'server');
  assert.equal(classifyMmxError({ stderr: 'something weird happened' }, ''), 'unknown');
});

test('isRetryableMmxError: permanent errors (input/auth/quota) are NOT retried', () => {
  const { isRetryableMmxError } = load();
  assert.equal(isRetryableMmxError(REF_MISSING, REF_MISSING.stdout), false, 'a missing reference image must not be retried');
  assert.equal(isRetryableMmxError({ stderr: 'HTTP 401 unauthorized' }, ''), false);
  assert.equal(isRetryableMmxError({ stderr: 'quota exhausted' }, ''), false);
});

test('isRetryableMmxError: transient errors (rate/network/server/unknown) ARE retried', () => {
  const { isRetryableMmxError } = load();
  assert.equal(isRetryableMmxError({ stderr: 'rate limit 429' }, ''), true);
  assert.equal(isRetryableMmxError({ stderr: 'ECONNRESET network' }, ''), true);
  assert.equal(isRetryableMmxError({ stderr: 'system error (HTTP 200)' }, ''), true);
  assert.equal(isRetryableMmxError({ stderr: 'mystery failure' }, ''), true);
});

// ---------------------------------------------------------------------------
// BUG-9-08 (reported 2026-06-25): mmx exits with code -1 AND produces no
// stderr AND no stdout. Main process's proc.on('error') path fires when
// the Node child cannot be spawned OR dies before mmx's own error
// handler runs. mmx normally prints "Error: <msg>" to stderr before
// exiting, so a truly empty stderr with code -1 is the smoking gun for
// "mmx crashed before it could print anything" — typically a rate-limit
// crash on a rapid 2nd request, an OOM kill, or a Node spawn failure.
// New 'silent' classification. Permanent (non-retryable).
// ---------------------------------------------------------------------------
test('classifyMmxError: code -1 + empty stderr/stdout → silent (BUG-9-08)', () => {
  const { classifyMmxError } = load();
  assert.equal(classifyMmxError({ code: -1, stderr: '', stdout: '' }, ''), 'silent');
  assert.equal(classifyMmxError({ code: -1, stderr: '   ', stdout: '\n' }, ''), 'silent');
  // The exact error pattern the user saw on 2026-06-25
  assert.equal(classifyMmxError({ code: -1, stderr: '', stdout: '' }, 'mmx exited with code -1'), 'silent');
});
test('classifyMmxError: non-empty stderr still classifies as before (not silent)', () => {
  const { classifyMmxError } = load();
  // code -1 but with an actual stderr message — this is a regular mmx error
  // whose message happens to come out of a -1 path. Don't override the
  // more specific classification.
  assert.equal(classifyMmxError({ code: -1, stderr: 'rate limit 429', stdout: '' }, ''), 'rate');
});
test('isRetryableMmxError: silent failures are NOT retried (BUG-9-08)', () => {
  const { isRetryableMmxError } = load();
  assert.equal(
    isRetryableMmxError({ code: -1, stderr: '', stdout: '' }, ''),
    false,
    'a silent mmx crash must not be retried — typically a rate-limit/OOM that needs a wait, not an immediate retry'
  );
});
