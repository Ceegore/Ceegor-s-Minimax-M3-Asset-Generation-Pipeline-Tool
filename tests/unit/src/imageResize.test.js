// tests/unit/src/imageResize.test.js
// Task 1 — resize to a free target resolution. Real sharp-encoded bytes (no
// mocks) so the tests exercise the actual Lanczos3 pipeline + the
// downscale-sharpen / upscale-no-sharpen decision.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const imageResize = require('../../../src/imageResize');
const { sharp } = require('../../../src/imageOptimizer/formatUtils');

test('sharp must be installed for these tests to be meaningful', () => {
  assert.ok(sharp, 'sharp failed to load');
});

async function makeSource(dir, name, w, h, channels = 4) {
  const p = path.join(dir, name);
  const buf = await sharp({
    create: { width: w, height: h, channels, background: { r: 50, g: 150, b: 200, alpha: 1 } },
  }).png().toBuffer();
  await fsp.writeFile(p, buf);
  return p;
}

async function metadataOf(filePath) {
  const buf = await fsp.readFile(filePath);
  return sharp(buf).metadata();
}

test('resize downscales to exact target dims (aspect preserved by caller)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imgresize-'));
  try {
    const src = await makeSource(dir, 'src.png', 800, 600);
    const r = await imageResize.resize(src, { width: 400, height: 300, outputPath: path.join(dir, 'out.png') });
    assert.equal(r.ok, true);
    assert.equal(r.width, 400);
    assert.equal(r.height, 300);
    assert.equal(r.srcWidth, 800);
    assert.equal(r.srcHeight, 600);
    assert.equal(r.downscaled, true, '400x300 < 800x600 is a downscale');
    const meta = await metadataOf(r.outputPath);
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 300);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

test('resize upscales to exact target dims and flags downscaled=false (no sharpen)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imgresize-'));
  try {
    const src = await makeSource(dir, 'src.png', 200, 200);
    const r = await imageResize.resize(src, { width: 600, height: 600, outputPath: path.join(dir, 'big.png') });
    assert.equal(r.ok, true);
    assert.equal(r.downscaled, false, '600x600 > 200x200 is an upscale → no sharpen');
    assert.equal(r.width, 600);
    assert.equal(r.height, 600);
    const meta = await metadataOf(r.outputPath);
    assert.equal(meta.width, 600);
    assert.equal(meta.height, 600);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

// 360° audit fix: a MIXED resize (one axis up, one axis down) must NOT be
// treated as a downscale. The prior area-based check sharpened the upscaled
// axis, amplifying artefacts. Now both axes must shrink for sharpen to fire.
test('resize: mixed-axis resize (one up, one down) is NOT a downscale (no sharpen)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imgresize-'));
  try {
    const src = await makeSource(dir, 'src.png', 1000, 1000);
    // 1100 wide (upscaled) × 500 tall (downscaled): area smaller, but not a
    // genuine downscale → downscaled must be false.
    const r = await imageResize.resize(src, { width: 1100, height: 500, outputPath: path.join(dir, 'mixed.png') });
    assert.equal(r.ok, true);
    assert.equal(r.downscaled, false, 'mixed resize is not a downscale → no sharpen');
    assert.equal(r.width, 1100);
    assert.equal(r.height, 500);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

test('resize preserves alpha channel (PNG transparency)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imgresize-'));
  try {
    // Build a 4-channel source with a genuinely transparent region (alpha=0),
    // otherwise libvips optimises the (fully-opaque) alpha away.
    const src = path.join(dir, 'alpha.png');
    // Composite: opaque top half, transparent bottom half → real alpha channel.
    const buf = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 50, g: 150, b: 200, alpha: 0 } },
    })
      .composite([{
        input: { type: 'input', create: { width: 100, height: 50, channels: 4, background: { r: 50, g: 150, b: 200, alpha: 1 } } },
        top: 0, left: 0,
      }])
      .png().toBuffer();
    await fsp.writeFile(src, buf);
    const r = await imageResize.resize(src, { width: 50, height: 50, outputPath: path.join(dir, 'half.png') });
    assert.equal(r.ok, true);
    const meta = await metadataOf(r.outputPath);
    assert.equal(meta.channels, 4, 'alpha must be preserved on downscale');
    assert.equal(meta.hasAlpha, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

test('resize can re-encode format (png → webp) at the target dims', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imgresize-'));
  try {
    const src = await makeSource(dir, 'src.png', 160, 120);
    const r = await imageResize.resize(src, { width: 80, height: 60, format: 'webp', quality: 80, outputPath: path.join(dir, 'out.webp') });
    assert.equal(r.ok, true);
    assert.equal(r.format, 'webp');
    const meta = await metadataOf(r.outputPath);
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 80);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

test('resize rejects invalid dimensions', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imgresize-'));
  try {
    const src = await makeSource(dir, 'src.png', 64, 64);
    // Zero / negative are genuine errors (no image can be produced).
    assert.equal((await imageResize.resize(src, { width: 0, height: 0 })).ok, false);
    assert.equal((await imageResize.resize(src, { width: -5, height: 10 })).ok, false);
    assert.equal((await imageResize.resize(src, { width: 10, height: NaN })).ok, false);
    // An absurdly large value is clamped to the libvips axis cap (65500) rather
    // than producing an error — gentler for a fat-fingered input.
    const clamped = await imageResize.resize(src, { width: 100000, height: 64, outputPath: path.join(dir, 'c.png') });
    assert.equal(clamped.ok, true);
    assert.equal(clamped.width, 65500, 'over-cap width is clamped, not rejected');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

test('resize default output path is a sibling _resized_<W>x<H> file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imgresize-'));
  try {
    const src = await makeSource(dir, 'hero.png', 100, 100);
    const r = await imageResize.resize(src, { width: 50, height: 50 });
    assert.equal(r.ok, true);
    assert.equal(r.outputPath, path.join(dir, 'hero_resized_50x50.png'));
    assert.equal(fs.existsSync(r.outputPath), true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

test('resize handles missing source file gracefully', async () => {
  const r = await imageResize.resize(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now() + '.png'), { width: 10, height: 10 });
  assert.equal(r.ok, false);
});
