// tests/unit/scripts/verifyRelease.test.js
// Regression coverage for H7-002 / H7-003: the release verifier must FAIL on
// invalid/truncated/tampered archives, not report them as PASS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { archiveFiles, infoFor, releasePaths, validateArchiveSequence } = require('../../../scripts/releaseArtifacts');
const { evaluate } = require('../../../scripts/verify-release');

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-verify-release-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    version: '9.8.7',
    build: { productName: 'FixtureTool', directories: { output: 'out' } },
  }));
  return root;
}

// Build a minimal but REAL zip so 7za t passes when the bundled tool runs.
// Returns the path to the written zip. Uses the bundled 7za when available,
// otherwise writes a tiny well-formed zip header.
function makeRealZip(filePath) {
  const sevenZip = path.join(__dirname, '..', '..', '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  const src = filePath + '.src.txt';
  fs.writeFileSync(src, 'hello');
  try {
    if (process.platform === 'win32' && fs.existsSync(sevenZip)) {
      require('child_process').spawnSync(sevenZip, ['a', '-mx=0', filePath, src], { windowsHide: true });
    } else {
      // Fallback: minimal valid empty zip (End Of Central Directory record).
      // 7za t will still PASS on this; it's a structurally-valid (empty) zip.
      const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      fs.writeFileSync(filePath, eocd);
    }
  } finally {
    try { fs.unlinkSync(src); } catch (_) {}
  }
  return filePath;
}

function makeExe(root) {
  const paths = releasePaths(root);
  fs.mkdirSync(path.dirname(paths.executable), { recursive: true });
  // QA-025: write a minimal valid PE header (MZ + e_lfanew + PE signature)
  // so the verifier's PE validation passes.
  const buf = Buffer.alloc(72, 0);
  buf[0] = 0x4D; buf[1] = 0x5A; // 'MZ'
  buf.writeUInt32LE(64, 0x3C);   // e_lfanew = 64
  buf[64] = 0x50; buf[65] = 0x45; buf[66] = 0x00; buf[67] = 0x00; // 'PE\0\0'
  fs.writeFileSync(paths.executable, buf);
  return paths.executable;
}

test('validateArchiveSequence rejects a standalone .zip.002 with no .001', () => {
  const root = fixtureRoot();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    // The exact false-positive shape from H7-002: a lone .002 text file.
    fs.writeFileSync(paths.archive + '.002', 'this is just text, not a zip part');
    const seq = validateArchiveSequence(paths);
    assert.equal(seq.ok, false);
    assert.match(seq.error, /incomplete/i);
    assert.ok(seq.missing.some((m) => /\.001$/.test(m)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validateArchiveSequence rejects a gapped sequence (.001 + .003, no .002)', () => {
  const root = fixtureRoot();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    fs.writeFileSync(paths.archive + '.001', 'a');
    fs.writeFileSync(paths.archive + '.003', 'c');
    const seq = validateArchiveSequence(paths);
    assert.equal(seq.ok, false);
    assert.match(seq.error, /missing .*\.002/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validateArchiveSequence accepts a complete .001/.002 sequence', () => {
  const root = fixtureRoot();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    fs.writeFileSync(paths.archive + '.001', 'a');
    fs.writeFileSync(paths.archive + '.002', 'b');
    const seq = validateArchiveSequence(paths);
    assert.equal(seq.ok, true);
    assert.equal(seq.volumes, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evaluate with --require-archive FAILS on the H7-002 false-positive fixture', () => {
  const root = fixtureRoot();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    makeExe(root);
    fs.writeFileSync(paths.archive + '.002', 'standalone text part');
    const report = evaluate(root, { requireArchive: true, skipIntegrity: true });
    assert.ok(report.errors.length > 0, 'expected errors for the standalone-.002 fixture');
    assert.match(report.errors.join(' '), /incomplete/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evaluate with --require-archive FAILS when only an invalid EXE is present', () => {
  const root = fixtureRoot();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(path.dirname(paths.executable), { recursive: true });
    // No exe, no archive at all.
    const report = evaluate(root, { requireArchive: true, skipIntegrity: true });
    assert.ok(report.errors.length >= 2, 'expected missing-exe and missing-archive errors');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evaluate FAILS on manifest checksum mismatch', () => {
  const root = fixtureRoot();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    makeExe(root);
    makeRealZip(paths.archive);
    // Write a manifest with a WRONG hash for the archive.
    const base = path.basename(paths.archive);
    fs.writeFileSync(paths.manifest, `${'0'.repeat(64)}  ${base}\n`, 'utf8');
    const report = evaluate(root, { requireArchive: true });
    const joined = report.errors.join(' ');
    assert.match(joined, /[Cc]hecksum mismatch|[Mm]anifest/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evaluate FAILS on provenance asar hash mismatch', () => {
  const root = fixtureRoot();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    makeExe(root);
    makeRealZip(paths.archive);
    fs.writeFileSync(paths.manifest, '', 'utf8'); // empty manifest → skipped
    // Provenance claiming a hash that the (non-existent) asar can't match.
    fs.writeFileSync(paths.provenance, JSON.stringify({
      version: '9.8.7', electronVersion: '99.0.0', asarSha256: 'deadbeef'.repeat(8),
    }), 'utf8');
    const report = evaluate(root, { requireArchive: true });
    const joined = report.errors.join(' ');
    assert.match(joined, /asar/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evaluate PASSES on a complete, consistent single-archive release', () => {
  const root = fixtureRoot();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    makeExe(root);
    makeRealZip(paths.archive);
    const easyInstaller = path.join(paths.output, 'Install MiniMax Asset Tool.cmd');
    fs.writeFileSync(easyInstaller, '@echo off\r\n', 'utf8');
    fs.writeFileSync(paths.manifest, `${infoFor(easyInstaller).sha256}  ${path.basename(easyInstaller)}\n`, 'utf8');
    // QA-025: provenance is now required.
    fs.writeFileSync(paths.provenance, JSON.stringify({
      version: '9.8.7', electronVersion: '99.0.0', asarSha256: null,
      commit: '0123456789ab', commitDirty: false,
    }), 'utf8');
    const report = evaluate(root, { requireArchive: true });
    assert.equal(report.errors.length, 0, 'errors: ' + report.errors.join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evaluate FAILS when provenance records a dirty Git tree', () => {
  const root = fixtureRoot();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    makeExe(root);
    makeRealZip(paths.archive);
    fs.writeFileSync(paths.provenance, JSON.stringify({
      version: '9.8.7', electronVersion: '99.0.0', asarSha256: null,
      commit: '0123456789ab', commitDirty: true,
    }), 'utf8');
    const report = evaluate(root, { requireArchive: true });
    assert.match(report.errors.join(' '), /dirty/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
