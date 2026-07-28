// Effect assertions applied to the real image/file paths.
//
// P1 of the post-KGO10 plan. Every one of the last three confirmed bugs ran
// clean through the existing tests because those tests asserted the SHAPE of a
// return value and never the effect on the world. These cases assert the
// effect: the file is still usable, the pixels are right, the envelope survived.
//
// The helpers themselves are self-tested in effectAssertionsSelfTest.test.js —
// an assertion that cannot fail is worth nothing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  assertFileUsable, assertDirRemovable, assertPixels, assertIpcEnvelope,
} = require('../helpers/effectAssertions');

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-eff-' + tag + '-')); }

async function gradient(dir, name, ext) {
  const w = 200, h = 120;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = Math.floor((x / w) * 255); raw[i + 1] = Math.floor((y / h) * 255); raw[i + 2] = 128;
    }
  }
  const p = path.join(dir, name);
  let s = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  s = ext === 'webp' ? s.webp({ quality: 100, lossless: true })
    : ext === 'jpg' ? s.jpeg({ quality: 100 }) : s.png();
  await s.toFile(p);
  return p;
}

// ---------------------------------------------------------------------------
// Effect 1 — a file touched by an image op must stay usable.
// ---------------------------------------------------------------------------
test('effect: optimize leaves every source usable (all formats, in place + sibling)', async () => {
  const { optimize } = require(path.join(ROOT, 'src', 'imageOptimizer.js'));
  const dir = tmp('opt');
  for (const ext of ['webp', 'png', 'jpg']) {
    for (const inPlace of [true, false]) {
      const src = await gradient(dir, `o_${ext}_${inPlace}.${ext}`, ext);
      const dst = inPlace ? src : path.join(dir, `o_${ext}_${inPlace}-out.${ext}`);
      const r = await optimize(src, { outputPath: dst, quality: 80 });
      assert.strictEqual(r.ok, true, `optimize failed for ${ext}: ${r.error}`);
      assertFileUsable(src, `${ext} inPlace=${inPlace}`);
    }
  }
  assertDirRemovable(dir, 'after optimize sweep');
});

test('effect: resize leaves its source usable', async () => {
  const { resize } = require(path.join(ROOT, 'src', 'imageResize.js'));
  const dir = tmp('rs');
  for (const ext of ['webp', 'png', 'jpg']) {
    const src = await gradient(dir, `r.${ext}`, ext);
    const r = await resize(src, { outputPath: path.join(dir, `r-out.${ext}`), width: 80, height: 48 });
    assert.strictEqual(r.ok, true, `resize failed for ${ext}: ${r.error}`);
    assertFileUsable(src, ext);
  }
  assertDirRemovable(dir, 'after resize sweep');
});

test('effect: fixExtensionToMatchContent leaves the renamed file usable', async () => {
  const { fixExtensionToMatchContent } = require(path.join(ROOT, 'src', 'imageOptimizer.js'));
  const dir = tmp('fix');
  const jpgBytes = await gradient(dir, 'real.jpg', 'jpg');
  const mislabelled = path.join(dir, 'mislabelled.png');
  fs.copyFileSync(jpgBytes, mislabelled);
  const r = await fixExtensionToMatchContent(mislabelled);
  assert.strictEqual(r.ok, true, `fixExtension failed: ${r.error}`);
  assertFileUsable(r.path, 'after extension fix');
  assertDirRemovable(dir, 'after fixExtension');
});

// ---------------------------------------------------------------------------
// Effect 2 — pixels, not just dimensions.
// ---------------------------------------------------------------------------
test('effect: resize output is real image data, not a blank canvas', async () => {
  const { resize } = require(path.join(ROOT, 'src', 'imageResize.js'));
  const dir = tmp('px');
  const src = await gradient(dir, 's.png', 'png');
  const dst = path.join(dir, 'out.png');
  const r = await resize(src, { outputPath: dst, width: 100, height: 60 });
  assert.strictEqual(r.ok, true, r.error);
  await assertPixels(sharp, dst, { minDistinctColours: 20, notSaturated: [[10, 10], [50, 30], [90, 55]] });
  assertDirRemovable(dir);
});

test('effect: a kept-original optimize leaves the bytes byte-identical', async () => {
  const { optimize } = require(path.join(ROOT, 'src', 'imageOptimizer.js'));
  const dir = tmp('keep');
  const src = await gradient(dir, 'k.webp', 'webp');
  const before = fs.readFileSync(src);
  const r = await optimize(src, { outputPath: src, quality: 80 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.keptOriginal, true, 'a lossless webp at q80 should take the keep path');
  assert.ok(before.equals(fs.readFileSync(src)),
    'the "kept original" path must not rewrite the file at all');
  assertFileUsable(src, 'kept original');
  assertDirRemovable(dir);
});

// ---------------------------------------------------------------------------
// Effect 3 — the envelope the RENDERER sees, not the module's return value.
// ---------------------------------------------------------------------------
test('effect: handler warnings survive the IPC envelope adapter', () => {
  const { adaptInpaintResult } = require(path.join(ROOT, 'main', 'ipc', 'legacyAdapter.js'));
  assertIpcEnvelope(adaptInpaintResult, {
    ok: true,
    outputPath: 'C:\\x\\y.png',
    warnings: ['Re-encoding would have produced a LARGER file; the original was kept.'],
    stderr: '',
    keptOriginal: true,
  }, {
    warningsContain: ['LARGER file'],
    keepsFields: ['keptOriginal'],
  });
});

test('effect: stderr-derived and handler warnings coexist in the envelope', () => {
  const { adaptInpaintResult } = require(path.join(ROOT, 'main', 'ipc', 'legacyAdapter.js'));
  const out = assertIpcEnvelope(adaptInpaintResult, {
    ok: true, outputPath: 'C:\\x\\y.png',
    warnings: ['from-handler'], stderr: 'from-stderr',
  }, { warningsContain: ['from-handler', 'from-stderr'] });
  assert.strictEqual(out.warnings.length, 2, `expected exactly two warnings, got ${JSON.stringify(out.warnings)}`);
});
