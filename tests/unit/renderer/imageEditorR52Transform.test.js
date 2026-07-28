// tests/unit/renderer/imageEditorR52Transform.test.js
// ============================================================================
// R5.2 Transform — third callsite card of the R5.2 series.
//
// Background: per design contract §Phase R5 / §R5.2, the snapshot
// system (R5.1) is in place. The next step is to wire the
// callsites so each user-action correctly pushes a
// pre-snapshot + commits + cancels.
//
// Pre-R5.2 bug: in imageEditorOverlay.js, the `object:modified`
// handler did NOT call `Tools.pushUndo(session)`. So when a
// user moved/scaled/rotated an object via the Fabric
// transform handles, the canvas state was mutated but the
// undo stack was not. The user could not undo the transform.
// (The handler only set `slot.modified = true` + refreshed
// the UI.)
//
// R5.2 fix: implement pre-snapshot + commit + cancel:
//   - mousedown (with active object) → pushUndo (pre-snapshot)
//   - object:modified → commit (no push; pre-snapshot is kept)
//   - mouseup (without object:modified in between) → cancel
//     (pop the pre-snapshot; the click was a select/deselect
//     not a transform)
// Same pattern as R5.2 Stroke (pre-snapshot on action-start,
// cancel on action-end if no actual action).
//
// Test discipline: structural source-grep test (the overlay
// requires full DOM mocks for a behavioral test, which is
// out of scope for R5.2 third card). The source-grep test
// catches the regression by verifying the exact line
// patterns. Plus 1 integration test that exercises the
// underlying R5.1 pushUndo/undo infrastructure.
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

test('R5.2.Transform.A: mousedown handler pushes undo when active object (PRE-snapshot)', () => {
  // R5.2 Transform A: the pre-snapshot is captured on
  // mousedown (not on object:modified). Verify that the
  // mousedown handler has a pushUndo call wrapped in an
  // active-object check.
  //
  // R5.2.AuditFix P-R52S-F2 (analog): there are 2 mousedown
  // handlers in imageEditorOverlay.js (the original one for
  // pipette/heal/select/bar, and the R5.2 one for transform).
  // We need to match the R5.2 one specifically (the one with
  // pushUndo + getActiveObject + _preTransformObject).
  const allMousedownBlocks = overlayCode.match(/trackOn\('mouse:down', \(opt\) => \{[\s\S]*?\}\);/g);
  assert.ok(allMousedownBlocks && allMousedownBlocks.length >= 2,
    'R5.2.Transform.A: expected at least 2 mousedown handlers in imageEditorOverlay.js (original + R5.2)');
  // Find the R5.2 one (the one with getActiveObject + pushUndo).
  const r52Block = allMousedownBlocks.find((b) => /getActiveObject/.test(b) && /pushUndo/.test(b));
  assert.ok(r52Block, 'R5.2.Transform.A: R5.2 mousedown handler must have getActiveObject + pushUndo');
  const block = r52Block;
  // The block must check for active object and call pushUndo.
  assert.ok(/getActiveObject/.test(block),
    'R5.2.Transform.A: mousedown handler must check getActiveObject');
  assert.ok(/pushUndo/.test(block),
    'R5.2.Transform.A: mousedown handler must call pushUndo (the pre-snapshot)');
  // P-R52-B1: exact call-signature check.
  assert.ok(/Tools\.pushUndo\s*\(\s*session\s*\)/.test(block),
    'R5.2.Transform.A: mousedown handler must call Tools.pushUndo(session) EXACTLY (not a typo)');
  // P-R52-T01: try/catch wrapper check.
  assert.ok(/try\s*\{[^}]*Tools\.pushUndo[^}]*\}\s*catch/.test(block),
    'R5.2.Transform.A: Tools.pushUndo must be wrapped in try/catch (defensive)');
  // The block must also set _preTransformObject (the cancel marker).
  assert.ok(/_preTransformObject\s*=/.test(block),
    'R5.2.Transform.A: mousedown handler must set _preTransformObject (cancel marker for the mouseup handler)');
});

test('R5.2.Transform.B: mouseup handler pops the pre-snapshot if no object:modified (CANCEL)', () => {
  // R5.2 Transform B: the cancel-cleanup. If no
  // object:modified fired between mousedown and mouseup, the
  // click was a select/deselect (not a transform). Pop the
  // pre-snapshot to avoid polluting the undo stack.
  //
  // R5.2.AuditFix P-R52S-F2 (analog): there are 2 mouseup
  // handlers in imageEditorOverlay.js. We need to match the
  // R5.2 one (the one with _preTransformObject + _undo.pop).
  const allMouseupBlocks = overlayCode.match(/trackOn\('mouse:up'[\s\S]*?\}\);/g);
  assert.ok(allMouseupBlocks && allMouseupBlocks.length >= 1,
    'R5.2.Transform.B: expected at least 1 mouseup handler in imageEditorOverlay.js');
  // Find the R5.2 one (the one with _preTransformObject).
  const r52Block = allMouseupBlocks.find((b) => /_preTransformObject/.test(b));
  assert.ok(r52Block, 'R5.2.Transform.B: R5.2 mouseup handler must have _preTransformObject');
  const block = r52Block;
  // The block must check for _preTransformObject and pop.
  assert.ok(/_preTransformObject/.test(block),
    'R5.2.Transform.B: mouseup handler must check _preTransformObject (cancel marker)');
  assert.ok(/_undo\.pop\(\)/.test(block),
    'R5.2.Transform.B: mouseup handler must pop the pre-snapshot (cancel cleanup)');
  // P-R52-T01: try/catch around _undo.pop (defensive — a malformed
  // session might not have _undo, or the pop could fail).
  assert.ok(/try\s*\{[^}]*_undo\.pop[^}]*\}\s*catch/.test(block),
    'R5.2.Transform.B: _undo.pop must be wrapped in try/catch (defensive)');
  // The block must NOT call pushUndo (cancel only pops).
  assert.ok(!/Tools\.pushUndo\s*\(/.test(block),
    'R5.2.Transform.B: mouseup handler must NOT call pushUndo (only the cancel pop)');
  // The block must clear _preTransformObject after the pop.
  assert.ok(/_preTransformObject\s*=\s*null/.test(block),
    'R5.2.Transform.B: mouseup handler must clear _preTransformObject after the pop');
});

test('R5.2.Transform.C: object:modified handler clears the pre-snapshot flag (COMMIT)', () => {
  // R5.2 Transform C: the commit. When the user releases
  // after a transform, object:modified fires. The handler
  // clears the _preTransformObject flag (the pre-snapshot
  // is kept in the undo stack) + sets slot.modified + refreshes
  // the UI.
  const modifiedBlock = overlayCode.match(/trackOn\('object:modified'[\s\S]*?\}\);/);
  assert.ok(modifiedBlock, 'R5.2.Transform.C: session.canvas.on(object:modified) handler must exist in imageEditorOverlay.js');
  const block = modifiedBlock[0];
  // The block must clear _preTransformObject.
  assert.ok(/_preTransformObject\s*=\s*null/.test(block),
    'R5.2.Transform.C: object:modified handler must clear _preTransformObject (commit)');
  // The block must NOT call pushUndo (the pre-snapshot is already in the stack).
  assert.ok(!/Tools\.pushUndo\s*\(/.test(block),
    'R5.2.Transform.C: object:modified handler must NOT call pushUndo (pre-snapshot already captured on mousedown)');
  // The block must set slot.modified = true + refresh.
  assert.ok(/slot\.modified\s*=\s*true/.test(block),
    'R5.2.Transform.C: object:modified handler must set slot.modified = true');
  assert.ok(/refreshObjectsList/.test(block),
    'R5.2.Transform.C: object:modified handler must call refreshObjectsList');
  assert.ok(/refreshQueueBar/.test(block),
    'R5.2.Transform.C: object:modified handler must call refreshQueueBar');
});

test('R5.2.Transform.D: mousedown handler doc-comment explains the pre-snapshot purpose', () => {
  // R5.2 Transform D: the mousedown handler has a doc-comment
  // explaining the pre-snapshot pattern. The doc-comment
  // must mention R5.2 + pre-snapshot + PE-005.
  //
  // R5.2.AuditFix P-R52S-F2 (analog): there are 2 mousedown
  // handlers. The R5.2 one has a R5.2 doc-comment. The
  // original one doesn't.
  const allMousedownBlocks = overlaySrc.match(/trackOn\('mouse:down', \(opt\) => \{[\s\S]*?\}\);/g);
  assert.ok(allMousedownBlocks && allMousedownBlocks.length >= 2,
    'R5.2.Transform.D: expected at least 2 mousedown handlers in imageEditorOverlay.js');
  const r52Block = allMousedownBlocks.find((b) => /R5\.2 Transform/.test(b) && /_preTransformObject/.test(b));
  assert.ok(r52Block, 'R5.2.Transform.D: R5.2 mousedown handler must have R5.2 doc-comment + _preTransformObject');
  assert.ok(/R5\.2/.test(r52Block),
    'R5.2.Transform.D: mousedown handler must have a R5.2 doc-comment');
  assert.ok(/PRE-SNAPSHOT|pre-snapshot|PE-005/i.test(r52Block),
    'R5.2.Transform.D: mousedown handler doc-comment must explain the pre-snapshot purpose + PE-005');
});

test('R5.2.Transform.E: mouseup handler doc-comment explains the cancel-cleanup purpose', () => {
  // R5.2 Transform E: the mouseup handler has a doc-comment
  // explaining the cancel-cleanup pattern.
  const allMouseupBlocks = overlaySrc.match(/trackOn\('mouse:up'[\s\S]*?\}\);/g);
  assert.ok(allMouseupBlocks, 'R5.2.Transform.E: mouseup handler must exist');
  const r52Block = allMouseupBlocks.find((b) => /R5\.2 Transform/.test(b) && /_preTransformObject/.test(b));
  assert.ok(r52Block, 'R5.2.Transform.E: R5.2 mouseup handler must have R5.2 doc-comment + _preTransformObject');
  assert.ok(/R5\.2/.test(r52Block),
    'R5.2.Transform.E: mouseup handler must have a R5.2 doc-comment');
  assert.ok(/cancel|CANCEL/i.test(r52Block),
    'R5.2.Transform.E: mouseup handler doc-comment must explain the cancel-cleanup');
});

test('R5.2.Transform.F: object:modified handler doc-comment explains the commit purpose', () => {
  // R5.2 Transform F: the object:modified handler has a
  // doc-comment explaining the commit (no push, just clear
  // the pre-snapshot flag + update UI).
  const modifiedBlock = overlaySrc.match(/trackOn\('object:modified'[\s\S]*?\}\);/);
  assert.ok(modifiedBlock, 'R5.2.Transform.F: session.canvas.on(object:modified) handler must exist');
  const block = modifiedBlock[0];
  assert.ok(/R5\.2/.test(block),
    'R5.2.Transform.F: object:modified handler must have a R5.2 doc-comment');
  assert.ok(/commit|COMMIT|pre-snapshot is committed/i.test(block),
    'R5.2.Transform.F: object:modified handler doc-comment must explain the commit');
});

test('R5.2.Transform.G: integration check — pre-snapshot + transform + undo restores pre-transform state', () => {
  // R5.2 Transform G: verify the underlying pushUndo/undo
  // infrastructure works for the Transform scenario.
  // Pre-snapshot is captured BEFORE the object is transformed.
  // Undo restores the pre-transform state (object at original
  // position).
  //
  // This is a regression test for R5.1 (the underlying
  // snapshot system) — not a behavioral test of the overlay
  // handler (that would require full DOM mocks).
  const vm = require('vm');
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  // Reuse the FakeFabric pattern.
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
    FakeCanvas.prototype.setWidth = FakeCanvas.prototype.setHeight = function () {};
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
  // Add an object to transform.
  const obj = { type: 'image', left: 50, top: 50, scaleX: 1, scaleY: 1, angle: 0, ieKind: 'image' };
  session.canvas.add(obj);
  assert.equal(obj.left, 50, 'R5.2.Transform.G: initial left = 50');
  // Simulate: mousedown (with active object) → pushUndo (pre-snapshot).
  T.pushUndo(session);
  assert.equal(T.canUndo(session), true, 'R5.2.Transform.G: after mousedown pushUndo, canUndo must be true');
  // Simulate: user transforms the object.
  obj.left = 100;
  obj.top = 80;
  obj.scaleX = 2;
  obj.angle = 45;
  // Simulate: object:modified → commit (no push, just clear).
  assert.equal(session._undo.length, 1, 'R5.2.Transform.G: after transform, _undo has 1 entry (pre-snapshot)');
  // Simulate: user undoes.
  return T.undo(session).then(() => {
    // The canvas is restored from the pre-snapshot. The obj
    // object reference is now the new object (loadFromJSON
    // replaced it). Find it in the canvas.
    const objs = session.canvas.getObjects();
    assert.equal(objs.length, 1, 'R5.2.Transform.G: after undo, canvas has 1 object (the restored one)');
    const restored = objs[0];
    assert.equal(restored.left, 50, 'R5.2.Transform.G: after undo, left is restored to 50 (pre-transform state)');
    assert.equal(restored.top, 50, 'R5.2.Transform.G: after undo, top is restored to 50 (pre-transform state)');
    assert.equal(restored.scaleX, 1, 'R5.2.Transform.G: after undo, scaleX is restored to 1 (pre-transform state)');
    assert.equal(restored.angle, 0, 'R5.2.Transform.G: after undo, angle is restored to 0 (pre-transform state)');
  });
});
