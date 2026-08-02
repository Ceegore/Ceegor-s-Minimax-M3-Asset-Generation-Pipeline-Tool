// tests/unit/src/assetPaths.h065.test.js
// ============================================================================
// H-065 regression: two non-interchangeable APIs.
//   resolveAsset()            → READ-ONLY resolution (override → bundled),
//                               no mkdir side-effects.
//   resolveWritableOverride() → WRITE target, exclusively <userData>/assets/…
//                               (never the read-only bundled tree).
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const assetPaths = require('../../../src/assetPaths');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assetpaths-'));
  const appRoot = path.join(root, 'app');
  const userData = path.join(root, 'userData');
  fs.mkdirSync(path.join(appRoot, 'bin', 'models'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  const prevConfig = { ...assetPaths.getConfig() };
  assetPaths.init({ appRoot, resourcesPath: '', userDataPath: userData });
  return {
    root, appRoot, userData, prevConfig,
    restore() {
      assetPaths.init(prevConfig);
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

test('H-065: resolveWritableOverride always targets <userData>/assets, even when bundled exists', () => {
  const t = setup();
  try {
    // Bundled copy exists — resolveAsset would return it, but the WRITE
    // target must still be the override dir.
    const bundled = path.join(t.appRoot, 'bin', 'models', 'model.onnx');
    fs.writeFileSync(bundled, 'bundled');

    const dest = assetPaths.resolveWritableOverride('models', 'model.onnx');
    assert.equal(dest, path.join(t.userData, 'assets', 'models', 'model.onnx'));
    assert.ok(fs.existsSync(path.dirname(dest)), 'parent dir created for immediate writes');

    // Round trip: after writing to the override, reads discover it first.
    fs.writeFileSync(dest, 'installed');
    const resolved = assetPaths.resolveAsset('models', 'model.onnx');
    assert.equal(resolved, dest, 'override wins over bundled on read');
  } finally { t.restore(); }
});

test('H-065: resolveWritableOverride validates its inputs', () => {
  const t = setup();
  try {
    assetPaths.init({ userDataPath: '' });
    assert.throws(() => assetPaths.resolveWritableOverride('models', 'x.onnx'), /userDataPath is required/);
    assetPaths.init({ userDataPath: t.userData });
    assert.throws(() => assetPaths.resolveWritableOverride('models', ''), /filename is required/);
    assert.throws(() => assetPaths.resolveWritableOverride('models', null), /filename is required/);
  } finally { t.restore(); }
});

test('H-065: resolveAsset is a pure read — no mkdir side-effects', () => {
  const t = setup();
  try {
    const p = assetPaths.resolveAsset('models', 'missing.onnx');
    // Falls back to the (non-existent) override path for fresh installs…
    assert.equal(p, path.join(t.userData, 'assets', 'models', 'missing.onnx'));
    // …but must NOT have created any directory along the way.
    assert.ok(!fs.existsSync(path.join(t.userData, 'assets')), 'no override dirs created by a read');
  } finally { t.restore(); }
});

test('H-065: resolveAsset still finds the bundled asset when no override exists', () => {
  const t = setup();
  try {
    const bundled = path.join(t.appRoot, 'bin', 'models', 'only-bundled.onnx');
    fs.writeFileSync(bundled, 'x');
    assert.equal(assetPaths.resolveAsset('models', 'only-bundled.onnx'), bundled);
  } finally { t.restore(); }
});

test('H-065: kind-less resolveWritableOverride lands directly in assets/', () => {
  const t = setup();
  try {
    const dest = assetPaths.resolveWritableOverride('', 'tool.exe');
    assert.equal(dest, path.join(t.userData, 'assets', 'tool.exe'));
  } finally { t.restore(); }
});
