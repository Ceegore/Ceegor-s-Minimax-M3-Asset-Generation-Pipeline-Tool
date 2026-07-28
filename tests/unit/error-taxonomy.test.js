// ============================================================================
// Phase 3 — Error taxonomy (Tier 0, offline). Superset of the BUG-05 fix.
//
// A corpus of REAL captured mmx / MiniMax API error strings (auth 401/403/
// 1004/2049, rate, quota, network, server, input, silent) asserting that
// classifyMmxError maps each to the right class — and, just as importantly,
// that it produces NO false positives. The highest-value negative case is the
// BUG-05 one: a DNS-level "ENOTFOUND" must classify as `network` (transient,
// retryable) and must NOT be swallowed by the `input` rule that was added to
// catch local "ENOENT" reference-file failures (permanent, non-retryable).
//
// Loads the ACTUAL production functions out of renderer/app.js (vm +
// brace-matched extraction — same pattern as mmxErrorClassify.test.js) so any
// regression in the real classifier fails here.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
// Lexer-aware extractor (handles the unbalanced `{` inside classifyMmxError's
// regex character classes — see _fnExtract.js).
const { extractFnSrc } = require('./_fnExtract');

function load() {
  const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const classifySrc = extractFnSrc(appSrc, 'function classifyMmxError(r, msg) {');
  const retrySrc = extractFnSrc(appSrc, 'function isRetryableMmxError(r, msg) {');
  const context = vm.createContext({});
  vm.runInContext(
    `${classifySrc}\n${retrySrc}\nglobalThis.classifyMmxError = classifyMmxError; globalThis.isRetryableMmxError = isRetryableMmxError;`,
    context
  );
  return { classifyMmxError: context.classifyMmxError, isRetryableMmxError: context.isRetryableMmxError };
}

// The exact error the user hit in the field (missing --subject-ref image),
// carried over from the BUG-05 fix so this corpus is a true superset.
const REF_MISSING = {
  code: 1,
  stderr: '',
  stdout: JSON.stringify({ error: { code: 1, message: "File system error: ENOENT: no such file or directory, open 'C:\\\\Users\\\\Example\\\\Downloads\\\\ref.jpeg'", hint: 'File or directory not found.' } }),
};

// ---------------------------------------------------------------------------
// The corpus. Each row: [description, result-object, msg, expected-class].
// `retryable` is asserted separately from the class (see below).
// ---------------------------------------------------------------------------
const CORPUS = [
  // ---- auth (401 / 403 / base_resp 1004 / 2049 / phrasings) ----
  ['HTTP 401', { stderr: 'HTTP 401 Unauthorized' }, '', 'auth'],
  ['HTTP 403', { stderr: 'HTTP 403 Forbidden' }, '', 'auth'],
  ['base_resp status_code 1004 (invalid api key)', { stdout: '{"base_resp":{"status_code":1004,"status_msg":"invalid api key"}}' }, '', 'auth'],
  ['base_resp status_code 2049', { stdout: '{"base_resp":{"status_code":2049}}' }, '', 'auth'],
  ['"invalid api key" phrasing', { stderr: 'Error: invalid api key' }, '', 'auth'],
  ['"api key is invalid" phrasing', { stderr: 'api key is invalid' }, '', 'auth'],
  ['authentication failed', { stderr: 'authentication failed' }, '', 'auth'],
  ['login failed', { stderr: 'login failed' }, '', 'auth'],
  ['unauthorized', { stderr: 'unauthorized access' }, '', 'auth'],
  ['forbidden (in msg, not stderr)', { stderr: '' }, 'forbidden: access denied', 'auth'],

  // ---- input (permanent, user-fixable — the BUG-05 class) ----
  ['real captured missing reference image (ENOENT)', REF_MISSING, REF_MISSING.stdout, 'input'],
  ['ENOENT phrasing', { stderr: 'ENOENT: no such file or directory' }, '', 'input'],
  ['"File system error" phrasing', { stderr: 'File system error: ENOENT' }, '', 'input'],
  ['"File or directory not found" phrasing', { stderr: 'File or directory not found.' }, '', 'input'],
  ['ENOENT surfaced via msg', { stderr: '' }, "Error: ENOENT: no such file or directory, open 'C:\\ref.jpeg'", 'input'],

  // ---- rate (transient) ----
  ['HTTP 429', { stderr: 'HTTP 429 Too Many Requests' }, '', 'rate'],
  ['rate limit', { stderr: 'rate limit exceeded' }, '', 'rate'],
  ['throttled', { stderr: 'request throttled, slow down' }, '', 'rate'],
  ['too many requests', { stderr: 'too many requests' }, '', 'rate'],

  // ---- quota (permanent) ----
  ['quota exhausted', { stderr: 'quota exhausted' }, '', 'quota'],
  ['not in plan', { stderr: 'this model is not in plan' }, '', 'quota'],
  ['insufficient balance', { stderr: 'insufficient balance' }, '', 'quota'],
  ['quota exceeded', { stderr: 'monthly quota exceeded' }, '', 'quota'],

  // ---- network (transient) ----
  ['ENOTFOUND (DNS) — the key BUG-05 negative', { stderr: 'getaddrinfo ENOTFOUND api.minimaxi.com' }, '', 'network'],
  ['ECONNREFUSED', { stderr: 'connect ECONNREFUSED 127.0.0.1:443' }, '', 'network'],
  ['ECONNRESET', { stderr: 'read ECONNRESET' }, '', 'network'],
  ['ETIMEDOUT', { stderr: 'connect ETIMEDOUT' }, '', 'network'],
  ['network unreachable', { stderr: 'network is unreachable' }, '', 'network'],
  ['dns lookup failed', { stderr: 'dns lookup failed' }, '', 'network'],

  // ---- server (transient) ----
  ['HTTP 500', { stderr: 'HTTP 500 Internal Server Error' }, '', 'server'],
  ['HTTP 502', { stderr: 'HTTP 502 Bad Gateway' }, '', 'server'],
  ['HTTP 503', { stderr: 'HTTP 503 Service Unavailable' }, '', 'server'],
  ['HTTP 504', { stderr: 'HTTP 504 Gateway Timeout' }, '', 'server'],
  ['MiniMax "system error (HTTP 200)" quirk', { stderr: 'system error (HTTP 200)' }, '', 'server'],
  ['server error phrasing', { stderr: 'server error, please retry' }, '', 'server'],

  // ---- silent (code -1, nothing printed — BUG-9-08) ----
  ['code -1 + empty everything', { code: -1, stderr: '', stdout: '' }, '', 'silent'],
  ['code -1 + whitespace-only streams + exit msg', { code: -1, stderr: '   ', stdout: '\n' }, 'mmx exited with code -1', 'silent'],

  // ---- unknown ----
  ['unrecognised message', { code: 1, stderr: 'something weird happened' }, '', 'unknown'],
  ['empty streams but exit code 1 (NOT silent)', { code: 1, stderr: '', stdout: '' }, '', 'unknown'],
];

// Which classes the retry loop is allowed to retry. Permanent classes
// (auth / quota / input / silent) must NEVER be retried.
const RETRYABLE = { auth: false, input: false, quota: false, silent: false, rate: true, network: true, server: true, unknown: true };

test('classifyMmxError maps every real captured error string to the correct class', () => {
  const { classifyMmxError } = load();
  for (const [desc, r, msg, expected] of CORPUS) {
    assert.equal(classifyMmxError(r, msg), expected, `[${desc}] expected ${expected}`);
  }
});

test('isRetryableMmxError agrees with the class→retryable policy for every corpus row', () => {
  const { classifyMmxError, isRetryableMmxError } = load();
  for (const [desc, r, msg, expected] of CORPUS) {
    const cls = classifyMmxError(r, msg);
    assert.equal(
      isRetryableMmxError(r, msg),
      RETRYABLE[cls],
      `[${desc}] class=${cls} should ${RETRYABLE[cls] ? '' : 'NOT '}be retried`
    );
  }
});

// ---------------------------------------------------------------------------
// Explicit false-positive guards (the "no false positives" half of BUG-05).
// ---------------------------------------------------------------------------
test('ENOTFOUND (DNS) is network, NOT swallowed by the input/ENOENT rule', () => {
  const { classifyMmxError, isRetryableMmxError } = load();
  const r = { stderr: 'getaddrinfo ENOTFOUND api.minimaxi.com' };
  const cls = classifyMmxError(r, '');
  assert.notEqual(cls, 'input', 'a DNS failure must never be treated as a permanent input error');
  assert.equal(cls, 'network');
  assert.equal(isRetryableMmxError(r, ''), true, 'a DNS blip is transient and worth retrying');
});

test('a server error that merely mentions "file" is NOT misclassified as input', () => {
  const { classifyMmxError } = load();
  // Contains the word "file" but none of the input rule's specific phrases.
  assert.equal(classifyMmxError({ stderr: 'internal server error while processing file upload' }, ''), 'server');
});

test('the input rule only fires on its specific phrases, not on arbitrary "file" mentions', () => {
  const { classifyMmxError } = load();
  // "profile" contains "file" as a substring — must not trigger input.
  assert.notEqual(classifyMmxError({ stderr: 'could not load user profile' }, ''), 'input');
});

test('every permanent class is non-retryable and every transient class is retryable (policy sweep)', () => {
  const { isRetryableMmxError } = load();
  // Permanent.
  assert.equal(isRetryableMmxError({ stderr: 'HTTP 401 unauthorized' }, ''), false);
  assert.equal(isRetryableMmxError(REF_MISSING, REF_MISSING.stdout), false);
  assert.equal(isRetryableMmxError({ stderr: 'quota exhausted' }, ''), false);
  assert.equal(isRetryableMmxError({ code: -1, stderr: '', stdout: '' }, ''), false);
  // Transient.
  assert.equal(isRetryableMmxError({ stderr: 'rate limit 429' }, ''), true);
  assert.equal(isRetryableMmxError({ stderr: 'ENOTFOUND dns' }, ''), true);
  assert.equal(isRetryableMmxError({ stderr: 'system error (HTTP 200)' }, ''), true);
  assert.equal(isRetryableMmxError({ stderr: 'mystery failure' }, ''), true);
});
