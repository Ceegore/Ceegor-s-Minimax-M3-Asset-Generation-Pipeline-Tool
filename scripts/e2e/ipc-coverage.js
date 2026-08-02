// scripts/e2e/ipc-coverage.js
// ============================================================================
// Phase 6 — IPC handler coverage cross-check (the third of the three honest
// coverage metrics, alongside line coverage and UI-surface coverage).
//
// It enumerates EVERY IPC channel the app registers (all REGISTRARS + the mmx
// channels) by wrapping ipcMain.handle/on, then boots the real renderer under
// the fake-mmx harness and runs the whole Tier-2 scenario suite, recording
// which channels actually get invoked. The result — registered vs invoked vs
// never-invoked — is written to coverage/ipc.json and printed as a table.
//
// Phase F: Added --threshold=N flag to enforce a minimum coverage percentage.
// Exit 1 if coverage is below the threshold (CI gate).
//
// Run:  node scripts/e2e/ipc-coverage.js [--threshold=90]
// ============================================================================

const path = require('path');
const fs = require('fs');

// Parse --threshold=N from CLI args.
const thresholdArg = process.argv.find(a => a.startsWith('--threshold='));
const THRESHOLD = thresholdArg ? parseFloat(thresholdArg.split('=')[1]) : null;

let electron;
try { electron = require('electron'); } catch (_) { electron = null; }
const app = electron && electron.app;
const ipcMain = electron && electron.ipcMain;

// ---- Node context: re-spawn ourselves under Electron ----
// KNOWN FALSE POSITIVE: spawnSync here launches ONLY the Electron binary
// with this same file as entry — standard Electron-from-Node pattern.
// See harness.js header for the full false-positives reference.
if (!app || typeof app.whenReady !== 'function') {
  const { spawnSync } = require('child_process');
  let electronPath;
  try { electronPath = require('electron'); } catch (e) {
    console.error('Electron is not installed (npm install first).');
    process.exit(1);
  }
  const r = spawnSync(electronPath, [__filename], { stdio: 'inherit', env: { ...process.env } });
  process.exit(r.status == null ? 1 : r.status);
}

// ---- Electron context ----
// Suppress Electron's blocking native "A JavaScript error occurred in the
// main process" dialog: log the stack to stdout instead so CI/user terminals
// see the error and the run is never blocked on a dialog click.
process.on('uncaughtException', (err) => { console.error('[ipc-coverage] uncaughtException: ' + ((err && err.stack) || err)); });
process.on('unhandledRejection', (reason) => { console.error('[ipc-coverage] unhandledRejection: ' + ((reason && reason.stack) || reason)); });
const { createHarness, APP_ROOT } = require('./harness');
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');

// KGO7-004: channels a scenario must NOT drive, with the reason. They still
// count in the denominator — the point is that the gap is VISIBLE instead
// of being hidden by a shrunken denominator.
const INTENTIONALLY_UNINVOKED = {
  'app:relaunch': 'kills the Electron process (app.relaunch + app.exit) — would abort the run',
  'app:resetAndRelaunch': 'deletes local data then kills the process — would abort the run',
  'app:confirmResetAndRelaunch': 'B-009 Main-owned reset transaction: native dialog + delete + relaunch — would block on the dialog and abort the run',
  'app:prepare-close:ack': 'registered lazily by createMainWindow during the real close handshake, which the harness never opens',
  'renderer:log': 'declared at top level in main/index.js (the app entry), which a harness must not load — it would boot a second app instance',
};

/**
 * Statically scan main/ for every `ipcMain.handle|on|once('channel'` so
 * the coverage denominator reflects what the APP declares, independent of
 * which registrars a harness happened to load.
 * @param {string} dir
 * @returns {string[]} sorted, de-duplicated channel names
 */
function scanDeclaredChannels(dir) {
  const found = new Set();
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      let src;
      try { src = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      const re = /ipcMain\s*\.\s*(?:handle|handleOnce|on|once)\s*\(\s*['"]([^'"]+)['"]/g;
      let m;
      while ((m = re.exec(src))) found.add(m[1]);
    }
  };
  walk(dir);
  return [...found].sort();
}

// Wrap ipcMain.handle/on BEFORE anything registers, so every channel the app
// exposes is captured, and every invocation during the scenario run is seen.
const registered = new Set();
const invoked = new Set();
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  registered.add(channel);
  return origHandle(channel, async (...a) => { invoked.add(channel); return handler(...a); });
};
const origOn = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, listener) => {
  registered.add(channel);
  return origOn(channel, (...a) => { invoked.add(channel); return listener(...a); });
};

function loadScenarios() {
  const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.js')).sort();
  const list = [];
  for (const f of files) {
    try {
      const mod = require(path.join(SCENARIOS_DIR, f));
      if (mod && typeof mod.run === 'function') {
        list.push({ file: f, name: mod.name || f.replace(/\.js$/, ''), needsRealApi: !!mod.needsRealApi, order: Number(mod.order != null ? mod.order : 100), run: mod.run });
      }
    } catch (_) { /* skip unloadable */ }
  }
  list.sort((a, b) => (a.order - b.order) || a.file.localeCompare(b.file));
  return list;
}

app.whenReady().then(async () => {
  const killer = setTimeout(() => { console.error('IPC_COVERAGE_TIMEOUT'); app.exit(2); }, 600000);
  let exitCode = 0;
  let harness = null;
  const failedScenarios = [];
  try {
    harness = createHarness({ real: false });
    await harness.boot();

    // Run every Tier-2 (fake-mode) scenario so their IPC traffic is observed.
    const scenarios = loadScenarios().filter((s) => !s.needsRealApi);
    for (const sc of scenarios) {
      try {
        await harness.reset();
        await sc.run(harness);
      } catch (e) {
        failedScenarios.push(sc.name + ': ' + ((e && e.message) || e));
      }
    }

    // KGO7-004: measure against the channels the APP declares, not just
    // the ones this harness happened to register. The old denominator was
    // whatever `registered` collected at runtime, so a registrar missing
    // from the harness list simply shrank the denominator — the gate
    // printed "84/84 = 100 %" while main/ registers 91 channels, hiding
    // app:resetAllData, app:relaunch, app:resetAndRelaunch, m3:chat,
    // mmx:profile, renderer:log and app:prepare-close:ack.
    const declared = scanDeclaredChannels(path.join(APP_ROOT, 'main'));
    const reg = [...new Set([...registered, ...declared])].sort();
    // Channels listed in INTENTIONALLY_UNINVOKED are also intentionally
    // NOT registered (they live outside the registrar system), so they
    // must not trip the drift check.
    const neverRegistered = declared
      .filter((c) => !registered.has(c) && !INTENTIONALLY_UNINVOKED[c])
      .sort();
    const never = reg.filter((c) => !invoked.has(c));
    // The percentage is measured over the ACTIONABLE set: every declared
    // channel minus the ones listed (with a reason) in
    // INTENTIONALLY_UNINVOKED. Both numbers are reported so a growing
    // exclusion list is visible rather than quietly inflating the score.
    const actionable = reg.filter((c) => !INTENTIONALLY_UNINVOKED[c]);
    const actionableMissed = actionable.filter((c) => !invoked.has(c));
    const pct = actionable.length
      ? Math.round(((actionable.length - actionableMissed.length) / actionable.length) * 1000) / 10
      : 0;
    const report = {
      coverage_pct: pct,
      registered_total: reg.length,
      invoked_total: reg.length - never.length,
      actionable_total: actionable.length,
      actionable_invoked: actionable.length - actionableMissed.length,
      declaredTotal: declared.length,
      registered: reg,
      invoked: [...invoked].filter((c) => reg.includes(c)).sort(),
      neverInvoked: never,
      // Declared in main/ but never even REGISTERED during the run — a
      // louder failure class than "registered but not invoked".
      neverRegistered,
      // Channels deliberately not driven by a scenario, with the reason.
      intentionallyUninvoked: INTENTIONALLY_UNINVOKED,
      failedScenarios,
    };

    const covDir = path.join(APP_ROOT, 'coverage');
    fs.mkdirSync(covDir, { recursive: true });
    const outFile = path.join(covDir, 'ipc.json');
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

    console.log('\n================================================================');
    console.log(`IPC HANDLER COVERAGE  ${report.actionable_invoked}/${actionable.length} actionable channels invoked  (${pct}%)`);
    console.log(`  declared in main/: ${declared.length}   registered this run: ${registered.size}   intentionally excluded: ${reg.length - actionable.length}`);
    console.log('================================================================');
    if (neverRegistered.length) {
      console.log(`\nDECLARED IN main/ BUT NEVER REGISTERED (${neverRegistered.length}) — harness registrar drift:`);
      for (const c of neverRegistered) console.log('  ! ' + c);
      console.log('  (fix main/ipcRegistrarNames.js or the harness, not this list)');
    }
    if (never.length) {
      console.log(`Never invoked by any Tier-2 scenario (${never.length}):`);
      for (const c of never) {
        const why = INTENTIONALLY_UNINVOKED[c];
        console.log('  - ' + c + (why ? `   [intentional: ${why}]` : ''));
      }
    } else {
      console.log('Every registered IPC channel was invoked. ');
    }
    if (failedScenarios.length) {
      console.log(`\nWARNING: ${failedScenarios.length} scenario(s) threw during the coverage run (coverage may be under-reported):`);
      for (const f of failedScenarios) console.log('  - ' + f);
      exitCode = 1;
    }
    // KGO7-004: harness drift is its own hard failure. Without this, a
    // registrar dropped from the harness just shrinks the surface and the
    // gate stays green.
    if (neverRegistered.length) {
      console.error(`\nIPC COVERAGE GATE FAILED: ${neverRegistered.length} channel(s) declared in main/ were never registered.`);
      console.error('The harness registrar list has drifted from main/ipcRegistrarNames.js.');
      exitCode = 1;
    }
    console.log(`\nReport written to ${outFile}\n`);

    // Phase F: Enforce threshold if specified.
    if (THRESHOLD !== null && pct < THRESHOLD) {
      console.error(`\nIPC COVERAGE GATE FAILED: ${pct}% < ${THRESHOLD}% threshold`);
      console.error(`Coverage must be at least ${THRESHOLD}% to pass CI.`);
      exitCode = 1;
    } else if (THRESHOLD !== null) {
      console.log(`IPC coverage gate passed: ${pct}% >= ${THRESHOLD}%`);
    }
  } catch (e) {
    console.error('IPC_COVERAGE_FATAL\n' + ((e && e.stack) || e));
    exitCode = 1;
  } finally {
    clearTimeout(killer);
    if (harness) { try { harness.cleanup(); } catch (_) {} }
    app.exit(exitCode);
  }
});
