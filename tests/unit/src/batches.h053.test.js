// tests/unit/src/batches.h053.test.js
// ============================================================================
// H-053 regression: a corrupted (or future-schema) batches.json must NEVER be
// silently replaced with empty defaults. read() preserves the unreadable file
// as `batches.json.corrupt-<ts>` and latches a recovery state; write() refuses
// (EBATCHRECOVERY) until the recovery is explicitly acknowledged.
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// The recovery latch is module state, so every test gets a FRESH copy of
// src/batches.js (and src/config.js, which caches nothing relevant but is
// re-required for symmetry) pointed at its own temp config dir.
function withFreshBatches(run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batches-h053-'));
  const prevEnv = process.env.MINIMAX_CONFIG_DIR;
  process.env.MINIMAX_CONFIG_DIR = tmp;
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'batches.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'config.js'))];
  try {
    const batches = require(path.join(ROOT, 'src', 'batches.js'));
    return run({ batches, tmp, file: path.join(tmp, 'batches.json') });
  } finally {
    if (prevEnv == null) delete process.env.MINIMAX_CONFIG_DIR;
    else process.env.MINIMAX_CONFIG_DIR = prevEnv;
    delete require.cache[require.resolve(path.join(ROOT, 'src', 'batches.js'))];
    delete require.cache[require.resolve(path.join(ROOT, 'src', 'config.js'))];
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

function listBackups(tmp) {
  return fs.readdirSync(tmp).filter((n) => n.startsWith('batches.json.corrupt-'));
}

test('H-053: healthy round-trip has no recovery latch', () => {
  withFreshBatches(({ batches }) => {
    batches.write({ image: ['a prompt'], speech: [], music: [], video: [] });
    const got = batches.read();
    assert.deepEqual(got.image, ['a prompt']);
    assert.equal(batches.pendingRecovery(), null);
  });
});

test('H-053: corrupt JSON is backed up, read returns defaults, recovery latched', () => {
  withFreshBatches(({ batches, tmp, file }) => {
    const corrupt = '{ "schemaVersion": 1, "queues": { "image": ["preciou'; // truncated mid-write
    fs.writeFileSync(file, corrupt, 'utf8');

    const got = batches.read();
    assert.deepEqual(got, { image: [], speech: [], music: [], video: [] });

    const rec = batches.pendingRecovery();
    assert.ok(rec, 'recovery must be latched');
    assert.equal(rec.reason, 'parse-failed');
    assert.ok(rec.backupPath, 'backup path recorded');
    assert.equal(fs.existsSync(rec.backupPath), true);
    assert.equal(fs.readFileSync(rec.backupPath, 'utf8'), corrupt, 'backup preserves original bytes');
    // The original file is untouched too.
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
    assert.equal(listBackups(tmp).length, 1);
  });
});

test('H-053: write() throws EBATCHRECOVERY while unacknowledged and leaves the file alone', () => {
  withFreshBatches(({ batches, file }) => {
    const corrupt = 'not json at all';
    fs.writeFileSync(file, corrupt, 'utf8');
    batches.read();

    assert.throws(
      () => batches.write({ image: [], speech: [], music: [], video: [] }),
      (e) => e.code === 'EBATCHRECOVERY' && /recovery/i.test(e.message),
    );
    // The corrupt source survives the blocked write.
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  });
});

test('H-053: repeated reads do not stack additional backups', () => {
  withFreshBatches(({ batches, tmp, file }) => {
    fs.writeFileSync(file, '{{{{', 'utf8');
    batches.read();
    batches.read();
    batches.read();
    assert.equal(listBackups(tmp).length, 1);
  });
});

test('H-053: acknowledgeRecovery unblocks writes; the backup stays on disk', () => {
  withFreshBatches(({ batches, tmp, file }) => {
    fs.writeFileSync(file, '][', 'utf8');
    batches.read();
    const rec = batches.pendingRecovery();

    assert.equal(batches.acknowledgeRecovery(), true);
    assert.equal(batches.pendingRecovery(), null);

    batches.write({ image: ['fresh start'], speech: [], music: [], video: [] });
    assert.deepEqual(batches.read().image, ['fresh start']);
    // The pre-recovery backup is never cleaned up automatically.
    assert.equal(fs.existsSync(rec.backupPath), true);
    assert.equal(listBackups(tmp).length, 1);
    // Acknowledging again with no pending recovery reports false.
    assert.equal(batches.acknowledgeRecovery(), false);
  });
});

test('H-053: a FUTURE schemaVersion is fail-closed (not reinterpreted as v1)', () => {
  withFreshBatches(({ batches, file }) => {
    const future = JSON.stringify({ schemaVersion: 99, queues: { image: ['from the future'] }, extra: true });
    fs.writeFileSync(file, future, 'utf8');

    const got = batches.read();
    // Do NOT guess: the future payload is not surfaced as current data.
    assert.deepEqual(got, { image: [], speech: [], music: [], video: [] });

    const rec = batches.pendingRecovery();
    assert.ok(rec);
    assert.equal(rec.reason, 'newer-schema');
    assert.equal(fs.readFileSync(file, 'utf8'), future, 'future-schema file preserved verbatim');
    assert.throws(
      () => batches.write({ image: [], speech: [], music: [], video: [] }),
      (e) => e.code === 'EBATCHRECOVERY',
    );
  });
});

test('H-053: legacy bare-queues format still reads without triggering recovery', () => {
  withFreshBatches(({ batches, file }) => {
    fs.writeFileSync(file, JSON.stringify({ image: ['legacy prompt'], speech: [], music: [], video: [] }), 'utf8');
    const got = batches.read();
    assert.deepEqual(got.image, ['legacy prompt']);
    assert.equal(batches.pendingRecovery(), null);
  });
});
