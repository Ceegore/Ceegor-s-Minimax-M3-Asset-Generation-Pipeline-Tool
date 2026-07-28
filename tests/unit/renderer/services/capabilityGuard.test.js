// tests/unit/renderer/services/capabilityGuard.test.js
// R7.2b: CapabilityGuard — renderer-side capability cache service.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const GUARD_PATH = path.join(ROOT, 'renderer', 'services', 'capabilityGuard.js');
const guardSrc = fs.readFileSync(GUARD_PATH, 'utf8');

// Evaluate the IIFE in a sandbox with a mock window + api.
function loadGuard(diagnoseResult) {
  const sandbox = {
    window: {
      api: {
        diagnose: async () => diagnoseResult,
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(guardSrc, sandbox);
  return sandbox.window.CapabilityGuard;
}

const GOOD_DIAGNOSE = {
  capabilityAvailable: true,
  capability: {
    version: '1.0.16',
    hasDryRun: true,
    subcommands: {
      image: { available: true, flags: ['--model', '--dry-run'], models: ['flux-dev', 'flux-pro'] },
      speech: { available: true, flags: ['--model'], models: [] },
      music: { available: true, flags: [], models: [] },
      video: { available: false, flags: [], models: [] },
      'sound-effect': { available: true, flags: [], models: [] },
    },
    probedAt: 1700000000000,
  },
};

test('R7.2b.A: init() fetches and caches capability from diagnose', async () => {
  const guard = loadGuard(GOOD_DIAGNOSE);
  assert.equal(guard.isLoaded(), false, 'not loaded before init');
  await guard.init();
  assert.equal(guard.isLoaded(), true, 'loaded after init');
  assert.equal(guard.getSnapshot().version, '1.0.16');
});

test('R7.2b.B: isSubcommandAvailable returns correct values', async () => {
  const guard = loadGuard(GOOD_DIAGNOSE);
  await guard.init();
  assert.equal(guard.isSubcommandAvailable('image'), true);
  assert.equal(guard.isSubcommandAvailable('video'), false, 'video marked unavailable');
  assert.equal(guard.isSubcommandAvailable('speech'), true);
});

test('R7.2b.C: isFlagSupported returns correct values', async () => {
  const guard = loadGuard(GOOD_DIAGNOSE);
  await guard.init();
  assert.equal(guard.isFlagSupported('image', '--model'), true);
  assert.equal(guard.isFlagSupported('image', '--dry-run'), true);
  assert.equal(guard.isFlagSupported('image', '--nonexistent'), false);
  assert.equal(guard.isFlagSupported('video', '--model'), true, 'unavailable subcommand returns permissive true');
});

test('R7.2b.D: getModels returns model list', async () => {
  const guard = loadGuard(GOOD_DIAGNOSE);
  await guard.init();
  assert.deepEqual(JSON.parse(JSON.stringify(guard.getModels('image'))), ['flux-dev', 'flux-pro']);
  assert.deepEqual(JSON.parse(JSON.stringify(guard.getModels('speech'))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(guard.getModels('video'))), [], 'unavailable subcommand returns empty');
});

test('R7.2b.E: permissive defaults when diagnose fails', async () => {
  const guard = loadGuard(null); // diagnose returns null
  await guard.init();
  assert.equal(guard.isLoaded(), false);
  assert.equal(guard.isSubcommandAvailable('image'), true, 'permissive when not loaded');
  assert.equal(guard.isFlagSupported('image', '--anything'), true, 'permissive when not loaded');
  assert.equal(guard.getModels('image').length, 0, 'empty when not loaded');
});

test('R7.2b.F: setFromDiagnose feeds data without extra IPC', () => {
  const guard = loadGuard(null);
  guard.setFromDiagnose(GOOD_DIAGNOSE);
  assert.equal(guard.isLoaded(), true);
  assert.equal(guard.isSubcommandAvailable('video'), false);
  assert.equal(guard.getSnapshot().version, '1.0.16');
});

test('R7.2b.G: refresh re-fetches capability', async () => {
  let callCount = 0;
  const sandbox = {
    window: {
      api: {
        diagnose: async () => { callCount++; return GOOD_DIAGNOSE; },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(guardSrc, sandbox);
  const guard = sandbox.window.CapabilityGuard;
  await guard.init();
  assert.equal(callCount, 1);
  await guard.refresh();
  assert.equal(callCount, 2, 'refresh triggers a new diagnose call');
  assert.equal(guard.isLoaded(), true);
});

test('R7.2b.H: init is idempotent (no duplicate IPC)', async () => {
  let callCount = 0;
  const sandbox = {
    window: {
      api: {
        diagnose: async () => { callCount++; return GOOD_DIAGNOSE; },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(guardSrc, sandbox);
  const guard = sandbox.window.CapabilityGuard;
  await guard.init();
  await guard.init();
  await guard.init();
  assert.equal(callCount, 1, 'init only calls diagnose once');
});

// R7.2b.AuditFix: structural tests for the boot + tab integration.
// These verify that the CapabilityGuard is actually WIRED INTO the
// app's boot sequence and the tab Generate handlers (R7-Gate:
// "unsupported Controls nicht klickbar").

test('R7.2b.I: app.js boot calls CapabilityGuard.setFromDiagnose', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  assert.ok(
    appSrc.includes('CapabilityGuard.setFromDiagnose'),
    'app.js must call CapabilityGuard.setFromDiagnose(d) in the boot sequence',
  );
});

test('R7.2b.J: all 4 tab Generate handlers check CapabilityGuard.isSubcommandAvailable', () => {
  const tabs = ['imageTab.js', 'speechTab.js', 'musicTab.js', 'videoTab.js'];
  const subs = ['image', 'speech', 'music', 'video'];
  for (let i = 0; i < tabs.length; i++) {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', tabs[i]), 'utf8');
    assert.ok(
      src.includes(`CapabilityGuard.isSubcommandAvailable('${subs[i]}')`),
      `${tabs[i]} must check CapabilityGuard.isSubcommandAvailable('${subs[i]}') in its Generate handler`,
    );
  }
});

test('R7.2b.K: index.html loads capabilityGuard.js before app.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  // Match actual <script src="..."> tags, not comments.
  const guardIdx = html.indexOf('<script src="services/capabilityGuard.js">');
  const appIdx = html.indexOf('<script src="app.js">');
  assert.ok(guardIdx !== -1, 'capabilityGuard.js script tag must be in index.html');
  assert.ok(appIdx !== -1, 'app.js script tag must be in index.html');
  assert.ok(guardIdx < appIdx, 'capabilityGuard.js must load BEFORE app.js');
});
