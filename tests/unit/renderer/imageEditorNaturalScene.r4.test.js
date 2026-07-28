// tests/unit/renderer/imageEditorNaturalScene.r4.test.js
// ============================================================================
// R4.1 — Natural-Scene Renderer (PE-001).
//
// Background: Fabric 6's `toCanvasElement(multiplier)` and
// `toDataURL({multiplier})` BOTH honour the live canvas's current
// viewport transform (zoom + pan + fit). Exporting a 100×100 red
// square at zoom 0.5 produced 2.500 opaque red pixels instead of
// 10.000 (PE-001 repro). The R4.1 fix: a new pure helper
// `renderSceneAtNaturalSize(session)` that renders at natural size
// with an identity VPT. The visible viewport is NOT modified (no
// setWidth / setHeight / setViewportTransform LEFT on the live
// instance — it is set to identity only for the duration of the
// snapshot, then restored) — so the user sees no flicker.
//
// gewv2 NF-02 rewrite (2026-07-23): the ORIGINAL R4.1 implementation
// copied live fabric objects into the temp canvas via `temp.add(o)`.
// In real Fabric v6, `add()` REMOVES an object from whatever canvas it
// currently belongs to — so after the FIRST call, every live object was
// silently stripped off the live canvas, and every subsequent
// save/bake/remove-bg/render wrote a BLANK image. The old FakeCanvas
// mock's `add()` never simulated this cross-canvas removal, so 1941
// green unit tests coexisted with a 100%-reproducible blank-save bug in
// the real app (see gewv2.md finding NF-02, live-proven three ways).
//
// The FIX: `renderSceneAtNaturalSize` now takes a PIXEL SNAPSHOT of the
// live canvas (`canvas.toCanvasElement(1, {left,top,width,height})` at
// an identity VPT that is set-then-restored) and wraps that snapshot in
// a single `fabric.Image` on the temp canvas. No object ever changes
// canvas membership. `_isHelper` objects (snap guides) are excluded by
// temporarily setting `visible = false` for the snapshot only, then
// restoring — again, no membership change.
//
// This file's tests are rewritten to pin the NEW contract, including
// the actual regression check for NF-02: live canvas objects survive
// (and remain fully rendered) across MULTIPLE calls to
// renderSceneAtNaturalSize.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CANVAS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorCanvas.js');

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    children: [], style: {}, dataset: {}, classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 200 }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

// ---- Fake Fabric with StaticCanvas support for R4.1 ----
function installFakeFabric(sandbox) {
  function FakeCanvas(hostEl, opts) {
    this._objects = []; this._vp = [1, 0, 0, 1, 0, 0];
    this.width = 0; this.height = 0; this.isDrawingMode = false;
    this.freeDrawingBrush = null; this.backgroundColor = '';
    this.selection = true; this.defaultCursor = 'default';
    this._listeners = {};
    this.toCanvasElementCalls = [];
  }
  FakeCanvas.prototype.setWidth = function (w) { this.width = w; };
  FakeCanvas.prototype.setHeight = function (h) { this.height = h; };
  FakeCanvas.prototype.getWidth = function () { return this.width; };
  FakeCanvas.prototype.getHeight = function () { return this.height; };
  FakeCanvas.prototype.add = function (o) { this._objects.push(o); return o; };
  FakeCanvas.prototype.remove = function (o) {
    const i = this._objects.indexOf(o);
    if (i >= 0) this._objects.splice(i, 1);
    return o;
  };
  FakeCanvas.prototype.sendObjectToBack = function () {};
  FakeCanvas.prototype.toObject = function () { return {}; };
  FakeCanvas.prototype.toJSON = function () { return { objects: [] }; };
  FakeCanvas.prototype.loadFromJSON = function (j, cb) { if (cb) cb(); };
  FakeCanvas.prototype.renderAll = function () {};
  FakeCanvas.prototype.requestRenderAll = function () {};
  FakeCanvas.prototype.setViewportTransform = function (v) { this._vp = v.slice(); };
  FakeCanvas.prototype.getViewportTransform = function () { return this._vp.slice(); };
  // Real Fabric v6 Canvas exposes `.viewportTransform` as a public
  // property (imageEditorCanvas.js reads it directly at lines 107/137/
  // 149/224) — expose the same shape here so the mock matches reality.
  Object.defineProperty(FakeCanvas.prototype, 'viewportTransform', {
    get() { return this._vp; },
  });
  FakeCanvas.prototype.zoomToPoint = function () {};
  FakeCanvas.prototype.dispose = function () {};
  FakeCanvas.prototype.on = function (ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); };
  FakeCanvas.prototype.off = function () {};
  FakeCanvas.prototype.fire = function (ev, data) { (this._listeners[ev] || []).forEach((fn) => fn(data || {})); };
  FakeCanvas.prototype.getObjects = function () { return this._objects; };
  FakeCanvas.prototype.setActiveObject = function () {};
  FakeCanvas.prototype.getActiveObject = function () { return null; };
  // gewv2: record every call (with the VPT active at call time + which
  // objects were visible) so tests can assert the identity-VPT-during-
  // snapshot and helper-hiding contracts without needing real pixels.
  FakeCanvas.prototype.toCanvasElement = function (multiplier, opts) {
    const visibleObjects = this._objects.filter((o) => o && o.visible !== false);
    const call = {
      multiplier, opts, vpAtCallTime: this._vp.slice(),
      visibleObjectCount: visibleObjects.length,
      totalObjectCount: this._objects.length,
    };
    this.toCanvasElementCalls.push(call);
    return { width: (opts && opts.width) || this.width, height: (opts && opts.height) || this.height, getContext: () => ({}), __snapshotOf: call };
  };
  FakeCanvas.prototype.toDataURL = function () { return 'data:image/png;base64,AAAA'; };
  FakeCanvas.prototype.getContext = function () { return {}; };

  // R4.1: StaticCanvas support (the temp canvas). Adversarial-design: the
  // default VPT is NON-IDENTITY ([2,0,0,2,50,50] = "zoom 2x + pan 50px")
  // so the test that asserts "temp VPT is identity" is a REAL structural
  // defense — if the production code forgot to call
  // `temp.setViewportTransform([1,0,0,1,0,0])`, the test would fail.
  function FakeStaticCanvas(hostEl, opts) {
    opts = opts || {};
    this._objects = [];
    this._vp = [2, 0, 0, 2, 50, 50];
    this.width = opts.width || 0;
    this.height = opts.height || 0;
    this.backgroundColor = opts.backgroundColor || '';
    this._listeners = {};
  }
  FakeStaticCanvas.prototype.add = FakeCanvas.prototype.add;
  FakeStaticCanvas.prototype.setViewportTransform = FakeCanvas.prototype.setViewportTransform;
  FakeStaticCanvas.prototype.getViewportTransform = FakeCanvas.prototype.getViewportTransform;
  FakeStaticCanvas.prototype.renderAll = function () { this._rendered = true; };
  FakeStaticCanvas.prototype.getObjects = function () { return this._objects; };
  FakeStaticCanvas.prototype.dispose = function () {};
  FakeStaticCanvas.prototype.on = FakeCanvas.prototype.on;
  FakeStaticCanvas.prototype.off = FakeCanvas.prototype.off;
  FakeStaticCanvas.prototype.fire = FakeCanvas.prototype.fire;
  FakeStaticCanvas.prototype.toCanvasElement = function () {
    return { width: this.width, height: this.height, getContext: () => ({}) };
  };
  FakeStaticCanvas.prototype.toDataURL = function () { return 'data:image/png;base64,AAAA'; };

  // gewv2 NF-02 fix: fabric.Image must be usable as a real constructor
  // (`new fabric.Image(el)`), matching real Fabric v6. `fromURL` is kept
  // for other consumers (asset placement, etc.) that still use it.
  function FakeImage(el) { this._el = el; this.type = 'image'; }
  FakeImage.fromURL = function () { return Promise.resolve(new FakeImage()); };
  FakeImage.prototype.set = function () {};

  sandbox.window.fabric = {
    Canvas: FakeCanvas,
    StaticCanvas: FakeStaticCanvas,  // R4.1
    Image: FakeImage,
    PencilBrush: function () { this.color = ''; this.width = 1; },
    SprayBrush: function () { this.color = ''; this.width = 1; },
  };
}

function makeSandbox() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.document = {
    createElement: (tag) => makeEl(tag),
    body: makeEl('body'),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  sandbox.global = sandbox;
  sandbox.el = makeEl('div');
  return sandbox;
}

function loadCanvas(sandbox) {
  vm.createContext(sandbox);
  const code = require('fs').readFileSync(CANVAS_JS, 'utf8');
  vm.runInContext(code, sandbox, { filename: CANVAS_JS });
  return sandbox.window.ImageEditorCanvas;
}

// ============================================================================
// Tests
// ============================================================================

test('R4.1 PE-001.A: renderSceneAtNaturalSize is exposed on the session', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  assert.equal(typeof sess.renderSceneAtNaturalSize, 'function',
    'PE-001.A: session must expose renderSceneAtNaturalSize as a function');
});

test('R4.1 PE-001.B: renderSceneAtNaturalSize returns a temp canvas with natural dimensions and identity VPT', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  const temp = sess.renderSceneAtNaturalSize();
  assert.equal(typeof temp, 'object', 'PE-001.B: must return an object (the temp StaticCanvas)');
  assert.equal(temp.width, 100, 'PE-001.B: temp canvas width must be imgW (100)');
  assert.equal(temp.height, 60, 'PE-001.B: temp canvas height must be imgH (60)');
  const vpt = temp.getViewportTransform();
  assert.deepEqual(vpt, [1, 0, 0, 1, 0, 0],
    'PE-001.B: temp canvas VPT must be identity [1,0,0,1,0,0] — production must explicitly set it (the fake defaults to a non-identity VPT to make this a real assertion)');
});

test('R4.1 PE-001.C: renderSceneAtNaturalSize does NOT leave the live canvas VPT modified (the bug fix)', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  const liveVpt = [2, 0, 0, 2, 100, 50];
  sess.canvas.setViewportTransform(liveVpt);
  assert.deepEqual(sess.canvas.getViewportTransform(), liveVpt, 'PE-001.C pre: live VPT must match what we set');
  const temp = sess.renderSceneAtNaturalSize();
  // THE KEY ASSERTION: after the call, the live canvas's VPT is back to
  // what the user had (the implementation sets it to identity ONLY for
  // the duration of the snapshot, then restores it — no visible flicker).
  assert.deepEqual(sess.canvas.getViewportTransform(), liveVpt,
    'PE-001.C: live canvas VPT must be RESTORED after renderSceneAtNaturalSize (temporarily identity during the snapshot only)');
  assert.deepEqual(temp.getViewportTransform(), [1, 0, 0, 1, 0, 0],
    'PE-001.C: temp canvas VPT must be identity regardless of the live canvas VPT');
});

test('R4.1 PE-001.D: renderSceneAtNaturalSize does NOT modify the live canvas dimensions (no flicker)', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  const liveW = sess.canvas.getWidth();
  const liveH = sess.canvas.getHeight();
  assert.equal(liveW, 100, 'PE-001.D pre: live canvas width must be 100');
  assert.equal(liveH, 60, 'PE-001.D pre: live canvas height must be 60');
  sess.renderSceneAtNaturalSize();
  assert.equal(sess.canvas.getWidth(), 100, 'PE-001.D: live canvas width must be UNCHANGED');
  assert.equal(sess.canvas.getHeight(), 60, 'PE-001.D: live canvas height must be UNCHANGED');
});

test('R4.1 PE-001.E (gewv2 rewrite): the temp canvas wraps ONE snapshot image — live objects are NEVER individually re-parented', () => {
  // gewv2 NF-02: the old mechanism copied each live object into the temp
  // canvas via temp.add(o) — which in real Fabric REMOVES the object from
  // the live canvas. The fix takes a single flattened pixel snapshot
  // instead, so the temp canvas always holds exactly 1 object (a
  // fabric.Image), regardless of how many objects are on the live canvas.
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  const objA = { type: 'path', left: 10, top: 10, _isHelper: false };
  const objB = { type: 'path', left: 20, top: 20, _isHelper: false };
  const objC = { type: 'rect', left: 30, top: 30, _isHelper: false };
  sess.canvas.add(objA); sess.canvas.add(objB); sess.canvas.add(objC);
  const temp = sess.renderSceneAtNaturalSize();
  const tempObjects = temp.getObjects();
  assert.equal(tempObjects.length, 1, 'PE-001.E: temp canvas must hold exactly one flattened snapshot image, not per-object copies');
  assert.equal(tempObjects[0] instanceof sb.window.fabric.Image, true, 'PE-001.E: the temp object must be a fabric.Image wrapping the snapshot');
  // THE regression check: none of the original live objects were removed.
  assert.deepEqual(sess.canvas.getObjects(), [objA, objB, objC],
    'PE-001.E (NF-02 regression): the live canvas objects must be UNCHANGED after the call — this is exactly the bug the fix closes');
});

// ---------------------------------------------------------------------------
// R4.1.AuditFix additional coverage, updated for the gewv2 NF-02 mechanism.
// ---------------------------------------------------------------------------

test('R4.1 PE-001.F: production flow — temp.toCanvasElement(1) returns natural-dimensions canvas (the PE-001 bug repro)', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  sess.canvas.add({ type: 'path', left: 10, top: 10, width: 20, height: 20 });
  sess.canvas.setViewportTransform([0.5, 0, 0, 0.5, 50, 50]);
  const temp = sess.renderSceneAtNaturalSize();
  const out = temp.toCanvasElement(1);
  assert.equal(out.width, 100, 'PE-001.F: output width must be natural (100), NOT the zoomed size');
  assert.equal(out.height, 60, 'PE-001.F: output height must be natural (60)');
});

test('R4.1 PE-001.G: multiple calls produce INDEPENDENT temp canvases, and the SECOND call still sees ALL live objects (NF-02 regression)', () => {
  // gewv2 NF-02: this is the direct regression test for the bug. Under
  // the old mechanism, the SECOND call would see 0 live objects (the
  // first call had stripped them via temp.add(o)). Under the fix, the
  // live canvas is a pixel SOURCE, never mutated — so a second call still
  // sees every object that was ever added.
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  sess.canvas.add({ type: 'path', left: 10, top: 10 });
  const t1 = sess.renderSceneAtNaturalSize();
  assert.equal(sess.canvas.getObjects().length, 1, 'PE-001.G: live canvas must still have its 1 object after the FIRST call');
  sess.canvas.add({ type: 'rect', left: 20, top: 20 });
  const t2 = sess.renderSceneAtNaturalSize();
  assert.notEqual(t1, t2, 'PE-001.G: t1 and t2 must be different instances');
  assert.equal(sess.canvas.getObjects().length, 2,
    'PE-001.G (NF-02 regression): live canvas must have BOTH objects after the SECOND call — the old bug would have left 0');
  // Each temp snapshot call recorded how many live objects were visible
  // at snapshot time (the fake's toCanvasElementCalls tracker).
  const calls = sess.canvas.toCanvasElementCalls;
  assert.equal(calls.length, 2, 'PE-001.G: toCanvasElement must be called once per renderSceneAtNaturalSize call');
  assert.equal(calls[0].visibleObjectCount, 1, 'PE-001.G: first snapshot saw 1 live object');
  assert.equal(calls[1].visibleObjectCount, 2, 'PE-001.G: second snapshot saw 2 live objects (NOT 0 — the NF-02 bug)');
});

test('R4.1 PE-001.H: empty live canvas (0 objects) — temp still holds one (empty) snapshot image', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  const temp = sess.renderSceneAtNaturalSize();
  assert.equal(temp.getObjects().length, 1, 'PE-001.H: empty live canvas still produces one flattened snapshot image (possibly blank)');
  assert.equal(temp.width, 100, 'PE-001.H: temp width must be 100');
  assert.equal(temp.height, 60, 'PE-001.H: temp height must be 60');
  assert.deepEqual(temp.getViewportTransform(), [1, 0, 0, 1, 0, 0], 'PE-001.H: temp VPT is identity');
});

test('R4.1 PE-001.I: 100 live objects survive across the snapshot (no accidental re-parenting at scale)', () => {
  // gewv2 rewrite: under the old per-object-copy mechanism this test
  // asserted "all 100 objects were copied into the temp" (i.e. re-parented
  // — the bug). Under the fix, the temp always holds ONE flattened image;
  // the meaningful assertion now is that all 100 live objects survive on
  // the LIVE canvas (no off-by-one in the helper-visibility toggle loop
  // that would leave some objects permanently hidden).
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 200, 200);
  for (let i = 0; i < 100; i++) sess.canvas.add({ type: 'path', left: i, top: i, _isHelper: i % 2 === 0 });
  sess.renderSceneAtNaturalSize();
  const objs = sess.canvas.getObjects();
  assert.equal(objs.length, 100, 'PE-001.I: all 100 objects must still be on the live canvas');
  assert.equal(objs.every((o) => o.visible !== false), true,
    'PE-001.I: every helper object\'s visible flag must be restored to true (no off-by-one leaving one permanently hidden)');
});

test('R4.1 PE-001.J (gewv2 rewrite): the temp object is NEVER the same reference as a live object — mutating it cannot corrupt the live canvas', () => {
  // This directly inverts the OLD test's documented "limitation" (shared
  // references were the bug). The fix guarantees the temp canvas's single
  // object is a fresh fabric.Image wrapping a pixel snapshot — never a
  // live object reference.
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  const originalObj = { type: 'path', left: 10, top: 10 };
  sess.canvas.add(originalObj);
  const temp = sess.renderSceneAtNaturalSize();
  assert.notEqual(temp.getObjects()[0], originalObj,
    'PE-001.J (fix): temp must NOT share the live object\'s reference — it is a separately-constructed snapshot image');
  assert.equal(sess.canvas.getObjects()[0], originalObj,
    'PE-001.J: the live canvas must still hold the ORIGINAL object instance');
});

test('R4.1 PE-001.K: temp canvas exposes dispose() — no memory leak', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  const temp = sess.renderSceneAtNaturalSize();
  assert.equal(typeof temp.dispose, 'function', 'PE-001.K: temp must expose dispose()');
  assert.doesNotThrow(() => temp.dispose(), 'PE-001.K: dispose() must not throw');
});

test('R4.1 PE-001.L (gewv2 rewrite): helper objects are hidden for the snapshot, then RESTORED to visible — interleaved case', () => {
  // gewv2 NF-02: helper exclusion is now done via a temporary
  // visible=false toggle (never canvas.add/remove), verified via the
  // fake's toCanvasElementCalls.visibleObjectCount (helpers excluded at
  // snapshot time) and a post-call check that every helper's `visible`
  // flag was restored.
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  const objs = [];
  for (let i = 0; i < 10; i++) {
    const o = { type: i % 2 === 0 ? 'helper' : 'stroke', left: i, top: i, _isHelper: i % 2 === 0 };
    objs.push(o);
    sess.canvas.add(o);
  }
  sess.renderSceneAtNaturalSize();
  const call = sess.canvas.toCanvasElementCalls[0];
  assert.equal(call.visibleObjectCount, 5, 'PE-001.L: exactly 5 non-helper objects must be visible at snapshot time (helpers hidden)');
  assert.equal(call.totalObjectCount, 10, 'PE-001.L: all 10 objects remain on the live canvas (none removed)');
  for (const o of objs) {
    assert.notEqual(o.visible, false, 'PE-001.L: every object\'s visible flag must be restored (not left false) after the call');
  }
});

test('R4.1 PE-001.M: backgroundColor fallback — empty/null live bg must default to transparent', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  for (const bg of ['', null, undefined]) {
    sess.canvas.backgroundColor = bg;
    const temp = sess.renderSceneAtNaturalSize();
    assert.equal(temp.backgroundColor, 'rgba(0,0,0,0)',
      'PE-001.M: temp bg must be transparent fallback when live bg is ' + JSON.stringify(bg));
  }
  sess.canvas.backgroundColor = '#ff0000';
  const tempRed = sess.renderSceneAtNaturalSize();
  assert.equal(tempRed.backgroundColor, '#ff0000', 'PE-001.M: temp bg must match the live bg when set');
});

test('R4.1 PE-001.N: temp.renderAll() is called (the rendering step)', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  const mod = loadCanvas(sb);
  const sess = mod.createEditorSession(makeEl('canvas'), 100, 60);
  sess.canvas.add({ type: 'path', left: 10, top: 10 });
  const temp = sess.renderSceneAtNaturalSize();
  assert.equal(typeof temp.renderAll, 'function', 'PE-001.N: temp must expose renderAll');
  assert.equal(temp._rendered, true, 'PE-001.N: temp.renderAll() must actually have been called before returning');
});
