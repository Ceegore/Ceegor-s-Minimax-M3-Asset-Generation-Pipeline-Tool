'use strict';

// H-012/H-013 (hhhhu3 audit): crash-window regression tests for the runtime
// activation state machine. An interrupted activation must NEVER be committed
// without verification, and the known-good backup must survive recovery.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RuntimeInstaller } = require('../../../scripts/lib/RuntimeInstaller');

function makeProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-installer-test-'));
  const activePath = path.join(projectRoot, 'bin');
  fs.mkdirSync(activePath, { recursive: true });
  fs.writeFileSync(path.join(activePath, 'old-runtime.txt'), 'OLD', 'utf8');
  const installer = new RuntimeInstaller({ projectRoot, runtimeDir: 'bin' });
  const markerPath = path.join(projectRoot, '.setup-transaction.json');
  const readMarker = () => JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const writeMarkerState = (state) => {
    const m = readMarker();
    m.state = state;
    fs.writeFileSync(markerPath, JSON.stringify(m, null, 2), 'utf8');
  };
  return { projectRoot, activePath, installer, markerPath, readMarker, writeMarkerState };
}

function rmProject(projectRoot) {
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch (_) {}
}

// Drive a transaction to ACTIVATED: stage verified, old bin backed up,
// stage renamed to active.
function reachActivated(ctx) {
  const { installer } = ctx;
  const { transactionId, stagePath } = installer.begin();
  fs.writeFileSync(path.join(stagePath, 'new-runtime.txt'), 'NEW', 'utf8');
  installer.verifyStage(transactionId, () => true);
  installer.activate(transactionId);
  return transactionId;
}

test('H-012: ACTIVATING crash with active present is verified before commit', () => {
  const ctx = makeProject();
  try {
    const { installer, activePath, markerPath, writeMarkerState } = ctx;
    reachActivated(ctx);
    writeMarkerState('ACTIVATING'); // simulate crash before ACTIVATED marker

    // Failing verifier: unverified active must be rolled back to the backup.
    const r = installer.recover({ verifyFn: () => false });
    assert.equal(r.recovered, true);
    assert.equal(r.action, 'rolled-back-unverified-activation');
    assert.ok(fs.existsSync(path.join(activePath, 'old-runtime.txt')), 'backup must be restored');
    assert.ok(!fs.existsSync(path.join(activePath, 'new-runtime.txt')), 'unverified active must not stay live');
    assert.ok(!fs.existsSync(markerPath), 'marker must be removed');
  } finally {
    rmProject(ctx.projectRoot);
  }
});

test('H-012: ACTIVATING crash is committed when the verifier passes', () => {
  const ctx = makeProject();
  try {
    const { installer, activePath, markerPath, writeMarkerState, readMarker } = ctx;
    reachActivated(ctx);
    const backupPath = readMarker().backupPath;
    writeMarkerState('ACTIVATING');

    const r = installer.recover({ verifyFn: () => true });
    assert.equal(r.action, 'committed-verified-activation');
    assert.ok(fs.existsSync(path.join(activePath, 'new-runtime.txt')));
    assert.ok(!fs.existsSync(backupPath), 'backup is removed only after verification');
    assert.ok(!fs.existsSync(markerPath));
  } finally {
    rmProject(ctx.projectRoot);
  }
});

test('H-012: first-install ACTIVATING crash (no backup) never keeps an unverified runtime', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-installer-test-'));
  const ctx = { projectRoot };
  try {
    // No pre-existing bin/ → first install, no backup.
    const installer = new RuntimeInstaller({ projectRoot, runtimeDir: 'bin' });
    const activePath = path.join(projectRoot, 'bin');
    const { transactionId, stagePath } = installer.begin();
    fs.writeFileSync(path.join(stagePath, 'new-runtime.txt'), 'NEW', 'utf8');
    installer.verifyStage(transactionId, () => true);
    installer.activate(transactionId);
    // Simulate crash: pretend the ACTIVATED marker never got written.
    const markerPath = path.join(projectRoot, '.setup-transaction.json');
    const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    m.state = 'ACTIVATING';
    fs.writeFileSync(markerPath, JSON.stringify(m, null, 2), 'utf8');

    const r = installer.recover({ verifyFn: () => false });
    assert.equal(r.recovered, true);
    assert.ok(!fs.existsSync(path.join(activePath, 'new-runtime.txt')),
      'unverified first-install runtime must not stay live');
  } finally {
    rmProject(projectRoot);
  }
});

test('H-012: ACTIVATING crash before the rename restores the backup', () => {
  const ctx = makeProject();
  try {
    const { installer, activePath, markerPath, writeMarkerState } = ctx;
    const transactionId = reachActivated(ctx);
    // Move active back to stage to simulate "rename never happened".
    const { stagePath } = installer.siblingPaths(transactionId);
    fs.renameSync(ctx.activePath, stagePath);
    writeMarkerState('ACTIVATING');

    const r = installer.recover({ verifyFn: () => true });
    assert.equal(r.action, 'restored-backup');
    assert.ok(fs.existsSync(path.join(activePath, 'old-runtime.txt')));
    assert.ok(!fs.existsSync(markerPath));
  } finally {
    rmProject(ctx.projectRoot);
  }
});

test('H-013: recovery without a verifier rolls back instead of committing', () => {
  const ctx = makeProject();
  try {
    const { installer, activePath, markerPath, writeMarkerState, readMarker } = ctx;
    reachActivated(ctx);
    const backupPath = readMarker().backupPath;
    writeMarkerState('ACTIVATED'); // interrupted activation

    // No verifyFn supplied — must NOT commit, must NOT delete the backup.
    const r = installer.recover();
    assert.equal(r.action, 'rolled-back-unverifiable-activation');
    assert.ok(fs.existsSync(path.join(activePath, 'old-runtime.txt')), 'known-good backup restored');
    assert.ok(fs.existsSync(backupPath) || fs.existsSync(path.join(activePath, 'old-runtime.txt')));
    assert.ok(!fs.existsSync(path.join(activePath, 'new-runtime.txt')));
    assert.ok(!fs.existsSync(markerPath));
  } finally {
    rmProject(ctx.projectRoot);
  }
});

test('happy path: begin→verify→activate→commit swaps the runtime cleanly', () => {
  const ctx = makeProject();
  try {
    const { installer, activePath, markerPath } = ctx;
    const { transactionId, stagePath } = installer.begin();
    fs.writeFileSync(path.join(stagePath, 'new-runtime.txt'), 'NEW', 'utf8');
    installer.verifyStage(transactionId, () => true);
    installer.activate(transactionId);
    installer.verifyAndCommit(transactionId, () => true);
    assert.ok(fs.existsSync(path.join(activePath, 'new-runtime.txt')));
    assert.ok(!fs.existsSync(path.join(activePath, 'old-runtime.txt')));
    assert.ok(!fs.existsSync(markerPath));
  } finally {
    rmProject(ctx.projectRoot);
  }
});

test('H-013: begin() forwards the verifier to recovery', () => {
  const ctx = makeProject();
  try {
    const { installer, activePath, writeMarkerState } = ctx;
    reachActivated(ctx);
    writeMarkerState('ACTIVATED');
    // begin() must run recovery WITH the verifier: failing verifier rolls back.
    installer.begin({ verifyFn: () => false });
    assert.ok(fs.existsSync(path.join(activePath, 'old-runtime.txt')),
      'begin() recovery must verify, not commit blindly');
  } finally {
    rmProject(ctx.projectRoot);
  }
});
