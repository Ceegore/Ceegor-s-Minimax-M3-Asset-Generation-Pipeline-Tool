// tests/unit/scripts/checkUnitCoverage.rq104.test.js
// ============================================================================
// V104-B003 + RR2-B003: contract for the full-metric coverage gate. Pins
// the table parser, the aggregate floors, the per-file critical rule
// (100% without waiver, EXACT per-metric floors with a narrow waiver),
// the narrow waiver schema (owner/ticket/expiry/substitute evidence), and
// the LCOV/untested-evidence producers.
// ============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const {
  parseCoverageTable, evaluateGate, validateWaiverEntry, parseLcov,
  untestedEvidence, CRITICAL_FILES,
} = require(path.join(ROOT, 'scripts', 'check-unit-coverage.js'));

const WAIVERS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'coverage-waivers.json'), 'utf8'));

const TABLE = [
  'ℹ file                | line % | branch % | funcs % | uncovered lines',
  'ℹ --------------------------------------------------------------------',
  'ℹ  providersStore.js  |  79.00 |    79.00 |  100.00 |',
  'ℹ  cpuGuard.js        | 100.00 |   100.00 |  100.00 |',
  'ℹ  mystery.js         |  40.00 |    40.00 |   40.00 |',
  'ℹ --------------------------------------------------------------------',
  'ℹ all files           |  60.00 |    70.00 |   35.00 |',
  'ℹ --------------------------------------------------------------------',
].join('\n');

const FAR_FUTURE = '2999-01-01';

function narrowWaiver(overrides = {}) {
  return {
    owner: 'Ceegor',
    ticket: 'RR2-B003',
    expiry: FAR_FUTURE,
    reason: 'Documented unit-unreachable branches in this module.',
    substituteEvidence: 'E2E suite exercises the waived branches against the real OS.',
    remediation: 'Inject the IO layer and cover the remaining branches.',
    waivers: [
      { metric: 'line', floor: 78, uncoveredLines: [42, 43] },
      { metric: 'branch', floor: 78, uncoveredBranches: ['55:0.1'] },
    ],
    ...overrides,
  };
}

function opts(overrides = {}) {
  return {
    lineThreshold: 50,
    branchThreshold: 60,
    functionThreshold: 30,
    waivers: { files: { 'providersStore.js': narrowWaiver() } },
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

test('RR2-B003: waived metrics pass at their EXACT floor (no blanket tolerance)', () => {
  const parsed = parseCoverageTable(TABLE);
  // providersStore measures 79/79; waiver floors are 78/78 -> pass.
  const r = evaluateGate(parsed, opts());
  const row = r.evidence.critical.find((c) => c.file === 'providersStore.js');
  assert.deepEqual(row.waived, ['line', 'branch']);
  assert.ok(row.pass);

  // Raise the floor to exactly the measured value: still passes.
  const tight = opts({ waivers: { files: { 'providersStore.js': narrowWaiver({ waivers: [{ metric: 'line', floor: 79 }, { metric: 'branch', floor: 79 }] }) } } });
  assert.ok(evaluateGate(parsed, tight).pass);

  // One point above the measurement fails: there is NO tolerance.
  const over = opts({ waivers: { files: { 'providersStore.js': narrowWaiver({ waivers: [{ metric: 'line', floor: 80 }, { metric: 'branch', floor: 78 }] }) } } });
  const rOver = evaluateGate(parsed, over);
  assert.ok(!rOver.pass);
  assert.ok(rOver.failures.some((f) => /providersStore\.js/.test(f) && /line 79% < 80%/.test(f)));
});

test('RR2-B003: an UNWAIVED metric is still held at 100% on a waived file', () => {
  const parsed = parseCoverageTable(TABLE);
  // Waive only line+branch: function must be 100 — and is (100.00) -> pass.
  assert.ok(evaluateGate(parsed, opts()).pass);
  // Drop the function measurement below 100 with no function waiver -> fail.
  const low = TABLE.replace('79.00 |    79.00 |  100.00', '79.00 |    79.00 |   90.00');
  const r = evaluateGate(parseCoverageTable(low), opts());
  assert.ok(!r.pass);
  assert.ok(r.failures.some((f) => /function 90% < 100% \(NOT waived\)/.test(f)));
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

test('RR2-B003: malformed waivers fail the gate', () => {
  const parsed = parseCoverageTable(TABLE);
  const cases = [
    [{ owner: '', }, /must document owner/],
    [{ ticket: '  ' }, /must document ticket/],
    [{ expiry: 'someday' }, /expiry date/],
    [{ expiry: '2020-01-01' }, /expired/],
    [{ substituteEvidence: 'x' }, /must document substituteEvidence/],
    [{ remediation: 'short' }, /must document remediation/],
    [{ waivers: [] }, /individually waived metrics/],
    [{ waivers: [{ metric: 'entropy', floor: 50 }] }, /unknown metric/],
    [{ waivers: [{ metric: 'line', floor: 100 }] }, /100 needs no waiver/],
    [{ waivers: [{ metric: 'line', floor: 50 }, { metric: 'line', floor: 60 }] }, /twice/],
  ];
  for (const [patch, re] of cases) {
    const w = narrowWaiver(patch);
    if (patch.waivers) w.waivers = patch.waivers;
    const problems = validateWaiverEntry('x.js', w);
    assert.ok(problems.some((p) => re.test(p)), `expected ${re} for ${JSON.stringify(patch)}; got ${problems.join('; ')}`);
    const r = evaluateGate(parsed, opts({ waivers: { files: { 'providersStore.js': w } } }));
    assert.ok(!r.pass, `gate must fail for ${JSON.stringify(patch)}`);
  }
});

test('RR2-B003: repo waiver matrix is narrow, owned, time-boxed and critical-only', () => {
  const names = Object.keys(WAIVERS.files);
  assert.ok(names.length > 0, 'waiver matrix exists');
  assert.ok(names.length < CRITICAL_FILES.length, 'RR2-B003: NOT every critical file may be waived — the 100% rule must govern at least one file');
  for (const [name, w] of Object.entries(WAIVERS.files)) {
    assert.ok(CRITICAL_FILES.includes(name), `orphan waiver entry: ${name}`);
    assert.deepEqual(validateWaiverEntry(name, w), [], `${name} waiver must be structurally valid`);
    for (const item of w.waivers) {
      assert.ok(item.floor < 100, `${name}.${item.metric}: a 100 floor needs no waiver`);
    }
  }
  // De-waived files must not reappear in the matrix.
  assert.ok(!WAIVERS.files['cpuGuard.js'], 'cpuGuard.js is de-waived (RR2-B003)');
  assert.ok(!WAIVERS.files['mmxCredentialBridge.js'], 'mmxCredentialBridge.js is de-waived (RR2-B003)');
});

test('RR2-B003: parseLcov extracts untested lines and branches', () => {
  const lcov = [
    'TN:', 'SF:src/example.js',
    'FN:1,foo', 'FNDA:1,foo', 'FNF:1', 'FNH:1',
    'BRDA:5,0,0,3', 'BRDA:5,0,1,-', 'BRF:2', 'BRH:1',
    'DA:1,1', 'DA:2,5', 'DA:7,0', 'LF:3', 'LH:2',
    'end_of_record',
  ].join('\n');
  const files = parseLcov(lcov);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].uncoveredLines, [7]);
  assert.deepEqual(files[0].uncoveredBranches, ['5:0.1']);
  assert.equal(files[0].totalLines, 3);
  assert.equal(files[0].coveredLines, 2);
});

test('RR2-B003: untestedEvidence groups by leaf filename', () => {
  const lcov = parseLcov([
    'SF:src/a/state.js', 'DA:1,1', 'DA:2,0', 'end_of_record',
    'SF:src/b/state.js', 'DA:9,0', 'BRDA:9,1,0,0', 'end_of_record',
  ].join('\n'));
  const ev = untestedEvidence(lcov, ['state.js', 'missing.js']);
  assert.deepEqual(ev['state.js'].uncoveredLines, [2, 9]);
  assert.deepEqual(ev['state.js'].uncoveredBranches, ['9:1.0']);
  assert.equal(ev['state.js'].sources.length, 2);
  assert.deepEqual(ev['missing.js'].uncoveredLines, []);
});

test('evidence payload carries thresholds, aggregate and per-file decisions', () => {
  const parsed = parseCoverageTable(TABLE);
  const r = evaluateGate(parsed, opts());
  assert.ok(r.evidence.thresholds.line === 50);
  assert.deepEqual(r.evidence.aggregate, { line: 60, branch: 70, function: 35 });
  assert.ok(Array.isArray(r.evidence.critical) && r.evidence.critical.length >= 2);
  assert.ok(r.evidence.generatedAt);
  const row = r.evidence.critical.find((c) => c.file === 'providersStore.js');
  assert.equal(row.waiverMeta.ticket, 'RR2-B003');
});

// ---------------------------------------------------------------------------
// Signing-migration Phase 0: waiver-scope honouring. A waived metric that
// dips below its stated floor under Node's ±3-point coverage noise must not
// fail the release when the MEASURED uncovered set is exactly the waiver's
// documented scope. Any undocumented gap keeps the strict floor.
// ---------------------------------------------------------------------------
test('waiver scope: a floor dip is honoured when every uncovered line/branch is documented', () => {
  // providersStore measures 79/79 but the floors are pushed to 85 so BOTH
  // waived metrics dip — exactly the noise window that flaked the old gate.
  const parsed = parseCoverageTable(TABLE);
  const tight = opts({ waivers: { files: { 'providersStore.js': narrowWaiver({ waivers: [
    { metric: 'line', floor: 85, uncoveredLines: [42, 43] },
    { metric: 'branch', floor: 85, uncoveredBranches: ['55:0.1'] },
  ] }) } } });
  // Without evidence the strict floors govern (no silent tolerance).
  assert.ok(!evaluateGate(parsed, tight).pass);
  // With evidence that matches the documented scope exactly: honoured.
  // Aggregate floors are lowered so ONLY the waiver-scope decision is tested.
  const untested = {
    'providersStore.js': {
      sources: ['src/providersStore.js'],
      perSource: [{ uncoveredLines: [42, 43], uncoveredBranches: ['55:0.1'] }],
      uncoveredLines: [42, 43],
      uncoveredBranches: ['55:0.1'],
    },
  };
  const r = evaluateGate(parsed, { ...tight, lineThreshold: 50, branchThreshold: 60, functionThreshold: 30, untested });
  assert.ok(r.pass, 'scope-identical dip must be honoured: ' + r.failures.join('; '));
  const row = r.evidence.critical.find((c) => c.file === 'providersStore.js');
  assert.deepEqual(row.scopeHonoured.sort(), ['branch', 'line']);
});

test('waiver scope: an UNDOCUMENTED uncovered line/branch keeps the strict floor', () => {
  const parsed = parseCoverageTable(TABLE);
  const tight = opts({ waivers: { files: { 'providersStore.js': narrowWaiver({ waivers: [
    { metric: 'line', floor: 85, uncoveredLines: [42, 43] },
    { metric: 'branch', floor: 85, uncoveredBranches: ['55:0.1'] },
  ] }) } } });
  const untested = {
    'providersStore.js': {
      sources: ['src/providersStore.js'],
      perSource: [{ uncoveredLines: [42, 43, 999], uncoveredBranches: ['55:0.1'] }],
      uncoveredLines: [42, 43, 999],
      uncoveredBranches: ['55:0.1'],
    },
  };
  const r = evaluateGate(parsed, { ...tight, untested });
  assert.ok(!r.pass, 'a new uncovered line outside the waiver scope must fail');
  assert.ok(r.failures.some((f) => /line 79% < 85%/.test(f)));
});

test('waiver scope: a same-leaf module cannot hide behind another module’s waiver', () => {
  const parsed = parseCoverageTable(TABLE);
  const tight = opts({ waivers: { files: { 'providersStore.js': narrowWaiver({ waivers: [
    { metric: 'line', floor: 85, uncoveredLines: [42, 43] },
    { metric: 'branch', floor: 85, uncoveredBranches: ['55:0.1'] },
  ] }) } } });
  // Two modules share the leaf name; for BOTH metrics EVERY single source
  // carries at least one gap outside the documented scope, so no source may
  // be scope-honoured and the strict floor must govern.
  const untested = {
    'providersStore.js': {
      sources: ['src/a/providersStore.js', 'src/b/providersStore.js'],
      perSource: [
        { uncoveredLines: [42, 888], uncoveredBranches: ['55:0.1', '77:9.9'] },
        { uncoveredLines: [43, 999], uncoveredBranches: ['12:3.4'] },
      ],
      uncoveredLines: [42, 43, 888, 999],
      uncoveredBranches: ['55:0.1', '77:9.9', '12:3.4'],
    },
  };
  const r = evaluateGate(parsed, { ...tight, untested });
  assert.ok(!r.pass, 'leaf-name collisions must not dilute the waiver scope');
  assert.ok(r.failures.some((f) => /line 79% < 85%/.test(f)));
  assert.ok(r.failures.some((f) => /branch 79% < 85%/.test(f)));
});
