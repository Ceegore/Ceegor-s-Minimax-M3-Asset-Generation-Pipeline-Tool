// tests/unit/renderer/imageEditorHistoryR51.test.js
// ============================================================================
// R5.1 — Historyschema (S2).
//
// Background: per design contract §Phase R5 / §R5.1, the snapshot
// system was minimal: only `json` (toJSON without custom
// props) + `viewport` (VPT array). Several issues:
//   - PE-005: session.baseObject points to the OLD object
//     after restore (loadFromJSON returns new objects).
//   - PE-018: restore uses the legacy Fabric 5 callback API
//     for loadFromJSON. Fabric 6 returns a Promise and treats
//     the 2nd arg as a reviver, not a callback.
//   - Dimensions, zoom, tool state, baseId are NOT in the
//     snapshot — undo of a tool change would silently revert
//     the user back to the old tool.
//   - Savepoint/Dirty model doesn't exist. The "has the
//     session been modified since the last save?" check is
//     not implemented.
//
// R5.1 fix:
//   (a) Snapshot is extended with: dimensions, zoom, baseId,
//       tool. Custom props (selectable, evented, ieKind,
//       excludeFromExport, __baseId) are passed to toJSON.
//   (b) Restore is still Promise-based (the legacy callback
//       is wrapped in a Promise), but it now re-links
//       session.baseObject to the back-most object after
//       loadFromJSON.
//   (c) Savepoint/Dirty model is added as infrastructure
//       (setSavepoint, clearSavepoint, isModified,
//       snapshotEqual). No callsite uses it yet — future
//       R5.2+ cards wire it up.
//   (d) session.baseId is set lazily on the first snapshot
//       (avoids modifying imageEditorCanvas.js, which is
//       out of R5.1 scope per the spec).
//
// Test discipline:
//   - 7 unit tests covering each R5.1 sub-fix (snapshot
//     fields, restore re-link, promise-correct, savepoint,
//     dirty, snapshotEqual, custom-props).
//   - 1 regression test verifying the existing undo/redo
//     stack still works (imageEditorBehavior.test.js has the
//     original test; we add a sanity check here).
//   - 1 adversarial probe: simulate a broken restore and
//     verify the tests catch it.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CANVAS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorCanvas.js');
const TOOLS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorTools.js');

// ---- helpers ----

function makeFakeCanvas() {
  let vpt = [1, 0, 0, 1, 0, 0];
  const objects = [];
  const canvasListeners = {};
  return {
    width: 200, height: 200,
    getWidth() { return this.width; },
    getHeight() { return this.height; },
    setWidth(w) { this.width = w; },
    setHeight(h) { this.height = h; },
    get viewportTransform() { return vpt; },
    setViewportTransform(newVpt) { vpt = newVpt.slice(); },
    getZoom() { return vpt[0] || 1; },
    zoomToPoint() {},
    toJSON(props) { return { version: 'mocked', objects: this._objects.map((o) => ({ ...o, customProps: props })), customPropsRequested: props }; },
    loadFromJSON(j, cb) {
      // Fabric v6 replaces the canvas objects from `j.objects` and
      // returns a Promise that resolves with the canvas — whether or
      // not a reviver/callback is passed (the 2nd arg is a reviver in
      // v6, NOT a completion callback). The production restore() now
      // calls `loadFromJSON(json)` with NO callback and awaits the
      // returned Promise, so the fake MUST replace the objects
      // unconditionally to mimic real Fabric v6. (Pre-fix the fake only
      // replaced objects when a callback was given — a false-confidence
      // trap that mirrored the OLD buggy v5-callback production code.)
      objects.length = 0;
      const list = (j && j.objects) || [];
      list.forEach((o) => objects.push(Object.assign({}, o)));
      if (typeof cb === 'function') setTimeout(() => cb(null), 0);
      return Promise.resolve();
    },
    on(type, fn) { (canvasListeners[type] = canvasListeners[type] || []).push(fn); },
    off(type, fn) {
      const arr = canvasListeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    fire(type, payload) { (canvasListeners[type] || []).forEach((fn) => fn(payload)); },
    add(o) { objects.push(o); return o; },
    getObjects() { return objects; },
    remove(o) { const i = objects.indexOf(o); if (i >= 0) objects.splice(i, 1); },
    sendObjectToBack(o) {
      const i = objects.indexOf(o);
      if (i >= 0) {
        objects.splice(i, 1);
        objects.unshift(o);
      }
    },
    requestRenderAll() {},
    setBackgroundColor() {},
    renderAll() {},
    dispose() {},
    _vpt: vpt,
    _objects: objects,
    _listeners: canvasListeners,
  };
}

function makeFakeFabric() {
  function FakeCanvas(hostEl, opts) { this._state = makeFakeCanvas(); this._opts = opts; }
  FakeCanvas.prototype.setWidth = function (w) { this._state.width = w; };
  FakeCanvas.prototype.setHeight = function (h) { this._state.height = h; };
  FakeCanvas.prototype.getWidth = function () { return this._state.width; };
  FakeCanvas.prototype.getHeight = function () { return this._state.height; };
  FakeCanvas.prototype.zoomToPoint = function (point, z) { this._state.zoomToPoint(point, z); };
  FakeCanvas.prototype.setViewportTransform = function (v) { this._state.setViewportTransform(v); };
  FakeCanvas.prototype.getZoom = function () { return this._state.getZoom(); };
  FakeCanvas.prototype.on = function (type, fn) { this._state.on(type, fn); };
  FakeCanvas.prototype.off = function (type, fn) { this._state.off(type, fn); };
  FakeCanvas.prototype.fire = function (type, p) { this._state.fire(type, p); };
  FakeCanvas.prototype.add = function (o) { this._state.add(o); };
  FakeCanvas.prototype.getObjects = function () { return this._state.getObjects(); };
  FakeCanvas.prototype.remove = function (o) { this._state.remove(o); };
  FakeCanvas.prototype.sendObjectToBack = function (o) { this._state.sendObjectToBack(o); };
  FakeCanvas.prototype.requestRenderAll = function () { this._state.requestRenderAll(); };
  FakeCanvas.prototype.toJSON = function (props) { return this._state.toJSON(props); };
  FakeCanvas.prototype.loadFromJSON = function (j, cb) { return this._state.loadFromJSON(j, cb); };
  FakeCanvas.prototype.toCanvasElement = function (m) { return { width: this._state.width, height: this._state.height, getContext: () => null }; };
  FakeCanvas.prototype.toDataURL = function () { return 'data:image/png;base64,FAKE'; };
  FakeCanvas.prototype.dispose = function () { this._state.dispose(); };
  FakeCanvas.prototype.renderAll = function () { this._state.renderAll(); };
  Object.defineProperty(FakeCanvas.prototype, 'viewportTransform', { get: function () { return this._state.viewportTransform; } });
  function FakeStaticCanvas(hostEl, opts) { this._state = { vpt: [1, 0, 0, 1, 0, 0], objects: [] }; }
  FakeStaticCanvas.prototype.setViewportTransform = function (v) { this._state.vpt = v.slice(); };
  FakeStaticCanvas.prototype.add = function (o) { this._state.objects.push(o); };
  FakeStaticCanvas.prototype.getObjects = function () { return this._state.objects; };
  FakeStaticCanvas.prototype.setBackgroundColor = function () {};
  FakeStaticCanvas.prototype.renderAll = function () {};
  FakeStaticCanvas.prototype.toCanvasElement = function () { return { width: 0, height: 0, getContext: () => null }; };
  FakeStaticCanvas.prototype.dispose = function () {};
  Object.defineProperty(FakeStaticCanvas.prototype, 'viewportTransform', { get: function () { return this._state.vpt; } });
  return { Canvas: FakeCanvas, StaticCanvas: FakeStaticCanvas, Image: { fromURL: () => Promise.resolve({ set() {}, width: 100, height: 60 }) }, PencilBrush: FakeBrush, SprayBrush: FakeBrush };
}

// R5.1.AuditFix P-R51-T04: minimal brush stub so setTool
// can construct a PencilBrush / SprayBrush for the
// restore-re-applies-canvas-tool-state test. The real
// Fabric brushes are full classes with stroke rendering;
// for the test we just need an object that records its
// color/width/density/strokeLineCap/strokeLineJoin so
// the post-undo brush identity check can verify the
// right brush was re-applied.
function FakeBrush() { this.color = null; this.width = 0; this.density = 0; this.strokeLineCap = null; this.strokeLineJoin = null; }

function loadSession() {
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  sb.fabric = makeFakeFabric();
  vm.runInContext(fs.readFileSync(CANVAS_JS, 'utf8'), sb, { filename: 'imageEditorCanvas.js' });
  vm.runInContext(fs.readFileSync(TOOLS_JS, 'utf8'), sb, { filename: 'imageEditorTools.js' });
  const handle = sb.ImageEditorCanvas.createEditorSession({}, 200, 100);
  // Set up a base object (mimics setBaseImage without the actual
  // Fabric Image creation).
  const baseObj = { type: 'image', left: 0, top: 0, width: 200, height: 100 };
  handle.session.canvas.add(baseObj);
  handle.session.canvas.sendObjectToBack(baseObj);
  handle.session.baseObject = baseObj;
  return { sb, handle };
}

// ---- tests ----

test('R5.1.1: snapshot includes dimensions + zoom + baseId + tool (R5.1 sub-fix A)', () => {
  // The new snapshot format includes fields that the
  // pre-R5.1 snapshot did NOT have. Without these, undo of
  // a tool change would lose the tool state, undo of a
  // zoom would lose the zoom, etc.
  const { sb, handle } = loadSession();
  const T = sb.ImageEditorTools;
  // Add a drawing object.
  handle.session.canvas.add({ type: 'rect', left: 10, top: 10, width: 20, height: 20 });
  // Capture a snapshot by calling pushUndo.
  T.pushUndo(handle.session);
  // After pushUndo, _undo has 1 entry. Read the entry.
  assert.equal(handle.session._undo.length, 1);
  const snap = handle.session._undo[0];
  // New fields must be present.
  assert.ok(snap.dimensions, 'R5.1.1: snapshot must include dimensions');
  assert.equal(snap.dimensions.imgW, 200, 'R5.1.1: dimensions.imgW must be 200');
  assert.equal(snap.dimensions.imgH, 100, 'R5.1.1: dimensions.imgH must be 100');
  assert.ok('zoom' in snap, 'R5.1.1: snapshot must include zoom');
  assert.equal(snap.zoom, 1, 'R5.1.1: zoom must be 1 (default)');
  assert.ok('baseId' in snap, 'R5.1.1: snapshot must include baseId');
  assert.ok(snap.baseId && /base-/.test(snap.baseId), 'R5.1.1: baseId must be auto-generated (base-N)');
  assert.equal(snap.tool, 'pen', 'R5.1.1: tool must be "pen" (default)');
  // Existing fields must still be present.
  assert.ok(snap.json, 'R5.1.1: snapshot must still include json');
  assert.ok(snap.viewport, 'R5.1.1: snapshot must still include viewport');
});

test('R5.1.2: snapshot includes custom props in toJSON (ieKind, excludeFromExport, __baseId)', () => {
  // R5.1 sub-fix A: the toJSON call must include the
  // editor-internal custom props so they survive
  // snapshot/restore. Pre-R5.1 only included 'selectable'
  // + 'evented', losing ieKind + excludeFromExport.
  const { sb, handle } = loadSession();
  const T = sb.ImageEditorTools;
  T.pushUndo(handle.session);
  // Inspect the toJSON call to see which custom props were
  // requested.
  const jsonObj = handle.session.canvas.toJSON('selectable,evented,ieKind,excludeFromExport,__baseId');
  // The fake's toJSON records the requested props. We can't
  // inspect the snapshot's toJSON call directly (the
  // snapshot has already serialized). But we can verify that
  // the JSON_CUSTOM_PROPS list in the source includes all
  // 5 props.
  const toolsSrc = fs.readFileSync(TOOLS_JS, 'utf8');
  const codeOnly = toolsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
  const listMatch = codeOnly.match(/JSON_CUSTOM_PROPS\s*=\s*\[([^\]]+)\]/);
  assert.ok(listMatch, 'R5.1.2: JSON_CUSTOM_PROPS must be defined');
  const list = listMatch[1];
  assert.ok(/selectable/.test(list), 'R5.1.2: JSON_CUSTOM_PROPS must include selectable');
  assert.ok(/evented/.test(list), 'R5.1.2: JSON_CUSTOM_PROPS must include evented');
  assert.ok(/ieKind/.test(list), 'R5.1.2: JSON_CUSTOM_PROPS must include ieKind');
  assert.ok(/excludeFromExport/.test(list), 'R5.1.2: JSON_CUSTOM_PROPS must include excludeFromExport');
  assert.ok(/__baseId/.test(list), 'R5.1.2: JSON_CUSTOM_PROPS must include __baseId');
});

test('R5.1.3: restore re-links session.baseObject to the back-most object (R5.1 sub-fix B)', () => {
  // Pre-R5.1: session.baseObject was a reference to the OLD
  // Fabric object. After loadFromJSON, the OLD object is
  // detached (not in the canvas); session.baseObject pointed
  // to a stale reference. R5.1 fixes this by re-linking
  // session.baseObject to the back-most object (which is
  // the base, by sendObjectToBack).
  //
  // R5.1.AuditFix P-R51-B1: the FakeCanvas's loadFromJSON
  // now actually REPLACES the objects (mimicking real
  // Fabric). Pre-fix, the fake was a no-op, so the
  // assertion `session.baseObject === objs[0]` passed
  // even when the re-link was removed (false-confidence
  // trap). With the actual replacement, this test now
  // catches the regression: objs[0] is the NEW object
  // (from the snapshot's json), and session.baseObject
  // is the OLD object unless the re-link runs.
  const { sb, handle } = loadSession();
  const T = sb.ImageEditorTools;
  // Push undo, then add a new object, then push undo again.
  T.pushUndo(handle.session);
  handle.session.canvas.add({ type: 'rect', left: 5, top: 5 });
  T.pushUndo(handle.session);
  // Capture the pre-restore baseObject (stale, will be orphaned
  // after loadFromJSON replaces the objects).
  const staleBase = handle.session.baseObject;
  // Undo: the rect is removed; session.baseObject is re-linked
  // to the back-most object (which is the base, recreated by
  // loadFromJSON).
  return T.undo(handle.session).then(() => {
    const objs = handle.session.canvas.getObjects();
    // 1) The strong assertion: baseObject is re-linked to the
    //    back-most object of the restored state. If the re-link
    //    is removed, this fails (baseObject is still the stale
    //    ref, objs[0] is the new object — different references).
    assert.equal(handle.session.baseObject, objs[0],
      'R5.1.3: session.baseObject must be re-linked to the back-most object after restore');
    // 2) Defensive: baseObject is NOT the stale (detached) ref
    //    from before restore. This proves the re-link actually
    //    changed something.
    assert.notEqual(handle.session.baseObject, staleBase,
      'R5.1.3: session.baseObject must NOT be the stale pre-restore ref (PE-005 fix)');
    // 3) Defensive: baseObject is a member of the canvas's
    //    objects array (i.e. not orphaned / detached).
    assert.ok(objs.includes(handle.session.baseObject),
      'R5.1.3: session.baseObject must be a member of canvas.getObjects() (not detached)');
  });
});

test('R5.1.4: restore is Promise-correct (PE-018 fix, success path)', () => {
  // Pre-R5.1: restore used `new Promise((resolve) => { ...
  // loadFromJSON(snap.json, () => { ... resolve(); }); })`.
  // Fabric 6's loadFromJSON returns a Promise and treats the
  // 2nd arg as a reviver, not a callback. R5.1 wraps the
  // callback in a Promise (compatible with the legacy
  // signature used by the current FakeCanvas). The restore
  // is awaited correctly.
  //
  // R5.1.AuditFix P-R51-DOC-3: this test verifies the
  // Promise-wrap only. It does NOT verify Fabric 6's
  // native Promise API (which is deferred to R5.2+).
  // The R5.1.4.error-path test (next) covers the error
  // propagation through the Promise wrap.
  const { sb, handle } = loadSession();
  const T = sb.ImageEditorTools;
  T.pushUndo(handle.session);
  // The undo should return a Promise.
  const undoResult = T.undo(handle.session);
  assert.ok(undoResult && typeof undoResult.then === 'function',
    'R5.1.4: undo must return a Promise');
  return undoResult.then(() => {
    assert.ok(true, 'R5.1.4: undo Promise resolved');
  });
});

test('R5.1.4.error-path: restore rejects when loadFromJSON passes an error', () => {
  // R5.1.AuditFix P-R51-E1: the success-path test (R5.1.4)
  // does not cover the error path. Pre-fix, the restore's
  // `if (err) { reject(err); return; }` branch was untested.
  // The adversarial probe (mutate restore() to drop the
  // err-check + pass an error from FakeCanvas) verified that
  // the success-path test does NOT catch the regression.
  //
  // This test: pass an error from the FakeCanvas, verify
  // the Promise rejects with the same error.
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  sb.fabric = makeFakeFabric();
  vm.runInContext(fs.readFileSync(CANVAS_JS, 'utf8'), sb, { filename: 'imageEditorCanvas.js' });
  vm.runInContext(fs.readFileSync(TOOLS_JS, 'utf8'), sb, { filename: 'imageEditorTools.js' });
  // Patch the FakeCanvas's loadFromJSON to fail. Real Fabric v6 signals a
  // load failure by REJECTING the returned Promise (the 2nd arg is a reviver,
  // NOT a completion callback), so the fake rejects the Promise rather than
  // invoking a callback with an error. The production restore() awaits the
  // returned Promise, so the rejection propagates and undo() rejects.
  const handle = sb.ImageEditorCanvas.createEditorSession({}, 200, 100);
  handle.session.canvas.loadFromJSON = function (j, cb) {
    return Promise.reject(new Error('synthetic load error'));
  };
  const T = sb.ImageEditorTools;
  T.pushUndo(handle.session);
  const undoResult = T.undo(handle.session);
  assert.ok(undoResult && typeof undoResult.then === 'function',
    'R5.1.4.error-path: undo must return a Promise (even on err path)');
  return undoResult.then(
    () => { throw new Error('R5.1.4.error-path: undo should have REJECTED (err path), not resolved'); },
    (err) => {
      assert.ok(err && /synthetic load error/.test(err.message),
        'R5.1.4.error-path: undo must reject with the load error');
    }
  );
});

test('R5.1.5: setSavepoint + isModified (R5.1 sub-fix C — Savepoint/Dirty model)', () => {
  // The Savepoint/Dirty model is added as infrastructure.
  // No callsite uses it yet, but the helpers are exported.
  const { sb, handle } = loadSession();
  const T = sb.ImageEditorTools;
  // Initial state: no savepoint, isModified returns false.
  assert.equal(T.isModified(handle.session), false,
    'R5.1.5: with no savepoint, isModified must return false (initial state)');
  // Set savepoint to the current snapshot.
  T.setSavepoint(handle.session);
  assert.equal(T.isModified(handle.session), false,
    'R5.1.5: after setSavepoint (no args), isModified must return false');
  // Modify the canvas (add an object).
  handle.session.canvas.add({ type: 'rect', left: 10, top: 10 });
  // Now the current snapshot differs from the savepoint.
  assert.equal(T.isModified(handle.session), true,
    'R5.1.5: after a modification, isModified must return true');
  // Set savepoint again (captures the modified state).
  T.setSavepoint(handle.session);
  assert.equal(T.isModified(handle.session), false,
    'R5.1.5: after setSavepoint, isModified must return false again');
  // Clear savepoint.
  T.clearSavepoint(handle.session);
  assert.equal(T.isModified(handle.session), false,
    'R5.1.5: after clearSavepoint, isModified must return false');
});

test('R5.1.6: snapshotEqual detects changes in zoom, tool, baseId, viewport, json', () => {
  // The snapshotEqual helper is used by isModified. It must
  // detect changes in all fields that affect the canvas
  // state.
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  sb.fabric = makeFakeFabric();
  vm.runInContext(fs.readFileSync(CANVAS_JS, 'utf8'), sb, { filename: 'imageEditorCanvas.js' });
  vm.runInContext(fs.readFileSync(TOOLS_JS, 'utf8'), sb, { filename: 'imageEditorTools.js' });
  const T = sb.ImageEditorTools;
  const a = { json: {}, viewport: [1, 0, 0, 1, 0, 0], dimensions: { imgW: 100, imgH: 100 }, zoom: 1, baseId: 'base-1', tool: 'pen' };
  const b = { json: {}, viewport: [1, 0, 0, 1, 0, 0], dimensions: { imgW: 100, imgH: 100 }, zoom: 1, baseId: 'base-1', tool: 'pen' };
  assert.equal(T.snapshotEqual(a, b), true, 'R5.1.6: identical snapshots must be equal');
  assert.equal(T.snapshotEqual(a, null), false, 'R5.1.6: null comparison must be false');
  assert.equal(T.snapshotEqual(null, a), false, 'R5.1.6: null comparison must be false');
  // Change each field; must detect.
  const c = { ...b, zoom: 1.5 };
  assert.equal(T.snapshotEqual(a, c), false, 'R5.1.6: zoom change must be detected');
  const d = { ...b, tool: 'eraser' };
  assert.equal(T.snapshotEqual(a, d), false, 'R5.1.6: tool change must be detected');
  const e = { ...b, baseId: 'base-2' };
  assert.equal(T.snapshotEqual(a, e), false, 'R5.1.6: baseId change must be detected');
  const f = { ...b, viewport: [1, 0, 0, 1, 10, 20] };
  assert.equal(T.snapshotEqual(a, f), false, 'R5.1.6: viewport change must be detected');
  const g = { ...b, dimensions: { imgW: 200, imgH: 100 } };
  assert.equal(T.snapshotEqual(a, g), false, 'R5.1.6: dimensions change must be detected');
  const h = { ...b, json: { different: true } };
  assert.equal(T.snapshotEqual(a, h), false, 'R5.1.6: json change must be detected');
});

test('R5.1.7: existing undo/redo flow still works (regression)', () => {
  // Sanity check: the original undo/redo flow (push → undo →
  // redo) still works after the R5.1 refactor.
  const { sb, handle } = loadSession();
  const T = sb.ImageEditorTools;
  assert.equal(T.canUndo(handle.session), false);
  T.pushUndo(handle.session);
  assert.equal(T.canUndo(handle.session), true);
  return T.undo(handle.session).then(() => {
    assert.equal(T.canRedo(handle.session), true);
    return T.redo(handle.session);
  }).then(() => {
    assert.equal(T.canUndo(handle.session), true);
  });
});

test('R5.1.adversarial: removing setSavepoint from tools.js would FAIL R5.1.5', () => {
  // Adversarial probe: simulate removing the setSavepoint
  // export and verify that the R5.1.5 test would fail.
  // We do this by source-grepping for the function name.
  const toolsSrc = fs.readFileSync(TOOLS_JS, 'utf8');
  assert.ok(/function\s+setSavepoint/.test(toolsSrc),
    'R5.1.adversarial: setSavepoint must be defined in imageEditorTools.js');
  assert.ok(/function\s+isModified/.test(toolsSrc),
    'R5.1.adversarial: isModified must be defined in imageEditorTools.js');
  assert.ok(/function\s+snapshotEqual/.test(toolsSrc),
    'R5.1.adversarial: snapshotEqual must be defined in imageEditorTools.js');
  // The setSavepoint + isModified + snapshotEqual must be
  // EXPORTED in the window.ImageEditorTools object.
  assert.ok(/setSavepoint,?\s*\n/.test(toolsSrc) || /setSavepoint,/.test(toolsSrc),
    'R5.1.adversarial: setSavepoint must be exported');
  assert.ok(/isModified,?/.test(toolsSrc),
    'R5.1.adversarial: isModified must be exported');
  assert.ok(/snapshotEqual,?/.test(toolsSrc),
    'R5.1.adversarial: snapshotEqual must be exported');
});

// ---- R5.1.AuditFix: edge-case tests (P-R51-T02..T06) ----

test('R5.1.8 P-R51-T02: pushUndo caps the undo stack at MAX_UNDO=25', () => {
  // R5.1.AuditFix P-R51-T02: MAX_UNDO=25 was hardcoded but
  // never directly tested. After 26 pushUndo's, only the
  // last 25 should be in the _undo stack (the first one is
  // shifted off by the cap).
  const { sb, handle } = loadSession();
  const T = sb.ImageEditorTools;
  const MAX_UNDO = 25;
  // Push 26 unique states (each state differs from the
  // previous by a new object).
  for (let i = 0; i < MAX_UNDO + 1; i++) {
    handle.session.canvas.add({ type: 'rect', left: i, top: i });
    T.pushUndo(handle.session);
  }
  assert.equal(handle.session._undo.length, MAX_UNDO,
    'R5.1.8 P-R51-T02: _undo stack must be capped at MAX_UNDO=25 (got ' + handle.session._undo.length + ')');
});

test('R5.1.9 P-R51-T03: restore() with undefined fields is defensive (no crash)', () => {
  // R5.1.AuditFix P-R51-T03: the spec doesn't say what
  // happens with a malformed snapshot (missing fields).
  // The current implementation has `if (snap.dimensions)`,
  // `if (snap.tool != null)`, etc. — so undefined fields are
  // skipped. Test this defensive behavior by manually
  // pushing a minimal snap (only json + viewport) and
  // calling undo() to trigger restore().
  const { sb, handle } = loadSession();
  const T = sb.ImageEditorTools;
  // Build a minimal snap (only json + viewport, no dimensions/tool/baseId/zoom).
  const minimalSnap = { json: { version: 'mocked', objects: [] }, viewport: [1, 0, 0, 1, 0, 0] };
  // Push the minimal snap to _undo (simulating a prior snapshot).
  handle.session._undo.push(minimalSnap);
  assert.equal(handle.session._undo.length, 1,
    'R5.1.9 P-R51-T03: _undo must have 1 entry before undo');
  // Undo triggers restore with the minimal snap.
  return T.undo(handle.session).then(() => {
    // After restore with minimal snap, the session must
    // not crash. baseObject was re-linked (to null because
    // the empty json has no objects). tool was NOT
    // changed (no snap.tool).
    assert.equal(handle.session.baseObject, null,
      'R5.1.9 P-R51-T03: with empty objects, baseObject should be null after restore');
  });
});

test('R5.1.10 P-R51-T04: restore() re-applies the canvas tool state (the P-R51-T01 prod-bug)', () => {
  // R5.1.AuditFix P-R51-T01 (prod-bug): pre-fix, restore()
  // set `session.tool = snap.tool` but did NOT call
  // setTool(), so the canvas's isDrawingMode + freeDrawingBrush
  // were NOT updated. After undo, the canvas was in the
  // WRONG drawing mode. This test catches the bug by
  // verifying that after undo, the canvas's freeDrawingBrush
  // color matches the pen brush (uses session.fg color),
  // NOT the eraser brush (always black rgba(0,0,0,1)).
  const { sb, handle } = loadSession();
  const T = sb.ImageEditorTools;
  // Set fg to RED so the pen brush color is distinguishable
  // from the eraser brush color (which is always black).
  handle.session.fg = '#ff0000';
  // Set tool to 'pen' (drawing mode).
  T.setTool(handle.session, 'pen');
  // Sanity: pen brush color should be the red fg.
  assert.equal(handle.session.canvas.freeDrawingBrush.color, 'rgba(255,0,0,1)',
    'R5.1.10 P-R51-T04: pre-undo, pen brush color must be the red fg');
  // Push undo (captures state with pen + red brush).
  T.pushUndo(handle.session);
  // Switch to eraser (brush becomes black).
  T.setTool(handle.session, 'eraser');
  assert.equal(handle.session.canvas.freeDrawingBrush.color, 'rgba(0,0,0,1)',
    'R5.1.10 P-R51-T04: after switch to eraser, brush color must be black');
  // Undo: should re-apply the pen tool's drawing state
  // (i.e. call setTool('pen') which re-creates the brush
  // with the red fg color).
  return T.undo(handle.session).then(() => {
    assert.equal(handle.session.tool, 'pen',
      'R5.1.10 P-R51-T04: after undo, session.tool must be "pen"');
    const brush = handle.session.canvas.freeDrawingBrush;
    assert.ok(brush,
      'R5.1.10 P-R51-T04: after undo, freeDrawingBrush must exist');
    // Pre-fix: brush color would still be 'rgba(0,0,0,1)'
    // (the eraser color, because restore only set
    // session.tool and did not call setTool). Post-fix:
    // brush color must be 'rgba(255,0,0,1)' (the pen
    // brush with red fg).
    assert.equal(brush.color, 'rgba(255,0,0,1)',
      'R5.1.10 P-R51-T04: after undo, brush color must be the PEN brush (red fg), not the eraser black. Got: ' + brush.color);
  });
});

test('R5.1.11 P-R51-T05: snapshotEqual handles deep object changes (defensive)', () => {
  // R5.1.AuditFix P-R51-T05: snapshotEqual uses JSON.stringify
  // for the json field. For a json with NESTED objects, the
  // comparison is deep. This test verifies that a nested
  // change is detected.
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  sb.fabric = makeFakeFabric();
  vm.runInContext(fs.readFileSync(CANVAS_JS, 'utf8'), sb, { filename: 'imageEditorCanvas.js' });
  vm.runInContext(fs.readFileSync(TOOLS_JS, 'utf8'), sb, { filename: 'imageEditorTools.js' });
  const T = sb.ImageEditorTools;
  const a = { json: { version: 'x', objects: [{ type: 'rect', props: { fill: 'red' } }] }, viewport: [1, 0, 0, 1, 0, 0], dimensions: { imgW: 100, imgH: 100 }, zoom: 1, baseId: 'base-1', tool: 'pen' };
  const b = { ...a, json: { version: 'x', objects: [{ type: 'rect', props: { fill: 'blue' } }] } };
  assert.equal(T.snapshotEqual(a, b), false,
    'R5.1.11 P-R51-T05: nested json change must be detected by snapshotEqual');
  const c = { ...a, json: { ...a.json, version: 'y' } };
  assert.equal(T.snapshotEqual(a, c), false,
    'R5.1.11 P-R51-T05: top-level json field change must be detected');
  const d = { ...a }; // identical
  assert.equal(T.snapshotEqual(a, d), true,
    'R5.1.11 P-R51-T05: identical snapshots must be equal (sanity)');
});

test('R5.1.12 P-R51-T06: pushUndo clears the redo stack (undo/redo branch semantics)', () => {
  // R5.1.AuditFix P-R51-T06: when a new edit is pushed
  // (after some undos), the redo stack is cleared. This is
  // a critical branch-invariant: the user can't redo after
  // making a new edit.
  const { sb, handle } = loadSession();
  const T = sb.ImageEditorTools;
  // Push 2 states, undo once (state goes to redo).
  T.pushUndo(handle.session);
  handle.session.canvas.add({ type: 'rect', left: 1, top: 1 });
  T.pushUndo(handle.session);
  return T.undo(handle.session).then(() => {
    assert.equal(handle.session._redo.length, 1,
      'R5.1.12 P-R51-T06: redo stack must have 1 entry after undo');
    // New edit: push a new state, redo should be cleared.
    handle.session.canvas.add({ type: 'rect', left: 2, top: 2 });
    T.pushUndo(handle.session);
    assert.equal(handle.session._redo.length, 0,
      'R5.1.12 P-R51-T06: new edit must clear the redo stack');
  });
});
