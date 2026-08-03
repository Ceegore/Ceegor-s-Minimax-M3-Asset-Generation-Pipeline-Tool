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
  assert.match(jobBlock('clean-vm-acceptance'), /npm run test:packaged/, 'packaged boot on clean VM');
  assert.match(jobBlock('clean-vm-acceptance'), /npm run test:installer/, 'installer acceptance on clean VM');
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
