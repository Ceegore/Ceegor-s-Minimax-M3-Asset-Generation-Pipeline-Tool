// scripts/check-unit-coverage.js
// ============================================================================
// V104-B003: full-metric unit coverage GATE.
//
// The v1.0.4 requalification rejected a gate that only enforced a 50%
// aggregate LINE floor. This gate enforces:
//
//   1. Aggregate metrics: line, branch AND function coverage floors.
//   2. Per-file CRITICAL rule: every release-critical credential/security
//      module must be 100/100/100 — unless it carries an explicit waiver
//      in scripts/coverage-waivers.json (measured baseline + reason +
//      remediation). Waived floors are enforced minus a documented
//      run-to-run noise tolerance. A critical file without a waiver that
//      is below 100% fails the release.
//   3. Retained evidence: the full metric table (aggregate + per-critical
//      file rows, thresholds, waiver decisions) is written to
//      coverage/unit-coverage-gate.json and uploaded with the other
//      coverage evidence.
//
// Run:  node scripts/check-unit-coverage.js [--threshold=50]
//             [--branch-threshold=60] [--function-threshold=30]
//
// Noise note (KGO7-021): Node's built-in coverage reports vary by roughly
// +/-3 points between identical runs (child-process code paths). Aggregate
// floors therefore sit BELOW the measured level as regression guards, and
// waived per-file floors carry an explicit tolerance. The per-file rule
// targets DETERMINISTIC modules, where the measurement is stable.
//
// KGO7-021 history: the original finding proposed a ratchet. A measured
// noise band of ~56.41 -> ~53 -> ~56 points on an UNCHANGED tree showed a
// ratchet fails every honest run, so the ratchet was deliberately removed
// and replaced by fixed aggregate floors + the per-file critical rule with
// an explicit waiver tolerance (see scripts/coverage-waivers.json).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Release-critical credential/security modules (per-file 100% rule).
const CRITICAL_FILES = [
  'providersStore.js',
  'providersPayloadSchema.js',
  'mmxApiKeySync.js',
  'mmxCredentialBridge.js',
  'deepRedactor.js',
  'mmxResultRedactor.js',
  'stateCorruptBackup.js',
  'stateSanitizers.js',
  'state.js',
  'windowsNamePolicy.js',
  'pathUtils.js',
  'assetPaths.js',
  'config.js',
  'batches.js',
  'jobRegistry.js',
  'cpuGuard.js',
];

function argNum(name, fallback) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return fallback;
  const v = parseFloat(a.split('=')[1]);
  if (Number.isNaN(v)) { log(`FATAL: --${name} is not a number: ${a}`); process.exit(1); }
  return v;
}

function log(m) { process.stdout.write(`[unit-coverage] ${m}\n`); }

// Parse Node's built-in coverage table:
//   file | line % | branch % | funcs % | uncovered lines
// Directory rows carry no numbers; the "all files" row is the aggregate.
// Returns { aggregate: {line,branch,function}, files: [{name,line,branch,function}] }.
function parseCoverageTable(text) {
  const aggregate = { line: null, branch: null, function: null };
  const files = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\u2139#]\s*/, '').trim();
    const m = line.match(/^([\w][\w .-]*?)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
    if (!m) continue;
    const row = {
      name: m[1].trim(),
      line: parseFloat(m[2]),
      branch: parseFloat(m[3]),
      function: parseFloat(m[4]),
    };
    if (/^all files$/i.test(row.name)) {
      aggregate.line = row.line;
      aggregate.branch = row.branch;
      aggregate.function = row.function;
    } else {
      files.push(row);
    }
  }
  return { aggregate, files };
}

// Evaluate the gate against a parsed table. Pure — unit-tested directly.
// Returns { pass, failures: [...], evidence: {...} }.
function evaluateGate(parsed, opts) {
  const { lineThreshold, branchThreshold, functionThreshold, waivers, criticalFiles } = opts;
  const tolerance = (waivers && typeof waivers.noiseTolerancePoints === 'number')
    ? waivers.noiseTolerancePoints : 5;
  const waiverFiles = (waivers && waivers.files) || {};
  const failures = [];

  const agg = parsed.aggregate;
  if (agg.line === null || agg.branch === null || agg.function === null) {
    failures.push('coverage summary missing: the suite may have crashed before emitting metrics');
  } else {
    if (agg.line < lineThreshold) failures.push(`aggregate line coverage ${agg.line}% < ${lineThreshold}% floor`);
    if (agg.branch < branchThreshold) failures.push(`aggregate branch coverage ${agg.branch}% < ${branchThreshold}% floor`);
    if (agg.function < functionThreshold) failures.push(`aggregate function coverage ${agg.function}% < ${functionThreshold}% floor`);
  }

  const criticalRows = [];
  for (const name of criticalFiles) {
    // A filename can map to several modules (same leaf name in different
    // dirs); EVERY matching row must satisfy the rule.
    const rows = parsed.files.filter((f) => f.name === name);
    if (rows.length === 0) {
      failures.push(`critical file ${name} has no coverage row (never loaded by the unit suite)`);
      criticalRows.push({ file: name, missing: true, pass: false });
      continue;
    }
    const waiver = waiverFiles[name] || null;
    const floors = waiver
      ? {
        line: Math.max(0, waiver.line - tolerance),
        branch: Math.max(0, waiver.branch - tolerance),
        function: Math.max(0, waiver.function - tolerance),
      }
      : { line: 100, branch: 100, function: 100 };
    for (const row of rows) {
      const problems = [];
      if (row.line < floors.line) problems.push(`line ${row.line}% < ${floors.line}%`);
      if (row.branch < floors.branch) problems.push(`branch ${row.branch}% < ${floors.branch}%`);
      if (row.function < floors.function) problems.push(`function ${row.function}% < ${floors.function}%`);
      const pass = problems.length === 0;
      if (!pass) {
        failures.push(`critical file ${name} ${waiver ? '(waived)' : '(NO waiver)'}: ${problems.join(', ')}`);
      }
      criticalRows.push({
        file: name,
        line: row.line,
        branch: row.branch,
        function: row.function,
        waived: !!waiver,
        floors,
        pass,
      });
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    evidence: {
      generatedAt: new Date().toISOString(),
      thresholds: { line: lineThreshold, branch: branchThreshold, function: functionThreshold },
      noiseTolerancePoints: tolerance,
      aggregate: agg,
      critical: criticalRows,
    },
  };
}

function loadWaivers(waiverPath) {
  let raw;
  try { raw = fs.readFileSync(waiverPath, 'utf8'); }
  catch (e) { log(`FATAL: cannot read the waiver matrix ${waiverPath}: ${e.message}`); process.exit(1); }
  try { return JSON.parse(raw); }
  catch (e) { log(`FATAL: waiver matrix ${waiverPath} is not valid JSON: ${e.message}`); process.exit(1); }
}

async function main() {
  const lineThreshold = argNum('threshold', 50);
  const branchThreshold = argNum('branch-threshold', 60);
  const functionThreshold = argNum('function-threshold', 30);
  const waiverPath = path.join(ROOT, 'scripts', 'coverage-waivers.json');
  const evidencePath = path.join(ROOT, 'coverage', 'unit-coverage-gate.json');

  // KNOWN FALSE POSITIVE: spawnSync here launches ONLY the Node binary
  // (process.execPath) with fixed test-runner flags and a fixed glob — it
  // is NOT arbitrary command execution. Node expands the glob itself.
  const r = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=6', '--experimental-test-coverage', 'tests/unit/**/*.test.js'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.error) {
    log('FATAL: failed to launch the unit suite: ' + r.error.message);
    process.exit(1);
  }
  // A non-zero exit from the test run itself means failing tests — always
  // fail the gate regardless of what the coverage table says.
  if (r.status !== 0) {
    log('FATAL: the unit suite itself failed (non-zero exit). Coverage gate aborted.');
    log('Last 40 lines of the suite output:');
    process.stdout.write(((r.stdout || '') + '\n' + (r.stderr || '')).split(/\r?\n/).slice(-40).join('\n') + '\n');
    process.exit(1);
  }

  const out = (r.stdout || '') + '\n' + (r.stderr || '');
  const parsed = parseCoverageTable(out);
  if (parsed.aggregate.line === null) {
    log('FATAL: could not locate the "all files" coverage summary in the output.');
    log('Last 15 lines of the suite output:');
    process.stdout.write(out.split(/\r?\n/).slice(-15).join('\n') + '\n');
    process.exit(1);
  }

  const waivers = loadWaivers(waiverPath);
  const result = evaluateGate(parsed, {
    lineThreshold,
    branchThreshold,
    functionThreshold,
    waivers,
    criticalFiles: CRITICAL_FILES,
  });

  log(`aggregate: line ${parsed.aggregate.line}% (floor ${lineThreshold}%) | branch ${parsed.aggregate.branch}% (floor ${branchThreshold}%) | function ${parsed.aggregate.function}% (floor ${functionThreshold}%)`);
  for (const row of result.evidence.critical) {
    if (row.missing) { log(`  critical ${row.file}: MISSING from coverage table`); continue; }
    log(`  critical ${row.file}: line ${row.line}% branch ${row.branch}% funcs ${row.function}% ${row.waived ? '(waived)' : ''} -> ${row.pass ? 'OK' : 'FAIL'}`);
  }

  // Retained evidence: always written, pass or fail, so the release record
  // carries the exact metric table this gate judged.
  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(result.evidence, null, 2) + '\n', 'utf8');
    log(`evidence retained: ${path.relative(ROOT, evidencePath)}`);
  } catch (e) {
    log(`FATAL: could not retain coverage evidence: ${e.message}`);
    process.exit(1);
  }

  if (!result.pass) {
    log('UNIT COVERAGE GATE FAILED:');
    for (const f of result.failures) log('  - ' + f);
    log('NOTE: aggregate metrics carry ~±3 points of run-to-run noise; waived');
    log('      floors already discount that tolerance. Re-run before acting on a');
    log('      single low aggregate reading — per-file critical failures are');
    log('      deterministic and MUST be fixed or explicitly waived.');
    process.exit(1);
  }

  log('Unit coverage gate passed (aggregate floors + per-file critical rule).');
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => { log(`FATAL: ${e.stack || e.message}`); process.exit(1); });
}

module.exports = { parseCoverageTable, evaluateGate, CRITICAL_FILES };
