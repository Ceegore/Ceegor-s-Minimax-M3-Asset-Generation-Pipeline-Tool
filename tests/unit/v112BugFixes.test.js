// tests/unit/v111BugFixes.test.js
// ============================================================================
// Regression coverage for the three defects found in the 2026-06-26
// adversarial bug hunt (see _temp12.md):
//
//   BUG-A — src/imageOptimizer.js used `Math.round(x) || default` (the
//           AUDIT-01 falsy-fallback) for webp/avif/png effort, so a
//           user-selected effort of 0 ("fastest") silently became the
//           slowest setting. Fixed via clampInt() (Number.isFinite).
//   BUG-C — the Real-ESRGAN advanced-settings overlay invited tile sizes
//           up to 4096 and GPU id 4, but state.js capped tile at 2048 and
//           whitelisted gpu to 0..3, AND a tile size <32 reached the
//           binary as an invalid -t flag ("invalid tilesize argument").
//           Fixed: valid tile set {0=auto} ∪ [32,4096], gpu id [0,15].
//   BUG-B — a cancelled --n>1 run recorded outputPaths:[] because the
//           out-dir discovery scan only ran in the non-cancel success
//           branch. Fixed via the resolveOutDirFiles() helper reused by
//           the cancel path.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ============================================================================
// BUG-A — imageOptimizer honours effort/compression = 0 (real sharp)
// ============================================================================
test('BUG-A: webpEffort=0 reaches sharp as 0 (not the slowest default 6)', async () => {
  const sharp = require('sharp');
  const captured = {};
  const orig = {};
  for (const m of ['webp', 'avif', 'png']) {
    orig[m] = sharp.prototype[m];
    sharp.prototype[m] = function (o) { captured[m] = o; return orig[m].call(this, o); };
  }
  try {
    const opt = require(path.join(ROOT, 'src', 'imageOptimizer.js'));
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bugA-'));
    const srcPng = path.join(d, 'src.png');
    await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(srcPng);

    await opt.optimize(srcPng, { format: 'webp', encoders: { webpEffort: 0 } });
    assert.equal(captured.webp.effort, 0, 'webpEffort:0 must reach sharp as effort 0');

    await opt.optimize(srcPng, { format: 'avif', encoders: { avifEffort: 0 } });
    assert.equal(captured.avif.effort, 0, 'avifEffort:0 must reach sharp as effort 0');

    await opt.optimize(srcPng, { format: 'png', encoders: { pngCompressionLevel: 0 } });
    assert.equal(captured.png.compressionLevel, 0, 'pngCompressionLevel:0 must reach sharp as 0');

    // Control: a non-zero value still passes through, and an absent
    // value still falls back to the documented default.
    await opt.optimize(srcPng, { format: 'webp', encoders: { webpEffort: 3 } });
    assert.equal(captured.webp.effort, 3, 'non-zero effort must pass through unchanged');
    await opt.optimize(srcPng, { format: 'webp', encoders: {} });
    assert.equal(captured.webp.effort, 6, 'absent effort must fall back to the default 6');

    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } finally {
    for (const m of ['webp', 'avif', 'png']) sharp.prototype[m] = orig[m];
  }
});

test('BUG-A: imageOptimizer no longer uses the `Math.round(x) || default` falsy pattern', () => {
  const s = src('src/imageOptimizer.js');
  assert.ok(!/Math\.round\(enc\.\w+\)\s*\|\|/.test(s),
    'imageOptimizer must not use `Math.round(enc.x) || default` (the AUDIT-01 falsy-fallback bug)');
  assert.ok(/function clampInt\(/.test(s),
    'imageOptimizer must define the clampInt() helper that accepts 0');
});

// 360° audit 2026-07-11 (run 2): the SAME falsy-fallback bug survived in the
// optimize overlay's SAVE path — its Effort selects offer 0 (fastest), but
// `parseInt(sel.value) || 6` rewrote a selected 0 to the SLOWEST setting
// before the sanitiser ever saw it. Guard the effort/compression writes in
// the overlay source the same way BUG-A guards the optimizer.
test('BUG-A: imageOptimizeOverlay save path must not collapse effort 0 via `|| default`', () => {
  const s = src('renderer/overlays/imageOptimizeOverlay.js');
  assert.ok(!/parseInt\((?:webpEffortSel|avifEffortSel|pngCompSel)\.value[^)]*\)\s*\|\|/.test(s),
    'overlay must not use `parseInt(effortSel.value) || default` — 0 is a legal effort');
});

// Same class in the audio cutter: padMs 0 ("no padding") is explicit and
// backend-supported (sanitizeAutoCutRules clamps to [0, 5000]) but both UI
// save paths used `parseInt(acPad.value) || 25`, making it unreachable.
test('BUG-A: audioCutter must not collapse padMs 0 via `|| 25`', () => {
  const s = src('renderer/audioCutter.js');
  assert.ok(!/padMs:\s*parseInt\([^)]*\)\s*\|\|/.test(s),
    'audioCutter must not use `padMs: parseInt(x) || default` — 0 is a legal padding');
});

// ============================================================================
// BUG-C — state.js + realesrgan range alignment with the overlay
// ============================================================================
test('BUG-C: state persists tileSize in {0=auto} ∪ [32,4096]; maps 1..31 / out-of-range to 0', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bugC-'));
  process.env.MINIMAX_CONFIG_DIR = d;
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'state.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'config.js'))];
  const state = require(path.join(ROOT, 'src', 'state.js'));
  const tile = (v) => state.write({ pipelineAdvancedSettings: { realesrgan: { tileSize: v } } })
    .pipelineAdvancedSettings.realesrgan.tileSize;
  assert.equal(tile(4096), 4096, '4096 (overlay suggests it) must be honoured');
  assert.equal(tile(64), 64, '64 is a valid tile size');
  assert.equal(tile(32), 32, '32 is the minimum the binary accepts');
  assert.equal(tile(16), 0, '16 (<32) must map to 0=auto, never reach the binary as -t 16');
  assert.equal(tile(31), 0, '31 (<32) must map to 0=auto');
  assert.equal(tile(0), 0, '0=auto round-trips');
  assert.equal(tile(5000), 0, '5000 (>4096) must map to 0=auto');
  fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('BUG-C: state persists gpuId in {auto} ∪ [0,15]; rejects 16+ to auto', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bugCg-'));
  process.env.MINIMAX_CONFIG_DIR = d;
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'state.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'config.js'))];
  const state = require(path.join(ROOT, 'src', 'state.js'));
  const gpu = (v) => state.write({ pipelineAdvancedSettings: { realesrgan: { gpuId: v } } })
    .pipelineAdvancedSettings.realesrgan.gpuId;
  assert.equal(gpu('4'), '4', "'4' (overlay suggests 4 for a 5th GPU) must be honoured");
  assert.equal(gpu('15'), '15', "'15' is the max accepted id");
  assert.equal(gpu('auto'), 'auto', "'auto' round-trips");
  assert.equal(gpu('16'), 'auto', "'16' (>15) must map to auto");
  assert.equal(gpu('99'), 'auto', "'99' must map to auto");
  assert.equal(gpu('x'), 'auto', 'non-numeric must map to auto');
  fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('BUG-C: realesrgan wrapper only emits -t for [32,4096] and -g for [0,15]', () => {
  const s = src('src/realesrgan.js');
  assert.ok(/t >= 32 && t <= 4096/.test(s),
    'realesrgan must only emit -t for a tile size the binary accepts (>=32)');
  assert.ok(!/t > 0 && t <= 4096/.test(s),
    'the old `t > 0` guard (which emitted invalid -t 1..31) must be gone');
  assert.ok(/Number\(opts\.gpuId\) <= 15/.test(s),
    'realesrgan must accept GPU ids up to 15');
  assert.ok(!/n >= 0 && n <= 3/.test(s),
    'the old legacy [0,3] GPU clamp must be gone');
});



// ============================================================================
// BUG-B — imageTab populates outputPaths on a cancelled --n>1 run
// ============================================================================
test('BUG-B: imageTab extracts the out-dir scan into resolveOutDirFiles()', () => {
  const s = src('renderer/tabs/imageTab.js');
  assert.ok(/async function resolveOutDirFiles\(\)/.test(s),
    'imageTab must define resolveOutDirFiles() (the reusable out-dir discovery scan)');
});

test('BUG-B: the cancel path recovers out-dir outputs so the job records its files', () => {
  const s = src('renderer/tabs/imageTab.js');
  // The cancel branch must call resolveOutDirFiles() when a --n>1 run left
  // finalOutputPaths empty (the scan was skipped because cancel short-
  // circuited the success branch). R9: the gate no longer requires
  // succeededCount > 0 — a killed in-flight call leaves succeededCount at 0
  // yet may already have written files, so accept both shapes.
  const cancelStart = s.indexOf('if (cancel.wasCancelled()) {', s.indexOf('if (threw) return'));
  assert.ok(cancelStart > 0, 'the post-run cancel branch must exist');
  const cancelSlice = s.slice(cancelStart, cancelStart + 1200);
  assert.ok(/useOutDir && (succeededCount > 0 && )?finalOutputPaths\.length === 0/.test(cancelSlice),
    'the cancel branch must recover out-dir files when finalOutputPaths is empty');
  assert.ok(/finalOutputPaths = await resolveOutDirFiles\(\)/.test(cancelSlice),
    'the cancel branch must call resolveOutDirFiles() to repopulate outputPaths');
});

test('BUG-B: the success block reuses resolveOutDirFiles() (no duplicated inline scan)', () => {
  const s = src('renderer/tabs/imageTab.js');
  // There must be exactly one inline fbList-based mtime scan left (inside
  // the helper); the success block calls the helper instead.
  const scanCalls = (s.match(/const scanned = await resolveOutDirFiles\(\)/g) || []).length;
  assert.equal(scanCalls, 1, 'the success block must call resolveOutDirFiles() once');
});
