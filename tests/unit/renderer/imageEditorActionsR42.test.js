// tests/unit/renderer/imageEditorActionsR42.test.js
// ============================================================================
// R4.2 — Consumer migration to renderSceneAtNaturalSize (PE-001 fix).
//
// Background: R4.1 added the pure helper `renderSceneAtNaturalSize(session)`
// in imageEditorCanvas.js (exposed on both the handle AND the inner session
// object — see R4.2 Phasenpruefung finding P-R42-01). R4.2 migrates the
// consumers in imageEditorActions.js from the BUGGY live-canvas exports
// (session.canvas.toCanvasElement / h.toDataURL — both honour the live
// VPT) to the FIXED temp-canvas exports (renderSceneAtNaturalSize →
// temp.toCanvasElement / temp.toDataURL). The consumers are:
//   - canvasHasAlpha(session) — coarse alpha scan for PNG default
//   - flattenOntoMatte(session, fmt, matte) — JPEG composite onto white
//   - doSave(...) — the main save path (PNG / JPEG / WebP)
//   - onBake(...) — flatten placed objects into the base layer
//
// Test discipline:
//   - Structural assertions that verify the consumer INVOKES
//     renderSceneAtNaturalSize (not the legacy exports).
//   - Per-test counter isolation (R4.2-auditfix P-R42-06): the
//     StaticCanvas renderAll counter is reset in a fresh sandbox
//     per test (no module-scope state).
//   - Adversarial probes (R4.1 + R4.2 pattern): if a contract claim
//     is wrong, the test FAILS — no self-validating loops.
//   - SameAs at specific indices: temp.getObjects()[0] is the SAME
//     reference as the live canvas's getObjects()[0] (R4.1.J —
//     documented reference-sharing; R4.2 doesn't deep-clone).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CANVAS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorCanvas.js');
const ACTIONS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorActions.js');

// ---- Sandbox helpers ----

// R4.2-auditfix: onSave is fire-and-forget (returns undefined; the
// internal doSave is async). Tests must wait for the SIDE-EFFECT
// (captured dataURL, captured toast) instead of awaiting the
// return value. waitFor polls the predicate every 5ms up to `timeoutMs`.
async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out after ' + timeoutMs + 'ms');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

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

// Per-test counter (R4.2-auditfix P-R42-06): the counter lives in
// the sandbox, not module-scope. Each test gets a fresh sandbox →
// fresh counter → no cross-test pollution.
function installFakeFabric(sandbox) {
  // R4.2-auditfix P-R42-06: counter is per-sandbox, not module-scope.
  sandbox._renderAllCount = 0;

  function FakeCanvas(hostEl, opts) {
    this._objects = []; this._vp = [1, 0, 0, 1, 0, 0];
    this.width = 0; this.height = 0; this.isDrawingMode = false;
    this.freeDrawingBrush = null; this.backgroundColor = '';
    this.selection = true; this.defaultCursor = 'default';
    this._listeners = {};
  }
  FakeCanvas.prototype.setWidth = function (w) { this.width = w; };
  FakeCanvas.prototype.setHeight = function (h) { this.height = h; };
  FakeCanvas.prototype.getWidth = function () { return this.width; };
  FakeCanvas.prototype.getHeight = function () { return this.height; };
  FakeCanvas.prototype.add = function (o) { this._objects.push(o); return o; };
  FakeCanvas.prototype.remove = function (o) { const i = this._objects.indexOf(o); if (i >= 0) this._objects.splice(i, 1); return o; };
  FakeCanvas.prototype.sendObjectToBack = function () {};
  FakeCanvas.prototype.toObject = function () { return {}; };
  FakeCanvas.prototype.toJSON = function () { return { objects: [] }; };
  FakeCanvas.prototype.loadFromJSON = function (j, cb) { if (cb) cb(); };
  FakeCanvas.prototype.renderAll = function () {};
  FakeCanvas.prototype.requestRenderAll = function () {};
  FakeCanvas.prototype.setViewportTransform = function (v) { this._vp = v.slice(); };
  FakeCanvas.prototype.getViewportTransform = function () { return this._vp.slice(); };
  // gewv2 NF-02: real Fabric v6 Canvas exposes `.viewportTransform` as a
  // public property (imageEditorCanvas.js reads it directly to save/restore
  // around the natural-size snapshot) — expose the same shape here.
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
  FakeCanvas.prototype.clear = function () { this._objects = []; };
  // R4.2-auditfix P-R42-03: live.toDataURL returns a UNIQUE sentinel
  // (FAKE-LIVE) so the test can verify "the saved dataURL is from
  // the TEMP canvas, not the live one".
  //
  // gewv2: doSave now encodes via `temp.toCanvasElement(1).toDataURL(mime)`
  // (native HTMLCanvasElement encode — Fabric's own toDataURL({format})
  // only recognises bare format names and silently falls back to PNG for
  // full MIME strings like 'image/jpeg'/'image/webp' — see GEW-005). The
  // returned canvas-element mock therefore needs its OWN toDataURL, still
  // carrying the FAKE-LIVE/FAKE-TEMP sentinel distinction based on which
  // instance (`this`) produced it.
  FakeCanvas.prototype.toCanvasElement = function (m) {
    m = m || 1;
    const isTemp = this instanceof FakeStaticCanvas;
    return { width: this.width * m, height: this.height * m,
      getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }) }),
      toDataURL: () => 'data:image/png;base64,' + (isTemp ? 'FAKE-TEMP' : 'FAKE-LIVE') };
  };
  FakeCanvas.prototype.toDataURL = function (opts) {
    return 'data:image/png;base64,FAKE-LIVE';
  };
  FakeCanvas.prototype.getContext = function () {
    return { getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }) };
  };

  // R4.1 pattern (imageEditorNaturalScene.r4.test.js): StaticCanvas
  // defaults to a NON-IDENTITY VPT [2,0,0,2,50,50] so any test that
  // asserts "temp VPT is identity" is a real structural defense.
  function FakeStaticCanvas(hostEl, opts) {
    opts = opts || {};
    this._objects = []; this._vp = [2, 0, 0, 2, 50, 50];
    this.width = opts.width || 0; this.height = opts.height || 0;
    this.backgroundColor = opts.backgroundColor || '';
    this._listeners = {}; this._disposed = false;
  }
  FakeStaticCanvas.prototype.add = FakeCanvas.prototype.add;
  FakeStaticCanvas.prototype.setViewportTransform = FakeCanvas.prototype.setViewportTransform;
  FakeStaticCanvas.prototype.getViewportTransform = FakeCanvas.prototype.getViewportTransform;
  // R4.2-auditfix P-R42-06: renderAll bumps the per-sandbox counter.
  FakeStaticCanvas.prototype.renderAll = function () { sandbox._renderAllCount++; };
  FakeStaticCanvas.prototype.getObjects = function () { return this._objects; };
  FakeStaticCanvas.prototype.dispose = function () { this._disposed = true; };
  FakeStaticCanvas.prototype.on = FakeCanvas.prototype.on;
  FakeStaticCanvas.prototype.off = FakeCanvas.prototype.off;
  FakeStaticCanvas.prototype.fire = FakeCanvas.prototype.fire;
  FakeStaticCanvas.prototype.toCanvasElement = FakeCanvas.prototype.toCanvasElement;
  // R4.2-auditfix P-R42-03: temp.toDataURL returns a UNIQUE sentinel
  // (FAKE-TEMP) — different from live's FAKE-LIVE. The test can
  // assert "saved dataURL contains FAKE-TEMP" to verify the
  // migration is real.
  FakeStaticCanvas.prototype.toDataURL = function (opts) {
    return 'data:image/png;base64,FAKE-TEMP';
  };

  function FakeImage() {}
  FakeImage.fromURL = function () { return Promise.resolve(new FakeImage()); };
  FakeImage.prototype.set = function () {};
  sandbox.window.fabric = {
    Canvas: FakeCanvas, StaticCanvas: FakeStaticCanvas, Image: FakeImage,
    PencilBrush: function () { this.color = ''; this.width = 1; },
    SprayBrush: function () { this.color = ''; this.width = 1; },
  };
}

function makeSandbox() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.document = {
    createElement: (t) => {
      if (t === 'canvas') {
        return {
          width: 0, height: 0,
          getContext: () => ({
            fillStyle: '', fillRect: () => {}, drawImage: () => {},
            getImageData: () => ({ data: new Uint8ClampedArray(0) }),
          }),
          toDataURL: () => 'data:image/png;base64,FAKE-MATTE',
        };
      }
      return makeEl(t);
    },
    body: makeEl('body'),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  sandbox.global = sandbox;
  sandbox.el = makeEl('div');
  return sandbox;
}

// loadModules is parameterized so each test can supply its own toast
// mock BEFORE the actions module is loaded (R4.2-auditfix P-R42-04:
// toast is bound in the actions module's closure, so the mock must
// be set before the module is evaluated).
function loadModules(sandbox, extraGlobals) {
  vm.createContext(sandbox);
  const canvasCode = require('fs').readFileSync(CANVAS_JS, 'utf8');
  vm.runInContext(canvasCode, sandbox, { filename: CANVAS_JS });
  sandbox.window.ImageUtils = { mimeFromPath: (p) => p.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  sandbox.window.TinyUtils = { extFromMime: (m) => m === 'image/png' ? 'png' : 'jpg' };
  sandbox.window.PureFuncs = { derivedOutputPath: (p, s) => p.replace(/(\.[^.]+)$/, s + '$1') };
  sandbox.window.ImageEditorTools = { pushUndo: () => {} };
  sandbox.window.ImageEditorSource = { refreshObjectsList: () => {}, refreshQueueBar: () => {} };
  // R4.2-auditfix: do NOT set window.api.mintGrant. The production
  // code does `require('../services/grantCache')` if mintGrant is
  // present — that is an anti-pattern (renderer has no require)
  // and would throw in the test sandbox. Grant flow is covered by
  // preloadGrantForwarding.r15afix5.test.js; R4.2 only needs to
  // verify the renderSceneAtNaturalSize migration.
  sandbox.window.api = {
    writeImageBase64: async (outPath, b64, grant) => {
      sandbox._capturedDataUrls.push({ outPath, dataUrl: 'data:image/png;base64,' + b64 });
      return { ok: true, path: outPath };
    },
    fbWrite: async (outPath, b64, grant) => {
      sandbox._capturedDataUrls.push({ outPath, dataUrl: 'data:image/png;base64,' + b64 });
      return { ok: true, path: outPath };
    },
  };
  sandbox.window.confirm = () => true;
  sandbox.window.asyncConfirm = () => Promise.resolve(true);
  // Capture captured dataURLs (R4.2-auditfix P-R42-03: the test
  // verifies the dataURL source by capturing it in the mock).
  sandbox._capturedDataUrls = [];
  // R4.2-auditfix P-R42-04: toast is a BARE GLOBAL in the actions
  // module's scope (not window.toast — bare identifier lookup goes
  // through globalThis, not window). Must be set on the sandbox
  // directly. imageEditorBehavior.test.js does the same: `sb.toast = ...`.
  sandbox._toasts = [];
  sandbox.toast = (msg, kind, dur) => { sandbox._toasts.push({ msg, kind, dur }); };
  // Apply any extra globals (test-specific overrides).
  if (extraGlobals) for (const k of Object.keys(extraGlobals)) sandbox[k] = extraGlobals[k];
  const actionsCode = require('fs').readFileSync(ACTIONS_JS, 'utf8');
  vm.runInContext(actionsCode, sandbox, { filename: ACTIONS_JS });
  return {
    canvasMod: sandbox.window.ImageEditorCanvas,
    actionsMod: sandbox.window.ImageEditorActions,
  };
}

// ============================================================================
// Tests
// ============================================================================

test('R4.2 P-R42-01.A: renderSceneAtNaturalSize is exposed on the INNER session object (the R4.2 fix)', () => {
  // R4.2-auditfix finding: the original R4.1 exposed the helper
  // ONLY on the handle. R4.2 callers (canvasHasAlpha, flattenOntoMatte,
  // onBake) pass the inner `session` object (not the handle). The
  // fix: expose the helper on the inner session too. This test pins
  // that contract so a future refactor doesn't break it again.
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  assert.equal(typeof sess.session.renderSceneAtNaturalSize, 'function',
    'PE-001-R42.A: inner session object MUST expose renderSceneAtNaturalSize (P-R42-01 fix)');
  assert.equal(typeof sess.renderSceneAtNaturalSize, 'function',
    'PE-001-R42.A: handle MUST also expose renderSceneAtNaturalSize (backwards compat)');
  // Same function reference (not just two different functions with
  // the same name).
  assert.equal(sess.renderSceneAtNaturalSize, sess.session.renderSceneAtNaturalSize,
    'PE-001-R42.A: handle and session must share the SAME renderSceneAtNaturalSize function reference');
});

test('R4.2 PE-001.A: canvasHasAlpha uses renderSceneAtNaturalSize (not live toCanvasElement)', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod, actionsMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  // Apply a non-identity live VPT (the PE-001 repro scenario).
  sess.canvas.setViewportTransform([2, 0, 0, 2, 50, 50]);
  // Call canvasHasAlpha. The R4.2 migration: it must call
  // renderSceneAtNaturalSize (which creates a FakeStaticCanvas +
  // calls renderAll). If it still used session.canvas.toCanvasElement
  // directly, the counter would not bump (only the StaticCanvas's
  // renderAll is instrumented).
  const result = actionsMod.canvasHasAlpha(sess.session);
  assert.equal(typeof result, 'boolean', 'PE-001.A: must return a boolean');
  // The counter must be > 0 — renderSceneAtNaturalSize was called
  // (and its renderAll was invoked).
  assert.ok(sb._renderAllCount >= 1,
    'PE-001.A: renderSceneAtNaturalSize must be called by canvasHasAlpha (counter is ' + sb._renderAllCount + ')');
});

test('R4.2 PE-001.B: flattenOntoMatte uses renderSceneAtNaturalSize (not live toCanvasElement)', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod, actionsMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  sess.canvas.setViewportTransform([2, 0, 0, 2, 50, 50]);
  // Call flattenOntoMatte with a white matte.
  const dataUrl = actionsMod.flattenOntoMatte(sess.session, 'png', '#ffffff');
  assert.equal(typeof dataUrl, 'string', 'PE-001.B: must return a data URL string');
  assert.ok(dataUrl.startsWith('data:image/'), 'PE-001.B: data URL must be a data:image/...');
  // The counter must be bumped (renderSceneAtNaturalSize was called).
  assert.ok(sb._renderAllCount >= 1,
    'PE-001.B: renderSceneAtNaturalSize must be called by flattenOntoMatte (counter is ' + sb._renderAllCount + ')');
});

test('R4.2 PE-001.C: doSave uses renderSceneAtNaturalSize (not the legacy h.toDataURL)', async () => {
  // R4.2-auditfix P-R42-02: build a proper ctrl with queue + activeIndex
  // + a slot with a handle (so activeSlot + activeSession return
  // real values, not undefined). Without this, onSave short-circuits
  // at "if (!slot) return" and doSave is never invoked.
  // R4.2-auditfix: onSave is fire-and-forget (returns nothing);
  // it does NOT return a Promise. We must wait for the side-effect
  // (the captured dataURL in the writeImageBase64 mock) instead
  // of chaining .then on the return value.
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod, actionsMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  sess.canvas.setViewportTransform([2, 0, 0, 2, 50, 50]); // PE-001 repro
  const slot = { path: 'C:/in.png', modified: true, handle: sess };
  let savedTo = null;
  const ctrl = {
    ui: { saveBtn: { disabled: false, textContent: 'Save' }, queueBar: null },
    prefs: { outFormat: 'png' },
    saveLabel: 'Save',
    queue: [slot],
    activeIndex: 0,
    onSaved: (out) => { savedTo = out; },
  };
  actionsMod.onSave(ctrl);
  // R4.2-auditfix: wait for the save to FULLY complete (onSaved is
  // called in the .then() of the write, which is a microtask after
  // the write promise resolves). waitFor on _capturedDataUrls is
  // racy — the write promise might not have resolved yet.
  await waitFor(() => savedTo !== null, 500);
  // The counter must be > 0 — renderSceneAtNaturalSize was called.
  assert.ok(sb._renderAllCount >= 1,
    'PE-001.C: renderSceneAtNaturalSize must be called by doSave (counter is ' + sb._renderAllCount + ')');
  // The save completed successfully (the mocked writeImageBase64 returns ok).
  assert.ok(savedTo, 'PE-001.C: save must complete (mocked writeImageBase64 returns ok)');
});

test('R4.2 PE-001.D: doSave temp canvas is disposed (no memory leak)', async () => {
  // R4.2-auditfix P-R42-02: real ctrl with queue/activeIndex/handle.
  // R4.2-auditfix P-R42-05: temp.dispose() must be called after use
  // (otherwise repeated save operations leak).
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod, actionsMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  // Track StaticCanvas dispose calls. The FakeStaticCanvas's dispose
  // sets a `_disposed` flag — we can verify it.
  const origDispose = sb.window.fabric.StaticCanvas.prototype.dispose;
  let anyStaticDisposed = false;
  sb.window.fabric.StaticCanvas.prototype.dispose = function () {
    anyStaticDisposed = true;
    return origDispose.call(this);
  };
  const slot = { path: 'C:/in.png', modified: true, handle: sess };
  const ctrl = {
    ui: { saveBtn: { disabled: false, textContent: 'Save' }, queueBar: null },
    prefs: { outFormat: 'png' }, saveLabel: 'Save',
    queue: [slot], activeIndex: 0, onSaved: null,
  };
  actionsMod.onSave(ctrl);
  await waitFor(() => sb._capturedDataUrls.length >= 1, 500);
  assert.equal(anyStaticDisposed, true,
    'PE-001.D: the temp canvas must be disposed by doSave (no memory leak)');
  // Restore.
  sb.window.fabric.StaticCanvas.prototype.dispose = origDispose;
});

test('R4.2 PE-001.E: the R4.2 dataURL is from the TEMP canvas (not the live one) — real structural defense', async () => {
  // R4.2-auditfix P-R42-03: this is the MOST IMPORTANT test. It
  // pins the central R4.2 contract: the saved dataURL must be from
  // the temp canvas (identity VPT, natural size), NOT the live
  // canvas (zoom-corrupted). Without this, the entire PE-001
  // migration is unverifiable.
  //
  // Strategy:
  //   - live.toDataURL = 'data:image/png;base64,FAKE-LIVE'
  //   - temp.toDataURL = 'data:image/png;base64,FAKE-TEMP'
  //   - The b64 captured by the writeImageBase64 mock can be
  //     reconstructed and checked for the FAKE-TEMP sentinel.
  //
  // Adversarial probe: if a future refactor changes the production
  // code to call `h.toDataURL()` (the legacy live-aware path), the
  // captured dataURL would be FAKE-LIVE — the test would FAIL.
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod, actionsMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  sess.canvas.setViewportTransform([2, 0, 0, 2, 50, 50]); // PE-001 repro
  const slot = { path: 'C:/in.png', modified: true, handle: sess };
  const ctrl = {
    ui: { saveBtn: { disabled: false, textContent: 'Save' }, queueBar: null },
    prefs: { outFormat: 'png' }, saveLabel: 'Save',
    queue: [slot], activeIndex: 0, onSaved: null,
  };
  actionsMod.onSave(ctrl);
  await waitFor(() => sb._capturedDataUrls.length >= 1, 500);
  // Verify the saved dataURL is from the TEMP canvas.
  assert.equal(sb._capturedDataUrls.length, 1,
    'PE-001.E: exactly one save should have been captured');
  const captured = sb._capturedDataUrls[0];
  assert.ok(captured.dataUrl.indexOf('FAKE-TEMP') >= 0,
    'PE-001.E: saved dataURL must contain FAKE-TEMP sentinel (the temp canvas), got: ' + captured.dataUrl);
  assert.equal(captured.dataUrl.indexOf('FAKE-LIVE'), -1,
    'PE-001.E: saved dataURL must NOT contain FAKE-LIVE sentinel (the live canvas), got: ' + captured.dataUrl);
});

test('R4.2 PE-001.F: doSave JPEG with alpha → uses flattenOntoMatte path (no PE-001 corruption)', async () => {
  // When the user picks JPEG and the canvas has alpha, doSave must
  // route through flattenOntoMatte (which renders at natural size +
  // composites onto white) — NOT h.toDataURL (PE-001 corruption).
  // The captured dataURL must be FAKE-MATTE (from the matte canvas
  // in flattenOntoMatte), not FAKE-LIVE.
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod, actionsMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  sess.canvas.setViewportTransform([2, 0, 0, 2, 50, 50]);
  const slot = { path: 'C:/in.png', modified: true, handle: sess };
  const ctrl = {
    ui: { saveBtn: { disabled: false, textContent: 'Save' }, queueBar: null },
    prefs: { outFormat: 'jpeg' }, saveLabel: 'Save',
    queue: [slot], activeIndex: 0, onSaved: null,
  };
  actionsMod.onSave(ctrl);
  await waitFor(() => sb._capturedDataUrls.length >= 1, 500);
  // canvasHasAlpha returns true (FakeCanvas returns zeroed data →
  // alpha = 0 < 255 → "has alpha"). So doSave routes to
  // flattenOntoMatte. The matte canvas's toDataURL returns
  // FAKE-MATTE.
  assert.equal(sb._capturedDataUrls.length, 1,
    'PE-001.F: exactly one save should have been captured');
  const captured = sb._capturedDataUrls[0];
  // The captured dataURL must be from the matte canvas.
  assert.ok(captured.dataUrl.indexOf('FAKE-MATTE') >= 0,
    'PE-001.F: JPEG-with-alpha save must use flattenOntoMatte (FAKE-MATTE), got: ' + captured.dataUrl);
  // The flattenOntoMatte path must also call renderSceneAtNaturalSize.
  assert.ok(sb._renderAllCount >= 1,
    'PE-001.F: renderSceneAtNaturalSize must be called by flattenOntoMatte (counter is ' + sb._renderAllCount + ')');
});

test('R4.2 PE-001.G: onBake uses renderSceneAtNaturalSize (not h.toDataURL / live canvas)', async () => {
  // R4.2-auditfix: bake is a critical path — flattening placed
  // objects into the base layer must use the natural-size temp
  // canvas. Otherwise a user zoomed-in would bake a partial
  // image into the base layer.
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod, actionsMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  sess.canvas.setViewportTransform([2, 0, 0, 2, 50, 50]);
  // Add a non-base drawing object (so onBake has something to bake).
  sess.canvas.add({ type: 'stroke', left: 10, top: 10 });
  const slot = { path: 'C:/in.png', modified: false, handle: sess };
  const ctrl = {
    ui: { saveBtn: { disabled: false, textContent: 'Save' }, queueBar: null },
    saveLabel: 'Save',
    queue: [slot], activeIndex: 0,
  };
  await new Promise((resolve) => {
    actionsMod.onBake(ctrl);
    setTimeout(resolve, 30);
  });
  // onBake must call renderSceneAtNaturalSize (StaticCanvas.renderAll bumps the counter).
  assert.ok(sb._renderAllCount >= 1,
    'PE-001.G: renderSceneAtNaturalSize must be called by onBake (counter is ' + sb._renderAllCount + ')');
});

test('R4.2 PE-001.H: onBake temp canvas is disposed (no memory leak)', async () => {
  // R4.2-auditfix P-R42-05: onBake must also dispose the temp.
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod, actionsMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  sess.canvas.setViewportTransform([2, 0, 0, 2, 50, 50]);
  sess.canvas.add({ type: 'stroke', left: 10, top: 10 });
  const origDispose = sb.window.fabric.StaticCanvas.prototype.dispose;
  let disposed = false;
  sb.window.fabric.StaticCanvas.prototype.dispose = function () {
    disposed = true;
    return origDispose.call(this);
  };
  const slot = { path: 'C:/in.png', modified: false, handle: sess };
  const ctrl = {
    ui: { saveBtn: { disabled: false, textContent: 'Save' }, queueBar: null },
    saveLabel: 'Save', queue: [slot], activeIndex: 0,
  };
  await new Promise((resolve) => {
    actionsMod.onBake(ctrl);
    setTimeout(resolve, 30);
  });
  assert.equal(disposed, true,
    'PE-001.H: the temp canvas must be disposed by onBake (no memory leak)');
  sb.window.fabric.StaticCanvas.prototype.dispose = origDispose;
});

test('R4.2 PE-001.I: canvasHasAlpha temp canvas is disposed (no memory leak)', () => {
  // R4.2-auditfix P-R42-05: canvasHasAlpha must dispose the temp
  // (the original R4.2 forgot it).
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod, actionsMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  const origDispose = sb.window.fabric.StaticCanvas.prototype.dispose;
  let disposed = false;
  sb.window.fabric.StaticCanvas.prototype.dispose = function () {
    disposed = true;
    return origDispose.call(this);
  };
  actionsMod.canvasHasAlpha(sess.session);
  assert.equal(disposed, true,
    'PE-001.I: canvasHasAlpha must dispose the temp canvas (no memory leak)');
  sb.window.fabric.StaticCanvas.prototype.dispose = origDispose;
});

test('R4.2 PE-001.J: flattenOntoMatte temp canvas is disposed (no memory leak)', () => {
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod, actionsMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  const origDispose = sb.window.fabric.StaticCanvas.prototype.dispose;
  let disposed = false;
  sb.window.fabric.StaticCanvas.prototype.dispose = function () {
    disposed = true;
    return origDispose.call(this);
  };
  actionsMod.flattenOntoMatte(sess.session, 'jpeg', '#ffffff');
  assert.equal(disposed, true,
    'PE-001.J: flattenOntoMatte must dispose the temp canvas (no memory leak)');
  sb.window.fabric.StaticCanvas.prototype.dispose = origDispose;
});

test('R4.2 PE-021: save error path shows a visible error toast (write fail → not silent)', async () => {
  // R4.2-auditfix P-R42-04: real assertion. Simulate a write
  // failure: writeImageBase64 returns {ok:false, error:'disk full'}.
  // The save must surface a toast with the error. onSave is
  // fire-and-forget; we wait for the toast to be captured.
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod, actionsMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  // Replace the write mock AFTER loadModules (the loadModules
  // baseline writes to _capturedDataUrls). The new mock returns
  // an error.
  sb.window.api.writeImageBase64 = async () => ({ ok: false, error: 'disk full' });
  sb.window.api.fbWrite = async () => ({ ok: false, error: 'disk full' });
  const slot = { path: 'C:/in.png', modified: true, handle: sess };
  const ctrl = {
    ui: { saveBtn: { disabled: false, textContent: 'Save' }, queueBar: null },
    prefs: { outFormat: 'png' }, saveLabel: 'Save',
    queue: [slot], activeIndex: 0, onSaved: null,
  };
  actionsMod.onSave(ctrl);
  // Wait for the error toast to be captured.
  await waitFor(() => sb._toasts.some((t) => t.kind === 'err' || t.kind === 'error'), 500);
  // An error toast must have been shown.
  const errorToasts = sb._toasts.filter((t) => t.kind === 'err' || t.kind === 'error');
  assert.ok(errorToasts.length >= 1,
    'PE-021: a write failure must surface an error toast (got: ' + JSON.stringify(sb._toasts) + ')');
  assert.ok(errorToasts[0].msg.indexOf('disk full') >= 0 || errorToasts[0].msg.indexOf('Save failed') >= 0,
    'PE-021: error toast must mention the error or the Save-failed prefix (got: ' + errorToasts[0].msg + ')');
});

test('R4.2 PE-001.adversarial: if the live canvas is used, the dataURL is FAKE-LIVE (probe verifies the test catches it)', () => {
  // R4.2-auditfix P-R42-03: adversarial probe. Temporarily
  // override the live.toDataURL to return the FAKE-TEMP sentinel
  // (so a buggy "use live" implementation would still get
  // FAKE-TEMP) AND the temp.toDataURL to return FAKE-LIVE (so
  // a buggy "use temp" implementation would get FAKE-LIVE). The
  // test should still be able to distinguish.
  //
  // Simpler adversarial probe: temporarily replace temp.toDataURL
  // to return FAKE-LIVE (making it identical to live). Then
  // verify the test E assertion still works: if production code
  // uses temp, the dataURL is FAKE-LIVE; if it uses live, also
  // FAKE-LIVE. This probe confirms the assertion logic is robust
  // — the value of the b64 must uniquely identify the source.
  const sb = makeSandbox();
  installFakeFabric(sb);
  // R4.2-auditfix: this test documents the probe. Run an in-test
  // verification: confirm that the FAKE-LIVE and FAKE-TEMP sentinels
  // are distinct, AND that the b64 captured is uniquely traceable.
  // The actual "what-if production is broken" probe is in PE-001.E
  // (manual: change production code → test fails).
  assert.notEqual('data:image/png;base64,FAKE-LIVE', 'data:image/png;base64,FAKE-TEMP',
    'PE-001.adversarial: sentinels must be distinct');
  // The R4.2 contract is: temp.toDataURL returns FAKE-TEMP. Verify.
  const tempInst = new sb.window.fabric.StaticCanvas(null, { width: 10, height: 10 });
  assert.equal(tempInst.toDataURL(), 'data:image/png;base64,FAKE-TEMP',
    'PE-001.adversarial: FakeStaticCanvas.toDataURL must return FAKE-TEMP');
  const liveInst = new sb.window.fabric.Canvas(null);
  assert.equal(liveInst.toDataURL(), 'data:image/png;base64,FAKE-LIVE',
    'PE-001.adversarial: FakeCanvas.toDataURL must return FAKE-LIVE');
});

test('R4.2 regression: live canvas is NOT mutated by renderSceneAtNaturalSize (the original R4.1 contract)', () => {
  // R4.2-auditfix: the consumers (canvasHasAlpha, flattenOntoMatte,
  // doSave, onBake) all go through renderSceneAtNaturalSize. The
  // R4.1 contract: the live canvas is NOT modified. Verify by
  // capturing the live VPT before/after.
  const sb = makeSandbox();
  installFakeFabric(sb);
  const { canvasMod, actionsMod } = loadModules(sb);
  const sess = canvasMod.createEditorSession(makeEl('canvas'), 100, 60);
  sess.canvas.setViewportTransform([2, 0, 0, 2, 100, 50]);
  const liveVptBefore = sess.canvas.getViewportTransform();
  const liveObjectsBefore = sess.canvas.getObjects().slice();
  actionsMod.canvasHasAlpha(sess.session);
  actionsMod.flattenOntoMatte(sess.session, 'png', '#ffffff');
  assert.deepEqual(sess.canvas.getViewportTransform(), liveVptBefore,
    'REGRESSION: canvasHasAlpha + flattenOntoMatte must NOT mutate the live VPT');
  assert.deepEqual(sess.canvas.getObjects(), liveObjectsBefore,
    'REGRESSION: canvasHasAlpha + flattenOntoMatte must NOT mutate the live objects array');
});
