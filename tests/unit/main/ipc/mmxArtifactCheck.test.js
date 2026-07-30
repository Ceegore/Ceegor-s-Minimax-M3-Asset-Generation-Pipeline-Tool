// tests/unit/main/ipc/mmxArtifactCheck.test.js
// ============================================================================
// P4.1 (360° Audit DB-H-002 / DB-H-008): unit tests for
// main/ipc/mmxArtifactCheck.js — the post-run output validation the mmx IPC
// handlers apply to every --out / --download / -o artifact.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const { finalizeMmxArtifacts } = require(path.join(ROOT, 'main', 'ipc', 'mmxArtifactCheck.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-artcheck-'));
test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const OK_RESULT = () => ({ ok: true, code: 0, stdout: 's', stderr: '', parsed: { a: 1 } });
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const JPEG_MAGIC = Buffer.from([0xFF, 0xD8, 0xFF]);

function write(p, magic) {
  fs.writeFileSync(p, Buffer.concat([magic, Buffer.alloc(2048, 0)]));
  return p;
}

test('P4.1: failed results pass through untouched (nothing to validate)', async () => {
  const failed = { ok: false, code: 3, stdout: '', stderr: 'boom', parsed: null };
  const r = await finalizeMmxArtifacts(failed, [{ flag: '--out', value: path.join(TMP, 'nope.png'), kind: 'file' }]);
  assert.equal(r, failed);
});

test('P4.1: ok result with a valid PNG at the --out path passes through', async () => {
  const p = write(path.join(TMP, 'good.png'), PNG_MAGIC);
  const ok = OK_RESULT();
  const r = await finalizeMmxArtifacts(ok, [{ flag: '--out', value: p, kind: 'file' }]);
  assert.equal(r, ok);
});

test('P4.1: image-family tolerance — JPEG bytes in a .png path are accepted (fixImageExtension case)', async () => {
  const p = write(path.join(TMP, 'jpeg-in-png.png'), JPEG_MAGIC);
  const r = await finalizeMmxArtifacts(OK_RESULT(), [{ flag: '--out', value: p, kind: 'file' }]);
  assert.equal(r.ok, true);
});

test('P4.1: missing --out file flips ok:true to the fail envelope', async () => {
  const missing = path.join(TMP, 'never-written.png');
  const r = await finalizeMmxArtifacts(OK_RESULT(), [{ flag: '--out', value: missing, kind: 'file' }]);
  assert.equal(r.ok, false);
  assert.equal(r.code, -1);
  assert.match(r.stderr, /output failed validation/i);
  assert.match(r.stderr, /not created/i);
  assert.equal(r.stdout, 's', 'stdout is preserved for diagnostics');
  assert.deepEqual(r.parsed, { a: 1 }, 'parsed is preserved for diagnostics');
});

test('P4.1: undersized artifact is rejected AND deleted', async () => {
  const p = path.join(TMP, 'tiny.png');
  fs.writeFileSync(p, Buffer.concat([PNG_MAGIC, Buffer.alloc(8, 0)]));
  const r = await finalizeMmxArtifacts(OK_RESULT(), [{ flag: '--out', value: p, kind: 'file' }]);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /minimum/i);
  assert.ok(!fs.existsSync(p), 'the truncated file must be deleted');
});

test('P4.1: magic-byte mismatch (HTML error page saved as .mp3) is rejected AND deleted', async () => {
  const p = path.join(TMP, 'error-page.mp3');
  fs.writeFileSync(p, Buffer.concat([Buffer.from('<html><body>quota exceeded'), Buffer.alloc(2048, 0)]));
  const r = await finalizeMmxArtifacts(OK_RESULT(), [{ flag: '--out', value: p, kind: 'file' }]);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /does not look like a valid mp3/i);
  assert.ok(!fs.existsSync(p), 'the corrupt file must be deleted');
});

test('P4.1: dir flags (--out-dir) and input flags are NOT validated here', async () => {
  const ok = OK_RESULT();
  const r = await finalizeMmxArtifacts(ok, [
    { flag: '--out-dir', value: path.join(TMP, 'no-such-dir'), kind: 'dir' },
    { flag: '--first-frame', value: path.join(TMP, 'no-such-input.png'), kind: 'input' },
  ]);
  assert.equal(r, ok);
});

test('P4.1: unknown extensions skip the magic check but keep the size check', async () => {
  const p = path.join(TMP, 'artifact.bin');
  fs.writeFileSync(p, Buffer.alloc(2048, 7));
  const r = await finalizeMmxArtifacts(OK_RESULT(), [{ flag: '--download', value: p, kind: 'file' }]);
  assert.equal(r.ok, true);
});

test('P4.1: every failing file is reported (multi-flag runs)', async () => {
  const good = write(path.join(TMP, 'multi-good.jpg'), JPEG_MAGIC);
  const missA = path.join(TMP, 'multi-missing-a.jpg');
  const missB = path.join(TMP, 'multi-missing-b.mp4');
  const r = await finalizeMmxArtifacts(OK_RESULT(), [
    { flag: '--out', value: good, kind: 'file' },
    { flag: '--out', value: missA, kind: 'file' },
    { flag: '--download', value: missB, kind: 'file' },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /multi-missing-a\.jpg/);
  assert.match(r.stderr, /multi-missing-b\.mp4/);
});
