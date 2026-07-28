// KGO10-001 — path-based sharp() reads leave the file open.
//
// `sharp(<path>).metadata()` keeps a libvips handle on the file (observed with
// the webp decoder), so the caller cannot delete/move/rename it afterwards:
// `EBUSY: resource busy or locked`. src/imageOptimizer/keepOriginal.js did
// exactly that on the source it had just decided to KEEP — and the reachable
// callers (the pipeline's `optimize-format: keep`, the 🗜 Optimize overlay)
// optimise in place and are routinely followed by a delete or move.
//
// This class has now shipped three times (KGOOO-1, KGOOO-2, KGO10-001). The
// behavioural test below is the one that matters; the static guards make the
// next instance fail in review instead of in production.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function makeImage(dir, name, ext) {
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
  s = ext === 'webp' ? s.webp({ quality: 100, lossless: true }) : ext === 'jpg' ? s.jpeg({ quality: 100 }) : s.png();
  await s.toFile(p);
  return p;
}

test('KGO10-001: a kept-original source stays deletable (webp, in place and to a sibling)', async () => {
  const { optimize } = require(path.join(ROOT, 'src', 'imageOptimizer.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-kgo10-'));
  try {
    for (const inPlace of [true, false]) {
      const src = await makeImage(dir, `keep_${inPlace}.webp`, 'webp');
      const dst = inPlace ? src : path.join(dir, `keep_${inPlace}-out.webp`);
      const r = await optimize(src, { outputPath: dst, quality: 80 });
      assert.strictEqual(r.ok, true, `optimize failed: ${r.error}`);
      assert.strictEqual(r.keptOriginal, true,
        'a lossless webp re-encoded at q80 should not come out smaller — the keep-original path must be the one under test');
      // The dimensions must still be reported (the metadata read must work).
      assert.strictEqual(r.width, 200);
      assert.strictEqual(r.height, 120);
      // THE assertion the original test suite was missing.
      assert.doesNotThrow(() => fs.renameSync(src, src + '.moved'),
        `source is locked after optimize (inPlace=${inPlace}) — a path-based sharp() read is holding the handle`);
      fs.renameSync(src + '.moved', src);
      assert.doesNotThrow(() => fs.unlinkSync(src),
        `source could not be deleted after optimize (inPlace=${inPlace})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KGO10-001: png and jpg sources stay usable too', async () => {
  const { optimize } = require(path.join(ROOT, 'src', 'imageOptimizer.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-kgo10b-'));
  try {
    for (const ext of ['png', 'jpg']) {
      const src = await makeImage(dir, `x.${ext}`, ext);
      const r = await optimize(src, { outputPath: src, quality: 80 });
      assert.strictEqual(r.ok, true, `optimize failed for ${ext}: ${r.error}`);
      assert.doesNotThrow(() => fs.unlinkSync(src), `${ext} source locked after optimize`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KGO10-001: the temp dir is removable — no lingering libvips handle', async () => {
  // fs.rmSync failing with EPERM is how this bug was actually found: an open
  // handle inside the directory. Asserting it directly catches any future
  // path-based read anywhere in the optimize path.
  const { optimize } = require(path.join(ROOT, 'src', 'imageOptimizer.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-kgo10c-'));
  const src = await makeImage(dir, 'held.webp', 'webp');
  await optimize(src, { outputPath: src, quality: 80 });
  assert.doesNotThrow(() => fs.rmSync(dir, { recursive: true, force: true }),
    'the temp dir could not be removed — something still holds a file handle');
});

test('KGO10-001: no path-based sharp() read survives in the optimize / inpaint IPC paths', () => {
  // A `sharp(<something that is a path>)` on a caller-owned file is the defect.
  // Buffer forms — sharp(buf), sharp(await fsp.readFile(p)), sharp(raw,{raw})
  // — are fine and are what these files must use.
  for (const rel of [
    'src/imageOptimizer/keepOriginal.js',
    'src/imageOptimizer.js',
    'main/ipc/registerInpaintOnnxIpc.js',
    'main/ipc/registerInpaintIpc.js',
  ]) {
    const src = read(rel);
    const offenders = [];
    const re = /(?<!\/\/[^\n]*)\bsharp\(\s*([A-Za-z_$][\w$.]*)\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const arg = m[1];
      // Heuristic: an identifier ending in Path/path is a filesystem path.
      if (/(^|[a-z])[Pp]ath$/.test(arg)) offenders.push(`${rel}: sharp(${arg})`);
    }
    assert.deepStrictEqual(offenders, [],
      `path-based sharp() read(s) found — read the bytes first (sharp(await fsp.readFile(p))): ${offenders.join(', ')}`);
  }
});
