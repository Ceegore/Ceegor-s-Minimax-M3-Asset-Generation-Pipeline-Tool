// tests/unit/src/deepRedactor.r24.test.js
// ============================================================================
// R2.4 — DeepRedactor helper unit tests.
//
// The helper is a pure function; these tests cover the contract:
//   • `redactString` — replaces known secret patterns (Authorization,
//     --api-key, --api-key=, MMX_API_KEY=, …) in a string.
//   • `deepRedact`   — walks strings, arrays, plain objects, Errors.
//   • `redactValue`  — replaces a known secret literal out of a string.
//
//   A. authorize: Bearer <secret>   → "Authorization: ***"
//   B. --api-key <value>            → "--api-key ***"
//   C. --api-key=<value>            → "--api-key=***"
//   D. --api-key "value" (quoted)   → "--api-key ***"
//   E. MMX_API_KEY=<value>          → "MMX_API_KEY=***"
//   F. api_key FIELD value          → replaced (non-string kept)
//   G. recursive walk of nested
//      object/array structures     → all leaves scrubbed
//   H. Error objects: message + stack redacted, code preserved
//   I. cycle-safe (no infinite recursion on circular refs)
//   J. pure: same input → same output (no mutation of input)
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

const SECRET = 'sk-LEAK-CANARY-DEEPREDACT-XYZ-9876';
const REPL = '***';

// ---------------------------------------------------------------------------
// A
// ---------------------------------------------------------------------------
test('R2.4.A: authorize: Bearer <secret> is redacted (secret removed, "Authorization: " prefix preserved)', () => {
  const { redactString } = load();
  const out = redactString('Authorization: Bearer ' + SECRET);
  assert.ok(!out.includes(SECRET), 'A: secret must be removed. Got: ' + out);
  assert.ok(out.startsWith('Authorization:'), 'A: "Authorization:" prefix must be preserved. Got: ' + out);
  assert.ok(out.includes(REPL), 'A: redaction marker must be present. Got: ' + out);
});

// ---------------------------------------------------------------------------
// B
// ---------------------------------------------------------------------------
test('R2.4.B: --api-key <value> (two-token) → "--api-key ***"', () => {
  const { redactString } = load();
  const out = redactString('mmx image generate --api-key ' + SECRET);
  assert.ok(!out.includes(SECRET), 'B: secret must be removed. Got: ' + out);
  assert.ok(out.includes('--api-key ***'), 'B: must keep "--api-key ***". Got: ' + out);
});

// ---------------------------------------------------------------------------
// C
// ---------------------------------------------------------------------------
test('R2.4.C: --api-key=<value> (single-token = form) → "--api-key=***"', () => {
  const { redactString } = load();
  const out = redactString('mmx image generate --api-key=' + SECRET);
  assert.ok(!out.includes(SECRET), 'C: secret must be removed. Got: ' + out);
  assert.ok(out.includes('--api-key=***'), 'C: must keep "--api-key=***". Got: ' + out);
});

// ---------------------------------------------------------------------------
// D
// ---------------------------------------------------------------------------
test('R2.4.D: --api-key "value" (quoted) → "--api-key ***"', () => {
  const { redactString } = load();
  const out = redactString('mmx image generate --api-key "' + SECRET + '"');
  assert.ok(!out.includes(SECRET), 'D: secret must be removed. Got: ' + out);
  assert.ok(out.includes('--api-key ***'), 'D: must keep "--api-key ***". Got: ' + out);
});

// ---------------------------------------------------------------------------
// E
// ---------------------------------------------------------------------------
test('R2.4.E: MMX_API_KEY=<value> (env form) → "MMX_API_KEY=***"', () => {
  const { redactString } = load();
  const out = redactString('MMX_API_KEY=' + SECRET);
  assert.ok(!out.includes(SECRET), 'E: secret must be removed. Got: ' + out);
  assert.ok(out.includes('MMX_API_KEY=***'), 'E: must keep "MMX_API_KEY=***". Got: ' + out);
});

// ---------------------------------------------------------------------------
// F
// ---------------------------------------------------------------------------
test('R2.4.F: api_key FIELD value is redacted; non-string fields preserved', () => {
  const { deepRedact } = load();
  const input = {
    api_key: SECRET,
    apiKey: SECRET,
    minimax_api_key: SECRET,
    apiKeyLength: 32, // non-string → preserved
    apiKeyCount: 5,   // non-string → preserved
    region: 'global', // unrelated → preserved
  };
  const out = deepRedact(input);
  assert.equal(out.api_key, REPL, 'F: api_key string field must be redacted');
  assert.equal(out.apiKey, REPL, 'F: apiKey string field must be redacted');
  assert.equal(out.minimax_api_key, REPL, 'F: minimax_api_key string field must be redacted');
  assert.equal(out.apiKeyLength, 32, 'F: apiKeyLength (non-string) must be preserved');
  assert.equal(out.apiKeyCount, 5, 'F: apiKeyCount (non-string) must be preserved');
  assert.equal(out.region, 'global', 'F: unrelated fields must be preserved');
});

// ---------------------------------------------------------------------------
// G
// ---------------------------------------------------------------------------
test('R2.4.G: recursive walk of nested object/array structures', () => {
  const { deepRedact } = load();
  const input = {
    args: ['image', 'generate', '--api-key', SECRET],
    nested: {
      header: 'Authorization: Bearer ' + SECRET,
      arr: [{ api_key: SECRET }, { api_key: 'sk-OTHER' }],
    },
    unrelated: 'no secrets here',
  };
  const out = deepRedact(input);
  assert.equal(out.args[3], REPL, 'G: array element with secret must be redacted');
  assert.ok(!out.nested.header.includes(SECRET), 'G: nested header must not contain secret. Got: ' + out.nested.header);
  assert.ok(out.nested.header.startsWith('Authorization:'), 'G: nested header must start with "Authorization:". Got: ' + out.nested.header);
  assert.ok(out.nested.header.includes(REPL), 'G: nested header must include redaction marker. Got: ' + out.nested.header);
  assert.equal(out.nested.arr[0].api_key, REPL, 'G: nested api_key in array must be redacted');
  assert.equal(out.nested.arr[1].api_key, REPL, 'G: nested api_key in array must be redacted');
  assert.equal(out.unrelated, 'no secrets here', 'G: unrelated string must be preserved');
});

// ---------------------------------------------------------------------------
// H
// ---------------------------------------------------------------------------
test('R2.4.H: Error objects — message + stack redacted, code preserved', () => {
  const { deepRedact } = load();
  const e = new Error('spawn failed: --api-key=' + SECRET);
  e.code = 'ENOENT';
  e.stack = 'Error: spawn failed: --api-key=' + SECRET + '\n    at somewhere';
  const out = deepRedact(e);
  assert.ok(out instanceof Error, 'H: output must be an Error instance');
  assert.ok(!out.message.includes(SECRET), 'H: error message must not contain secret. Got: ' + out.message);
  assert.equal(out.code, 'ENOENT', 'H: code property must be preserved');
  assert.ok(!String(out.stack).includes(SECRET), 'H: error stack must not contain secret. Got: ' + out.stack);
});

// ---------------------------------------------------------------------------
// I
// ---------------------------------------------------------------------------
test('R2.4.I: cycle-safe (no infinite recursion on circular refs)', () => {
  const { deepRedact } = load();
  const a = { name: 'a', api_key: SECRET };
  a.self = a; // cycle
  const b = { name: 'b', a };
  const out = deepRedact(b);
  assert.equal(out.name, 'b', 'I: top-level name must be preserved');
  assert.equal(out.a.name, 'a', 'I: nested name must be preserved');
  assert.equal(out.a.api_key, REPL, 'I: nested api_key must be redacted');
  // The cycle itself terminates — the test simply must not hang.
});

// ---------------------------------------------------------------------------
// J
// ---------------------------------------------------------------------------
test('R2.4.J: pure — input is NOT mutated', () => {
  const { deepRedact } = load();
  const input = {
    api_key: SECRET,
    args: ['--api-key', SECRET],
  };
  const snapshot = JSON.stringify(input);
  deepRedact(input);
  assert.equal(JSON.stringify(input), snapshot, 'J: input must not be mutated');
});

// ---------------------------------------------------------------------------
// K: redactValue strips a known secret literal
// ---------------------------------------------------------------------------
test('R2.4.K: redactValue strips a known secret literal out of a string', () => {
  const { redactValue } = load();
  const out = redactValue('prefix ' + SECRET + ' suffix', SECRET);
  assert.ok(!out.includes(SECRET), 'K: secret must be removed. Got: ' + out);
  assert.equal(out, 'prefix *** suffix', 'K: must produce "prefix *** suffix". Got: ' + out);
});

// ---------------------------------------------------------------------------
// L: custom replacement
// ---------------------------------------------------------------------------
test('R2.4.L: custom replacement string is honoured', () => {
  const { redactString, deepRedact } = load();
  const out1 = redactString('Authorization: Bearer ' + SECRET, { replacement: '<HIDDEN>' });
  assert.ok(!out1.includes(SECRET), 'L: secret must be removed. Got: ' + out1);
  assert.ok(out1.includes('<HIDDEN>'), 'L: custom replacement must be present. Got: ' + out1);
  assert.ok(out1.startsWith('Authorization:'), 'L: "Authorization:" prefix must be preserved. Got: ' + out1);
  const out2 = deepRedact({ api_key: SECRET }, { replacement: '<HIDDEN>' });
  assert.equal(out2.api_key, '<HIDDEN>', 'L: deepRedact must honour custom replacement');
});
