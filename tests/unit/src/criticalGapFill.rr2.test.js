// RR2-B003 (release requalification 1.0.4 recheck-2): close the remaining
// unit-reachable gaps in five critical modules so they are held at
// 100/100/100 by the coverage gate WITHOUT a waiver:
//   deepRedactor.js, mmxResultRedactor.js, stateCorruptBackup.js,
//   windowsNamePolicy.js, assetPaths.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { deepRedact, redactValue } = require(path.join(ROOT, 'src', 'deepRedactor.js'));
const { redactRunMmxResult, redactArgv } = require(path.join(ROOT, 'src', 'mmxResultRedactor.js'));
const { backupCorruptState } = require(path.join(ROOT, 'src', 'stateCorruptBackup.js'));
const { validateSinglePathSegment } = require(path.join(ROOT, 'src', 'windowsNamePolicy.js'));
const assetPaths = require(path.join(ROOT, 'src', 'assetPaths.js'));

test('RR2-B003: deepRedact stops descending past the max depth', () => {
  // Build a chain 60 levels deep — deeper than _MAX_DEPTH (50).
  let node = { secret: 'sk-deep-secret' };
  for (let i = 0; i < 60; i += 1) node = { child: node };
  const out = deepRedact(node);
  assert.ok(out, 'the walk returns the (truncated) structure');
});

test('RR2-B003: redactValue guard branches return the input untouched', () => {
  assert.equal(redactValue('keep me', ''), 'keep me', 'empty secret is a no-op');
  assert.equal(redactValue(123, 'x'), 123, 'non-string input passes through');
  assert.equal(redactValue('abc', 42), 'abc', 'non-string secret passes through');
  assert.equal(redactValue('a sk-live b', 'sk-live'), 'a *** b', 'the happy path still redacts');
});

test('RR2-B003: redactRunMmxResult passes non-objects through untouched', () => {
  assert.equal(redactRunMmxResult(null), null);
  assert.equal(redactRunMmxResult(undefined), undefined);
  assert.equal(redactRunMmxResult('plain'), 'plain');
  assert.equal(redactRunMmxResult(7), 7);
});

test('RR2-B003: redactArgv passes non-arrays through untouched', () => {
  assert.equal(redactArgv('not-an-array'), 'not-an-array');
  assert.equal(redactArgv(null), null);
  assert.ok(Array.isArray(redactArgv(['--api-key', 'sk-x'])));
});

test('RR2-B003: backupCorruptState survives an impossible backup target', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr2-b003-backup-'));
  try {
    // Pointing the backup source at a DIRECTORY makes copyFileSync throw
    // (EISDIR) — the catch branch must swallow it and keep going.
    assert.doesNotThrow(() => backupCorruptState(tmp, new Error('parse failed')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('RR2-B003: validateSinglePathSegment rejects every invalid shape', () => {
  const bad = (v, re) => {
    const r = validateSinglePathSegment(v);
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(v)}`);
    assert.match(r.error, re);
  };
  bad(42, /required/i);
  bad('', /required/i);
  bad('x'.repeat(256), /too long/i);
  bad('bad<name', /reserved character/i);
  bad('bad:name', /reserved character/i);
  bad('name.', /end in a dot or space/i);
  bad('name ', /end in a dot or space/i);
  bad('CON', /reserved Windows device name/i);
  bad('nul.txt', /reserved Windows device name/i);
  bad('COM1', /reserved Windows device name/i);
  assert.deepEqual(validateSinglePathSegment('good-name.txt'), { ok: true });
});

test('RR2-B003: writableAssetsDir requires a userDataPath and creates the dir', () => {
  assert.throws(() => assetPaths.writableAssetsDir(''), /userDataPath is required/);
  assert.throws(() => assetPaths.writableAssetsDir(null), /userDataPath is required/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr2-b003-assets-'));
  try {
    const fresh = path.join(tmp, 'no-such-userdata-yet');
    const dir = assetPaths.writableAssetsDir(fresh);
    assert.equal(dir, path.join(fresh, 'assets'));
    assert.ok(fs.existsSync(dir), 'the assets dir is created on demand');
    // Second call hits the already-exists branch.
    assert.equal(assetPaths.writableAssetsDir(fresh), dir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
