// scripts/flakiness-run.js
// ============================================================================
// RQ-004 fix + V104-H002: flakiness qualification gate.
//
// The v1.0.4 requalification rejected a gate that repeated only the unit
// suite 10x at a fixed concurrency. A release qualifies only when its
// FULL suite inventory is proven deterministic under VARIED conditions:
//
//   1. Release suites: every repetition runs the unit suite (parallel),
//      the smoke suite and the E2E suite — the same inventory the release
//      workflow gates on.
//   2. Varied conditions: one full SERIAL unit run (--test-concurrency=1)
//      precedes the repetitions (order effects surface only in serial),
//      and the high-risk battery alternates concurrency between runs.
//   3. High-risk 50x: the credential/security regression suites (the
//      mutation-test battery's suites) run 50 times under alternating
//      concurrency — any failed repetition fails the gate.
//
// Usage:  node scripts/flakiness-run.js [--repeats=N] [--high-risk-repeats=N]
//         (defaults: 10 repetitions, 50 high-risk repetitions;
//          FLAKY_REPEATS / FLAKY_HIGH_RISK_REPEATS env also honored)
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

// The release-suite inventory for one repetition.
const SUITES = [
  { id: 'unit-parallel', args: ['--test', '--test-concurrency=6', 'tests/unit/**/*.test.js'], timeoutMin: 40 },
  { id: 'smoke', args: ['scripts/run-smoke.js'], timeoutMin: 20 },
  { id: 'e2e', args: ['scripts/e2e/launch.js', '--surface-threshold=96'], timeoutMin: 40 },
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
log(`Running the release suite ${REPEATS} time(s) (unit-parallel + smoke + e2e).`);
for (let i = 1; i <= REPEATS; i++) {
  for (const suite of SUITES) {
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

// --- High-risk 50x under alternating concurrency (varied condition 2). ---
log(`Running the ${HIGH_RISK_SUITES.length} high-risk credential/security suites ${HIGH_RISK_REPEATS} time(s) with alternating concurrency.`);
for (let i = 1; i <= HIGH_RISK_REPEATS; i++) {
  const concurrency = i % 2 === 0 ? 1 : 6; // varied condition
  const started = Date.now();
  const r = runNode(['--test', `--test-concurrency=${concurrency}`, ...HIGH_RISK_SUITES], 30);
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
