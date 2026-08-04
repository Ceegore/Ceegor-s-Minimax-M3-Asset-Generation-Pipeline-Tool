// tests/unit/scripts/sbomGate.rq104.test.js
// ============================================================================
// V104-H003: contract for the COMPLETE, fail-closed SBOM pipeline. Pins:
//   - the generator enumerates the FULL transitive prod tree (no depth=0,
//     no fail-open empty-tree fallback),
//   - the dependency-tree flattener deduplicates nested versions,
//   - runtime assets (executables, native DLLs, ML models) are inventoried
//     with their pinned SHA-256,
//   - the verifier fails closed on missing lock packages, missing/tampered
//     runtime assets, or the missing full-transitive marker.
// ============================================================================
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const gen = require(path.join(ROOT, 'scripts', 'generate-sbom.js'));
const { verifySbomCompleteness } = require(path.join(ROOT, 'scripts', 'verify-release.js'));

// ---------------------------------------------------------------------------
// Generator contract: full transitive enumeration, fail-closed.
// ---------------------------------------------------------------------------
test('V104-H003: the SBOM generator enumerates the FULL transitive tree', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'generate-sbom.js'), 'utf8');
  assert.match(src, /--all/, 'npm ls must request the full tree, not --depth=0');
  assert.doesNotMatch(src, /--depth=0/, 'the direct-dependency-only enumeration must be gone');
  assert.doesNotMatch(src, /tree = \{ dependencies: \{\} \}/,
    'parse/npm errors must NOT degrade into an empty dependency tree');
  assert.match(src, /full-transitive/, 'the SBOM must declare its completeness marker');
  assert.match(src, /runtime-assets\.json/, 'the offline runtime payload must be inventoried');
});

test('V104-H003: flattenDepTree flattens nested dependencies and deduplicates', () => {
  const tree = {
    foo: { version: '1.0.0', dependencies: { nested: { version: '3.1.4' } } },
    bar: { version: '2.0.0' },
    // Same package hoisted twice at the same version: must dedupe to one.
    baz: { version: '4.0.0', dependencies: { nested: { version: '3.1.4' } } },
    // Uninstalled optional platform stub (no version): must be skipped, not fatal.
    'platform-stub': { optional: true },
  };
  const flat = [...gen.flattenDepTree(tree).values()];
  const names = flat.map((e) => `${e.name}@${e.version}`).sort();
  assert.deepEqual(names, ['bar@2.0.0', 'baz@4.0.0', 'foo@1.0.0', 'nested@3.1.4'],
    'nested versions must be captured exactly once');
});

test('V104-H003: runtime assets are inventoried with pinned hashes and types', () => {
  const manifest = {
    schemaVersion: 1,
    assets: [
      { path: 'ffprobe.exe', bytes: 10, sha256: 'aa11' },
      { path: 'models/isnet-general-use.onnx', bytes: 20, sha256: 'bb22' },
      { path: 'models/realesr-x2.param', bytes: 3, sha256: 'cc33' },
    ],
  };
  const comps = gen.runtimeAssetComponents(manifest);
  assert.equal(comps.length, 3, 'every manifest asset becomes a component');
  const exe = comps.find((c) => c.properties.some((p) => p.value === 'ffprobe.exe'));
  const model = comps.find((c) => c.properties.some((p) => p.value === 'models/isnet-general-use.onnx'));
  const param = comps.find((c) => c.properties.some((p) => p.value === 'models/realesr-x2.param'));
  assert.equal(exe.type, 'file', 'executables are file components');
  assert.equal(model.type, 'machine-learning-model', 'ONNX models are ML-model components');
  assert.equal(param.type, 'machine-learning-model', 'native runtime weights are ML-model components');
  assert.equal(model.hashes[0].content, 'bb22', 'the manifest SHA-256 must be pinned verbatim');
});

// ---------------------------------------------------------------------------
// Verifier contract: completeness fails closed.
// ---------------------------------------------------------------------------
function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-gate-'));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: 'fixture', version: '1.0.4', lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.4' },
      'node_modules/foo': { version: '1.0.0' },
      'node_modules/bar': { version: '2.0.0', dev: true },
      'node_modules/wasmthing': { version: '1.0.0', optional: true, os: ['wasm32'] },
      'node_modules/foo/node_modules/nested': { version: '3.1.4' },
    },
  }, null, 2));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'runtime-assets.json'), JSON.stringify({
    schemaVersion: 1,
    assets: [{ path: 'models/isnet.onnx', bytes: 1, sha256: 'DEAD' }],
  }));
  return dir;
}

function fullSbom() {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: { properties: [{ name: 'sbom:dependencyTree', value: 'full-transitive' }] },
    components: [
      { type: 'library', name: 'foo', version: '1.0.0' },
      { type: 'library', name: 'nested', version: '3.1.4' },
      {
        type: 'machine-learning-model', name: 'isnet.onnx', version: 'runtime-manifest-v1',
        properties: [{ name: 'asset:path', value: 'models/isnet.onnx' }],
        hashes: [{ alg: 'SHA-256', content: 'dead' }],
      },
    ],
  };
}

function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

test('V104-H003: a complete SBOM passes the completeness check', () => {
  const dir = makeTempRoot();
  try {
    const errors = verifySbomCompleteness(dir, fullSbom());
    assert.deepEqual(errors, [], 'no completeness errors for a full SBOM');
  } finally { cleanup(dir); }
});

test('V104-H003: dev-only and foreign-platform optional packages are NOT required', () => {
  const dir = makeTempRoot();
  try {
    const sbom = fullSbom(); // has no "bar" (dev) and no "wasmthing" (wasm32-only)
    const errors = verifySbomCompleteness(dir, sbom);
    assert.deepEqual(errors, []);
  } finally { cleanup(dir); }
});

test('V104-H003: a transitive lock package missing from the SBOM fails', () => {
  const dir = makeTempRoot();
  try {
    const sbom = fullSbom();
    sbom.components = sbom.components.filter((c) => c.name !== 'nested');
    const errors = verifySbomCompleteness(dir, sbom);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /omits 1 production package/);
    assert.match(errors[0], /nested@3\.1\.4/);
  } finally { cleanup(dir); }
});

test('V104-H003: a missing full-transitive marker fails', () => {
  const dir = makeTempRoot();
  try {
    const sbom = fullSbom();
    sbom.metadata.properties = [];
    const errors = verifySbomCompleteness(dir, sbom);
    assert.ok(errors.some((e) => /full-transitive/.test(e)), 'the marker must be enforced');
  } finally { cleanup(dir); }
});

test('V104-H003: a missing or tampered runtime asset fails', () => {
  const dir = makeTempRoot();
  try {
    const missing = fullSbom();
    missing.components = missing.components.filter((c) => c.type !== 'machine-learning-model');
    assert.ok(verifySbomCompleteness(dir, missing).some((e) => /omits runtime asset models\/isnet\.onnx/.test(e)),
      'an omitted asset must be reported');

    const tampered = fullSbom();
    tampered.components[2].hashes[0].content = 'beef';
    assert.ok(verifySbomCompleteness(dir, tampered).some((e) => /SHA-256 that does not match/.test(e)),
      'a swapped asset hash must be reported');
  } finally { cleanup(dir); }
});

test('V104-H003: an unreadable lockfile fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-gate-nolock-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'runtime-assets.json'), JSON.stringify({ schemaVersion: 1, assets: [] }));
    const errors = verifySbomCompleteness(dir, fullSbom());
    assert.ok(errors.some((e) => /package-lock\.json/.test(e)), 'missing lockfile must fail the check');
  } finally { cleanup(dir); }
});
