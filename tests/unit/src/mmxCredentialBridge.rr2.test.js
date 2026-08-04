// RR2-B003 (release requalification 1.0.4 recheck-2): de-waive
// mmxCredentialBridge.js. Every guard branch of prepare()/sendCredential()
// is reachable in unit scope, so the file is held at 100/100/100 by the
// coverage gate WITHOUT a waiver.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const bridge = require(path.join(ROOT, 'src', 'mmxCredentialBridge.js'));

test('RR2-B003: prepare() rejects a non-string entry', () => {
  assert.throws(() => bridge.prepare(null, []), TypeError);
  assert.throws(() => bridge.prepare(42, []), TypeError);
  assert.throws(() => bridge.prepare(undefined, []), TypeError);
});

test('RR2-B003: prepare() rejects an empty entry', () => {
  assert.throws(() => bridge.prepare('', []), TypeError);
});

test('RR2-B003: prepare() rejects non-array args', () => {
  assert.throws(() => bridge.prepare('entry.js', 'nope'), TypeError);
  assert.throws(() => bridge.prepare('entry.js', null), TypeError);
});

test('RR2-B003: prepare() builds the fd-3 spawn contract', () => {
  const r = bridge.prepare('entry.js', ['--a', 'b']);
  assert.equal(r.argv[0], '-e');
  assert.equal(r.argv[1], bridge.BOOTSTRAP);
  assert.equal(r.argv[2], 'entry.js');
  assert.deepEqual(r.argv.slice(3), ['--a', 'b']);
  assert.deepEqual(r.stdio, ['ignore', 'pipe', 'pipe', 'pipe']);
});

test('RR2-B003: sendCredential() rejects a missing process or stdio', () => {
  assert.throws(() => bridge.sendCredential(null, 'k'), /credential pipe is unavailable/);
  assert.throws(() => bridge.sendCredential({}, 'k'), /credential pipe is unavailable/);
  assert.throws(() => bridge.sendCredential({ stdio: [] }, 'k'), /credential pipe is unavailable/);
  assert.throws(() => bridge.sendCredential({ stdio: [null, null, null, null] }, 'k'), /credential pipe is unavailable/);
});

test('RR2-B003: sendCredential() rejects a pipe without end()', () => {
  assert.throws(() => bridge.sendCredential({ stdio: [null, null, null, {}] }, 'k'), /credential pipe is unavailable/);
});

test('RR2-B003: sendCredential() writes the JSON payload and closes fd 3', () => {
  let written = null;
  let endedWith = null;
  const pipe = {
    end: (payload, enc) => { written = payload; endedWith = enc; },
  };
  bridge.sendCredential({ stdio: [null, null, null, pipe] }, 'sekret');
  assert.equal(endedWith, 'utf8');
  assert.deepEqual(JSON.parse(written), { apiKey: 'sekret' });
});

test('RR2-B003: BOOTSTRAP never interpolates the key into module text', () => {
  // The bootstrap is static text; the credential only ever travels fd 3.
  assert.ok(!bridge.BOOTSTRAP.includes('sekret'));
  assert.ok(bridge.BOOTSTRAP.includes('readFileSync(3'));
  assert.ok(bridge.BOOTSTRAP.includes("'--api-key'"));
});
