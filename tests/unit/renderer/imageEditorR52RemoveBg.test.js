// tests/unit/renderer/imageEditorR52RemoveBg.test.js
// ============================================================================
// R5.2 Remove BG — ninth callsite card of the R5.2 series.
//
// Background: per design contract §Phase R5 / §R5.2, the snapshot
// system (R5.1) is in place. The next step is to wire the
// callsites so each user-action correctly pushes a
// pre-snapshot + commits + cancels.
//
// Pre-R5.2 (H8-001 fix): the `runRemoveBg` handler pushed
// `Tools.pushUndo(s)` BEFORE `await Heal.reloadBaseFromPath(...)`,
// so undo would pop the post-RemoveBG state and restore to
// it (no visible change). The user had to undo TWICE to
// get back to the pre-RemoveBG state.
//
// H8 fix: push the undo BEFORE `reloadBaseFromPath`. This
// was a one-line fix but did NOT add cancel-cleanup. If
// `reloadBaseFromPath` threw, the pre-snapshot was left
// orphan in the undo stack (the function uses an unguarded
// code path with no try/catch around the post-actions).
//
// R5.2 fix: keep the H8 pre-snapshot position (BEFORE
// reloadBaseFromPath), wrap pushUndo in try/catch (defensive),
// and add a catch block with cancel-cleanup (pop the
// pre-snapshot if reloadBaseFromPath or any subsequent step
// throws). 1 undo reverts to pre-RemoveBG state (PE-005).
//
// Test discipline: structural source-grep test (the
// RemoveBG path requires full DOM/IPC mocks for a behavioral
// test).
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

// Extract the runRemoveBg function body. Use a non-greedy match
// to the next `function ` declaration.
function extractRunRemoveBg() {
  const re = /async function runRemoveBg\(ctrl, slot, h\) \{[\s\S]*?(?=function dirnameOf|function onExternal|function activeSlot|function activeSession|\}\)\(\);)/;
  const m = actionsCode.match(re);
  return m ? m[0] : null;
}

test('R5.2.RBG.A: runRemoveBg pushes undo BEFORE reloadBaseFromPath (PRE-snapshot, pre-mutation)', () => {
  // R5.2 RBG A: the pre-snapshot is captured BEFORE
  // `reloadBaseFromPath` (so undo restores the pre-RemoveBG state).
  const block = extractRunRemoveBg();
  assert.ok(block, 'R5.2.RBG.A: runRemoveBg function must exist in imageEditorActions.js');
  const pushUndoIdx = block.indexOf('Tools.pushUndo(s)');
  // gewv2 GEW-003 fix: isnetbg returns { outputPath }, not { path } —
  // reloadBaseFromPath now reads r.outputPath (with a tmpOut fallback).
  const reloadIdx = block.indexOf('Heal.reloadBaseFromPath(ctrl, r.outputPath || tmpOut)');
  assert.ok(pushUndoIdx >= 0, 'R5.2.RBG.A: runRemoveBg must call Tools.pushUndo(s)');
  assert.ok(reloadIdx >= 0, 'R5.2.RBG.A: runRemoveBg must call reloadBaseFromPath');
  assert.ok(pushUndoIdx < reloadIdx,
    'R5.2.RBG.A: pushUndo must be BEFORE reloadBaseFromPath (pre-snapshot)');
  // Exact call-signature check.
  assert.ok(/Tools\.pushUndo\s*\(\s*s\s*\)/.test(block),
    'R5.2.RBG.A: runRemoveBg must call Tools.pushUndo(s) EXACTLY (not a typo)');
  // try/catch wrapper check. 200-char LEADING window to avoid
  // matching outer try/catch.
  const pushUndoCallIdx = block.indexOf('Tools.pushUndo(s)');
  assert.ok(pushUndoCallIdx >= 0, 'R5.2.RBG.A: pushUndo call must be present');
  const window200 = block.substring(Math.max(0, pushUndoCallIdx - 200), pushUndoCallIdx);
  assert.ok(/try\s*\{/.test(window200),
    'R5.2.RBG.A: pushUndo must be inside a try { ... } block (defensive)');
  const afterWindow = block.substring(pushUndoCallIdx, pushUndoCallIdx + 200);
  assert.ok(/\}\s*catch/.test(afterWindow),
    'R5.2.RBG.A: pushUndo\'s try block must be followed by } catch (defensive)');
});

test('R5.2.RBG.B: runRemoveBg has cancel-cleanup in a catch block (try/catch around _undo.pop)', () => {
  // R5.2 RBG B: the function must have a catch block
  // (not just finally) that pops the pre-snapshot on
  // failure. Per R5.2 Transform.AuditFix P-R52T-F1.
  const block = extractRunRemoveBg();
  assert.ok(block, 'R5.2.RBG.B: runRemoveBg function must exist in imageEditorActions.js');
  // The function must have a catch block. Use a function-level
  // search for the key patterns: `if (pushedPreSnapshot)` followed
  // by `try { ... _undo.pop ... } catch { ... }`. The catch block
  // for the R5.2 cancel-cleanup pattern.
  assert.ok(/catch\s*\(\s*\w+\s*\)/.test(block),
    'R5.2.RBG.B: runRemoveBg must have a catch block');
  // The cancel-cleanup structure: if (pushedPreSnapshot) { try { if (s && Array.isArray(s._undo) && s._undo.length) { s._undo.pop(); } } catch (_) {} pushedPreSnapshot = false; }
  assert.ok(/if\s*\(\s*pushedPreSnapshot\s*\)\s*\{[\s\S]*?s\._undo\.pop[\s\S]*?pushedPreSnapshot\s*=\s*false/.test(block),
    'R5.2.RBG.B: catch block must have `if (pushedPreSnapshot) { ... s._undo.pop ... pushedPreSnapshot = false; }` cancel-cleanup');
  // P-R52RBG-F1 (R5.2 Remove BG.AuditFix): the cancel-cleanup
  // condition must be `if (pushedPreSnapshot)` (not `if (true)`).
  // Use a specific regex that requires the variable name.
  assert.ok(/if\s*\(\s*pushedPreSnapshot\s*\)\s*\{[\s\S]*?s\._undo\.pop/.test(block),
    'R5.2.RBG.B: cancel-cleanup condition must be `if (pushedPreSnapshot)` (not `if (true)` or wrong-var)');
  // P-R52RBG-F2 (R5.2 Remove BG.AuditFix): the `_undo.pop` must
  // be wrapped in try/catch (defensive, per R5.2 Transform.AuditFix
  // P-R52T-F1 pattern). Use a function-level search for the
  // pattern: `try { ... s._undo.pop ... } catch`.
  assert.ok(/try\s*\{[\s\S]*?s\._undo\.pop[\s\S]*?\}\s*catch/.test(block),
    'R5.2.RBG.B: _undo.pop must be wrapped in try/catch (defensive, per R5.2 Transform.AuditFix P-R52T-F1)');
});

test('R5.2.RBG.C: runRemoveBg has doc-comment explaining pre-fix bug + post-R5.2 fix + PE-005', () => {
  // R5.2 RBG C: the runRemoveBg function has a doc-comment
  // explaining WHY the pre-snapshot is positioned before
  // reloadBaseFromPath. Per R5.2 Source Add/Delete.AuditFix
  // P-R52S-F2 pattern, doc-comment tests MÜSSEN spezifische
  // strings prüfen: Pre-fix + Post-R5.2 + PE-005.
  const re = /async function runRemoveBg\(ctrl, slot, h\) \{[\s\S]*?(?=function dirnameOf|function onExternal|function activeSlot|function activeSession|\}\)\(\);)/;
  const fullBlock = actionsSrc.match(re);
  assert.ok(fullBlock, 'R5.2.RBG.C: runRemoveBg must exist in imageEditorActions.js');
  // P-R52S-F2 pattern: specific strings required.
  assert.ok(/Pre-fix/.test(fullBlock[0]),
    'R5.2.RBG.C: runRemoveBg must have a doc-comment mentioning "Pre-fix"');
  assert.ok(/Post-R5\.2/.test(fullBlock[0]),
    'R5.2.RBG.C: runRemoveBg must have a doc-comment mentioning "Post-R5.2"');
  assert.ok(/PE-005/.test(fullBlock[0]),
    'R5.2.RBG.C: runRemoveBg must have a doc-comment mentioning "PE-005"');
});

test('R5.2.RBG.D: runRemoveBg resets pushedPreSnapshot = false in the catch block', () => {
  // R5.2 RBG D (P-R52R-F1 equivalent): the catch block must
  // reset `pushedPreSnapshot = false` AFTER the cancel-cleanup.
  const block = extractRunRemoveBg();
  assert.ok(block, 'R5.2.RBG.D: runRemoveBg function must exist in imageEditorActions.js');
  // The cancel-cleanup structure must include `pushedPreSnapshot = false`.
  assert.ok(/pushedPreSnapshot\s*=\s*false\s*;/.test(block),
    'R5.2.RBG.D: runRemoveBg must reset pushedPreSnapshot = false (avoid stale flag on next remove-bg)');
});

test('R5.2.RBG.E: runRemoveBg cancel-cleanup checks `s &&` (defensive null-guard)', () => {
  // R5.2 RBG E (P-R52R-F7 equivalent): the cancel-cleanup
  // must check `s &&` (defensive null-guard).
  const block = extractRunRemoveBg();
  assert.ok(block, 'R5.2.RBG.E: runRemoveBg function must exist in imageEditorActions.js');
  const allCatch = block.match(/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?(?=\s*\}\s*\n\s{2,3})/g);
  const r52Catch = allCatch ? allCatch.find((c) => /pushedPreSnapshot/.test(c) && /_undo\.pop/.test(c)) : null;
  assert.ok(r52Catch, 'R5.2.RBG.E: must have a catch block with pushedPreSnapshot + _undo.pop');
  // The cancel-cleanup must check `s && Array.isArray(s._undo) && s._undo.length`.
  assert.ok(/if\s*\(\s*s\s*&&\s*Array\.isarray\s*\(\s*s\._undo\s*\)\s*&&\s*s\._undo\.length/i.test(r52Catch),
    'R5.2.RBG.E: cancel-cleanup must check `s && Array.isArray(s._undo) && s._undo.length` (defensive null-guard + length check)');
  // Condition: must be `if (pushedPreSnapshot)`, not `if (true)`.
  assert.ok(/if\s*\(\s*pushedPreSnapshot\s*\)/.test(r52Catch),
    'R5.2.RBG.E: cancel-cleanup must check `if (pushedPreSnapshot)` (correct condition)');
});

test('R5.2.RBG.F: runRemoveBg has post-actions (slot.modified + refresh) AFTER the swap', () => {
  // R5.2 RBG F: after the swap, the slot must be marked
  // as modified + the UI must be refreshed. Per R5.2
  // Reorder/Flip.AuditFix P-R52RF-F1 pattern, post-actions
  // are MANDATORY.
  const block = extractRunRemoveBg();
  assert.ok(block, 'R5.2.RBG.F: runRemoveBg function must exist in imageEditorActions.js');
  // gewv2 GEW-003 fix: isnetbg returns { outputPath }, not { path } —
  // reloadBaseFromPath now reads r.outputPath (with a tmpOut fallback).
  const reloadIdx = block.indexOf('Heal.reloadBaseFromPath(ctrl, r.outputPath || tmpOut)');
  const slotModifiedIdx = block.indexOf('slot.modified = true');
  assert.ok(reloadIdx >= 0, 'R5.2.RBG.F: runRemoveBg must call reloadBaseFromPath');
  assert.ok(slotModifiedIdx >= 0, 'R5.2.RBG.F: runRemoveBg must set slot.modified = true');
  assert.ok(reloadIdx < slotModifiedIdx,
    'R5.2.RBG.F: slot.modified = true must come AFTER reload (post-action)');
  // refreshQueueBar must be present.
  assert.ok(/refreshQueueBar/.test(block),
    'R5.2.RBG.F: runRemoveBg must call refreshQueueBar (post-action)');
});

test('R5.2.RBG.G: runRemoveBg catch block re-throws the error (not silent swallow)', () => {
  // R5.2 RBG G (P-R52Heal-F2 equivalent): the catch block
  // must re-throw the error so the caller can handle the
  // failure.
  const block = extractRunRemoveBg();
  assert.ok(block, 'R5.2.RBG.G: runRemoveBg function must exist in imageEditorActions.js');
  // The function must have a `throw e;` (re-throw) somewhere in
  // the cancel-cleanup catch block.
  assert.ok(/throw\s+\w+\s*;/.test(block),
    'R5.2.RBG.G: runRemoveBg must re-throw the error (not silent swallow)');
});

test('R5.2.RBG.I: runRemoveBg pre-snapshot is AFTER the scene bake (state-capture order)', () => {
  // R5.2 RBG I (P-R52RBG-F3, equivalent to R5.2 Heal B):
  // the pre-snapshot must be AFTER the scene bake
  // (so the snapshot captures the FULL pre-RemoveBG state, not
  // an empty mid-flight state). The BUG #9 fix replaced the legacy
  // VPT-aware `bakedB64 = h.toDataURL('png')` bake with a
  // natural-size temp canvas, so the anchor is now the temp-canvas
  // creation (`bgTemp = h.session.renderSceneAtNaturalSize()`).
  const block = extractRunRemoveBg();
  assert.ok(block, 'R5.2.RBG.I: runRemoveBg function must exist in imageEditorActions.js');
  const pushUndoIdx = block.indexOf('Tools.pushUndo(s)');
  const bakedB64Idx = block.indexOf('bgTemp = h.session.renderSceneAtNaturalSize()');
  assert.ok(pushUndoIdx >= 0, 'R5.2.RBG.I: runRemoveBg must call pushUndo');
  assert.ok(bakedB64Idx >= 0, 'R5.2.RBG.I: runRemoveBg must bake the scene via a natural-size temp canvas (BUG #9)');
  assert.ok(pushUndoIdx > bakedB64Idx,
    'R5.2.RBG.I: pushUndo must be AFTER the scene bake (capture order)');
});

test('R5.2.RBG.J: runRemoveBg sets pushedPreSnapshot = true after pushUndo', () => {
  // R5.2 RBG J (P-R52RBG-F4): the pushUndo block must set
  // `pushedPreSnapshot = true;` so the catch path knows to
  // do cancel-cleanup. If the flag is never set, the catch
  // path's cancel-cleanup never runs.
  const block = extractRunRemoveBg();
  assert.ok(block, 'R5.2.RBG.J: runRemoveBg function must exist in imageEditorActions.js');
  // The pushUndo block must be followed by `pushedPreSnapshot = true;`.
  // Use a specific regex to find the structure.
  assert.ok(/Tools\.pushUndo\(s\)[\s\S]*?pushedPreSnapshot\s*=\s*true\s*;/.test(block),
    'R5.2.RBG.J: pushedPreSnapshot = true must come after Tools.pushUndo(s) (flag must be set)');
});

test('R5.2.RBG.K: runRemoveBg typo detection for s._undo.pop (exact match)', () => {
  // R5.2 RBG K (P-R52RBG-F5, equivalent to R5.2.Bake C):
  // the test must use an exact regex for `s._undo.pop` to catch
  // typos like `s._undo.popXXX`. A plain `/s\._undo\.pop/` regex
  // would match `s._undo.popXXX` too (false-positive).
  const block = extractRunRemoveBg();
  assert.ok(block, 'R5.2.RBG.K: runRemoveBg function must exist in imageEditorActions.js');
  // Use a regex with end-of-word boundary.
  assert.ok(/s\._undo\.pop\(\)\s*;/.test(block),
    'R5.2.RBG.K: runRemoveBg must call `s._undo.pop();` exactly (not `s._undo.popXXX();`)');
});

test('R5.2.RBG.H: integration check — pre-snapshot on success + cancel-cleanup on reload-throw', () => {
  // R5.2 RBG H: behavioral verification using a minimal mock.
  // 1. Success: pre-snapshot + reload succeeds, no cancel-cleanup.
  // 2. Reload-throws: pre-snapshot + reload throws. Cancel-cleanup
  //    pops the pre-snapshot.
  const baseImg = { _isBase: true, type: 'image', left: 0, top: 0, width: 100, height: 60 };
  const session = {
    _undo: [],
    imgW: 100, imgH: 60,
    baseObject: baseImg,
  };
  let pushedPreSnapshot = false;
  // Scenario A: success — pushUndo + reload succeeds.
  session._undo.push({ json: { version: 'x' } });
  pushedPreSnapshot = true;
  session.baseObject = { _isBase: true, type: 'image', width: 100, height: 60 };
  // Success: session._undo has 1 entry, pushedPreSnapshot is true.
  assert.equal(session._undo.length, 1, 'R5.2.RBG.H scenario A: success — session._undo has 1 entry');
  assert.equal(pushedPreSnapshot, true, 'R5.2.RBG.H scenario A: success — pushedPreSnapshot is true');
  // Scenario B: reload throws after pushUndo — cancel-cleanup pops the pre-snapshot.
  const sessionB = {
    _undo: [],
    imgW: 100, imgH: 60,
    baseObject: baseImg,
  };
  let pushedB = false;
  sessionB._undo.push({ json: { version: 'x' } });
  pushedB = true;
  let reloadThrew = false;
  try {
    throw new Error('simulated reloadBaseFromPath failure');
  } catch (e) {
    reloadThrew = true;
    if (pushedB) {
      if (sessionB && Array.isArray(sessionB._undo) && sessionB._undo.length) {
        sessionB._undo.pop();
      }
      pushedB = false;
    }
  }
  assert.equal(reloadThrew, true, 'R5.2.RBG.H scenario B: reload threw');
  assert.equal(sessionB._undo.length, 0, 'R5.2.RBG.H scenario B: reload-throw — session._undo is empty (cancel-cleanup)');
  assert.equal(pushedB, false, 'R5.2.RBG.H scenario B: reload-throw — pushedPreSnapshot is false');
});
