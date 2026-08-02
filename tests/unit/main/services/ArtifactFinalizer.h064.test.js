// tests/unit/main/services/ArtifactFinalizer.h064.test.js
// ============================================================================
// H-064 regression:
//   - unknown expectedType FAILS CLOSED in checkMagicBytes
//   - mandatory full image decode catches magic-valid-but-corrupt files
//   - finalize NEVER overwrites an existing final path (wx reservation)
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  validateAndFinalize,
  checkMagicBytes,
} = require('../../../../main/services/ArtifactFinalizer');

// Real, decodable 1x1 transparent PNG (~70 bytes).
const REAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'artfin-'));
}
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Fail-closed magic check
// ---------------------------------------------------------------------------

test('H-064: unknown expectedType fails closed in checkMagicBytes', () => {
  const pngHeader = REAL_PNG.slice(0, 16);
  // Known type still passes…
  assert.equal(checkMagicBytes(pngHeader, 'png'), true);
  // …but ANY unknown/typo'd type is rejected instead of skipping the check.
  for (const t of ['pngg', 'exe', 'txt', 'tiff', 'unknown', 'PNG ', '']) {
    assert.equal(checkMagicBytes(pngHeader, t), false, `type ${JSON.stringify(t)} must fail closed`);
  }
});

test('H-064: validateAndFinalize rejects an unknown expectedType', async () => {
  const dir = tmpDir();
  try {
    const p = path.join(dir, 'a.bin');
    fs.writeFileSync(p, REAL_PNG);
    const res = await validateAndFinalize({ path: p, expectedType: 'not-a-type', minSize: 16 });
    assert.equal(res.ok, false);
    assert.match(res.error, /magic bytes/);
  } finally { rmrf(dir); }
});

// ---------------------------------------------------------------------------
// Mandatory full decode
// ---------------------------------------------------------------------------

test('H-064: magic-valid but corrupt PNG is rejected by the mandatory decode', async () => {
  const dir = tmpDir();
  try {
    // Valid 8-byte PNG signature followed by garbage — the OLD pipeline
    // (magic bytes only) accepted this as a good artifact.
    const corrupt = Buffer.concat([REAL_PNG.slice(0, 8), Buffer.alloc(120, 0xAB)]);
    const tempPath = path.join(dir, 'out.tmp');
    const finalPath = path.join(dir, 'out.png');
    fs.writeFileSync(tempPath, corrupt);

    const res = await validateAndFinalize({ tempPath, finalPath, expectedType: 'png', minSize: 16 });
    assert.equal(res.ok, false);
    assert.match(res.error, /decode|corrupt/i);
    assert.ok(!fs.existsSync(finalPath), 'corrupt artifact must never be published');
    assert.ok(!fs.existsSync(tempPath), 'corrupt temp file is cleaned up');
  } finally { rmrf(dir); }
});

test('H-064: a real PNG passes decode and is finalized atomically', async () => {
  const dir = tmpDir();
  try {
    const tempPath = path.join(dir, 'ok.tmp');
    const finalPath = path.join(dir, 'nested', 'ok.png');
    fs.writeFileSync(tempPath, REAL_PNG);

    const res = await validateAndFinalize({ tempPath, finalPath, expectedType: 'png', minSize: 16 });
    assert.equal(res.ok, true);
    assert.equal(res.path, finalPath);
    assert.ok(fs.existsSync(finalPath));
    assert.ok(!fs.existsSync(tempPath), 'temp renamed away');
    assert.deepEqual(fs.readFileSync(finalPath), REAL_PNG);
  } finally { rmrf(dir); }
});

test('H-064: explicit fullDecode:false opts out of the decode (magic still enforced)', async () => {
  const dir = tmpDir();
  try {
    const corrupt = Buffer.concat([REAL_PNG.slice(0, 8), Buffer.alloc(120, 0xAB)]);
    const p = path.join(dir, 'b.png');
    fs.writeFileSync(p, corrupt);
    const res = await validateAndFinalize({ path: p, expectedType: 'png', minSize: 16, fullDecode: false });
    assert.equal(res.ok, true, 'opt-out skips the decode');
  } finally { rmrf(dir); }
});

test('H-064: non-image types are not routed through the image decoder', async () => {
  const dir = tmpDir();
  try {
    // Minimal ftyp box — enough for the mp4 magic check, undecodable as image.
    const mp4ish = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypisom'),
      Buffer.alloc(64, 0),
    ]);
    const p = path.join(dir, 'v.mp4');
    fs.writeFileSync(p, mp4ish);
    const res = await validateAndFinalize({ path: p, expectedType: 'mp4', minSize: 16 });
    assert.equal(res.ok, true);
  } finally { rmrf(dir); }
});

// ---------------------------------------------------------------------------
// No-clobber finalize
// ---------------------------------------------------------------------------

test('H-064: finalize refuses to overwrite an existing final path', async () => {
  const dir = tmpDir();
  try {
    const tempPath = path.join(dir, 'new.tmp');
    const finalPath = path.join(dir, 'existing.png');
    fs.writeFileSync(tempPath, REAL_PNG);
    fs.writeFileSync(finalPath, 'precious user data');

    const res = await validateAndFinalize({ tempPath, finalPath, expectedType: 'png', minSize: 16 });
    assert.equal(res.ok, false);
    assert.match(res.error, /Refusing to overwrite/);
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'precious user data', 'existing file untouched');
    assert.ok(fs.existsSync(tempPath), 'validated temp is kept for the caller to retry');
  } finally { rmrf(dir); }
});

test('H-064: failed finalize leaves no zero-byte reservation behind on retry path', async () => {
  const dir = tmpDir();
  try {
    const tempPath = path.join(dir, 'r.tmp');
    const finalPath = path.join(dir, 'r.png');
    fs.writeFileSync(tempPath, REAL_PNG);

    // First run succeeds.
    const first = await validateAndFinalize({ tempPath, finalPath, expectedType: 'png', minSize: 16 });
    assert.equal(first.ok, true);

    // Second run against the SAME final path must fail cleanly (EEXIST), and
    // the published file must still be the intact first artifact.
    fs.writeFileSync(tempPath, REAL_PNG);
    const second = await validateAndFinalize({ tempPath, finalPath, expectedType: 'png', minSize: 16 });
    assert.equal(second.ok, false);
    assert.deepEqual(fs.readFileSync(finalPath), REAL_PNG);
  } finally { rmrf(dir); }
});
