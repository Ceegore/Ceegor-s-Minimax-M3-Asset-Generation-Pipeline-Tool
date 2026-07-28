// tests/unit/renderer/section07_r61_phasenpruefung.test.js
// ============================================================================
// R6.1 Phasenprüfung-of-Phasenpruefung — adversarial test against the
// ACTUAL `runPostProcessChain` source (not a simulation). Each test
// reproduces a realistic failure mode the original R6.1 simulation suite
// would have missed, so a regression in the guard re-opens the
// data-loss path or introduces a new one.
//
// All tests run against the live source by loading section07 into a
// minimal browser-ish sandbox (window.api, state, escapeHtml) and
// invoking runPostProcessChain(srcPath, opts) with controlled mocks.
// Every fs op happens inside an isolated per-file mkdtempSync directory.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SECTION07 = path.join(ROOT, 'renderer', 'sections', 'section07_Image_optimisation___compression.js');

const TMP_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r61pp-'));

// 1x1 PNG (89 bytes)
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d4944415478da6360606060000000050001a5f645400000000049454e44ae426082',
  'hex'
);

test.after(() => {
  try { fs.rmSync(TMP_OUT, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Load section07 into a controlled VM sandbox. Returns the sandbox + the
// spy record so each test can assert on what was called and with what args.
// ---------------------------------------------------------------------------
function loadSection07(apiOverrides, stateOverrides) {
  const spy = {
    fbDeleteCalls: [],
    optimizeCalls: [],
    removeBgCalls: [],
    isnetbgRunCalls: [],
    logEvents: [],
    refreshCalls: 0,
    toastCalls: [],
  };

  const api = Object.assign({
    fbDelete: async (p) => {
      spy.fbDeleteCalls.push(p);
      // Mirror the real behaviour: actually unlink the file. Tests
      // assert on the post-condition (file is gone) AND on the call
      // (which path was targeted).
      try { fs.unlinkSync(p); return { ok: true }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    isnetbgRun: async (src, dst, opts) => {
      spy.isnetbgRunCalls.push({ src, dst, opts });
      try { fs.writeFileSync(dst, TINY_PNG); } catch (_) {}
      return { ok: true, outputPath: dst };
    },
    // Section07's local `optimizeImageFile` calls
    // `window.api.optimizeImage(srcPath, { ..., outputPath, format, ... })`.
    // The overwrite-in-place vs new-file decision is encoded in
    // `outputPath === srcPath` (not in an `overwriteSource` flag — that
    // is only set by the caller of `optimizeImageFile`). Honour that
    // contract.
    optimizeImage: async (src, opts) => {
      spy.optimizeCalls.push({ src, opts });
      const isInPlace = opts && opts.outputPath === src;
      if (isInPlace) {
        try { fs.writeFileSync(src, TINY_PNG); } catch (_) {}
        return { ok: true, outputPath: src, inputSize: TINY_PNG.length, outputSize: TINY_PNG.length, savedPercent: 0, quality: 82, format: 'png', strippedMetadata: true };
      }
      const dir = path.dirname(src);
      const stem = path.basename(src).replace(/\.[^./\\]+$/, '');
      const ext = (opts && opts.format) || path.extname(src).slice(1) || 'png';
      const newPath = path.join(dir, `${stem}_optimized.${ext}`);
      try { fs.writeFileSync(newPath, TINY_PNG); } catch (_) {}
      return { ok: true, outputPath: newPath, inputSize: TINY_PNG.length, outputSize: TINY_PNG.length, savedPercent: 50, quality: 82, format: ext, strippedMetadata: true };
    },
    realesrganAvailable: async () => ({ available: false }),
    fbExists: async (p) => ({ ok: true, exists: fs.existsSync(p) }),
    fbWrite: async (p, b64) => {
      try { fs.writeFileSync(p, Buffer.from(b64, 'base64')); return { ok: true, path: p }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
  }, apiOverrides);

  const state = Object.assign({
    currentTab: 'image',
    upscaleEnabled: false,
    upscaleSettings: null,
    removeBackgroundEnabled: false,
    removeBackgroundUseGpu: false,
    optimizeSettings: { enabled: false, quality: 82, format: 'keep', stripMetadata: true },
    pipelineAdvancedSettings: {},
  }, stateOverrides);

  const elements = {};
  const makeEl = (tag) => ({
    tag, children: [], attrs: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    set innerHTML(v) {},
    get innerHTML() { return ''; },
    set textContent(v) {},
    get textContent() { return ''; },
    set value(v) {},
    get value() { return ''; },
    set checked(v) {},
    get checked() { return false; },
    set disabled(v) {},
    get disabled() { return false; },
    set className(v) {},
    set style(v) {},
    classList: { add() {}, remove() {}, toggle() {} },
  });
  const doc = {
    createElement: (tag) => makeEl(tag),
    activeElement: makeEl('body'),
    body: makeEl('body'),
    addEventListener() {},
    removeEventListener() {},
    getElementById: (id) => elements[id] || null,
  };

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const setStatus = () => {};
  const refreshBrowser = () => { spy.refreshCalls++; };
  const $ = (sel) => null;

  const win = {};
  win.window = win;
  win.document = doc;
  win.addEventListener = () => {};
  win.removeEventListener = () => {};
  win.api = api;
  win.state = state;
  win.escapeHtml = escapeHtml;
  win.setStatus = setStatus;
  win.refreshBrowser = refreshBrowser;
  win.$ = $;
  win.Section08Helpers = { makeResilientAddLog: () => () => {} };
  win.addLogEvent = (e) => { spy.logEvents.push(e); };
  win.toast = (msg, _tone, _ms) => { spy.toastCalls.push(msg); };
  win.el = (tag, _attrs, ...kids) => {
    const e = makeEl(tag);
    for (const k of kids) if (k) e.appendChild(typeof k === 'string' ? { tag: '#text' } : k);
    return e;
  };
  win.humanSize = (n) => `${n}B`;
  win.previewImageFromFile = () => {};
  win.uniqueOutputPath = async (p) => p;
  win.derivedOutputPath = (p, infix) => {
    const ext = path.extname(p);
    const stem = p.slice(0, -ext.length);
    return `${stem}${infix}${ext}`;
  };
  win.canvasOutputSourcePath = (p) => p;
  win.writeImageData = async (p) => ({ ok: true, path: p });
  win.mimeFromPath = (_p) => 'image/png';
  win.loadImageFromFile = async (_p) => ({ naturalWidth: 100, naturalHeight: 100 });
  win.upscaleImageFile = async (src) => {
    const dir = path.dirname(src);
    const stem = path.basename(src).replace(/\.[^./\\]+$/, '');
    const newPath = path.join(dir, `${stem}_2x.png`);
    try { fs.writeFileSync(newPath, TINY_PNG); } catch (_) {}
    return newPath;
  };
  win.cropImageFile = async (src) => {
    const dir = path.dirname(src);
    const stem = path.basename(src).replace(/\.[^./\\]+$/, '');
    const newPath = path.join(dir, `${stem}_cropped.png`);
    try { fs.writeFileSync(newPath, TINY_PNG); } catch (_) {}
    return newPath;
  };
  win.removeBackgroundFile = async (src) => {
    const dir = path.dirname(src);
    const stem = path.basename(src).replace(/\.[^./\\]+$/, '');
    const newPath = path.join(dir, `${stem}_nobg.png`);
    try { fs.writeFileSync(newPath, TINY_PNG); } catch (_) {}
    return newPath;
  };
  // Mirror the real `optimizeImageFile` semantics: format:'keep' becomes
  // a null format and uses the source path as outputPath when
  // overwriteSource:true.
  win.optimizeImageFile = async (src, opts) => {
    const o = opts || {};
    const fmt = (o.format === 'keep' || !o.format) ? null : o.format;
    const overwrite = !!o.overwriteSource;
    const out = overwrite && !fmt
      ? src
      : path.join(path.dirname(src), path.basename(src).replace(/\.[^./\\]+$/, '') + (fmt ? '_optimized.' + fmt : '_optimized') + (fmt ? '' : path.extname(src)));
    return api.optimizeImage(src, { ...o, format: fmt, outputPath: out });
  };

  const sandbox = vm.createContext({
    window: win,
    document: doc,
    state: win.state,
    toast: win.toast,
    addLogEvent: win.addLogEvent,
    escapeHtml, setStatus, refreshBrowser, $,
    // helpers that section07 calls as bare names (resolved through window)
    humanSize: win.humanSize,
    uniqueOutputPath: win.uniqueOutputPath,
    derivedOutputPath: win.derivedOutputPath,
    canvasOutputSourcePath: win.canvasOutputSourcePath,
    writeImageData: win.writeImageData,
    mimeFromPath: win.mimeFromPath,
    loadImageFromFile: win.loadImageFromFile,
    upscaleImageFile: win.upscaleImageFile,
    cropImageFile: win.cropImageFile,
    removeBackgroundFile: win.removeBackgroundFile,
    optimizeImageFile: win.optimizeImageFile,
    previewImageFromFile: win.previewImageFromFile,
    el: win.el,
    Promise, Buffer, setTimeout, clearTimeout, console,
    path, fs, os, crypto, Math, Date, JSON, String, Number, Array, Object, Boolean, RegExp, Error,
  });
  sandbox.window = win;

  // Load section07 source, truncating at the modal-heavy bottom so the
  // load doesn't crash on DOM-heavy code we don't need. We only need
  // `runPostProcessChain` defined.
  const src = fs.readFileSync(SECTION07, 'utf8');
  const truncated = src.split('// =================== Image-pipeline overlays ===================')[0];
  vm.runInContext(truncated, sandbox, { filename: 'section07_top.js' });

  return { win, spy, runPostProcessChain: sandbox.runPostProcessChain };
}

// ---------------------------------------------------------------------------
// PP-1: remove-bg only, no Upscale. Must NOT delete the original.
// ---------------------------------------------------------------------------
test('PP-1: remove-bg only must NOT delete the original (no upscale)', async () => {
  const orig = path.join(TMP_OUT, 'pp1_paid.png');
  fs.writeFileSync(orig, TINY_PNG);
  const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');

  const { runPostProcessChain, spy } = loadSection07(
    {},
    { upscaleEnabled: false, removeBackgroundEnabled: true }
  );
  await runPostProcessChain(orig, {});

  assert.equal(spy.fbDeleteCalls.includes(orig), false,
    'fbDelete must NEVER be called with the original srcPath. Calls: ' + JSON.stringify(spy.fbDeleteCalls));
  assert.equal(fs.existsSync(orig), true, 'original must remain on disk after the run');
  const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');
  assert.equal(hashAfter, hashBefore, 'original must remain byte-identical');
  const noBg = orig.replace(/\.png$/i, '_nobg.png');
  assert.equal(fs.existsSync(noBg), true, 'transparent no-bg version must exist');
});

// ---------------------------------------------------------------------------
// PP-2: Optimize only (no upscale, no removeBG). Must NOT delete original.
//       Optimize uses overwriteSource:true, so it writes in place. The
//       renderer must NOT also call fbDelete on the original.
// ---------------------------------------------------------------------------
test('PP-2: optimize only (overwriteSource:true) must NOT delete the original', async () => {
  const orig = path.join(TMP_OUT, 'pp2_paid.png');
  fs.writeFileSync(orig, TINY_PNG);
  const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');

  const { runPostProcessChain, spy } = loadSection07(
    {},
    {
      upscaleEnabled: false,
      removeBackgroundEnabled: false,
      optimizeSettings: { enabled: true, quality: 82, format: 'keep', stripMetadata: true },
    }
  );
  await runPostProcessChain(orig, {});

  assert.equal(spy.fbDeleteCalls.includes(orig), false,
    'optimize (overwriteSource) must NEVER call fbDelete on the original. Calls: ' + JSON.stringify(spy.fbDeleteCalls));
  assert.equal(fs.existsSync(orig), true, 'original must still exist (overwrite in place)');
});

// ---------------------------------------------------------------------------
// PP-3: Optimize with FORMAT CHANGE (png→jpg) on a raw API result.
//       Produces a NEW file. The original must NOT be deleted (it's
//       the API result, no upscale ran).
// ---------------------------------------------------------------------------
test('PP-3: optimize with format change on a raw API result must NOT delete the original', async () => {
  const orig = path.join(TMP_OUT, 'pp3_paid.png');
  fs.writeFileSync(orig, TINY_PNG);
  const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');

  const { runPostProcessChain, spy } = loadSection07(
    {},
    {
      upscaleEnabled: false,
      removeBackgroundEnabled: false,
      optimizeSettings: { enabled: true, quality: 82, format: 'jpg', stripMetadata: true },
    }
  );
  await runPostProcessChain(orig, {});

  assert.equal(spy.fbDeleteCalls.includes(orig), false,
    'optimize+format-change on a raw API result must NOT delete the original. Calls: ' + JSON.stringify(spy.fbDeleteCalls));
  const stem = orig.replace(/\.png$/i, '');
  const newFile = `${stem}_optimized.jpg`;
  assert.equal(fs.existsSync(newFile), true, 'new optimized file must exist');
  assert.equal(fs.existsSync(orig), true, 'original must still exist (format-change creates sibling)');
});

// ---------------------------------------------------------------------------
// PP-4: Upscale → Crop (autoCrop). The intermediate upscaled file was
//       created by the chain, so it MUST be deleted. The ORIGINAL must
//       be preserved end-to-end.
// ---------------------------------------------------------------------------
test('PP-4: upscale + autocrop must keep the original AND delete the upscaled intermediate', async () => {
  const orig = path.join(TMP_OUT, 'pp4_paid.png');
  fs.writeFileSync(orig, TINY_PNG);
  const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');

  const { runPostProcessChain, spy } = loadSection07(
    {},
    {
      upscaleEnabled: true,
      upscaleSettings: { multiplier: 2, autoCrop: true, cropWidth: 50, cropHeight: 50, cropAnchorX: 'center', cropAnchorY: 'center' },
      removeBackgroundEnabled: false,
      optimizeSettings: { enabled: false },
    }
  );
  const result = await runPostProcessChain(orig, {});

  assert.equal(fs.existsSync(orig), true, 'original must survive upscale+autocrop');
  const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');
  assert.equal(hashAfter, hashBefore, 'original must be byte-identical');
  // upscaleImageFile is called on srcPath → `pp4_paid_2x.png` is the
  // upscaled intermediate. cropImageFile is called on THAT → its
  // output is `pp4_paid_2x_cropped.png` (the chain stubs both writers
  // in the sandbox).
  const upscaled = orig.replace(/\.png$/i, '_2x.png');
  assert.equal(fs.existsSync(upscaled), false,
    'upscaled intermediate must be deleted after crop. fbDelete calls: ' + JSON.stringify(spy.fbDeleteCalls));
  const cropped = orig.replace(/\.png$/i, '_2x_cropped.png');
  assert.equal(fs.existsSync(cropped), true, 'cropped file must exist');
  assert.equal(result, cropped, 'runPostProcessChain must return the cropped path');
});

// ---------------------------------------------------------------------------
// PP-5: Upscale → Remove BG. Intermediate upscaled MUST be deleted,
//       no-bg must exist, original must survive.
// ---------------------------------------------------------------------------
test('PP-5: upscale + remove-bg must keep the original and delete the upscaled intermediate', async () => {
  const orig = path.join(TMP_OUT, 'pp5_paid.png');
  fs.writeFileSync(orig, TINY_PNG);
  const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');

  const { runPostProcessChain, spy } = loadSection07(
    {},
    {
      upscaleEnabled: true,
      upscaleSettings: { multiplier: 2 },
      removeBackgroundEnabled: true,
      optimizeSettings: { enabled: false },
    }
  );
  const result = await runPostProcessChain(orig, {});

  assert.equal(fs.existsSync(orig), true, 'original must survive');
  const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');
  assert.equal(hashAfter, hashBefore, 'original must be byte-identical');
  const upscaled = orig.replace(/\.png$/i, '_2x.png');
  assert.equal(fs.existsSync(upscaled), false, 'upscaled intermediate must be deleted');
  // removeBackgroundFile is called on the upscaled → `pp5_paid_2x_nobg.png`.
  const noBg = orig.replace(/\.png$/i, '_2x_nobg.png');
  assert.equal(fs.existsSync(noBg), true, 'no-bg file must exist');
  assert.equal(result, noBg, 'runPostProcessChain must return the no-bg path');
});

// ---------------------------------------------------------------------------
// PP-6: Full chain. All intermediates must be cleaned up. The original
//       must survive. The final result is the optimize output (or
//       whatever the last successful stage was).
// ---------------------------------------------------------------------------
test('PP-6: full chain (upscale+crop+removebg+optimize) must keep original and leave only the final result', async () => {
  const orig = path.join(TMP_OUT, 'pp6_paid.png');
  fs.writeFileSync(orig, TINY_PNG);
  const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');

  const { runPostProcessChain, spy } = loadSection07(
    {},
    {
      upscaleEnabled: true,
      upscaleSettings: { multiplier: 2, autoCrop: true, cropWidth: 50, cropHeight: 50, cropAnchorX: 'center', cropAnchorY: 'center' },
      removeBackgroundEnabled: true,
      optimizeSettings: { enabled: true, quality: 82, format: 'keep', stripMetadata: true },
    }
  );
  await runPostProcessChain(orig, {});

  assert.equal(fs.existsSync(orig), true, 'original must survive the full chain');
  const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');
  assert.equal(hashAfter, hashBefore, 'original must be byte-identical');
  const upscaled = orig.replace(/\.png$/i, '_2x.png');
  const cropped = orig.replace(/\.png$/i, '_2x_cropped.png');
  // remove-bg is called on the cropped → `pp6_paid_2x_cropped_nobg.png`,
  // then optimize in-place (overwriteSource:true, format:keep).
  const noBg = orig.replace(/\.png$/i, '_2x_cropped_nobg.png');
  assert.equal(fs.existsSync(upscaled), false, 'upscaled must be deleted after crop');
  assert.equal(fs.existsSync(cropped), false, 'cropped must be deleted after remove-bg');
  assert.equal(fs.existsSync(noBg), true, 'no-bg must be the final file');
});

// ---------------------------------------------------------------------------
// PP-7: Source-level invariant — every `fbDelete(displayFile)` call in
//       section07's runPostProcessChain must be guarded by
//       `displayFile !== srcPath` (either on the same line or in the
//       immediately-preceding lines). Uses a simple line-neighbourhood
//       check, robust to arrow-fn / template-string braces.
// ---------------------------------------------------------------------------
test('PP-7: every fbDelete(displayFile) in runPostProcessChain must be guarded by displayFile !== srcPath', () => {
  const src = fs.readFileSync(SECTION07, 'utf8');
  // Only inspect the part BEFORE the showUpscaleDirect modal (which has
  // its own legitimately-unguarded fbDelete calls on chain-created
  // intermediates like `upscaled` and `out`).
  const truncated = src.split('// =================== Image-pipeline overlays ===================')[0];
  const lines = truncated.split(/\r?\n/);
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\bfbDelete\(/.test(line)) continue;
    if (!/fbDelete\(\s*displayFile\b/.test(line)) continue;
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
    // Look back up to 3 lines for the guard
    const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
    const isGuarded = /if\s*\(\s*displayFile\s*!==\s*srcPath\s*\)/.test(window);
    if (!isGuarded) {
      violations.push('L' + (i + 1) + ': ' + line.trim());
    }
  }
  assert.equal(violations.length, 0,
    'SYS-004: every fbDelete(displayFile) call in runPostProcessChain must be guarded by `displayFile !== srcPath`. Violations:\n' + violations.join('\n'));
});

// ---------------------------------------------------------------------------
// PP-8: Phantom srcPath — the chain must not try to delete a srcPath
//       that no step produces, even when no intermediate exists.
// ---------------------------------------------------------------------------
test('PP-8: chain must never target the user-supplied srcPath for fbDelete', async () => {
  const orig = path.join(TMP_OUT, 'pp8_paid.png');
  fs.writeFileSync(orig, TINY_PNG);

  const { runPostProcessChain, spy } = loadSection07(
    {},
    {
      upscaleEnabled: false,
      removeBackgroundEnabled: true,
      optimizeSettings: { enabled: false },
    }
  );
  const result = await runPostProcessChain(orig, {});
  assert.equal(spy.fbDeleteCalls.includes(orig), false,
    'fbDelete must NEVER target the user-supplied srcPath. Calls: ' + JSON.stringify(spy.fbDeleteCalls));
  assert.ok(/_nobg\.png$/.test(result || ''), 'chain must return the no-bg path');
});

// ---------------------------------------------------------------------------
// PP-9: Cancel/error from isnetbg. Original must survive.
// ---------------------------------------------------------------------------
test('PP-9: a thrown isnetbg error must not delete the original (cancel/error path)', async () => {
  const orig = path.join(TMP_OUT, 'pp9_paid.png');
  fs.writeFileSync(orig, TINY_PNG);
  const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');

  const { runPostProcessChain, spy } = loadSection07(
    { isnetbgRun: async () => { throw new Error('cancel: user pressed Esc'); } },
    { upscaleEnabled: false, removeBackgroundEnabled: true, optimizeSettings: { enabled: false } }
  );
  try { await runPostProcessChain(orig, {}); } catch (_) { /* defensive */ }
  assert.equal(fs.existsSync(orig), true, 'original must survive a cancel');
  const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');
  assert.equal(hashAfter, hashBefore, 'original must be byte-identical after cancel');
  assert.equal(spy.fbDeleteCalls.includes(orig), false,
    'fbDelete must NEVER be called with the original on a cancel. Calls: ' + JSON.stringify(spy.fbDeleteCalls));
});

// ---------------------------------------------------------------------------
// PP-10: Mid-chain failure. Upscale OK, remove-bg throws. Original
//        must survive untouched. (The upscaled intermediate IS owned
//        by the chain and is safe to delete, but it isn't — the
//        catch block leaves it alone, which is fine; the user's
//        raw API result is what we MUST protect.)
// ---------------------------------------------------------------------------
test('PP-10: upscale OK + remove-bg throw must keep the original', async () => {
  const orig = path.join(TMP_OUT, 'pp10_paid.png');
  fs.writeFileSync(orig, TINY_PNG);
  const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');

  const { runPostProcessChain, spy } = loadSection07(
    { isnetbgRun: async () => { throw new Error('isnetbg exploded'); } },
    {
      upscaleEnabled: true,
      upscaleSettings: { multiplier: 2 },
      removeBackgroundEnabled: true,
      optimizeSettings: { enabled: false },
    }
  );
  await runPostProcessChain(orig, {});
  assert.equal(fs.existsSync(orig), true, 'original must survive a partial-chain failure');
  const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');
  assert.equal(hashAfter, hashBefore, 'original must be byte-identical');
  assert.equal(spy.fbDeleteCalls.includes(orig), false,
    'fbDelete must NEVER be called with the original on partial-chain failure. Calls: ' + JSON.stringify(spy.fbDeleteCalls));
});
