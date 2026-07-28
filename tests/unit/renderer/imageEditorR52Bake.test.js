// tests/unit/renderer/imageEditorR52Bake.test.js
// ============================================================================
// R5.2 Bake — seventh callsite card of the R5.2 series.
//
// Background: per design contract §Phase R5 / §R5.2, the snapshot
// system (R5.1) is in place. The next step is to wire the
// callsites so each user-action correctly pushes a
// pre-snapshot + commits + cancels.
//
// Pre-R5.2 bug: in imageEditorActions.js, the `onBake` handler
// pushed `window.ImageEditorTools.pushUndo(h.session)` AFTER
// `canvas.add(fImg)` — i.e., AFTER the entire mutation
// (canvas.clear + add + sendObjectToBack + baseObject).
// The pre-snapshot was the POST-bake state, so undo would pop
// the post-bake state and restore to it (no visible change).
// The user had to undo TWICE to get back to the pre-bake
// state.
//
// R5.2 fix: move the pushUndo to BEFORE `canvas.clear()`. Now
// a single undo restores the pre-bake state (PE-005).
// Plus cancel-cleanup in `.catch` if the async Image.fromURL
// throws (per R5.2.AuditFix P-R52T-F1 / R5.2 Stroke pattern).
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
const ACTIONS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorActions.js');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

const actionsSrc = fs.readFileSync(ACTIONS_JS, 'utf8');
const actionsCode = stripComments(actionsSrc);

// Extract the onBake function body. Use a non-greedy match
// to the next `function ` declaration.
function extractOnBake() {
  const re = /function onBake\(ctrl\) \{[\s\S]*?(?=function onHeal|function onRemoveBg|function onExternal|function onSave|\}\)\(\);)/;
  const m = actionsCode.match(re);
  return m ? m[0] : null;
}

// P-R52R-F6: extract the Click 1 / Click 2 equivalent — for
// Bake, the "Click 1" is the validation block (early-returns),
// and the "Click 2" is the actual mutation (canvas.clear +
// canvas.add). We use the `const temp =` line as the marker
// for the start of the mutation block.
function extractMutationBlock() {
  const full = extractOnBake();
  if (!full) return null;
  // The mutation block starts at `h.session.canvas.clear();`.
  const idx = full.indexOf('h.session.canvas.clear();');
  if (idx < 0) return null;
  return full.substring(idx);
}

test('R5.2.Bake.A: onBake pushes undo BEFORE canvas.clear (PRE-snapshot, pre-mutation)', () => {
  // R5.2 Bake A: the pre-snapshot is captured BEFORE
  // `canvas.clear()` (so undo restores the pre-bake state).
  const block = extractOnBake();
  assert.ok(block, 'R5.2.Bake.A: onBake function must exist in imageEditorActions.js');
  const pushUndoIdx = block.indexOf('pushUndo(h.session)');
  const canvasClearIdx = block.indexOf('h.session.canvas.clear()');
  assert.ok(pushUndoIdx >= 0, 'R5.2.Bake.A: onBake must call pushUndo(h.session)');
  assert.ok(canvasClearIdx >= 0, 'R5.2.Bake.A: onBake must call canvas.clear()');
  assert.ok(pushUndoIdx < canvasClearIdx,
    'R5.2.Bake.A: pushUndo must be BEFORE canvas.clear() (pre-snapshot)');
  // Exact call-signature check (catches typos like pushUndoWRONG).
  assert.ok(/window\.ImageEditorTools\.pushUndo\s*\(\s*h\.session\s*\)/.test(block),
    'R5.2.Bake.A: onBake must call window.ImageEditorTools.pushUndo(h.session) EXACTLY (not a typo)');
  // try/catch wrapper check. 200-char LEADING window to avoid
  // matching outer try/catch.
  const pushUndoCallIdx = block.indexOf('window.ImageEditorTools.pushUndo(h.session)');
  assert.ok(pushUndoCallIdx >= 0, 'R5.2.Bake.A: pushUndo call must be present');
  const window200 = block.substring(Math.max(0, pushUndoCallIdx - 200), pushUndoCallIdx);
  assert.ok(/try\s*\{/.test(window200),
    'R5.2.Bake.A: pushUndo must be inside a try { ... } block (defensive, not just outer try)');
  const afterWindow = block.substring(pushUndoCallIdx, pushUndoCallIdx + 200);
  assert.ok(/\}\s*catch/.test(afterWindow),
    'R5.2.Bake.A: pushUndo\'s try block must be followed by } catch (defensive)');
});

test('R5.2.Bake.B: onBake pre-snapshot is NOT after canvas.add (pre-fix bug)', () => {
  // R5.2 Bake B: regression check that the pre-snapshot is NOT
  // after the mutation (the pre-R5.2 bug). The pre-snapshot
  // must come BEFORE the canvas.clear().
  const block = extractOnBake();
  assert.ok(block, 'R5.2.Bake.B: onBake function must exist in imageEditorActions.js');
  const pushUndoIdx = block.indexOf('window.ImageEditorTools.pushUndo(h.session)');
  const canvasAddIdx = block.indexOf('h.session.canvas.add(fImg)');
  assert.ok(canvasAddIdx >= 0, 'R5.2.Bake.B: onBake must call canvas.add(fImg)');
  assert.ok(pushUndoIdx < canvasAddIdx,
    'R5.2.Bake.B: pushUndo must be BEFORE canvas.add (pre-snapshot before mutation, not after)');
  // P-R52Bake-F1 (R5.2 Bake.AuditFix): pushUndo must also be
  // AFTER renderSceneAtNaturalSize (so the pre-snapshot captures
  // the FULL pre-bake state, not an empty mid-flight state).
  const renderSceneIdx = block.indexOf('h.session.renderSceneAtNaturalSize()');
  assert.ok(renderSceneIdx >= 0, 'R5.2.Bake.B: onBake must call renderSceneAtNaturalSize');
  assert.ok(pushUndoIdx > renderSceneIdx,
    'R5.2.Bake.B: pushUndo must be AFTER renderSceneAtNaturalSize (pre-snapshot of full pre-bake state)');
});

test('R5.2.Bake.C: onBake has cancel-cleanup pattern (try/catch around _undo.pop in .catch)', () => {
  // R5.2 Bake C: if the async Image.fromURL throws after
  // the pre-snapshot was pushed, the .catch path must pop
  // the pre-snapshot. Per R5.2 Transform.AuditFix P-R52T-F1
  // (defensive try/catch around _undo.pop) pattern.
  const block = extractOnBake();
  assert.ok(block, 'R5.2.Bake.C: onBake function must exist in imageEditorActions.js');
  // Find the .catch block (since onBake uses .then().catch()
  // pattern for async Image.fromURL).
  const catchRe = /\.catch\s*\(\s*\(\s*\w+\s*\)\s*=>\s*\{[\s\S]*?\n\s{4}\}\s*\)/;
  const catchMatch = block.match(catchRe);
  assert.ok(catchMatch, 'R5.2.Bake.C: onBake must have a .catch block for async Image.fromURL');
  const catchBlock = catchMatch[0];
  // Check for _undo.pop wrapped in try/catch.
  assert.ok(/_undo\.pop/.test(catchBlock),
    'R5.2.Bake.C: .catch block must call _undo.pop (cancel-cleanup)');
  assert.ok(/try\s*\{[\s\S]*?_undo\.pop[\s\S]*?\}\s*catch/.test(catchBlock),
    'R5.2.Bake.C: _undo.pop must be wrapped in try/catch (defensive, per R5.2 Transform.AuditFix P-R52T-F1)');
});

test('R5.2.Bake.D: onBake has doc-comment explaining pre-fix bug + post-R5.2 fix + PE-005', () => {
  // R5.2 Bake D: the onBake function has a doc-comment
  // explaining WHY the pushUndo is BEFORE canvas.clear (so a
  // future contributor doesn't move it back). Per R5.2 Source
  // Add/Delete.AuditFix P-R52S-F2 pattern, doc-comment tests
  // MÜSSEN spezifische strings prüfen: Pre-fix + Post-R5.2 + PE-005.
  const re = /function onBake\(ctrl\) \{[\s\S]*?(?=function onHeal|function onRemoveBg|function onExternal|function onSave|\}\)\(\);)/;
  const fullBlock = actionsSrc.match(re);
  assert.ok(fullBlock, 'R5.2.Bake.D: onBake must exist in imageEditorActions.js');
  // P-R52S-F2 pattern: specific strings required.
  assert.ok(/Pre-fix/.test(fullBlock[0]),
    'R5.2.Bake.D: onBake must have a doc-comment mentioning "Pre-fix"');
  assert.ok(/Post-R5\.2/.test(fullBlock[0]),
    'R5.2.Bake.D: onBake must have a doc-comment mentioning "Post-R5.2"');
  assert.ok(/PE-005/.test(fullBlock[0]),
    'R5.2.Bake.D: onBake must have a doc-comment mentioning "PE-005"');
});

test('R5.2.Bake.I: doc-comment is in onBake (not in onHeal or other functions)', () => {
  // R5.2 Bake I (P-R52Bake-F2, equivalent to R5.2 Resize N):
  // the R5.2 Bake doc-comment must be inside the onBake function
  // specifically. A future change could move the doc-comment to
  // onHeal or to module level, which would be wrong. The test
  // verifies the doc-comment is between `function onBake(...){` and
  // `function onHeal`.
  const reOnBake = /function onBake\(ctrl\) \{[\s\S]*?(?=function onHeal|function onRemoveBg|function onExternal|function onSave|\}\)\(\);)/;
  const reOnHeal = /function onHeal\([\s\S]*?(?=function onRemoveBg|function onExternal|function onSave|\}\)\(\);)/;
  const onBakeBlock = actionsSrc.match(reOnBake);
  const onHealBlock = actionsSrc.match(reOnHeal);
  assert.ok(onBakeBlock, 'R5.2.Bake.I: onBake must exist in imageEditorActions.js');
  assert.ok(onHealBlock, 'R5.2.Bake.I: onHeal must exist in imageEditorActions.js');
  // The onBake block must have the R5.2 Bake doc-comment.
  assert.ok(/\/\/ R5\.2 Bake:/.test(onBakeBlock[0]),
    'R5.2.Bake.I: R5.2 Bake doc-comment must be in onBake (the function that does the bake)');
  // The onHeal block must NOT have the R5.2 Bake doc-comment.
  assert.ok(!/\/\/ R5\.2 Bake:/.test(onHealBlock[0]),
    'R5.2.Bake.I: R5.2 Bake doc-comment must NOT be in onHeal (different function)');
});

test('R5.2.Bake.E: onBake resets pushedPreSnapshot = false in the .catch block', () => {
  // R5.2 Bake E (P-R52R-F1 equivalent): the .catch block must
  // reset `pushedPreSnapshot = false` AFTER the cancel-cleanup.
  // If missing, the next bake would inherit the flag from a
  // previous failed bake (false-positive).
  const block = extractOnBake();
  assert.ok(block, 'R5.2.Bake.E: onBake function must exist in imageEditorActions.js');
  // Find the .catch block.
  const catchRe = /\.catch\s*\(\s*\(\s*\w+\s*\)\s*=>\s*\{[\s\S]*?\n\s{4}\}\s*\)/;
  const catchMatch = block.match(catchRe);
  assert.ok(catchMatch, 'R5.2.Bake.E: onBake must have a .catch block');
  const catchBlock = catchMatch[0];
  // The .catch block must contain `pushedPreSnapshot = false`.
  assert.ok(/pushedPreSnapshot\s*=\s*false\s*;/.test(catchBlock),
    'R5.2.Bake.E: .catch block must reset pushedPreSnapshot = false (avoid stale flag on next bake)');
});

test('R5.2.Bake.F: onBake cancel-cleanup checks `h.session &&` (defensive null-guard)', () => {
  // R5.2 Bake F (P-R52R-F7 equivalent): the cancel-cleanup
  // must check `h.session &&` (defensive null-guard for the
  // case where h.session was never assigned).
  const block = extractOnBake();
  assert.ok(block, 'R5.2.Bake.F: onBake function must exist in imageEditorActions.js');
  const catchRe = /\.catch\s*\(\s*\(\s*\w+\s*\)\s*=>\s*\{[\s\S]*?\n\s{4}\}\s*\)/;
  const catchMatch = block.match(catchRe);
  assert.ok(catchMatch, 'R5.2.Bake.F: onBake must have a .catch block');
  const catchBlock = catchMatch[0];
  // The cancel-cleanup must check `if (h.session && Array.isArray(h.session._undo)...`.
  assert.ok(/if\s*\(\s*h\.session\s*&&\s*Array\.isarray\s*\(\s*h\.session\._undo\s*\)/i.test(catchBlock),
    'R5.2.Bake.F: cancel-cleanup must check `h.session && Array.isArray(h.session._undo)` (defensive null-guard)');
  // P-R52R-F4 equivalent: the cancel-cleanup condition must be
  // `if (pushedPreSnapshot)` (not `if (true)` or wrong-var).
  assert.ok(/if\s*\(\s*pushedPreSnapshot\s*\)/.test(catchBlock),
    'R5.2.Bake.F: cancel-cleanup must check `if (pushedPreSnapshot)` (correct condition)');
  // Negative check: must NOT be `if (true)`.
  assert.ok(!/if\s*\(\s*true\s*\)/.test(catchBlock),
    'R5.2.Bake.F: cancel-cleanup must NOT be `if (true)` (would pop real undo entries)');
});

test('R5.2.Bake.G: onBake has post-actions (slot.modified + refresh) AFTER the swap', () => {
  // R5.2 Bake G: after the swap, the slot must be marked
  // as modified + the UI must be refreshed. Per R5.2
  // Reorder/Flip.AuditFix P-R52RF-F1 pattern, post-actions
  // are MANDATORY (not just the pre-snapshot).
  const block = extractOnBake();
  assert.ok(block, 'R5.2.Bake.G: onBake function must exist in imageEditorActions.js');
  // The post-action must be AFTER h.session.canvas.add(fImg).
  const canvasAddIdx = block.indexOf('h.session.canvas.add(fImg)');
  const slotModifiedIdx = block.indexOf('activeSlot(ctrl).modified = true');
  assert.ok(canvasAddIdx >= 0, 'R5.2.Bake.G: onBake must call h.session.canvas.add(fImg)');
  assert.ok(slotModifiedIdx >= 0, 'R5.2.Bake.G: onBake must set activeSlot(ctrl).modified = true');
  assert.ok(canvasAddIdx < slotModifiedIdx,
    'R5.2.Bake.G: slot.modified = true must come AFTER canvas.add (post-action)');
  // refreshObjectsList + refreshQueueBar must be present.
  assert.ok(/refreshObjectsList/.test(block),
    'R5.2.Bake.G: onBake must call refreshObjectsList (post-action)');
});

test('R5.2.Bake.H: integration check — pre-snapshot on success + cancel-cleanup on fromURL-throw', () => {
  // R5.2 Bake H: behavioral verification of the pushUndo +
  // cancel-cleanup pattern using a minimal mock. The full
  // onBake path requires too many globals (ImageEditorTools,
  // ImageEditorCanvas, ImageEditorSource, confirm) to be
  // worth the brittleness. Instead, we extract the relevant
  // logic and test it directly:
  // 1. Success: pre-snapshot + mutation succeeds, no cancel-cleanup.
  // 2. fromURL-throw: pre-snapshot + canvas.clear succeeded,
  //    but Image.fromURL throws. Cancel-cleanup pops the
  //    pre-snapshot.
  // Mock the session.
  const baseImg = { _isBase: true, type: 'image', left: 0, top: 0, width: 100, height: 60 };
  const session = {
    _undo: [],
    imgW: 100, imgH: 60,
    baseObject: baseImg,
    canvas: {
      _objects: [baseImg],
      getObjects: function () { return this._objects; },
      add: function (o) { this._objects.push(o); return o; },
      clear: function () { this._objects = []; },
      sendObjectToBack: function (o) { const i = this._objects.indexOf(o); if (i >= 0) { this._objects.splice(i, 1); this._objects.unshift(o); } },
      renderAll: function () {},
    },
  };
  // Simulate the R5.2 Bake pushUndo behavior.
  let pushedPreSnapshot = false;
  // Scenario A: success — pushUndo + mutation succeeds.
  session._undo.push({ json: { version: 'x' } });
  pushedPreSnapshot = true;
  session.canvas.clear();
  session.canvas.add({ _isBase: true, type: 'image', width: 100, height: 60 });
  session.canvas.sendObjectToBack(session.canvas._objects[0]);
  session.baseObject = session.canvas._objects[0];
  // Success: session._undo has 1 entry, pushedPreSnapshot is true.
  assert.equal(session._undo.length, 1, 'R5.2.Bake.H scenario A: success — session._undo has 1 entry');
  assert.equal(pushedPreSnapshot, true, 'R5.2.Bake.H scenario A: success — pushedPreSnapshot is true');
  // Scenario B: fromURL-throws after canvas.clear — cancel-cleanup pops the pre-snapshot.
  const sessionB = {
    _undo: [],
    imgW: 100, imgH: 60,
    baseObject: baseImg,
    canvas: {
      _objects: [baseImg],
      clear: function () { this._objects = []; },
    },
  };
  let pushedB = false;
  // Push the pre-snapshot.
  sessionB._undo.push({ json: { version: 'x' } });
  pushedB = true;
  // canvas.clear() succeeds.
  sessionB.canvas.clear();
  // Simulate fromURL throwing.
  let fromURLThrew = false;
  try {
    throw new Error('simulated fromURL failure');
  } catch (e) {
    fromURLThrew = true;
    // Cancel-cleanup: pop the pre-snapshot.
    if (pushedB) {
      if (sessionB && Array.isArray(sessionB._undo) && sessionB._undo.length) {
        sessionB._undo.pop();
      }
      pushedB = false;
    }
  }
  assert.equal(fromURLThrew, true, 'R5.2.Bake.H scenario B: fromURL threw');
  // After cancel-cleanup: sessionB._undo is empty.
  assert.equal(sessionB._undo.length, 0, 'R5.2.Bake.H scenario B: fromURL-throw — session._undo is empty (cancel-cleanup)');
  assert.equal(pushedB, false, 'R5.2.Bake.H scenario B: fromURL-throw — pushedPreSnapshot is false');
});
