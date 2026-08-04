// tests/unit/scripts/checkUnitCoverage.rq104.test.js
// ============================================================================
// V104-B003: contract for the full-metric coverage gate. Pins the table
// parser, the aggregate floors, the per-file critical rule (100% without
// waiver, waived floors minus tolerance), and the waiver-matrix shape.
// ============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { parseCoverageTable, evaluateGate, CRITICAL_FILES } = require(path.join(ROOT, 'scripts', 'check-unit-coverage.js'));

const WAIVERS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'coverage-waivers.json'), 'utf8'));

const TABLE = [
  'ℹ file                | line % | branch % | funcs % | uncovered lines',
  'ℹ --------------------------------------------------------------------',
  'ℹ  providersStore.js  |  79.00 |    79.00 |   82.00 |',
  'ℹ  cpuGuard.js        | 100.00 |    76.00 |  100.00 |',
  'ℹ  mystery.js         |  40.00 |    40.00 |   40.00 |',
  'ℹ --------------------------------------------------------------------',
  'ℹ all files           |  60.00 |    70.00 |   35.00 |',
  'ℹ --------------------------------------------------------------------',
].join('\n');

function opts(overrides = {}) {
  return {
    lineThreshold: 50,
    branchThreshold: 60,
    functionThreshold: 30,
    waivers: WAIVERS,
    criticalFiles: ['providersStore.js', 'cpuGuard.js'],
    ...overrides,
  };
}

test('parseCoverageTable extracts aggregate and per-file rows', () => {
  const parsed = parseCoverageTable(TABLE);
  assert.deepEqual(parsed.aggregate, { line: 60, branch: 70, function: 35 });
  const names = parsed.files.map((f) => f.name);
  assert.ok(names.includes('providersStore.js'));
  assert.ok(names.includes('cpuGuard.js'));
  assert.ok(!names.includes('all files'), 'the aggregate row is not a file row');
  const store = parsed.files.find((f) => f.name === 'providersStore.js');
  assert.equal(store.branch, 79);
});

test('aggregate floors fail below threshold on every metric', () => {
  const parsed = parseCoverageTable(TABLE);
  const r = evaluateGate(parsed, opts({ lineThreshold: 61, branchThreshold: 60, functionThreshold: 30 }));
  assert.ok(!r.pass);
  assert.ok(r.failures.some((f) => /aggregate line coverage/.test(f)));

  const r2 = evaluateGate(parsed, opts({ functionThreshold: 36 }));
  assert.ok(r2.failures.some((f) => /aggregate function coverage/.test(f)));

  const r3 = evaluateGate(parsed, opts({ branchThreshold: 71 }));
  assert.ok(r3.failures.some((f) => /aggregate branch coverage/.test(f)));
});

test('waived critical file passes at its waived floor minus tolerance', () => {
  const parsed = parseCoverageTable(TABLE);
  // providersStore waiver floors: 78/78/81 minus tolerance 5 = 73/73/76.
  const r = evaluateGate(parsed, opts());
  const row = r.evidence.critical.find((c) => c.file === 'providersStore.js');
  assert.ok(row.waived, 'providersStore.js must be governed by a waiver');
  assert.ok(row.pass);
});

test('waived critical file FAILS below its waived floor minus tolerance', () => {
  const low = TABLE.replace('79.00 |    79.00 |   82.00', '70.00 |    70.00 |   70.00');
  const parsed = parseCoverageTable(low);
  const r = evaluateGate(parsed, opts());
  assert.ok(!r.pass);
  assert.ok(r.failures.some((f) => /providersStore\.js/.test(f) && /waived/.test(f)));
});

test('critical file WITHOUT a waiver must be 100/100/100', () => {
  const parsed = parseCoverageTable(TABLE);
  const r = evaluateGate(parsed, opts({ criticalFiles: ['mystery.js'] }));
  assert.ok(!r.pass);
  assert.ok(r.failures.some((f) => /mystery\.js \(NO waiver\)/.test(f)));
});

test('critical file absent from the coverage table fails the gate', () => {
  const parsed = parseCoverageTable(TABLE);
  const r = evaluateGate(parsed, opts({ criticalFiles: ['neverLoaded.js'] }));
  assert.ok(!r.pass);
  assert.ok(r.failures.some((f) => /neverLoaded\.js has no coverage row/.test(f)));
});

test('waiver matrix is valid JSON covering every non-100 critical file shape', () => {
  assert.ok(Number.isFinite(WAIVERS.noiseTolerancePoints));
  for (const [name, w] of Object.entries(WAIVERS.files)) {
    assert.ok(CRITICAL_FILES.includes(name), `waiver for non-critical file: ${name}`);
    for (const metric of ['line', 'branch', 'function']) {
      assert.ok(typeof w[metric] === 'number' && w[metric] > 0 && w[metric] <= 100, `${name}.${metric} must be a percentage`);
    }
    assert.ok(w.reason && w.reason.length > 10, `${name} must document a reason`);
    assert.ok(w.remediation && w.remediation.length > 10, `${name} must document a remediation`);
  }
});

test('every waived critical file is on the critical list (no orphan waivers)', () => {
  for (const name of Object.keys(WAIVERS.files)) {
    assert.ok(CRITICAL_FILES.includes(name), `orphan waiver entry: ${name}`);
  }
});

test('evidence payload carries thresholds, aggregate and per-file decisions', () => {
  const parsed = parseCoverageTable(TABLE);
  const r = evaluateGate(parsed, opts());
  assert.ok(r.evidence.thresholds.line === 50);
  assert.deepEqual(r.evidence.aggregate, { line: 60, branch: 70, function: 35 });
  assert.ok(Array.isArray(r.evidence.critical) && r.evidence.critical.length >= 2);
  assert.ok(r.evidence.generatedAt);
});
