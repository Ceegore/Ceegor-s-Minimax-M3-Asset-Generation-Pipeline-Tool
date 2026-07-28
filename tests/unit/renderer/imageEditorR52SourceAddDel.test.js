// tests/unit/renderer/imageEditorR52SourceAddDel.test.js
// ============================================================================
// R5.2 Source Add/Delete — second callsite card of the R5.2 series.
//
// Background: per design contract §Phase R5 / §R5.2, the snapshot
// system (R5.1) is in place. The next step is to wire the
// callsites so each user-action correctly pushes a
// pre-snapshot + commits + cancels.
//
// Pre-R5.2 bug: in imageEditorSource.js:
//   (a) `onAddSource` pushed the post-add snapshot AFTER
//       `s.canvas.add(fImg)`. So undo would pop the post-add
//       state and restore to it (no visible change). The user
//       had to undo TWICE to get back to before the add.
//   (b) The `del` button in refreshObjectsList pushed the
//       post-remove snapshot AFTER `canvas.remove(o)`. Same
//       bug: undo would restore to the post-remove state
//       (no change). User had to undo TWICE to get back.
//
// R5.2 fix: move the pushUndo to BEFORE the mutation in
// both callsites. Now:
//   (a) onAddSource: pushUndo BEFORE canvas.add(fImg) → undo
//       pops the pre-add state, restores the pre-add canvas
//       (the new image is gone).
//   (b) del: pushUndo BEFORE canvas.remove(o) → undo pops
//       the pre-remove state, restores the deleted object.
//
// Test discipline: structural source-grep test (the overlay
// requires full DOM mocks for a behavioral test, which is
// out of scope for R5.2 second card). The source-grep test
// catches the regression (pushUndo moved back to AFTER the
// mutation) by verifying the exact line patterns.
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

test('R5.2.Source.A: onAddSource pushes undo BEFORE canvas.add (PRE-snapshot)', () => {
  // R5.2 Source Add A: the pre-snapshot is captured BEFORE
  // canvas.add(fImg). Verify that the pushUndo call is
  // positioned before the canvas.add call in onAddSource.
  //
  // R5.2.AuditFix P-R52S-F1: scope to the onAddSource function
  // body only (not 3000 chars which would also include the del
  // button's slot.modified). The function ends at the closing
  // `}` followed by the next function declaration. Use a
  // look-ahead to stop at the next `function ...` so the
  // window is just the onAddSource function.
  const onAddMatch = sourceCode.match(/function onAddSource\(ctrl\)[\s\S]*?(?=function refreshObjectsList|function setupSourceThumbDropZone|$)/);
  assert.ok(onAddMatch, 'R5.2.Source.A: onAddSource function must exist in imageEditorSource.js');
  const block = onAddMatch[0];
  // The pushUndo call must come BEFORE canvas.add(fImg).
  const pushUndoIdx = block.indexOf('pushUndo');
  const canvasAddIdx = block.indexOf('s.canvas.add(fImg)');
  assert.ok(pushUndoIdx >= 0, 'R5.2.Source.A: onAddSource must call pushUndo');
  assert.ok(canvasAddIdx >= 0, 'R5.2.Source.A: onAddSource must call canvas.add(fImg)');
  assert.ok(pushUndoIdx < canvasAddIdx,
    'R5.2.Source.A: pushUndo must be BEFORE canvas.add(fImg) (pre-snapshot)');
  // R5.2.AuditFix P-R52-B1: exact call-signature check (catches typos like pushUndoWRONG).
  // We scope to `pushUndo(s)` (the onAddSource signature, not the
  // del button's `pushUndo(h.session)` which is in a different
  // function).
  assert.ok(/window\.ImageEditorTools\.pushUndo\s*\(\s*s\s*\)/.test(block),
    'R5.2.Source.A: onAddSource must call window.ImageEditorTools.pushUndo(s) EXACTLY (not a typo)');
  // R5.2.AuditFix P-R52-T01: try/catch wrapper check, scoped to
  // the pushUndo(s) call (not pushUndo(h.session) which is in
  // the del button handler — different function).
  assert.ok(/try\s*\{[^}]*window\.ImageEditorTools\.pushUndo\s*\(\s*s\s*\)[^}]*\}\s*catch/.test(block),
    'R5.2.Source.A: pushUndo(s) in onAddSource must be wrapped in try/catch (defensive)');
  // R5.2.AuditFix P-R52S-F1: post-actions present (slot.modified
  // + refreshQueueBar). Without these, the slot wouldn't be
  // marked dirty and the queue bar wouldn't update. Scoped to
  // the onAddSource function (the del button has its own
  // slot.modified that's NOT in scope due to the
  // look-ahead-stop-at-next-function).
  // PE-028: now uses the CAPTURED slot variable (slot.modified)
  // instead of activeSlot(ctrl).modified — the add started on
  // slot A must dirty slot A, not whichever slot is active now.
  assert.ok(/slot\.modified\s*=\s*true/.test(block),
    'R5.2.Source.A: onAddSource must set slot.modified = true (post-action, PE-028 captured slot)');
  assert.ok(/refreshQueueBar\(ctrl\)/.test(block),
    'R5.2.Source.A: onAddSource must call refreshQueueBar(ctrl) (post-action)');
  assert.ok(/refreshObjectsList\(ctrl\)/.test(block),
    'R5.2.Source.A: onAddSource must call refreshObjectsList(ctrl) (post-action)');
});

test('R5.2.Source.B: del button pushes undo BEFORE canvas.remove (PRE-snapshot)', () => {
  // R5.2 Source Delete B: the pre-snapshot is captured BEFORE
  // canvas.remove(o). Verify that the pushUndo call is
  // positioned before the canvas.remove call in the del
  // button's click handler.
  //
  // R5.2.AuditFix P-R52S-F3: use a start-marker `(e) =>` to
  // anchor the del click callback specifically. Pre-fix the
  // regex `/del\.addEventListener\('click'[\s\S]*?\}\);/`
  // matched the FIRST `});` after `del.addEventListener('click'`
  // which happens to be the del's own callback closer. But if
  // a future contributor added a nested function call with
  // `});` in between, the regex would match the wrong block.
  // With `(e) =>` as start-marker, we anchor on the click
  // callback specifically.
  const delMatch = sourceCode.match(/del\.addEventListener\('click', \(e\) => \{[\s\S]*?\}\);/);
  assert.ok(delMatch, 'R5.2.Source.B: del button click handler must exist in imageEditorSource.js');
  const block = delMatch[0];
  const pushUndoIdx = block.indexOf('pushUndo');
  const canvasRemoveIdx = block.indexOf('canvas.remove(o)');
  assert.ok(pushUndoIdx >= 0, 'R5.2.Source.B: del handler must call pushUndo');
  assert.ok(canvasRemoveIdx >= 0, 'R5.2.Source.B: del handler must call canvas.remove(o)');
  assert.ok(pushUndoIdx < canvasRemoveIdx,
    'R5.2.Source.B: pushUndo must be BEFORE canvas.remove(o) (pre-snapshot)');
  // R5.2.AuditFix P-R52S-F1 + P-R52-B1: try/catch wrapper check
  // scoped to `pushUndo(h.session)` (the del button's signature,
  // not onAddSource's `pushUndo(s)` which is in a different
  // function).
  assert.ok(/try\s*\{[^}]*window\.ImageEditorTools\.pushUndo\s*\(\s*h\.session\s*\)[^}]*\}\s*catch/.test(block),
    'R5.2.Source.B: pushUndo(h.session) in del must be wrapped in try/catch (defensive)');
  // R5.2.AuditFix P-R52S-F1: post-actions present (slot.modified
  // + refreshQueueBar). Without these, the slot wouldn't be
  // marked dirty and the queue bar wouldn't update.
  assert.ok(/activeSlot\(ctrl\)\.modified\s*=\s*true/.test(block),
    'R5.2.Source.B: del handler must set activeSlot(ctrl).modified = true (post-action)');
  assert.ok(/refreshQueueBar\(ctrl\)/.test(block),
    'R5.2.Source.B: del handler must call refreshQueueBar(ctrl) (post-action)');
  assert.ok(/refreshObjectsList\(ctrl\)/.test(block),
    'R5.2.Source.B: del handler must call refreshObjectsList(ctrl) (post-action)');
});

test('R5.2.Source.C: onAddSource doc-comment explains the pre-fix bug + the fix', () => {
  // R5.2 Source Add C: the onAddSource function has a
  // doc-comment explaining WHY the pushUndo is BEFORE
  // canvas.add (so a future contributor doesn't move it back).
  //
  // R5.2.AuditFix P-R52S-F2: capture a leading window of 800
  // chars BEFORE the function declaration. The function-level
  // doc-comment is typically placed just above the function
  // (not inside the body). With a leading window, the test
  // verifies the full doc-comment narrative (Pre-fix +
  // Post-R5.2 + PE-005). This prevents the false-positive
  // where the inline comment is kept but the function-level
  // doc-comment is removed.
  const onAddIdx = sourceSrc.indexOf('function onAddSource(ctrl)');
  assert.ok(onAddIdx >= 0, 'R5.2.Source.C: onAddSource function must exist in imageEditorSource.js');
  const start = Math.max(0, onAddIdx - 800);
  const block = sourceSrc.slice(start, onAddIdx + 3000);
  // Function-level doc-comment must mention BOTH "Pre-fix"
  // and "Post-R5.2" (the full Pre-fix/Post-fix narrative).
  // The inline comment doesn't have this — only the
  // function-level doc-comment does.
  assert.ok(/Pre-fix/.test(block),
    'R5.2.Source.C: onAddSource must have a function-level doc-comment mentioning "Pre-fix"');
  assert.ok(/Post-R5\.2/.test(block),
    'R5.2.Source.C: onAddSource must have a function-level doc-comment mentioning "Post-R5.2"');
  assert.ok(/PE-005/i.test(block),
    'R5.2.Source.C: onAddSource function-level doc-comment must mention PE-005');
});

test('R5.2.Source.D: del doc-comment explains the pre-fix bug + the fix', () => {
  // R5.2 Source Delete D: the del handler has a doc-comment
  // explaining WHY the pushUndo is BEFORE canvas.remove.
  //
  // R5.2.AuditFix P-R52S-F2 + P-R52S-F3: use the same
  // start-marker `(e) =>` as R5.2.Source.B. Additionally,
  // check for the function-level doc-comment specifically
  // (mentions "Pre-fix" + "Post-R5.2").
  const delMatch = sourceSrc.match(/del\.addEventListener\('click', \(e\) => \{[\s\S]*?\}\);/);
  assert.ok(delMatch, 'R5.2.Source.D: del button click handler must exist in imageEditorSource.js');
  const block = delMatch[0];
  assert.ok(/Pre-fix/.test(block),
    'R5.2.Source.D: del handler must have a doc-comment mentioning "Pre-fix"');
  assert.ok(/Post-R5\.2/.test(block),
    'R5.2.Source.D: del handler must have a doc-comment mentioning "Post-R5.2"');
  assert.ok(/PE-005/i.test(block),
    'R5.2.Source.D: del handler doc-comment must mention PE-005');
});

test('R5.2.Source.E: integration check — pre-snapshot + add + undo restores pre-add state', () => {
  // R5.2 Source Add E: verify the underlying pushUndo/undo
  // infrastructure works for the Add scenario. Pre-snapshot
  // is captured BEFORE canvas.add → undo restores the
  // pre-add state (the new image is gone).
  //
  // This is a regression test for R5.1 (the underlying
  // snapshot system) — not a behavioral test of the source
  // module (that would require full DOM mocks).
  const vm = require('vm');
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  // Reuse the FakeFabric pattern from R5.2.E.
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
  // Initial state: no objects.
  assert.equal(session.canvas.getObjects().length, 0, 'R5.2.Source.E: initial canvas is empty');
  // Simulate: onAddSource pre-snapshot + canvas.add.
  T.pushUndo(session);
  const sourceImage = { type: 'image', left: 100, top: 50, width: 100, height: 50, ieKind: 'source' };
  session.canvas.add(sourceImage);
  assert.equal(session.canvas.getObjects().length, 1, 'R5.2.Source.E: after add, canvas has 1 object');
  // Simulate: user undoes.
  return T.undo(session).then(() => {
    assert.equal(session.canvas.getObjects().length, 0, 'R5.2.Source.E: after undo, the source image is gone (pre-add state restored)');
    // Simulate: user redoes.
    return T.redo(session);
  }).then(() => {
    assert.equal(session.canvas.getObjects().length, 1, 'R5.2.Source.E: after redo, the source image is back');
  });
});

test('R5.2.Source.F: integration check — pre-snapshot + remove + undo restores pre-remove state', () => {
  // R5.2 Source Delete F: verify the underlying pushUndo/undo
  // infrastructure works for the Delete scenario. Pre-snapshot
  // is captured BEFORE canvas.remove → undo restores the
  // pre-remove state (the deleted object is back).
  const vm = require('vm');
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
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
  // Add 2 objects to start with.
  const objA = { type: 'image', left: 0, top: 0, width: 50, height: 50, ieKind: 'image' };
  const objB = { type: 'image', left: 100, top: 0, width: 50, height: 50, ieKind: 'image' };
  session.canvas.add(objA);
  session.canvas.add(objB);
  assert.equal(session.canvas.getObjects().length, 2, 'R5.2.Source.F: initial canvas has 2 objects');
  // Simulate: del button pre-snapshot + canvas.remove(objB).
  T.pushUndo(session);
  session.canvas.remove(objB);
  assert.equal(session.canvas.getObjects().length, 1, 'R5.2.Source.F: after remove, canvas has 1 object');
  // Simulate: user undoes.
  return T.undo(session).then(() => {
    assert.equal(session.canvas.getObjects().length, 2, 'R5.2.Source.F: after undo, the deleted object is back (pre-remove state restored)');
  });
});
