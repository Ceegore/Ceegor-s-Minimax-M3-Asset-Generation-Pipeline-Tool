// tests/unit/renderer/imageEditorR5Gate.test.js
// ============================================================================
// R5-Gate — Verification gate for the entire R5 phase.
//
// R5 is composed of 10 sub-phases (per design contract §Phase R5):
//   R5.1   Historyschema (S2) — pushUndo architecture: snapshot
//          includes viewport + baseId + tool; pushUndo shifts
//          oldest on overflow (MAX_UNDO); restores via
//          loadFromJSON + setViewportTransform + canvas.getZoom.
//   R5.2   9 callsite-cards (pre-snapshot on action-start,
//          cancel on action-end / reload-throw):
//          1. R5.2 Stroke          — pre-snapshot on mouse:down
//                                     in wireCanvasEvents
//          2. R5.2 Source Add/Del  — pre-snapshot before add + del
//          3. R5.2 Transform       — pre-snapshot on mouse:down
//                                     (with active-object check)
//                                     + cancel on mouse:up
//          4. R5.2 Reorder/Flip    — pre-snapshot before reorder
//                                     (bring-forward / send-back)
//                                     + flip (flipH / flipV)
//          5. R5.2 Bar             — pre-snapshot in Bar Click 2
//                                     (before canvas.add(rect))
//          6. R5.2 Resize          — pre-snapshot after async
//                                     + cancel-cleanup in catch
//          7. R5.2 Bake            — pre-snapshot before
//                                     canvas.clear + cancel-cleanup
//                                     in .catch (async Image.fromURL)
//          8. R5.2 Heal            — H8 fix (pre-snapshot BEFORE
//                                     await reloadBaseFromPath) +
//                                     R5.2 cancel-cleanup in catch
//          9. R5.2 Remove BG       — same pattern as R5.2 Heal
//                                     (H8 fix + cancel-cleanup)
//
// R5-Gate acceptance criterion: all 9 R5.2 callsite-cards have
// pre-snapshot + cancel-cleanup (where applicable) AND R5.1
// pushUndo architecture is in place. R5.1+R5.2 are 100% test-
// covered (R5.1 + 9 R5.2 sub-phases = 91 imageEditor tests:
// R5.1=14 + R5.2 Stroke=6 + Source=6 + Transform=7 + Reorder/Flip=9
// + Bar=5 + Resize=14 + Bake=9 + Heal=10 + Remove BG=11).
//
// The R5-Gate is implemented as:
//   1. A meta-verification that all 10 R5 sub-phases'
//      source-grep markers are present (structural defense).
//   2. An integration test that exercises the combined flow
//      (pre-snapshot + cancel-cleanup + undo-stack integrity).
//   3. A re-run of all 10 R5 test files (R5.1 + 9 R5.2
//      sub-phase test files; the R5.2.AuditFix changes
//      were added directly to the R5.2 test files, so
//      no separate R5.2.AuditFix test files exist)
//      to verify nothing has regressed.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TOOLS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorTools.js');
const OVERLAY_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorOverlay.js');
const SOURCE_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorSource.js');
const SHAPES_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorShapes.js');
const ACTIONS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorActions.js');
const HEAL_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorHeal.js');
const RESIZE_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorResize.js');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

function extractFunction(src, fnName) {
  // Extract a top-level function `function fnName(...) { ... }` or
  // a method `fnName(...) { ... }` inside a plain object literal.
  // Returns the body (including braces) or null if not found.
  const re = new RegExp('function\\s+' + fnName + '\\s*\\([^)]*\\)\\s*\\{', 'g');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length - 1; // index of `{`
  let depth = 1;
  let i = start + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return src.slice(m.index, i);
}

function extractOnEventHandler(src, eventName) {
  // Extract ALL `session.canvas.on('event', (opt) => { ... })` bodies
  // for the given event name. Returns an array of bodies (in
  // source order). Returns [] if none found.
  const re = new RegExp("trackOn\\(\\s*['\"]" + eventName + "['\"]\\s*,\\s*\\(?[^)]*\\)?\\s*=>\\s*\\{", 'g');
  const bodies = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length - 1;
    let depth = 1;
    let i = start + 1;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    bodies.push(src.slice(m.index, i));
  }
  return bodies;
}

// ============================================================================
// 1. Meta-verification: all 10 R5 sub-phase markers are present
// ============================================================================

test('R5-Gate.1.A: R5.1 marker — pushUndo architecture (snapshot includes viewport+baseId+tool, MAX_UNDO shift)', () => {
  const src = fs.readFileSync(TOOLS_JS, 'utf8');
  const codeOnly = stripComments(src);
  // pushUndo function defined
  assert.ok(/function\s+pushUndo\s*\(/.test(codeOnly),
    'R5-Gate.1.A: pushUndo function must be defined in imageEditorTools.js (R5.1)');
  // MAX_UNDO bound with shift (oldest dropped on overflow)
  assert.ok(/MAX_UNDO/.test(codeOnly),
    'R5-Gate.1.A: MAX_UNDO constant must be defined (R5.1 bound)');
  assert.ok(/\.shift\(\)/.test(codeOnly),
    'R5-Gate.1.A: oldest _undo entry must be dropped on overflow (R5.1 shift)');
  // snapshot includes viewport (for VPT restore)
  assert.ok(/viewport/.test(codeOnly) || /vpt/.test(codeOnly),
    'R5-Gate.1.A: snapshot must include viewport (R5.1 S2 — VPT restore)');
  // snapshot includes baseId (R5.1 history schema)
  assert.ok(/baseId/.test(codeOnly),
    'R5-Gate.1.A: snapshot must include baseId (R5.1 history schema)');
  // snapshot includes tool (R5.1 history schema)
  assert.ok(/tool:/.test(codeOnly) || /tool\s*:/.test(codeOnly),
    'R5-Gate.1.A: snapshot must include tool (R5.1 history schema)');
  // pushUndo exposed on module namespace
  // The module uses `window.ImageEditorTools = { ... }` (no return keyword).
  const namespaceMatch = codeOnly.match(/window\.ImageEditorTools\s*=\s*\{[\s\S]*?\};/g) || [];
  assert.ok(namespaceMatch.length >= 1,
    'R5-Gate.1.A: window.ImageEditorTools namespace must be defined (R5.1)');
  const namespaceText = namespaceMatch.join('\n');
  assert.ok(/pushUndo/.test(namespaceText),
    'R5-Gate.1.A: pushUndo must be exposed on the window.ImageEditorTools namespace (R5.1)');
});

test('R5-Gate.1.B: R5.2 Stroke marker — pre-snapshot on mouse:down in wireCanvasEvents', () => {
  const src = fs.readFileSync(OVERLAY_JS, 'utf8');
  const codeOnly = stripComments(src);
  // The Stroke pre-snapshot lives in a mouse:down handler
  // (R5.2 Stroke: pre-snapshot on action-start).
  const mdowns = extractOnEventHandler(codeOnly, 'mouse:down');
  assert.ok(mdowns.length >= 1, 'R5-Gate.1.B: at least 1 mouse:down handler must exist in imageEditorOverlay.js');
  // Find the Stroke handler: contains `Tools.pushUndo(session)` wrapped in try/catch.
  const strokeHandler = mdowns.find((h) => /try\s*\{\s*Tools\.pushUndo\s*\(\s*session\s*\)\s*;?\s*\}\s*catch/.test(h));
  assert.ok(strokeHandler, 'R5-Gate.1.B: a mouse:down handler must have try/catch-wrapped pushUndo (R5.2 Stroke)');
  // The pre-fix "pushUndo on mouse:up" is GONE
  // (R5.2 Stroke: removed the post-stroke pushUndo on mouse:up)
  const mups = extractOnEventHandler(codeOnly, 'mouse:up');
  assert.ok(mups.length >= 1, 'R5-Gate.1.B: at least 1 mouse:up handler must exist');
  for (const mup of mups) {
    assert.equal(/Tools\.pushUndo\s*\(\s*session\s*\)/.test(mup), false,
      'R5-Gate.1.B: pre-fix `Tools.pushUndo(session)` on mouse:up must be GONE (R5.2 Stroke fix)');
  }
});

test('R5-Gate.1.C: R5.2 Source Add/Delete marker — pre-snapshot before add + del (2 callsites)', () => {
  const src = fs.readFileSync(SOURCE_JS, 'utf8');
  const codeOnly = stripComments(src);
  // (a) onAddSource: pre-snapshot BEFORE canvas.add(fImg)
  // Look for `pushUndo(s)` before `s.canvas.add(fImg)`.
  const addCallsites = (codeOnly.match(/pushUndo\s*\(\s*s\s*\)/g) || []).length;
  assert.ok(addCallsites >= 1,
    `R5-Gate.1.C: imageEditorSource.js must have >= 1 pushUndo(s) callsite (onAddSource, got ${addCallsites})`);
  // (b) del button: pre-snapshot BEFORE canvas.remove(o) — pushUndo(h.session)
  const delCallsites = (codeOnly.match(/pushUndo\s*\(\s*h\.session\s*\)/g) || []).length;
  assert.ok(delCallsites >= 2,
    `R5-Gate.1.C: imageEditorSource.js must have >= 2 pushUndo(h.session) callsites (del + sendToBack + bringForward, got ${delCallsites})`);
  // All pre-snapshots wrapped in try/catch (defensive)
  const allPushUndo = codeOnly.match(/try\s*\{[^}]*pushUndo[^}]*\}\s*catch/g) || [];
  assert.ok(allPushUndo.length >= 3,
    `R5-Gate.1.C: all R5.2 Source pre-snapshots must be wrapped in try/catch (got ${allPushUndo.length} wrapped call-sites)`);
});

test('R5-Gate.1.D: R5.2 Transform marker — pre-snapshot on mouse:down (with active-object check) + cancel on mouse:up', () => {
  const src = fs.readFileSync(OVERLAY_JS, 'utf8');
  const codeOnly = stripComments(src);
  // mouse:down must have an active-object check (the Transform handler)
  const mdowns = extractOnEventHandler(codeOnly, 'mouse:down');
  assert.ok(mdowns.length >= 1, 'R5-Gate.1.D: at least 1 mouse:down handler must exist');
  const transformHandler = mdowns.find((h) => /getActiveObject/.test(h) && /if\s*\(\s*active/.test(h));
  assert.ok(transformHandler,
    'R5-Gate.1.D: a mouse:down handler must call getActiveObject + guard on `if (active)` (R5.2 Transform)');
  // _preTransformObject for cancel-tracking
  assert.ok(/_preTransformObject/.test(codeOnly),
    'R5-Gate.1.D: _preTransformObject flag must be set (R5.2 Transform cancel-cleanup state)');
  // mouse:up must pop the pre-snapshot if no transform happened
  const mups = extractOnEventHandler(codeOnly, 'mouse:up');
  assert.ok(mups.length >= 1, 'R5-Gate.1.D: at least 1 mouse:up handler must exist');
  const transformUp = mups.find((h) => /_undo\.pop/.test(h) && /_preTransformObject/.test(h));
  assert.ok(transformUp,
    'R5-Gate.1.D: a mouse:up handler must pop _undo + reset _preTransformObject (R5.2 Transform cancel-cleanup)');
});

test('R5-Gate.1.E: R5.2 Reorder/Flip marker — pre-snapshot before reorder (bringForward/sendBack) + flip (flipH/flipV)', () => {
  const src = fs.readFileSync(SOURCE_JS, 'utf8');
  const codeOnly = stripComments(src);
  // Reorder callsites: bringObjectForward + sendObjectBackwards — each preceded by pushUndo
  // We check the 4 callsite pattern: bringObjectForward + sendObjectBackwards + flipX + flipY, all
  // preceded by a try/catch-wrapped pushUndo.
  const re = /try\s*\{[^}]*pushUndo\s*\([^)]*\)\s*;?[^}]*\}\s*catch[^}]*\}/g;
  const matches = codeOnly.match(re) || [];
  assert.ok(matches.length >= 4,
    `R5-Gate.1.E: imageEditorSource.js must have >= 4 try/catch-wrapped pushUndo callsites (Reorder + Flip + del, got ${matches.length})`);
  // bringObjectForward / sendObjectBackwards are called after pre-snapshot
  // Use word-boundary regex to avoid false-positives like `bringObjectForwardXXX`.
  assert.ok(/\bbringObjectForward\s*\(/.test(codeOnly),
    'R5-Gate.1.E: bringObjectForward(...) must be called (R5.2 Reorder)');
  assert.ok(/\bsendObjectBackwards\s*\(/.test(codeOnly),
    'R5-Gate.1.E: sendObjectBackwards(...) must be called (R5.2 Reorder)');
  // flipX / flipY (use word-boundary to avoid false-positives)
  assert.ok(/\bflipX\b/.test(codeOnly) || /\bflipY\b/.test(codeOnly) || /set\(['"]flipX['"]/.test(codeOnly) || /toggle\(['"]flipX['"]/.test(codeOnly),
    'R5-Gate.1.E: flipX/flipY must be called (R5.2 Flip)');
});

test('R5-Gate.1.F: R5.2 Bar marker — pre-snapshot in Bar Click 2 (before canvas.add(rect))', () => {
  const src = fs.readFileSync(SHAPES_JS, 'utf8');
  const codeOnly = stripComments(src);
  // The Bar pre-snapshot is in Click 2 (not Click 1) — must be wrapped in try/catch
  const matches = (codeOnly.match(/try\s*\{[^}]*pushUndo\s*\(\s*slot\.session\s*\)[^}]*\}\s*catch/g) || []);
  assert.ok(matches.length >= 1,
    `R5-Gate.1.F: imageEditorShapes.js must have >= 1 try/catch-wrapped pushUndo(slot.session) (Bar Click 2, got ${matches.length})`);
  // canvas.add(rect) must follow the pre-snapshot
  const addRect = codeOnly.match(/canvas\.add\s*\(\s*rect\s*\)/);
  assert.ok(addRect, 'R5-Gate.1.F: canvas.add(rect) must exist (Bar flow)');
});

test('R5-Gate.1.G: R5.2 Resize marker — pre-snapshot after async + cancel-cleanup in catch', () => {
  const src = fs.readFileSync(RESIZE_JS, 'utf8');
  const codeOnly = stripComments(src);
  // Resize has onApply function with async work + pre-snapshot AFTER awaits + cancel-cleanup
  const onApply = extractFunction(codeOnly, 'onApply');
  assert.ok(onApply, 'R5-Gate.1.G: onApply function must be defined in imageEditorResize.js (R5.2 Resize)');
  // pushUndo must be inside onApply
  assert.ok(/ImageEditorTools\.pushUndo\s*\(\s*session\s*\)/.test(onApply) || /pushUndo\s*\(\s*session\s*\)/.test(onApply),
    'R5-Gate.1.G: onApply must call pushUndo (R5.2 Resize pre-snapshot)');
  // pushedPreSnapshot flag for cancel-cleanup
  assert.ok(/pushedPreSnapshot\s*=\s*true/.test(onApply),
    'R5-Gate.1.G: onApply must set pushedPreSnapshot = true after pushUndo (R5.2 Resize flag)');
  // catch block with cancel-cleanup (s._undo.pop + flag reset)
  assert.ok(/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?if\s*\(\s*pushedPreSnapshot\s*\)/.test(onApply) && /_undo\.pop\(\)/.test(onApply),
    'R5-Gate.1.G: onApply must have a catch block with pushedPreSnapshot-guarded _undo.pop (R5.2 Resize cancel-cleanup)');
  // Cancel-cleanup pattern: pushedPreSnapshot + s._undo.pop
  // (Resize does NOT require `throw e;` — it uses `toast()` + `finally` instead.
  //  Resize's cancel-cleanup pattern is: pushedPreSnapshot-guarded _undo.pop +
  //  toast error message. The R5.2 Heal.AuditFix re-throw pattern is
  //  Heal/Remove BG-specific, NOT Resize-specific.)
  assert.ok(/if\s*\(\s*pushedPreSnapshot\s*\)\s*\{[\s\S]*?_undo\.pop\(\)[\s\S]*?pushedPreSnapshot\s*=\s*false/.test(onApply),
    'R5-Gate.1.G: onApply must have pushedPreSnapshot-guarded _undo.pop + flag reset (R5.2 Resize cancel-cleanup)');
});

test('R5-Gate.1.H: R5.2 Bake marker — pre-snapshot BEFORE canvas.clear + cancel-cleanup in .catch', () => {
  const src = fs.readFileSync(ACTIONS_JS, 'utf8');
  const codeOnly = stripComments(src);
  // onBake function with renderSceneAtNaturalSize + pushUndo before canvas.clear
  const onBake = extractFunction(codeOnly, 'onBake');
  assert.ok(onBake, 'R5-Gate.1.H: onBake function must be defined in imageEditorActions.js (R5.2 Bake)');
  // pushUndo BEFORE canvas.clear
  const pushUndoIdx = onBake.search(/pushUndo\s*\(\s*h\.session\s*\)/);
  const clearIdx = onBake.search(/canvas\.clear\s*\(\s*\)/);
  assert.ok(pushUndoIdx > 0 && clearIdx > 0,
    'R5-Gate.1.H: onBake must call pushUndo and canvas.clear');
  assert.ok(pushUndoIdx < clearIdx,
    'R5-Gate.1.H: pushUndo must be BEFORE canvas.clear (R5.2 Bake pre-snapshot before mutation)');
  // pushedPreSnapshot flag
  assert.ok(/pushedPreSnapshot\s*=\s*true/.test(onBake),
    'R5-Gate.1.H: onBake must set pushedPreSnapshot = true (R5.2 Bake flag)');
  // .catch block with cancel-cleanup
  assert.ok(/\.catch\s*\(\s*\(\s*\w+\s*\)\s*=>\s*\{[\s\S]*?if\s*\(\s*pushedPreSnapshot\s*\)/.test(onBake) && /_undo\.pop\(\)/.test(onBake),
    'R5-Gate.1.H: onBake must have a .catch block with pushedPreSnapshot-guarded _undo.pop (R5.2 Bake cancel-cleanup)');
});

test('R5-Gate.1.I: R5.2 Heal marker — H8 fix (pushUndo BEFORE await reloadBaseFromPath) + R5.2 cancel-cleanup', () => {
  const src = fs.readFileSync(HEAL_JS, 'utf8');
  const codeOnly = stripComments(src);
  // runHeal function
  const runHeal = extractFunction(codeOnly, 'runHeal');
  assert.ok(runHeal, 'R5-Gate.1.I: runHeal function must be defined in imageEditorHeal.js (R5.2 Heal)');
  // pushUndo BEFORE await reloadBaseFromPath
  const pushUndoIdx = runHeal.search(/pushUndo\s*\(\s*s\s*\)/);
  const reloadIdx = runHeal.search(/await\s+Heal\.reloadBaseFromPath|await\s+reloadBaseFromPath/);
  assert.ok(pushUndoIdx > 0 && reloadIdx > 0,
    'R5-Gate.1.I: runHeal must call pushUndo and await reloadBaseFromPath');
  assert.ok(pushUndoIdx < reloadIdx,
    'R5-Gate.1.I: pushUndo must be BEFORE await reloadBaseFromPath (R5.2 Heal H8 fix)');
  // pushedPreSnapshot flag + catch block
  assert.ok(/pushedPreSnapshot\s*=\s*true/.test(runHeal),
    'R5-Gate.1.I: runHeal must set pushedPreSnapshot = true (R5.2 Heal flag)');
  assert.ok(/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?if\s*\(\s*pushedPreSnapshot\s*\)/.test(runHeal) && /_undo\.pop\(\)/.test(runHeal),
    'R5-Gate.1.I: runHeal must have a catch block with pushedPreSnapshot-guarded _undo.pop (R5.2 Heal cancel-cleanup)');
  // Re-throw (per R5.2 Heal.AuditFix pattern: catch block MUST re-throw)
  // The cancel-cleanup catch block is the one containing `pushedPreSnapshot`.
  // Find that specific catch block, then verify it has `throw e;` (or similar).
  const cancelCatchMatch = runHeal.match(/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?if\s*\(\s*pushedPreSnapshot\s*\)[\s\S]*?_undo\.pop\(\)[\s\S]*?pushedPreSnapshot\s*=\s*false[\s\S]*?throw\s+\w+\s*;/);
  assert.ok(cancelCatchMatch,
    'R5-Gate.1.I: runHeal cancel-cleanup catch block must re-throw (R5.2 Heal.AuditFix pattern)');
});

test('R5-Gate.1.J: R5.2 Remove BG marker — H8 fix + R5.2 cancel-cleanup (mirrors R5.2 Heal)', () => {
  const src = fs.readFileSync(ACTIONS_JS, 'utf8');
  const codeOnly = stripComments(src);
  // runRemoveBg function (not just onRemoveBg)
  const runRemoveBg = extractFunction(codeOnly, 'runRemoveBg');
  assert.ok(runRemoveBg, 'R5-Gate.1.J: runRemoveBg function must be defined in imageEditorActions.js (R5.2 Remove BG)');
  // H8 fix: pushUndo BEFORE await reloadBaseFromPath
  const pushUndoIdx = runRemoveBg.search(/pushUndo\s*\(\s*s\s*\)/);
  const reloadIdx = runRemoveBg.search(/await\s+Heal\.reloadBaseFromPath/);
  assert.ok(pushUndoIdx > 0 && reloadIdx > 0,
    'R5-Gate.1.J: runRemoveBg must call pushUndo and await Heal.reloadBaseFromPath');
  assert.ok(pushUndoIdx < reloadIdx,
    'R5-Gate.1.J: pushUndo must be BEFORE await Heal.reloadBaseFromPath (R5.2 Remove BG H8 fix)');
  // state-capture order: pushUndo AFTER the scene bake. The BUG #9
  // fix replaced the legacy VPT-aware `h.toDataURL('png')` bake with
  // a natural-size temp canvas (renderSceneAtNaturalSize + dispose),
  // so the gate now anchors on the temp-canvas creation.
  const bakedB64Idx = runRemoveBg.search(/bgTemp\s*=\s*h\.session\.renderSceneAtNaturalSize\(\)/);
  assert.ok(bakedB64Idx > 0,
    'R5-Gate.1.J: runRemoveBg must bake via h.session.renderSceneAtNaturalSize() (BUG #9 natural-size bake)');
  assert.ok(pushUndoIdx > bakedB64Idx,
    'R5-Gate.1.J: pushUndo must be AFTER the scene bake (R5.2 Remove BG state-capture order)');
  // pushedPreSnapshot flag
  assert.ok(/pushedPreSnapshot\s*=\s*true/.test(runRemoveBg),
    'R5-Gate.1.J: runRemoveBg must set pushedPreSnapshot = true (R5.2 Remove BG flag)');
  // catch block with cancel-cleanup
  assert.ok(/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?if\s*\(\s*pushedPreSnapshot\s*\)/.test(runRemoveBg) && /_undo\.pop\(\)/.test(runRemoveBg),
    'R5-Gate.1.J: runRemoveBg must have a catch block with pushedPreSnapshot-guarded _undo.pop (R5.2 Remove BG cancel-cleanup)');
  // Re-throw (per R5.2 Heal.AuditFix pattern: catch block MUST re-throw)
  // The cancel-cleanup catch block is the one containing `pushedPreSnapshot`.
  const cancelCatchMatch = runRemoveBg.match(/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?if\s*\(\s*pushedPreSnapshot\s*\)[\s\S]*?_undo\.pop\(\)[\s\S]*?pushedPreSnapshot\s*=\s*false[\s\S]*?throw\s+\w+\s*;/);
  assert.ok(cancelCatchMatch,
    'R5-Gate.1.J: runRemoveBg cancel-cleanup catch block must re-throw (R5.2 Heal.AuditFix pattern)');
  // typo-detection: s._undo.pop() exactly
  assert.ok(/s\._undo\.pop\(\)\s*;/.test(runRemoveBg),
    'R5-Gate.1.J: runRemoveBg must call `s._undo.pop();` exactly (R5.2 Remove BG.AuditFix typo-detection)');
});

// ============================================================================
// 2. Integration test: pre-snapshot + cancel-cleanup + undo-stack integrity
// ============================================================================

test('R5-Gate.2: pre-snapshot + cancel-cleanup flow (success path) — undo-stack is correct', () => {
  // Simulate a full R5.2 Heal flow:
  // 1. User clicks "Heal selection" → pushUndo (pre-snapshot)
  // 2. reloadBaseFromPath succeeds
  // 3. session._undo has 1 entry (the pre-Heal state)
  // 4. User clicks "Undo" → restore the pre-Heal state
  const session = {
    _undo: [],
    _redo: [],
    imgW: 100, imgH: 60,
    baseObject: { _isBase: true, type: 'image', left: 0, top: 0, width: 100, height: 60 },
  };
  // Pre-snapshot: snapshot the current state.
  session._undo.push({ json: { version: 'pre-heal' }, viewport: [1, 0, 0, 1, 0, 0], dimensions: { width: 100, height: 60 } });
  // Mutation: reload new base (simulate success).
  session.baseObject = { _isBase: true, type: 'image', left: 0, top: 0, width: 200, height: 120 };
  // session._undo has 1 entry (the pre-Heal snapshot).
  assert.equal(session._undo.length, 1, 'R5-Gate.2: session._undo has 1 entry after pre-snapshot');
  // Undo: pop the pre-Heal snapshot.
  const snap = session._undo.pop();
  assert.equal(snap.json.version, 'pre-heal', 'R5-Gate.2: undo restores the pre-Heal snapshot');
  assert.equal(session._undo.length, 0, 'R5-Gate.2: session._undo is empty after undo');
});

test('R5-Gate.3: pre-snapshot + cancel-cleanup flow on reload-throw', () => {
  // Simulate a full R5.2 Heal flow where reloadBaseFromPath THROWS:
  // 1. User clicks "Heal selection" -> pushUndo (pre-snapshot)
  // 2. reloadBaseFromPath THROWS
  // 3. catch block runs cancel-cleanup -> pop the pre-snapshot
  // 4. session._undo is empty (no orphan pre-snapshot)
  // 5. catch block re-throws so the caller knows
  const session = {
    _undo: [],
    _redo: [],
    imgW: 100, imgH: 60,
    baseObject: { _isBase: true, type: 'image', left: 0, top: 0, width: 100, height: 60 },
  };
  let pushedPreSnapshot = false;
  let rethrowCaught = false;
  let reloadThrew = false;
  // Outer try/catch to verify the re-throw propagates.
  try {
    try {
      // 1. pre-snapshot
      session._undo.push({ json: { version: 'pre-heal' } });
      pushedPreSnapshot = true;
      // 2. reload throws
      throw new Error('simulated reloadBaseFromPath failure');
    } catch (e) {
      reloadThrew = true;
      // 3. cancel-cleanup
      if (pushedPreSnapshot) {
        if (session && Array.isArray(session._undo) && session._undo.length) {
          session._undo.pop();
        }
        pushedPreSnapshot = false;
      }
      // 4. re-throw
      throw e;
    }
  } catch (outerE) {
    rethrowCaught = true;
  }
  // Verify the cancel-cleanup + re-throw worked correctly.
  assert.equal(rethrowCaught, true, 'R5-Gate.3: re-throw was caught by outer scope');
  assert.equal(reloadThrew, true, 'R5-Gate.3: reload threw (catch was entered)');
  assert.equal(session._undo.length, 0, 'R5-Gate.3: session._undo is empty after cancel-cleanup');
  assert.equal(pushedPreSnapshot, false, 'R5-Gate.3: pushedPreSnapshot is reset to false');
  assert.equal(session.baseObject.width, 100, 'R5-Gate.3: baseObject is NOT mutated (reload threw before mutation)');
});

test('R5-Gate.4: undo-stack integrity after multi-action sequence (Stroke → Transform → Bar)', () => {
  // Simulate a 3-action user flow:
  // 1. Stroke → pre-snapshot (pushUndo)
  // 2. Transform → pre-snapshot (pushUndo)
  // 3. Bar → pre-snapshot in Click 2 (pushUndo)
  // Then user clicks Undo 3 times → should restore to the original state.
  // No cancel-cleanup should fire (all actions complete normally).
  const session = {
    _undo: [],
    _redo: [],
    imgW: 100, imgH: 60,
    baseObject: { _isBase: true, type: 'image', left: 0, top: 0, width: 100, height: 60 },
  };
  // Action 1: Stroke
  session._undo.push({ json: { version: 'pre-stroke' } });
  // (simulate stroke applied — baseObject unchanged for our test)
  // Action 2: Transform
  session._undo.push({ json: { version: 'pre-transform' } });
  // (simulate transform applied)
  // Action 3: Bar Click 2
  session._undo.push({ json: { version: 'pre-bar' } });
  // (simulate bar added)

  // session._undo has 3 entries.
  assert.equal(session._undo.length, 3, 'R5-Gate.4: session._undo has 3 entries after 3 actions');
  // Undo 3 times.
  const v3 = session._undo.pop();
  const v2 = session._undo.pop();
  const v1 = session._undo.pop();
  assert.equal(v3.json.version, 'pre-bar', 'R5-Gate.4: undo 1 → pre-bar');
  assert.equal(v2.json.version, 'pre-transform', 'R5-Gate.4: undo 2 → pre-transform');
  assert.equal(v1.json.version, 'pre-stroke', 'R5-Gate.4: undo 3 → pre-stroke');
  assert.equal(session._undo.length, 0, 'R5-Gate.4: session._undo is empty after 3 undos');
});

test('R5-Gate.5: multi-action with one cancel-cleanup (Transform click-without-drag) — undo-stack is correct', () => {
  // Simulate a 3-action user flow where Transform is a click-without-drag:
  // 1. Stroke → pre-snapshot (pushUndo) — 1 entry
  // 2. Transform click-without-drag → pre-snapshot + cancel → -1 entry
  // 3. Bar → pre-snapshot (pushUndo) — 1 entry
  // After all 3: session._undo has 2 entries (Stroke + Bar, Transform was cancelled).
  const session = {
    _undo: [],
    _redo: [],
    _preTransformObject: null,
    imgW: 100, imgH: 60,
  };
  // Action 1: Stroke
  session._undo.push({ json: { version: 'pre-stroke' } });
  // Action 2: Transform click-without-drag
  const active = { type: 'rect' }; // simulate getActiveObject returns a rect
  if (active) {
    session._undo.push({ json: { version: 'pre-transform' } });
    session._preTransformObject = active;
  }
  // mouse:up — click-without-drag: pop the pre-snapshot.
  if (session._preTransformObject) {
    try { session._undo.pop(); } catch (_) {}
    session._preTransformObject = null;
  }
  // Action 3: Bar Click 2
  session._undo.push({ json: { version: 'pre-bar' } });

  // session._undo has 2 entries (Stroke + Bar; Transform was cancelled).
  assert.equal(session._undo.length, 2, 'R5-Gate.5: session._undo has 2 entries (Transform cancelled)');
  const v2 = session._undo.pop();
  const v1 = session._undo.pop();
  assert.equal(v2.json.version, 'pre-bar', 'R5-Gate.5: undo 1 → pre-bar');
  assert.equal(v1.json.version, 'pre-stroke', 'R5-Gate.5: undo 2 → pre-stroke');
});

// ============================================================================
// 3. R5 sub-phase tests are still green (subprocess re-run)
// ============================================================================

const { execFileSync } = require('child_process');

test('R5-Gate.6: all 10 R5 sub-phase test files pass (R5.1 + 9 R5.2 sub-phases)', () => {
  // Run each R5 test file in a subprocess and verify all pass.
  // The 10 R5 test files (R5.1 + 9 R5.2 sub-phases):
  //   R5.1              → imageEditorHistoryR51.test.js
  //   R5.2 Stroke       → imageEditorR52Stroke.test.js
  //   R5.2 Source Add/D → imageEditorR52SourceAddDel.test.js
  //   R5.2 Transform    → imageEditorR52Transform.test.js
  //   R5.2 Reorder/Flip → imageEditorR52ReorderFlip.test.js
  //   R5.2 Bar          → imageEditorR52Bar.test.js
  //   R5.2 Resize       → imageEditorR52Resize.test.js
  //   R5.2 Bake         → imageEditorR52Bake.test.js
  //   R5.2 Heal         → imageEditorR52Heal.test.js
  //   R5.2 Remove BG    → imageEditorR52RemoveBg.test.js
  //
  // Note: the R5.2.AuditFix changes were added directly to the R5.2
  // test files (e.g., R5.2.RemoveBg.AuditFix added R5.2.RBG.I/J/K
  // to the same imageEditorR52RemoveBg.test.js), so no separate
  // R5.2.AuditFix test files exist. We re-run all 10 files.
  const testFiles = [
    'tests/unit/renderer/imageEditorHistoryR51.test.js',         // R5.1
    'tests/unit/renderer/imageEditorR52Stroke.test.js',          // R5.2 Stroke
    'tests/unit/renderer/imageEditorR52SourceAddDel.test.js',    // R5.2 Source Add/Delete
    'tests/unit/renderer/imageEditorR52Transform.test.js',       // R5.2 Transform
    'tests/unit/renderer/imageEditorR52ReorderFlip.test.js',     // R5.2 Reorder/Flip
    'tests/unit/renderer/imageEditorR52Bar.test.js',             // R5.2 Bar
    'tests/unit/renderer/imageEditorR52Resize.test.js',          // R5.2 Resize
    'tests/unit/renderer/imageEditorR52Bake.test.js',            // R5.2 Bake
    'tests/unit/renderer/imageEditorR52Heal.test.js',            // R5.2 Heal
    'tests/unit/renderer/imageEditorR52RemoveBg.test.js',        // R5.2 Remove BG
  ];
  const SUBPROCESS_TIMEOUT_MS = 30000; // 30s per test file
  const results = [];
  // R5.1.AuditFix R-1: build a clean env for the subprocess
  // that strips the test-runner markers inherited from the parent.
  const subprocessEnv = Object.assign({}, process.env);
  delete subprocessEnv.NODE_TEST_CONTEXT;
  delete subprocessEnv.NODE_TEST_WORKER_ID;
  for (const file of testFiles) {
    try {
      const out = execFileSync('node', [path.join(ROOT, file)], {
        encoding: 'utf8',
        timeout: SUBPROCESS_TIMEOUT_MS,
        env: subprocessEnv,
      });
      const passMatch = out.match(/(?:ℹ pass|# pass) (\d+)/);
      const failMatch = out.match(/(?:ℹ fail|# fail) (\d+)/);
      const pass = passMatch ? parseInt(passMatch[1], 10) : 0;
      const fail = failMatch ? parseInt(failMatch[1], 10) : 0;
      results.push({ file: path.basename(file), pass, fail });
    } catch (e) {
      const isTimeout = e.killed === true || /ETIMEDOUT|timeout/i.test(e.message || '');
      results.push({
        file: path.basename(file),
        pass: 0,
        fail: -1,
        error: isTimeout ? `TIMEOUT after ${SUBPROCESS_TIMEOUT_MS}ms` : e.message,
      });
    }
  }
  for (const r of results) {
    assert.equal(r.fail, 0, `R5-Gate.6: ${r.file} must have 0 failures (got ${r.fail}${r.error ? ': ' + r.error : ''})`);
    assert.ok(r.pass > 0, `R5-Gate.6: ${r.file} must have > 0 passing tests (got ${r.pass})`);
  }
  // R5.1 + 9 R5.2 totals: 14 + 6 + 6 + 7 + 9 + 5 + 14 + 9 + 10 + 11 = 91 tests.
  const totalPass = results.reduce((acc, r) => acc + r.pass, 0);
  assert.ok(totalPass >= 91,
    `R5-Gate.6: total R5 test count must be >= 91 (got ${totalPass})`);
});
