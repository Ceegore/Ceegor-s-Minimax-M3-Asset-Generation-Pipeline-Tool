// tests/release/integrity.test.js
// ============================================================================
// P6.3 (360° Audit): Release integrity suite.
//
// Validates the release verification infrastructure:
//   1. Tampered archive detection (checksum mismatch)
//   2. Tampered hash + archive detection
//   3. Invalid/corrupt provenance detection
//   4. Per-file manifest (FILES.sha256) format validation
//   5. PE header validation rejects non-executables
//   6. Archive sequence validation (missing parts)
// ============================================================================
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  validatePEHeader,
  verifyManifest,
  verifyProvenance,
  validateArchiveSequence,
} = require('../../scripts/verify-release');
const { infoFor, releasePaths } = require('../../scripts/releaseArtifacts');

describe('Release Integrity: PE Header Validation', () => {
  it('rejects a text file as PE', () => {
    const tmp = path.join(os.tmpdir(), `pe-test-${Date.now()}.txt`);
    fs.writeFileSync(tmp, 'This is not an executable file at all.');
    try {
      const r = validatePEHeader(tmp);
      assert.equal(r.ok, false);
      assert.ok(r.error.includes('MZ') || r.error.includes('PE') || r.error.includes('small'));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('rejects an empty file', () => {
    const tmp = path.join(os.tmpdir(), `pe-empty-${Date.now()}.bin`);
    fs.writeFileSync(tmp, Buffer.alloc(0));
    try {
      const r = validatePEHeader(tmp);
      assert.equal(r.ok, false);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('rejects a file with MZ but invalid e_lfanew', () => {
    const tmp = path.join(os.tmpdir(), `pe-bad-${Date.now()}.exe`);
    const buf = Buffer.alloc(128);
    buf[0] = 0x4D; buf[1] = 0x5A; // MZ magic
    buf.writeUInt32LE(99999, 0x3C); // absurd e_lfanew
    fs.writeFileSync(tmp, buf);
    try {
      const r = validatePEHeader(tmp);
      assert.equal(r.ok, false);
      assert.ok(r.error.includes('e_lfanew') || r.error.includes('Invalid'));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('accepts a minimal valid PE structure', () => {
    const tmp = path.join(os.tmpdir(), `pe-ok-${Date.now()}.exe`);
    const buf = Buffer.alloc(256);
    buf[0] = 0x4D; buf[1] = 0x5A; // MZ
    buf.writeUInt32LE(128, 0x3C); // e_lfanew = 128
    buf[128] = 0x50; buf[129] = 0x45; buf[130] = 0x00; buf[131] = 0x00; // PE\0\0
    fs.writeFileSync(tmp, buf);
    try {
      const r = validatePEHeader(tmp);
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('rejects a nonexistent file', () => {
    const r = validatePEHeader('C:\\nonexistent\\file.exe');
    assert.equal(r.ok, false);
  });
});

describe('Release Integrity: Manifest Verification', () => {
  it('detects checksum mismatch', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
    try {
      // Create a file and a manifest with wrong hash
      const filePath = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(filePath, 'hello world');
      const manifestPath = path.join(tmpDir, 'test.sha256');
      fs.writeFileSync(manifestPath, 'deadbeef'.repeat(8) + '  test.txt\n');
      const paths = { manifest: manifestPath, output: tmpDir };
      const r = verifyManifest(paths, [filePath]);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes('mismatch')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes with correct checksum', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-ok-'));
    try {
      const filePath = path.join(tmpDir, 'data.bin');
      const content = Buffer.from('integrity test data');
      fs.writeFileSync(filePath, content);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const manifestPath = path.join(tmpDir, 'data.sha256');
      fs.writeFileSync(manifestPath, `${hash}  data.bin\n`);
      const paths = { manifest: manifestPath, output: tmpDir };
      const r = verifyManifest(paths, [filePath]);
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects missing file referenced in manifest', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-miss-'));
    try {
      const manifestPath = path.join(tmpDir, 'x.sha256');
      fs.writeFileSync(manifestPath, 'ab'.repeat(32) + '  ghost.dll\n');
      const paths = { manifest: manifestPath, output: tmpDir };
      const r = verifyManifest(paths, []);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes('missing')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Release Integrity: Provenance Verification', () => {
  it('rejects missing provenance file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-miss-'));
    try {
      const paths = { provenance: path.join(tmpDir, 'nope.json'), output: tmpDir };
      const r = verifyProvenance(tmpDir, paths);
      assert.equal(r.ok, false);
      assert.ok(r.errors[0].includes('missing'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid JSON provenance', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-bad-'));
    try {
      const provPath = path.join(tmpDir, 'prov.json');
      fs.writeFileSync(provPath, 'not json at all {{{');
      const paths = { provenance: provPath, output: tmpDir };
      const r = verifyProvenance(tmpDir, paths);
      assert.equal(r.ok, false);
      assert.ok(r.errors[0].includes('not valid JSON'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects dirty-tree provenance', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-dirty-'));
    try {
      const provPath = path.join(tmpDir, 'prov.json');
      fs.writeFileSync(provPath, JSON.stringify({ commit: 'abc123', commitDirty: true }));
      const paths = { provenance: provPath, output: tmpDir };
      const r = verifyProvenance(tmpDir, paths);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.includes('dirty')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Release Integrity: Archive Sequence Validation', () => {
  it('rejects when no archive exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-none-'));
    try {
      const paths = {
        output: tmpDir,
        baseName: 'TestApp-1.0.0-x64',
        archive: path.join(tmpDir, 'TestApp-1.0.0-x64.zip'),
      };
      const r = validateArchiveSequence(paths);
      assert.equal(r.ok, false);
      assert.ok(r.error.includes('Missing'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('accepts a single unsplit zip', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-single-'));
    try {
      const zipPath = path.join(tmpDir, 'App-1.0.0-x64.zip');
      fs.writeFileSync(zipPath, 'fake zip content');
      const paths = { output: tmpDir, baseName: 'App-1.0.0-x64', archive: zipPath };
      const r = validateArchiveSequence(paths);
      assert.equal(r.ok, true);
      assert.equal(r.single, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects incomplete part sequence (part1 + part3, no part2)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-gap-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'App-2.0.0-x64.part1.zip'), 'p1');
      fs.writeFileSync(path.join(tmpDir, 'App-2.0.0-x64.part3.zip'), 'p3');
      const paths = {
        output: tmpDir,
        baseName: 'App-2.0.0-x64',
        archive: path.join(tmpDir, 'App-2.0.0-x64.zip'),
      };
      const r = validateArchiveSequence(paths);
      assert.equal(r.ok, false);
      assert.ok(r.error.includes('incomplete') || r.error.includes('part2'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Release Integrity: infoFor Hashing', () => {
  it('returns correct sha256 for known content', () => {
    const tmp = path.join(os.tmpdir(), `hash-test-${Date.now()}.bin`);
    const content = Buffer.from('The quick brown fox jumps over the lazy dog');
    fs.writeFileSync(tmp, content);
    try {
      const expected = crypto.createHash('sha256').update(content).digest('hex');
      const info = infoFor(tmp);
      assert.equal(info.exists, true);
      assert.equal(info.sha256, expected);
      assert.equal(info.size, content.length);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('returns exists:false for missing file', () => {
    const info = infoFor('C:\\nonexistent\\path\\file.bin');
    assert.equal(info.exists, false);
  });
});
