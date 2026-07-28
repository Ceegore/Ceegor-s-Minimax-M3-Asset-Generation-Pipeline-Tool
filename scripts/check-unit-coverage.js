// scripts/check-unit-coverage.js
// ============================================================================
// Phase F4 — Unit line-coverage threshold gate.
//
// Runs the full unit suite with Node's built-in coverage
// (--experimental-test-coverage), parses the "all files" summary line and
// fails (exit 1) if line coverage drops below the threshold. This turns the
// previously advisory line-coverage number into a hard CI gate, so a large
// drop in tested code can never ship silently.
//
// Run:  node scripts/check-unit-coverage.js [--threshold=50]
//       (default threshold: 50%)
//
// Calibration note: as of 2026-07-25 the suite's line coverage is ~54.6%.
// The gate is intentionally set BELOW the current level (50%) so it acts as
// a regression guard (catches meaningful drops) without failing CI today.
// Ratchet the threshold UP over time as coverage improves — never down.
// ============================================================================

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Parse --threshold=N from CLI args (default 50%).
const thresholdArg = process.argv.find((a) => a.startsWith('--threshold='));
const THRESHOLD = thresholdArg ? parseFloat(thresholdArg.split('=')[1]) : 50;

function log(m) { process.stdout.write(`[unit-coverage] ${m}\n`); }

// KNOWN FALSE POSITIVE: spawnSync here launches ONLY the Node binary
// (process.execPath) with fixed test-runner flags and a fixed glob — it is
// NOT arbitrary command execution. Node expands the glob for --test itself.
// See scripts/e2e/harness.js header for the full false-positives reference.
const r = spawnSync(
  process.execPath,
  ['--test', '--experimental-test-coverage', 'tests/unit/**/*.test.js'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
);

if (r.error) {
  log('FATAL: failed to launch the unit suite: ' + r.error.message);
  process.exit(1);
}

const out = (r.stdout || '') + '\n' + (r.stderr || '');

// The coverage summary line looks like:
//   "ℹ all files         | 100.00 |   100.00 |  100.00 | "
// We want the FIRST numeric column (line %) of the "all files" row.
let linePct = null;
for (const raw of out.split(/\r?\n/)) {
  const line = raw.replace(/^[\u2139#]\s*/, '').trim(); // strip the "ℹ" or "#" info marker (Node 22 uses '#')
  if (!/^all files\b/i.test(line)) continue;
  const cols = line.split('|').map((c) => c.trim());
  // cols[0] = "all files", cols[1] = line %, cols[2] = branch %, cols[3] = funcs %
  const parsed = parseFloat(cols[1]);
  if (!Number.isNaN(parsed)) { linePct = parsed; break; }
}

if (linePct === null) {
  log('FATAL: could not locate the "all files" coverage summary in the output.');
  log('The unit suite may have crashed before emitting coverage. Last 15 lines:');
  const tail = out.split(/\r?\n/).slice(-15).join('\n');
  process.stdout.write(tail + '\n');
  process.exit(1);
}

log(`Unit line coverage: ${linePct}% (threshold: ${THRESHOLD}%)`);

// A non-zero exit from the test run itself means failing tests — always fail.
if (r.status !== 0) {
  log('FATAL: the unit suite itself failed (non-zero exit). See output above.');
  process.exit(1);
}

// KGO7-021 — a ratchet was built here, MEASURED, and deliberately removed.
//
// The original finding claimed coverage was sliding (56.02 % run 11 ->
// 55.8 % -> 53.75 % -> 52.95 % run 14) and proposed a ratchet so it could
// only go up. Building it exposed the flaw in that premise: this metric is
// NOT reproducible. Six consecutive runs on an UNCHANGED tree reported
//
//     53.72   53.85   53.97   54.50   56.01      (parallel runner)
//     54.12   56.41   53.24                      (--test-concurrency=1)
//
// — roughly ±3 points of noise, present with serial execution too, so it
// is not a scheduling artefact. A ratchet on a metric that noisy pins the
// bar to the luckiest run and then fails every honest one (observed
// immediately: "REGRESSION: 53.24 % < 56.16 %" on an unmodified tree).
//
// The cross-run "decline" the finding was based on therefore sits INSIDE
// the noise band and is not evidence of a real slide.
//
// So: fixed floor, as before. Making a ratchet meaningful requires first
// making the measurement reproducible (a deterministic coverage tool, or
// per-file thresholds on modules that do not spawn child processes) —
// that is a separate piece of work, not a one-line gate change.
if (linePct < THRESHOLD) {
  log(`UNIT COVERAGE GATE FAILED: ${linePct}% < ${THRESHOLD}% threshold`);
  log(`Line coverage must be at least ${THRESHOLD}% to pass CI.`);
  log('NOTE: this metric has ~±3 points of run-to-run noise; a single low');
  log('      reading is not proof of a regression. Re-run before acting.');
  process.exit(1);
}

log(`Unit coverage gate passed: ${linePct}% >= ${THRESHOLD}%`);
process.exit(0);
