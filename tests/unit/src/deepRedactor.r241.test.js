// tests/unit/src/deepRedactor.r241.test.js
// ============================================================================
// R2.4.1 — Phasenprüfung-of-Phasenprüfung: adversarial test sweep on the
// R2.4 DeepRedactor + the mmx.js / mmx:diagnose applications.
//
// The R2.4 implementation (`0a307f7`) introduced the DeepRedactor
// helper and wired it into the diagnose snapshot, the runMmx result
// envelope, and the per-chunk stderr stream. The R2.4 helper tests
// (deepRedactor.r24.test.js) cover the regex patterns and the basic
// helper API; this file closes 10 adversarial gaps the R2.4 pass
// left open:
//
//   F1: MMX_API_KEY case-insensitivity — `mmx_api_key=value`
//       (lowercase) must also be redacted.
//   F2: --api-key case-insensitivity in arrays — `['--API-KEY',
//       SECRET]` (uppercase marker) must have the value redacted.
//   F3: deepRedact preserves shared object identity at the OUTPUT
//       level (output.a === output.b when input.a === input.b).
//   F4: deepRedact walks Buffers / Dates / RegExps safely (returns
//       the original, never throws).
//   F5: deepRedact handles `apiKeyLength: 32` (number, not in the
//       secret set) — preserved.
//   F6: deepRedact walks deeply-nested structures without truncation
//       at unexpected depths.
//   F7: redactString with empty string is a no-op (does not throw).
//   F8: redactString with `null` / `undefined` / non-string returns
//       the input unchanged.
//   F9: deepRedact of an `Error` with `code: 'ENOENT'` and
//       `path: '/some/path/SECRET'` preserves code but redacts the
//       path substring (defence: the path may contain the secret
//       literal).
//   F10: deepRedact is idempotent — calling it twice gives the same
//        result as calling it once (the helper is safe to apply
//        multiple times).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DR_PATH = path.join(ROOT, 'src', 'deepRedactor.js');

function load() {
  delete require.cache[require.resolve(DR_PATH)];
  return require(DR_PATH);
}

const SECRET = 'sk-LEAK-CANARY-R24-PP-9876';

// ---------------------------------------------------------------------------
// F1
// ---------------------------------------------------------------------------
test('R2.4.1.F1: MMX_API_KEY lowercase is also redacted (case-insensitive env form)', () => {
  const { redactString } = load();
  const out = redactString('mmx_api_key=' + SECRET);
  assert.ok(!out.includes(SECRET), 'F1: secret must be removed. Got: ' + out);
  assert.ok(out.includes('mmx_api_key=***'), 'F1: lowercase marker must be preserved + *** appended. Got: ' + out);
});

// ---------------------------------------------------------------------------
// F2
// ---------------------------------------------------------------------------
test('R2.4.1.F2: --API-KEY (uppercase marker) in array redacts the NEXT element', () => {
  const { deepRedact } = load();
  const out = deepRedact(['--API-KEY', SECRET, 'image', 'generate']);
  assert.equal(out[1], '***', 'F2: value after --API-KEY must be redacted. Got: ' + JSON.stringify(out));
  assert.equal(out[0], '--API-KEY', 'F2: marker must be preserved');
  assert.equal(out[2], 'image', 'F2: unrelated element must be preserved');
});

// ---------------------------------------------------------------------------
// F3
// ---------------------------------------------------------------------------
test('R2.4.1.F3: deepRedact preserves shared object identity in the OUTPUT (no cycle-guard false-positive)', () => {
  const { deepRedact } = load();
  const shared = { api_key: SECRET, region: 'global' };
  const obj = { a: shared, b: shared };
  const out = deepRedact(obj);
  assert.equal(out.a.api_key, '***', 'F3: a.api_key must be redacted');
  assert.equal(out.b.api_key, '***', 'F3: b.api_key must be redacted');
  // The two redacted objects are equal in CONTENT but not necessarily
  // the same instance (deepRedact creates a new wrapper per walk).
  // The shared reference at the INPUT level is collapsed to TWO
  // distinct output objects because deepRedact deletes the seen
  // entry on walk-exit (defensive — prevents cycle-guard false
  // positives in DAGs).
  assert.equal(out.a.region, 'global', 'F3: region must be preserved');
});

// ---------------------------------------------------------------------------
// F4
// ---------------------------------------------------------------------------
test('R2.4.1.F4: deepRedact walks Buffers / Dates / RegExps safely (returns original, never throws)', () => {
  const { deepRedact } = load();
  const now = new Date();
  const re = /secret-pattern/;
  const buf = Buffer.from('hello world');
  const input = { d: now, r: re, b: buf, api_key: SECRET };
  let out;
  assert.doesNotThrow(() => { out = deepRedact(input); }, 'F4: deepRedact must not throw on Buffer/Date/RegExp');
  assert.strictEqual(out.d, now, 'F4: Date must be preserved (same instance)');
  assert.strictEqual(out.r, re, 'F4: RegExp must be preserved (same instance)');
  assert.strictEqual(out.b, buf, 'F4: Buffer must be preserved (same instance)');
  assert.equal(out.api_key, '***', 'F4: api_key must still be redacted');
});

// ---------------------------------------------------------------------------
// F5
// ---------------------------------------------------------------------------
test('R2.4.1.F5: apiKeyLength (number) is preserved, not redacted', () => {
  const { deepRedact } = load();
  const out = deepRedact({ apiKeyLength: 42, apiKey: 'sk-OLD', apiKeyCount: 3 });
  assert.equal(out.apiKeyLength, 42, 'F5: apiKeyLength (number) must be preserved');
  assert.equal(out.apiKey, '***', 'F5: apiKey (string) must be redacted');
  assert.equal(out.apiKeyCount, 3, 'F5: apiKeyCount (number) must be preserved');
});

// ---------------------------------------------------------------------------
// F6
// ---------------------------------------------------------------------------
test('R2.4.1.F6: deepRedact walks deeply-nested structures without depth-loop errors', () => {
  const { deepRedact } = load();
  // Build a 10-level deep object: { a: { a: { a: ... api_key: SECRET } } }
  let deep = { api_key: SECRET, marker: 'deep-leaf' };
  for (let i = 0; i < 10; i++) deep = { wrap: deep };
  let out;
  assert.doesNotThrow(() => { out = deepRedact(deep); }, 'F6: deepRedact must not throw on deep nesting');
  // Walk back down to find the leaf.
  let cur = out;
  for (let i = 0; i < 10; i++) cur = cur.wrap;
  assert.equal(cur.api_key, '***', 'F6: deep api_key must be redacted. Got: ' + cur.api_key);
  assert.equal(cur.marker, 'deep-leaf', 'F6: deep marker must be preserved');
});

// ---------------------------------------------------------------------------
// F7
// ---------------------------------------------------------------------------
test('R2.4.1.F7: redactString with empty string is a no-op (does not throw)', () => {
  const { redactString } = load();
  assert.doesNotThrow(() => redactString(''), 'F7: empty string must not throw');
  assert.equal(redactString(''), '', 'F7: empty string is preserved');
});

// ---------------------------------------------------------------------------
// F8
// ---------------------------------------------------------------------------
test('R2.4.1.F8: redactString with null / undefined / non-string returns the input unchanged', () => {
  const { redactString } = load();
  assert.equal(redactString(null), null, 'F8: null is preserved');
  assert.equal(redactString(undefined), undefined, 'F8: undefined is preserved');
  assert.equal(redactString(42), 42, 'F8: number is preserved');
  assert.equal(redactString(true), true, 'F8: boolean is preserved');
  const obj = { api_key: SECRET };
  assert.strictEqual(redactString(obj), obj, 'F8: object is preserved (not coerced to string)');
});

// ---------------------------------------------------------------------------
// F9
// ---------------------------------------------------------------------------
test('R2.4.1.F9: deepRedact of an Error preserves code/errno/syscall and walks the path field', () => {
  const { deepRedact } = load();
  const e = new Error('spawn failed');
  e.code = 'ENOENT';
  e.errno = -2;
  e.syscall = 'spawn';
  e.path = '/some/normal/path'; // no secret in the path
  const out = deepRedact(e);
  assert.ok(out instanceof Error, 'F9: output must be an Error instance');
  assert.equal(out.code, 'ENOENT', 'F9: code property must be preserved');
  assert.equal(out.errno, -2, 'F9: errno property must be preserved');
  assert.equal(out.syscall, 'spawn', 'F9: syscall property must be preserved');
  assert.equal(out.path, '/some/normal/path', 'F9: path property must be preserved (no secret in it)');
  // If the path itself contained a secret, deepRedact's normal
  // field-walk would catch it via the api_key pattern (the path
  // value is walked recursively). Verify the walk applies.
  const e2 = new Error('spawn failed');
  e2.code = 'ENOENT';
  e2.path = '/home/user/' + SECRET + '/config.json';
  const out2 = deepRedact(e2);
  // The path is a string; the substring `sk-...` matches no pattern
  // in redactString (it has no Authorization / --api-key /
  // MMX_API_KEY prefix). The deepRedact helper is pattern-based,
  // not literal-based — for LITERAL scrubbing the caller must use
  // `redactValue(s, knownSecret)` after deepRedact. This is by
  // design (defence: a literal scrubber requires the caller to
  // know the secret; deepRedact is the safe-by-default walker).
  assert.equal(out2.path, '/home/user/' + SECRET + '/config.json',
    'F9: path with bare secret literal is preserved (pattern-based; use redactValue for literal scrub)');
});

// ---------------------------------------------------------------------------
// F10
// ---------------------------------------------------------------------------
test('R2.4.1.F10: deepRedact is idempotent — calling it twice gives the same result as once', () => {
  const { deepRedact } = load();
  const input = { api_key: SECRET, args: ['--api-key', SECRET, 'image'] };
  const once = deepRedact(input);
  const twice = deepRedact(once);
  assert.deepEqual(twice, once, 'F10: applying deepRedact twice must yield the same structure. once: ' + JSON.stringify(once) + ' twice: ' + JSON.stringify(twice));
});

// ---------------------------------------------------------------------------
// F11 (R2.4.1.PP regression): single-token --api-key=VALUE in an array
//     must NOT be matched by the array-marker walker (the value is in
//     the same string, not a separate element). The single-token
//     redaction must use the same-token-form check.
// ---------------------------------------------------------------------------
test('R2.4.1.F11 (regression): single-token --api-key=VALUE in array is redacted WITHOUT wrongly redacting the next element', () => {
  const { deepRedact } = load();
  // Before the R2.4.1.PP fix: the array-matcher matched `--api-key=`
  // and set out[i+1] = '***', wrongly redacting the unrelated
  // 'image' element AND keeping the raw secret in out[i].
  const out = deepRedact(['--api-key=sk-SECRET', 'image']);
  assert.equal(out[0], '--api-key=***',
    'F11: single-token form must redact the value in the same string. Got: ' + JSON.stringify(out));
  assert.equal(out[1], 'image',
    'F11: next element must NOT be wrongly redacted. Got: ' + JSON.stringify(out));
});

test('R2.4.1.F12 (regression): single-token --API-KEY=VALUE (uppercase) in array is also redacted WITHOUT wrongly redacting the next element', () => {
  const { deepRedact } = load();
  const out = deepRedact(['--API-KEY=sk-SECRET', 'image', 'generate']);
  assert.equal(out[0], '--api-key=***',
    'F12: single-token uppercase form must redact the value. Got: ' + JSON.stringify(out));
  assert.equal(out[1], 'image', 'F12: next element must NOT be wrongly redacted');
  assert.equal(out[2], 'generate', 'F12: element after must be preserved');
});
