// tests/unit/renderer/imageEditorR52Bar.test.js
// ============================================================================
// R5.2 Bar — fifth callsite card of the R5.2 series.
//
// Background: per design contract §Phase R5 / §R5.2, the snapshot
// system (R5.1) is in place. The next step is to wire the
// callsites so each user-action correctly pushes a
// pre-snapshot + commits + cancels.
//
// Pre-R5.2 bug: in imageEditorShapes.js, the `onMouseDown`
// handler for the bar tool (Click 2: finalize) called
// `Tools.pushUndo(slot.session)` AFTER `canvas.add(rect)`.
// So undo would pop the post-add state and restore to it
// (no visible change). The user had to undo TWICE to get
// back to before the bar was added.
//
// R5.2 fix: move the pushUndo to BEFORE `canvas.add(rect)`.
// Now a single undo restores the pre-bar state (PE-005).
//
// Test discipline: structural source-grep test (the overlay
// requires full DOM mocks for a behavioral test).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SHAPES_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorShapes.js');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

const shapesSrc = fs.readFileSync(SHAPES_JS, 'utf8');
const shapesCode = stripComments(shapesSrc);

// Extract the onMouseDown function body. Use a non-greedy match
// to the next `function ` declaration (so we don't pull in
// onMouseMove, attachEndpointControls, etc.).
function extractOnMouseDown() {
  // PE-036: signature gained a `nativeEvent` param (button check).
  const re = /function onMouseDown\(ctrl, p, activeSlotFn, Tools(?:,\s*nativeEvent)?\) \{[\s\S]*?(?=function onMouseMove|function attachEndpointControls|function cancel)/;
  const m = shapesCode.match(re);
  return m ? m[0] : null;
}

// P-R52Bar-F1 (R5.2 Bar.AuditFix): extract ONLY the Click 2
// portion of onMouseDown (after the Click 1 early-return). This
// is the block where pushUndo must be placed — NOT in Click 1
// (where it would leave a useless pre-snapshot if the user
// cancels before Click 2). Use the structural marker
// `const a = st.pending; st.pending = null;` which only
// appears in Click 2 (Click 1 sets pending to a coord object,
// never null).
function extractClick2Block() {
  const full = extractOnMouseDown();
  if (!full) return null;
  const m = full.match(/const a = st\.pending;[\s\S]*$/);
  return m ? m[0] : null;
}

// P-R52Bar-F1 (R5.2 Bar.AuditFix): extract the Click 1 portion
// of onMouseDown (before the early-return). Used to assert that
// pushUndo is NOT in Click 1.
function extractClick1Block() {
  const full = extractOnMouseDown();
  if (!full) return null;
  // Click 1 ends at `const a = st.pending;` (which is the first
  // line of Click 2 in the production code).
  const idx = full.indexOf('const a = st.pending;');
  if (idx < 0) return null;
  return full.substring(0, idx);
}

test('R5.2.Bar.A: onMouseDown (Click 2) pushes undo BEFORE canvas.add(rect) (PRE-snapshot)', () => {
  // R5.2 Bar A: the pre-snapshot is captured BEFORE
  // canvas.add(rect) AND in the Click 2 branch (not Click 1).
  // Verify both: (a) pushUndo is in Click 2 only, (b) pushUndo
  // is positioned before canvas.add(rect).
  const click2 = extractClick2Block();
  assert.ok(click2, 'R5.2.Bar.A: Click 2 block must exist in imageEditorShapes.js');
  // The pushUndo call must come BEFORE canvas.add(rect) within Click 2.
  const pushUndoIdx = click2.indexOf('pushUndo');
  const canvasAddIdx = click2.indexOf('canvas.add(rect)');
  assert.ok(pushUndoIdx >= 0, 'R5.2.Bar.A: Click 2 must call pushUndo');
  assert.ok(canvasAddIdx >= 0, 'R5.2.Bar.A: Click 2 must call canvas.add(rect)');
  assert.ok(pushUndoIdx < canvasAddIdx,
    'R5.2.Bar.A: pushUndo must be BEFORE canvas.add(rect) (pre-snapshot)');
  // P-R52-B1: exact call-signature check (catches typos like pushUndoWRONG).
  // The R5.2 Bar uses `Tools.pushUndo` (not `window.ImageEditorTools.pushUndo`).
  assert.ok(/Tools\.pushUndo\s*\(\s*slot\.session\s*\)/.test(click2),
    'R5.2.Bar.A: Click 2 must call Tools.pushUndo(slot.session) EXACTLY (not a typo)');
  // P-R52-T01: try/catch wrapper check.
  assert.ok(/try\s*\{[^}]*Tools\.pushUndo[^}]*\}\s*catch/.test(click2),
    'R5.2.Bar.A: pushUndo must be wrapped in try/catch (defensive)');
  // P-R52Bar-F1 (R5.2 Bar.AuditFix): pushUndo must NOT be in Click 1.
  // If pushUndo is in Click 1, a user-cancel before Click 2 leaves
  // a useless pre-snapshot (the user has to undo twice to get back
  // to before Click 1).
  const click1Block = extractClick1Block();
  assert.ok(click1Block !== null, 'R5.2.Bar.A: Click 1 block must exist');
  // Note: Click 1's own canvas.add(st.preview) is OK (no pushUndo).
  // We only forbid pushUndo in Click 1.
  assert.ok(!/\bTools\.pushUndo\b/.test(click1Block),
    'R5.2.Bar.A: pushUndo must NOT be in Click 1 (would leave useless pre-snapshot on cancel)');
});

test('R5.2.Bar.B: onMouseDown (Click 2) post-actions present (slot.modified + refresh)', () => {
  // R5.2 Bar B: the commit (post-actions). After the bar is
  // added, the slot must be marked as modified + the UI must
  // be refreshed. R5.2 Bar.AuditFix P-R52Bar-F1: refreshQueueBar
  // is also required (not just refreshObjectsList).
  // R5.2 Bar.AuditFix P-R52Bar-F3: the post-action block must
  // be guarded by `if (window.ImageEditorSource)` (defensive
  // null-guard per R5.5.AuditFix pattern).
  const click2 = extractClick2Block();
  assert.ok(click2, 'R5.2.Bar.B: Click 2 block must exist in imageEditorShapes.js');
  // The pushUndo must come BEFORE slot.modified = true + refresh.
  const pushUndoIdx = click2.indexOf('pushUndo');
  const slotModifiedIdx = click2.indexOf('slot.modified = true');
  assert.ok(pushUndoIdx >= 0, 'R5.2.Bar.B: Click 2 must call pushUndo');
  assert.ok(slotModifiedIdx >= 0, 'R5.2.Bar.B: Click 2 must set slot.modified = true');
  assert.ok(pushUndoIdx < slotModifiedIdx,
    'R5.2.Bar.B: pushUndo must be BEFORE slot.modified = true (pre-snapshot before commit)');
  // R5.2 Bar.AuditFix P-R52Bar-F1: refreshQueueBar must be called
  // (not just refreshObjectsList).
  assert.ok(/refreshQueueBar/.test(click2),
    'R5.2.Bar.B: Click 2 must call refreshQueueBar (post-action for queue bar modified badge)');
  assert.ok(/refreshObjectsList/.test(click2),
    'R5.2.Bar.B: Click 2 must call refreshObjectsList (post-action)');
  // R5.2 Bar.AuditFix P-R52Bar-F3: defensive null-guard for renderers.
  // The post-action block must be guarded by `if (window.ImageEditorSource)`
  // to handle the case where imageEditorSource.js is not yet loaded
  // (e.g. during teardown or in unit tests).
  assert.ok(/if\s*\(\s*window\.ImageEditorSource\s*\)/.test(click2),
    'R5.2.Bar.B: post-actions must be guarded by `if (window.ImageEditorSource)` (defensive null-guard)');
});

test('R5.2.Bar.C: onMouseDown doc-comment explains the pre-fix bug + the fix', () => {
  // R5.2 Bar C: the onMouseDown function has a doc-comment
  // explaining WHY the pushUndo is BEFORE canvas.add(rect)
  // (so a future contributor doesn't move it back).
  // R5.2 Bar.AuditFix P-R52Bar-F2 (P-R52S-F2 pattern): the
  // doc-comment must include the SPECIFIC strings `Pre-fix`,
  // `Post-R5.2`, and `PE-005` — not just any R5.2 mention
  // (which could match the test file's own header). Use a
  // LEADING window from the `// R5.2 Bar:` marker to avoid
  // matching doc-comments in unrelated parts of the file.
  const re = /function onMouseDown\(ctrl, p, activeSlotFn, Tools(?:,\s*nativeEvent)?\) \{[\s\S]*?(?=function onMouseMove|function attachEndpointControls|function cancel)/;
  const block = shapesSrc.match(re);
  assert.ok(block, 'R5.2.Bar.C: onMouseDown function must exist in imageEditorShapes.js');
  // P-R52Bar-F2: extract the function-level doc-comment for the
  // R5.2 Bar fix. The comment is `// R5.2 Bar: PRE-SNAPSHOT ...`
  // through the next code line.
  const docRe = /\/\/ R5\.2 Bar:[^\n]*\n(?:\s*\/\/[^\n]*\n)+/;
  const docMatch = block[0].match(docRe);
  assert.ok(docMatch, 'R5.2.Bar.C: onMouseDown must have a function-level `// R5.2 Bar:` doc-comment');
  const doc = docMatch[0];
  // Specific strings (P-R52S-F2 pattern):
  assert.ok(/Pre-fix/.test(doc),
    'R5.2.Bar.C: doc-comment must mention "Pre-fix" (specific — not just any R5.2 mention)');
  assert.ok(/Post-R5\.2/.test(doc),
    'R5.2.Bar.C: doc-comment must mention "Post-R5.2" (specific — not just any R5.2 mention)');
  assert.ok(/PE-005/.test(doc),
    'R5.2.Bar.C: doc-comment must mention "PE-005" (specific — not just any R5.2 mention)');
  // Keep the original broader check for regression safety:
  assert.ok(/PRE-SNAPSHOT|pre-snapshot/i.test(doc),
    'R5.2.Bar.C: doc-comment must explain the pre-snapshot purpose');
});

test('R5.2.Bar.E: onMouseDown (Click 2) does NOT duplicate canvas.add(rect) calls', () => {
  // R5.2 Bar E (P-R52Bar-F5): ensure the Click 2 block has
  // exactly ONE `canvas.add(rect)` call. A double-add would
  // place the rect twice (visual duplicate + state corruption).
  // The integration test only adds once, so it wouldn't catch
  // a regression that adds twice in the production code.
  const click2 = extractClick2Block();
  assert.ok(click2, 'R5.2.Bar.E: Click 2 block must exist');
  // Match `canvas.add(rect)` — count occurrences.
  const matches = click2.match(/canvas\.add\(rect\)/g) || [];
  assert.equal(matches.length, 1,
    'R5.2.Bar.E: Click 2 must call canvas.add(rect) EXACTLY ONCE (not 0, not 2+)');
});

test('R5.2.Bar.D: integration check — pre-snapshot + bar add + undo restores pre-bar state', () => {
  // R5.2 Bar D: verify the underlying pushUndo/undo
  // infrastructure works for the Bar scenario. Pre-snapshot
  // is captured BEFORE the bar is added. Undo restores the
  // pre-bar state (the bar is gone).
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
    FakeCanvas.prototype.remove = function (o) { return this._state.remove(o); };
    FakeCanvas.prototype.sendObjectToBack = function (o) { return this._state.sendObjectToBack(o); };
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
  assert.equal(session.canvas.getObjects().length, 0, 'R5.2.Bar.D: initial canvas is empty');
  // Simulate: pre-snapshot BEFORE canvas.add(rect).
  T.pushUndo(session);
  // Add a bar (simulating Click 2 finalize).
  const bar = { type: 'rect', left: 100, top: 50, width: 80, height: 2, ieKind: 'bar' };
  session.canvas.add(bar);
  assert.equal(session.canvas.getObjects().length, 1, 'R5.2.Bar.D: after add, canvas has 1 bar');
  // Simulate: user undoes.
  return T.undo(session).then(() => {
    const objs = session.canvas.getObjects();
    assert.equal(objs.length, 0, 'R5.2.Bar.D: after undo, the bar is gone (pre-bar state restored)');
  });
});
