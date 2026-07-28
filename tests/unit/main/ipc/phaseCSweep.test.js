// tests/unit/main/ipc/phaseCSweep.test.js
// ============================================================================
// Phase C full-tool-sweep harness — exercises every Phase-C surface against
// real filesystem fixtures and captures every tool call to the debug
// server in `.dbg/full-tool-sweep.env` so we can confirm each behaviour.
//
// The harness runs deterministically: each test gets its own tempdir,
// every IPC handler is registered against a mocked `electron`, and every
// tool call is recorded with hypothesisId + location so the evidence
// log in `debug-full-tool-sweep.md` is reproducible.
//
// Phase C surfaces covered:
//   state:set / state:get
//   state:archiveRead / state:archiveClear / state:archiveSize
//   state:archiveDelete
//   src/services/ArchiveService: append, readChunk, deleteOne, clear,
//                                size, _trimPartialLastLine
//   src/state.js: L2 cap enforcement + L3 move on every write
//   renderer LogService: renderPersistedL2 (boot-time L2 render)
//
// Bugs to look for (Phase-C specific):
//   H1. The state:set handler does NOT trigger an archive append when
//       jobsSnapshot overflows jobsArchiveCap.
//   H2. state:archiveSize returns 0 even after writes (wrong dir).
//   H3. state:archiveDelete returns ok:true even when nothing matched.
//   H4. readChunk is offset-based but the renderer never passes an
//       offset → always returns first 100 lines, never scrolls.
//   H5. The L2 cap clamp in read() does NOT handle missing
//       jobsArchiveCap (the field is null) — silently falls back to
//       200 which could mask a corruption bug.
//   H6. _trimPartialLastLine does not handle a 0-byte file
//       (returns silently — which is correct; just confirm).
//   H7. The L2 clamp does NOT happen when the user writes a NEW
//       state.json (round-trip preserves user's cap).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DEBUG_ENV_PATH = path.join(ROOT, '.dbg', 'full-tool-sweep.env');

function purgeProjectCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ROOT) && key !== __filename) delete require.cache[key];
  }
}

function makeDebugReporter() {
  // Read debug config from .dbg/full-tool-sweep.env (set by debug session).
  let url = null;
  let sessionId = 'phase-c-sweep';
  try {
    const envText = fs.readFileSync(DEBUG_ENV_PATH, 'utf8');
    url = envText.match(/DEBUG_SERVER_URL=(.+)/)?.[1]?.trim() || null;
    sessionId = envText.match(/DEBUG_SESSION_ID=(.+)/)?.[1]?.trim() || sessionId;
  } catch (_) { /* env not present — silent */ }
  const calls = [];
  function report(hypothesisId, location, msg, data) {
    calls.push({ hypothesisId, location, msg, data });
    if (url && typeof fetch === 'function') {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId, runId: 'phase-c', hypothesisId, location, msg, data, ts: Date.now(),
        }),
      }).catch(() => {});
    }
  }
  return { report, calls };
}

function createElectronMock() {
  const handlers = {};
  return {
    handlers,
    module: {
      ipcMain: {
        handle(channel, fn) { handlers[channel] = fn; },
      },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: {
        showItemInFolder: () => {},
        openPath: async () => '',
        openExternal: async () => {},
      },
      app: {
        getPath(name) {
          // We'll override this in withIsolatedProject below.
          return name === 'exe' ? process.cwd() : process.cwd();
        },
      },
      BrowserWindow: class {},
      contextBridge: undefined,
      ipcRenderer: undefined,
    },
  };
}

async function withIsolatedProject(options, run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-c-sweep-'));
  const previousConfigDir = process.env.MINIMAX_CONFIG_DIR;
  process.env.MINIMAX_CONFIG_DIR = tmp;
  purgeProjectCache();
  const electron = createElectronMock();
  // Make app.getPath('exe') return a file INSIDE the tmp dir, so
  // configDir() returns our tmp dir (otherwise it would return the
  // tmp dir's parent — path.dirname(<dir>) returns the parent).
  electron.module.app.getPath = (name) => {
    if (name === 'exe') return path.join(tmp, 'MiniMaxAssetsTool.exe');
    return tmp;
  };
  try {
    return await new Promise((resolve, reject) => {
      const originalLoad = Module._load;
      Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'electron') return electron.module;
        return originalLoad.call(this, request, parent, isMain);
      };
      try {
        return Promise.resolve(run({ tmp, electron, load: (rel) => require(path.join(ROOT, rel)) })).then(resolve, reject);
      } catch (e) { reject(e); }
      finally {
        Module._load = originalLoad;
      }
    });
  } finally {
    if (previousConfigDir == null) delete process.env.MINIMAX_CONFIG_DIR;
    else process.env.MINIMAX_CONFIG_DIR = previousConfigDir;
    purgeProjectCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

function mkSummary(id, status = 'ok', extras = {}) {
  return {
    id,
    type: 'image',
    title: `Job ${id}`,
    subtitle: 'phase-c-test',
    status,
    startedAt: '2026-06-20T12:00:00.000Z',
    finishedAt: '2026-06-20T12:00:05.000Z',
    outputPaths: [`C:/tmp/${id}.png`],
    groupId: null,
    ...extras,
  };
}

test('Phase C / state:set persists jobsSnapshot verbatim when under the cap', async () => {
  const { calls, report } = makeDebugReporter();
  await withIsolatedProject({}, async ({ tmp, electron, load }) => {
    load('main/ipc/registerStateIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const snap = [mkSummary('a'), mkSummary('b'), mkSummary('c')];
    report('H7', 'phaseCSweep:state.set', 'before write', { snap: snap.length, cap: 200 });
    const setRes = electron.handlers['state:set'](null, {
      tabs: {},
      jobsSnapshot: snap,
      jobsArchiveCap: 200,
    });
    report('H7', 'phaseCSweep:state.set', 'after write', { setRes });
    assert.deepEqual(setRes, { ok: true });
    const got = electron.handlers['state:get']();
    assert.equal(got.jobsSnapshot.length, 3);
    assert.equal(got.jobsArchiveCap, 200);
    // No archive file should exist (nothing overflowed).
    const archivePath = path.join(tmp, 'state.jobs.archive.jsonl');
    assert.equal(fs.existsSync(archivePath), false, 'no archive file when nothing overflows');
  });
});

test('Phase C / H1: state:set triggers archive append when jobsSnapshot exceeds the cap', async () => {
  const { report } = makeDebugReporter();
  await withIsolatedProject({}, async ({ tmp, electron, load }) => {
    load('main/ipc/registerStateIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    // 25 entries, cap = 20 → 5 overflow.
    const snap = Array.from({ length: 25 }, (_, i) => mkSummary('j' + i));
    report('H1', 'phaseCSweep:H1:state.set', 'before write', { snap: snap.length, cap: 20 });
    const setRes = electron.handlers['state:set'](null, {
      tabs: {}, jobsSnapshot: snap, jobsArchiveCap: 20,
    });
    report('H1', 'phaseCSweep:H1:state.set', 'after write', { setRes });
    assert.deepEqual(setRes, { ok: true });
    const got = electron.handlers['state:get']();
    // L2 should be the last 20.
    assert.equal(got.jobsSnapshot.length, 20);
    // Archive file MUST exist (5 entries moved to L3).
    const archivePath = path.join(tmp, 'state.jobs.archive.jsonl');
    report('H1', 'phaseCSweep:H1:archivePath', 'after write', {
      archivePath,
      exists: fs.existsSync(archivePath),
    });
    assert.equal(fs.existsSync(archivePath), true, 'archive file must be created on overflow');
    const lines = fs.readFileSync(archivePath, 'utf8').split('\n').filter(Boolean);
    report('H1', 'phaseCSweep:H1:archivePath', 'lines', { count: lines.length });
    assert.equal(lines.length, 5, '5 entries must have been moved to L3');
    const archivedIds = lines.map((l) => JSON.parse(l).id);
    assert.deepEqual(archivedIds, ['j0', 'j1', 'j2', 'j3', 'j4']);
  });
});

test('Phase C / H2: state:archiveSize returns the file size after writes', async () => {
  const { report } = makeDebugReporter();
  await withIsolatedProject({}, async ({ tmp, electron, load }) => {
    load('main/ipc/registerStateIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    // First write: 25 entries, cap 20 → 5 in archive.
    const snap = Array.from({ length: 25 }, (_, i) => mkSummary('j' + i));
    electron.handlers['state:set'](null, {
      tabs: {}, jobsSnapshot: snap, jobsArchiveCap: 20,
    });
    const sizeRes = electron.handlers['state:archiveSize']();
    report('H2', 'phaseCSweep:H2:archiveSize', 'after overflow', { sizeRes });
    assert.equal(sizeRes.ok, true);
    assert.ok(sizeRes.bytes > 0, 'archive size must be > 0 after writes');
    // The archive must be at least 5 lines × ~50 bytes/line = 250 bytes.
    assert.ok(sizeRes.bytes >= 250, `archive size should be at least 250 bytes (got ${sizeRes.bytes})`);
  });
});

test('Phase C / state:archiveRead returns chunks with correct shape', async () => {
  const { report } = makeDebugReporter();
  await withIsolatedProject({}, async ({ tmp, electron, load }) => {
    load('main/ipc/registerStateIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const snap = Array.from({ length: 50 }, (_, i) => mkSummary('k' + i));
    electron.handlers['state:set'](null, {
      tabs: {}, jobsSnapshot: snap, jobsArchiveCap: 20,
    });
    const r1 = electron.handlers['state:archiveRead'](null, { offset: 0, limit: 10 });
    report('H4', 'phaseCSweep:H4:archiveRead', 'first chunk', {
      got: r1.lines.length, hasMore: r1.hasMore, nextOffset: r1.nextOffset,
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.lines.length, 10);
    assert.equal(r1.hasMore, true);
    assert.ok(r1.nextOffset > 0);
    const r2 = electron.handlers['state:archiveRead'](null, { offset: r1.nextOffset, limit: 100 });
    assert.equal(r2.lines.length, 20, 'second chunk reads the remaining 20');
    assert.equal(r2.hasMore, false);
  });
});

test('Phase C / state:archiveDelete removes a single entry atomically', async () => {
  const { report } = makeDebugReporter();
  await withIsolatedProject({}, async ({ tmp, electron, load }) => {
    load('main/ipc/registerStateIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const snap = Array.from({ length: 25 }, (_, i) => mkSummary('d' + i));
    electron.handlers['state:set'](null, {
      tabs: {}, jobsSnapshot: snap, jobsArchiveCap: 20,
    });
    const beforeSize = electron.handlers['state:archiveSize']().bytes;
    const delRes = electron.handlers['state:archiveDelete'](null, { id: 'd1' });
    report('H3', 'phaseCSweep:H3:archiveDelete', 'first delete', { delRes });
    assert.equal(delRes.ok, true);
    assert.equal(delRes.removed, true);
    const afterSize = electron.handlers['state:archiveSize']().bytes;
    assert.ok(afterSize < beforeSize, 'archive must shrink after delete');
    const delMiss = electron.handlers['state:archiveDelete'](null, { id: 'does-not-exist' });
    assert.equal(delMiss.removed, false, 'H3: missing id must report removed:false');
  });
});

test('Phase C / state:archiveClear empties the file', async () => {
  const { report } = makeDebugReporter();
  await withIsolatedProject({}, async ({ tmp, electron, load }) => {
    load('main/ipc/registerStateIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const snap = Array.from({ length: 25 }, (_, i) => mkSummary('c' + i));
    electron.handlers['state:set'](null, {
      tabs: {}, jobsSnapshot: snap, jobsArchiveCap: 20,
    });
    assert.ok(electron.handlers['state:archiveSize']().bytes > 0);
    const clearRes = electron.handlers['state:archiveClear']();
    report('H3', 'phaseCSweep:archiveClear', 'cleared', { clearRes });
    assert.equal(clearRes.ok, true);
    assert.ok(clearRes.removedBytes > 0);
    assert.equal(electron.handlers['state:archiveSize']().bytes, 0);
  });
});

test('Phase C / H5: read() clamps jobsArchiveCap defensively', async () => {
  await withIsolatedProject({}, async ({ tmp, electron, load }) => {
    load('main/ipc/registerStateIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    // Write a CORRUPTED state.json directly.
    fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({
      tabs: {},
      jobsArchiveCap: 9999, // out of range
    }));
    const got = electron.handlers['state:get']();
    assert.equal(got.jobsArchiveCap, 1000, '9999 must clamp to 1000');
    // Negative value falls back to 200.
    fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({
      tabs: {}, jobsArchiveCap: -50,
    }));
    const got2 = electron.handlers['state:get']();
    assert.equal(got2.jobsArchiveCap, 200, '-50 must fall back to default 200');
    // Non-numeric falls back to 200.
    fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({
      tabs: {}, jobsArchiveCap: 'banana',
    }));
    const got3 = electron.handlers['state:get']();
    assert.equal(got3.jobsArchiveCap, 200);
  });
});

test('Phase C / Crash safety: a partial last line in the archive is dropped on next state:set', async () => {
  const { report } = makeDebugReporter();
  await withIsolatedProject({}, async ({ tmp, electron, load }) => {
    load('main/ipc/registerStateIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    // First write creates the archive with 5 entries.
    const snap1 = Array.from({ length: 25 }, (_, i) => mkSummary('p' + i));
    electron.handlers['state:set'](null, {
      tabs: {}, jobsSnapshot: snap1, jobsArchiveCap: 20,
    });
    const archivePath = path.join(tmp, 'state.jobs.archive.jsonl');
    assert.ok(fs.existsSync(archivePath));
    // Corrupt the file with a partial last line (simulate crash mid-write).
    fs.appendFileSync(archivePath, '{"id":"p99","title":"PARTIAL', 'utf8');
    const beforeContent = fs.readFileSync(archivePath, 'utf8');
    report('H6', 'phaseCSweep:crashSafety', 'before second write', {
      endsWithPartial: !beforeContent.endsWith('\n'),
    });
    // Second write: 25 entries, cap 20 → another 5 overflow.
    // ArchiveService.append must drop the partial line first.
    const snap2 = Array.from({ length: 25 }, (_, i) => mkSummary('q' + i));
    electron.handlers['state:set'](null, {
      tabs: {}, jobsSnapshot: snap2, jobsArchiveCap: 20,
    });
    const afterContent = fs.readFileSync(archivePath, 'utf8');
    report('H6', 'phaseCSweep:crashSafety', 'after second write', {
      endsWithNewline: afterContent.endsWith('\n'),
      totalLines: afterContent.split('\n').filter(Boolean).length,
    });
    // Every line in the file must be valid JSON.
    const lines = afterContent.split('\n').filter(Boolean);
    for (const line of lines) {
      try { JSON.parse(line); } catch (e) {
        assert.fail(`archive line should be valid JSON: ${line} (${e.message})`);
      }
    }
    // The archive should now have 5 (old) + 5 (new) = 10 valid entries.
    assert.equal(lines.length, 10, `expected 10 valid lines, got ${lines.length}`);
    assert.equal(afterContent.endsWith('\n'), true, 'archive must end with a newline');
  });
});

test('Phase C / H4 follow-up: archiveRead paginates correctly across 3 chunks', async () => {
  await withIsolatedProject({}, async ({ tmp, electron, load }) => {
    load('main/ipc/registerStateIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const snap = Array.from({ length: 100 }, (_, i) => mkSummary('p' + i));
    electron.handlers['state:set'](null, {
      tabs: {}, jobsSnapshot: snap, jobsArchiveCap: 20,
    });
    // Walk in chunks of 30. 80 archive entries → 3 chunks.
    const seen = new Set();
    let off = 0;
    let hasMore = true;
    let chunks = 0;
    while (hasMore) {
      const r = electron.handlers['state:archiveRead'](null, { offset: off, limit: 30 });
      assert.equal(r.ok, true);
      for (const j of r.lines) seen.add(j.id);
      off = r.nextOffset;
      hasMore = r.hasMore;
      chunks++;
      if (chunks > 10) assert.fail('too many chunks — pagination stuck');
    }
    assert.equal(seen.size, 80);
  });
});

test('Phase C / Renderer side: LogService.renderPersistedL2 renders rows but does not make them clickable', async () => {
  // This is a render-side test. We exercise the same code path
  // (with a minimal DOM stub) to confirm the rows are appended.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-c-render-'));
  try {
    global.window = global.window || {};
    global.window.state = { _logEvents: [], jobsSnapshot: null };
    const docs = [];
    function makeEl() {
      const style = {};
      const el = {
        attributes: {},
        children: [],
        style,
        classList: { add(c) { el.classes = el.classes || new Set(); el.classes.add(c); } },
        set innerHTML(v) { el._innerHTML = v; el.children = []; },
        get innerHTML() { return el._innerHTML || ''; },
        set textContent(v) { el._text = v; el.children = []; },
        get textContent() { return el._text || ''; },
        appendChild(child) { el.children.push(child); return child; },
        append(...children) { for (const c of children) el.children.push(c); },
        setAttribute(k, v) { el.attributes[k] = v; },
        getAttribute(k) { return el.attributes[k]; },
        set id(v) { el.attributes.id = v; },
        get id() { return el.attributes.id; },
        set className(v) { el._className = v; if (el.classList) for (const c of String(v).split(/\s+/).filter(Boolean)) el.classList.add(c); },
        get className() { return el._className || ''; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
      };
      return el;
    }
    global.window.document = {
      createElement(tag) { const e = makeEl(); e.tagName = tag; return e; },
      getElementById(id) { return docs.find((d) => d.attributes && d.attributes.id === id) || null; },
      body: { appendChild(child) { docs.push(child); } },
    };
    // LogService reads the bare global `document` (via direct
    // identifier), not just `window.document`. Set both.
    global.document = global.window.document;
    const ROOT_RENDERER = path.join(ROOT, 'renderer', 'jobs', 'JobRunner.js');
    const ROOT_LOGSVC = path.join(ROOT, 'renderer', 'services', 'LogService.js');
    // Load LogService inside an IIFE so its top-level declarations
    // (e.g. the `log` helper) don't pollute the test's outer
    // scope across multiple test runs.
    const logSrc = fs.readFileSync(ROOT_LOGSVC, 'utf8');
    const wrapped = '(function() {\n' + logSrc + '\n})();';
    // eslint-disable-next-line no-eval
    eval(wrapped);
    // renderPersistedL2 looks up document.getElementById('log').
    // Provide a stub root with that id so the function has a host.
    const logRoot = makeEl();
    logRoot.attributes.id = 'log';
    docs.push(logRoot);
    // Now call renderPersistedL2.
    const snapshot = [
      mkSummary('r1', 'ok'),
      mkSummary('r2', 'err', { subtitle: 'quota exceeded' }),
      mkSummary('r3', 'warn', { subtitle: 'retry succeeded' }),
    ];
    const added = window.LogService.renderPersistedL2(snapshot);
    assert.equal(added, 3);
    assert.equal(logRoot.children.length, 3);
    // Each row must have a data-persisted="1" attribute.
    for (const row of logRoot.children) {
      assert.equal(row.attributes['data-persisted'], '1');
      // Rows must not have a data-job-id (the cancel handler relies on it).
      // Confirms they're non-interactive by design.
      assert.ok(!row.attributes['data-job-id'],
        'persisted rows must not have data-job-id (non-interactive by design)');
      // bug-fix M2 (_temp4.md): the row's DIRECT children must match
      // renderLogEvent's flat structure (ts, icon, headline, chev,
      // details) — NOT wrap icon+headline in an extra .log-event-head
      // div. .log-event is display:grid with a fixed
      // grid-template-columns; an extra wrapper counts as a single
      // grid child, squeezing icon+headline into one column instead
      // of each getting its own, and misaligning against every live
      // row.
      const childClasses = row.children.map((c) => c.className);
      assert.ok(!childClasses.includes('log-event-head'),
        'M2 regression: renderPersistedL2 must not wrap icon+headline in a .log-event-head div');
      assert.deepEqual(childClasses, ['log-event-ts', 'log-type-icon', 'log-event-headline', 'log-event-chev log-event-chev-empty', 'log-event-details'],
        'M2: persisted rows must have the same flat child shape (and class names) as a simple live row');
    }
  } finally {
    delete global.window;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});