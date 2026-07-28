// tests/unit/renderer/imageEditorR4Gate.test.js
// ============================================================================
// R4-Gate — Verification gate for the entire R4 phase.
//
// R4 is composed of 6 sub-phases (per design contract §Phase R4):
//   R4.1   Natural Scene Renderer (PE-001) — pure helper that
//          builds a temp fabric.StaticCanvas with identity VPT
//          and renders at natural dimensions.
//   R4.2   Save/Alpha/JPEG consumer migration (4 callsites in
//          imageEditorActions.js use renderSceneAtNaturalSize).
//   R4.3   Empty Prompt state machine (PE-003) — idle / loading /
//          success / error / cancel transitions for the "Load
//          image…" button when no path is provided.
//   R4.4   Queuehosts (PE-002) — persistent host per slot, stable
//          slot.id, A→B→A works without detaching canvases.
//   R4.5   Source-/Cursorlistener (PE-027 + PE-035) — dropzone +
//          brush-cursor use single-wrapper-listener + disposer.
//   R4.6   Cursor-Zoom (PE-012) — pan-aware display-to-scene
//          conversion; drift < 0.01 px.
//
// R4-Gate acceptance criterion (per design contract): Natural Export +
// A→B→A + Prompt + Listener + Zoom grün; Pixelhash bei allen VPTs
// identisch.
//
// The "Pixelhash bei allen VPTs identisch" acceptance criterion
// requires real-Fabric rendering (real <canvas> 2D context) which
// the current vm-sandbox test environment does not provide.
// The R4-Gate is therefore implemented as:
//   1. A meta-verification that all 5 R4 sub-phases'
//      source-grep markers are present (structural defense).
//   2. An integration test that exercises the combined flow
//      (zoom + natural-export + A→B→A) with a counting
//      FakeCanvas and verifies the natural-export produces
//      consistent dimensions + object count regardless of the
//      live canvas's VPT.
//   3. A re-run of all 5 R4 test files (one source-grep per
//      test file) to verify the R4 sub-phases haven't regressed.
//
// A real-Fabric pixelhash verification (the actual R4-Gate
// acceptance) is deferred to a future card that runs in a
// browser environment (puppeteer / electron).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CANVAS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorCanvas.js');
const OVERLAY_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorOverlay.js');
const TOOLS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorTools.js');
const SOURCE_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorSource.js');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

// ============================================================================
// 1. Meta-verification: all 5 R4 sub-phase markers are present
// ============================================================================

test('R4-Gate.1.A: R4.1 marker — renderSceneAtNaturalSize is defined + exposed on both handle and session', () => {
  const src = fs.readFileSync(CANVAS_JS, 'utf8');
  // function renderSceneAtNaturalSize() {...} defined in the IIFE
  assert.ok(/function\s+renderSceneAtNaturalSize\s*\(/.test(src),
    'R4-Gate.1.A: renderSceneAtNaturalSize function must be defined in imageEditorCanvas.js');
  // Exposed on the handle (return object). Use a robust regex
  // (R4-Gate.AuditFix P-R4G-DOC-2) that just checks for the
  // string within the return block, not the exact whitespace
  // pattern. The block starts at `return {` and ends at the
  // matching `};` — we use a simple substring check.
  assert.ok(/return\s*\{[^{}]*renderSceneAtNaturalSize[^{}]*\};/.test(src),
    'R4-Gate.1.A: renderSceneAtNaturalSize must be exposed on the handle (return object)');
  // Exposed on the inner session (R4.2 P-R42-01 fix)
  assert.ok(/session\.renderSceneAtNaturalSize\s*=\s*renderSceneAtNaturalSize/.test(src),
    'R4-Gate.1.A: renderSceneAtNaturalSize must be exposed on the inner session (R4.2 P-R42-01 fix)');
});

test('R4-Gate.1.B: R4.2 marker — Save/Alpha/JPEG/Bake use renderSceneAtNaturalSize', () => {
  const actionsSrc = fs.readFileSync(ROOT + '/renderer/overlays/imageEditorActions.js', 'utf8');
  const codeOnly = stripComments(actionsSrc);
  // At least 4 callsites use renderSceneAtNaturalSize (canvasHasAlpha,
  // flattenOntoMatte, doSave PNG/JPEG/WebP, onBake).
  const matches = codeOnly.match(/renderSceneAtNaturalSize\s*\(\s*\)/g) || [];
  assert.ok(matches.length >= 4,
    `R4-Gate.1.B: imageEditorActions.js must call renderSceneAtNaturalSize at least 4 times (got ${matches.length})`);
});

test('R4-Gate.1.C: R4.3 marker — Empty Prompt state machine has setMode + data-state attribute', () => {
  const keyboardSrc = fs.readFileSync(ROOT + '/renderer/overlays/imageEditorKeyboard.js', 'utf8');
  const codeOnly = stripComments(keyboardSrc);
  assert.ok(/setMode/.test(codeOnly),
    'R4-Gate.1.C: showEmptyPrompt must have setMode helper for state transitions');
  assert.ok(/data-state/.test(codeOnly),
    'R4-Gate.1.C: showEmptyPrompt must set data-state attribute on the prompt element');
  // hideEmptyPrompt + resetEmptyPrompt are exposed for activateSlot to call
  assert.ok(/hideEmptyPrompt/.test(codeOnly) && /resetEmptyPrompt/.test(codeOnly),
    'R4-Gate.1.C: hideEmptyPrompt + resetEmptyPrompt must be exposed for activateSlot');
});

test('R4-Gate.1.D: R4.4 marker — Queuehosts pattern (mintSlotId + showOnlyHost + data-slot-id)', () => {
  const overlaySrc = fs.readFileSync(OVERLAY_JS, 'utf8');
  const codeOnly = stripComments(overlaySrc);
  // mintSlotId counter
  assert.ok(/let\s+_nextSlotId\s*=\s*1/.test(codeOnly) && /function\s+mintSlotId\s*\(\)/.test(codeOnly),
    'R4-Gate.1.D: mintSlotId counter must be defined in imageEditorOverlay.js (R4.4.AuditFix P-R44-01)');
  // showOnlyHost helper
  assert.ok(/function\s+showOnlyHost/.test(codeOnly),
    'R4-Gate.1.D: showOnlyHost helper must be defined (R4.4 PE-002 fix)');
  // data-slot-id attribute on the host
  assert.ok(/setAttribute\(['"]data-slot-id['"]/.test(codeOnly),
    'R4-Gate.1.D: hosts must set data-slot-id attribute (R4.4 PE-002 fix)');
  // setupSourceThumbDropZone called from buildSourceTray (R4.5)
  assert.ok(/setupSourceThumbDropZone/.test(codeOnly),
    'R4-Gate.1.D: setupSourceThumbDropZone must be called from buildSourceTray (R4.5 PE-027 fix)');
});

test('R4-Gate.1.E: R4.5 marker — Single-wrapper-listener pattern (installBrushCursor guard + disposer)', () => {
  const toolsSrc = fs.readFileSync(TOOLS_JS, 'utf8');
  const codeOnly = stripComments(toolsSrc);
  // Idempotent guard
  assert.ok(/_ieBrushCursorInstalled/.test(codeOnly),
    'R4-Gate.1.E: installBrushCursor must use _ieBrushCursorInstalled guard (R4.5 PE-035 fix)');
  // Returns a disposer
  assert.ok(/return\s+function\s+disposeBrushCursor/.test(codeOnly),
    'R4-Gate.1.E: installBrushCursor must return a disposer function (R4.5 PE-035 fix)');
  // setupSourceThumbDropZone in source module
  const sourceSrc = fs.readFileSync(SOURCE_JS, 'utf8');
  const sourceCodeOnly = stripComments(sourceSrc);
  assert.ok(/function\s+setupSourceThumbDropZone/.test(sourceCodeOnly),
    'R4-Gate.1.E: setupSourceThumbDropZone must be defined in imageEditorSource.js (R4.5 PE-027 fix)');
});

test('R4-Gate.1.F: R4.6 marker — Cursor-Zoom pan-aware conversion (vpt[4] + vpt[5])', () => {
  const canvasSrc = fs.readFileSync(CANVAS_JS, 'utf8');
  const codeOnly = stripComments(canvasSrc);
  // zoomAt must use vpt[4] and vpt[5] (panX, panY)
  assert.ok(/vpt\[4\]|panX/.test(codeOnly),
    'R4-Gate.1.F: zoomAt must use VPT[4] (panX) for the display-to-scene conversion (R4.6 PE-012 fix)');
  assert.ok(/vpt\[5\]|panY/.test(codeOnly),
    'R4-Gate.1.F: zoomAt must use VPT[5] (panY) for the display-to-scene conversion (R4.6 PE-012 fix)');
  // session.zoom syncs from canvas.getZoom() (single-source-of-truth)
  assert.ok(/session\.zoom\s*=\s*canvas\.getZoom/.test(codeOnly),
    'R4-Gate.1.F: session.zoom must sync from canvas.getZoom() (R4.6 PE-012 fix)');
  // Pre-fix pattern is GONE
  assert.equal(codeOnly.indexOf('displayPoint.x / session.zoom'), -1,
    'R4-Gate.1.F: pre-fix `displayPoint.x / session.zoom` must be GONE (R4.6 PE-012 fix)');
});

// ============================================================================
// 2. Integration test: zoom + natural-export + A→B→A
// ============================================================================

const vm = require('vm');

function makeFakeCanvas(initialVpt) {
  let vpt = initialVpt.slice();
  const canvasListeners = {};
  const objects = [];
  return {
    width: 200, height: 200,
    getWidth() { return this.width; },
    getHeight() { return this.height; },
    setWidth(w) { this.width = w; },
    setHeight(h) { this.height = h; },
    get viewportTransform() { return vpt; },
    setViewportTransform(newVpt) { vpt = newVpt.slice(); },
    getZoom() { return vpt[0] || 1; },
    zoomToPoint(point, newZoom) {
      const oldDisplayX = vpt[0] * point.x + vpt[4];
      const oldDisplayY = vpt[3] * point.y + vpt[5];
      vpt = [newZoom, 0, 0, newZoom, oldDisplayX - newZoom * point.x, oldDisplayY - newZoom * point.y];
    },
    on(type, fn) { (canvasListeners[type] = canvasListeners[type] || []).push(fn); },
    off(type, fn) {
      const arr = canvasListeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    fire(type, payload) {
      const arr = canvasListeners[type] || [];
      for (const fn of arr) fn(payload);
    },
    add(o) { objects.push(o); },
    getObjects() { return objects; },
    remove(o) {
      const i = objects.indexOf(o);
      if (i >= 0) objects.splice(i, 1);
    },
    sendObjectToBack() {},
    requestRenderAll() {},
    setBackgroundColor() {},
    toJSON: () => 'mocked',
    loadFromJSON: (j, cb) => { if (cb) cb(); return Promise.resolve(); },
    toCanvasElement: () => ({ width: 200, height: 100, getContext: () => null }),
    toDataURL: () => 'data:image/png;base64,FAKE',
    dispose() {},
    setViewportTransform_called_with: null,
    _vpt: vpt,
  };
}

function makeFakeStaticCanvas() {
  const objects = [];
  let vpt = [1, 0, 0, 1, 0, 0];
  return {
    width: 0, height: 0,
    setViewportTransform(newVpt) { vpt = newVpt.slice(); },
    get viewportTransform() { return vpt; },
    add(o) { objects.push(o); },
    getObjects() { return objects; },
    setBackgroundColor() {},
    renderAll() {},
    renderCanvas: null,
    toCanvasElement: () => ({ width: 0, height: 0, getContext: () => null }),
    toDataURL: () => 'data:image/png;base64,FAKE',
    dispose() {},
  };
}

function makeFakeFabric() {
  function FakeCanvas(hostEl, opts) {
    this._state = makeFakeCanvas([1, 0, 0, 1, 0, 0]);
    this._opts = opts;
  }
  FakeCanvas.prototype.setWidth = function (w) { this._state.width = w; };
  FakeCanvas.prototype.setHeight = function (h) { this._state.height = h; };
  FakeCanvas.prototype.getWidth = function () { return this._state.width; };
  FakeCanvas.prototype.getHeight = function () { return this._state.height; };
  FakeCanvas.prototype.zoomToPoint = function (point, z) { this._state.zoomToPoint(point, z); };
  FakeCanvas.prototype.setViewportTransform = function (v) { this._state.setViewportTransform(v); };
  FakeCanvas.prototype.getZoom = function () { return this._state.getZoom(); };
  FakeCanvas.prototype.on = function (type, fn) { this._state.on(type, fn); };
  FakeCanvas.prototype.off = function (type, fn) { this._state.off(type, fn); };
  FakeCanvas.prototype.fire = function (type, payload) { this._state.fire(type, payload); };
  FakeCanvas.prototype.add = function (o) { this._state.add(o); };
  FakeCanvas.prototype.getObjects = function () { return this._state.getObjects(); };
  FakeCanvas.prototype.remove = function (o) { this._state.remove(o); };
  FakeCanvas.prototype.sendObjectToBack = function (o) { this._state.sendObjectToBack(o); };
  FakeCanvas.prototype.requestRenderAll = function () { this._state.requestRenderAll(); };
  FakeCanvas.prototype.toJSON = function () { return 'mocked'; };
  FakeCanvas.prototype.loadFromJSON = function (j, cb) { if (cb) cb(); return Promise.resolve(); };
  FakeCanvas.prototype.toCanvasElement = function (m) { return { width: this._state.width, height: this._state.height, getContext: () => null }; };
  FakeCanvas.prototype.toDataURL = function () { return 'data:image/png;base64,FAKE'; };
  FakeCanvas.prototype.dispose = function () { this._state.dispose(); };
  Object.defineProperty(FakeCanvas.prototype, 'viewportTransform', { get: function () { return this._state.viewportTransform; } });

  function FakeStaticCanvas(hostEl, opts) {
    this._state = makeFakeStaticCanvas();
    this._opts = opts;
  }
  FakeStaticCanvas.prototype.setViewportTransform = function (v) { this._state.setViewportTransform(v); };
  FakeStaticCanvas.prototype.add = function (o) { this._state.add(o); };
  FakeStaticCanvas.prototype.getObjects = function () { return this._state.getObjects(); };
  FakeStaticCanvas.prototype.setBackgroundColor = function (c) { this._state.setBackgroundColor(c); };
  FakeStaticCanvas.prototype.renderAll = function () { this._state.renderAll(); };
  FakeStaticCanvas.prototype.toCanvasElement = function (m) { return { width: this._opts.width, height: this._opts.height, getContext: () => null }; };
  FakeStaticCanvas.prototype.toDataURL = function () { return 'data:image/png;base64,FAKE'; };
  FakeStaticCanvas.prototype.dispose = function () { this._state.dispose(); };
  Object.defineProperty(FakeStaticCanvas.prototype, 'viewportTransform', { get: function () { return this._state.viewportTransform; } });

  // gewv2 NF-02 fix: fabric.Image must be usable as `new fabric.Image(el)`
  // (real Fabric v6 constructor) — renderSceneAtNaturalSize wraps its pixel
  // snapshot in one. Previously only `.fromURL` was exposed, which broke
  // with "fabric.Image is not a constructor".
  function FakeImage(imgEl, opts) {
    this._el = imgEl; this._opts = opts; this.width = 100; this.height = 60;
  }
  FakeImage.prototype.set = function () {};
  FakeImage.prototype.scale = function () {};
  FakeImage.fromURL = () => Promise.resolve(new FakeImage());
  return { Canvas: FakeCanvas, StaticCanvas: FakeStaticCanvas, Image: FakeImage };
}

function loadCreateEditorSession() {
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  sb.fabric = makeFakeFabric();
  vm.runInContext(fs.readFileSync(CANVAS_JS, 'utf8'), sb, { filename: 'imageEditorCanvas.js' });
  return sb.ImageEditorCanvas.createEditorSession({}, 200, 100);
}

test('R4-Gate.2: natural export produces consistent dimensions across all VPTs (R4.1 verify at the gate level)', () => {
  // The acceptance criterion: "Pixelhash bei allen VPTs identisch".
  // Without real Fabric rendering we can't compute the actual
  // pixelhash, but we can verify that the dimensions + object
  // count are IDENTICAL across VPTs (the natural export is
  // VPT-invariant by construction).
  const handle = loadCreateEditorSession();
  // Add a single "drawing" object (a red square).
  const obj = { type: 'path', left: 10, top: 10, width: 20, height: 20 };
  handle.session.canvas.add(obj);

  // Test 5 different VPTs.
  const vpts = [
    [1, 0, 0, 1, 0, 0],       // identity
    [0.25, 0, 0, 0.25, 50, 50], // 25% zoom + pan
    [0.5, 0, 0, 0.5, 25, 25],   // 50% zoom + pan
    [2, 0, 0, 2, -100, -100],   // 200% zoom + negative pan
    [4, 0, 0, 4, 0, 0],         // 400% zoom
  ];

  const results = [];
  for (const vpt of vpts) {
    handle.session.canvas.setViewportTransform(vpt);
    const temp = handle.session.renderSceneAtNaturalSize();
    const out = temp.toCanvasElement(1);
    results.push({ width: out.width, height: out.height, objects: temp.getObjects().length });
  }

  // All results must be identical.
  for (let i = 1; i < results.length; i++) {
    assert.deepEqual(results[i], results[0],
      `R4-Gate.2: VPT ${i} result must match VPT 0 result. Got ${JSON.stringify(results[i])} vs ${JSON.stringify(results[0])}`);
  }
  // The natural dimensions must be 200×100 (the imageW × imageH).
  assert.equal(results[0].width, 200, 'R4-Gate.2: natural width must be imgW (200)');
  assert.equal(results[0].height, 100, 'R4-Gate.2: natural height must be imgH (100)');
  assert.equal(results[0].objects, 1, 'R4-Gate.2: 1 object must be exported');
});

test('R4-Gate.2.AuditFix P-R4G-LIMITATION-1: VPT-invariance holds for 0 objects AND N=10 objects', () => {
  // R4-Gate.AuditFix P-R4G-LIMITATION-1: the original R4-Gate.2
  // only tested with 1 object. Edge cases (0 objects — empty
  // canvas — and N objects — many drawings) were not directly
  // verified. This test exercises both edge cases.
  const handle0 = loadCreateEditorSession(); // 0 objects
  const handleN = loadCreateEditorSession();
  for (let i = 0; i < 10; i++) {
    handleN.session.canvas.add({ type: 'rect', left: i * 10, top: i * 5, width: 8, height: 4 });
  }

  for (const handle of [handle0, handleN]) {
    const vpts = [
      [1, 0, 0, 1, 0, 0],
      [0.5, 0, 0, 0.5, 25, 25],
      [2, 0, 0, 2, -50, -50],
    ];
    const results = [];
    for (const vpt of vpts) {
      handle.session.canvas.setViewportTransform(vpt);
      const temp = handle.session.renderSceneAtNaturalSize();
      const out = temp.toCanvasElement(1);
      results.push({ width: out.width, height: out.height, objects: temp.getObjects().length });
    }
    for (let i = 1; i < results.length; i++) {
      assert.deepEqual(results[i], results[0],
        `P-R4G-LIMITATION-1: handle with ${handle.session.canvas.getObjects().length} objects — VPT ${i} result must match VPT 0 result`);
    }
  }
  // gewv2 NF-02 fix: renderSceneAtNaturalSize now returns a temp canvas
  // holding ONE flattened snapshot image (not a per-object copy) — so the
  // temp always has exactly 1 object regardless of how many live objects
  // were drawn (0 or 10). This is what makes the export VPT-invariant AND
  // safe (no live-object re-parenting); see imageEditorNaturalScene.r4.test.js
  // PE-001.E/G/I for the direct regression coverage.
  const temp0 = handle0.session.renderSceneAtNaturalSize();
  assert.equal(temp0.getObjects().length, 1, 'P-R4G-LIMITATION-1: empty live canvas still exports 1 flattened (blank) snapshot image');
  const tempN = handleN.session.renderSceneAtNaturalSize();
  assert.equal(tempN.getObjects().length, 1, 'P-R4G-LIMITATION-1: N=10 live objects flatten into 1 snapshot image');
});

test('R4-Gate.3: A→B→A combined with zoom + natural export (R4.4 + R4.6 + R4.1 combined)', () => {
  // Known limitation (P-R4G-LIMITATION-2): this test uses 2
  // SEPARATE sessions (handleA, handleB), not the SAME ctrl
  // with 2 slots. The actual activateSlot flow at the
  // controller level is tested in imageEditorQueueR44.test.js
  // (which is included in R4-Gate.5 subprocess re-run). This
  // gate test verifies the LEAF function (renderSceneAtNaturalSize)
  // works correctly across slot switches; the controller-level
  // wiring is verified separately.
  //
  // Simulate the A→B→A flow: zoom at A, switch to B, switch back
  // to A, export. The export must produce the same dimensions
  // and object count regardless of the VPT changes.
  const handleA = loadCreateEditorSession();
  const handleB = loadCreateEditorSession();
  // Add a "drawing" object to each.
  handleA.session.canvas.add({ type: 'path', left: 10, top: 10 });
  handleB.session.canvas.add({ type: 'rect', left: 20, top: 20 });

  // Step 1: zoom at A.
  handleA.session.canvas.setViewportTransform([0.5, 0, 0, 0.5, 10, 20]);
  handleA.zoomAt({ x: 150, y: 100 }, 1.5);

  // Step 2: switch to B (re-activate).
  handleB.session.canvas.setViewportTransform([2, 0, 0, 2, -50, -50]);
  // (no zoom at B)

  // Step 3: switch back to A. The VPT must be preserved.
  handleA.session.canvas.setViewportTransform(handleA.session.canvas.viewportTransform.slice());

  // Step 4: export A.
  const tempA = handleA.session.renderSceneAtNaturalSize();
  const outA = tempA.toCanvasElement(1);

  // The export must be at natural dimensions.
  assert.equal(outA.width, 200, 'R4-Gate.3: A export width must be natural (200)');
  assert.equal(outA.height, 100, 'R4-Gate.3: A export height must be natural (100)');
  assert.equal(tempA.getObjects().length, 1, 'R4-Gate.3: A must have 1 object');

  // Step 5: export B.
  const tempB = handleB.session.renderSceneAtNaturalSize();
  const outB = tempB.toCanvasElement(1);
  assert.equal(outB.width, 200, 'R4-Gate.3: B export width must be natural (200)');
  assert.equal(outB.height, 100, 'R4-Gate.3: B export height must be natural (100)');
  assert.equal(tempB.getObjects().length, 1, 'R4-Gate.3: B must have 1 object');

  // The two exports must have the same dimensions (VPT-invariant).
  assert.equal(outA.width, outB.width, 'R4-Gate.3: A and B export widths must match');
  assert.equal(outA.height, outB.height, 'R4-Gate.3: A and B export heights must match');
});

test('R4-Gate.4: cursor-zoom with panned VPT preserves the natural export (R4.6 + R4.1 combined)', () => {
  // Known limitation (P-R4G-LIMITATION-3): this test verifies
  // that the natural export dimensions remain 200×100 after
  // cursor-zoom. It does NOT verify the cursor-zoom math
  // itself (drift < 0.01 px) — the export is VPT-invariant
  // by construction, so the cursor position doesn't affect
  // the output dimensions. The cursor-zoom math is verified
  // in imageEditorZoomR46.test.js (which is included in
  // R4-Gate.5 subprocess re-run).
  //
  // The combined invariant: zooming at a panned cursor must
  // not break the natural export. The export must still be
  // at natural dimensions regardless of the new VPT.
  const handle = loadCreateEditorSession();
  handle.session.canvas.add({ type: 'path', left: 5, top: 5 });

  // Pre-zoom: panned VPT.
  handle.session.canvas.setViewportTransform([0.5, 0, 0, 0.5, 10, 20]);
  handle.session.zoom = 0.5;

  // Zoom in 5x at the cursor (150, 100).
  for (let i = 0; i < 5; i++) {
    handle.zoomAt({ x: 150, y: 100 }, 1.3);
  }

  // Export must be at natural dimensions.
  const temp = handle.session.renderSceneAtNaturalSize();
  const out = temp.toCanvasElement(1);
  assert.equal(out.width, 200, 'R4-Gate.4: export width must be natural (200) after zoomAt with panned VPT');
  assert.equal(out.height, 100, 'R4-Gate.4: export height must be natural (100) after zoomAt with panned VPT');
  assert.equal(temp.getObjects().length, 1, 'R4-Gate.4: 1 object must be exported');
});

// ============================================================================
// 3. R4 sub-phase tests are still green
// ============================================================================

const { execFileSync } = require('child_process');

test('R4-Gate.5: all 7 R4 sub-phase test files pass', () => {
  // Run each R4 test file in a subprocess and verify all pass.
  // R4.2 + R4.2.follow-up are included via the consumer
  // migration tests (imageEditorActionsR42 + imageEditorPe001Migrate).
  //
  // R4-Gate.AuditFix P-R4G-EDGE-1: each subprocess has a
  // 30-second timeout. If a test file hangs (e.g., infinite
  // loop in a new test), the gate fails fast instead of
  // waiting indefinitely.
  const testFiles = [
    'tests/unit/renderer/imageEditorNaturalScene.r4.test.js',     // R4.1
    'tests/unit/renderer/imageEditorActionsR42.test.js',           // R4.2
    'tests/unit/renderer/imageEditorPe001Migrate.test.js',         // R4.2.follow-up
    'tests/unit/renderer/imageEditorKeyboardR43.test.js',          // R4.3
    'tests/unit/renderer/imageEditorQueueR44.test.js',             // R4.4
    'tests/unit/renderer/imageEditorListenersR45.test.js',         // R4.5
    'tests/unit/renderer/imageEditorZoomR46.test.js',             // R4.6
  ];
  const SUBPROCESS_TIMEOUT_MS = 30000; // 30s per test file
  const results = [];
  // R5.1.AuditFix R-1: build a clean env for the subprocess
  // that strips the test-runner markers inherited from the
  // parent. When this test is itself run from `node --test`,
  // the parent env contains `NODE_TEST_CONTEXT=child-v8` and
  // `NODE_TEST_WORKER_ID=1`. The subprocess detects these
  // and switches to TAP/JSON output mode (or refuses to run
  // with `node --test`). The pre-fix regex `/ℹ pass (\d+)/`
  // then fails to match.
  const subprocessEnv = Object.assign({}, process.env);
  delete subprocessEnv.NODE_TEST_CONTEXT;
  delete subprocessEnv.NODE_TEST_WORKER_ID;
  for (const file of testFiles) {
    try {
      const out = execFileSync('node', [path.join(ROOT, file)], {
        encoding: 'utf8',
        timeout: SUBPROCESS_TIMEOUT_MS,
        env: subprocessEnv,
      });
      // The test runner outputs a summary like "ℹ pass N" at the end.
      const passMatch = out.match(/(?:ℹ pass|# pass) (\d+)/);
      const failMatch = out.match(/(?:ℹ fail|# fail) (\d+)/);
      const pass = passMatch ? parseInt(passMatch[1], 10) : 0;
      const fail = failMatch ? parseInt(failMatch[1], 10) : 0;
      results.push({ file: path.basename(file), pass, fail });
    } catch (e) {
      // Distinguish timeout from other errors.
      const isTimeout = e.killed === true || /ETIMEDOUT|timeout/i.test(e.message || '');
      results.push({
        file: path.basename(file),
        pass: 0,
        fail: -1,
        error: isTimeout ? `TIMEOUT after ${SUBPROCESS_TIMEOUT_MS}ms` : e.message,
      });
    }
  }
  for (const r of results) {
    assert.equal(r.fail, 0, `R4-Gate.5: ${r.file} must have 0 failures (got ${r.fail}${r.error ? ': ' + r.error : ''})`);
    assert.ok(r.pass > 0, `R4-Gate.5: ${r.file} must have > 0 passing tests (got ${r.pass})`);
  }
  // The R4.1 + R4.2 + R4.2.follow-up + R4.3 + R4.4 + R4.5 + R4.6 totals
  // are at least 14 + 14 + 7 + 17 + 9 + 19 + 14 = 94 tests.
  const totalPass = results.reduce((acc, r) => acc + r.pass, 0);
  assert.ok(totalPass >= 94,
    `R4-Gate.5: total R4 test count must be >= 94 (got ${totalPass})`);
});
