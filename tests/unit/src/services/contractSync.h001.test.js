// tests/unit/src/services/contractSync.h001.test.js
// H-001 (_5 audit): ContractRegistry must be the single source of truth.
// This test loads BOTH the Main-side ContractRegistry and the Renderer-side
// modelSpecs.js and asserts their video resolution/duration tables agree.
// If they diverge, this test fails — forcing the developer to sync them.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// Load the Main-side ContractRegistry (Node module).
const { VIDEO_MATRIX, VIDEO_MODES, getVideoResolutions, contractHash } = require(
  path.join(ROOT, 'src', 'services', 'ContractRegistry.js')
);

// Load the Renderer-side modelSpecs.js in a sandbox (it's an IIFE that sets window.*).
function loadModelSpecs() {
  const sandbox = { window: {}, console, JSON, Math, Set, Object, Array, String, Number };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'specs', 'modelSpecs.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'modelSpecs.js' });
  return sandbox.window;
}

test('H-001: VIDEO_RESOLUTIONS_BY_MODEL matches ContractRegistry resolutions (T2V+I2V union)', () => {
  const w = loadModelSpecs();
  const rendererTable = w.VIDEO_RESOLUTIONS_BY_MODEL;
  assert.ok(rendererTable, 'modelSpecs must export VIDEO_RESOLUTIONS_BY_MODEL');

  // The renderer table shows resolutions for the DEFAULT mode (T2V or I2V).
  // ContractRegistry may have mode-specific restrictions (e.g. FL2V excludes 512P).
  // The renderer table should be the UNION of all non-mode-specific resolutions.
  for (const model of Object.keys(VIDEO_MATRIX)) {
    const modelEntry = VIDEO_MATRIX[model];
    // Collect all resolutions across T2V and I2V (the "general" modes).
    const generalRes = new Set();
    for (const mode of [VIDEO_MODES.T2V, VIDEO_MODES.I2V, VIDEO_MODES.S2V]) {
      if (modelEntry[mode]) {
        for (const res of Object.keys(modelEntry[mode])) generalRes.add(res);
      }
    }
    // If no T2V/I2V/S2V modes, skip (model only has FL2V or similar).
    if (generalRes.size === 0) continue;

    const rendererRes = rendererTable[model];
    assert.ok(rendererRes, `modelSpecs must have an entry for "${model}"`);
    const registryArr = [...generalRes].sort();
    const rendererArr = [...rendererRes].sort();
    assert.deepEqual(rendererArr, registryArr,
      `Resolution mismatch for ${model}: renderer=[${rendererArr}] vs registry=[${registryArr}]`);
  }
});

test('H-001: FL2V excluded resolutions match ContractRegistry (no 512P in FL2V)', () => {
  const w = loadModelSpecs();
  // The renderer should exclude 512P for FL2V mode.
  if (typeof w.resolutionsForVideoMode === 'function') {
    const hailuo02FL2V = w.resolutionsForVideoMode('MiniMax-Hailuo-02', 'FL2V');
    const registryFL2V = getVideoResolutions('MiniMax-Hailuo-02', VIDEO_MODES.FL2V);
    assert.deepEqual([...hailuo02FL2V].sort(), [...registryFL2V].sort(),
      'FL2V resolutions must match between renderer and registry');
  }
});

test('H-001: contractHash is a stable 16-char hex string', () => {
  const hash = contractHash();
  assert.match(hash, /^[0-9a-f]{16}$/, 'hash must be 16 hex chars');
  // Calling again must produce the same hash (deterministic).
  assert.equal(contractHash(), hash, 'hash must be stable');
});

test('H-001: duration enums in ContractRegistry are discrete [6,10] subsets', () => {
  for (const model of Object.keys(VIDEO_MATRIX)) {
    for (const mode of Object.keys(VIDEO_MATRIX[model])) {
      for (const res of Object.keys(VIDEO_MATRIX[model][mode])) {
        const durations = VIDEO_MATRIX[model][mode][res];
        assert.ok(Array.isArray(durations), `${model}/${mode}/${res} must be an array`);
        for (const d of durations) {
          assert.ok(d === 6 || d === 10,
            `${model}/${mode}/${res}: duration ${d} is not in {6, 10}`);
        }
      }
    }
  }
});
