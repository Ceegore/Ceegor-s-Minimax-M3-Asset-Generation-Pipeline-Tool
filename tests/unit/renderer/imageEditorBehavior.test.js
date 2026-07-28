// tests/unit/renderer/imageEditorBehavior.test.js
//
// Behavioral + unit tests for the in-app pixel/image editor overlay
// (Feature 5). Loads the editor modules into a vm sandbox with mocked
// globals and verifies:
//   - the entry point showImageEditOverlay is exposed
//   - ImageEditorActions format/path/alpha helpers
//   - ImageEditorTools color + undo/redo stack logic
//
// We mock Fabric's Canvas surface minimally so the canvas/tools modules
// initialize without a real WebGL/2D context.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OVER = path.join(ROOT, 'renderer', 'overlays');

// ---- minimal DOM / global mock ----
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], style: {}, dataset: {}, classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined) on = !this._set.has(c); if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener() {}, removeEventListener() {},
    setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    textContent: '', value: '', checked: false,
  };
  return el;
}

function makeSandbox() {
  const sandbox = {};
  const document = {
    createElement: (t) => makeEl(t),
    activeElement: makeEl('body'),
    addEventListener() {}, removeEventListener() {},
    contains() { return true; },
  };
  const window = {
    ImageUtils: {
      mimeFromPath: (p) => {
        const ext = (p.split('.').pop() || '').toLowerCase();
        if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
        if (ext === 'webp') return 'image/webp';
        return 'image/png';
      },
    },
    TinyUtils: {
      extFromMime: (m) => (m === 'image/jpeg' ? 'jpg' : (m === 'image/webp' ? 'webp' : 'png')),
    },
    PureFuncs: {
      // mimic derivedOutputPath: swap extension, no suffix substitution here
      derivedOutputPath: (src, suffix) => {
        const dot = src.lastIndexOf('.');
        const base = dot >= 0 ? src.slice(0, dot) : src;
        return base + suffix + '.png';
      },
    },
  };
  sandbox.window = window;
  sandbox.document = document;
  sandbox.globalThis = sandbox;
  sandbox.window.globalThis = sandbox;
  sandbox.console = console;
  sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
  Object.defineProperty(sandbox, 'self', { value: sandbox, configurable: true });
  vm.createContext(sandbox);
  return sandbox;
}

function loadIn(sandbox, relPath) {
  const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  vm.runInContext(code, sandbox, { filename: relPath });
}

// ---- a tiny fake Fabric so canvas/tools modules initialize ----
function installFakeFabric(sandbox) {
  function FakeCanvas(hostEl, opts) {
    this._objects = []; this._vp = [1, 0, 0, 1, 0, 0];
    this.width = 0; this.height = 0; this.isDrawingMode = false;
    this.freeDrawingBrush = null; this.backgroundColor = ''; this.selection = true;
    this.defaultCursor = 'default'; this._listeners = {};
  }
  FakeCanvas.prototype.setWidth = function (w) { this.width = w; };
  FakeCanvas.prototype.setHeight = function (h) { this.height = h; };
  FakeCanvas.prototype.add = function (o) { this._objects.push(o); return o; };
  FakeCanvas.prototype.sendObjectToBack = function () {};
  FakeCanvas.prototype.toObject = function () { return {}; };
  FakeCanvas.prototype.toJSON = function () { return { objects: [] }; };
  FakeCanvas.prototype.loadFromJSON = function (j, cb) { if (cb) cb(); };
  FakeCanvas.prototype.renderAll = function () {};
  FakeCanvas.prototype.requestRenderAll = function () {};
  FakeCanvas.prototype.setViewportTransform = function (v) { this._vp = v.slice(); };
  FakeCanvas.prototype.zoomToPoint = function () {};
  FakeCanvas.prototype.dispose = function () {};
  FakeCanvas.prototype.on = function (ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); };
  FakeCanvas.prototype.off = function () {};
  FakeCanvas.prototype.fire = function (ev, data) { (this._listeners[ev] || []).forEach((fn) => fn(data || {})); };
  FakeCanvas.prototype.getObjects = function () { return this._objects; };
  FakeCanvas.prototype.setActiveObject = function () {};
  FakeCanvas.prototype.getActiveObject = function () { return null; };
  FakeCanvas.prototype.toCanvasElement = function () {
    const c = { width: 8, height: 8, getContext: () => ({ getImageData: () => ({ data: [0, 0, 0, 255] }) }) };
    return c;
  };
  FakeCanvas.prototype.getZoom = function () { return (this._vp && this._vp[0]) || 1; };
  FakeCanvas.prototype.toDataURL = function () { return 'data:image/png;base64,AAAA'; };
  FakeCanvas.prototype.getContext = function () { return { getImageData: () => ({ data: [0, 0, 0, 255] }) }; };
  function FakeImage() {}
  FakeImage.fromURL = function () { return Promise.resolve(new FakeImage()); };
  FakeImage.prototype.set = function () {};
  sandbox.window.fabric = { Canvas: FakeCanvas, Image: FakeImage, PencilBrush: function () { this.color = ''; this.width = 1; }, SprayBrush: function () { this.color = ''; this.width = 1; } };
}

// ============================================================
// TESTS
// ============================================================

test('showImageEditOverlay is exposed on window.ImageOverlays + bare global', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  // stub the modules' dependencies
  sb.window.el = (t) => makeEl(t);
  sb.window.createElement = (t) => makeEl(t);
  sb.window.$ = () => makeEl('div');
  sb.window.toast = () => {};
  sb.window.showModal = (build) => { const m = makeEl('div'); const close = () => {}; build(m, close); return close; };
  sb.window.loadImageFromFile = () => Promise.reject(new Error('no image in test'));
  sb.window.FileUrl = { fileUrl: (p) => 'file:///' + p };
  sb.window.api = { pickFile: () => Promise.resolve({ ok: false }), fbWrite: () => Promise.resolve({ ok: true }), externalToolsRun: () => Promise.resolve({ ok: true }) };
  sb.window.refreshBrowser = () => {};
  sb.window.previewImageFromFile = () => {};
  // el helper: emulate createElement with attrs+children like DomHelpers
  sb.window.el = function (tag, attrs, children) {
    const node = makeEl(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k.startsWith('on')) { /* skip */ }
      else node[k] = attrs[k];
    }
    if (children) [].concat(children).forEach((c) => { if (c == null) return; if (typeof c === 'string') node.textContent += c; else if (c.tagName) node.appendChild(c); });
    return node;
  };
  loadIn(sb, 'renderer/overlays/imageEditorCanvas.js');
  loadIn(sb, 'renderer/overlays/imageEditorTools.js');
  loadIn(sb, 'renderer/overlays/imageEditorActions.js');
  loadIn(sb, 'renderer/overlays/imageEditorSource.js');
  loadIn(sb, 'renderer/overlays/imageEditorSettings.js');
  loadIn(sb, 'renderer/overlays/imageEditorHeal.js');
  loadIn(sb, 'renderer/overlays/imageEditorKeyboard.js');
  loadIn(sb, 'renderer/overlays/imageEditorOverlay.js');
  assert.strictEqual(typeof sb.window.showImageEditOverlay, 'function');
  assert.strictEqual(typeof sb.window.ImageOverlays.showImageEditOverlay, 'function');
});

test('ImageEditorActions.derivedEditedPath honours output format', () => {
  const sb = makeSandbox();
  sb.window.el = function () { return makeEl('div'); };
  loadIn(sb, 'renderer/overlays/imageEditorActions.js');
  const A = sb.window.ImageEditorActions;
  // base PureFuncs returns C:/x/y_edited.png; format png → keep png
  assert.strictEqual(A.derivedEditedPath('C:/x/y.png', 'png'), 'C:/x/y_edited.png');
  assert.strictEqual(A.derivedEditedPath('C:/x/y.png', 'jpeg'), 'C:/x/y_edited.jpg');
  assert.strictEqual(A.derivedEditedPath('C:/x/y.png', 'webp'), 'C:/x/y_edited.webp');
});

test('ImageEditorActions.mimeForFmt round-trips via existing helpers', () => {
  const sb = makeSandbox();
  sb.window.el = function () { return makeEl('div'); };
  loadIn(sb, 'renderer/overlays/imageEditorActions.js');
  const A = sb.window.ImageEditorActions;
  assert.strictEqual(A.mimeForFmt('png'), 'image/png');
  assert.strictEqual(A.mimeForFmt('jpeg'), 'image/jpeg');
  assert.strictEqual(A.mimeForFmt('webp'), 'image/webp');
});

test('H7-017: onExternal reads config.external_tools (not the state root) and launches the tool', () => {
  const sb = makeSandbox();
  let runPayload = null;
  sb.window.el = function () { return makeEl('div'); };
  // toast is referenced as a bare global inside imageEditorActions.js.
  sb.toast = () => {};
  sb.window.api = {
    externalToolsRun: (payload) => { runPayload = payload; return Promise.resolve({ ok: true, pid: 123 }); },
  };
  // Configure an external tool under the CANONICAL path.
  sb.window.state = { config: { external_tools: [{ name: 'GIMP', exe: 'C:\\gimp.exe', args: '' }] } };
  loadIn(sb, 'renderer/overlays/imageEditorActions.js');
  const A = sb.window.ImageEditorActions;
  const ctrl = { queue: [{ path: 'C:\\img.png' }], activeIndex: 0 };
  A.onExternal(ctrl);
  assert.ok(runPayload, 'externalToolsRun must have been invoked with the configured tool');
  assert.equal(runPayload.name, 'GIMP');
  assert.deepEqual(runPayload.paths, ['C:\\img.png']);
});

test('H7-017: onExternal shows a warning when config.external_tools is empty', () => {
  const sb = makeSandbox();
  let warned = null;
  sb.window.el = function () { return makeEl('div'); };
  sb.toast = (_msg, kind) => { warned = kind; };
  sb.window.api = { externalToolsRun: () => Promise.resolve({ ok: true }) };
  // Empty tools under the canonical path.
  sb.window.state = { config: { external_tools: [] } };
  loadIn(sb, 'renderer/overlays/imageEditorActions.js');
  const A = sb.window.ImageEditorActions;
  A.onExternal({ queue: [{ path: 'C:\\img.png' }], activeIndex: 0 });
  assert.equal(warned, 'warn');
});

test('ImageEditorTools hexToRgb parses #rrggbb', () => {
  const sb = makeSandbox();
  loadIn(sb, 'renderer/overlays/imageEditorTools.js');
  const T = sb.window.ImageEditorTools;
  const o = T.hexToRgb('#ff8800');
  assert.strictEqual(o.r, 255); assert.strictEqual(o.g, 136); assert.strictEqual(o.b, 0);
  const k = T.hexToRgb('#000000');
  assert.strictEqual(k.r, 0); assert.strictEqual(k.g, 0); assert.strictEqual(k.b, 0);
  assert.strictEqual(T.hexToRgb('garbage'), null);
});

test('ImageEditorTools.hexWithAlpha produces rgba()', () => {
  const sb = makeSandbox();
  loadIn(sb, 'renderer/overlays/imageEditorTools.js');
  const T = sb.window.ImageEditorTools;
  assert.strictEqual(T.hexWithAlpha('#ff8800', 0.5), 'rgba(255,136,0,0.5)');
});

test('ImageEditorTools undo/redo stack pushes + restores', async () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  sb.window.el = function () { return makeEl('div'); };
  loadIn(sb, 'renderer/overlays/imageEditorCanvas.js');
  loadIn(sb, 'renderer/overlays/imageEditorTools.js');
  const T = sb.window.ImageEditorTools;
  // create a session via the canvas module
  const host = makeEl('canvas');
  const handle = sb.window.ImageEditorCanvas.createEditorSession(host, 8, 8);
  const session = handle.session;
  assert.strictEqual(T.canUndo(session), false);
  T.pushUndo(session);
  assert.strictEqual(T.canUndo(session), true);
  await T.undo(session);
  assert.strictEqual(T.canRedo(session), true);
  await T.redo(session);
  assert.strictEqual(T.canUndo(session), true);
});

// ---- H8-007: scenePointOf coordinate helper ----
test('H8-007 scenePointOf prefers opt.scenePoint (Fabric v6 event data)', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  sb.window.el = function () { return makeEl('div'); };
  loadIn(sb, 'renderer/overlays/imageEditorCanvas.js');
  loadIn(sb, 'renderer/overlays/imageEditorTools.js');
  const T = sb.window.ImageEditorTools;
  const fakeCanvas = {}; // scenePointOf does not require a real canvas when opt.scenePoint exists
  const p = T.scenePointOf(fakeCanvas, { scenePoint: { x: 123.4, y: 567.8 } }, 1000, 1000);
  assert.equal(p.x, 123.4);
  assert.equal(p.y, 567.8);
});

test('H8-007 scenePointOf falls back to canvas.getScenePoint(e) when no scenePoint', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  sb.window.el = function () { return makeEl('div'); };
  loadIn(sb, 'renderer/overlays/imageEditorCanvas.js');
  loadIn(sb, 'renderer/overlays/imageEditorTools.js');
  const T = sb.window.ImageEditorTools;
  let calledWith = null;
  const fakeCanvas = {
    getScenePoint(e) { calledWith = e; return { x: 50, y: 60 }; },
  };
  const p = T.scenePointOf(fakeCanvas, { e: 'evt-1' }, 1000, 1000);
  assert.equal(calledWith, 'evt-1');
  assert.equal(p.x, 50);
  assert.equal(p.y, 60);
});

test('H8-007 scenePointOf clamps to the image rectangle', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  sb.window.el = function () { return makeEl('div'); };
  loadIn(sb, 'renderer/overlays/imageEditorCanvas.js');
  loadIn(sb, 'renderer/overlays/imageEditorTools.js');
  const T = sb.window.ImageEditorTools;
  // negative coords clamp to 0; oversized clamp to imgW/imgH
  const p1 = T.scenePointOf({}, { scenePoint: { x: -50, y: -10 } }, 100, 80);
  assert.equal(p1.x, 0); assert.equal(p1.y, 0);
  const p2 = T.scenePointOf({}, { scenePoint: { x: 9999, y: 9999 } }, 100, 80);
  assert.equal(p2.x, 100); assert.equal(p2.y, 80);
});

test('H8-007 scenePointOf never returns a viewport point as scene point when scenePoint is present', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  sb.window.el = function () { return makeEl('div'); };
  loadIn(sb, 'renderer/overlays/imageEditorCanvas.js');
  loadIn(sb, 'renderer/overlays/imageEditorTools.js');
  const T = sb.window.ImageEditorTools;
  // The bug: opt.pointer is viewport-space. With a scenePoint present the helper
  // MUST prefer it, not opt.pointer. (200 here is a screen-space value that would
  // be wrong as a scene coord at zoom 0.5.)
  const p = T.scenePointOf({}, { scenePoint: { x: 40, y: 40 }, pointer: { x: 200, y: 200 } }, 1000, 1000);
  assert.equal(p.x, 40); assert.equal(p.y, 40);
});

// ---- H8-005: select tool branch exists in setTool ----
test('H8-005 setTool has a select branch (crosshair, no selection)', () => {
  const src = fs.readFileSync(path.join(OVER, 'imageEditorTools.js'), 'utf8');
  assert.match(src, /tool === 'select'/);
  // The select branch must disable object selection + use a crosshair cursor.
  assert.match(src, /tool === 'select'[\s\S]*?selection = false[\s\S]*?crosshair/);
});

// ---- H8-005: selection/preview rects are excludeFromExport ----
test('H8-005 heal-drag rect is excludeFromExport:true (never baked/exported)', () => {
  const src = fs.readFileSync(path.join(OVER, 'imageEditorSelect.js'), 'utf8');
  assert.match(src, /excludeFromExport:\s*true/);
});

// ---- H8-006: slider blocks have a numeric input + full-width row ----
test('H8-006 tool rail exposes numeric inputs synced with the sliders', () => {
  const src = fs.readFileSync(path.join(OVER, 'imageEditorOverlay.js'), 'utf8');
  assert.match(src, /ui\.sizeNum\s*=\s*el\(['"]input['"]/);
  assert.match(src, /ui\.opacityNum\s*=\s*el\(['"]input['"]/);
  // applySize clamps to the slider range.
  assert.match(src, /applySize\s*=\s*\(val\)[\s\S]*?Math\.max\(1,\s*Math\.min\(200/);
});
test('H8-006 CSS widens the rail to 120px and styles the slider block', () => {
  const css = fs.readFileSync(path.join(OVER, 'imageEditor.css'), 'utf8');
  assert.match(css, /\.ie-tools\s*\{[\s\S]*?width:\s*120px/);
  assert.match(css, /\.ie-slider-block/);
  assert.match(css, /\.ie-slider-num\b/);
});

// ---- H8-002: bar-tool endpoint math ----
test('H8-002 endpointsOf returns the two endpoints of a bar (center + length + angle)', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  sb.window.el = function () { return makeEl('div'); };
  loadIn(sb, 'renderer/overlays/imageEditorShapes.js');
  const S = sb.window.ImageEditorShapes;
  // horizontal bar, length 10, centered at (0,0) → (-5,0) and (5,0).
  let [a, b] = S.endpointsOf(0, 0, 10, 0);
  assert.ok(Math.abs(a.x - (-5)) < 1e-9 && Math.abs(a.y - 0) < 1e-9);
  assert.ok(Math.abs(b.x - 5) < 1e-9 && Math.abs(b.y - 0) < 1e-9);
  // vertical bar (angle = PI/2) → (0,-5) and (0,5).
  [a, b] = S.endpointsOf(0, 0, 10, Math.PI / 2);
  assert.ok(Math.abs(a.y - (-5)) < 1e-9);
  assert.ok(Math.abs(b.y - 5) < 1e-9);
});

test('H8-002 barFromEndpoints is the inverse of endpointsOf', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  sb.window.el = function () { return makeEl('div'); };
  loadIn(sb, 'renderer/overlays/imageEditorShapes.js');
  const S = sb.window.ImageEditorShapes;
  const cx = 12, cy = -7, length = 33, angle = 0.7;
  const [p1, p2] = S.endpointsOf(cx, cy, length, angle);
  const back = S.barFromEndpoints(p1, p2);
  assert.ok(Math.abs(back.centerX - cx) < 1e-6);
  assert.ok(Math.abs(back.centerY - cy) < 1e-6);
  assert.ok(Math.abs(back.length - length) < 1e-6);
  // angle wraps; compare modulo PI (a bar is symmetric under 180°).
  const norm = (x) => ((x % Math.PI) + Math.PI) % Math.PI;
  assert.ok(Math.abs(norm(back.angle) - norm(angle)) < 1e-6);
});

test('H8-002 the bar tool button + L shortcut + setTool branch exist', () => {
  assert.match(fs.readFileSync(path.join(OVER, 'imageEditorOverlay.js'), 'utf8'), /toolBtn\(['"]L['"],\s*['"]─['"],\s*['"]bar['"]\)/);
  assert.match(fs.readFileSync(path.join(OVER, 'imageEditorKeyboard.js'), 'utf8'), /case ['"]l['"]:\s*setActiveTool\(['"]bar['"]\)/);
  assert.match(fs.readFileSync(path.join(OVER, 'imageEditorTools.js'), 'utf8'), /tool === 'bar'/);
});

test('H8-002 cancel(ctrl) takes an activeSlotFn and removes the preview (360° bug fix)', () => {
  const src = fs.readFileSync(path.join(OVER, 'imageEditorShapes.js'), 'utf8');
  // cancel must accept the activeSlotFn arg and use it (not an undefined activeSlot).
  assert.match(src, /function cancel\(ctrl,\s*activeSlotFn\)/);
  assert.match(src, /const slot = activeSlotFn \? activeSlotFn\(\) : \(ctrl\.queue/);
  // The overlay's setActiveTool passes activeSlotFn(ctrl) when cancelling.
  const ov = fs.readFileSync(path.join(OVER, 'imageEditorOverlay.js'), 'utf8');
  assert.match(ov, /ImageEditorShapes\.cancel\(ctrl,\s*activeSlotFn\(ctrl\)\)/);
});
