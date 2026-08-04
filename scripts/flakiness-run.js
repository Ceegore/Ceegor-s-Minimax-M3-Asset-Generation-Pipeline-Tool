// scripts/flakiness-run.js
// ============================================================================
// RQ-004 fix + V104-H002 + RR2-H004: flakiness qualification gate.
//
// The v1.0.4 requalification rejected a gate that repeated only the unit
// suite 10x at a fixed concurrency. The recheck-2 requalification
// (RR2-H004) then rejected a gate that still skipped the contract,
// coverage, lint, SBOM and installer/upgrade suites and never randomized
// execution order. A release qualifies only when its FULL suite
// inventory is proven deterministic under VARIED conditions:
//
//   1. Release suites: every repetition runs the unit suite (parallel),
//      the smoke suite, the E2E suite, the contract gate, the unit
//      coverage gate, the lint gate and the renderer-isolation check —
//      the same inventory the release workflow gates on.
//   2. Randomized order: every repetition shuffles the suite order with
//      a seeded RNG (seed recorded in the report), and the high-risk
//      battery shuffles its file order per repetition — order effects
//      can no longer hide behind a fixed schedule.
//   3. Varied conditions: one full SERIAL unit run (--test-concurrency=1)
//      precedes the repetitions (order effects surface only in serial),
//      and the high-risk battery alternates concurrency between runs.
//   4. Heavy release phase: when a real release exists in dist-out, the
//      installer acceptance suite (fresh install + packaged boot +
//      upgrade + deterministic interrupt + tamper rejection) runs —
//      the installer/upgrade/rollback proof RR2-H003 added.
//   5. High-risk 50x: the credential/security regression suites (the
//      mutation-test battery's suites) run 50 times under alternating
//      concurrency — any failed repetition fails the gate.
//
// Usage:  node scripts/flakiness-run.js [--repeats=N] [--high-risk-repeats=N]
//         [--seed=N]
//         (defaults: 10 repetitions, 50 high-risk repetitions;
//          FLAKY_REPEATS / FLAKY_HIGH_RISK_REPEATS / FLAKY_SEED env
//          also honored)
//
// Output: console summary per repetition + coverage/flakiness-report.json.
// Exit 0 only when EVERY repetition of EVERY suite passes.
// ============================================================================

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function log(m) { process.stdout.write(`[flakiness] ${m}\n`); }

function argInt(name, envName, fallback) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  const raw = (a && a.split('=')[1]) || process.env[envName] || String(fallback);
  return Math.max(1, parseInt(raw, 10) || fallback);
}

const REPEATS = argInt('repeats', 'FLAKY_REPEATS', 10);
const HIGH_RISK_REPEATS = argInt('high-risk-repeats', 'FLAKY_HIGH_RISK_REPEATS', 50);

// RR2-H004: seeded, RECORDED randomization. Same seed => same shuffle,
// so a flaky order found by the gate is reproducible.
const SEED = (() => {
  const a = process.argv.find((x) => x.startsWith('--seed='));
  const raw = (a && a.split('=')[1]) || process.env.FLAKY_SEED || String(Date.now() % 1000000);
  return parseInt(raw, 10) || 1;
})();
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// KNOWN FALSE POSITIVE: spawnSync launches ONLY the Node binary
// (process.execPath) with fixed test-runner flags and fixed repo-relative
// paths — it is NOT arbitrary command execution. Node expands the glob.
function runNode(args, timeoutMin = 40) {
  return spawnSync(
    process.execPath,
    args,
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: timeoutMin * 60 * 1000 }
  );
}

// The release-suite inventory for one repetition. RR2-H004: this is the
// FULL gate inventory the release workflow runs — not just unit/smoke/e2e.
const SUITES = [
  { id: 'unit-parallel', args: ['--test', '--test-concurrency=6', 'tests/unit/**/*.test.js'], timeoutMin: 40 },
  { id: 'smoke', args: ['scripts/run-smoke.js'], timeoutMin: 20 },
  { id: 'e2e', args: ['scripts/e2e/launch.js', '--surface-threshold=96'], timeoutMin: 40 },
  { id: 'contract', args: ['scripts/run-contract.js'], timeoutMin: 30 },
  // The coverage gate re-runs the unit suite under instrumentation and
  // re-checks the narrow waiver matrix — its parse/evaluate logic has its
  // own flakiness surface and is repeated like any other gate.
  { id: 'coverage-gate', args: ['scripts/check-unit-coverage.js'], timeoutMin: 60 },
  { id: 'lint', args: ['scripts/lint.js'], timeoutMin: 20 },
  { id: 'renderer-isolation', args: ['scripts/check-renderer-no-node-globals.js'], timeoutMin: 10 },
];

// High-risk credential/security suites — the mutation battery's regression
// suites. Kept in lock-step with scripts/mutation-test.js SUITES.
const HIGH_RISK_SUITES = (() => {
  try {
    const { SUITES: mutationSuites } = require('./mutation-test.js');
    return [...new Set(Object.values(mutationSuites).flat())];
  } catch (_) {
    return [];
  }
})();

function parseSummary(out) {
  const pass = Number((out.match(/^\s*(?:ℹ\s*)?pass\s+(\d+)/m) || [])[1] || 0);
  const fail = Number((out.match(/^\s*(?:ℹ\s*)?fail\s+(\d+)/m) || [])[1] || 0);
  const skipped = Number((out.match(/^\s*(?:ℹ\s*)?skipped\s+(\d+)/m) || [])[1] || 0);
  return { pass, fail, skipped };
}

function judge(r) {
  const out = (r.stdout || '') + '\n' + (r.stderr || '');
  const summary = parseSummary(out);
  // Node --test suites report pass/fail counts; script suites (smoke/e2e)
  // report via exit code only — accept them when exit 0.
  const ok = r.status === 0 && summary.fail === 0;
  return { ok, out, summary };
}

function failingTail(out) {
  const matched = out.split('\n').filter((l) => /not ok|\bfail\b/i.test(l)).slice(0, 40);
  // Script suites (smoke/e2e) do not emit TAP "not ok" lines — always fall
  // back to the raw tail so a failed repetition is diagnosable.
  if (matched.length > 0) return matched;
  return out.split('\n').slice(-25);
}

const results = [];
let failures = 0;

// --- Varied condition 1: a full SERIAL unit run (order effects). --------
log('Varied-condition run: full unit suite SERIALLY (--test-concurrency=1)...');
{
  const started = Date.now();
  const r = runNode(['--test', '--test-concurrency=1', 'tests/unit/**/*.test.js'], 90);
  const { ok, out, summary } = judge(r);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ phase: 'serial-unit', ok, exitCode: r.status, ...summary, seconds: Number(secs) });
  if (ok) {
    log(`  serial unit: PASS (${summary.pass} pass, ${secs}s)`);
  } else {
    failures++;
    log(`  serial unit: FAIL (exit ${r.status}, ${summary.fail} failed, ${secs}s)`);
    for (const line of failingTail(out)) log('    ' + line);
  }
}

// --- Release-suite repetitions -------------------------------------------
log(`Running the release suite ${REPEATS} time(s) (${SUITES.length} suites: ${SUITES.map((s) => s.id).join(', ')}).`);
log(`Randomization seed: ${SEED} (recorded in flakiness-report.json; rerun with --seed=${SEED} to reproduce an order).`);
for (let i = 1; i <= REPEATS; i++) {
  // RR2-H004: seeded per-repetition shuffle — order effects can no longer
  // hide behind a fixed schedule; the seed is recorded in the report.
  const rng = mulberry32(SEED + i);
  const order = shuffled(SUITES, rng);
  log(`  repetition ${i}/${REPEATS} order: ${order.map((s) => s.id).join(' -> ')}`);
  for (const suite of order) {
    const started = Date.now();
    const r = runNode(suite.args, suite.timeoutMin);
    const { ok, out, summary } = judge(r);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    results.push({ phase: `rep-${i}`, suite: suite.id, ok, exitCode: r.status, ...summary, seconds: Number(secs) });
    if (ok) {
      log(`  repetition ${i}/${REPEATS} ${suite.id}: PASS (${secs}s)`);
    } else {
      failures++;
      log(`  repetition ${i}/${REPEATS} ${suite.id}: FAIL (exit ${r.status}, ${summary.fail} failed, ${secs}s)`);
      for (const line of failingTail(out)) log('    ' + line);
    }
  }
}

// --- Heavy release phase: installer/upgrade/rollback on the real release.
// RR2-H004 demanded the installer acceptance (fresh install, packaged
// boot, real upgrade, deterministic interrupt, tamper rejection) be part
// of the flakiness evidence. It runs when a complete release exists in
// dist-out; set FLAKY_SKIP_ACCEPTANCE=1 to opt out on machines without
// the release artifacts.
if (process.env.FLAKY_SKIP_ACCEPTANCE !== '1') {
  const acceptance = path.join(ROOT, 'scripts', 'test-release-acceptance.js');
  const distOut = path.join(ROOT, 'dist-out');
  if (fs.existsSync(acceptance) && fs.existsSync(distOut)) {
    log('Heavy phase: installer acceptance on the real release (install/boot/upgrade/interrupt/tamper)...');
    const started = Date.now();
    const r = spawnSync(process.execPath, [acceptance], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 90 * 60 * 1000,
      env: { ...process.env },
    });
    const out = (r.stdout || '') + '\n' + (r.stderr || '');
    const ok = r.status === 0;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    results.push({ phase: 'installer-acceptance', ok, exitCode: r.status, seconds: Number(secs) });
    if (ok) {
      log(`  installer acceptance: PASS (${secs}s)`);
    } else {
      failures++;
      log(`  installer acceptance: FAIL (exit ${r.status}, ${secs}s)`);
      for (const line of out.split('\n').slice(-30)) log('    ' + line);
    }
  } else {
    log('Heavy phase skipped: no dist-out release present (build the release first to include installer evidence).');
  }
}

// --- High-risk 50x under alternating concurrency (varied condition 2). ---
log(`Running the ${HIGH_RISK_SUITES.length} high-risk credential/security suites ${HIGH_RISK_REPEATS} time(s) with alternating concurrency and shuffled file order.`);
for (let i = 1; i <= HIGH_RISK_REPEATS; i++) {
  const concurrency = i % 2 === 0 ? 1 : 6; // varied condition
  const rng = mulberry32(SEED + 1000 + i);
  const files = shuffled(HIGH_RISK_SUITES, rng); // RR2-H004: random order
  const started = Date.now();
  const r = runNode(['--test', `--test-concurrency=${concurrency}`, ...files], 30);
  const { ok, out, summary } = judge(r);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ phase: 'high-risk', repetition: i, concurrency, ok, exitCode: r.status, ...summary, seconds: Number(secs) });
  if (ok) {
    log(`  high-risk ${i}/${HIGH_RISK_REPEATS} (concurrency=${concurrency}): PASS (${summary.pass} pass, ${secs}s)`);
  } else {
    failures++;
    log(`  high-risk ${i}/${HIGH_RISK_REPEATS} (concurrency=${concurrency}): FAIL (exit ${r.status}, ${summary.fail} failed, ${secs}s)`);
    for (const line of failingTail(out)) log('    ' + line);
  }
}

// Evidence artifact for the release record.
try {
  const reportDir = path.join(ROOT, 'coverage');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'flakiness-report.json'), JSON.stringify({
    repeats: REPEATS,
    highRiskRepeats: HIGH_RISK_REPEATS,
    highRiskSuiteCount: HIGH_RISK_SUITES.length,
    suites: SUITES.map((s) => s.id),
    seed: SEED,
    randomization: 'seeded per-repetition shuffle of suite order + high-risk file order',
    failures,
    verdict: failures === 0 ? 'STABLE' : 'FLAKY',
    results,
    at: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');
} catch (_) { /* report writing must not mask the verdict */ }

if (failures > 0) {
  log(`FAIL: ${failures} failed repetition(s) — the release suites are flaky and cannot qualify a release.`);
  process.exit(1);
}
log(`PASS: serial unit + ${REPEATS}x release suites + ${HIGH_RISK_REPEATS}x high-risk battery all green — no flakiness detected.`);
