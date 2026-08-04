// scripts/e2e/run.js
// ============================================================================
// Electron main-process entry for the E2E suite. Boots the reusable harness
// (scripts/e2e/harness.js), loads every scenario module in
// scripts/e2e/scenarios/, runs them sequentially against the REAL renderer,
// and exits non-zero if any assertion fails — so `npm run test:e2e` gates CI.
//
// Modes:
//   (default)   fake mmx backend — free, offline, deterministic (Tier 2)
//   --real      wire the REAL mmx IPC (image/speech/music hit the live API);
//               video stays faked unless RUN_VIDEO_CANARY=1 (Tier 3)
//   --only=X    run only scenarios whose name contains X (repeatable via ,)
//   --isolate   boot a FRESH harness per scenario (strictest isolation; CI)
//   --visual-capture  store fresh visual-regression baselines after the run
//               (without it, existing baselines are compared and enforced)
//   --surface-threshold=N  hard-gate on UI-surface coverage % (Phase F3)
//
// Run via:  node scripts/e2e/launch.js [args]   (or npm run test:e2e)
// Output:   JSON report between E2E_BEGIN/E2E_END, then PASS/FAIL.
// ============================================================================

const path = require('path');
const fs = require('fs');

const { createHarness, APP_ROOT } = require('./harness');
const { installRecorder, getTouched } = require('./uimap');
const { buildReport, writeReport, printTable } = require('./surface-report');
const { captureBaselines, compareBaselines, BASELINES_DIR } = require('./visual-baseline');

const argv = process.argv.slice(2);
const REAL = argv.includes('--real');
const ISOLATE = argv.includes('--isolate');
// --visual-capture (or VISUAL_CAPTURE=1) stores fresh visual baselines after
// the scenarios run; without it, existing baselines are compared and enforced.
const VISUAL_CAPTURE = argv.includes('--visual-capture') || process.env.VISUAL_CAPTURE === '1';
// --surface-threshold=N turns the UI-surface coverage report into a hard gate:
// fail the run if the % of automatable ui_map elements touched drops below N.
const surfaceThrArg = argv.find((a) => a.startsWith('--surface-threshold='));
const SURFACE_THRESHOLD = surfaceThrArg ? parseFloat(surfaceThrArg.split('=')[1]) : null;
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;
// Visual baselines are pixel-exact captures from the CI display stack.
// Interactive developer desktops with different DPI/font/clear-type
// settings render text-heavy screens measurably different (several %), so
// a LOCAL run may opt out EXPLICITLY. The skip is loud and recorded in the
// report; the release workflow never sets this, so CI stays strict.
const SKIP_VISUAL = argv.includes('--skip-visual') || process.env.E2E_SKIP_VISUAL === '1';

const SCENARIOS_DIR = path.join(__dirname, 'scenarios');

function loadScenarios() {
  const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.js')).sort();
  const list = [];
  for (const f of files) {
    try {
      const mod = require(path.join(SCENARIOS_DIR, f));
      if (mod && typeof mod.run === 'function') {
        list.push({ file: f, name: mod.name || f.replace(/\.js$/, ''), needsRealApi: !!mod.needsRealApi, fakeOnly: !!mod.fakeOnly, order: Number(mod.order != null ? mod.order : 100), skipWhen: typeof mod.skipWhen === 'function' ? mod.skipWhen : null, run: mod.run });
      }
    } catch (e) {
      list.push({ file: f, name: f.replace(/\.js$/, ''), order: 100, loadError: (e && e.stack || String(e)) });
    }
  }
  // Sort by explicit `order` (so the suite reproduces the original smoke
  // sequence 1:1), then by filename for a stable tie-break.
  list.sort((a, b) => (a.order - b.order) || a.file.localeCompare(b.file));
  return list;
}

// Wire the REAL mmx IPC (Tier 3). Image/speech/music hit the live API via
// src/mmx.js; video is intercepted by the fake unless RUN_VIDEO_CANARY=1.
// The credential is resolved exactly like the production IPC
// (main/ipc/resolveCredential.js) — it reads the isolated config.txt the
// harness wrote with the real key (MINIMAX_API_KEY).
function registerRealMmx(h) {
  const { ipcMain } = require('electron');
  const { runMmx } = require(path.join(APP_ROOT, 'src', 'mmx'));
  const { resolveCredential } = require(path.join(APP_ROOT, 'main', 'ipc', 'resolveCredential'));
  const { videoFakeEnabled, runVideoFake } = require('./videoFake');
  const canary = process.env.RUN_VIDEO_CANARY === '1';

  const dispatch = async (args, jobId) => {
    args = Array.isArray(args) ? args : [];
    // Video is the ONE fake (3/day quota) unless this is the canary run.
    if (args[0] === 'video' && videoFakeEnabled() && !canary) {
      return runVideoFake(args, h.OUT);
    }
    const cred = resolveCredential(null);
    if (cred.error || !cred.apiKey) {
      return { ok: false, code: -1, stdout: '', stderr: cred.error || 'No API key configured (set MINIMAX_API_KEY)', parsed: null, command: 'mmx', argv: args };
    }
    return runMmx({ args, jobId, apiKey: cred.apiKey, sessionOnly: cred.sessionOnly });
  };
  // KGO7-002: register the REAL registerMmxIpc first, so `mmx:voices`,
  // `mmx:quota`, `mmx:cancel`, `mmx:authStatus`, `mmx:diagnose` and
  // `mmx:profile` all exist and run their production code against the
  // isolated config (which the harness seeded with MINIMAX_API_KEY).
  //
  // Before this, registerRealMmx registered ONLY mmx:run + mmx:run:job, so
  // the other six channels had NO handler at all in `--real` mode. Measured
  // consequences: the speech tab could not finish building (no voice list,
  // so "Generate button not found"), the quota button threw an uncaught
  // rejection that failed both `setup-nav` and `zz-no-errors`, and the run
  // reported 34/52 with 7 failures — none of them about the app.
  try {
    require(path.join(APP_ROOT, 'main', 'ipc', 'registerMmxIpc'))
      .register({ appRoot: APP_ROOT, getMainWindow: () => h.win() });
  } catch (e) {
    process.stdout.write('\n[e2e] registerRealMmx: registerMmxIpc failed: ' + ((e && e.stack) || e) + '\n');
  }
  // Then take over ONLY the two run channels: the harness needs the video
  // fake + jobId plumbing, and it must own the credential resolution so a
  // run can never fall back to the user's real config.txt.
  for (const ch of ['mmx:run', 'mmx:run:job']) {
    try { ipcMain.removeHandler(ch); } catch (_) {}
  }
  ipcMain.handle('mmx:run', async (_e, args) => dispatch(args, null));
  ipcMain.handle('mmx:run:job', async (_e, payload, grantId) => {
    global.__e2eLastMmxGrantId = grantId;
    return dispatch(payload && payload.args, payload && payload.jobId);
  });
}

async function main() {
  const scenarios = loadScenarios();
  const filtered = ONLY
    ? scenarios.filter((s) => ONLY.some((o) => s.name.includes(o) || s.file.includes(o)))
    : scenarios;

  const results = [];
  let harness = null;

  const runScenario = async (sc) => {
    const res = { name: sc.name, file: sc.file, pass: true, problems: [], error: null };
    if (sc.loadError) {
      res.pass = false; res.error = sc.loadError;
      return { res, harness };
    }
    // Real-API-only scenarios are skipped in fake mode (they need --real);
    // fake-only scenarios (which assert on the fake backend's argv/out-path
    // captures) are skipped in real mode. Everything else runs in both.
    if (sc.needsRealApi && !REAL) { res.skipped = true; res.pass = false; return { res, harness }; }
    if (sc.fakeOnly && REAL) { res.skipped = true; res.pass = false; return { res, harness }; }
    // Real-API scenarios skip CLEANLY (exit 0, SKIP report) when no key is
    // configured, so a local `--real` run never breaks on a missing secret.
    if (sc.needsRealApi && REAL && !process.env.MINIMAX_API_KEY) { res.skipped = true; res.skipReason = 'MINIMAX_API_KEY not set'; res.pass = false; return { res, harness }; }
    // Scenario-specific skip predicate (e.g. the video canary only runs when
    // RUN_VIDEO_CANARY=1 so it can never burn quota accidentally).
    if (sc.skipWhen) { const why = sc.skipWhen(); if (why) { res.skipped = true; res.skipReason = why; res.pass = false; return { res, harness }; } }

    const before = harness.problems.length;
    try {
      await harness.reset();
      await sc.run(harness);
    } catch (e) {
      res.error = (e && e.stack || String(e));
      res.pass = false;
    }
    const newProblems = harness.problems.slice(before);
    res.problems = newProblems;
    if (newProblems.length) res.pass = false;
    // Capture a failure screenshot for evidence (kept by cleanup on failure).
    if (!res.pass) { try { await harness.screenshot('fail-' + sc.name); } catch (_) {} }
    return { res, harness };
  };

  // In real mode the harness writes the REAL key (from MINIMAX_API_KEY) into
  // the isolated config.txt so resolveCredential/runMmx can pick it up.
  const apiKey = process.env.MINIMAX_API_KEY || undefined;
  const touched = new Set();
  if (ISOLATE) {
    // Fresh harness per scenario — strictest isolation.
    for (const sc of filtered) {
      harness = createHarness({ real: REAL, apiKey });
      if (REAL) registerRealMmx(harness);
      await harness.boot();
      await installRecorder(harness.exec);
      const { res } = await runScenario(sc);
      for (const id of await getTouched(harness.exec)) touched.add(id);
      const c = harness.cleanup();
      res.keptShots = c.keptShots;
      results.push(res);
    }
    // KGO7-009: every per-scenario harness above has been cleaned up (its
    // window is destroyed), so the visual phase needs its own live one.
    harness = createHarness({ real: REAL, apiKey });
    if (REAL) registerRealMmx(harness);
    await harness.boot();
  } else {
    harness = createHarness({ real: REAL, apiKey });
    if (REAL) registerRealMmx(harness);
    await harness.boot();
    await installRecorder(harness.exec);
    for (const sc of filtered) {
      const { res } = await runScenario(sc);
      results.push(res);
    }
    for (const id of await getTouched(harness.exec)) touched.add(id);
  }

  // ---- Phase E: visual regression (capture or compare) ----
  // VISUAL_CAPTURE=1 stores fresh baselines; otherwise, when baselines
  // exist, compare against them. Visual regression failures also fail
  // the exit code (KGO-012).
  //
  // KGO7-009: this used to live INSIDE the shared-harness branch, so
  // `--isolate` — the mode the header documents as "strictest isolation;
  // CI" — returned `visual: null` and skipped the check entirely. The
  // strictest mode was checking the least. Now both modes run it; under
  // --isolate the last per-scenario harness is reused, which (with
  // KGO7-001's deterministic reset) is if anything the cleaner baseline
  // source.
  let visual = null;
  try {
    if (!harness) throw new Error('no harness available for the visual phase');
    const vctx = { exec: harness.exec, sleep: harness.sleep, screenshot: harness.screenshot, closeModals: harness.closeModals, sharp: harness.sharp };
    if (VISUAL_CAPTURE) {
      await captureBaselines(vctx);
      visual = { captured: true };
    } else if (ONLY) {
      // KGO8-003: the baselines record the app AFTER the full suite. A
      // filtered run reaches the shutter with a different file browser, a
      // different active tab and different job history, so comparing them is
      // meaningless — measured 18–90 % diffs on a --only run with the app
      // perfectly healthy. Now that the gate actually fails (the advisory
      // escape is gone) that would make every debug run red for no reason.
      // Skip explicitly and SAY SO — never silently "pass".
      process.stdout.write('\n[visual] SKIPPED — filtered run (--only) cannot reproduce the full-suite baseline state.\n');
      visual = { ok: true, skipped: true, reason: 'filtered run (--only)' };
    } else if (SKIP_VISUAL) {
      process.stdout.write('\n[visual] SKIPPED — explicitly opted out (--skip-visual / E2E_SKIP_VISUAL=1). CI never sets this; baselines stay enforced there.\n');
      visual = { ok: true, skipped: true, reason: 'explicit opt-out (--skip-visual / E2E_SKIP_VISUAL=1)' };
    } else if (fs.existsSync(BASELINES_DIR)) {
      visual = await compareBaselines(vctx);
    }
  } catch (e) {
    process.stdout.write('\nVISUAL_CHECK_ERROR ' + (e && e.message || e) + '\n');
  }

  return { results, harness, touched, visual };
}

// ---- Electron entry ----
const { app } = require('electron');
if (typeof app === 'undefined' || !app || typeof app.whenReady !== 'function') {
  process.stdout.write(
    '\nE2E_FATAL\nscripts/e2e/run.js must run inside Electron.\n' +
    'Use: node scripts/e2e/launch.js  (or npm run test:e2e)\n');
  process.exit(1);
}

app.whenReady().then(async () => {
  // Suppress Electron's blocking native error dialog for uncaught
  // main-process errors: log to stdout so the run is never blocked.
  process.on('uncaughtException', (err) => { process.stdout.write('\n[e2e] uncaughtException: ' + ((err && err.stack) || err) + '\n'); });
  process.on('unhandledRejection', (reason) => { process.stdout.write('\n[e2e] unhandledRejection: ' + ((reason && reason.stack) || reason) + '\n'); });
  // Real generations take minutes each (music/video), so the safety-net kill
  // timeout is much longer in --real mode than in the fast fake tier.
  const killMs = REAL ? 1800000 : 300000;
  const killer = setTimeout(() => { process.stdout.write('\nE2E_TIMEOUT\n'); app.exit(2); }, killMs);
  let exitCode = 0;
  let report = { results: [] };
  let lastHarness = null;
  let touched = new Set();
  try {
    const r = await main();
    lastHarness = r.harness;
    touched = r.touched || new Set();
    report = { mode: REAL ? 'real' : 'fake', isolate: ISOLATE, results: r.results };
    if (r.visual) report.visual = r.visual;
    const failed = r.results.filter((x) => !x.pass && !x.skipped);
    exitCode = failed.length ? 1 : 0;
    // KGO-012 fix: visual regression failures also fail the exit code.
    if (r.visual && r.visual.ok === false) exitCode = 1;
  } catch (e) {
    process.stdout.write('\nE2E_FATAL\n' + (e && e.stack || e) + '\n');
    exitCode = 1;
  } finally {
    clearTimeout(killer);
    let keptShots = null;
    if (lastHarness) { try { keptShots = lastHarness.cleanup().keptShots; } catch (_) {} }
    report.keptShots = keptShots;
    const total = report.results.length;
    const passed = report.results.filter((r) => r.pass && !r.skipped).length;
    const skipped = report.results.filter((r) => r.skipped).length;
    const scenarioFailed = report.results.filter((r) => !r.pass && !r.skipped).length;
    // KGO7-011: a visual regression sets exitCode but was NOT counted, so
    // the report read `"failed": 0` on a run that exits 1 — anything
    // machine-reading summary.failed (a CI dashboard, a badge) called that
    // run green. Count it, and keep the two sources distinguishable.
    const visualFailed = (report.visual && report.visual.ok === false)
      ? ((report.visual.failures || []).length || 1)
      : 0;
    const failed = scenarioFailed + visualFailed;
    report.summary = { total, passed, skipped, failed, scenarioFailed, visualFailed };
    // UI-surface coverage report (ui_map.json driven). Advisory by default;
    // becomes a hard gate when --surface-threshold=N is passed (Phase F3).
    try {
      const srep = buildReport(touched);
      // KGO7-012: a filtered run writes surface.partial.json instead of
      // clobbering the canonical coverage/surface.json with its 2 % number.
      const partial = !!ONLY;
      report.surface = { coverage_pct: srep.coverage_pct, touched: srep.touched, automatable_total: srep.automatable_total, manual_total: srep.manual_total, partial, file: writeReport(srep, undefined, { partial }) };
      if (partial) process.stdout.write('\n[surface] filtered run (--only) — wrote surface.partial.json; coverage/surface.json left intact\n');
      process.stdout.write('\n' + printTable(srep) + '\n');
      if (SURFACE_THRESHOLD !== null && srep.coverage_pct < SURFACE_THRESHOLD) {
        process.stdout.write(`\nSURFACE COVERAGE GATE FAILED: ${srep.coverage_pct}% < ${SURFACE_THRESHOLD}% threshold\n`);
        exitCode = 1;
      }
    } catch (e) {
      process.stdout.write('\nSURFACE_REPORT_ERROR ' + (e && e.message || e) + '\n');
    }
    process.stdout.write('\nE2E_BEGIN\n' + JSON.stringify(report, null, 2) + '\nE2E_END\n');
    process.stdout.write(exitCode
      ? `\nE2E_FAIL (${passed}/${total} passed, ${scenarioFailed} scenario + ${visualFailed} visual failure(s), exit=${exitCode})\n`
      : `\nE2E_PASS (${passed}/${total}, ${skipped} skipped)\n`);
    app.exit(exitCode);
  }
});
