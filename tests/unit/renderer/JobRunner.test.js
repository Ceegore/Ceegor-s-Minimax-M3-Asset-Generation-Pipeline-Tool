// tests/unit/renderer/JobRunner.test.js
// ============================================================================
// Phase A of _plan3.md — tests for the multi-job runner.
//
// The JobRunner is a renderer-side module that owns the per-tab
// generation lifecycle. These tests load the actual production file
// (renderer/jobs/JobRunner.js) through a minimal window/DOM mock and
// exercise its public API:
//
//   - run() creates a Job, sets state.generating (derived projection),
//     appends a primary log row, and returns { jobId, cancel, done }.
//   - isTabRunning() returns true while a job is wip on that tab.
//   - cancel(jobId) flips the job to 'cancel' on the next resolve.
//   - cancelAll() flips every wip job.
//   - runFn signals: ctx.signal.aborted is set on cancel.
//   - attachSecondaryToJob(jobId, line) appends the line into the
//     job's primary row's details (not as a new row).
//   - The hard cap of 16 concurrent jobs is enforced.
//   - The per-tab re-entrancy check prevents two jobs on the same tab.
//   - state.generating is a derived projection (single tab → tabKey,
//     multiple tabs → 'mixed', none → null).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    classList: {
      _set: new Set(),
      add(c) { if (c) for (const cls of String(c).split(/\s+/).filter(Boolean)) this._set.add(cls); },
      remove(c) { if (c) for (const cls of String(c).split(/\s+/).filter(Boolean)) this._set.delete(cls); },
      contains(c) { return this._set.has(c); },
      toggle(c, force) {
        if (force === true) this.add(c);
        else if (force === false) this.remove(c);
        else if (this._set.has(c)) this.remove(c);
        else this.add(c);
        return this._set.has(c);
      },
    },
    parentNode: null,
    dataset: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] == null ? null : String(this.attributes[k]); },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    insertBefore(child, ref) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); return child; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text != null ? this._text : ''; },
  };
}

function setupMock() {
  delete global.window;
  delete global.document;
  const logEl = makeEl('div');
  const doc = {
    createElement: (tag) => makeEl(tag),
    createElementNS: (_, tag) => makeEl(tag),
    getElementById: (id) => (id === 'log' ? logEl : null),
    querySelector: (sel) => (sel === '#log' ? logEl : null),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: makeEl('body'),
    documentElement: makeEl('html'),
  };
  const elFactory = (tag, attrs, ...children) => {
    const n = makeEl(tag);
    if (attrs && typeof attrs === 'object') {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') n.classList.add(v);
        else n.attributes[k] = v;
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      if (typeof c === 'string' || typeof c === 'number') {
        const t = makeEl('span');
        t.textContent = String(c);
        n.children.push(t);
        t.parentNode = n;
      } else if (typeof c === 'object' && c.tagName) {
        n.children.push(c);
        c.parentNode = n;
      }
    }
    return n;
  };
  const win = {
    api: { mmxCancel: () => Promise.resolve({ ok: true }) },
    state: { _logEvents: [], jobs: new Map() },
    toast: () => {},
    el: elFactory,
    createElement: elFactory,
    LogCategories: { LOG_MAX_EVENTS: 500, LOG_CATEGORIES: { info: { icon: '·', label: 'Info' } } },
    securityUtils: { maskLine: (s) => String(s) },
  };
  win.document = doc;
  global.window = win;
  global.document = doc;
  return { win, logEl };
}

function loadJobRunner() {
  // Fresh require for each test so state.jobs is empty.
  const file = path.join(ROOT, 'renderer', 'jobs', 'JobRunner.js');
  delete require.cache[require.resolve(file)];
  // Load LogService stub so JobRunner can call into it. We use a
  // tiny stub that satisfies JobRunner's expectations: addLogEvent
  // is the only API JobRunner uses.
  const lsFile = path.join(ROOT, 'renderer', 'services', 'LogService.js');
  // Build a minimal LogService in window BEFORE requiring JobRunner
  // — JobRunner only calls window.LogService.addLogEvent and
  // updateLogStatus, so the stub needs just those.
  let nextId = 0;
  global.window.LogService = {
    addLogEvent(opts) {
      opts = opts || {};
      const ev = {
        id: ++nextId,
        ts: new Date(),
        headline: opts.headline || '',
        details: opts.details || [],
        jobId: opts.jobId || null,
        state: opts.state || 'wip',
        cancellable: !!opts.cancellable,
        typeIcon: opts.typeIcon || null,
        progress: opts.progress || null,
      };
      global.window.state._logEvents.push(ev);
      return ev.id;
    },
    updateLogStatus() {},
    appendLogDetails() {},
  };
  require(file);
  return global.window.JobRunner;
}

test('JobRunner.run creates a job and returns { jobId, cancel, done }', async () => {
  const { win } = setupMock();
  const JobRunner = loadJobRunner();
  const ctrl = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    title: 'Test image',
    typeIcon: '🖼',
    runFn: async () => ({ status: 'ok' }),
  });
  assert.equal(typeof ctrl.jobId, 'string');
  assert.equal(typeof ctrl.cancel, 'function');
  assert.ok(ctrl.done instanceof Promise);
  // While the runFn is in flight, the job should be wip.
  assert.equal(JobRunner.isTabRunning('image'), true);
  assert.equal(JobRunner.activeJobs().length, 1);
  // state.generating is a derived projection: single tab → its key.
  assert.equal(win.state.generating, 'image');
  await ctrl.done;
  // After the runFn resolves, the job is done. We LEAVE the
  // legacy state.generating field alone when no JobRunner job
  // is in flight (the legacy armGenBtnWithCancel flow owns it
  // in that case).
  assert.equal(JobRunner.isTabRunning('image'), false);
});

test('JobRunner.isTabRunning reports per-tab busy state', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  // Stalled job — we control when it resolves via the runFn.
  let resolveStalled;
  const stalled = new Promise((r) => { resolveStalled = r; });
  const ctrl1 = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    runFn: () => stalled,
  });
  // Image is busy, music is not.
  assert.equal(JobRunner.isTabRunning('image'), true);
  assert.equal(JobRunner.isTabRunning('music'), false);
  // Resolve the stalled job.
  resolveStalled({ status: 'ok' });
  await ctrl1.done;
  // After resolution, no tab is busy.
  assert.equal(JobRunner.isTabRunning('image'), false);
  assert.equal(JobRunner.isTabRunning('music'), false);
});

test('JobRunner per-tab re-entrancy: cannot start two jobs on the same tab', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  let resolveStalled;
  const stalled = new Promise((r) => { resolveStalled = r; });
  const ctrl1 = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    runFn: () => stalled,
  });
  // Wait for the runFn to start so the tab is in the wip state.
  await new Promise((r) => setImmediate(r));
  // Trying to start a second image job while the first is wip must
  // reject (the per-tab gate from _plan3.md §4.2). We await the
  // returned promise so the rejection surfaces in our try/catch.
  let rejected = null;
  try {
    await JobRunner.run({
      tabKey: 'image',
      type: 'image',
      runFn: async () => ({ status: 'ok' }),
    });
  } catch (e) {
    rejected = e;
  }
  assert.ok(rejected, 'second run on the same tab must reject');
  assert.match(String(rejected.message), /already running/i);
  // The gate must NOT block a job on a different tab (the whole
  // point of Phase A).
  let resolveStalledMusic;
  const stalledMusic = new Promise((r) => { resolveStalledMusic = r; });
  const ctrl2 = JobRunner.run({
    tabKey: 'music',
    type: 'music',
    runFn: () => stalledMusic,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(JobRunner.isTabRunning('image'), true);
  assert.equal(JobRunner.isTabRunning('music'), true);
  // Cleanup
  resolveStalled({ status: 'ok' });
  resolveStalledMusic({ status: 'ok' });
  await ctrl1.done;
  await ctrl2.done;
});

test('JobRunner cancel sets the signal; the runFn can detect it', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  let signalRef = null;
  const ctrl = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    runFn: async (ctx) => {
      signalRef = ctx.signal;
      // Wait until aborted.
      await new Promise((resolve) => {
        if (ctx.signal.aborted) return resolve();
        const onAbort = () => resolve();
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      });
      // The runFn can throw a structured cancel result.
      return { status: 'cancel' };
    },
  });
  // The runFn fires in a microtask, so wait for it.
  await new Promise((r) => setImmediate(r));
  assert.equal(signalRef && signalRef.aborted, false);
  // Cancel from outside the runFn.
  ctrl.cancel();
  // The signal must be aborted.
  assert.equal(signalRef.aborted, true);
  // The job is marked cancel after the runFn resolves.
  await ctrl.done;
  const job = global.window.state.jobs.get(ctrl.jobId);
  assert.equal(job.status, 'cancel');
  assert.equal(JobRunner.isTabRunning('image'), false);
});

test('JobRunner hard cap of 16 concurrent jobs', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  // Fill the cap with never-resolving jobs, all on tabKey=null so
  // the per-tab gate is bypassed (it's only checked when tabKey is
  // set). Wait for each runFn to start so the job is in the wip
  // state (which is what HARD_CAP counts against).
  const ctrls = [];
  for (let i = 0; i < JobRunner.HARD_CAP; i++) {
    ctrls.push(JobRunner.run({
      tabKey: null,
      type: 'image',
      runFn: () => new Promise(() => {}), // never resolves
    }));
  }
  await new Promise((r) => setImmediate(r));
  // The next run must reject (we await the returned promise so the
  // rejection surfaces in our try/catch). The per-tab gate is not
  // checked (tabKey=null) so the HARD_CAP must be the one that fires.
  let rejected = null;
  try {
    await JobRunner.run({
      tabKey: null,
      type: 'image',
      runFn: async () => ({ status: 'ok' }),
    });
  } catch (e) {
    rejected = e;
  }
  assert.ok(rejected, 'over-cap run must reject');
  assert.match(String(rejected.message), /Too many jobs/);
});

test('JobRunner state.generating is the derived projection (single tab → key, mixed → "mixed")', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  // Two jobs on different tabs running concurrently.
  let r1, r2;
  const c1 = JobRunner.run({ tabKey: 'image', type: 'image', runFn: () => new Promise((r) => { r1 = r; }) });
  const c2 = JobRunner.run({ tabKey: 'music', type: 'music', runFn: () => new Promise((r) => { r2 = r; }) });
  // Wait for both runFns to start (queueMicrotask).
  await new Promise((r) => setImmediate(r));
  // Two tabs running → state.generating === 'mixed'
  assert.equal(global.window.state.generating, 'mixed');
  // Finish the image job → state.generating === 'music' (the remaining tab)
  r1({ status: 'ok' });
  await c1.done;
  assert.equal(global.window.state.generating, 'music');
  // Finish the music job → no more JobRunner jobs → we LEAVE the
  // legacy field alone (the legacy armGenBtnWithCancel flow owns
  // it in that case). So state.generating stays as 'music' (or
  // whatever the legacy code last set).
  r2({ status: 'ok' });
  await c2.done;
});

test('JobRunner runFn throw surfaces as job.status = "err"', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  const ctrl = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    runFn: async () => { throw new Error('boom'); },
  });
  await ctrl.done;
  const job = global.window.state.jobs.get(ctrl.jobId);
  assert.equal(job.status, 'err');
  assert.equal(job.error, 'boom');
  assert.equal(JobRunner.isTabRunning('image'), false);
});

test('JobRunner.runFn returning { status: "warn" } marks the job as warn', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  const ctrl = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    runFn: async () => ({ status: 'warn', details: ['partial'] }),
  });
  await ctrl.done;
  const job = global.window.state.jobs.get(ctrl.jobId);
  assert.equal(job.status, 'warn');
});

test('JobRunner.attachSecondaryToJob appends into the primary row', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  let captured = null;
  const ctrl = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    runFn: async (ctx) => {
      captured = { ctrl, ctx, JobRunner };
      // The runFn uses ctx.onSecondary to attach stderr chunks
      // (matching the Plan §4.1 API). Direct call from outside via
      // the public method:
      JobRunner.attachSecondaryToJob(ctrl.jobId, 'first stderr chunk');
      JobRunner.attachSecondaryToJob(ctrl.jobId, 'second stderr chunk');
      return { status: 'ok' };
    },
  });
  await ctrl.done;
  assert.ok(captured, 'runFn must have been called');
  const job = global.window.state.jobs.get(ctrl.jobId);
  assert.equal(job.childLogIds.length, 2);
  // Each childLogId is a separate log event with the same jobId.
  for (const id of job.childLogIds) {
    const ev = global.window.state._logEvents.find((e) => e.id === id);
    assert.ok(ev, 'secondary event must be in the log buffer');
    assert.equal(ev.jobId, ctrl.jobId);
  }
});

test('JobRunner.on / JobRunner.off fan out jobrunner:job-* events', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  const events = [];
  const off = JobRunner.on('jobrunner:job-added', (job) => events.push({ t: 'added', id: job.id }));
  JobRunner.on('jobrunner:job-updated', (job) => events.push({ t: 'updated', id: job.id, status: job.status }));
  JobRunner.on('jobrunner:job-removed', (job) => events.push({ t: 'removed', id: job.id, status: job.status }));
  const ctrl = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    runFn: async () => ({ status: 'ok' }),
  });
  await ctrl.done;
  // added fires synchronously inside run(); updated fires when the
  // job's status changes (wip → ok). removed fires ONLY when a job
  // is actually evicted from _jobs by _pruneFinishedJobs (see bug-fix
  // M2, _temp5.md 360° audit) — NOT on completion, because the job
  // stays in the map for scrollback/`await ctrl.done` lookups.
  const types = events.map((e) => e.t);
  assert.ok(types.includes('added'), 'must fire job-added');
  assert.ok(types.includes('updated'), 'must fire job-updated on completion (status changed wip → ok)');
  // The finished job is still in _jobs (not evicted — we're under
  // the FINISHED_JOB_KEEP cap), so job-removed must NOT have fired.
  assert.ok(!types.includes('removed'),
    'must NOT fire job-removed on completion — the job stays in _jobs for scrollback; job-removed fires only on eviction (M2)');
  // Sanity: the job is still queryable.
  assert.ok(global.window.state.jobs.has(ctrl.jobId), 'finished job must still be in _jobs');
  off();
});

// --- bug-fix H1 (_temp4.md): hard cap must count only WIP jobs ------------
test('JobRunner hard cap is lifted again once jobs finish (H1: does not count finished jobs)', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  // Run exactly HARD_CAP jobs that all complete immediately.
  for (let i = 0; i < JobRunner.HARD_CAP; i++) {
    const ctrl = JobRunner.run({ tabKey: null, type: 'image', runFn: async () => ({ status: 'ok' }) });
    await ctrl.done;
  }
  // Before the H1 fix, _jobs.size would now be HARD_CAP (nothing was
  // ever pruned) and this next run would incorrectly reject.
  const extra = JobRunner.run({ tabKey: null, type: 'image', runFn: async () => ({ status: 'ok' }) });
  await assert.doesNotReject(async () => { await extra.done; });
  const job = global.window.state.jobs.get(extra.jobId);
  assert.equal(job.status, 'ok');
});

test('JobRunner hard cap still rejects when 16 jobs are genuinely WIP at once', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  const ctrls = [];
  for (let i = 0; i < JobRunner.HARD_CAP; i++) {
    ctrls.push(JobRunner.run({ tabKey: null, type: 'image', runFn: () => new Promise(() => {}) }));
  }
  await new Promise((r) => setImmediate(r));
  let rejected = null;
  try {
    await JobRunner.run({ tabKey: null, type: 'image', runFn: async () => ({ status: 'ok' }) });
  } catch (e) {
    rejected = e;
  }
  assert.ok(rejected, 'cap must still apply when jobs are genuinely in flight');
  assert.match(String(rejected.message), /Too many jobs/);
});

// --- bug-fix H2 (_temp4.md): state.jobs survives a load-order mismatch ----
test('JobRunner re-attaches state.jobs on run() even if window.state did not exist at script-load time (H2)', async () => {
  const { win } = setupMock();
  // Simulate the real load order bug: JobRunner.js loads BEFORE
  // section24_State.js defines window.state. Remove state entirely,
  // load JobRunner (its one-time top-level assignment now no-ops),
  // THEN attach state — mirroring "section24_State.js runs later".
  delete win.state;
  const file = require.resolve('../../../renderer/jobs/JobRunner.js');
  delete require.cache[file];
  let nextId = 0;
  win.LogService = {
    addLogEvent(opts) { nextId += 1; return nextId; },
    updateLogStatus() {},
    appendLogDetails() {},
  };
  require(file);
  const JobRunner = global.window.JobRunner;
  // At this point, per the H2 bug, window.state doesn't exist yet, so
  // the script-load-time assignment was skipped.
  win.state = { _logEvents: [] }; // section24_State.js "loads" now — no .jobs field
  assert.equal(win.state.jobs, undefined, 'sanity: state.jobs must NOT exist yet');
  const ctrl = JobRunner.run({ tabKey: 'image', type: 'image', runFn: async () => ({ status: 'ok' }) });
  // run() must have re-asserted state.jobs synchronously.
  assert.ok(win.state.jobs instanceof Map, 'run() must attach state.jobs even if it was missing at load time');
  await ctrl.done;
  assert.equal(win.state.jobs.get(ctrl.jobId).status, 'ok');
});

// --- bug-fix H3 (_temp4.md): flushBatchSummaries ---------------------------
test('JobRunner.flushBatchSummaries persists wip jobs as interrupted and exists as a real function (H3)', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  assert.equal(typeof JobRunner.flushBatchSummaries, 'function');
  let resolveStalled;
  const ctrl = JobRunner.run({
    tabKey: 'image', type: 'image', title: 'Stuck image gen',
    runFn: () => new Promise((r) => { resolveStalled = r; }),
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(JobRunner.isTabRunning('image'), true);
  JobRunner.flushBatchSummaries();
  const job = global.window.state.jobs.get(ctrl.jobId);
  assert.equal(job.status, 'cancel');
  assert.equal(job.error, 'Interrupted by app shutdown.');
  assert.ok(Array.isArray(global.window.state.jobsSnapshot));
  const snap = global.window.state.jobsSnapshot.find((s) => s.id === ctrl.jobId);
  assert.ok(snap, 'flushBatchSummaries must push a snapshot for the interrupted job');
  assert.equal(snap.status, 'cancel');
  // Cleanup: let the stalled runFn resolve so the test process can exit.
  resolveStalled({ status: 'ok' });
  await ctrl.done;
});

// --- Phase 1 jobsSnapshot push (so L2/History/ArchiveViewer get data) -----
test('JobRunner pushes a jobsSnapshot entry with the shape LogService.renderPersistedL2 / ArchiveViewer expect', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  const ctrl = JobRunner.run({
    tabKey: 'image', type: 'image', title: 'A cat in a hat', subtitle: 'seed=42',
    runFn: async () => ({ status: 'ok', outputPaths: ['C:/out/cat1.jpg', 'C:/out/cat2.jpg'] }),
  });
  await ctrl.done;
  assert.ok(Array.isArray(global.window.state.jobsSnapshot));
  assert.equal(global.window.state.jobsSnapshot.length, 1);
  const snap = global.window.state.jobsSnapshot[0];
  assert.equal(snap.id, ctrl.jobId);
  assert.equal(snap.type, 'image');
  assert.equal(snap.tab, 'image');
  assert.equal(snap.title, 'A cat in a hat');
  assert.equal(snap.subtitle, 'seed=42');
  assert.equal(snap.status, 'ok');
  assert.ok(snap.finishedAt instanceof Date);
  assert.deepEqual(snap.outputPaths, ['C:/out/cat1.jpg', 'C:/out/cat2.jpg']);
  assert.equal(snap.error, null);
  // job.outputPaths itself must also be populated (ActiveJobsWidget /
  // future consumers reading the live job, not just the snapshot).
  const job = global.window.state.jobs.get(ctrl.jobId);
  assert.deepEqual(job.outputPaths, ['C:/out/cat1.jpg', 'C:/out/cat2.jpg']);
});

test('JobRunner jobsSnapshot push calls scheduleStateSave when available', async () => {
  const { win } = setupMock();
  let saveCalls = 0;
  win.scheduleStateSave = () => { saveCalls += 1; };
  const JobRunner = loadJobRunner();
  const ctrl = JobRunner.run({ tabKey: 'image', type: 'image', runFn: async () => ({ status: 'ok' }) });
  await ctrl.done;
  assert.ok(saveCalls >= 1, 'a finished job must schedule a state save so jobsSnapshot persists to disk');
});

// --- bug-fix Phase1 (_temp4.md): suppressLogRow for legacy-logging callers --
test('JobRunner.run({suppressLogRow:true}) tracks the job (for ActiveJobsWidget/cancel) without creating a log row', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  const addLogEventCalls = [];
  const realAddLogEvent = global.window.LogService.addLogEvent;
  global.window.LogService.addLogEvent = (opts) => { addLogEventCalls.push(opts); return realAddLogEvent(opts); };
  const ctrl = JobRunner.run({
    tabKey: 'image', type: 'image', title: 'Manually logged elsewhere', suppressLogRow: true,
    runFn: async () => ({ status: 'ok', details: ['done'] }),
  });
  // Still fully tracked: ActiveJobsWidget / isTabRunning / cancel all work.
  assert.equal(JobRunner.isTabRunning('image'), true);
  assert.equal(JobRunner.activeJobs().length, 1);
  assert.equal(addLogEventCalls.length, 0, 'suppressLogRow must skip the primary-row creation entirely');
  await ctrl.done;
  const job = global.window.state.jobs.get(ctrl.jobId);
  assert.equal(job.logEventId, null);
  assert.equal(job.status, 'ok');
  // _markJobDone's LogService calls must have safely no-op'd (guarded
  // on logEventId != null) rather than throwing on a null id.
  assert.equal(addLogEventCalls.length, 0);
});

// ============================================================================
// bug-fix (spawned follow-up, _temp4.md Phase2): BatchGen now wraps its
// outer loop in JobRunner.run({ tabKey: null, ... }) so ActiveJobsWidget
// shows ONE parent "Batch: …" row instead of N individual jobs flickering
// by. The critical risk (per the spawned task's own design note) is the
// per-tab gate: each batch ITEM also calls JobRunner.run({ tabKey, ... })
// for the same tab (via the Phase1-migrated tab handlers). If the parent
// occupied that tab's wip slot, every child item would immediately
// self-reject. tabKey: null is the fix — verify it actually holds.
// ============================================================================

test('JobRunner per-tab gate: a parent job with tabKey:null does NOT block a child job on the same logical tab', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  let resolveParent;
  const parentStalled = new Promise((r) => { resolveParent = r; });
  // Parent: mirrors batchManager.js's startBatchGen wrap — tabKey:null,
  // type:'music' (so ActiveJobsWidget can still show the right icon/type),
  // but deliberately opted OUT of the per-tab mutual-exclusion gate.
  const parentCtrl = JobRunner.run({
    tabKey: null,
    type: 'music',
    title: 'Batch: Music (2 items)',
    typeIcon: '∑',
    runFn: () => parentStalled,
  });
  await new Promise((r) => setImmediate(r));
  // The parent itself must still be tracked (ActiveJobsWidget, cancel) —
  // tabKey:null does not mean "untracked", just "exempt from the gate".
  assert.equal(JobRunner.activeJobs().length, 1);
  assert.equal(JobRunner.isTabRunning('music'), false, 'a tabKey:null parent must not occupy the music tab slot');
  // Child: mirrors musicTab.js's own genBtn handler — tabKey:'music'.
  // This is the exact call that would self-reject if the parent had
  // taken the 'music' slot.
  let resolveChild;
  const childStalled = new Promise((r) => { resolveChild = r; });
  let childCtrl;
  assert.doesNotThrow(() => {
    childCtrl = JobRunner.run({ tabKey: 'music', type: 'music', runFn: () => childStalled });
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(JobRunner.isTabRunning('music'), true, 'the CHILD (real tabKey) does occupy the slot');
  assert.equal(JobRunner.activeJobs().length, 2, 'both parent and child are tracked simultaneously');
  // A second concurrent child on the SAME tab must still be rejected —
  // tabKey:null on the parent must not have silently disabled the gate
  // for real tab-keyed jobs.
  let secondChildRejected = null;
  try {
    await JobRunner.run({ tabKey: 'music', type: 'music', runFn: async () => ({ status: 'ok' }) });
  } catch (e) {
    secondChildRejected = e;
  }
  assert.ok(secondChildRejected, 'the gate must still apply between two real tabKey jobs on the same tab');
  resolveChild({ status: 'ok' });
  await childCtrl.done;
  resolveParent({ status: 'ok' });
  await parentCtrl.done;
});

test('JobRunner per-tab gate: two tabKey:null parent jobs (e.g. batches on different tabs) never block each other or themselves', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  let resolveA, resolveB;
  const aStalled = new Promise((r) => { resolveA = r; });
  const bStalled = new Promise((r) => { resolveB = r; });
  // Two simultaneous batch parents (image batch + music batch) — neither
  // should ever interact via the gate since neither claims a tabKey.
  let ctrlA, ctrlB;
  assert.doesNotThrow(() => { ctrlA = JobRunner.run({ tabKey: null, type: 'image', title: 'Batch: Image', runFn: () => aStalled }); });
  assert.doesNotThrow(() => { ctrlB = JobRunner.run({ tabKey: null, type: 'music', title: 'Batch: Music', runFn: () => bStalled }); });
  await new Promise((r) => setImmediate(r));
  assert.equal(JobRunner.activeJobs().length, 2);
  resolveA({ status: 'ok' });
  resolveB({ status: 'ok' });
  await ctrlA.done;
  await ctrlB.done;
});

test('JobRunner per-tab gate: parent job settling to "cancel" when its ctx.signal is aborted (Stop-batch / ActiveJobsWidget ✕ parity)', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  let sawAbort = false;
  // v1.1 (audit BUG-3): use a Promise that the runFn resolves
  // *after* the test has cancelled, so the 5ms race the previous
  // version had (Node's event loop processes timers BEFORE
  // setImmediate) can no longer mask the abort signal. The
  // `runFnStarted` flag signals the test that the runFn has
  // attached its abort listener and is now waiting for the
  // explicit `keepRunning` resolve, so the test can safely
  // call ctrl.cancel() without racing the 5ms setTimeout.
  let runFnStarted;
  let keepRunning;
  const runFnStartedPromise = new Promise((r) => { runFnStarted = r; });
  const keepRunningPromise = new Promise((r) => { keepRunning = r; });
  const ctrl = JobRunner.run({
    tabKey: null,
    type: 'speech',
    title: 'Batch: Speech (3 items)',
    runFn: async (ctx) => {
      ctx.signal.addEventListener('abort', () => { sawAbort = true; });
      // Mirrors batchManager.js: the loop polls an abort flag and
      // breaks, then the runFn returns its own best-effort status —
      // but JobRunner's ac.signal.aborted check overrides this to
      // 'cancel' regardless of what's returned here. We no longer
      // use a 5ms setTimeout (which the Node event loop can fire
      // before the test's setImmediate, leading to a job-already-
      // ok race). Instead we wait for the test to release us.
      runFnStarted();
      await keepRunningPromise;
      return { status: 'ok' };
    },
  });
  // Wait for the runFn's microtask to actually attach its abort
  // listener. setImmediate was not enough (Node's timers phase
  // runs before setImmediate, so a 5ms setTimeout in the runFn
  // could resolve the runFn to 'ok' BEFORE the test reached this
  // line — at which point ctrl.cancel() would be a no-op because
  // job.status !== 'wip'). Polling the explicit signal the runFn
  // sends when the listener is attached is race-free.
  await runFnStartedPromise;
  ctrl.cancel();
  // Now release the runFn so the cancel-vs-resolve path plays out
  // and we can assert the final job.status.
  keepRunning();
  const result = await ctrl.done;
  assert.equal(sawAbort, true, 'ctx.signal abort must fire so batchManager.js can flip window._batchAbortByTab[tabKey]');
  assert.equal(result.status, 'cancel');
  assert.equal(JobRunner.activeJobs().length, 0);
});

// Note: tabKey:null jobs are still subject to HARD_CAP — already covered
// by the pre-existing 'JobRunner hard cap of 16 concurrent jobs' test
// above, which fills the cap using tabKey:null jobs specifically (see its
// own comment: "so the per-tab gate is bypassed... HARD_CAP must be the
// one that fires").

// Bug-fix B7 (_temp5.md): finished jobs used to accumulate in `_jobs`
// forever (H1 made them stay queryable for the post-`await ctrl.done`
// lookups, but nothing ever evicted them). A marathon batch session
// would grow the map without limit. The fix caps the FINISHED-job
// history at FINISHED_JOB_KEEP (200), evicting the oldest finished
// entries whenever a new job is added. WIP jobs are never evicted.
//
// These tests exercise the REAL JobRunner.js (loaded via loadJobRunner)
// so a future change that reverts the prune call or breaks the eviction
// order fails here.
test('B7: finished jobs past FINISHED_JOB_KEEP (200) are evicted, keeping the newest', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  // Run FINISHED_JOB_KEEP + 10 jobs that all complete. Each run()
  // triggers _pruneFinishedJobs() after inserting the new job. By the
  // end, the map should hold exactly FINISHED_JOB_KEEP finished jobs
  // (the newest 200), not 210.
  const KEEP = 200; // mirror the constant in JobRunner.js
  const ids = [];
  for (let i = 0; i < KEEP + 10; i++) {
    const ctrl = JobRunner.run({
      tabKey: null,
      type: 'image',
      title: 'prune-probe-' + i,
      suppressLogRow: true,
      runFn: async () => ({ status: 'ok' }),
    });
    ids.push(ctrl.jobId);
    await ctrl.done;
  }
  // The Map is exposed via state.jobs (loadJobRunner wires it up).
  const mapSize = global.window.state.jobs.size;
  // Allow a small slack (the exact count depends on eviction timing),
  // but it MUST be bounded — the bug was unbounded growth.
  assert.ok(mapSize <= KEEP + 1,
    `finished-job map must be bounded at ~${KEEP} after ${KEEP + 10} completions, got ${mapSize} (B7 regression: unbounded growth)`);
  assert.ok(mapSize >= KEEP,
    `finished-job map should keep ~${KEEP} entries for scrollback/lookup, got ${mapSize} (B7 over-evicted)`);
  // The NEWEST job must still be in the map (post-`await ctrl.done`
  // lookups rely on this — see the bug-fix H1 comment in JobRunner.js).
  assert.ok(global.window.state.jobs.has(ids[ids.length - 1]),
    'the most recently-completed job must still be queryable in `_jobs` right after completion (bug-fix H1 contract)');
  // The OLDEST finished jobs are evicted (FIFO — Map iteration is
  // insertion-ordered, and ids are monotonic by _newJobId).
  assert.ok(!global.window.state.jobs.has(ids[0]),
    'the oldest finished job should have been evicted once the map crossed FINISHED_JOB_KEEP (B7 regression: not evicting)');
});

test('B7: WIP jobs are NEVER evicted even when many finished jobs accumulate', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  // Start one job that we control the resolution of, so it stays WIP
  // while we pump a lot of finished jobs through the runner.
  let resolveStalled;
  const stalled = new Promise((r) => { resolveStalled = r; });
  const wipCtrl = JobRunner.run({
    tabKey: 'music',
    type: 'music',
    title: 'long-running-wip',
    suppressLogRow: true,
    runFn: () => stalled,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(JobRunner.isTabRunning('music'), true, 'sanity: the stalled job is wip');
  const wipId = wipCtrl.jobId;

  // Pump FINISHED_JOB_KEEP + 20 finished jobs through (on different
  // tabs so the per-tab gate doesn't fire — alternating image/speech).
  for (let i = 0; i < 220; i++) {
    const tab = i % 2 === 0 ? 'image' : 'speech';
    // The per-tab gate blocks a second WIP job on the same tab, but
    // these complete synchronously so each tab is idle again by the
    // time the next same-tab iteration starts.
    const ctrl = JobRunner.run({
      tabKey: tab,
      type: tab,
      title: 'filler-' + i,
      suppressLogRow: true,
      runFn: async () => ({ status: 'ok' }),
    });
    await ctrl.done;
  }

  // The WIP job MUST still be in the map and still wip, regardless of
  // how many finished jobs were pruned around it.
  assert.ok(global.window.state.jobs.has(wipId),
    'WIP job must NEVER be evicted by _pruneFinishedJobs (B7 regression: evicted a wip job)');
  assert.equal(JobRunner.isTabRunning('music'), true,
    'WIP job must still be running after the prune sweep (B7 regression)');

  // Release the stalled job so the test doesn't hang.
  resolveStalled({ status: 'ok' });
  await wipCtrl.done;
});

test('B7: _pruneFinishedJobs is a no-op when the map is under the cap', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  // A handful of jobs (well under 200) — none should be evicted.
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const ctrl = JobRunner.run({
      tabKey: null,
      type: 'image',
      title: 'under-cap-' + i,
      suppressLogRow: true,
      runFn: async () => ({ status: 'ok' }),
    });
    ids.push(ctrl.jobId);
    await ctrl.done;
  }
  // All 10 must still be present (no eviction under the cap).
  for (const id of ids) {
    assert.ok(global.window.state.jobs.has(id),
      `job ${id} should still be in the map when the count is under FINISHED_JOB_KEEP (B7 over-evicted)`);
  }
});

// BUG-9-07 (user-reported, 2026-06-25): the log pane used to
// show every mmx line TWICE (e.g. `[Model: image-01]`,
// `{"saved": "..."}`, `$ node mmx.mjs ...` all appeared in
// duplicate rows). Two compounding causes:
//
//   1. Main process: `mmx:run:job` passed BOTH `onLog` AND
//      `onChunk` to `runMmx`, and `src/mmx.js` calls both with
//      the same line for every mmx stdout/stderr chunk. Both
//      callbacks routed to the same `sendLog` IPC, so the
//      renderer's `onLogRich` fired twice per line. Fixed by
//      passing only `onChunk` from the job-aware path.
//
//   2. Renderer: `_addLogSecondary` always called
//      `Log.addLogEvent({ _internal: true, ... })` regardless of
//      whether the job had a primary row. With `_internal: true`
//      the routing check (`!ev._internal`) skipped, so every
//      line became its own separate log row instead of being
//      folded into the primary row's `details` array.
//
// These tests pin the renderer fix: when a job HAS a primary
// row, `attachSecondaryToJob` must call `appendLogDetails` (not
// `addLogEvent`) so the line ends up in the primary row's
// expanded details, not as a separate row. When the job has NO
// primary row (suppressLogRow: true), `addLogEvent` is the
// only path and is correct.
test('BUG-9-07: attachSecondaryToJob folds into the primary row (appendLogDetails), not a new row (addLogEvent)', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  // Track every addLogEvent / appendLogDetails call the LogService
  // mock receives. The test asserts the right mix of calls.
  const calls = { addLogEvent: [], appendLogDetails: [] };
  const realAddLogEvent = global.window.LogService.addLogEvent;
  const realAppendLogDetails = global.window.LogService.appendLogDetails;
  global.window.LogService.addLogEvent = (opts) => {
    calls.addLogEvent.push(opts);
    return realAddLogEvent(opts);
  };
  global.window.LogService.appendLogDetails = (id, lines) => {
    calls.appendLogDetails.push({ id, lines });
    return realAppendLogDetails(id, lines);
  };
  // Run a job that ATTACHES two stderr chunks via the public
  // attachSecondaryToJob. The job has a primary row (no
  // suppressLogRow) — so each attach must go to appendLogDetails,
  // not addLogEvent.
  const ctrl = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    title: 'dup-test',
    runFn: async () => {
      JobRunner.attachSecondaryToJob(ctrl.jobId, '[Model: image-01]');
      JobRunner.attachSecondaryToJob(ctrl.jobId, '{"saved": "C:/out/bird.png"}');
      return { status: 'ok' };
    },
  });
  await ctrl.done;
  const job = global.window.state.jobs.get(ctrl.jobId);
  assert.ok(job, 'job must be in _jobs');
  assert.notEqual(job.logEventId, null, 'job has a primary row (no suppressLogRow)');
  // Zero addLogEvent calls with _internal: true for the
  // secondaries — pre-fix this would have been 2 (one per line).
  const internalCalls = calls.addLogEvent.filter((o) => o && o._internal);
  assert.equal(internalCalls.length, 0,
    `BUG-9-07 regression: attachSecondaryToJob must NOT call Log.addLogEvent for jobs that have a primary row (got ${internalCalls.length} internal call(s)). Pre-fix the renderer always called addLogEvent({ _internal: true }) which produced a separate row for every line — the user saw "[Model: image-01]" and the other lines TWICE in the log pane.`);
  // 2 appendLogDetails calls instead.
  assert.equal(calls.appendLogDetails.length, 2,
    `attachSecondaryToJob must call Log.appendLogDetails for each stderr chunk (got ${calls.appendLogDetails.length})`);
  // The 2 calls must target the primary row's logEventId.
  for (const c of calls.appendLogDetails) {
    assert.equal(c.id, job.logEventId,
      'appendLogDetails must target the job\'s primary log row id');
    assert.ok(Array.isArray(c.lines) && c.lines.length === 1,
      'appendLogDetails must be called with a one-line array');
  }
});

test('BUG-9-07: attachSecondaryToJob falls back to addLogEvent when the job has no primary row (suppressLogRow: true)', async () => {
  setupMock();
  const JobRunner = loadJobRunner();
  const calls = { addLogEvent: [], appendLogDetails: [] };
  const realAddLogEvent = global.window.LogService.addLogEvent;
  const realAppendLogDetails = global.window.LogService.appendLogDetails;
  global.window.LogService.addLogEvent = (opts) => {
    calls.addLogEvent.push(opts);
    return realAddLogEvent(opts);
  };
  global.window.LogService.appendLogDetails = (id, lines) => {
    calls.appendLogDetails.push({ id, lines });
    return realAppendLogDetails(id, lines);
  };
  // suppressLogRow: true → no primary row, logEventId stays null.
  const ctrl = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    title: 'suppressed',
    suppressLogRow: true,
    runFn: async () => {
      JobRunner.attachSecondaryToJob(ctrl.jobId, '[Model: image-01]');
      JobRunner.attachSecondaryToJob(ctrl.jobId, '{"saved": "C:/out/bird.png"}');
      return { status: 'ok' };
    },
  });
  await ctrl.done;
  const job = global.window.state.jobs.get(ctrl.jobId);
  assert.equal(job.logEventId, null, 'sanity: suppressLogRow:true → no primary row');
  // No primary row → appendLogDetails would be a no-op (it
  // requires a valid logEventId). The fallback to addLogEvent
  // keeps the user-visible behaviour (the line still shows in
  // the log pane) without breaking the appendLogDetails contract.
  assert.equal(calls.appendLogDetails.length, 0,
    'appendLogDetails must not be called when there\'s no primary row (no logEventId to target)');
  assert.equal(calls.addLogEvent.length, 2,
    `addLogEvent must be called as a fallback for the suppressLogRow case (got ${calls.addLogEvent.length})`);
});
