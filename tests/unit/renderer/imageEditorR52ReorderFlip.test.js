// tests/unit/renderer/imageEditorR52ReorderFlip.test.js
// ============================================================================
// R5.2 Reorder/Flip — fourth callsite card of the R5.2 series.
//
// Background: per design contract §Phase R5 / §R5.2, the snapshot
// system (R5.1) is in place. The next step is to wire the
// callsites so each user-action correctly pushes a
// pre-snapshot + commits + cancels.
//
// Pre-R5.2 bug: in imageEditorSource.js, the fwd/bwd/flipH/flipV
// buttons in refreshObjectsList did NOT call pushUndo at all.
// So when the user clicked "bring forward" / "send backward" /
// "flip horizontal" / "flip vertical", the canvas state was
// mutated but the undo stack was not. The user could not undo
// these operations.
//
// R5.2 fix: add pre-snapshot to all 4 buttons. Same pattern
// as R5.2 Source Add/Delete (pre-snapshot before mutation,
// no cancel for atomic actions).
//
// Test discipline: structural source-grep test (the overlay
// requires full DOM mocks for a behavioral test). The
// source-grep test catches the regression by verifying the
// exact line patterns.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SOURCE_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorSource.js');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

const sourceSrc = fs.readFileSync(SOURCE_JS, 'utf8');
const sourceCode = stripComments(sourceSrc);

// Helper: extract a specific click handler block.
// Each handler is: name.addEventListener('click', (e) => { ... });
function extractClickHandler(name) {
  // Use a non-greedy match that ends at the FIRST `});` after the start.
  // This works because the handler body doesn't contain nested `});`
  // (the body is just sequential statements).
  const re = new RegExp(name + "\\.addEventListener\\('click', \\(e\\) => \\{[^]*?\\}\\);");
  const m = sourceCode.match(re);
  return m ? m[0] : null;
}

test('R5.2.RF.A: fwd (bring forward) pushes undo BEFORE bringObjectForward (PRE-snapshot)', () => {
  const block = extractClickHandler('fwd');
  assert.ok(block, 'R5.2.RF.A: fwd click handler must exist in imageEditorSource.js');
  // R5.2 Reorder: pre-snapshot before bringObjectForward.
  const pushUndoIdx = block.indexOf('pushUndo');
  const bringFwdIdx = block.indexOf('bringObjectForward');
  assert.ok(pushUndoIdx >= 0, 'R5.2.RF.A: fwd handler must call pushUndo');
  assert.ok(bringFwdIdx >= 0, 'R5.2.RF.A: fwd handler must call bringObjectForward');
  assert.ok(pushUndoIdx < bringFwdIdx,
    'R5.2.RF.A: pushUndo must be BEFORE bringObjectForward (pre-snapshot)');
  // P-R52-B1: exact call-signature check (catches typos like pushUndoWRONG).
  assert.ok(/window\.ImageEditorTools\.pushUndo\s*\(\s*h\.session\s*\)/.test(block),
    'R5.2.RF.A: fwd handler must call window.ImageEditorTools.pushUndo(h.session) EXACTLY (not a typo)');
  // P-R52-T01: try/catch wrapper check.
  assert.ok(/try\s*\{[^}]*window\.ImageEditorTools\.pushUndo[^}]*\}\s*catch/.test(block),
    'R5.2.RF.A: pushUndo must be wrapped in try/catch (defensive)');
  // R5.2.AuditFix P-R52RF-F1: post-actions present (slot.modified
  // + refreshObjectsList + refreshQueueBar). Without these, the
  // slot is not marked as dirty and the UI is not refreshed.
  assert.ok(/activeSlot\(ctrl\)\.modified\s*=\s*true/.test(block),
    'R5.2.RF.A: fwd handler must set activeSlot(ctrl).modified = true (post-action)');
  assert.ok(/refreshObjectsList\(ctrl\)/.test(block),
    'R5.2.RF.A: fwd handler must call refreshObjectsList(ctrl) (post-action)');
  assert.ok(/refreshQueueBar\(ctrl\)/.test(block),
    'R5.2.RF.A: fwd handler must call refreshQueueBar(ctrl) (post-action)');
});

test('R5.2.RF.B: bwd (send backward) pushes undo BEFORE sendObjectBackwards (PRE-snapshot)', () => {
  const block = extractClickHandler('bwd');
  assert.ok(block, 'R5.2.RF.B: bwd click handler must exist in imageEditorSource.js');
  const pushUndoIdx = block.indexOf('pushUndo');
  const sendBwdIdx = block.indexOf('sendObjectBackwards');
  assert.ok(pushUndoIdx >= 0, 'R5.2.RF.B: bwd handler must call pushUndo');
  assert.ok(sendBwdIdx >= 0, 'R5.2.RF.B: bwd handler must call sendObjectBackwards');
  assert.ok(pushUndoIdx < sendBwdIdx,
    'R5.2.RF.B: pushUndo must be BEFORE sendObjectBackwards (pre-snapshot)');
  // P-R52-B1: exact call-signature.
  assert.ok(/window\.ImageEditorTools\.pushUndo\s*\(\s*h\.session\s*\)/.test(block),
    'R5.2.RF.B: bwd handler must call window.ImageEditorTools.pushUndo(h.session) EXACTLY');
  // P-R52-T01: try/catch wrapper.
  assert.ok(/try\s*\{[^}]*window\.ImageEditorTools\.pushUndo[^}]*\}\s*catch/.test(block),
    'R5.2.RF.B: pushUndo must be wrapped in try/catch (defensive)');
  // R5.2.AuditFix P-R52RF-F1: post-actions present.
  assert.ok(/activeSlot\(ctrl\)\.modified\s*=\s*true/.test(block),
    'R5.2.RF.B: bwd handler must set activeSlot(ctrl).modified = true (post-action)');
  assert.ok(/refreshObjectsList\(ctrl\)/.test(block),
    'R5.2.RF.B: bwd handler must call refreshObjectsList(ctrl) (post-action)');
  assert.ok(/refreshQueueBar\(ctrl\)/.test(block),
    'R5.2.RF.B: bwd handler must call refreshQueueBar(ctrl) (post-action)');
});

test('R5.2.RF.C: flipH (flip horizontal) pushes undo BEFORE flipX toggle (PRE-snapshot)', () => {
  const block = extractClickHandler('flipH');
  assert.ok(block, 'R5.2.RF.C: flipH click handler must exist in imageEditorSource.js');
  const pushUndoIdx = block.indexOf('pushUndo');
  const flipXIdx = block.indexOf("'flipX'");
  assert.ok(pushUndoIdx >= 0, 'R5.2.RF.C: flipH handler must call pushUndo');
  assert.ok(flipXIdx >= 0, 'R5.2.RF.C: flipH handler must reference flipX');
  assert.ok(pushUndoIdx < flipXIdx,
    'R5.2.RF.C: pushUndo must be BEFORE flipX toggle (pre-snapshot)');
  assert.ok(/window\.ImageEditorTools\.pushUndo\s*\(\s*h\.session\s*\)/.test(block),
    'R5.2.RF.C: flipH handler must call window.ImageEditorTools.pushUndo(h.session) EXACTLY');
  assert.ok(/try\s*\{[^}]*window\.ImageEditorTools\.pushUndo[^}]*\}\s*catch/.test(block),
    'R5.2.RF.C: pushUndo must be wrapped in try/catch (defensive)');
  // R5.2.AuditFix P-R52RF-F1: post-actions present.
  assert.ok(/activeSlot\(ctrl\)\.modified\s*=\s*true/.test(block),
    'R5.2.RF.C: flipH handler must set activeSlot(ctrl).modified = true (post-action)');
  assert.ok(/refreshObjectsList\(ctrl\)/.test(block),
    'R5.2.RF.C: flipH handler must call refreshObjectsList(ctrl) (post-action)');
  assert.ok(/refreshQueueBar\(ctrl\)/.test(block),
    'R5.2.RF.C: flipH handler must call refreshQueueBar(ctrl) (post-action)');
});

test('R5.2.RF.D: flipV (flip vertical) pushes undo BEFORE flipY toggle (PRE-snapshot)', () => {
  const block = extractClickHandler('flipV');
  assert.ok(block, 'R5.2.RF.D: flipV click handler must exist in imageEditorSource.js');
  const pushUndoIdx = block.indexOf('pushUndo');
  const flipYIdx = block.indexOf("'flipY'");
  assert.ok(pushUndoIdx >= 0, 'R5.2.RF.D: flipV handler must call pushUndo');
  assert.ok(flipYIdx >= 0, 'R5.2.RF.D: flipV handler must reference flipY');
  assert.ok(pushUndoIdx < flipYIdx,
    'R5.2.RF.D: pushUndo must be BEFORE flipY toggle (pre-snapshot)');
  assert.ok(/window\.ImageEditorTools\.pushUndo\s*\(\s*h\.session\s*\)/.test(block),
    'R5.2.RF.D: flipV handler must call window.ImageEditorTools.pushUndo(h.session) EXACTLY');
  assert.ok(/try\s*\{[^}]*window\.ImageEditorTools\.pushUndo[^}]*\}\s*catch/.test(block),
    'R5.2.RF.D: pushUndo must be wrapped in try/catch (defensive)');
  // R5.2.AuditFix P-R52RF-F1: post-actions present.
  assert.ok(/activeSlot\(ctrl\)\.modified\s*=\s*true/.test(block),
    'R5.2.RF.D: flipV handler must set activeSlot(ctrl).modified = true (post-action)');
  assert.ok(/refreshObjectsList\(ctrl\)/.test(block),
    'R5.2.RF.D: flipV handler must call refreshObjectsList(ctrl) (post-action)');
  assert.ok(/refreshQueueBar\(ctrl\)/.test(block),
    'R5.2.RF.D: flipV handler must call refreshQueueBar(ctrl) (post-action)');
});

test('R5.2.RF.E: fwd doc-comment explains the pre-fix bug + the fix', () => {
  // R5.2 Reorder/Flip E: the fwd handler has a doc-comment
  // explaining WHY the pushUndo is BEFORE bringObjectForward
  // (so a future contributor doesn't move it back).
  const re = new RegExp("fwd\\.addEventListener\\('click', \\(e\\) => \\{[\\s\\S]*?\\}\\);");
  const block = sourceSrc.match(re);
  assert.ok(block, 'R5.2.RF.E: fwd click handler must exist');
  assert.ok(/R5\.2/.test(block[0]),
    'R5.2.RF.E: fwd handler must have a R5.2 doc-comment');
  assert.ok(/PRE-SNAPSHOT|pre-snapshot|PE-005/i.test(block[0]),
    'R5.2.RF.E: fwd handler doc-comment must explain the pre-snapshot purpose + PE-005');
});

test('R5.2.RF.F: flipH doc-comment explains the pre-fix bug + the fix', () => {
  const re = new RegExp("flipH\\.addEventListener\\('click', \\(e\\) => \\{[\\s\\S]*?\\}\\);");
  const block = sourceSrc.match(re);
  assert.ok(block, 'R5.2.RF.F: flipH click handler must exist');
  assert.ok(/R5\.2/.test(block[0]),
    'R5.2.RF.F: flipH handler must have a R5.2 doc-comment');
  assert.ok(/PRE-SNAPSHOT|pre-snapshot|PE-005/i.test(block[0]),
    'R5.2.RF.F: flipH handler doc-comment must explain the pre-snapshot purpose + PE-005');
});

test('R5.2.RF.F2: bwd doc-comment explains the pre-fix bug + the fix (R5.2.AuditFix consistency)', () => {
  // R5.2.AuditFix P-R52RF-F2: bwd has the same R5.2 doc-comment
  // pattern as fwd. Test it for consistency.
  const re = new RegExp("bwd\\.addEventListener\\('click', \\(e\\) => \\{[\\s\\S]*?\\}\\);");
  const block = sourceSrc.match(re);
  assert.ok(block, 'R5.2.RF.F2: bwd click handler must exist');
  assert.ok(/R5\.2/.test(block[0]),
    'R5.2.RF.F2: bwd handler must have a R5.2 doc-comment');
  assert.ok(/PRE-SNAPSHOT|pre-snapshot|PE-005/i.test(block[0]),
    'R5.2.RF.F2: bwd handler doc-comment must explain the pre-snapshot purpose + PE-005');
});

test('R5.2.RF.F3: flipV doc-comment explains the pre-fix bug + the fix (R5.2.AuditFix consistency)', () => {
  // R5.2.AuditFix P-R52RF-F2: flipV has the same R5.2 doc-comment
  // pattern as flipH. Test it for consistency.
  const re = new RegExp("flipV\\.addEventListener\\('click', \\(e\\) => \\{[\\s\\S]*?\\}\\);");
  const block = sourceSrc.match(re);
  assert.ok(block, 'R5.2.RF.F3: flipV click handler must exist');
  assert.ok(/R5\.2/.test(block[0]),
    'R5.2.RF.F3: flipV handler must have a R5.2 doc-comment');
  assert.ok(/PRE-SNAPSHOT|pre-snapshot|PE-005/i.test(block[0]),
    'R5.2.RF.F3: flipV handler doc-comment must explain the pre-snapshot purpose + PE-005');
});

test('R5.2.RF.G: integration check — pre-snapshot + flip + undo restores pre-flip state', () => {
  // R5.2 Reorder/Flip G: verify the underlying pushUndo/undo
  // infrastructure works for the Flip scenario. Pre-snapshot
  // is captured BEFORE the flipX toggle. Undo restores the
  // pre-flip state (flipX is back to false).
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
  // Add an object with flipX=false.
  const obj = { type: 'image', left: 0, top: 0, flipX: false, flipY: false, ieKind: 'image' };
  session.canvas.add(obj);
  assert.equal(obj.flipX, false, 'R5.2.RF.G: initial flipX = false');
  // Simulate: flipH click → pushUndo (pre-snapshot) + flipX toggle.
  // Plain objects don't have .set() so toggle the property directly
  // (the production code uses o.set('flipX', ...) which is equivalent
  // for Fabric's set semantics on the flipX property).
  T.pushUndo(session);
  obj.flipX = !obj.flipX;
  assert.equal(obj.flipX, true, 'R5.2.RF.G: after flip, flipX = true');
  // Simulate: user undoes.
  return T.undo(session).then(() => {
    // The canvas is restored from the pre-snapshot. The obj
    // object reference is now the new object (loadFromJSON
    // replaced it). Find it in the canvas.
    const objs = session.canvas.getObjects();
    assert.equal(objs.length, 1, 'R5.2.RF.G: after undo, canvas has 1 object (the restored one)');
    const restored = objs[0];
    assert.equal(restored.flipX, false, 'R5.2.RF.G: after undo, flipX is restored to false (pre-flip state)');
    assert.equal(restored.flipY, false, 'R5.2.RF.G: after undo, flipY is still false (unchanged)');
  });
});
