// scripts/flakiness-run.js
// ============================================================================
// RQ-004 fix: flakiness qualification gate.
//
// Runs the FULL unit suite repeatedly. A test suite that passes once is not
// proven deterministic — order effects, port collisions, timing races and
// leftover temp state only surface under repetition. Any failed repetition
// fails this gate, so a flaky suite can never qualify a release silently.
//
// Usage:  node scripts/flakiness-run.js [--repeats=N]
//         (default 10 repetitions; FLAKY_REPEATS env also honored)
//
// Output: console summary per repetition + coverage/flakiness-report.json.
// Exit 0 only when EVERY repetition passes.
// ============================================================================

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function log(m) { process.stdout.write(`[flakiness] ${m}\n`); }

const repeatsArg = process.argv.find((a) => a.startsWith('--repeats='));
const REPEATS = Math.max(1, parseInt(
  (repeatsArg && repeatsArg.split('=')[1]) || process.env.FLAKY_REPEATS || '10', 10));

// KNOWN FALSE POSITIVE: spawnSync launches ONLY the Node binary
// (process.execPath) with fixed test-runner flags and a fixed glob — it is
// NOT arbitrary command execution. Node expands the glob for --test itself.
function runSuite() {
  return spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=6', 'tests/unit/**/*.test.js'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 30 * 60 * 1000 }
  );
}

function parseSummary(out) {
  const pass = Number((out.match(/^\s*(?:ℹ\s*)?pass\s+(\d+)/m) || [])[1] || 0);
  const fail = Number((out.match(/^\s*(?:ℹ\s*)?fail\s+(\d+)/m) || [])[1] || 0);
  const skipped = Number((out.match(/^\s*(?:ℹ\s*)?skipped\s+(\d+)/m) || [])[1] || 0);
  return { pass, fail, skipped };
}

log(`Running the full unit suite ${REPEATS} time(s) to qualify flakiness.`);
const results = [];
let failures = 0;

for (let i = 1; i <= REPEATS; i++) {
  const started = Date.now();
  const r = runSuite();
  const out = (r.stdout || '') + '\n' + (r.stderr || '');
  const summary = parseSummary(out);
  const ok = r.status === 0 && summary.fail === 0 && summary.pass > 0;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ repetition: i, ok, exitCode: r.status, ...summary, seconds: Number(secs) });
  if (ok) {
    log(`  repetition ${i}/${REPEATS}: PASS (${summary.pass} pass / ${summary.skipped} skipped, ${secs}s)`);
  } else {
    failures++;
    log(`  repetition ${i}/${REPEATS}: FAIL (exit ${r.status}, ${summary.fail} failed test(s), ${secs}s)`);
    // Keep the failing tail so the flaky test can actually be diagnosed.
    const tail = out.split('\n').filter((l) => /not ok|fail/i.test(l)).slice(0, 40);
    for (const line of tail) log('    ' + line);
  }
}

// Evidence artifact for the release record.
try {
  const reportDir = path.join(ROOT, 'coverage');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'flakiness-report.json'), JSON.stringify({
    repeats: REPEATS,
    failures,
    verdict: failures === 0 ? 'STABLE' : 'FLAKY',
    results,
    at: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');
} catch (_) { /* report writing must not mask the verdict */ }

if (failures > 0) {
  log(`FAIL: ${failures} of ${REPEATS} repetitions failed — the suite is flaky and cannot qualify a release.`);
  process.exit(1);
}
log(`PASS: ${REPEATS}/${REPEATS} repetitions green — no flakiness detected.`);
