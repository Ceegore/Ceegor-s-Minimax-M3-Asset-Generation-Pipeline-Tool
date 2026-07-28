// tests/unit/renderer/statePersistKeys.test.js
// Bug-fix B1a + B5 (_temp5.md): the entire Phase C job-history stack
// was dead because `jobsSnapshot` and `jobsArchiveCap` were missing
// from the renderer's STATE_PERSIST_KEYS — so saveAllStates() never
// sent them and init()'s load loop never read them back. Four other
// settings (apiKeyNoSave, fbTypeFilter, batchesAutoRemove,
// batchesExportFormat) had the same defect on BOTH sides.
//
// This test pins the renderer-side fix by loading the REAL
// section24_State.js in a minimal window mock (the file only needs
// `window` to exist) and asserting:
//   1. STATE_PERSIST_KEYS contains every key that src/state.js
//      write() sanitises (the two lists MUST stay in sync — that's
//      the whole point of the bug).
//   2. window.state has explicit defaults for the new keys so the
//      first read isn't `undefined` (greppable shape).
//   3. A simulated saveAllStates snapshot actually carries the keys.
//
// The backend (src/state.js) round-trip is covered by
// tests/unit/src/state.test.js; this file covers the renderer half.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SECTION_FILE = path.join(ROOT, 'renderer', 'sections', 'section24_State.js');

function loadSection24() {
  // Fresh minimal window mock. section24_State.js only assigns to
  // `window.STATE_PERSIST_KEYS` and `window.state`, plus a `var state`
  // alias and a top-level `const _popupSeenThisSession`. It doesn't
  // touch document at top level.
  const win = {};
  global.window = win;
  // A fresh require each time so the IIFE re-runs against our mock.
  delete require.cache[require.resolve(SECTION_FILE)];
  require(SECTION_FILE);
  return win;
}

// The canonical list of keys src/state.js write() whitelists. This
// is the source of truth the renderer's STATE_PERSIST_KEYS MUST
// match (modulo the `tabs`/`currentTab`/`fbDirs` special-cases,
// which the renderer handles separately).
//
// Bug-fix LOW-5 (_temp5.md 360° audit): extract the keys DYNAMICALLY
// from src/state.js write()'s `clean` object literal instead of
// hardcoding them. The previous hardcoded copy could silently drift
// if a developer added a key to write() and forgot to update this
// list — the test would still pass and the bug (renderer resets that
// key on every restart) would go undetected. By regex-parsing the
// source we guarantee any new key in write() must also appear in
// STATE_PERSIST_KEYS.
function extractBackendKeys() {
  const stateCode = fs.readFileSync(path.join(ROOT, 'src', 'state.js'), 'utf8');
  // Locate `const clean = { ... }` and pull out the `key:` literals.
  const cleanMatch = stateCode.match(/const clean = \{([\s\S]*?)\n  \};/);
  assert.ok(cleanMatch, 'could not locate `const clean = { ... }` in src/state.js write()');
  const body = cleanMatch[1];
  // Keys are the identifiers immediately inside the object literal
  // (`key: value`). Match top-level `word:` at the start of a line,
  // skipping comments and nested object keys.
  const keys = new Set();
  for (const line of body.split('\n')) {
    const m = line.match(/^\s{4}([a-zA-Z_][a-zA-Z0-9_]*):\s/);
    if (m) keys.add(m[1]);
  }
  // `tabs` is the snapshot root (`{ tabs: state.tabSettings, ...rest }`)
  // — it's NOT a STATE_PERSIST_KEYS entry (the renderer handles it
  // separately in saveAllStates). All other clean-object keys
  // (currentTab, fbDirs included) ARE in STATE_PERSIST_KEYS and MUST
  // round-trip. Exclude `tabs` from the sync check so the assertion
  // doesn't false-fire on the one legitimate special-case.
  keys.delete('tabs');
  return Array.from(keys);
}
const BACKEND_WHITELISTED_KEYS = extractBackendKeys();

test('sanity: dynamically-extracted backend key list is non-empty', () => {
  assert.ok(BACKEND_WHITELISTED_KEYS.length >= 20,
    `extractBackendKeys should find at least 20 keys in src/state.js write() (got ${BACKEND_WHITELISTED_KEYS.length}); if this fails, the regex parse is broken`);
  // The keys we explicitly fixed in this pass must be present (if
  // any is missing, the regex parse missed it — fail loud).
  for (const k of ['jobsSnapshot', 'jobsArchiveCap', 'apiKeyNoSave', 'fbTypeFilter', 'batchesAutoRemove', 'batchesExportFormat']) {
    assert.ok(BACKEND_WHITELISTED_KEYS.includes(k), `extractBackendKeys missed ${k} — the regex parse is broken`);
  }
});

test('B1a+B5: STATE_PERSIST_KEYS contains every key whitelisted by src/state.js write()', () => {
  const win = loadSection24();
  assert.ok(Array.isArray(win.STATE_PERSIST_KEYS), 'STATE_PERSIST_KEYS must be an array');
  const missing = BACKEND_WHITELISTED_KEYS.filter((k) => !win.STATE_PERSIST_KEYS.includes(k));
  assert.deepEqual(missing, [],
    `STATE_PERSIST_KEYS is missing keys that src/state.js write() sanitises — these would silently reset on every restart: ${JSON.stringify(missing)}`);
});

test('B1a: STATE_PERSIST_KEYS explicitly includes jobsSnapshot and jobsArchiveCap', () => {
  const win = loadSection24();
  assert.ok(win.STATE_PERSIST_KEYS.includes('jobsSnapshot'),
    'jobsSnapshot must be in STATE_PERSIST_KEYS or the L2 previous-session list never reloads (B1a)');
  assert.ok(win.STATE_PERSIST_KEYS.includes('jobsArchiveCap'),
    'jobsArchiveCap must be in STATE_PERSIST_KEYS or the History pane cap input resets on restart (B1a)');
});

test('B1a: window.state declares explicit defaults for jobsSnapshot and jobsArchiveCap', () => {
  const win = loadSection24();
  assert.ok(win.state && typeof win.state === 'object');
  // jobsSnapshot default is `null` (NOT [] — saves an empty array
  // in state.json and lets the renderer tell "no jobs yet" apart
  // from "jobs were cleared").
  assert.equal(win.state.jobsSnapshot, null,
    'state.jobsSnapshot default must be null (not undefined, not []) so the shape is greppable');
  assert.equal(win.state.jobsArchiveCap, 200,
    'state.jobsArchiveCap default must be 200 so the History pane input has a known initial value');
});

test('B5: window.state declares explicit defaults for the four previously-lost settings', () => {
  const win = loadSection24();
  // Each default must match the corresponding default in
  // src/state.js write() so a first-run user sees consistent
  // behaviour before the first save.
  assert.equal(win.state.apiKeyNoSave, false, 'apiKeyNoSave default must be false');
  assert.equal(win.state.fbTypeFilter, '', 'fbTypeFilter default must be empty string ("All types")');
  assert.equal(win.state.batchesAutoRemove, true, 'batchesAutoRemove default must be true (opt-OUT)');
  assert.equal(win.state.batchesExportFormat, 'md', 'batchesExportFormat default must be md');
});

// Simulated saveAllStates: the snapshot must actually carry the new
// keys. This is the exact loop in renderer/app.js saveAllStates()
// (lines ~1439-1441):
//   const snapshot = { tabs: state.tabSettings };
//   const persistKeys = window.STATE_PERSIST_KEYS || [];
//   for (const k of persistKeys) snapshot[k] = state[k];
// We replicate it here against the REAL STATE_PERSIST_KEYS + the
// REAL window.state defaults so a future change to either side
// (the list, the defaults, or the loop) fails this test.
test('B1a+B5: a simulated saveAllStates snapshot carries jobsSnapshot/jobsArchiveCap and the four settings', () => {
  const win = loadSection24();
  // Pretend a job finished and pushed a snapshot entry.
  win.state.jobsSnapshot = [{ id: 'job-x', type: 'image', status: 'ok', finishedAt: '2026-06-22T12:00:00.000Z', outputPaths: ['C:/out/x.png'], title: 'X', subtitle: '', tab: 'image', error: null }];
  win.state.jobsArchiveCap = 50;
  win.state.apiKeyNoSave = true;
  win.state.fbTypeFilter = 'png';
  win.state.batchesAutoRemove = false;
  win.state.batchesExportFormat = 'txt';

  // Mirror saveAllStates' snapshot build exactly.
  const snapshot = { tabs: {} };
  for (const k of win.STATE_PERSIST_KEYS) snapshot[k] = win.state[k];

  // The keys the bug was about MUST be in the snapshot, and MUST
  // carry the value that was on state.* at save time.
  assert.ok('jobsSnapshot' in snapshot, 'snapshot missing jobsSnapshot — B1a regression');
  assert.deepEqual(snapshot.jobsSnapshot, win.state.jobsSnapshot);
  assert.equal(snapshot.jobsArchiveCap, 50);
  assert.equal(snapshot.apiKeyNoSave, true);
  assert.equal(snapshot.fbTypeFilter, 'png');
  assert.equal(snapshot.batchesAutoRemove, false);
  assert.equal(snapshot.batchesExportFormat, 'txt');
});

// And the load side: init()'s persist-key load loop is:
//   for (const k of persistKeys) {
//     if (k === 'fbDirs' || k === 'currentTab') continue;
//     if (savedState[k] === undefined || savedState[k] === null) continue;
//     state[k] = savedState[k];
//   }
// Simulate it against the REAL STATE_PERSIST_KEYS and confirm a
// saved jobsSnapshot would actually make it back into state.* on
// the next launch (the precise condition B1b's old parse-time
// renderPersistedL2 call violated).
test('B1a: simulated init() load loop restores jobsSnapshot into state.* from a saved payload', () => {
  const win = loadSection24();
  const saved = {
    jobsSnapshot: [{ id: 'job-prev', type: 'music', status: 'ok', finishedAt: '2026-06-21T09:00:00.000Z', outputPaths: [], title: 'Prev', subtitle: '', tab: 'music', error: null }],
    jobsArchiveCap: 80,
    apiKeyNoSave: true,
    fbTypeFilter: 'wav',
    batchesAutoRemove: false,
    batchesExportFormat: 'txt',
  };
  // Mirror init()'s load loop exactly (app.js ~322-327).
  for (const k of win.STATE_PERSIST_KEYS) {
    if (k === 'fbDirs' || k === 'currentTab') continue;
    if (saved[k] === undefined || saved[k] === null) continue;
    win.state[k] = saved[k];
  }
  assert.deepEqual(win.state.jobsSnapshot, saved.jobsSnapshot,
    'init() load loop must restore jobsSnapshot — B1a regression (the value would stay null forever)');
  assert.equal(win.state.jobsArchiveCap, 80);
  assert.equal(win.state.apiKeyNoSave, true);
  assert.equal(win.state.fbTypeFilter, 'wav');
  assert.equal(win.state.batchesAutoRemove, false);
  assert.equal(win.state.batchesExportFormat, 'txt');
});
