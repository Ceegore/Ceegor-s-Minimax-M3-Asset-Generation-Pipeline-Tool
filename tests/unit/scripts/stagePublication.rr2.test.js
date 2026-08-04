// RR2-B002/M003/C002 (release requalification 1.0.4 recheck-2):
// publication staging must create parent dirs for nested manifest entries,
// enforce the EXACT canonical inventory, and verify the manifest signature
// cryptographically against a pinned key (fail-closed).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sp = require('../../../scripts/stage-publication');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// RR2-C002: manifest path safety
// ---------------------------------------------------------------------------
test('RR2-C002: validateManifestRel accepts plain relative paths', () => {
  assert.equal(sp.validateManifestRel('win-unpacked/MiniMaxAssetTool.exe').ok, true);
  assert.equal(sp.validateManifestRel('MiniMaxAssetTool-1.0.5-x64.part1.zip').ok, true);
  assert.equal(sp.validateManifestRel('minisign.pub').ok, true);
});

test('RR2-C002: validateManifestRel rejects traversal, absolute and staging paths', () => {
  for (const bad of [
    '../evil.exe', 'a/../../evil.exe', './x', 'a//b',
    '/abs/path.exe', '\\\\unc\\share\\x', 'C:/drive/x', 'win-unpacked/..',
    'publication/x.txt', 'has space.exe', 'semi;colon.exe', '', null,
  ]) {
    assert.equal(sp.validateManifestRel(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('RR2-C002: parseManifest rejects unsafe entries, duplicates and empty input', () => {
  const h = 'a'.repeat(64);
  assert.equal(sp.parseManifest(`${h}  ../evil.exe`).ok, false);
  assert.equal(sp.parseManifest(`${h}  ok.exe\n${h}  ok.exe`).ok, false);
  assert.equal(sp.parseManifest('').ok, false);
  assert.equal(sp.parseManifest('not-a-hash ok.exe').ok, false);
  const good = sp.parseManifest(`${h}  win-unpacked/App.exe`);
  assert.equal(good.ok, true);
  assert.deepEqual(good.entries, [{ sha256: h, rel: 'win-unpacked/App.exe' }]);
});

// ---------------------------------------------------------------------------
// RR2-M003: exact-set inventory
// ---------------------------------------------------------------------------
test('RR2-M003: checkExactInventory rejects extras as well as gaps', () => {
  const canonical = ['a.zip', 'minisign.pub'];
  assert.deepEqual(sp.checkExactInventory(['a.zip', 'minisign.pub'], canonical), { ok: true, missing: [], extra: [] });
  assert.deepEqual(sp.checkExactInventory(['a.zip'], canonical), { ok: false, missing: ['minisign.pub'], extra: [] });
  assert.deepEqual(sp.checkExactInventory(['a.zip', 'minisign.pub', 'evil.exe'], canonical), { ok: false, missing: [], extra: ['evil.exe'] });
});

// ---------------------------------------------------------------------------
// RR2-B002: nested staging creates parent directories
// ---------------------------------------------------------------------------
test('RR2-B002: stageFiles creates missing parent dirs (no ENOENT)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr2-stage-'));
  try {
    const srcRoot = path.join(tmp, 'src');
    const stageDir = path.join(tmp, 'stage');
    fs.mkdirSync(path.join(srcRoot, 'win-unpacked'), { recursive: true });
    fs.writeFileSync(path.join(srcRoot, 'win-unpacked', 'App.exe'), 'PE');
    fs.writeFileSync(path.join(srcRoot, 'root.txt'), 'r');
    // The exact shape that crashed the old stager: a nested entry whose
    // parent directory does not exist yet in the stage folder.
    sp.stageFiles({ srcRoot, stageDir, rels: ['win-unpacked/App.exe', 'root.txt'] });
    assert.equal(fs.readFileSync(path.join(stageDir, 'win-unpacked', 'App.exe'), 'utf8'), 'PE');
    assert.equal(fs.readFileSync(path.join(stageDir, 'root.txt'), 'utf8'), 'r');
    assert.throws(() => sp.stageFiles({ srcRoot, stageDir, rels: ['missing.bin'] }), /missing on disk/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// RR2-C002: cryptographic signature verification (injectable spawn)
// ---------------------------------------------------------------------------
test('RR2-C002: verifyManifestSignature fails closed without a pinned key', () => {
  const r = sp.verifyManifestSignature({
    manifestPath: 'whatever', sigPath: 'whatever.minisig', pubKeyPath: '', minisignBin: 'minisign',
    spawn: () => { throw new Error('must not be called'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /MINISIGN_PUB_PATH/);
});

test('RR2-C002: verifyManifestSignature runs minisign -V and surfaces rejection', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr2-sig-'));
  try {
    const pub = path.join(tmp, 'minisign.pub');
    fs.writeFileSync(pub, 'untrusted comment: pinned\nRWQ\n');
    const calls = [];
    const okSpawn = (bin, args) => { calls.push({ bin, args }); return { status: 0, stdout: '', stderr: '' }; };
    assert.equal(sp.verifyManifestSignature({
      manifestPath: 'm', sigPath: 'm.minisig', pubKeyPath: pub, minisignBin: 'TOOL', spawn: okSpawn,
    }).ok, true);
    assert.equal(calls[0].bin, 'TOOL');
    assert.ok(calls[0].args.includes('-V') && calls[0].args.includes('-p') && calls[0].args.includes(pub));
    const bad = sp.verifyManifestSignature({
      manifestPath: 'm', sigPath: 'm.minisig', pubKeyPath: pub, minisignBin: 'TOOL',
      spawn: () => ({ status: 1, stdout: '', stderr: 'Signature and comment signature mismatch' }),
    });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /mismatch/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end staging through main() with an injectable verifier
// ---------------------------------------------------------------------------
function buildReleaseFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr2-main-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    version: '9.8.7',
    build: { productName: 'FixtureTool', directories: { output: 'out' } },
  }));
  const { releasePaths } = require('../../../scripts/releaseArtifacts');
  const paths = releasePaths(root);
  fs.mkdirSync(path.join(paths.output, 'win-unpacked'), { recursive: true });
  const files = {
    'win-unpacked/FixtureTool.exe': Buffer.from('MZPE'),
    [`${paths.baseName}.zip`]: Buffer.from('ZIPDATA'),
    'Install-MiniMax-Asset-Tool.cmd': Buffer.from('@echo off'),
    [`${paths.baseName}.provenance.json`]: Buffer.from('{}'),
    [`${paths.baseName}.sbom.json`]: Buffer.from('{}'),
    'minisign.pub': Buffer.from('untrusted comment: pinned\nRWQ\n'),
  };
  for (const [rel, buf] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(paths.output, rel)), { recursive: true });
    fs.writeFileSync(path.join(paths.output, rel), buf);
  }
  const manifestLines = Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, buf]) => `${sha256(buf)}  ${rel}`);
  fs.writeFileSync(paths.manifest, manifestLines.join('\n') + '\n');
  fs.writeFileSync(paths.manifest + '.minisig', 'untrusted comment: signature\nRWQ...\n');
  const pubKey = path.join(root, 'pinned.pub');
  fs.writeFileSync(pubKey, files['minisign.pub']);
  return { root, paths, pubKey };
}

function withCapturedExit(fn) {
  const origExit = process.exit;
  let code = null;
  process.exit = (c) => { code = c; throw new Error(`__EXIT__${c}`); };
  try {
    fn();
    return { exited: false };
  } catch (e) {
    if (String(e.message).startsWith('__EXIT__')) return { exited: true, code };
    throw e;
  } finally {
    process.exit = origExit;
  }
}

const OK_SPAWN = () => ({ status: 0, stdout: '', stderr: '' });

test('RR2-B002/M003/C002: main() stages the exact signed inventory with nested dirs', () => {
  const { root, paths, pubKey } = buildReleaseFixture();
  try {
    sp.main({ root, env: { MINISIGN_PUB_PATH: pubKey, MINISIGN_TOOL_PATH: 'minisign' }, spawn: OK_SPAWN });
    const stage = path.join(paths.output, 'publication');
    // The nested exe must be present (RR2-B002 regression).
    assert.equal(fs.existsSync(path.join(stage, 'win-unpacked', 'FixtureTool.exe')), true);
    const rels = sp.stagedFileRels(stage);
    assert.deepEqual(rels.sort(), [
      'Install-MiniMax-Asset-Tool.cmd',
      'FixtureTool-9.8.7-x64.provenance.json',
      'FixtureTool-9.8.7-x64.sbom.json',
      'FixtureTool-9.8.7-x64.sha256',
      'FixtureTool-9.8.7-x64.sha256.minisig',
      'FixtureTool-9.8.7-x64.zip',
      'minisign.pub',
      'win-unpacked/FixtureTool.exe',
    ].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RR2-M003: main() rejects a manifest with an extra entry', () => {
  const { root, pubKey } = buildReleaseFixture();
  try {
    const { releasePaths } = require('../../../scripts/releaseArtifacts');
    const paths = releasePaths(root);
    const evil = path.join(paths.output, 'evil.exe');
    fs.writeFileSync(evil, 'EVIL');
    fs.appendFileSync(paths.manifest, `${sha256('EVIL')}  evil.exe\n`);
    const r = withCapturedExit(() => sp.main({ root, env: { MINISIGN_PUB_PATH: pubKey }, spawn: OK_SPAWN }));
    assert.equal(r.exited, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RR2-C002: main() fails closed when the pinned key is absent', () => {
  const { root } = buildReleaseFixture();
  try {
    const r = withCapturedExit(() => sp.main({ root, env: {}, spawn: OK_SPAWN }));
    assert.equal(r.exited, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RR2-C002: main() fails closed when the verifier rejects the signature', () => {
  const { root, pubKey } = buildReleaseFixture();
  try {
    const reject = () => ({ status: 1, stdout: '', stderr: 'Signature mismatch' });
    const r = withCapturedExit(() => sp.main({ root, env: { MINISIGN_PUB_PATH: pubKey }, spawn: reject }));
    assert.equal(r.exited, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RR2-C002: main() rejects a shipped minisign.pub that differs from the pinned key', () => {
  const { root, paths, pubKey } = buildReleaseFixture();
  try {
    // Swap the shipped key for an attacker key (manifest hash kept valid so
    // the failure is EXACTLY the pinned-vs-shipped key comparison).
    const attacker = Buffer.from('untrusted comment: attacker\nRWX\n');
    fs.writeFileSync(path.join(paths.output, 'minisign.pub'), attacker);
    const lines = fs.readFileSync(paths.manifest, 'utf8').split('\n').map((l) => (
      l.includes('  minisign.pub') ? `${sha256(attacker)}  minisign.pub` : l
    ));
    fs.writeFileSync(paths.manifest, lines.join('\n'));
    const r = withCapturedExit(() => sp.main({ root, env: { MINISIGN_PUB_PATH: pubKey }, spawn: OK_SPAWN }));
    assert.equal(r.exited, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
