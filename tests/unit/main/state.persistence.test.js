// tests/unit/main/state.persistence.test.js
// ============================================================================
// Phase C of _plan3.md — tests for the L2 cap + L3 move behaviour.
//
// The state module enforces the L2 cap (state.jobsArchiveCap, default
// 200, clamped [20, 1000]) on every write: the oldest entries above
// the cap are appended to the JSONL archive (state.jobs.archive.jsonl).
// We exercise this against a real temp directory so we can verify
// the disk-side state (state.json + archive file).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'state-persistence-test-'));
}

function loadStateWithDir(dir) {
  // Mock the electron module so configDir() returns our tmp dir.
  // app.getPath('exe') returns the full path to the executable;
  // configDir() does `path.dirname(app.getPath('exe'))` so we
  // need to return a file inside dir, not dir itself.
  const fakeExe = path.join(dir, 'MiniMaxAssetsTool.exe');
  const electronMock = { app: { getPath: (k) => fakeExe }, shell: { openPath: async () => '' } };
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'electron') return electronMock;
    return origLoad.call(this, request, parent, ...rest);
  };
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'src', 'state.js'))];
    delete require.cache[require.resolve(path.join(ROOT, 'src', 'config.js'))];
    return require(path.join(ROOT, 'src', 'state.js'));
  } finally {
    Module._load = origLoad;
  }
}

function writeSummary(id, status = 'ok') {
  return {
    id,
    type: 'image',
    title: `Job ${id}`,
    subtitle: 'test',
    status,
    startedAt: new Date(Date.parse('2026-06-20T12:00:00Z')).toISOString(),
    finishedAt: new Date(Date.parse('2026-06-20T12:00:05Z')).toISOString(),
    outputPaths: [`C:/tmp/${id}.png`],
    groupId: null,
  };
}

test('jobsArchiveCap is clamped to [20, 1000] even with a corrupted state.json', () => {
  const dir = makeTmpDir();
  process.env.MINIMAX_CONFIG_DIR = dir;
  const state = loadStateWithDir(dir);
  fs.writeFileSync(state.statePath(), JSON.stringify({ tabs: {}, jobsArchiveCap: 5000 }), 'utf8');
  // Re-read. The clamp must bring it down to 1000.
  const s = state.read();
  assert.equal(s.jobsArchiveCap, 1000, 'jobsArchiveCap > 1000 must be clamped');
  // A negative / zero / NaN value should be bumped to the default 200.
  fs.writeFileSync(state.statePath(), JSON.stringify({ tabs: {}, jobsArchiveCap: -50 }), 'utf8');
  const s2 = state.read();
  assert.equal(s2.jobsArchiveCap, 200);
  fs.writeFileSync(state.statePath(), JSON.stringify({ tabs: {}, jobsArchiveCap: 5 }), 'utf8');
  const s3 = state.read();
  assert.equal(s3.jobsArchiveCap, 20);
});

test('write() persists jobsSnapshot verbatim when under the cap', () => {
  const dir = makeTmpDir();
  process.env.MINIMAX_CONFIG_DIR = dir;
  const state = loadStateWithDir(dir);
  const snap = [writeSummary('j1'), writeSummary('j2'), writeSummary('j3')];
  state.write({ tabs: {}, jobsSnapshot: snap, jobsArchiveCap: 200 });
  const s = state.read();
  assert.deepEqual(s.jobsSnapshot, snap);
});

test('write() enforces the L2 cap: trimmed entries are moved to L3', () => {
  const dir = makeTmpDir();
  process.env.MINIMAX_CONFIG_DIR = dir;
  const state = loadStateWithDir(dir);
  // 25 entries, cap = 20 → 5 trimmed entries → moved to L3.
  const snap = Array.from({ length: 25 }, (_, i) => writeSummary('j' + i));
  state.write({ tabs: {}, jobsSnapshot: snap, jobsArchiveCap: 20 });
  const s = state.read();
  // L2: the 20 newest entries.
  assert.equal(s.jobsSnapshot.length, 20);
  assert.deepEqual(s.jobsSnapshot.map((x) => x.id),
    Array.from({ length: 25 }, (_, i) => 'j' + i).slice(-20));
  // L3: the 5 trimmed entries.
  const archivePath = path.join(dir, 'state.jobs.archive.jsonl');
  assert.ok(fs.existsSync(archivePath), 'archive file must be created');
  const lines = fs.readFileSync(archivePath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 5);
  const archived = lines.map((l) => JSON.parse(l));
  assert.deepEqual(archived.map((x) => x.id),
    Array.from({ length: 25 }, (_, i) => 'j' + i).slice(0, 5));
});

test('write() clamps the cap to [20, 1000] even when the user passes a value outside the range', () => {
  const dir = makeTmpDir();
  process.env.MINIMAX_CONFIG_DIR = dir;
  const state = loadStateWithDir(dir);
  const snap = Array.from({ length: 30 }, (_, i) => writeSummary('j' + i));
  // cap = 5 → should be clamped to 20 → last 20 entries survive, 10 → L3.
  state.write({ tabs: {}, jobsSnapshot: snap, jobsArchiveCap: 5 });
  const s = state.read();
  assert.equal(s.jobsSnapshot.length, 20, 'clamped cap keeps the last 20 entries');
  assert.equal(s.jobsArchiveCap, 20, 'cap is persisted as the clamped value');
});

test('write() is best-effort: a failing archive write does not block the main save', () => {
  const dir = makeTmpDir();
  process.env.MINIMAX_CONFIG_DIR = dir;
  const state = loadStateWithDir(dir);
  // Pre-create the archive file as a directory so writes to it
  // fail. (Trying to write to a path that's a directory throws.)
  fs.mkdirSync(path.join(dir, 'state.jobs.archive.jsonl'));
  const snap = Array.from({ length: 30 }, (_, i) => writeSummary('j' + i));
  // Should NOT throw — the main save must succeed.
  state.write({ tabs: {}, jobsSnapshot: snap, jobsArchiveCap: 5 });
  // Verify the trimmed L2 was still persisted.
  const s = state.read();
  assert.equal(s.jobsSnapshot.length, 20);
});

test('a partial last line in the archive is dropped on the next append (crash safety)', () => {
  const dir = makeTmpDir();
  process.env.MINIMAX_CONFIG_DIR = dir;
  const state = loadStateWithDir(dir);
  // 25 entries, cap=20 → 5 entries moved to L3 in the first write.
  const snap = Array.from({ length: 25 }, (_, i) => writeSummary('j' + i));
  state.write({ tabs: {}, jobsSnapshot: snap, jobsArchiveCap: 20 });
  // Now manually corrupt the archive: append a partial line.
  const archivePath = path.join(dir, 'state.jobs.archive.jsonl');
  fs.appendFileSync(archivePath, '{"id":"j1","title":"PARTIAL', 'utf8');
  // Next save: cap=20 still triggers trimming (overflow = 5 entries).
  // ArchiveService.append must drop the partial line before
  // appending new entries.
  state.write({ tabs: {}, jobsSnapshot: snap, jobsArchiveCap: 20 });
  // Verify the archive file is well-formed (every line parses).
  const lines = fs.readFileSync(archivePath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try { JSON.parse(line); } catch (e) {
      assert.fail(`archive line should be valid JSON: ${line} (${e.message})`);
    }
  }
});