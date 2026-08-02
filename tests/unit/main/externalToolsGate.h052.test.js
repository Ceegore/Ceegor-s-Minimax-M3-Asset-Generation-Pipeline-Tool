// tests/unit/main/externalToolsGate.h052.test.js
// ============================================================================
// H-052 (_5 audit): the external tools UI must be hidden/disabled in
// packaged builds where externalToolsEnabled() returns false. The
// _publicConfig must expose the flag; the renderer pane must gate on it.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// Main-side: _publicConfig exposes externalToolsEnabled
// ---------------------------------------------------------------------------

test('H-052: _publicConfig includes externalToolsEnabled flag', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerConfigIpc.js'), 'utf8');
  assert.match(src, /externalToolsEnabled:.*FeatureFlags.*externalToolsEnabled/s,
    '_publicConfig must expose externalToolsEnabled from FeatureFlags');
});

test('H-052: FeatureFlags.externalToolsEnabled returns false when app.isPackaged', () => {
  // Source guard: the function checks isProduction() and returns false.
  const src = fs.readFileSync(path.join(ROOT, 'main', 'services', 'FeatureFlags.js'), 'utf8');
  assert.match(src, /function externalToolsEnabled\(\)\s*\{[\s\S]*?if\s*\(!isProduction\(\)\)\s*return true;[\s\S]*?return false;/,
    'externalToolsEnabled must return false in production (isPackaged)');
});

// ---------------------------------------------------------------------------
// Renderer-side: settings pane gates on the flag
// ---------------------------------------------------------------------------

test('H-052: buildSettingsExternalToolsPane gates on externalToolsEnabled === false', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section03_Settings_tab_panes.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // The gate must check state.config.externalToolsEnabled === false and return early.
  assert.match(code, /state\.config\.externalToolsEnabled\s*===\s*false/,
    'pane must check externalToolsEnabled === false');
  // Inside the gate, it must return root (early exit, no editor).
  const gateIdx = code.indexOf('state.config.externalToolsEnabled === false');
  const returnIdx = code.indexOf('return root;', gateIdx);
  const editorIdx = code.indexOf('external-tools-list', gateIdx);
  assert.ok(returnIdx > gateIdx, 'must return root early when disabled');
  assert.ok(returnIdx < editorIdx, 'early return must precede the editor build');
});

test('H-052: disabled notice mentions development-only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section03_Settings_tab_panes.js'), 'utf8');
  assert.match(src, /development builds/i,
    'disabled notice must mention development-only availability');
  assert.match(src, /disabled in this build/i,
    'disabled notice must clearly state the feature is disabled');
});

// ---------------------------------------------------------------------------
// Main-side: externalTools:run rejects when flag is off
// ---------------------------------------------------------------------------

test('H-052: externalTools:run handler checks externalToolsEnabled()', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerExternalToolsIpc.js'), 'utf8');
  assert.match(src, /if\s*\(!externalToolsEnabled\(\)\)/,
    'externalTools:run must reject when the flag is off');
});
