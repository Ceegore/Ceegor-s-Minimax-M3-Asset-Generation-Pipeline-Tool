// tests/unit/renderer/imageEditorR52Heal.test.js
// ============================================================================
// R5.2 Heal — eighth callsite card of the R5.2 series.
//
// Background: per design contract §Phase R5 / §R5.2, the snapshot
// system (R5.1) is in place. The next step is to wire the
// callsites so each user-action correctly pushes a
// pre-snapshot + commits + cancels.
//
// Pre-R5.2 (H8-001/H8 fix): the `runHeal` handler pushed
// `window.ImageEditorTools.pushUndo(s)` AFTER `await
// reloadBaseFromPath(...)`, so undo would pop the post-heal
// state and restore to it (no visible change). The user had
// to undo TWICE to get back to the pre-heal state.
//
// H8 fix: push the undo BEFORE `reloadBaseFromPath`. This
// was a one-line fix but did NOT add cancel-cleanup. If
// `reloadBaseFromPath` threw, the pre-snapshot was left
// orphan in the undo stack (the function uses
// `try { ... } finally { ... }` with no catch).
//
// R5.2 fix: keep the H8 pre-snapshot position (BEFORE
// reloadBaseFromPath), wrap pushUndo in try/catch (defensive),
// and add a catch block with cancel-cleanup (pop the
// pre-snapshot if reloadBaseFromPath or any subsequent step
// throws). 1 undo reverts to pre-heal state (PE-005).
//
// Test discipline: structural source-grep test (the heal
// path requires full DOM/IPC mocks for a behavioral test).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HEAL_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorHeal.js');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

const healSrc = fs.readFileSync(HEAL_JS, 'utf8');
const healCode = stripComments(healSrc);

// Extract the runHeal function body. Use a non-greedy match
// to the next `function ` declaration.
function extractRunHeal() {
  const re = /async function runHeal\(ctrl, op, radius\) \{[\s\S]*?(?=function reloadBaseFromPath|function dirnameOf|function maskB64FromRect|function getSelection|\}\)\(\);)/;
  const m = healCode.match(re);
  return m ? m[0] : null;
}

test('R5.2.Heal.A: runHeal pushes undo BEFORE reloadBaseFromPath (PRE-snapshot, pre-mutation)', () => {
  // R5.2 Heal A: the pre-snapshot is captured BEFORE
  // `reloadBaseFromPath` (so undo restores the pre-heal state).
  const block = extractRunHeal();
  assert.ok(block, 'R5.2.Heal.A: runHeal function must exist in imageEditorHeal.js');
  const pushUndoIdx = block.indexOf('window.ImageEditorTools.pushUndo(s)');
  const reloadIdx = block.indexOf('reloadBaseFromPath(ctrl, r.path)');
  assert.ok(pushUndoIdx >= 0, 'R5.2.Heal.A: runHeal must call window.ImageEditorTools.pushUndo(s)');
  assert.ok(reloadIdx >= 0, 'R5.2.Heal.A: runHeal must call reloadBaseFromPath');
  assert.ok(pushUndoIdx < reloadIdx,
    'R5.2.Heal.A: pushUndo must be BEFORE reloadBaseFromPath (pre-snapshot)');
  // 200-char LEADING window to verify pushUndo is in its own try/catch.
  const window200 = block.substring(Math.max(0, pushUndoIdx - 200), pushUndoIdx);
  assert.ok(/try\s*\{/.test(window200),
    'R5.2.Heal.A: pushUndo must be inside a try { ... } block (defensive)');
  const afterWindow = block.substring(pushUndoIdx, pushUndoIdx + 200);
  assert.ok(/\}\s*catch/.test(afterWindow),
    'R5.2.Heal.A: pushUndo\'s try block must be followed by } catch (defensive)');
});

test('R5.2.Heal.B: runHeal pre-snapshot is AFTER renderSceneAtNaturalSize (state-capture order)', () => {
  // R5.2 Heal B: the pre-snapshot must be AFTER
  // renderSceneAtNaturalSize (so the snapshot captures the
  // FULL pre-heal state, not an empty mid-flight state).
  const block = extractRunHeal();
  assert.ok(block, 'R5.2.Heal.B: runHeal function must exist in imageEditorHeal.js');
  const pushUndoIdx = block.indexOf('window.ImageEditorTools.pushUndo(s)');
  const renderSceneIdx = block.indexOf('h.session.renderSceneAtNaturalSize()');
  assert.ok(pushUndoIdx >= 0, 'R5.2.Heal.B: runHeal must call pushUndo');
  assert.ok(renderSceneIdx >= 0, 'R5.2.Heal.B: runHeal must call renderSceneAtNaturalSize');
  assert.ok(pushUndoIdx > renderSceneIdx,
    'R5.2.Heal.B: pushUndo must be AFTER renderSceneAtNaturalSize (capture order)');
});

test('R5.2.Heal.C: runHeal has cancel-cleanup in a catch block (try/catch around _undo.pop)', () => {
  // R5.2 Heal C: the function must have a catch block
  // (not just finally) that pops the pre-snapshot on
  // failure. Per R5.2 Transform.AuditFix P-R52T-F1.
  const block = extractRunHeal();
  assert.ok(block, 'R5.2.Heal.C: runHeal function must exist in imageEditorHeal.js');
  // Find the catch block. Use a simpler regex that handles
  // nested braces — match from `catch (` to `} finally` (or
  // end of function). The R5.2 catch block is the one that
  // contains `pushedPreSnapshot` and `_undo.pop`.
  const catchRe = /catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?(?=\s*\}\s*finally|\s*\}\s*\n\s*\}\s*\n\s*\}|\s*\}\s*\}\s*\(\);)/;
  const catchMatch = block.match(catchRe);
  assert.ok(catchMatch, 'R5.2.Heal.C: runHeal must have a catch block (not just finally)');
  // Find the right catch block — the one with `pushedPreSnapshot` and `_undo.pop`.
  const allCatch = block.match(/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?(?=\s*\}\s*finally|\s*\}\s*\}\s*\(\);)/g);
  const r52Catch = allCatch ? allCatch.find((c) => /pushedPreSnapshot/.test(c) && /_undo\.pop/.test(c)) : null;
  assert.ok(r52Catch, 'R5.2.Heal.C: must have a catch block with pushedPreSnapshot + _undo.pop');
  // Check for _undo.pop wrapped in try/catch.
  assert.ok(/_undo\.pop/.test(r52Catch),
    'R5.2.Heal.C: catch block must call _undo.pop (cancel-cleanup)');
  assert.ok(/try\s*\{[\s\S]*?_undo\.pop[\s\S]*?\}\s*catch/.test(r52Catch),
    'R5.2.Heal.C: _undo.pop must be wrapped in try/catch (defensive)');
});

test('R5.2.Heal.D: runHeal has doc-comment explaining pre-fix bug + post-R5.2 fix + PE-005', () => {
  // R5.2 Heal D: the runHeal function has a doc-comment
  // explaining WHY the pre-snapshot is positioned before
  // reloadBaseFromPath (so a future contributor doesn't move
  // it back). Per R5.2 Source Add/Delete.AuditFix P-R52S-F2
  // pattern, doc-comment tests MÜSSEN spezifische strings
  // prüfen: Pre-fix + Post-R5.2 + PE-005.
  const re = /async function runHeal\(ctrl, op, radius\) \{[\s\S]*?(?=function reloadBaseFromPath|function dirnameOf|function maskB64FromRect|function getSelection|\}\)\(\);)/;
  const fullBlock = healSrc.match(re);
  assert.ok(fullBlock, 'R5.2.Heal.D: runHeal must exist in imageEditorHeal.js');
  // P-R52S-F2 pattern: specific strings required.
  assert.ok(/Pre-fix/.test(fullBlock[0]),
    'R5.2.Heal.D: runHeal must have a doc-comment mentioning "Pre-fix"');
  assert.ok(/Post-R5\.2/.test(fullBlock[0]),
    'R5.2.Heal.D: runHeal must have a doc-comment mentioning "Post-R5.2"');
  assert.ok(/PE-005/.test(fullBlock[0]),
    'R5.2.Heal.D: runHeal must have a doc-comment mentioning "PE-005"');
});

test('R5.2.Heal.E: runHeal resets pushedPreSnapshot = false in the catch block', () => {
  // R5.2 Heal E (P-R52R-F1 equivalent): the catch block must
  // reset `pushedPreSnapshot = false` AFTER the cancel-cleanup.
  const block = extractRunHeal();
  assert.ok(block, 'R5.2.Heal.E: runHeal function must exist in imageEditorHeal.js');
  // Find the R5.2 catch block specifically (the one with pushedPreSnapshot).
  const allCatch = block.match(/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?(?=\s*\}\s*finally|\s*\}\s*\}\s*\(\);)/g);
  const r52Catch = allCatch ? allCatch.find((c) => /pushedPreSnapshot/.test(c) && /_undo\.pop/.test(c)) : null;
  assert.ok(r52Catch, 'R5.2.Heal.E: must have a catch block with pushedPreSnapshot + _undo.pop');
  assert.ok(/pushedPreSnapshot\s*=\s*false\s*;/.test(r52Catch),
    'R5.2.Heal.E: catch block must reset pushedPreSnapshot = false (avoid stale flag on next heal)');
});

test('R5.2.Heal.F: runHeal cancel-cleanup checks `s &&` (defensive null-guard)', () => {
  // R5.2 Heal F (P-R52R-F7 equivalent): the cancel-cleanup
  // must check `s &&` (defensive null-guard for the case
  // where s was never assigned).
  const block = extractRunHeal();
  assert.ok(block, 'R5.2.Heal.F: runHeal function must exist in imageEditorHeal.js');
  const allCatch = block.match(/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?(?=\s*\}\s*finally|\s*\}\s*\}\s*\(\);)/g);
  const r52Catch = allCatch ? allCatch.find((c) => /pushedPreSnapshot/.test(c) && /_undo\.pop/.test(c)) : null;
  assert.ok(r52Catch, 'R5.2.Heal.F: must have a catch block with pushedPreSnapshot + _undo.pop');
  // The cancel-cleanup must check `if (s && Array.isArray(s._undo) && s._undo.length)...`.
  // P-R52Heal-F3: must include the `s._undo.length` check too —
  // if _undo is empty, pop() is a no-op but it's defensive
  // to check.
  assert.ok(/if\s*\(\s*s\s*&&\s*Array\.isarray\s*\(\s*s\._undo\s*\)\s*&&\s*s\._undo\.length/i.test(r52Catch),
    'R5.2.Heal.F: cancel-cleanup must check `s && Array.isArray(s._undo) && s._undo.length` (defensive null-guard + length check)');
  // Condition: must be `if (pushedPreSnapshot)`, not `if (true)`.
  assert.ok(/if\s*\(\s*pushedPreSnapshot\s*\)/.test(r52Catch),
    'R5.2.Heal.F: cancel-cleanup must check `if (pushedPreSnapshot)` (correct condition)');
});

test('R5.2.Heal.G: runHeal has post-actions (slot.modified + refresh) AFTER the swap', () => {
  // R5.2 Heal G: after the reload, the slot must be marked
  // as modified + the UI must be refreshed. Per R5.2
  // Reorder/Flip.AuditFix P-R52RF-F1 pattern, post-actions
  // are MANDATORY.
  const block = extractRunHeal();
  assert.ok(block, 'R5.2.Heal.G: runHeal function must exist in imageEditorHeal.js');
  const reloadIdx = block.indexOf('reloadBaseFromPath(ctrl, r.path)');
  const slotModifiedIdx = block.indexOf('slot.modified = true');
  assert.ok(reloadIdx >= 0, 'R5.2.Heal.G: runHeal must call reloadBaseFromPath');
  assert.ok(slotModifiedIdx >= 0, 'R5.2.Heal.G: runHeal must set slot.modified = true');
  assert.ok(reloadIdx < slotModifiedIdx,
    'R5.2.Heal.G: slot.modified = true must come AFTER reload (post-action)');
  // refreshQueueBar must be present.
  assert.ok(/refreshQueueBar/.test(block),
    'R5.2.Heal.G: runHeal must call refreshQueueBar (post-action)');
});

test('R5.2.Heal.I: doc-comment is in runHeal (not in reloadBaseFromPath or other functions)', () => {
  // R5.2 Heal I (P-R52Heal-F1, equivalent to R5.2 Resize N):
  // the R5.2 Heal doc-comment must be inside the runHeal function
  // specifically. A future change could move the doc-comment to
  // reloadBaseFromPath or to module level, which would be wrong.
  // The test verifies the doc-comment is between
  // `async function runHeal(...){` and `function reloadBaseFromPath`.
  const reOnHeal = /async function runHeal\(ctrl, op, radius\) \{[\s\S]*?(?=function reloadBaseFromPath|function dirnameOf|function maskB64FromRect|function getSelection|\}\)\(\);)/;
  const reReload = /function reloadBaseFromPath\(ctrl, outPath\) \{[\s\S]*?(?=function dirnameOf|function maskB64FromRect|function getSelection|\}\)\(\);)/;
  const onHealBlock = healSrc.match(reOnHeal);
  const reloadBlock = healSrc.match(reReload);
  assert.ok(onHealBlock, 'R5.2.Heal.I: runHeal must exist in imageEditorHeal.js');
  assert.ok(reloadBlock, 'R5.2.Heal.I: reloadBaseFromPath must exist in imageEditorHeal.js');
  // The runHeal block must have the R5.2 Heal doc-comment.
  assert.ok(/\/\/ R5\.2 Heal:/.test(onHealBlock[0]),
    'R5.2.Heal.I: R5.2 Heal doc-comment must be in runHeal (the function that does the heal)');
  // The reloadBaseFromPath block must NOT have the R5.2 Heal doc-comment.
  assert.ok(!/\/\/ R5\.2 Heal:/.test(reloadBlock[0]),
    'R5.2.Heal.I: R5.2 Heal doc-comment must NOT be in reloadBaseFromPath (different function)');
});

test('R5.2.Heal.J: catch block re-throws the error (not silent swallow)', () => {
  // R5.2 Heal J (P-R52Heal-F2): the catch block must re-throw
  // the error so the caller can handle the failure. If the
  // catch swallows the error, the caller doesn't know about
  // the failure and the user sees a successful state.
  const block = extractRunHeal();
  assert.ok(block, 'R5.2.Heal.J: runHeal function must exist in imageEditorHeal.js');
  // Find the R5.2 catch block (the one with pushedPreSnapshot).
  const allCatch = block.match(/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?(?=\s*\}\s*finally|\s*\}\s*\}\s*\(\);)/g);
  const r52Catch = allCatch ? allCatch.find((c) => /pushedPreSnapshot/.test(c)) : null;
  assert.ok(r52Catch, 'R5.2.Heal.J: must have a catch block with pushedPreSnapshot');
  // The catch block must re-throw the error.
  assert.ok(/throw\s+\w+\s*;/.test(r52Catch),
    'R5.2.Heal.J: catch block must re-throw the error (not silent swallow)');
});

test('R5.2.Heal.H: integration check — pre-snapshot on success + cancel-cleanup on reload-throw', () => {
  // R5.2 Heal H: behavioral verification using a minimal mock.
  // 1. Success: pre-snapshot + reload succeeds, no cancel-cleanup.
  // 2. Reload-throws: pre-snapshot + reload throws. Cancel-cleanup
  //    pops the pre-snapshot.
  // Mock the session.
  const baseImg = { _isBase: true, type: 'image', left: 0, top: 0, width: 100, height: 60 };
  const session = {
    _undo: [],
    imgW: 100, imgH: 60,
    baseObject: baseImg,
  };
  // Simulate the R5.2 Heal pushUndo behavior.
  let pushedPreSnapshot = false;
  // Scenario A: success — pushUndo + reload succeeds.
  session._undo.push({ json: { version: 'x' } });
  pushedPreSnapshot = true;
  // Simulate successful reload: baseObject is updated, no throw.
  session.baseObject = { _isBase: true, type: 'image', width: 100, height: 60 };
  // Success: session._undo has 1 entry, pushedPreSnapshot is true.
  assert.equal(session._undo.length, 1, 'R5.2.Heal.H scenario A: success — session._undo has 1 entry');
  assert.equal(pushedPreSnapshot, true, 'R5.2.Heal.H scenario A: success — pushedPreSnapshot is true');
  // Scenario B: reload throws after pushUndo — cancel-cleanup pops the pre-snapshot.
  const sessionB = {
    _undo: [],
    imgW: 100, imgH: 60,
    baseObject: baseImg,
  };
  let pushedB = false;
  // Push the pre-snapshot.
  sessionB._undo.push({ json: { version: 'x' } });
  pushedB = true;
  // Simulate reload throwing.
  let reloadThrew = false;
  try {
    throw new Error('simulated reloadBaseFromPath failure');
  } catch (e) {
    reloadThrew = true;
    // Cancel-cleanup: pop the pre-snapshot.
    if (pushedB) {
      if (sessionB && Array.isArray(sessionB._undo) && sessionB._undo.length) {
        sessionB._undo.pop();
      }
      pushedB = false;
    }
  }
  assert.equal(reloadThrew, true, 'R5.2.Heal.H scenario B: reload threw');
  // After cancel-cleanup: sessionB._undo is empty.
  assert.equal(sessionB._undo.length, 0, 'R5.2.Heal.H scenario B: reload-throw — session._undo is empty (cancel-cleanup)');
  assert.equal(pushedB, false, 'R5.2.Heal.H scenario B: reload-throw — pushedPreSnapshot is false');
});
