// tests/unit/renderer/providersIsolation.test.js
// ============================================================================
// Isolation guard: asserts the "Other APIs" tab (providers) is NEVER added
// to the mmx 4-type arrays or the app.js boot loop. This prevents a future
// change from accidentally pulling the new tab into batch, quota, gen-queue,
// capability, or autosave logic.
// ============================================================================
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

test('ISOLATION: mmx-only app.js loops keep providers isolated', () => {
  const s = src('renderer/app.js');
  // The boot loop at ~line 575 iterates the 4 mmx tabs.
  // "providers" must NOT appear in any ['image','speech','music','video'] array.
  const fourTypeArrays = s.match(/\['image',\s*'speech',\s*'music',\s*'video'\]/g) || [];
  assert.ok(fourTypeArrays.length >= 3, 'app.js has multiple 4-type arrays (sanity check)');
  // Ctrl+5 may navigate to Providers, but it must not enter any mmx loop.
  assert.ok(!fourTypeArrays.some((a) => a.includes("'providers'")), 'providers must not enter a mmx-only array');
});

test('ISOLATION: providersTab.js is NOT in the mmx boot loop', () => {
  const s = src('renderer/app.js');
  // The boot loop builds tabs: TABS[tabKey].build()
  // providers must not be in the tabKey iteration.
  const bootLoop = s.match(/for\s*\(const tabKey of \[([^\]]+)\]/);
  assert.ok(bootLoop, 'found the boot loop');
  assert.ok(!bootLoop[1].includes('providers'), 'providers not in boot loop array');
});

test('ISOLATION: providersTab.js does not use buildParamRow or setupTabAutosave', () => {
  const s = src('renderer/tabs/providersTab.js');
  assert.ok(!s.includes('buildParamRow'), 'must not use mmx buildParamRow');
  assert.ok(!s.includes('setupTabAutosave'), 'must not use mmx setupTabAutosave');
  assert.ok(!s.includes('modelSpecs'), 'must not reference modelSpecs');
  assert.ok(!s.includes('CapabilityGuard'), 'must not reference CapabilityGuard');
});

test('ISOLATION: providersTab.js does not call mmx IPC channels', () => {
  const s = src('renderer/tabs/providersTab.js');
  assert.ok(!s.includes('mmxRun'), 'must not call mmxRun');
  assert.ok(!s.includes('mmx:run'), 'must not reference mmx:run channel');
  assert.ok(!s.includes('window.api.quota'), 'must not touch quota panel');
});

test('ISOLATION: registerProvidersIpc.js uses grantAuthorizer (not a custom gate)', () => {
  const s = src('main/ipc/registerProvidersIpc.js');
  assert.ok(s.includes("require('./grantAuthorizer')"), 'imports the shared grantAuthorizer');
  assert.ok(s.includes('authorizePath'), 'calls authorizePath');
});

test('ISOLATION: providers IPC channels are distinct from mmx channels', () => {
  const s = src('main/ipc/registerProvidersIpc.js');
  assert.ok(s.includes("'providers:get'"), 'has providers:get');
  assert.ok(s.includes("'providers:set'"), 'has providers:set');
  assert.ok(s.includes("'providers:generate'"), 'has providers:generate');
  assert.ok(s.includes("'providers:cancel'"), 'has providers:cancel');
  assert.ok(s.includes("'providers:listModels'"), 'has providers:listModels');
  // Must NOT register any mmx:* or existing channels
  assert.ok(!s.includes("'mmx:"), 'no mmx channels');
  assert.ok(!s.includes("'config:"), 'no config channels');
});

test('ISOLATION: index.html has the providers tab button and panel', () => {
  const s = src('renderer/index.html');
  assert.ok(s.includes('data-tab="providers"'), 'has tab button');
  assert.ok(s.includes('id="tab-providers"'), 'has tab panel');
  assert.ok(s.includes('tabs/providersTab.js'), 'has script include');
});

test('ISOLATION: showTab lazy-builds providers tab', () => {
  const s = src('renderer/sections/section11_Variants_dropdown.js');
  assert.ok(s.includes("name === 'providers'"), 'showTab checks for providers');
  assert.ok(s.includes('window.TABS.providers'), 'references TABS.providers');
});

test('ISOLATION: preload exposes providers bridge entries', () => {
  const s = src('preload.js');
  assert.ok(s.includes('providersGet'), 'has providersGet');
  assert.ok(s.includes('providersSet'), 'has providersSet');
  assert.ok(s.includes('providersListModels'), 'has providersListModels');
  assert.ok(s.includes('providersGenerate'), 'has providersGenerate');
  assert.ok(s.includes('providersCancel'), 'has providersCancel');
  assert.ok(s.includes('onProvidersProgress'), 'has onProvidersProgress');
});
