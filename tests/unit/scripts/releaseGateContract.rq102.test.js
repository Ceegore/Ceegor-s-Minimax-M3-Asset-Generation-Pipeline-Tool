// tests/unit/scripts/releaseGateContract.rq102.test.js
// ============================================================================
// RQ-004 fix: workflow CONTRACT test for .github/workflows/release-gate.yml.
//
// The release-qualification audit found the release workflow omitting
// mandatory gates (packaged E2E, installer, flakiness, mutation, coverage
// GATE, clean-VM acceptance) and publishing without depending on all of
// them. This contract pins the required gate inventory so a future edit
// cannot silently remove a gate or detach publication from it:
//
//   1. Every mandatory gate job exists.
//   2. release-publication lists EVERY gate in its `needs`.
//   3. RQ-008: the coverage GATE runs after coverage collection.
//   4. RQ-002: signing material goes to RUNNER_TEMP / MINISIGN_PUB_PATH,
//      a second clean-tree assertion runs before the build, and the
//      provenance is asserted against the triggering SHA afterwards.
//   5. Every npm script the workflow invokes actually exists (no dead
//      gates that can never fail).
// ============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const wfPath = path.join(ROOT, '.github', 'workflows', 'release-gate.yml');
const wf = fs.readFileSync(wfPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// js-yaml arrives transitively via electron-builder. It is required here on
// purpose: the v1.0.3 tag once failed on GitHub with ZERO diagnostics
// because an unquoted ": " in a step name made the workflow unparseable.
// If the dependency ever disappears, this test must fail loudly instead of
// silently skipping the parse check.
let yaml = null;
try { yaml = require('js-yaml'); } catch (_) { yaml = null; }

// Very small structural slice helper: returns the text of one top-level job
// block (from its key until the next same-or-higher-indented key).
function jobBlock(jobId) {
  const re = new RegExp(`^  ${jobId}:\\s*\\n[\\s\\S]*?(?=^  \\S|$(?![\\s\\S]))`, 'm');
  const m = wf.match(re);
  return m ? m[0] : '';
}

const GATES = [
  'qualification',
  'e2e-and-smoke',
  'flakiness',
  'mutation',
  'build-sign-verify',
  'clean-vm-acceptance',
];

test('RQ-004: every mandatory gate job exists in release-gate.yml', () => {
  for (const job of [...GATES, 'release-publication']) {
    assert.ok(jobBlock(job).length > 0, `missing mandatory job: ${job}`);
  }
});

test('RQ-004: publication depends on ALL gate jobs (no detached gate)', () => {
  const pub = jobBlock('release-publication');
  const needsLine = pub.split('\n').find((l) => /^\s*needs:/.test(l));
  assert.ok(needsLine, 'release-publication must declare needs');
  for (const job of GATES) {
    assert.ok(needsLine.includes(job), `release-publication.needs must include ${job}`);
  }
});

test('RQ-004: gate jobs carry their mandatory commands', () => {
  assert.match(jobBlock('qualification'), /npm run lint/, 'lint gate');
  assert.match(jobBlock('qualification'), /npm run test:coverage\b/, 'coverage collection');
  assert.match(jobBlock('qualification'), /npm run test:contract/, 'contract gate');
  assert.match(jobBlock('qualification'), /npm run test:ipc-coverage/, 'IPC coverage gate');
  assert.match(jobBlock('e2e-and-smoke'), /npm run test:e2e/, 'packaged E2E gate');
  assert.match(jobBlock('e2e-and-smoke'), /npm run test:smoke/, 'smoke gate');
  assert.match(jobBlock('flakiness'), /npm run test:flaky/, 'flakiness gate');
  assert.match(jobBlock('mutation'), /npm run test:mutation/, 'mutation gate');
  assert.match(jobBlock('build-sign-verify'), /npm run assert:identity/, 'identity assertion');
  assert.match(jobBlock('build-sign-verify'), /npm run verify:release/, 'strict verification');
  // RR2-H001 (recheck-2): clean-VM acceptance is NODE-FREE. A pure
  // PowerShell harness drives the shipped CMD installer, boots the packaged
  // app over CDP, proves a real offline function with the bundled ffprobe,
  // and runs a real old->new upgrade plus interrupt/tamper phases. A Node
  // runtime or dev dependencies on the acceptance VM would invalidate the
  // "standard machine" proof.
  assert.match(jobBlock('clean-vm-acceptance'), /clean-vm-acceptance\.ps1/, 'node-free PowerShell acceptance harness');
  assert.match(jobBlock('clean-vm-acceptance'), /MINIMAX_PREV_RELEASE_DIR/, 'real previous-release upgrade must be wired into the harness');
  assert.doesNotMatch(jobBlock('clean-vm-acceptance'), /uses:\s*actions\/setup-node/, 'clean-VM acceptance must not install Node');
  assert.doesNotMatch(jobBlock('clean-vm-acceptance'), /npm ci/, 'clean-VM acceptance must not install dev dependencies');
});

test('V104-H002: flakiness gate runs the full suite under varied conditions', () => {
  const job = jobBlock('flakiness');
  assert.match(job, /FLAKY_REPEATS: '10'/, 'ten repetitions of the release-suite inventory');
  assert.match(job, /FLAKY_HIGH_RISK_REPEATS: '50'/, 'fifty high-risk repetitions must be configured');
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'flakiness-run.js'), 'utf8');
  assert.match(src, /--test-concurrency=1/, 'a serial unit run must surface order effects');
  assert.match(src, /run-smoke\.js/, 'the smoke suite must be part of every repetition');
  assert.match(src, /e2e\/launch\.js/, 'the E2E suite must be part of every repetition');
  assert.match(src, /mutation-test\.js/, 'the high-risk battery must reuse the mutation regression suites');
  assert.match(src, /% 2/, 'high-risk runs must alternate concurrency (varied conditions)');
});

test('V104-H001: the mutation battery is systematic, not a directed sample', () => {
  const { MUTANTS, SUITES } = require(path.join(ROOT, 'scripts', 'mutation-test.js'));
  assert.ok(MUTANTS.length >= 15, `the battery must carry at least 15 mutants (found ${MUTANTS.length})`);
  const targetedFiles = new Set(MUTANTS.map((m) => m.file));
  assert.ok(targetedFiles.size >= 10, `mutants must span at least 10 modules (found ${targetedFiles.size})`);
  assert.ok(Object.keys(SUITES).length >= 10, 'every targeted module needs a dedicated regression suite');
  for (const m of MUTANTS) {
    assert.ok(Array.isArray(SUITES[m.file]) && SUITES[m.file].length > 0,
      `mutant ${m.id} targets ${m.file}, which has no regression suite mapped`);
  }
});

test('V104-C002: inventory finalization runs after SBOM and before signing', () => {
  const b = jobBlock('build-sign-verify');
  const sbom = b.indexOf('scripts/generate-sbom.js');
  const finalize = b.indexOf('npm run finalize:release');
  const sign = b.indexOf('npm run sign:release');
  assert.ok(sbom !== -1, 'SBOM generation step must exist');
  assert.ok(finalize !== -1, 'finalize:release step must exist');
  assert.ok(sign !== -1, 'sign:release step must exist');
  assert.ok(sbom < finalize, 'inventory finalization must run AFTER SBOM generation');
  assert.ok(finalize < sign, 'inventory finalization must run BEFORE manifest signing');
  assert.match(b, /MINISIGN_TOOL_PATH/, 'the pinned minisign verifier must ship with the release');
});

test('V104-C002: publication stages ONLY the signed inventory', () => {
  const pub = jobBlock('release-publication');
  assert.match(pub, /npm run stage:publication/, 'publication must stage from the signed inventory');
  assert.match(pub, /dist-out\/publication\//, 'publication must upload the staged inventory, not all of dist-out');
  const uploadIdx = pub.indexOf('npm run stage:publication');
  const uploadPath = pub.indexOf('path: dist-out/publication/');
  assert.ok(uploadPath > uploadIdx, 'staging must run before the upload');
});

test('RQ-008: the coverage GATE runs after coverage collection', () => {
  const q = jobBlock('qualification');
  const collectM = q.match(/npm run test:coverage(?![\w:.-])/);
  const gate = q.indexOf('npm run test:coverage:gate');
  assert.ok(collectM, 'test:coverage collection step must exist');
  assert.ok(gate !== -1, 'test:coverage:gate step must exist');
  assert.ok(gate > collectM.index, 'the coverage gate must run AFTER collection');
});

test('RQ-002: signing material never lands in the repository worktree', () => {
  const b = jobBlock('build-sign-verify');
  assert.match(b, /RUNNER_TEMP/, 'public key must be written under RUNNER_TEMP');
  assert.match(b, /MINISIGN_PUB_PATH/, 'scripts must consume the pub key via MINISIGN_PUB_PATH');
  assert.doesNotMatch(b, /Set-Content[^]*?minisign\.pub[^\n]*\n[^\n]*-Path \$env:GITHUB_WORKSPACE/, 'no worktree pub-key write');
});

test('RQ-002: clean tree is re-asserted immediately before the build', () => {
  const b = jobBlock('build-sign-verify');
  const reAssert = b.indexOf('git status --porcelain');
  const build = b.indexOf('scripts/zip-portable.js');
  assert.ok(reAssert !== -1, 'a git status --porcelain assertion must exist in the build job');
  assert.ok(build !== -1, 'the portable build step must exist');
  assert.ok(reAssert < build, 'the clean-tree assertion must run BEFORE the build');
});

test('RQ-002: provenance is asserted against the triggering SHA after build', () => {
  const b = jobBlock('build-sign-verify');
  const build = b.indexOf('scripts/zip-portable.js');
  // $p.commitDirty is the actual assertion expression; the bare word also
  // appears in explanatory comments before the build, so anchor on the var.
  const prov = b.indexOf('$p.commitDirty');
  assert.ok(prov !== -1, 'a provenance commitDirty assertion must exist');
  assert.ok(prov > build, 'the provenance assertion must run AFTER the build');
  assert.match(b, /GITHUB_SHA/, 'provenance must be compared against the triggering SHA');
});

test('RQ-004: every npm script the workflow invokes actually exists', () => {
  const invoked = [...wf.matchAll(/npm run ([\w:.-]+)/g)].map((m) => m[1]);
  assert.ok(invoked.length >= 10, 'sanity: the workflow must invoke npm scripts');
  for (const script of new Set(invoked)) {
    assert.ok(pkg.scripts && pkg.scripts[script], `workflow invokes missing npm script: ${script}`);
  }
});

test('RQ-004: every workflow file parses as valid YAML with a job graph', () => {
  assert.ok(yaml, 'js-yaml must be resolvable (transitive via electron-builder) to validate workflow syntax');
  const dir = path.join(ROOT, '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0, 'sanity: workflow files must exist');
  for (const f of files) {
    let doc = null;
    try { doc = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (e) { assert.fail(`workflow ${f} is not parseable YAML — GitHub will reject every run with no diagnostics: ${e.message}`); }
    assert.ok(doc && typeof doc === 'object', `workflow ${f} must be a mapping`);
    assert.ok(doc.jobs && Object.keys(doc.jobs).length > 0, `workflow ${f} must define at least one job`);
    // An unquoted ": " inside a plain step/job name is the exact shape
    // that broke the v1.0.3 release run; flag it directly.
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const bad = src.split(/\r?\n/).filter((l) => /^\s*(?:-\s*)?name:\s+[^"'\s][^"']*:\s/.test(l));
    assert.equal(bad.length, 0, `workflow ${f} has unquoted names containing \": \": ${bad.join(' | ')}`);
  }
});
