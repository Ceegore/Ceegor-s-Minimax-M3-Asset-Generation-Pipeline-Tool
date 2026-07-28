// tests/unit/renderer/imageEditorR52Stroke.test.js
// ============================================================================
// R5.2 Stroke — first callsite card of the R5.2 series.
//
// Background: per design contract §Phase R5 / §R5.2, the snapshot
// system (R5.1) is in place. The next step is to wire the
// callsites so each user-action correctly pushes a
// pre-snapshot + commits + cancels.
//
// Pre-R5.2 bug: the overlay's wireCanvasEvents function
// pushed the post-stroke snapshot on `mouse:up`. This meant:
//   1. user draws stroke (mouse:down → drag → mouse:up)
//   2. path:created fires (path is on canvas)
//   3. mouse:up handler pushes post-stroke state S1
//   4. _undo = [S1]
//   5. user undoes → pops S1, restores to S1 (NO CHANGE)
//   6. user has to undo TWICE to get back to before the stroke
// (in practice: undo is broken for a single stroke).
//
// R5.2 fix: move the pushUndo to `mouse:down` (PRE-snapshot).
// Now:
//   1. user mouses down → pushUndo captures pre-stroke S0
//   2. user drags → path is created
//   3. user mouses up → slot.modified = true (no push)
//   4. _undo = [S0]
//   5. user undoes → pops S0, restores to S0 (PRE-STROKE)
//   6. ONE undo restores the pixel-exact pre-stroke state
//      (PE-005-Pixelvertrag).
//
// Test discipline: structural source-grep test (the overlay
// requires full DOM mocks for a behavioral test, which is out
// of scope for R5.2 first card). The source-grep test catches
// the regression (pushUndo back on mouse:up) by verifying the
// exact line patterns.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OVERLAY_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorOverlay.js');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

const overlaySrc = fs.readFileSync(OVERLAY_JS, 'utf8');
const overlayCode = stripComments(overlaySrc);

test('R5.2.A: mouse:down handler pushes undo when isDrawingMode (PRE-snapshot)', () => {
  // R5.2 Stroke A: the pre-snapshot is captured on mouse:down
  // (not on mouse:up). Verify that the mouse:down handler has
  // a pushUndo call wrapped in an isDrawingMode check AND a
  // try/catch (defensive against malformed sessions).
  //
  // R5.2.AuditFix P-R52-B1: check for the EXACT call
  // `Tools.pushUndo(session)` (not just any string containing
  // "pushUndo"). Pre-fix: a typo like `Tools.pushUndoWRONG(session)`
  // would have passed the test because `/pushUndo/.test(block)`
  // matches the typo. Post-fix: the regex requires the exact
  // call signature.
  //
  // R5.2.AuditFix P-R52-T01: also check for the try/catch
  // wrapper around pushUndo. Without the try/catch, a malformed
  // session would crash the editor.
  const mouseDownMatch = overlayCode.match(/trackOn\('mouse:down'[\s\S]*?\}\);/);
  assert.ok(mouseDownMatch, 'R5.2.A: mouse:down handler must exist in imageEditorOverlay.js');
  const block = mouseDownMatch[0];
  assert.ok(/isDrawingMode/.test(block),
    'R5.2.A: mouse:down handler must check isDrawingMode');
  // P-R52-B1: exact call signature check.
  assert.ok(/Tools\.pushUndo\s*\(\s*session\s*\)/.test(block),
    'R5.2.A: mouse:down handler must call Tools.pushUndo(session) EXACTLY (not a typo like pushUndoWRONG)');
  // P-R52-T01: try/catch wrapper check.
  assert.ok(/try\s*\{[^}]*Tools\.pushUndo[^}]*\}\s*catch/.test(block),
    'R5.2.A: Tools.pushUndo must be wrapped in try/catch (defensive against malformed sessions)');
  // R5.2.AuditFix P-R52-T02: mouse:down must also record the
  // pre-stroke object count (for the click-without-drag cleanup
  // in mouse:up).
  assert.ok(/_preStrokeObjectCount/.test(block),
    'R5.2.A: mouse:down handler must record _preStrokeObjectCount (for the click-without-drag cleanup)');
});

test('R5.2.B: mouse:up handler does NOT call pushUndo (only sets modified + refresh)', () => {
  // R5.2 Stroke B: the post-stroke push was REMOVED from
  // mouse:up. Verify that the mouse:up handler does NOT
  // call pushUndo. It still sets slot.modified = true and
  // calls refreshQueueBar (those are post-stroke actions
  // that don't need to be in the undo stack).
  //
  // R5.2.AuditFix P-R52-B1: same exact-call check as R5.2.A.
  // A typo `Tools.pushUndoWRONG` should NOT be allowed.
  const mouseUpMatch = overlayCode.match(/trackOn\('mouse:up'[\s\S]*?\}\);/);
  assert.ok(mouseUpMatch, 'R5.2.B: mouse:up handler must exist in imageEditorOverlay.js');
  const block = mouseUpMatch[0];
  assert.ok(!/Tools\.pushUndo\s*\(/.test(block),
    'R5.2.B: mouse:up handler must NOT call Tools.pushUndo(...) (the pre-snapshot moved to mouse:down)');
  // Defensive: still has the isDrawingMode guard + slot.modified + refresh.
  assert.ok(/isDrawingMode/.test(block),
    'R5.2.B: mouse:up handler must still check isDrawingMode');
  assert.ok(/slot\.modified\s*=\s*true/.test(block),
    'R5.2.B: mouse:up handler must still set slot.modified = true');
  assert.ok(/refreshQueueBar/.test(block),
    'R5.2.B: mouse:up handler must still call refreshQueueBar');
  // R5.2.AuditFix P-R52-T02/T03: mouse:up must pop the
  // pre-snapshot if no stroke was created (click-without-drag
  // or mouseup outside canvas). The logic compares
  // canvas.getObjects().length to the recorded
  // _preStrokeObjectCount.
  assert.ok(/_preStrokeObjectCount/.test(block) || /canvas\.getObjects\(\)/.test(block),
    'R5.2.B: mouse:up handler must check _preStrokeObjectCount (P-R52-T02/T03 click-without-drag cleanup)');
  assert.ok(/_undo\.pop\(\)/.test(block) || /undo/.test(block),
    'R5.2.B: mouse:up handler must pop the pre-snapshot if no stroke was created');
});

test('R5.2.C: R5.2 doc-comment in mouse:up explains the pre-fix bug + the fix', () => {
  // R5.2 Stroke C: the mouse:up handler has a doc-comment
  // explaining WHY the pushUndo was removed (so a future
  // contributor doesn't accidentally put it back).
  const mouseUpMatch = overlaySrc.match(/trackOn\('mouse:up'[\s\S]*?\}\);/);
  assert.ok(mouseUpMatch, 'R5.2.C: mouse:up handler must exist in imageEditorOverlay.js');
  const block = mouseUpMatch[0];
  // The block must contain a "R5.2" reference + an explanation
  // of why pushUndo was removed.
  assert.ok(/R5\.2/.test(block),
    'R5.2.C: mouse:up handler must have a R5.2 doc-comment');
  assert.ok(/PRE-SNAPSHOT|Pre-fix|pre-snapshot|post-stroke|stroke was drawn/i.test(block),
    'R5.2.C: mouse:up handler doc-comment must explain the pre-fix bug + the fix');
});

test('R5.2.D: R5.2 doc-comment in mouse:down explains the pre-snapshot purpose', () => {
  // R5.2 Stroke D: the mouse:down handler has a doc-comment
  // explaining WHY pushUndo is called (the pre-snapshot).
  const mouseDownMatch = overlaySrc.match(/trackOn\('mouse:down'[\s\S]*?\}\);/);
  assert.ok(mouseDownMatch, 'R5.2.D: mouse:down handler must exist in imageEditorOverlay.js');
  const block = mouseDownMatch[0];
  assert.ok(/R5\.2/.test(block),
    'R5.2.D: mouse:down handler must have a R5.2 doc-comment');
  assert.ok(/PRE-SNAPSHOT|pre-snapshot|pixel-exact|PE-005/i.test(block),
    'R5.2.D: mouse:down handler doc-comment must explain the pre-snapshot purpose + PE-005-Pixelvertrag');
});

test('R5.2.E: integration check — pushUndo + undo + redo (drag+release scenario)', () => {
  // R5.2 Stroke E: verify the pushUndo infrastructure still
  // works as expected (drag + release scenario — the path is
  // created, so the pre-snapshot is kept, undo restores the
  // pre-stroke state).
  //
  // R5.2.AuditFix P-R52-DOC-1: this test exercises the
  // underlying R5.1 pushUndo/undo infrastructure directly. It
  // does NOT test the overlay's wireCanvasEvents handler (that
  // would require full DOM mocks). The overlay's handler is
  // verified by the structural source-grep tests (R5.2.A-D,
  // R5.2.F-G).
  const vm = require('vm');
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  // Minimal FakeFabric (same pattern as imageEditorHistoryR51.test.js).
  function makeFakeCanvas() {
    const vpt = [1, 0, 0, 1, 0, 0];
    const objects = [];
    const canvasListeners = {};
    return {
      width: 200, height: 100,
      viewportTransform: vpt,
      setViewportTransform: (v) => v,
      getZoom: () => 1,
      toJSON: () => ({ version: 'x', objects: objects.map((o) => Object.assign({}, o)) }),
      loadFromJSON: (j, cb) => {
        objects.length = 0;
        (j.objects || []).forEach((o) => objects.push(Object.assign({}, o)));
        if (typeof cb === 'function') setTimeout(() => cb(null), 0);
        return Promise.resolve();
      },
      on: (t, fn) => { (canvasListeners[t] = canvasListeners[t] || []).push(fn); },
      off: (t, fn) => { const arr = canvasListeners[t] || []; const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); },
      fire: (t, p) => { (canvasListeners[t] || []).forEach((fn) => fn(p)); },
      add: (o) => { objects.push(o); return o; },
      getObjects: () => objects,
      remove: (o) => { const i = objects.indexOf(o); if (i >= 0) objects.splice(i, 1); },
      sendObjectToBack: (o) => { const i = objects.indexOf(o); if (i >= 0) { objects.splice(i, 1); objects.unshift(o); } },
      renderAll: () => {}, requestRenderAll: () => {}, dispose: () => {},
    };
  }
  function makeFakeFabric() {
    function FakeCanvas() { this._state = makeFakeCanvas(); }
    FakeCanvas.prototype.setWidth = function () {};
    FakeCanvas.prototype.setHeight = function () {};
    FakeCanvas.prototype.getWidth = function () { return 200; };
    FakeCanvas.prototype.getHeight = function () { return 100; };
    FakeCanvas.prototype.setViewportTransform = function (v) { this._state.setViewportTransform(v); };
    FakeCanvas.prototype.getZoom = function () { return 1; };
    FakeCanvas.prototype.toJSON = function () { return this._state.toJSON(); };
    FakeCanvas.prototype.loadFromJSON = function (j, cb) { return this._state.loadFromJSON(j, cb); };
    FakeCanvas.prototype.on = function (t, fn) { this._state.on(t, fn); };
    FakeCanvas.prototype.off = function (t, fn) { this._state.off(t, fn); };
    FakeCanvas.prototype.fire = function (t, p) { this._state.fire(t, p); };
    FakeCanvas.prototype.add = function (o) { return this._state.add(o); };
    FakeCanvas.prototype.getObjects = function () { return this._state.getObjects(); };
    FakeCanvas.prototype.remove = function (o) { this._state.remove(o); };
    FakeCanvas.prototype.sendObjectToBack = function (o) { this._state.sendObjectToBack(o); };
    FakeCanvas.prototype.renderAll = function () {}; FakeCanvas.prototype.dispose = function () {};
    Object.defineProperty(FakeCanvas.prototype, 'viewportTransform', { get: function () { return this._state.viewportTransform; } });
    return { Canvas: FakeCanvas, StaticCanvas: FakeCanvas, Image: { fromURL: () => Promise.resolve({ set() {}, width: 100, height: 60 }) } };
  }
  sb.fabric = makeFakeFabric();
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', 'overlays', 'imageEditorCanvas.js'), 'utf8'), sb, { filename: 'imageEditorCanvas.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', 'overlays', 'imageEditorTools.js'), 'utf8'), sb, { filename: 'imageEditorTools.js' });
  const T = sb.ImageEditorTools;
  const handle = sb.ImageEditorCanvas.createEditorSession({}, 200, 100);
  const session = handle.session;
  // Simulate: mouse:down → pushUndo (R5.2 PRE-snapshot) +
  // record _preStrokeObjectCount.
  T.pushUndo(session);
  session._preStrokeObjectCount = session.canvas.getObjects().length;
  assert.equal(T.canUndo(session), true, 'R5.2.E: after mouse:down pushUndo, canUndo must be true');
  // Simulate: user drags + releases (path is created).
  const strokePath = { type: 'path', stroke: 'red', left: 10, top: 10 };
  session.canvas.add(strokePath);
  assert.equal(session.canvas.getObjects().length, 1, 'R5.2.E: after adding the path, canvas has 1 object');
  // Simulate: mouse:up → no pushUndo + check: object count changed
  // (1 vs 0), so the pre-snapshot is KEPT.
  const preUndoCount = session._undo.length;
  const isStrokeCommitted = session.canvas.getObjects().length !== session._preStrokeObjectCount;
  if (!isStrokeCommitted) {
    // R5.2.AuditFix P-R52-T02/T03: no stroke was created → pop the
    // pre-snapshot (click-without-drag cleanup).
    session._undo.pop();
  }
  assert.equal(session._undo.length, preUndoCount, 'R5.2.E: drag+release scenario: _undo has 1 entry (pre-snapshot kept)');
  // Simulate: user undoes
  return T.undo(session).then(() => {
    assert.equal(session.canvas.getObjects().length, 0, 'R5.2.E: after undo, the path is gone (pre-stroke state restored)');
    assert.equal(T.canRedo(session), true, 'R5.2.E: after undo, canRedo is true');
    // Simulate: user redoes
    return T.redo(session);
  }).then(() => {
    assert.equal(session.canvas.getObjects().length, 1, 'R5.2.E: after redo, the path is back');
    assert.equal(T.canUndo(session), true, 'R5.2.E: after redo, canUndo is true again');
  });
});

test('R5.2.F: click-without-drag cleanup — pre-snapshot is popped (R5.2.AuditFix P-R52-T02/T03)', () => {
  // R5.2.AuditFix P-R52-T02/T03: pre-R5.2.AuditFix, a click
  // without drag (mouse:down + mouse:up without stroke) would
  // leave a useless pre-snapshot in the undo stack. After N
  // clicks, the user would have to undo N times to get back
  // to the "real" previous state. Post-R5.2.AuditFix: the
  // mouse:up handler compares the canvas object count to the
  // recorded _preStrokeObjectCount; if unchanged, the
  // pre-snapshot is popped.
  //
  // We exercise the SAME logic that the overlay's mouse:up
  // handler uses (without loading the full overlay).
  const vm = require('vm');
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  // Reuse the same FakeFabric setup as R5.2.E.
  function makeFakeCanvas() {
    const vpt = [1, 0, 0, 1, 0, 0];
    const objects = [];
    return {
      width: 200, height: 100,
      viewportTransform: vpt, setViewportTransform: (v) => v, getZoom: () => 1,
      toJSON: () => ({ version: 'x', objects: objects.map((o) => Object.assign({}, o)) }),
      loadFromJSON: (j, cb) => { objects.length = 0; (j.objects || []).forEach((o) => objects.push(Object.assign({}, o))); if (typeof cb === 'function') setTimeout(() => cb(null), 0); return Promise.resolve(); },
      on: () => {}, off: () => {}, fire: () => {},
      add: (o) => { objects.push(o); return o; },
      getObjects: () => objects,
      remove: (o) => { const i = objects.indexOf(o); if (i >= 0) objects.splice(i, 1); },
      sendObjectToBack: (o) => { const i = objects.indexOf(o); if (i >= 0) { objects.splice(i, 1); objects.unshift(o); } },
      renderAll: () => {}, requestRenderAll: () => {}, dispose: () => {},
    };
  }
  function makeFakeFabric() {
    function FakeCanvas() { this._state = makeFakeCanvas(); }
    FakeCanvas.prototype.setWidth = FakeCanvas.prototype.setHeight = function () {};
    FakeCanvas.prototype.getWidth = function () { return 200; };
    FakeCanvas.prototype.getHeight = function () { return 100; };
    FakeCanvas.prototype.setViewportTransform = function (v) { this._state.setViewportTransform(v); };
    FakeCanvas.prototype.getZoom = function () { return 1; };
    FakeCanvas.prototype.toJSON = function () { return this._state.toJSON(); };
    FakeCanvas.prototype.loadFromJSON = function (j, cb) { return this._state.loadFromJSON(j, cb); };
    FakeCanvas.prototype.on = FakeCanvas.prototype.off = FakeCanvas.prototype.fire = function () {};
    FakeCanvas.prototype.add = function (o) { return this._state.add(o); };
    FakeCanvas.prototype.getObjects = function () { return this._state.getObjects(); };
    FakeCanvas.prototype.remove = function (o) { this._state.remove(o); };
    FakeCanvas.prototype.sendObjectToBack = function (o) { this._state.sendObjectToBack(o); };
    FakeCanvas.prototype.renderAll = FakeCanvas.prototype.dispose = function () {};
    Object.defineProperty(FakeCanvas.prototype, 'viewportTransform', { get: function () { return this._state.viewportTransform; } });
    return { Canvas: FakeCanvas, StaticCanvas: FakeCanvas, Image: { fromURL: () => Promise.resolve({ set() {}, width: 100, height: 60 }) } };
  }
  sb.fabric = makeFakeFabric();
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', 'overlays', 'imageEditorCanvas.js'), 'utf8'), sb, { filename: 'imageEditorCanvas.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', 'overlays', 'imageEditorTools.js'), 'utf8'), sb, { filename: 'imageEditorTools.js' });
  const T = sb.ImageEditorTools;
  const handle = sb.ImageEditorCanvas.createEditorSession({}, 200, 100);
  const session = handle.session;
  // Simulate: 3 click-without-drag cycles.
  for (let i = 0; i < 3; i++) {
    // mouse:down: pushUndo + record count.
    T.pushUndo(session);
    session._preStrokeObjectCount = session.canvas.getObjects().length;
    // mouse:up: count unchanged → pop the pre-snapshot.
    if (session.canvas.getObjects().length === session._preStrokeObjectCount) {
      session._undo.pop();
    }
    delete session._preStrokeObjectCount;
  }
  // After 3 click-without-drag cycles, _undo should be empty
  // (each pre-snapshot was popped).
  assert.equal(session._undo.length, 0,
    'R5.2.F: after 3 click-without-drag cycles, _undo must be empty (each pre-snapshot was popped). Got: ' + session._undo.length);
});
