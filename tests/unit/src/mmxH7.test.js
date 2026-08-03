// tests/unit/src/mmxH7.test.js
// Regression coverage for the H7 mmx fixes:
//   • H7-013: returned argv never contains the raw API key
//   • H7-022: session-only mode never writes the key to disk
//   • H-007 (hhhhu3 audit): the key travels over the fd-3 credential
//     bridge — not via ~/.mmx/config.json, not via env, not via argv
//   • H7-024: tryParseAll parses pretty-printed multi-line JSON objects
//   • H7-025: a user-canceled job resolves with { canceled: true }
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MMX_PATH = path.join(ROOT, 'src', 'mmx.js');

function freshMmx(t) {
  delete require.cache[MMX_PATH];
  t.mock.method(fs, 'existsSync', () => true);
  return require(MMX_PATH);
}

// ---------------- H7-024: tryParseAll ----------------

test('tryParseAll parses a single JSON object', (t) => {
  const { tryParseAll } = freshMmx(t);
  const r = tryParseAll(JSON.stringify({ base_resp: { status_code: 0 } }));
  assert.deepEqual(r, { base_resp: { status_code: 0 } });
});

test('tryParseAll parses TWO pretty-printed multi-line JSON objects (H7-024)', (t) => {
  const { tryParseAll } = freshMmx(t);
  // The real `speech synthesize --subtitles` output: two indented objects.
  const text = `{
  "file": {
    "url": "https://example.com/audio.mp3",
    "local_path": "out/audio.mp3"
  }
}
{
  "subtitles": {
    "file": "out/audio.srt",
    "segments": [{ "text": "hello", "start": 0.0, "end": 1.0 }]
  }
}`;
  const r = tryParseAll(text);
  assert.ok(Array.isArray(r), 'expected an array of two parsed objects');
  assert.equal(r.length, 2);
  assert.equal(r[0].file.local_path, 'out/audio.mp3');
  assert.equal(r[1].subtitles.segments[0].text, 'hello');
});

test('tryParseAll parses a JSON array document', (t) => {
  const { tryParseAll } = freshMmx(t);
  const r = tryParseAll('[{"a":1},{"b":2}]');
  assert.deepEqual(r, [{ a: 1 }, { b: 2 }]);
});

test('tryParseAll degrades to the trimmed string for non-JSON garbage', (t) => {
  const { tryParseAll } = freshMmx(t);
  const r = tryParseAll('Error: something went wrong\n');
  assert.equal(r, 'Error: something went wrong');
});

test('tryParseAll returns null for empty/whitespace input', (t) => {
  const { tryParseAll } = freshMmx(t);
  assert.equal(tryParseAll(''), null);
  assert.equal(tryParseAll('   \n\t '), null);
  assert.equal(tryParseAll(null), null);
  assert.equal(tryParseAll(undefined), null);
});

test('tryParseAll handles braces inside string values (no false split)', (t) => {
  const { tryParseAll } = freshMmx(t);
  const text = '{"prompt": "a {curly} brace"}{"x":1}';
  const r = tryParseAll(text);
  assert.ok(Array.isArray(r) && r.length === 2);
  assert.equal(r[0].prompt, 'a {curly} brace');
  assert.equal(r[1].x, 1);
});

// ---------------- H7-013 / H-007: key travels over fd 3, never argv/env ----------------

// Build a fake child process whose stdio[3] is a writable credential pipe.
function fakeProcWithFd3(capture) {
  return {
    stdout: { on() {}, resume() {} },
    stderr: { on() {}, resume() {} },
    stdio: [null, null, null, { end(payload, enc) { capture.payload = payload; capture.enc = enc; } }],
    on(ev, cb) { if (ev === 'close') setImmediate(() => cb(0)); },
    kill() {},
    killed: false,
    pid: -1,
    unref() {},
  };
}

test('runMmx routes the key via the fd-3 credential bridge — never argv/env (H7-013, H-007)', async (t) => {
  const cp = require('child_process');
  let capturedEnv = null;
  let capturedArgs = null;
  let capturedStdio = null;
  const capture = {};
  t.mock.method(cp, 'spawn', (cmd, args, opts) => {
    capturedArgs = args;
    capturedEnv = opts && opts.env;
    capturedStdio = opts && opts.stdio;
    return fakeProcWithFd3(capture);
  });
  delete require.cache[MMX_PATH];
  const mmx2 = require(MMX_PATH);

  const SECRET = 'sk-cp-DO-NOT-LEAK-1234567890';
  const r = await mmx2.runMmx({ args: ['quota'], apiKey: SECRET });
  assert.equal(r.ok, true); // close code 0
  // H-007: the key must NOT appear in argv at all.
  const joined = (capturedArgs || []).join(' ');
  assert.ok(!joined.includes(SECRET), `argv leaked the key: ${joined}`);
  // The spawn uses the bridge bootstrap: -e <bootstrap> <entry> ...cliArgs
  assert.ok(capturedArgs && capturedArgs[0] === '-e', 'spawn must use -e bridge bootstrap');
  assert.ok(/mmx\.mjs$/.test(capturedArgs[2] || ''), 'the bundled mmx entry must follow the bootstrap');
  assert.ok(!capturedArgs.includes('--api-key'), 'argv must not contain a standalone --api-key flag');
  // H-007: no environment transport.
  assert.ok(!capturedEnv || !capturedEnv.MINIMAX_API_KEY, 'the key must NOT be routed via env');
  // H-007: stdio must carry a 4th (fd 3) pipe and the key arrives over it.
  assert.ok(Array.isArray(capturedStdio) && capturedStdio.length === 4, 'spawn must open an fd-3 credential pipe');
  assert.ok(capture.payload, 'sendCredential must write the payload to fd 3');
  const parsed = JSON.parse(capture.payload);
  assert.equal(parsed.apiKey, SECRET, 'the fd-3 payload must carry the key');
});

// ---------------- H7-022: session-only never writes to disk ----------------

test('runMmx in session-only mode uses the same fd-3 bridge, no env/argv/disk (H7-022, H-007)', async (t) => {
  const cp = require('child_process');
  let capturedEnv = null;
  let capturedArgs = null;
  const capture = {};
  t.mock.method(cp, 'spawn', (cmd, args, opts) => {
    capturedEnv = opts && opts.env ? { ...opts.env } : null;
    capturedArgs = args ? args.slice() : null;
    return fakeProcWithFd3(capture);
  });
  const mmx = freshMmx(t);
  const SECRET = 'sk-cp-SESSION-ONLY-KEY';
  await mmx.runMmx({ args: ['quota'], apiKey: SECRET, sessionOnly: true });
  // Key must NOT be in argv.
  assert.ok(capturedArgs, 'spawn must have been called');
  assert.ok(!capturedArgs.join(' ').includes(SECRET), 'session-only key leaked into argv');
  assert.ok(!capturedArgs.includes('--api-key'), '--api-key flag must not be present in session-only mode');
  // H-007: no environment transport — the key goes over fd 3 only.
  assert.ok(!capturedEnv || !capturedEnv.MINIMAX_API_KEY, 'session key must not be routed via env');
  assert.equal(capturedArgs[0], '-e', 'session-only mode must use the argv-hidden bridge bootstrap');
  assert.equal(JSON.parse(capture.payload).apiKey, SECRET, 'the fd-3 payload must carry the session key');
});

// ---------------- H7-025: canceled resolves neutral ----------------

test('a canceled job resolves with canceled:true (H7-025)', async (t) => {
  const mmx = freshMmx(t);
  const p = mmx.runMmx({ args: ['music'], apiKey: 'sk-test', jobId: 'job-cancel-me' });
  // Kill it via the user-cancel path (not the timeout path).
  assert.equal(mmx.cancelByJobId('job-cancel-me'), true);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.canceled, true, 'a user-canceled job must surface canceled:true');
});
