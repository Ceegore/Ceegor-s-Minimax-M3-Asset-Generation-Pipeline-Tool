// Self-test for tests/helpers/effectAssertions.js.
//
// An assertion helper that cannot fail is worse than no helper — it manufactures
// confidence. That lesson came from KGO8-003, where the visual gate returned
// ok:true whenever it found differences and therefore proved nothing for three
// QA rounds.
//
// Each case below seeds the exact defect the helper exists to catch and asserts
// the helper THROWS. If any of these ever goes green by accident, the
// corresponding guard in effectAssertions.test.js is decorative.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const {
  assertFileUsable, assertDirRemovable, assertPixels, assertIpcEnvelope,
} = require('../helpers/effectAssertions');

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-selftest-' + tag + '-')); }

test('selftest: assertFileUsable FAILS on a locked file', async () => {
  const dir = tmp('lock');
  const p = path.join(dir, 'held.webp');
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3070d0' } })
    .webp({ lossless: true }).toFile(p);
  // Reproduce the real defect: a path-based sharp read leaks the handle.
  await sharp(p).metadata();
  assert.throws(() => assertFileUsable(p, 'seeded lock'), /LOCKED/,
    'assertFileUsable did not detect a leaked libvips handle — the guard is useless');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* still locked, expected */ }
});

test('selftest: assertFileUsable FAILS on a missing file', () => {
  assert.throws(() => assertFileUsable(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now())),
    /does not exist/);
});

test('selftest: assertDirRemovable FAILS while a handle is held', async () => {
  const dir = tmp('dirlock');
  const p = path.join(dir, 'held.webp');
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3070d0' } })
    .webp({ lossless: true }).toFile(p);
  await sharp(p).metadata(); // leak
  assert.throws(() => assertDirRemovable(dir, 'seeded'), /could not be removed/);
});

test('selftest: assertPixels FAILS on a blown-out (saturated) region', async () => {
  const dir = tmp('sat');
  const p = path.join(dir, 'white.png');
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#ffffff' } }).png().toFile(p);
  await assert.rejects(
    () => assertPixels(sharp, p, { notSaturated: [[10, 10]] }),
    /blown out/,
    'assertPixels did not catch a pure-white region — this is the exact LaMa signature');
  assertDirRemovable(dir);
});

test('selftest: assertPixels FAILS on a flat/blank image', async () => {
  const dir = tmp('flat');
  const p = path.join(dir, 'flat.png');
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#204080' } }).png().toFile(p);
  await assert.rejects(
    () => assertPixels(sharp, p, { minDistinctColours: 10 }),
    /blank\/flat/);
  assertDirRemovable(dir);
});

test('selftest: assertPixels FAILS when a region that should be untouched changed', async () => {
  const dir = tmp('moved');
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.png');
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#204080' } }).png().toFile(a);
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#a03020' } }).png().toFile(b);
  await assert.rejects(
    () => assertPixels(sharp, b, { matches: { ref: a, points: [[5, 5]] } }),
    /left untouched/);
  assertDirRemovable(dir);
});

test('selftest: assertIpcEnvelope FAILS when an adapter drops handler warnings', () => {
  // The pre-KGO9-002 adapter: rebuild warnings from stderr, then spread the
  // validated envelope OVER the result.
  const brokenAdapter = (result) => ({ ...result, warnings: [] });
  assert.throws(
    () => assertIpcEnvelope(brokenAdapter, { ok: true, warnings: ['keep me'], stderr: '' },
      { warningsContain: ['keep me'] }),
    /DROPPED by the envelope adapter/,
    'assertIpcEnvelope did not catch a warnings-clobbering adapter');
});

test('selftest: assertIpcEnvelope FAILS when the adapter loses a field', () => {
  const losingAdapter = (result) => { const o = { ...result }; delete o.keptOriginal; return o; };
  assert.throws(
    () => assertIpcEnvelope(losingAdapter, { ok: true, keptOriginal: true },
      { keepsFields: ['keptOriginal'] }),
    /was lost by the envelope adapter/);
});

test('selftest: the helpers PASS on correct input (no false positives)', async () => {
  const dir = tmp('ok');
  const p = path.join(dir, 'ok.png');
  const w = 60, h = 40, raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3; raw[i] = x * 4; raw[i + 1] = y * 6; raw[i + 2] = 90;
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toFile(p);
  await assertPixels(sharp, p, { minDistinctColours: 10, notSaturated: [[5, 5], [30, 20]] });
  const goodAdapter = (result) => ({ ...result, warnings: [...(result.warnings || [])] });
  assertIpcEnvelope(goodAdapter, { ok: true, warnings: ['w'], keptOriginal: true },
    { warningsContain: ['w'], keepsFields: ['keptOriginal'] });
  assertFileUsable(p, 'healthy file');
  assertDirRemovable(dir);
});
