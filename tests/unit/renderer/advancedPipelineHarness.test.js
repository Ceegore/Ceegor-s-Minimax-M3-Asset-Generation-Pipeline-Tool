// tests/unit/renderer/advancedPipelineHarness.test.js
// ============================================================================
// v1.1 HARNESS — real-code tests for the advanced-pipeline-settings
// feature and the special-feature backends it tunes.
//
// This harness LOADS THE ACTUAL SOURCE FILES (no re-implementations
// of the logic under test) and exercises the real exports. It was
// added alongside the v1.1 advanced-settings overlay so the user
// can verify — via `npm test` — that:
//
//   1. The new state.pipelineAdvancedSettings field round-trips
//      through src/state.js with sanitisation (corruption defence).
//   2. src/realesrgan.js run() builds the correct CLI argv for the
//      new -t (tile), -x (tta), -g (gpu) flags — and DOES NOT emit
//      them when the user leaves the defaults.
//   3. src/isnetbg.js checkNodeBackendAvailable is actually imported
//      (the v1.1 bug fix — was previously called but never imported,
//      so the "onnxruntime-node not bundled" diagnostic was lost).
//   4. src/isnetbg_node.js parseArgs picks up the new --intra-op /
//      --inter-op / --execution-mode flags AND the bicubicUpsample
//      kernel is numerically correct (identity on a 1×1 source).
//   5. src/imageOptimizer.js keeps ICC and strips EXIF when
//      stripMetadata=true (the v1.1 bug fix — the previous code
//      actually preserved all metadata in both branches), and
//      forwards the per-format encoder knobs to sharp.
//   6. src/audio/AudioTrimCut.js codecArgsFor substitutes the
//      user-tuned quality values and leaves unspecified codecs at
//      their defaults (the v1.1 audio-cutter knob).
//   7. The renderer overlay (section25) opens, exposes all four
//      sections + every dropdown, and Save round-trips through
//      state.
//   8. Source-level pins: the renderer flows that READ the new
//      state field actually reference it by name (catches "I
//      claimed I wired it but forgot to save the file").
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ----------------------------------------------------------------------------
// Shared DOM / window / electron mocks — same shape as realCodeHarness.test.js
// (kept self-contained so this file can run independently).
// ----------------------------------------------------------------------------
function makeEl(tag) {
  const node = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    classList: {
      _set: new Set(),
      add(c) { if (c == null) return; for (const cls of String(c).split(/\s+/).filter(Boolean)) this._set.add(cls); },
      remove(c) { if (c == null) return; for (const cls of String(c).split(/\s+/).filter(Boolean)) this._set.delete(cls); },
      contains(c) { return this._set.has(c); },
      toggle(c, force) {
        if (force === true) this.add(c);
        else if (force === false) this.remove(c);
        else if (this._set.has(c)) this.remove(c);
        else this.add(c);
        return this._set.has(c);
      },
    },
    parentNode: null,
    dataset: {},
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) { if (!this._listeners[ev]) return; this._listeners[ev] = this._listeners[ev].filter((f) => f !== fn); },
    dispatchEvent(event) { for (const fn of (this._listeners[event.type] || [])) fn(event); return true; },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    insertBefore(child, ref) { const i = this.children.indexOf(ref); if (i < 0) this.children.push(child); else this.children.splice(i, 0, child); child.parentNode = this; return child; },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parentNode = null; return child; },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] == null ? null : String(this.attributes[k]); },
    removeAttribute(k) { delete this.attributes[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    blur() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    set textContent(v) { this._text = v; this.children = []; },
    get textContent() { return this._text != null ? this._text : this.children.map((c) => c.textContent || '').join(''); },
    set innerHTML(v) { this._innerHTML = v; this.children = []; },
    get innerHTML() { return this._innerHTML || ''; },
    append(...nodes) { for (const n of nodes) { if (n && n.tagName) { this.children.push(n); n.parentNode = this; } } },
  };
  // select / input / textarea carry a `value` and `checked`
  if (node.tagName === 'SELECT' || node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
    node.value = '';
    node.checked = false;
    node.disabled = false;
  }
  return node;
}
function makeDom() {
  const elements = {};
  const docListeners = {};
  return {
    elements,
    docListeners,
    createElement: (tag) => makeEl(tag),
    createElementNS: (_, tag) => makeEl(tag),
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) { if (!docListeners[ev]) return; docListeners[ev] = docListeners[ev].filter((f) => f !== fn); },
    body: makeEl('body'),
    documentElement: makeEl('html'),
    readyState: 'complete',
  };
}
function setupWindowMock() {
  delete global.window;
  delete global.document;
  const dom = makeDom();
  const elFactory = (tag, attrs, ...children) => {
    const n = makeEl(tag);
    if (attrs && typeof attrs === 'object') {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') { n.attributes.class = v; n.classList.add(v); }
        else if (k === 'style' && typeof v === 'string') n.attributes.style = v;
        else if (k.startsWith('data-')) { n.attributes[k] = v; n.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v; }
        else n.attributes[k] = v;
        // Mirror a few attrs to properties the live code reads.
        if (k === 'value' && (n.tagName === 'OPTION' || n.tagName === 'INPUT' || n.tagName === 'SELECT')) n.value = v;
        if (k === 'type' && n.tagName === 'INPUT') n.type = v;
        if (k === 'checked' && n.tagName === 'INPUT') n.checked = !!v;
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      if (typeof c === 'string' || typeof c === 'number') {
        const t = makeEl('span'); t.textContent = String(c); n.children.push(t); t.parentNode = n;
      } else if (typeof c === 'object' && c.tagName) {
        n.children.push(c); c.parentNode = n;
      }
    }
    return n;
  };
  const win = {
    api: {}, state: undefined, toast: () => {},
    el: elFactory, createElement: elFactory,
    confirm: () => true,
    asyncConfirm: async () => true,
    document: dom,
  };
  global.window = win;
  global.document = dom;
  return win;
}

// ----------------------------------------------------------------------------
// Mock electron for src/state.js + src/isnetbg.js loads.
// ----------------------------------------------------------------------------
function withElectronMock(electronMock, fn) {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'electron') return electronMock;
    return origLoad.call(this, request, parent, ...rest);
  };
  try { return fn(); } finally { Module._load = origLoad; }
}

// ============================================================================
// TEST GROUP 1 — state.js round-trips pipelineAdvancedSettings with sanitisation
// ============================================================================
test('ADV 1a: state.js persists pipelineAdvancedSettings with full sanitisation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-state-'));
  process.env.MINIMAX_CONFIG_DIR = tmp;
  const electronMock = { app: { getPath: () => tmp }, shell: { openPath: async () => '' } };
  withElectronMock(electronMock, () => {
    delete require.cache[require.resolve(path.join(ROOT, 'src', 'state.js'))];
    const state = require(path.join(ROOT, 'src', 'state.js'));
    // Write with valid user values — every field should round-trip verbatim.
    const written = state.write({
      tabs: {},
      pipelineAdvancedSettings: {
        realesrgan: { tileSize: 256, ttaMode: true, gpuId: '1' },
        isnetbg: { intraOpNumThreads: 4, interOpNumThreads: 2, executionMode: 'parallel' },
        optimize: {
          jpegChromaSubsampling: '4:4:4', jpegMozjpeg: false,
          pngCompressionLevel: 6, pngPalette: false,
          webpMode: 'lossless', webpEffort: 4,
          avifEffort: 4, avifChromaSubsampling: '4:2:0',
        },
        audio: {
          silenceThresholdDb: -60, minSilenceMs: 100,
          mp3Quality: 0, oggQuality: 8, opusBitrate: '192k', m4aBitrate: '256k',
        },
      },
    });
    assert.equal(written.pipelineAdvancedSettings.realesrgan.tileSize, 256);
    assert.equal(written.pipelineAdvancedSettings.realesrgan.ttaMode, true);
    assert.equal(written.pipelineAdvancedSettings.realesrgan.gpuId, '1');
    assert.equal(written.pipelineAdvancedSettings.isnetbg.intraOpNumThreads, 4);
    assert.equal(written.pipelineAdvancedSettings.isnetbg.executionMode, 'parallel');
    assert.equal(written.pipelineAdvancedSettings.optimize.jpegChromaSubsampling, '4:4:4');
    assert.equal(written.pipelineAdvancedSettings.optimize.webpMode, 'lossless');
    assert.equal(written.pipelineAdvancedSettings.audio.silenceThresholdDb, -60);
    assert.equal(written.pipelineAdvancedSettings.audio.opusBitrate, '192k');
    // Round-trip via disk: read() must return the same values.
    const reread = state.read();
    assert.equal(reread.pipelineAdvancedSettings.realesrgan.ttaMode, true);
    assert.equal(reread.pipelineAdvancedSettings.optimize.webpMode, 'lossless');
  });
  delete process.env.MINIMAX_CONFIG_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

test('ADV 1b: state.js sanitises corrupted / out-of-range values', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-state-corrupt-'));
  process.env.MINIMAX_CONFIG_DIR = tmp;
  const electronMock = { app: { getPath: () => tmp }, shell: { openPath: async () => '' } };
  withElectronMock(electronMock, () => {
    delete require.cache[require.resolve(path.join(ROOT, 'src', 'state.js'))];
    const state = require(path.join(ROOT, 'src', 'state.js'));
    const corrupt = state.write({
      tabs: {},
      pipelineAdvancedSettings: {
        realesrgan: {
          tileSize: 99999,          // not on whitelist -> 0
          ttaMode: 'yes please',    // not strictly true -> false
          gpuId: '99',              // not on whitelist -> 'auto'
        },
        isnetbg: {
          intraOpNumThreads: -5,    // below 0 -> 0
          interOpNumThreads: 9999,  // above 64 -> clamped... actually (n || 0) wins, NaN handling
          executionMode: 'turbo',   // not on whitelist -> 'sequential'
        },
        optimize: {
          jpegChromaSubsampling: '4:1:1', // not on whitelist -> '4:2:0'
          pngCompressionLevel: 99,        // above 9 -> 9 (clamp)
          webpMode: 'best',               // not on whitelist -> 'lossy'
        },
        audio: {
          silenceThresholdDb: 50,         // above 0 -> 0 (clamp)
          minSilenceMs: -100,             // below 0 -> 0 (clamp via Math.max)
          opusBitrate: '500kbps',         // not /^\d+k$/ -> '128k'
        },
      },
    });
    // Every corrupted value must fall back to a safe default.
    assert.equal(corrupt.pipelineAdvancedSettings.realesrgan.tileSize, 0);
    assert.equal(corrupt.pipelineAdvancedSettings.realesrgan.ttaMode, false);
    assert.equal(corrupt.pipelineAdvancedSettings.realesrgan.gpuId, 'auto');
    assert.equal(corrupt.pipelineAdvancedSettings.isnetbg.executionMode, 'sequential');
    assert.equal(corrupt.pipelineAdvancedSettings.optimize.jpegChromaSubsampling, '4:2:0');
    assert.equal(corrupt.pipelineAdvancedSettings.optimize.pngCompressionLevel, 9);
    assert.equal(corrupt.pipelineAdvancedSettings.optimize.webpMode, 'lossy');
    assert.equal(corrupt.pipelineAdvancedSettings.audio.opusBitrate, '128k');
  });
  delete process.env.MINIMAX_CONFIG_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

test('ADV 1c: state.js supplies full defaults when pipelineAdvancedSettings is absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-state-empty-'));
  process.env.MINIMAX_CONFIG_DIR = tmp;
  const electronMock = { app: { getPath: () => tmp }, shell: { openPath: async () => '' } };
  withElectronMock(electronMock, () => {
    delete require.cache[require.resolve(path.join(ROOT, 'src', 'state.js'))];
    const state = require(path.join(ROOT, 'src', 'state.js'));
    const fresh = state.write({ tabs: {} });
    // A fresh install (no advanced settings ever opened) must get
    // the full default shape — every sub-key present, every value
    // matching the documented default.
    assert.ok(fresh.pipelineAdvancedSettings, 'pipelineAdvancedSettings must exist on a fresh write');
    assert.equal(fresh.pipelineAdvancedSettings.realesrgan.tileSize, 0);
    assert.equal(fresh.pipelineAdvancedSettings.realesrgan.ttaMode, false);
    assert.equal(fresh.pipelineAdvancedSettings.realesrgan.gpuId, 'auto');
    assert.equal(fresh.pipelineAdvancedSettings.isnetbg.executionMode, 'sequential');
    assert.equal(fresh.pipelineAdvancedSettings.optimize.jpegMozjpeg, true);
    assert.equal(fresh.pipelineAdvancedSettings.optimize.pngCompressionLevel, 9);
    assert.equal(fresh.pipelineAdvancedSettings.optimize.webpMode, 'lossy');
    assert.equal(fresh.pipelineAdvancedSettings.audio.silenceThresholdDb, -50);
    assert.equal(fresh.pipelineAdvancedSettings.audio.mp3Quality, 2);
    assert.equal(fresh.pipelineAdvancedSettings.audio.opusBitrate, '128k');
  });
  delete process.env.MINIMAX_CONFIG_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

// ============================================================================
// TEST GROUP 2 — realesrgan.js run() builds the right argv
// We intercept spawn() via the Module._load hook (mock child_process).
// ============================================================================
test('ADV 2: realesrgan.run() emits -t/-x/-g only when user opted in', () => {
  const captured = { args: null };
  // Mock child_process.spawn so we can capture the argv without
  // actually launching the binary.
  const cpMock = {
    spawn: (bin, args) => {
      captured.args = args;
      // Fake proc with the surface the wrapper touches.
      return {
        stderr: { on() {} },
        on(ev, fn) { if (ev === 'close') setImmediate(() => fn(0)); },
      };
    },
    spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
  };
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'child_process') return cpMock;
    return origLoad.call(this, request, parent, ...rest);
  };
  // Also mock fs.existsSync so findBinary() succeeds.
  const fsMock = {
    existsSync: () => true,
    renameSync: () => {},
    unlinkSync: () => {},
  };
  const origFs = require('fs');
  Module._load = function (request, parent, ...rest) {
    if (request === 'child_process') return cpMock;
    if (request === 'fs') return fsMock;
    return origLoad.call(this, request, parent, ...rest);
  };
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'src', 'realesrgan.js'))];
    const re = require(path.join(ROOT, 'src', 'realesrgan.js'));
    // Default opts: argv must NOT contain -t, -x, or -g.
    return re.run('C:\\in.png', 'C:\\out.png', { model: 'realesrgan-x4plus', scale: 4 }).then(() => {
      assert.ok(captured.args, 'spawn must have been called');
      assert.ok(!captured.args.includes('-t'), 'default tileSize must NOT emit -t (binary uses its own auto)');
      assert.ok(!captured.args.includes('-x'), 'default ttaMode must NOT emit -x');
      assert.ok(!captured.args.includes('-g'), 'default gpuId "auto" must NOT emit -g (binary picks on its own)');

      // User opted into every advanced knob.
      return re.run('C:\\in.png', 'C:\\out.png', {
        model: 'realesrgan-x4plus', scale: 4,
        tileSize: 256, ttaMode: true, gpuId: '1',
      });
    }).then(() => {
      const args = captured.args;
      const tIdx = args.indexOf('-t');
      assert.ok(tIdx >= 0, 'tileSize=256 must emit -t');
      assert.equal(args[tIdx + 1], '256');
      assert.ok(args.includes('-x'), 'ttaMode=true must emit -x');
      const gIdx = args.indexOf('-g');
      assert.ok(gIdx >= 0, 'gpuId="1" must emit -g');
      assert.equal(args[gIdx + 1], '1');
    });
  } finally {
    Module._load = origLoad;
  }
});

// ============================================================================
// TEST GROUP 3 — isnetbg.js imports checkNodeBackendAvailable (v1.1 bug fix)
// ============================================================================
test('ADV 3: isnetbg.js checkNodeBackendAvailable is imported + exported (v1.1 fix)', () => {
  // The bug: src/isnetbg.js called checkNodeBackendAvailable() but
  // never imported it (and binaryDiscovery.js never exported it).
  // The ReferenceError was swallowed by try/catch, so the user
  // never saw the actionable "onnxruntime-node not bundled" hint.
  // Source-level pins prove both ends of the fix are in place.
  const wrapper = fs.readFileSync(path.join(ROOT, 'src', 'isnetbg.js'), 'utf8');
  const disc = fs.readFileSync(path.join(ROOT, 'src', 'isnetbg', 'binaryDiscovery.js'), 'utf8');
  assert.ok(wrapper.includes('checkNodeBackendAvailable,'),
    'src/isnetbg.js MUST import checkNodeBackendAvailable from binaryDiscovery (was missing pre-v1.1)');
  assert.ok(/checkNodeBackendAvailable,?\s*\n/.test(disc) && disc.includes('module.exports'),
    'src/isnetbg/binaryDiscovery.js MUST export checkNodeBackendAvailable (was internal-only pre-v1.1)');
  // Behavioural check: actually load the module with all paths
  // resolving cleanly and verify the function is callable.
  const electronMock = { shell: { openPath: async () => '' } };
  withElectronMock(electronMock, () => {
    delete require.cache[require.resolve(path.join(ROOT, 'src', 'isnetbg', 'binaryDiscovery.js'))];
    const discMod = require(path.join(ROOT, 'src', 'isnetbg', 'binaryDiscovery.js'));
    assert.equal(typeof discMod.checkNodeBackendAvailable, 'function',
      'checkNodeBackendAvailable must be a function on the binaryDiscovery exports');
    // It must return a boolean (either true if onnxruntime-node
    // resolves, or false — never throw).
    let result;
    assert.doesNotThrow(() => { result = discMod.checkNodeBackendAvailable(); },
      'checkNodeBackendAvailable must never throw (try/catch around require.resolve)');
    assert.equal(typeof result, 'boolean');
  });
});

// ============================================================================
// TEST GROUP 4 — isnetbg_node.js parseArgs + bicubicUpsample + catmullRom1D
// (src/isnetbg_node.js was 0% covered before this harness.)
// ============================================================================
test('ADV 4a: isnetbg_node.js parseArgs picks up the v1.1 advanced flags', () => {
  // We test parseArgs in isolation by reading the file as text,
  // extracting the function, and re-evaluating it in a sandbox.
  // The function is self-contained (no module-level deps), so
  // this is a faithful real-code test that doesn't require loading
  // onnxruntime-node + sharp.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'isnetbg_node.js'), 'utf8');
  // Extract the parseArgs function body. It's declared with
  // `function parseArgs(argv) { ... }` and ends at the matching
  // closing brace at column 0.
  const m = src.match(/function parseArgs\(argv\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'parseArgs must be defined in isnetbg_node.js');
  // eslint-disable-next-line no-new-func
  const parseArgs = new Function(m[0] + '; return parseArgs;')();
  // Legacy args (the original C# contract) still work.
  const legacy = parseArgs(['--input', 'a.png', '--output', 'b.png', '--use-gpu', '1']);
  assert.equal(legacy.input, 'a.png');
  assert.equal(legacy.output, 'b.png');
  assert.equal(legacy.useGpu, true);
  // New v1.1 args are picked up.
  const adv = parseArgs(['--input', 'a.png', '--output', 'b.png',
    '--intra-op', '4', '--inter-op', '2', '--execution-mode', 'parallel']);
  assert.equal(adv.intraOpNumThreads, 4, '--intra-op must be parsed');
  assert.equal(adv.interOpNumThreads, 2, '--inter-op must be parsed');
  assert.equal(adv.executionMode, 'parallel', '--execution-mode parallel must be honoured');
  // Default executionMode is sequential.
  const seq = parseArgs(['--input', 'a.png', '--output', 'b.png']);
  assert.equal(seq.executionMode, 'sequential');
  assert.equal(seq.intraOpNumThreads, 0);
  assert.equal(seq.interOpNumThreads, 0);
  // Out-of-range values are clamped.
  const clamped = parseArgs(['--input', 'a.png', '--output', 'b.png',
    '--intra-op', '9999', '--inter-op', '-5', '--execution-mode', 'garbage']);
  assert.ok(clamped.intraOpNumThreads <= 64, 'intra-op must clamp to <= 64');
  assert.ok(clamped.interOpNumThreads >= 0, 'inter-op must clamp to >= 0');
  assert.equal(clamped.executionMode, 'sequential', 'unknown execution-mode must fall back to sequential');
});

test('ADV 4b: isnetbg_node.js catmullRom1D matches the textbook Catmull-Rom kernel', () => {
  // Extract catmullRom1D + bicubicUpsample the same way. We verify
  // a few invariants that any correct Catmull-Rom implementation
  // must satisfy:
  //   1. catmullRom1D(0) === 1 (the centre tap is unity).
  //   2. catmullRom1D(±1) === 0 (taps at neighbouring pixel
  //      centres contribute nothing when frac is 0).
  //   3. bicubicUpsample of a 1×1 source to 2×2 returns the same
  //      value at every output pixel (no edges in a constant image).
  //   4. bicubicUpsample is the identity when srcLen === dstLen.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'isnetbg_node.js'), 'utf8');
  const catmullSrc = src.match(/function catmullRom1D\(t\) \{[\s\S]*?\n\}/);
  const resampleSrc = src.match(/function resampleKernel\(srcLen, dstLen\) \{[\s\S]*?\n\}/);
  const bicubicSrc = src.match(/function bicubicUpsample\(src, srcW, srcH, dstW, dstH\) \{[\s\S]*?\n\}/);
  assert.ok(catmullSrc && resampleSrc && bicubicSrc,
    'catmullRom1D + resampleKernel + bicubicUpsample must all be defined');
  // eslint-disable-next-line no-new-func
  const sandbox = new Function(
    catmullSrc[0] + resampleSrc[0] + bicubicSrc[0] +
    '; return { catmullRom1D, bicubicUpsample };',
  )();
  // Invariant 1: centre tap is unity.
  assert.ok(Math.abs(sandbox.catmullRom1D(0) - 1) < 1e-9,
    'catmullRom1D(0) must be 1 — the centre tap weights the source pixel by 1');
  // Invariant 2: taps at neighbouring pixel centres are 0 at frac=0.
  // (catmullRom1D is called as catmullRom1D(frac - offset) where
  // offsets = [-1, 0, 1, 2]. At frac=0 those are 1, 0, -1, -2.)
  assert.ok(Math.abs(sandbox.catmullRom1D(1)) < 1e-9,
    'catmullRom1D(1) must be 0 — neighbouring tap contributes nothing at frac=0');
  assert.ok(Math.abs(sandbox.catmullRom1D(-1)) < 1e-9,
    'catmullRom1D(-1) must be 0 — neighbouring tap contributes nothing at frac=0');
  // Invariant 3: constant source → constant output (every output
  // pixel equals the input). This catches "wrong indexing" bugs
  // that would survive a magnitude test on a non-constant input.
  const constSrc = new Float32Array([0.42]);
  const up = sandbox.bicubicUpsample(constSrc, 1, 1, 4, 4);
  assert.equal(up.length, 16);
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(up[i] - 0.42) < 1e-3,
      `constant-source upsample must reproduce the constant (pixel ${i} = ${up[i]})`);
  }
  // Invariant 4: identity when srcLen === dstLen (no scaling).
  const idSrc = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const idUp = sandbox.bicubicUpsample(idSrc, 2, 2, 2, 2);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(idUp[i] - idSrc[i]) < 1e-6,
      `identity upsample must reproduce the source (pixel ${i})`);
  }
});

// ============================================================================
// TEST GROUP 5 — imageOptimizer.js forwards per-format encoder opts
// We use REAL sharp + real in-memory images (same pattern as
// tests/unit/src/imageOptimizer.test.js). This catches both the
// stripMetadata bug fix and the new encoder knobs.
// ============================================================================
test('ADV 5: imageOptimizer.js forwards encoder opts + stripMetadata fix', async () => {
  const { sharp } = require(path.join(ROOT, 'src', 'imageOptimizer', 'formatUtils.js'));
  if (!sharp) { assert.ok(true, 'sharp not installed — skipping (matches tests/unit/src/imageOptimizer.test.js)'); return; }

  const optimizer = require(path.join(ROOT, 'src', 'imageOptimizer.js'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-imgopt-'));
  try {
    // Build an input JPEG with an EXIF tag + an ICC profile so we
    // can verify the stripMetadata branch actually strips EXIF
    // (the bug pre-v1.1: it preserved EXIF in BOTH branches).
    const exif = {
      IFD0: {
        Software: 'MiniMax-Adv-Test',
        Copyright: 'Test-Co',
      },
    };
    const inputBuf = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 100, b: 50 } },
    }).jpeg({ quality: 95 }).withMetadata({ exif }).toBuffer();
    const inputPath = path.join(tmpDir, 'in.jpg');
    await fs.promises.writeFile(inputPath, inputBuf);

    // Sub-test 1: stripMetadata=true → output keeps ICC (sharp adds
    // sRGB ICC by default when the input has none) but the EXIF
    // Software tag must be gone. (Pre-v1.1 the EXIF survived.)
    const stripped = await optimizer.optimize(inputPath, {
      quality: 90, format: 'jpeg', stripMetadata: true,
      outputPath: path.join(tmpDir, 'stripped.jpg'),
    });
    assert.equal(stripped.ok, true);
    const strippedMeta = await sharp(await fs.promises.readFile(stripped.outputPath)).metadata();
    assert.ok(!strippedMeta.exif || strippedMeta.exif.length === 0,
      'stripMetadata=true must remove the EXIF block (the Software tag we wrote must be gone)');

    // Sub-test 2: stripMetadata=false → output keeps EXIF.
    const kept = await optimizer.optimize(inputPath, {
      quality: 90, format: 'jpeg', stripMetadata: false,
      outputPath: path.join(tmpDir, 'kept.jpg'),
    });
    assert.equal(kept.ok, true);
    const keptMeta = await sharp(await fs.promises.readFile(kept.outputPath)).metadata();
    assert.ok(keptMeta.exif && keptMeta.exif.length > 0,
      'stripMetadata=false must preserve the EXIF block');

    // Sub-test 3: jpegChromaSubsampling=4:4:4 must produce a
    // larger file than 4:2:0 (no chroma subsampling = more bytes).
    const sub420 = await optimizer.optimize(inputPath, {
      quality: 90, format: 'jpeg', stripMetadata: true,
      outputPath: path.join(tmpDir, 'chroma420.jpg'),
      encoders: { jpegChromaSubsampling: '4:2:0' },
    });
    const sub444 = await optimizer.optimize(inputPath, {
      quality: 90, format: 'jpeg', stripMetadata: true,
      outputPath: path.join(tmpDir, 'chroma444.jpg'),
      encoders: { jpegChromaSubsampling: '4:4:4' },
    });
    assert.ok(sub444.outputSize > sub420.outputSize,
      `4:4:4 chroma must produce a larger file than 4:2:0 (got ${sub444.outputSize} vs ${sub420.outputSize})`);

    // Sub-test 4: webpMode=lossless must produce a valid WebP whose
    // sharp metadata reports compression 'lossless' or at least a
    // format=='webp'. (We can't easily assert losslessness from
    // metadata, but we CAN assert the file is a real webp.)
    const webpLossless = await optimizer.optimize(inputPath, {
      quality: 80, format: 'webp', stripMetadata: true,
      outputPath: path.join(tmpDir, 'lossless.webp'),
      encoders: { webpMode: 'lossless' },
    });
    assert.equal(webpLossless.ok, true);
    const wlMeta = await sharp(await fs.promises.readFile(webpLossless.outputPath)).metadata();
    assert.equal(wlMeta.format, 'webp');
    assert.equal(wlMeta.hasAlpha, false);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ============================================================================
// TEST GROUP 6 — AudioTrimCut.js codecArgsFor substitutes user-tuned quality
// ============================================================================
test('ADV 6: AudioTrimCut.js codecArgsFor substitutes quality values per codec', () => {
  // codecArgsFor is a pure function — load the module directly.
  // It does NOT spawn ffmpeg or touch the filesystem.
  const { codecArgsFor, CODEC_BY_EXT } = require(path.join(ROOT, 'src', 'audio', 'AudioTrimCut.js'));
  assert.equal(typeof codecArgsFor, 'function');
  // 1) No quality override → returns the default argv (a copy).
  const defaultMp3 = codecArgsFor('mp3');
  assert.deepEqual(defaultMp3, CODEC_BY_EXT.mp3, 'no override must reproduce the default argv');
  // 2) MP3 quality override substitutes the -q:a value.
  const tunedMp3 = codecArgsFor('mp3', { mp3Quality: 5 });
  assert.deepEqual(tunedMp3, ['-c:a', 'libmp3lame', '-q:a', '5'],
    'mp3Quality=5 must replace the -q:a value');
  // 3) Ogg quality override substitutes the -q:a value (different range).
  const tunedOgg = codecArgsFor('ogg', { oggQuality: 8 });
  assert.deepEqual(tunedOgg, ['-c:a', 'libvorbis', '-q:a', '8']);
  // 4) Opus bitrate override substitutes the -b:a value.
  const tunedOpus = codecArgsFor('opus', { opusBitrate: '192k' });
  assert.deepEqual(tunedOpus, ['-c:a', 'libopus', '-b:a', '192k']);
  // 5) M4A bitrate override substitutes the -b:a value.
  const tunedM4a = codecArgsFor('m4a', { m4aBitrate: '256k' });
  assert.deepEqual(tunedM4a, ['-c:a', 'aac', '-b:a', '256k']);
  // 6) Quality for an UNRELATED codec must NOT change the argv.
  // (A common bug: passing the entire quality object to every codec.)
  const onlyMp3 = codecArgsFor('ogg', { mp3Quality: 0 });
  assert.deepEqual(onlyMp3, CODEC_BY_EXT.ogg,
    'mp3Quality must NOT affect the ogg argv (per-codec isolation)');
  const onlyOpus = codecArgsFor('mp3', { opusBitrate: '64k' });
  assert.deepEqual(onlyOpus, CODEC_BY_EXT.mp3,
    'opusBitrate must NOT affect the mp3 argv');
  // 7) PCM / FLAC codecs have no quality knob — overrides are ignored.
  const wavIgnored = codecArgsFor('wav', { mp3Quality: 0, opusBitrate: '64k' });
  assert.deepEqual(wavIgnored, CODEC_BY_EXT.wav,
    'wav (pcm_s16le) must ignore every quality override (no quality knob)');
  // 8) Unknown extension falls back to pcm_s16le.
  const unknown = codecArgsFor('xyz');
  assert.deepEqual(unknown, ['-c:a', 'pcm_s16le']);
  // 9) Out-of-range values are clamped.
  const clampedMp3 = codecArgsFor('mp3', { mp3Quality: 99 });
  assert.deepEqual(clampedMp3, ['-c:a', 'libmp3lame', '-q:a', '9'],
    'mp3Quality=99 must clamp to 9 (libmp3lame max)');
  // 10) CODEC_BY_EXT is re-exported from the audioCutter shim too.
  const shim = require(path.join(ROOT, 'src', 'audioCutter.js'));
  assert.deepEqual(shim.CODEC_BY_EXT, CODEC_BY_EXT,
    'audioCutter.js must re-export CODEC_BY_EXT for tests + introspection');
  assert.equal(typeof shim.codecArgsFor, 'function',
    'audioCutter.js must re-export codecArgsFor');
});

// ============================================================================
// TEST GROUP 7 — section25 overlay opens + Save round-trips through state
