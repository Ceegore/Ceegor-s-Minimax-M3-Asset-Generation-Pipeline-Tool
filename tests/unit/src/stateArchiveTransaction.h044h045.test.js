// tests/unit/src/stateArchiveTransaction.h044h045.test.js
// H-045: src/state.js write() must run the L2→L3 move as a transaction —
// each overflow entry is appended to the JSONL archive BEFORE it is dropped
// from state.json. On archive failure the overflow STAYS in state.json
// (temporarily exceeding the cap) and the failure is reported via the
// non-persisted _archiveWarnings field. Previously the list was trimmed
// first and append errors were swallowed → overflow silently destroyed.
// H-044 acceptance (report §H-044): cap 20 + 25 jobs → exactly 20 in L2,
// 5 in the L3 archive.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// Fresh config dir + fresh module instances per test (the H-045 dedupe set
// is module-level session state; a fresh require resets it).
function freshState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-h045-'));
  process.env.MINIMAX_CONFIG_DIR = dir;
  try {
    require.cache[require.resolve('electron')] = { exports: { app: { getPath: () => dir } } };
  } catch (_) { /* no electron shim needed when unresolvable */ }
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'config.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'state.js'))];
  const stateMod = require(path.join(ROOT, 'src', 'state.js'));
  return { dir, stateMod };
}

function makeJobs(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `${prefix}-${i}`, type: 'image', tab: 'image', title: 'Job ' + i, subtitle: '', status: 'ok', finishedAt: '2026-07-31T10:00:00Z', outputPaths: [], error: null });
  }
  return out;
}

function archiveLines(dir) {
  const p = path.join(dir, 'state.jobs.archive.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('H-044/H-045 acceptance: cap 20 + 25 jobs → exactly 20 in L2, 5 in L3, _jobsArchived=5', () => {
  const { dir, stateMod } = freshState();
  const clean = stateMod.write({ jobsSnapshot: makeJobs(25, 'acc'), jobsArchiveCap: 20 });
  // Return value reports the move; nothing of it is persisted.
  assert.equal(clean._jobsArchived, 5);
  assert.equal(clean._archiveWarnings, undefined);
  const back = stateMod.read();
  assert.equal(back.jobsSnapshot.length, 20, 'L2 must hold exactly cap entries');
  assert.equal(back.jobsSnapshot[0].id, 'acc-5', 'oldest 5 must have been moved out');
  assert.equal(back._jobsArchived, undefined, '_jobsArchived must NOT be persisted');
  const lines = archiveLines(dir);
  assert.equal(lines.length, 5, 'L3 archive must hold exactly the 5 overflow entries');
  assert.deepEqual(lines.map((l) => l.id), ['acc-0', 'acc-1', 'acc-2', 'acc-3', 'acc-4']);
});

test('H-045: a retried save with the same overflow does not duplicate archive entries', () => {
  const { dir, stateMod } = freshState();
  const snap = makeJobs(25, 'dup');
  stateMod.write({ jobsSnapshot: snap, jobsArchiveCap: 20 });
  // Renderer retry: the SAME untrimmed list is sent again (e.g. the first
  // response was lost, so the renderer never spliced its copy).
  const clean2 = stateMod.write({ jobsSnapshot: snap, jobsArchiveCap: 20 });
  assert.equal(clean2._jobsArchived, 5, 'retry still reports the entries as moved (they ARE in L3)');
  assert.equal(archiveLines(dir).length, 5, 'the archive must not contain duplicates');
  assert.equal(stateMod.read().jobsSnapshot.length, 20);
});

test('H-045: archive append failure keeps the overflow in state.json and reports warnings', () => {
  const { dir, stateMod } = freshState();
  // Block the archive path with a DIRECTORY → appendFileSync throws EISDIR.
  fs.mkdirSync(path.join(dir, 'state.jobs.archive.jsonl'));
  const clean = stateMod.write({ jobsSnapshot: makeJobs(25, 'fail'), jobsArchiveCap: 20 });
  assert.equal(clean._jobsArchived, undefined, 'nothing was archived');
  assert.ok(Array.isArray(clean._archiveWarnings) && clean._archiveWarnings.length === 1,
    'the failure must be reported as a warning');
  assert.match(clean._archiveWarnings[0], /jobs archive append failed/);
  const back = stateMod.read();
  assert.equal(back.jobsSnapshot.length, 25,
    'H-045: on archive failure ALL entries stay in state.json (no silent destruction)');
  assert.equal(back.jobsSnapshot[0].id, 'fail-0');
  assert.equal(back._archiveWarnings, undefined, '_archiveWarnings must NOT be persisted');
});

test('H-045: after the blocker is removed, a later save archives the retained overflow', () => {
  const { dir, stateMod } = freshState();
  fs.mkdirSync(path.join(dir, 'state.jobs.archive.jsonl'));
  stateMod.write({ jobsSnapshot: makeJobs(25, 'rec'), jobsArchiveCap: 20 });
  fs.rmdirSync(path.join(dir, 'state.jobs.archive.jsonl'));
  const snap = stateMod.read().jobsSnapshot;
  const clean = stateMod.write({ jobsSnapshot: snap, jobsArchiveCap: 20 });
  assert.equal(clean._jobsArchived, 5, 'the retained overflow is archived on the next save');
  assert.equal(archiveLines(dir).length, 5);
  assert.equal(stateMod.read().jobsSnapshot.length, 20);
});

test('H-044/H-045: state:set IPC returns jobsArchived + warnings to the renderer (source guard)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerStateIpc.js'), 'utf8');
  assert.ok(/const clean = stateMod\.write\(s\);/.test(src), 'state:set must capture write()\'s return');
  assert.ok(/res\.jobsArchived = Number\(clean\._jobsArchived\)/.test(src), 'state:set must forward _jobsArchived');
  assert.ok(/res\.warnings = clean\._archiveWarnings/.test(src), 'state:set must forward _archiveWarnings');
});
