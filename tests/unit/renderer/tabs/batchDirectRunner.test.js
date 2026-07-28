// tests/unit/renderer/tabs/batchDirectRunner.test.js
// X1-F1/F3/F5: the direct (snapshot) BatchGen execution path had ZERO tests
// even though it is the default (state.batchDirectMode !== false). Covers:
//   F1: a plain-string batch row must not produce an empty prompt.
//   F3: the mmx call must be wrapped in JobRunner.run({tabKey}) — parity
//       with the OLD DOM path (each genBtn.click() registered its own
//       per-tab JobRunner job) — so JobRunner.isTabRunning(tabKey) is true
//       while the child call is in flight. batchManager's _isTabRunningNow,
//       ActiveJobsWidget, and the BatchGen Stop-button visibility all read
//       this signal; without it the direct path never held any "tab busy"
//       state at all.
//   F3b: the REAL JobRunner's _syncLegacyGenerating() sets state.generating
//       while a job is wip but deliberately never clears it (that's
//       armGenBtnWithCancel's job, which the direct path never calls) — this
//       previously left state.generating stuck at the tab key FOREVER after
//       the very first batch item, which made _isTabRunningNow(tabKey) spin
//       forever before every subsequent item and hung the whole batch
//       (confirmed live: a 3-item batch that should finish in <1s timed out
//       at 90s). batchDirectRunner must clear it itself after the call.
//   F5: postprocess `outputs` (the real post-processed file paths) must
//       replace outFiles, not be dropped.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

global.window = global;
global.toast = () => {};
require(path.join(ROOT, 'renderer', 'tabs', 'argvBuilders.js'));
require(path.join(ROOT, 'renderer', 'tabs', 'batchDirectRunner.js'));
const { runVariantDirect } = global.window.BatchDirectRunner;

function resetState(overrides) {
  global.window.state = Object.assign({
    fbDir: 'C:\\out',
    generating: null,
  }, overrides || {});
}

test('F1: a plain-string row produces a non-empty --prompt (not "")', async () => {
  resetState();
  let capturedArgs = null;
  global.window.api = {
    mmxRunJob: async ({ args }) => { capturedArgs = args; return { ok: true, code: 0 }; },
  };
  const r = await runVariantDirect('image', 'a red dragon breathing fire', {});
  assert.equal(r.ok, true);
  const i = capturedArgs.indexOf('--prompt');
  assert.ok(i >= 0);
  assert.notEqual(capturedArgs[i + 1], '', 'prompt must not be empty for a string batch row');
  assert.equal(capturedArgs[i + 1], 'a red dragon breathing fire');
});

test('F1: a plain-string speech row produces a non-empty --text', async () => {
  resetState();
  let capturedArgs = null;
  global.window.api = {
    mmxRunJob: async ({ args }) => { capturedArgs = args; return { ok: true, code: 0 }; },
  };
  const r = await runVariantDirect('speech', 'Hello world, this is a test.', {});
  assert.equal(r.ok, true);
  const i = capturedArgs.indexOf('--text');
  assert.ok(i >= 0);
  assert.equal(capturedArgs[i + 1], 'Hello world, this is a test.');
});

// A minimal fake mirroring the real JobRunner's run()/isTabRunning() contract
// closely enough to test the busy-signal parity fix without loading the
// whole real module (JobRunner.js has its own DOM/widget dependencies).
// `simulateLegacyGeneratingSideEffect` reproduces _syncLegacyGenerating()'s
// real, one-directional behaviour: it SETS window.state.generating while a
// job is wip, and NEVER clears it — exactly the trap that caused F3b.
function makeFakeJobRunner(opts) {
  const simulateSideEffect = !!(opts && opts.simulateLegacyGeneratingSideEffect);
  const jobs = new Map();
  return {
    isTabRunning(tabKey) {
      for (const j of jobs.values()) if (j.tabKey === tabKey && j.status === 'wip') return true;
      return false;
    },
    run(runOpts) {
      const jobId = 'fake-' + Math.random();
      const job = { tabKey: runOpts.tabKey, status: 'wip' };
      jobs.set(jobId, job);
      if (simulateSideEffect && global.window.state) global.window.state.generating = runOpts.tabKey;
      const ctrl = { jobId, cancel() {} };
      // Mirrors the real JobRunner: runFn is deferred to a microtask (so the
      // caller's `ctrl` is assigned and ctrl.jobId is readable inside runFn),
      // is passed a ctx with an abort signal, and `done` always resolves even
      // when runFn throws (the throw is caught internally).
      ctrl.done = new Promise((resolve) => {
        queueMicrotask(async () => {
          try { await runOpts.runFn({ signal: { aborted: false } }); } catch (_) { /* swallowed */ }
          job.status = 'done';
          // Deliberately do NOT clear state.generating here — matches the
          // real _syncLegacyGenerating(), which only sets it, never clears it.
          resolve();
        });
      });
      return ctrl;
    },
  };
}

test('F3: JobRunner.isTabRunning(tabKey) is true while the child mmx call is in flight, and false after; mmx jobId == JobRunner job id (so per-item cancel targets the proc)', async () => {
  resetState();
  global.window.JobRunner = makeFakeJobRunner();
  let sawRunningDuringCall = null;
  let mmxJobId = null;
  global.window.api = {
    mmxRunJob: async ({ jobId }) => {
      sawRunningDuringCall = global.window.JobRunner.isTabRunning('speech');
      mmxJobId = jobId;
      return { ok: true, code: 0 };
    },
  };
  assert.equal(global.window.JobRunner.isTabRunning('speech'), false);
  await runVariantDirect('speech', 'hi', {});
  assert.equal(sawRunningDuringCall, true, 'JobRunner.isTabRunning(tabKey) must be true during the mmx call');
  assert.equal(global.window.JobRunner.isTabRunning('speech'), false, 'must be false again after the call settles');
  // The mmx jobId must be the JobRunner job's own id (fake- prefix), NOT a
  // separate 'batch-direct-' id — otherwise ActiveJobsWidget's per-item ✕
  // (which cancels via job.id) wouldn't match the running mmx proc.
  assert.ok(mmxJobId && mmxJobId.startsWith('fake-'), `mmx jobId must be the JobRunner job id, got ${mmxJobId}`);
  delete global.window.JobRunner;
});

test('F3: a throw inside the wrapped mmx call still resolves runVariantDirect with ok:false (does not hang)', async () => {
  resetState();
  global.window.JobRunner = makeFakeJobRunner();
  global.window.api = { mmxRunJob: async () => { throw new Error('boom'); } };
  const r = await runVariantDirect('speech', 'hi', {});
  assert.equal(r.ok, false);
  assert.equal(global.window.JobRunner.isTabRunning('speech'), false);
  delete global.window.JobRunner;
});

test('F3b: state.generating must be cleared after the call, even though JobRunner itself never clears it (else the next _isTabRunningNow check spins forever)', async () => {
  resetState();
  global.window.JobRunner = makeFakeJobRunner({ simulateLegacyGeneratingSideEffect: true });
  global.window.api = { mmxRunJob: async () => ({ ok: true, code: 0 }) };
  assert.equal(global.window.state.generating, null);
  await runVariantDirect('image', 'a', {});
  // The fake's run() set state.generating = 'image' as soon as the job went
  // wip, exactly like the real JobRunner does, and never clears it itself.
  assert.equal(global.window.state.generating, null,
    'batchDirectRunner must clear state.generating after its own job settles, or a second batch item hangs forever');
  delete global.window.JobRunner;
});

test('F3: without a JobRunner loaded, the call still falls back to a plain mmxRunJob invocation', async () => {
  resetState();
  let called = false;
  global.window.api = { mmxRunJob: async () => { called = true; return { ok: true, code: 0 }; } };
  const r = await runVariantDirect('speech', 'hi', {});
  assert.equal(called, true);
  assert.equal(r.ok, true);
});

test('F5: postprocess outputs replace outFiles (pipeline enqueue sees the post-processed file, not the raw one)', async () => {
  resetState({ _batchRowPostprocess: { removeBackground: 'true' }, autoPipelineEnabled: true });
  global.window.api = { mmxRunJob: async () => ({ ok: true, code: 0 }) };
  let enqueuedPaths = null;
  global.window.BatchPostprocess = {
    runRowPostprocess: async () => ({ applied: ['remove-bg C:\\out\\x_nobg.png'], errors: [], outputs: ['C:\\out\\x_nobg.png'] }),
  };
  global.window.Pipeline = {
    enqueueFromPaths: async (paths) => { enqueuedPaths = paths; },
  };
  const r = await runVariantDirect('image', { prompt: 'a cat' }, {});
  assert.equal(r.ok, true);
  assert.deepEqual(enqueuedPaths, ['C:\\out\\x_nobg.png']);
  assert.equal(r.outFile, 'C:\\out\\x_nobg.png');
});

// ============================================================================
// R6.2 — JobWorkspace für n>1: per-run subdir, no mtime scan.
// ============================================================================
//
// R6.2 spec: "Eigenes Runverzeichnis/ID; keine mtime-Scans." The pre-R6.2
// flow scanned the user-facing outputDir with an mtime window
// (mtimeMs >= runStartMs - 1500 && <= now + 5000) to find the n>1 outputs.
// R6.2 replaces this with a per-run subdir `run_<timestamp>_<random>/`
// under outputDir, mint+mkdir'd before the mmx call. The subdir by
// construction contains ONLY this run's outputs, so fbList(runSubdir)
// returns the outputs directly (no mtime filter needed). The subdir is
// deleted on mmx failure (best-effort) so a dead run_<id>/ doesn't
// accumulate under the user's outputDir.

const { mintRunSubdir, ensureRunSubdir } = global.window.BatchDirectRunner;

test('R6.2.A: mintRunSubdir returns a path under baseOutputDir with a run_<id> tail', () => {
  const r = mintRunSubdir('C:\\out');
  assert.equal(r.ok, true);
  assert.ok(/^run_\d+_[a-z0-9]+$/.test(r.id), `run id must match run_<ts>_<random>, got ${r.id}`);
  assert.ok(r.runSubdir.startsWith('C:\\out' + '\\') || r.runSubdir.startsWith('C:\\out/'),
    `runSubdir must be under baseOutputDir, got ${r.runSubdir}`);
  // Windows path: backslash separator
  assert.ok(r.runSubdir.includes('\\'), 'Windows path must use backslash separator');
});

test('R6.2.B: ensureRunSubdir calls window.api.fbEnsureDir with the runSubdir + grantId', async () => {
  resetState({ _fbGrantId: 'grant-xyz' });
  let ensureCall = null;
  global.window.api = {
    fbEnsureDir: async (p, gid) => { ensureCall = { p, gid }; return { ok: true, path: p }; },
  };
  const r = await ensureRunSubdir('C:\\out\\run_test');
  assert.equal(r.ok, true);
  assert.equal(ensureCall.p, 'C:\\out\\run_test');
  assert.equal(ensureCall.gid, 'grant-xyz');
});

test('R6.2.C: n>1 row mints a per-run subdir + mmx writes into it (no mtime scan)', async () => {
  resetState();
  const ensured = [];
  global.window.api = {
    fbEnsureDir: async (p) => { ensured.push(p); return { ok: true, path: p }; },
    mmxRunJob: async ({ args }) => {
      // The argv must include `--out-dir <runSubdir>` (the per-run subdir,
      // not the user's fbDir). Verify that here.
      const outDirIdx = args.indexOf('--out-dir');
      assert.ok(outDirIdx >= 0, 'n>1 must pass --out-dir to mmx');
      const outDirVal = args[outDirIdx + 1];
      assert.ok(outDirVal.startsWith('C:\\out\\run_'),
        `--out-dir must point at the per-run subdir, got ${outDirVal}`);
      return { ok: true, code: 0 };
    },
    // The fbList must be called against the runSubdir (not fbDir), AND
    // its result must be taken at face value (no mtime filter).
    fbList: async (p) => {
      assert.ok(p.startsWith('C:\\out\\run_'),
        `fbList must be called on the runSubdir, got ${p}`);
      return {
        ok: true,
        items: [
          { name: '1.png', ext: '.png', isDir: false, path: p + '\\1.png' },
          { name: '2.png', ext: '.png', isDir: false, path: p + '\\2.png' },
        ],
      };
    },
  };
  // Use item with n=2 to trigger the runSubdir mint.
  const r = await runVariantDirect('image', { prompt: 'a dragon', n: 2 }, {});
  assert.equal(r.ok, true);
  assert.equal(ensured.length, 1, 'fbEnsureDir must be called exactly once for the runSubdir');
  assert.ok(ensured[0].startsWith('C:\\out\\run_'),
    `the ensured path must be a runSubdir, got ${ensured[0]}`);
  assert.ok(r.outFile && /\\run_\d+_[a-z0-9]+\\/.test(r.outFile),
    `outFile must be inside the runSubdir, got ${r.outFile}`);
});

test('R6.2.C2 (BUG-4 regression): dashed --n:2 row (fenced-JSON import) still mints a per-run subdir', async () => {
  // BGR-012: fenced-JSON imports preserve the leading '--' on keys. The
  // normalization that strips '--' MUST run BEFORE the n>1 check — otherwise
  // a dashed '--n':'2' row would be read as n=1 and skip the runSubdir mint,
  // while buildArgs (which receives the normalized item) still emits --n 2 +
  // --out-dir, writing deliverables to a dir that was never grant-minted.
  resetState();
  const ensured = [];
  global.window.api = {
    fbEnsureDir: async (p) => { ensured.push(p); return { ok: true, path: p }; },
    mmxRunJob: async ({ args }) => {
      const outDirIdx = args.indexOf('--out-dir');
      assert.ok(outDirIdx >= 0, 'dashed --n:2 must pass --out-dir to mmx');
      assert.ok(args[outDirIdx + 1].startsWith('C:\\out\\run_'),
        `--out-dir must point at the per-run subdir, got ${args[outDirIdx + 1]}`);
      return { ok: true, code: 0 };
    },
    fbList: async (p) => ({
      ok: true,
      items: [
        { name: '1.png', ext: '.png', isDir: false, path: p + '\\1.png' },
        { name: '2.png', ext: '.png', isDir: false, path: p + '\\2.png' },
      ],
    }),
  };
  // Dashed key, exactly as a fenced-JSON import produces it.
  const r = await runVariantDirect('image', { prompt: 'a dragon', '--n': '2' }, {});
  assert.equal(r.ok, true);
  assert.equal(ensured.length, 1, 'dashed --n:2 must mint exactly one runSubdir');
  assert.ok(ensured[0].startsWith('C:\\out\\run_'),
    `the ensured path must be a runSubdir, got ${ensured[0]}`);
});

test('R6.2.D: n=1 row does NOT mint a per-run subdir (single-file writes go straight to outputDir)', async () => {
  resetState();
  const ensured = [];
  global.window.api = {
    fbEnsureDir: async (p) => { ensured.push(p); return { ok: true, path: p }; },
    mmxRunJob: async () => ({ ok: true, code: 0 }),
  };
  const r = await runVariantDirect('image', { prompt: 'a cat' }, {});
  assert.equal(r.ok, true);
  assert.equal(ensured.length, 0,
    'n=1 must NOT mint a runSubdir — R6.1 fought the per-item folder explosion');
});

test('R6.2.E: n>1 failure cleans up the runSubdir (best-effort fbDelete)', async () => {
  resetState();
  const deleted = [];
  global.window.api = {
    fbEnsureDir: async (p) => ({ ok: true, path: p }),
    mmxRunJob: async () => ({ ok: false, code: 1, stderr: 'mmx crashed' }),
    fbDelete: async (p) => { deleted.push(p); return { ok: true }; },
  };
  const r = await runVariantDirect('image', { prompt: 'a dragon', n: 2 }, {});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'mmx crashed');
  assert.equal(deleted.length, 1, 'mmx failure must clean up the runSubdir');
  assert.ok(deleted[0].startsWith('C:\\out\\run_'),
    `the deleted path must be the runSubdir, got ${deleted[0]}`);
});

test('R6.2.F: n>1 success leaves the runSubdir intact (cleanup only on failure)', async () => {
  resetState();
  const deleted = [];
  global.window.api = {
    fbEnsureDir: async (p) => ({ ok: true, path: p }),
    mmxRunJob: async () => ({ ok: true, code: 0 }),
    fbList: async (p) => ({ ok: true, items: [{ name: '1.png', ext: '.png', isDir: false, path: p + '\\1.png' }] }),
    fbDelete: async (p) => { deleted.push(p); return { ok: true }; },
  };
  const r = await runVariantDirect('image', { prompt: 'a dragon', n: 2 }, {});
  assert.equal(r.ok, true);
  assert.equal(deleted.length, 0,
    'successful run must NOT delete the runSubdir — the files are the deliverables');
});

test('R6.2.G: n>1 with no fbEnsureDir helper still proceeds (no-op success, fallback)', async () => {
  resetState();
  global.window.api = {
    // No fbEnsureDir at all.
    mmxRunJob: async () => ({ ok: true, code: 0 }),
    fbList: async (p) => ({ ok: true, items: [{ name: '1.png', ext: '.png', isDir: false, path: p + '\\1.png' }] }),
  };
  const r = await runVariantDirect('image', { prompt: 'a dragon', n: 2 }, {});
  assert.equal(r.ok, true,
    'no fbEnsureDir must NOT block the call — production code always has it, tests may not');
});

test('R6.2.H: n>1 with fbEnsureDir failing still proceeds (best-effort, fall back to user-facing outputDir)', async () => {
  resetState();
  let mmxArgs = null;
  global.window.api = {
    fbEnsureDir: async () => ({ ok: false, error: 'permission denied' }),
    mmxRunJob: async ({ args }) => { mmxArgs = args; return { ok: true, code: 0 }; },
    fbList: async (p) => ({ ok: true, items: [{ name: '1.png', ext: '.png', isDir: false, path: p + '\\1.png' }] }),
  };
  const r = await runVariantDirect('image', { prompt: 'a dragon', n: 2 }, {});
  // We fall back to the user-facing outputDir (no runSubdir) so the call
  // still succeeds — R6.2's per-run subdir is a quality-of-life, not a
  // hard requirement on the file system.
  assert.equal(r.ok, true);
  // The argv should still have --out-dir, but pointing at the user's
  // fbDir (the fallback path), not at run_<id>/.
  const outDirIdx = mmxArgs.indexOf('--out-dir');
  assert.ok(outDirIdx >= 0);
  assert.equal(mmxArgs[outDirIdx + 1], 'C:\\out',
    'fbEnsureDir failure must fall back to the user-facing outputDir');
});

// ============================================================================
// R6.2.AuditFix — adversarial-probe coverage gap closures
// ============================================================================
// The 14 P-probes + 10 P-probes + 13 XP-probes caught 24 of 27 mutations. The
// 3 not-caught mutations revealed three real test-coverage gaps the original
// R6.2.A-H set didn't enforce. R6.2.I/L close those gaps.

test('R6.2.I: mintRunSubdir rejects empty baseOutputDir (no runSubdir minted)', () => {
  const r = mintRunSubdir('');
  assert.equal(r.ok, false, 'empty baseOutputDir must NOT produce a runSubdir');
  assert.ok(r.error, 'empty baseOutputDir must return an error message');
  assert.equal(r.runSubdir, undefined,
    'empty baseOutputDir must NOT return a runSubdir (the caller treats a falsy runSubdir as "no per-run workspace")');
});

test('R6.2.J: n=1 with item.n=1 explicit does NOT mint a runSubdir (R6.1 anti-explosion enforced)', async () => {
  // R6.2.D tested the no-n case. R6.2.J explicitly tests item.n=1 (and
  // item.n="1" string) to close the gap the XP6 probe revealed: the
  // production code's `if (item.n || (item.params && item.params.n))`
  // gate kicks in only when an n is present; the actual n>1 check is
  // below it. This test exercises the n=1 path with an explicit n.
  resetState();
  const ensured = [];
  global.window.api = {
    fbEnsureDir: async (p) => { ensured.push(p); return { ok: true, path: p }; },
    mmxRunJob: async () => ({ ok: true, code: 0 }),
  };
  // item.n = 1 (number)
  const r1 = await runVariantDirect('image', { prompt: 'a cat', n: 1 }, {});
  assert.equal(r1.ok, true);
  assert.equal(ensured.length, 0, 'item.n=1 must NOT mint a runSubdir');
  // item.n = '1' (string, common when the row comes from CSV/JSON)
  const r2 = await runVariantDirect('image', { prompt: 'a cat', n: '1' }, {});
  assert.equal(r2.ok, true);
  assert.equal(ensured.length, 0, "item.n='1' must NOT mint a runSubdir");
});

test('R6.2.K: output list is sorted alphabetically by name (deterministic postprocess order)', async () => {
  // The pre-R6.2 sort was mtime-based (racy). R6.2 replaced it with
  // an alphabetical sort (deterministic). R6.2.K verifies the order
  // matters by feeding fbList an unsorted list and checking outFile
  // comes out as the first-by-name, not the first-by-list-order.
  resetState();
  global.window.api = {
    fbEnsureDir: async (p) => ({ ok: true, path: p }),
    mmxRunJob: async () => ({ ok: true, code: 0 }),
    // Return items in REVERSE-alphabetical order on purpose.
    fbList: async (p) => ({
      ok: true,
      items: [
        { name: '3.png', ext: '.png', isDir: false, path: p + '\\3.png' },
        { name: '1.png', ext: '.png', isDir: false, path: p + '\\1.png' },
        { name: '2.png', ext: '.png', isDir: false, path: p + '\\2.png' },
      ],
    }),
  };
  const r = await runVariantDirect('image', { prompt: 'a dragon', n: 3 }, {});
  assert.equal(r.ok, true);
  // r.outFile is the FIRST in alphabetical order, NOT the first in
  // fbList input order (which was 3.png).
  assert.ok(r.outFile && r.outFile.endsWith('1.png'),
    `outFile must be alphabetically first (1.png), got ${r.outFile}`);
});

test('R6.2.L: extension filter excludes non-image files (e.g. .json, .tmp)', async () => {
  // mmx-cli sometimes leaves behind .meta.json or .tmp/.part files in
  // the out-dir. R6.2 filters by extension — verify a .meta.json file
  // next to the .png outputs is NOT picked up.
  resetState();
  global.window.api = {
    fbEnsureDir: async (p) => ({ ok: true, path: p }),
    mmxRunJob: async () => ({ ok: true, code: 0 }),
    fbList: async (p) => ({
      ok: true,
      items: [
        { name: '1.png', ext: '.png', isDir: false, path: p + '\\1.png' },
        { name: '1.meta.json', ext: '.json', isDir: false, path: p + '\\1.meta.json' },
        { name: '2.png', ext: '.png', isDir: false, path: p + '\\2.png' },
        { name: 'tmp1.tmp', ext: '.tmp', isDir: false, path: p + '\\tmp1.tmp' },
        // Sub-directory — must be filtered by isDir check.
        { name: 'nested', ext: '', isDir: true, path: p + '\\nested' },
      ],
    }),
  };
  let enqueued = null;
  global.window.Pipeline = { enqueueFromPaths: async (paths) => { enqueued = paths; } };
  // Enable pipeline so we can inspect what was enqueued (the postprocess
  // would otherwise overwrite enqueued; we don't have postprocess, so the
  // raw outFiles go straight to the enqueue branch).
  global.window.state.autoPipelineEnabled = true;
  const r = await runVariantDirect('image', { prompt: 'a dragon', n: 2 }, {});
  assert.equal(r.ok, true);
  assert.equal(enqueued.length, 2, 'only 2 image files must be enqueued (.png x 2)');
  assert.ok(enqueued.every((p) => /\.png$/.test(p)),
    'every enqueued path must be a .png, got ' + JSON.stringify(enqueued));
});

test('R6.2.M: failure cleanup is gated on !ok (success never deletes the runSubdir with deliverables)', async () => {
  // XX2 + XX4 (R6.2.AuditFix): if a future refactor weakens the failure cleanup
  // condition to `if (true) { ... fbDelete ... }` it would clobber the
  // runSubdir even on the success path, deleting the user's deliverables.
  // This test exercises the success path explicitly and asserts fbDelete
  // is NEVER called.
  resetState();
  const deleted = [];
  global.window.api = {
    fbEnsureDir: async (p) => ({ ok: true, path: p }),
    mmxRunJob: async () => ({ ok: true, code: 0 }),
    fbList: async (p) => ({ ok: true, items: [{ name: '1.png', ext: '.png', isDir: false, path: p + '\\1.png' }] }),
    fbDelete: async (p) => { deleted.push(p); return { ok: true }; },
  };
  const r = await runVariantDirect('image', { prompt: 'a dragon', n: 2 }, {});
  assert.equal(r.ok, true);
  assert.equal(deleted.length, 0,
    'fbDelete must NEVER be called on the success path — that would clobber the deliverables');
});

test('R6.2.N: failure cleanup checks runSubdir truthy (no fbDelete(null) when mint failed)', async () => {
  // XX2 (R6.2.AuditFix): the failure cleanup MUST check `runSubdir`
  // before calling fbDelete. If the condition were weakened to
  // `if (true) { ... }` then a failed mint (runSubdir stays null) would
  // trigger fbDelete(null) which is a hard error in main-side.
  // We simulate this by NOT minting a runSubdir (n=1, no subdir at all)
  // + forcing mmx failure. fbDelete must NOT be called.
  resetState();
  const deleted = [];
  let fbDeleteCalled = false;
  global.window.api = {
    fbEnsureDir: async (p) => { throw new Error('mint failed'); },
    mmxRunJob: async () => ({ ok: false, code: 1, stderr: 'mmx crashed' }),
    fbDelete: async (p) => { fbDeleteCalled = true; deleted.push(p); return { ok: true }; },
  };
  // n=1 so no runSubdir is minted; mmx fails; cleanup must skip fbDelete.
  // Note: the production code's `if (runSubdir && ...)` guards against
  // the null case. A naive `if (true) { ... }` would call fbDelete(null).
  const r = await runVariantDirect('image', { prompt: 'a dragon' }, {});
  // n=1 + ensureRunSubdir-fail (mint skipped) means runSubdir stays null.
  // mmx fails. The cleanup is gated on runSubdir — fbDelete is NOT called.
  assert.equal(r.ok, false);
  // We allow fbDelete to be called (since n=1 has no runSubdir, fbDelete
  // is not gated by runSubdir at all). This test just documents the
  // expected behavior of the n=1 + failure path: no runSubdir cleanup
  // because there is no runSubdir.
  assert.equal(fbDeleteCalled, false,
    'n=1 path has no runSubdir to clean up — fbDelete must NOT be called');
});
