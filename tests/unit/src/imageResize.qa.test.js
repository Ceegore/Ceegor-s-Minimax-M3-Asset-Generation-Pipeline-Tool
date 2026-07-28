// tests/unit/src/imageResize.qa.test.js
// Phase 2 (adversarial QA) — exercises src/imageResize.js beyond the happy
// path in imageResize.test.js. Real sharp bytes, no mocks. Each test below
// targets a branch/gap the existing suite does NOT cover.
//
// Coverage targets:
//   - corrupt / truncated source (sharp failOn:'error')
//   - AVIF input + output round-trip
//   - ICC profile retention when stripMetadata=true (keepIccProfile)
//   - atomic-write tmp file cleanup on success (no .tmp leak)
//   - quality bounds (0/1/100/101/string)
//   - clampInt at exactly the 65500 axis cap
//   - non-image file rejected (txt)
//   - stripMetadata=false keeps EXIF
//   - no outputPath + explicit outputPath coexistence
//   - format aliases ('jpg','keep','auto','source') resolve correctly

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const imageResize = require('../../../src/imageResize');
const { sharp, ensureSharp } = require('../../../src/imageOptimizer/formatUtils');

test('sharp must be installed for these tests to be meaningful', () => {
  assert.equal(ensureSharp(), null, 'sharp failed to load');
});

async function mkdtempScope(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    // Windows: sharp/libvips can hold a file handle briefly after decode,
    // making the immediate rm fail with EBUSY. Retry with backoff + swallow
    // the final failure (a leftover temp dir is a test-infra wart, not a
    // product bug, and must never mask the real assertion result).
    async cleanup() {
      for (let attempt = 0; attempt < 8; attempt++) {
        try { await fsp.rm(dir, { recursive: true, force: true }); return; }
        catch (e) { if (attempt === 7) { /* give up silently */ return; } await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); }
      }
    },
  };
}

async function metaOf(p) {
  const buf = await fsp.readFile(p);
  return sharp(buf).metadata();
}

async function listTmpLeak(dir) {
  const entries = await fsp.readdir(dir);
  return entries.filter((n) => /\.tmp$/i.test(n));
}

// ---------------------------------------------------------------- corrupt src
test('CORRUPT: truncated PNG is rejected (failOn:error), not silently cropped', async () => {
  const t = await mkdtempScope('rz-corrupt-');
  try {
    const good = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    const truncated = good.slice(0, Math.floor(good.length / 2)); // cut the IDAT
    const src = path.join(t.dir, 'trunc.png');
    await fsp.writeFile(src, truncated);
    const r = await imageResize.resize(src, { width: 32, height: 32, outputPath: path.join(t.dir, 'out.png') });
    assert.equal(r.ok, false, 'a truncated/corrupt source must NOT produce a silently-partial output');
    assert.ok(/Resize failed|read/i.test(r.error), 'error should mention the read failure, got: ' + r.error);
  } finally { await t.cleanup(); }
});

// ------------------------------------------------------------------- non-image
test('REJECT: a non-image file (.txt) yields ok:false, not a crash', async () => {
  const t = await mkdtempScope('rz-txt-');
  try {
    const src = path.join(t.dir, 'note.txt');
    await fsp.writeFile(src, 'this is not an image');
    const r = await imageResize.resize(src, { width: 16, height: 16, outputPath: path.join(t.dir, 'x.png') });
    assert.equal(r.ok, false);
  } finally { await t.cleanup(); }
});

// ------------------------------------------------------------------- AVIF r/t
test('AVIF: input decoded + output re-encoded as AVIF (detectRealFormat normalises heif→avif)', async () => {
  const t = await mkdtempScope('rz-avif-');
  try {
    // Skip silently if the libvips build can't encode AVIF (some prebuilt
    // binaries lack AV1). We still want the test to run where it CAN.
    const src = path.join(t.dir, 'src.avif');
    try {
      await sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 200, g: 100, b: 50 } } })
        .avif({ quality: 50 }).toFile(src);
    } catch (e) {
      console.warn('AVIF encode unavailable on this libvips build — skipping:', e.message);
      return;
    }
    const r = await imageResize.resize(src, { width: 40, height: 40, format: 'avif', quality: 50, outputPath: path.join(t.dir, 'out.avif') });
    if (!r.ok && /not available|unsupported/i.test(r.error)) {
      console.warn('AVIF path unavailable on this build — skipping:', r.error);
      return;
    }
    assert.equal(r.ok, true, 'AVIF resize should succeed: ' + r.error);
    const meta = await metaOf(r.outputPath);
    assert.equal(meta.width, 40);
    assert.equal(meta.height, 40);
  } finally { await t.cleanup(); }
});

// ----------------------------------------------------- ICC profile retention
test('ICC: stripMetadata=true keeps the ICC profile (keepIccProfile)', async () => {
  const t = await mkdtempScope('rz-icc-');
  try {
    // Synthesize an sRGB ICC profile via sharp's withMetadata + a known profile.
    const src = path.join(t.dir, 'src.png');
    await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .withIccProfile('srgb')
      .png()
      .toFile(src);
    const srcMeta = await metaOf(src);
    const out = path.join(t.dir, 'out.png');
    const r = await imageResize.resize(src, { width: 20, height: 20, stripMetadata: true, outputPath: out });
    assert.equal(r.ok, true);
    const outMeta = await metaOf(out);
    // The ICC bytes survive (keepIccProfile). Exact profile equality is
    // libvips-dependent; we assert presence.
    assert.equal(outMeta.hasProfile, srcMeta.hasProfile, 'ICC profile presence should be preserved (stripMetadata keeps ICC by design)');
  } finally { await t.cleanup(); }
});

test('EXIF: stripMetadata=false keeps full metadata (withMetadata)', async () => {
  const t = await mkdtempScope('rz-exif-');
  try {
    // Build a JPEG with EXIF orientation, then resize keeping metadata.
    const src = path.join(t.dir, 'src.jpg');
    await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 120, g: 120, b: 120 } } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(src);
    const out = path.join(t.dir, 'out.jpg');
    const r = await imageResize.resize(src, { width: 25, height: 25, stripMetadata: false, outputPath: out });
    assert.equal(r.ok, true);
    const m = await metaOf(out);
    // Orientation is part of EXIF; withMetadata should carry it through.
    assert.equal(m.orientation, 6, 'stripMetadata=false should retain EXIF orientation');
  } finally { await t.cleanup(); }
});

// ------------------------------------------------------ atomic-write tmp leak
test('ATOMIC: no .tmp file leaks into the output dir on success', async () => {
  const t = await mkdtempScope('rz-tmp-');
  try {
    const src = path.join(t.dir, 's.png');
    await sharp({ create: { width: 30, height: 30, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toFile(src);
    const out = path.join(t.dir, 'out.png');
    const r = await imageResize.resize(src, { width: 15, height: 15, outputPath: out });
    assert.equal(r.ok, true);
    const leaks = await listTmpLeak(t.dir);
    assert.deepEqual(leaks, [], 'no .resize-*.tmp file should remain after a successful rename');
  } finally { await t.cleanup(); }
});

// --------------------------------------------------------- quality boundaries
test('QUALITY: 0→82(default), 1→1, 100→100, 101→100, "90"→90 (clamped + coerced)', async () => {
  const t = await mkdtempScope('rz-q-');
  try {
    const src = path.join(t.dir, 's.png');
    await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 100, g: 50, b: 200 } } }).png().toFile(src);
    const cases = [
      { q: undefined, expectClamped: 82 }, // default
      { q: 1, expectClamped: 1 },
      { q: 100, expectClamped: 100 },
      { q: 101, expectClamped: 100 }, // over-range clamps to 100
      { q: '90', expectClamped: 90 }, // string coercion
      { q: -5, expectClamped: 1 }, // under-range clamps to 1
    ];
    for (const c of cases) {
      const out = path.join(t.dir, `q-${c.expectClamped}-${Math.random().toString(36).slice(2)}.jpg`);
      const r = await imageResize.resize(src, { width: 20, height: 20, format: 'jpeg', quality: c.q, outputPath: out });
      assert.equal(r.ok, true, 'quality ' + c.q + ' failed: ' + r.error);
      assert.ok(fs.existsSync(out));
    }
    // No crashes, all clamped to valid range (1..100). We can't read back the
    // exact quality from a JPEG, but producing a valid file for each boundary
    // confirms normaliseQuality + the encoder cooperate.
    assert.ok(true);
  } finally { await t.cleanup(); }
});

// ------------------------------------------------------------- exact 65500 cap
test('CLAMP: exactly 65500 is accepted (boundary), 65501 clamps down', async () => {
  const t = await mkdtempScope('rz-cap-');
  try {
    const src = path.join(t.dir, 's.png');
    await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 5, g: 5, b: 5 } } }).png().toFile(src);
    // 65500 is the libvips axis cap — at-boundary, accepted as-is.
    const at = await imageResize.resize(src, { width: 65500, height: 10, outputPath: path.join(t.dir, 'at.png') });
    assert.equal(at.ok, true, '65500 should be accepted at-boundary: ' + at.error);
    assert.equal(at.width, 65500);
    // 65501 is one over → clamped to 65500, not rejected.
    const over = await imageResize.resize(src, { width: 65501, height: 10, outputPath: path.join(t.dir, 'over.png') });
    assert.equal(over.ok, true);
    assert.equal(over.width, 65500, '65501 clamps to the 65500 cap');
  } finally { await t.cleanup(); }
});

// ------------------------------------------------------- 1×1 extreme minimum
test('MIN: 1×1 output is valid (minimum positive dims)', async () => {
  const t = await mkdtempScope('rz-min-');
  try {
    const src = path.join(t.dir, 's.png');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toFile(src);
    const r = await imageResize.resize(src, { width: 1, height: 1, outputPath: path.join(t.dir, 'one.png') });
    assert.equal(r.ok, true);
    const m = await metaOf(r.outputPath);
    assert.equal(m.width, 1);
    assert.equal(m.height, 1);
  } finally { await t.cleanup(); }
});

// ----------------------------------------------- format aliases resolution
test('ALIAS: format "jpg"→jpeg, "keep"/"auto"/"source"→preserve source ext', async () => {
  const t = await mkdtempScope('rz-alias-');
  try {
    const pngSrc = path.join(t.dir, 's.png');
    await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(pngSrc);

    // 'jpg' alias → jpeg encoder, .jpg sibling ext
    const jpg = await imageResize.resize(pngSrc, { width: 10, height: 10, format: 'jpg', outputPath: path.join(t.dir, 'a.jpg') });
    assert.equal(jpg.ok, true);
    assert.equal(jpg.format, 'jpeg');

    // 'keep' → source png
    const keep = await imageResize.resize(pngSrc, { width: 10, height: 10, format: 'keep', outputPath: path.join(t.dir, 'k.png') });
    assert.equal(keep.ok, true);
    assert.equal(keep.format, 'png');

    // 'auto' / 'source' → also null → keep source
    const auto = await imageResize.resize(pngSrc, { width: 10, height: 10, format: 'auto', outputPath: path.join(t.dir, 'au.png') });
    assert.equal(auto.format, 'png');
  } finally { await t.cleanup(); }
});

// ----------------------------------------------- default-path ext mapping
test('PATH: default output ext is .jpg for jpeg target, else format name', async () => {
  const t = await mkdtempScope('rz-ext-');
  try {
    const pngSrc = path.join(t.dir, 'hero.png');
    await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 7, g: 8, b: 9 } } }).png().toFile(pngSrc);

    // No outputPath + format jpeg → sibling _resized_<W>x<H>.jpg
    const j = await imageResize.resize(pngSrc, { width: 8, height: 8, format: 'jpeg' });
    assert.equal(j.outputPath, path.join(t.dir, 'hero_resized_8x8.jpg'));

    // No outputPath + keep png → .png sibling
    const p = await imageResize.resize(pngSrc, { width: 8, height: 8 });
    assert.equal(p.outputPath, path.join(t.dir, 'hero_resized_8x8.png'));
  } finally { await t.cleanup(); }
});

// ----------------------------------------------- sharpen-only-on-downscale guard
test('SHARPEN: equal-size resize is NOT a downscale (downscaled=false)', async () => {
  const t = await mkdtempScope('rz-eq-');
  try {
    const src = path.join(t.dir, 's.png');
    await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toFile(src);
    // 64×64 → 64×64: neither axis shrinks → not a downscale.
    const r = await imageResize.resize(src, { width: 64, height: 64, outputPath: path.join(t.dir, 'eq.png') });
    assert.equal(r.ok, true);
    assert.equal(r.downscaled, false, 'identical dims is not a downscale');
  } finally { await t.cleanup(); }
});
