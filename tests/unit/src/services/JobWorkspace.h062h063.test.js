// tests/unit/src/services/JobWorkspace.h062h063.test.js
// ============================================================================
// H-062: strict ID validation (no sanitizing), ownership manifest, deletion
//        containment — cleanup can never delete the jobs root or foreign dirs.
// H-063: transactional commit — no-clobber pre-flight + rollback on
//        mid-transaction failure (all-or-nothing).
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { JobWorkspace, MANIFEST_NAME } = require('../../../../src/services/JobWorkspace');

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jobws-'));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// H-062: strict ID validation
// ---------------------------------------------------------------------------

test('H-062: invalid jobIds throw instead of being sanitized', () => {
  const base = tmpBase();
  try {
    const bad = ['', ' ', '../x', 'a/b', 'a\\b', 'a:b', 'a b', '.', '..', 'a'.repeat(65), 'jöb', 'a.b'];
    for (const id of bad) {
      assert.throws(() => new JobWorkspace(base, id), /invalid jobId/, `expected throw for ${JSON.stringify(id)}`);
    }
    assert.throws(() => new JobWorkspace(base, null), /invalid jobId/);
    assert.throws(() => new JobWorkspace(base, 42), /invalid jobId/);
    // Valid IDs are accepted verbatim.
    for (const id of ['a', 'A-1_b', 'a'.repeat(64)]) {
      const ws = new JobWorkspace(base, id);
      assert.equal(path.basename(ws.jobDir), id);
    }
  } finally { rmrf(base); }
});

test('H-062: distinct IDs can no longer collide onto the same directory', () => {
  const base = tmpBase();
  try {
    // The old sanitizer mapped 'a/b' and 'a:b' both to 'a_b'. Now both are
    // rejected outright, so no two accepted IDs can share a directory.
    assert.throws(() => new JobWorkspace(base, 'a/b'));
    assert.throws(() => new JobWorkspace(base, 'a:b'));
  } finally { rmrf(base); }
});

test('H-062: invalid runId throws (runDir / createAttempt / rollback)', () => {
  const base = tmpBase();
  try {
    const ws = new JobWorkspace(base, 'job1');
    assert.throws(() => ws.runDir('../evil'), /invalid runId/);
    assert.throws(() => ws.runDir(''), /invalid runId/);
    assert.throws(() => ws.createAttempt('a/b', 1), /invalid runId/);
    assert.throws(() => ws.rollback('..'), /invalid runId/);
  } finally { rmrf(base); }
});

// ---------------------------------------------------------------------------
// H-062: ownership manifest + containment
// ---------------------------------------------------------------------------

test('H-062: ensureJobDir writes an ownership manifest; createAttempt establishes it', () => {
  const base = tmpBase();
  try {
    const ws = new JobWorkspace(base, 'job2');
    ws.createAttempt('r1', 1);
    const manifest = JSON.parse(fs.readFileSync(path.join(ws.jobDir, MANIFEST_NAME), 'utf8'));
    assert.equal(manifest.jobId, 'job2');
  } finally { rmrf(base); }
});

test('H-062: ensureJobDir throws when the directory is owned by another job', () => {
  const base = tmpBase();
  try {
    const dir = path.join(base, 'jobs', 'job3');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify({ jobId: 'someone-else' }));
    const ws = new JobWorkspace(base, 'job3');
    assert.throws(() => ws.ensureJobDir(), /owned by a different job/);
  } finally { rmrf(base); }
});

test('H-062: cleanup refuses foreign-owned and manifest-less directories', () => {
  const base = tmpBase();
  try {
    // Foreign manifest → refuse.
    const foreignDir = path.join(base, 'jobs', 'job4');
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, MANIFEST_NAME), JSON.stringify({ jobId: 'other' }));
    fs.writeFileSync(path.join(foreignDir, 'data.bin'), 'x');
    new JobWorkspace(base, 'job4').cleanup();
    assert.ok(fs.existsSync(path.join(foreignDir, 'data.bin')), 'foreign dir must survive cleanup');

    // No manifest at all (dir not created by ensureJobDir) → refuse.
    const strayDir = path.join(base, 'jobs', 'job5');
    fs.mkdirSync(strayDir, { recursive: true });
    fs.writeFileSync(path.join(strayDir, 'keep.txt'), 'x');
    new JobWorkspace(base, 'job5').cleanup();
    assert.ok(fs.existsSync(path.join(strayDir, 'keep.txt')), 'manifest-less dir must survive cleanup');

    // Own manifest → deleted.
    const ws = new JobWorkspace(base, 'job6');
    ws.createAttempt('r1', 1);
    assert.ok(fs.existsSync(ws.jobDir));
    ws.cleanup();
    assert.ok(!fs.existsSync(ws.jobDir), 'owned dir is removed');
    assert.ok(fs.existsSync(path.join(base, 'jobs')), 'jobs root always survives');
  } finally { rmrf(base); }
});

// ---------------------------------------------------------------------------
// H-063: transactional commit
// ---------------------------------------------------------------------------

test('H-063: happy-path commit promotes all attempt files', () => {
  const base = tmpBase();
  try {
    const ws = new JobWorkspace(base, 'job7');
    const dir = ws.createAttempt('r1', 1);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'aaa');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'bbb');
    const res = ws.commit('r1', 1, { expectedCount: 2 });
    assert.equal(res.ok, true);
    assert.equal(res.files.length, 2);
    for (const f of res.files) assert.ok(fs.existsSync(f));
    assert.ok(res.files.every((f) => f.startsWith(ws.committedDir('r1'))));
  } finally { rmrf(base); }
});

test('H-063: commit refuses to clobber an existing committed file (pre-flight)', () => {
  const base = tmpBase();
  try {
    const ws = new JobWorkspace(base, 'job8');
    const dir = ws.createAttempt('r1', 1);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'new-a');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new-b');
    // Simulate an earlier commit having produced b.txt already.
    fs.mkdirSync(ws.committedDir('r1'), { recursive: true });
    fs.writeFileSync(path.join(ws.committedDir('r1'), 'b.txt'), 'precious');

    const res = ws.commit('r1', 1);
    assert.equal(res.ok, false);
    assert.match(res.error, /already exists/);
    // NOTHING was moved — not even a.txt (all-or-nothing).
    assert.ok(fs.existsSync(path.join(dir, 'a.txt')), 'a.txt stays in the attempt dir');
    assert.equal(fs.readFileSync(path.join(ws.committedDir('r1'), 'b.txt'), 'utf8'), 'precious');
    assert.ok(!fs.existsSync(path.join(ws.committedDir('r1'), 'a.txt')));
  } finally { rmrf(base); }
});

test('H-063: mid-transaction rename failure rolls back already-moved files', () => {
  const base = tmpBase();
  try {
    const ws = new JobWorkspace(base, 'job9');
    const dir = ws.createAttempt('r1', 1);
    // readdirSync returns sorted names: a.txt, b.txt, c.txt
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'B');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'C');

    // Inject a failure when the SECOND file is promoted INTO the commit dir.
    // (Rollback renames go the other direction and must not be affected.)
    const commitDir = ws.committedDir('r1');
    const realRename = fs.renameSync;
    fs.renameSync = function (src, dst) {
      if (path.dirname(dst) === commitDir && path.basename(dst) === 'b.txt') {
        const err = new Error('EIO: injected failure');
        err.code = 'EIO';
        throw err;
      }
      return realRename.call(fs, src, dst);
    };
    let res;
    try {
      res = ws.commit('r1', 1);
    } finally {
      fs.renameSync = realRename;
    }

    assert.equal(res.ok, false);
    assert.match(res.error, /rolled back/);
    // All three files are back in (or still in) the attempt dir.
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
      assert.ok(fs.existsSync(path.join(dir, f)), `${f} restored to attempt dir`);
    }
    // Nothing left behind in the commit dir.
    assert.deepEqual(fs.readdirSync(commitDir), []);
  } finally { rmrf(base); }
});

test('H-063: non-integer attempt number is rejected', () => {
  const base = tmpBase();
  try {
    const ws = new JobWorkspace(base, 'job10');
    ws.createAttempt('r1', 1);
    for (const bad of [0, -1, 1.5, NaN, '1', null, undefined]) {
      const res = ws.commit('r1', bad);
      assert.equal(res.ok, false, `attemptNum ${String(bad)} must be rejected`);
      assert.match(res.error, /Invalid attempt number/);
    }
  } finally { rmrf(base); }
});

test('H-062: rollback only removes the run directory, nothing else', () => {
  const base = tmpBase();
  try {
    const ws = new JobWorkspace(base, 'job11');
    const d1 = ws.createAttempt('r1', 1);
    const d2 = ws.createAttempt('r2', 1);
    fs.writeFileSync(path.join(d1, 'x'), '1');
    fs.writeFileSync(path.join(d2, 'y'), '2');
    ws.rollback('r1');
    assert.ok(!fs.existsSync(ws.runDir('r1')));
    assert.ok(fs.existsSync(path.join(d2, 'y')), 'other runs untouched');
    assert.ok(fs.existsSync(path.join(ws.jobDir, MANIFEST_NAME)), 'job dir itself untouched');
  } finally { rmrf(base); }
});
