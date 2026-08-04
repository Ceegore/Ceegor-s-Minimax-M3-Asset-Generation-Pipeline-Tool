// RR2-M002/H007 (release requalification 1.0.4 recheck-2):
//  • SBOM component hashes/licenses must come from the lockfile-resolved
//    copy of name@version, not the first package.json with that name.
//  • verifySbomCompleteness must reject a SBOM whose hash disagrees with
//    the lockfile-resolved install.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sbomGen = require('../../../scripts/generate-sbom');
const { verifySbomCompleteness } = require('../../../scripts/verify-release');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Fixture: dependency "dup" installed TWICE — hoisted v2 + nested v1.
function dupFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr2-sbom-'));
  const hoisted = { name: 'dup', version: '2.0.0', license: 'MIT', marker: 'hoisted' };
  const nested = { name: 'dup', version: '1.0.0', license: 'Apache-2.0', marker: 'nested' };
  const hoistedPath = path.join(root, 'node_modules', 'dup', 'package.json');
  const nestedPath = path.join(root, 'node_modules', 'parent', 'node_modules', 'dup', 'package.json');
  fs.mkdirSync(path.dirname(hoistedPath), { recursive: true });
  fs.mkdirSync(path.dirname(nestedPath), { recursive: true });
  fs.writeFileSync(hoistedPath, JSON.stringify(hoisted));
  fs.writeFileSync(nestedPath, JSON.stringify(nested));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/dup': { version: '2.0.0' },
      'node_modules/parent': { version: '3.0.0' },
      'node_modules/parent/node_modules/dup': { version: '1.0.0' },
    },
  }));
  return { root, hoistedPath, nestedPath };
}

test('RR2-M002: exact resolver picks the copy matching the LOCKED version', () => {
  const { root, hoistedPath, nestedPath } = dupFixture();
  try {
    // The OLD name-only scan returns the hoisted copy for BOTH versions.
    assert.equal(sbomGen.resolveDepPackageJson(root, 'dup'), hoistedPath);
    // The exact resolver distinguishes them.
    assert.equal(sbomGen.resolveDepPackageJsonExact(root, 'dup', '2.0.0'), hoistedPath);
    assert.equal(sbomGen.resolveDepPackageJsonExact(root, 'dup', '1.0.0'), nestedPath);
    // Unknown version falls back to the name scan (warn-and-continue path).
    assert.equal(sbomGen.resolveDepPackageJsonExact(root, 'dup', '9.9.9'), hoistedPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RR2-M002: lockfileInstallPaths prefers the hoisted copy and is deterministic', () => {
  const { root, hoistedPath } = dupFixture();
  try {
    // Same version listed twice (pathological lockfile): shortest path wins.
    const paths = sbomGen.lockfileInstallPaths(root, 'dup', '2.0.0');
    assert.deepEqual(paths, [hoistedPath]);
    assert.equal(sbomGen.lockfileInstallPaths(root, 'nope', '1.0.0'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function completenessFixture(sbomComponents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr2-sbomc-'));
  const pkgJson = JSON.stringify({ name: 'dep', version: '1.2.3', license: 'MIT' });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'package.json'), pkgJson);
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/dep': { version: '1.2.3' },
    },
  }));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'runtime-assets.json'), JSON.stringify({ schemaVersion: 1, assets: [] }));
  const sbom = {
    bomFormat: 'CycloneDX', specVersion: '1.5',
    metadata: { properties: [{ name: 'sbom:dependencyTree', value: 'full-transitive' }] },
    components: sbomComponents,
  };
  return { root, sbom, pkgJson };
}

test('RR2-M002: verifier rejects a SBOM hash from the WRONG duplicate copy', () => {
  const goodHash = sha256(Buffer.from(JSON.stringify({ name: 'dep', version: '1.2.3', license: 'MIT' })));
  const { root, sbom } = completenessFixture([
    { type: 'library', name: 'dep', version: '1.2.3', hashes: [{ alg: 'SHA-256', content: 'f'.repeat(64) }] },
  ]);
  try {
    const errors = verifySbomCompleteness(root, sbom);
    assert.ok(errors.some((e) => /does not match the lockfile-resolved install/.test(e)), errors.join('; '));
    // A matching hash passes.
    sbom.components[0].hashes[0].content = goodHash;
    assert.deepEqual(verifySbomCompleteness(root, sbom), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
