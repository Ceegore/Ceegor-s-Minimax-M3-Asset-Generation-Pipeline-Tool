// tests/unit/renderer/v1129BatchImportStyle.test.js
// v1.1.29: two user-requested changes — both source-pinned here so a
// future refactor can't silently drop them.
//
//   1) When the user changes output_dir in ⚙ Settings (or the
//      first-time-setup popup), the file browser must re-point to
//      the new folder. The fix captures the OLD output_dir from
//      the pre-save state.config snapshot (a local const at the
//      top of the handler), resolves the NEW effective output dir
//      (defaulting to the platform default if the user blanked
//      the field), and navigates the explorer when they differ.
//
//   2) The batch-import dialog gains a combined "Apply a style
//      preset to all items in this batch" option. When the user
//      fills in name + value, the import flow:
//        - saves the preset into the global config.styles list
//          (de-duped by name), so it persists across sessions and
//          shows up in every tab's style dropdown;
//        - stamps `style: <name>` on every imported entry, so the
//          existing BatchGen runner (batchManager.js `item.style`
//          handling) pre-selects the dropdown and prepends the
//          value via buildFinalPrompt when the row generates.
//
// These tests assert the LIVE source so a future refactor that
// silently drops either behaviour fails this test file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', '..', '..', 'renderer', 'sections', 'section04_Settings.js');
const FIRST_TIME_PATH = path.join(__dirname, '..', '..', '..', 'renderer', 'sections', 'section17_First_time_setup_popup.js');
const IMPORT_HELPER_PATH = path.join(__dirname, '..', '..', '..', 'renderer', 'tabs', 'batchImportHelper.js');

const settingsSrc = fs.readFileSync(SETTINGS_PATH, 'utf8');
const firstTimeSrc = fs.readFileSync(FIRST_TIME_PATH, 'utf8');
const importSrc = fs.readFileSync(IMPORT_HELPER_PATH, 'utf8');

function extractHandlerBody(src, marker) {
  // R3.3.AuditFix-PP-2: balanced-brace extraction. The previous
  // non-greedy regex `\}\);` matched the FIRST inner-loop
  // statement-end (e.g. `allErrors.push({...});` inside a
  // for-of), which broke the test whenever the body contained
  // any `for` / `while` with `});` statements. The balanced
  // walker tracks brace depth so we only return at the OUTER
  // `});` that closes the addEventListener handler.
  const startRe = new RegExp(marker + '\\.addEventListener\\(\'click\',\\s*async\\s*\\(\\)\\s*=>\\s*\\{');
  const startM = src.match(startRe);
  if (!startM) throw new Error('handler not found for marker: ' + marker);
  const startIdx = startM.index + startM[0].length;
  let depth = 1;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        // Expect ');' to close the addEventListener call.
        return src.substring(startIdx, i);
      }
    }
  }
  throw new Error('handler body not closed (unbalanced braces) for marker: ' + marker);
}

// --- 1) Output_dir → folder explorer auto-navigate ---

test('settings Save: captures oldOut from pre-save snapshot, resolves effective dirs, and re-points the explorer', () => {
  const body = extractHandlerBody(settingsSrc, 'saveBtn');

  // (a) oldOut must be captured from the pre-save state.config
  // snapshot (a local const at the top of the handler), not from
  // state.config after the post-save reassignment.
  const idxOldOut = body.search(/const\s+oldOut\s*=/);
  const idxAssign = body.search(/state\.config\s*=[^;]*\bsaved\b/);
  assert.ok(idxOldOut >= 0, 'oldOut local const is missing from the settings Save handler');
  assert.ok(idxAssign >= 0, 'state.config = saved assignment is missing');
  assert.ok(idxOldOut < idxAssign,
    'oldOut must be captured BEFORE state.config = saved (pre-save snapshot, not post-assignment)');

  // (b) The handler must resolve the EFFECTIVE output dir for
  // both the new and old state (defaulting to the platform
  // default when the user blanked the field). This is the
  // bug-A2 fix: the explorer must follow the new effective
  // location even when output_dir was cleared.
  const defaultCalls = body.match(/defaultOutputDir\s*\(\s*\)/g) || [];
  assert.ok(defaultCalls.length >= 2,
    'settings Save must call defaultOutputDir() at least twice (once each for newEffective / oldEffective) so a blank output_dir still navigates the explorer to the platform default');

  // (c) state.fbDir and state.fbDirs must be updated from a
  // navigation TARGET (rawNew || newEffective — never the empty
  // string), and BEFORE the actual refreshBrowser() call (not
  // before the word "refreshBrowser()" appearing in a comment).
  // The handler body may reference refreshBrowser in a code
  // comment — find the LAST call site, which is the
  // unconditional `refreshBrowser();` at the end of the
  // handler.
  const idxFbDirAssign = body.search(/state\.fbDir\s*=\s*target/);
  const idxFbDirsLoop = body.search(/for\s*\(\s*const\s+k\s+of\s+Object\.keys\(\s*state\.fbDirs\s*\)\s*\)\s*state\.fbDirs\[k\]\s*=\s*target/);
  // Find every `refreshBrowser()` token in the handler; the
  // last one is the real unconditional call. (Earlier hits are
  // usually inside comments — see the bug-A2 comment that
  // mentions refreshBrowser().)
  const refreshIndices = [];
  const refreshRe = /refreshBrowser\s*\(\s*\)/g;
  let mm;
  while ((mm = refreshRe.exec(body)) !== null) refreshIndices.push(mm.index);
  assert.ok(refreshIndices.length > 0, 'refreshBrowser() call is missing');
  const idxRefresh = refreshIndices[refreshIndices.length - 1];
  assert.ok(idxFbDirAssign >= 0,
    'settings Save must set state.fbDir = target (where target = rawNew || newEffective) when the effective output dir changed');
  assert.ok(idxFbDirsLoop >= 0,
    'settings Save must also set every state.fbDirs[k] = target so a tab switch lands on the new folder');
  assert.ok(idxFbDirAssign < idxRefresh && idxFbDirsLoop < idxRefresh,
    'state.fbDir = target and the state.fbDirs loop must run BEFORE refreshBrowser() — otherwise the new folder is ignored on the first refresh');

  // (d) The branch must be guarded by a change-detection
  // condition (otherwise the explorer would navigate to the
  // same folder on every save).
  const branchMatch = body.match(/if\s*\(\s*norm\s*\(\s*newEffective\s*\)\s*!==\s*norm\s*\(\s*oldEffective\s*\)\s*\)\s*\{([\s\S]*?)\}/);
  assert.ok(branchMatch,
    'settings Save must guard the navigation branch on `if (norm(newEffective) !== norm(oldEffective))` so the explorer only navigates when the effective dir actually changed');
});

test('first-time-setup Save: captures oldOut from pre-save snapshot and re-points the explorer', () => {
  // Same contract for the first-time-setup popup. The fix
  // captures oldOut at the top of the handler (before the
  // setConfig await) and re-points state.fbDir + state.fbDirs
  // when newOut !== oldOut.
  const body = extractHandlerBody(firstTimeSrc, 'save');

  const idxOldOut = body.search(/const\s+oldOut\s*=/);
  const idxAssign = body.search(/state\.config\s*=[^;]*\bresult\.config\b/);
  assert.ok(idxOldOut >= 0, 'oldOut local const is missing from the first-time-setup Save handler');
  assert.ok(idxAssign >= 0, 'state.config = result.config assignment is missing');
  assert.ok(idxOldOut < idxAssign,
    'oldOut must be captured BEFORE state.config = result.config (pre-save snapshot) — this is the bug-A1 fix');

  const idxFbDirAssign = body.search(/state\.fbDir\s*=\s*newOut/);
  const idxFbDirsLoop = body.search(/for\s*\(\s*const\s+k\s+of\s+Object\.keys\(\s*state\.fbDirs\s*\)\s*\)\s*state\.fbDirs\[k\]\s*=\s*newOut/);
  const idxRefresh = body.search(/refreshBrowser\s*\(\s*\)/);
  assert.ok(idxFbDirAssign >= 0,
    'first-time-setup Save must set state.fbDir = newOut when the output_dir changed');
  assert.ok(idxFbDirsLoop >= 0,
    'first-time-setup Save must also set every state.fbDirs[k] = newOut so a tab switch lands on the new folder');
  assert.ok(idxFbDirAssign < idxRefresh && idxFbDirsLoop < idxRefresh,
    'state.fbDir = newOut and the state.fbDirs loop must run BEFORE refreshBrowser()');
});

// --- 2) Batch import: combined style ---

test('batch import: new "apply a style" checkbox + name + value fields are rendered in the summary modal', () => {
  assert.ok(/Apply a style preset to all items in this batch/.test(importSrc),
    'batchImportHelper.js must render the "Apply a style preset to this batch" label in the summary modal');
  assert.ok(/type:\s*'checkbox'/.test(importSrc),
    'batchImportHelper.js must render a checkbox for the "apply style" toggle');
  assert.ok(/Style name \(e\.g\. "Imported batch/.test(importSrc),
    'batchImportHelper.js must render a name input for the new style');
  assert.ok(/Style value — text prepended to every prompt/.test(importSrc),
    'batchImportHelper.js must render a value textarea for the new style');
});

test('batch import: applyStyleToImportedBatch persists the style to the global config (setConfig) and refreshes dropdowns', () => {
  const fnMatch = importSrc.match(/async function applyStyleToImportedBatch\(\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'applyStyleToImportedBatch helper is missing from batchImportHelper.js');
  const body = fnMatch[0];
  assert.ok(/window\.api\.setConfig\(/.test(body),
    'applyStyleToImportedBatch must call window.api.setConfig to persist the style to config.txt');
  assert.ok(/_refreshAllStyleDropdowns/.test(body),
    'applyStyleToImportedBatch must refresh the per-tab <select class="style-select"> dropdowns after saving');
  assert.ok(/return\s+n/.test(body),
    'applyStyleToImportedBatch must return the saved name (so the caller can stamp it on every entry)');
});

test('batch import: stampStyleOnImportedBatch writes style=name on every entry of every type', () => {
  const fnMatch = importSrc.match(/function stampStyleOnImportedBatch\([\s\S]*?\n\}/);
  assert.ok(fnMatch, 'stampStyleOnImportedBatch helper is missing from batchImportHelper.js');
  const body = fnMatch[0];
  assert.ok(/image/.test(body) && /speech/.test(body) && /music/.test(body) && /video/.test(body),
    'stampStyleOnImportedBatch must iterate image/speech/music/video');
  assert.ok(/entry\.style\s*=\s*n/.test(body),
    'stampStyleOnImportedBatch must set entry.style = n for every entry');
  assert.ok(/window\.BatchManager\.stampStyleOnImportedBatch/.test(importSrc),
    'stampStyleOnImportedBatch must be exposed on window.BatchManager');
  assert.ok(/window\.BatchManager\.applyStyleToImportedBatch/.test(importSrc),
    'applyStyleToImportedBatch must be exposed on window.BatchManager');
});

test('batch import: Overwrite and Append handlers both call applyStyleIfRequested and use setCommitButtonsBusy for double-click safety', () => {
  const handlers = importSrc.match(/(overwriteBtn|appendBtn)\.addEventListener\('click',\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/g);
  assert.ok(handlers && handlers.length === 2, 'expected exactly two handlers (overwrite + append) in the import modal');
  for (const h of handlers) {
    assert.ok(/applyStyleIfRequested\s*\(/.test(h),
      'both Overwrite and Append handlers must call applyStyleIfRequested before saveImported');
    assert.ok(/styleCb\.checked\s*&&\s*!applied\s*\)\s*return/.test(h),
      'both handlers must early-return when the user checked the box but applyStyleIfRequested returned "" (validation failed)');
    assert.ok(/setCommitButtonsBusy\s*\(\s*true\s*\)/.test(h),
      'both handlers must disable the commit buttons (Overwrite + Append) at the start of the click body — bug-A5 fix');
    assert.ok(/setCommitButtonsBusy\s*\(\s*false\s*\)/.test(h),
      'both handlers must re-enable the commit buttons (typically in a finally block) on every return path');
  }
});

test('batch import: reconstructParamStr already includes "style" so the queue editor surfaces the attached preset', () => {
  const fnMatch = importSrc.match(/function reconstructParamStr\([\s\S]*?\n\}/);
  assert.ok(fnMatch, 'reconstructParamStr is missing from batchImportHelper.js');
  const body = fnMatch[0];
  const skipMatch = body.match(/const\s+skip\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/);
  assert.ok(skipMatch, 'reconstructParamStr must define a skip Set');
  assert.ok(!/['"]style['"]/.test(skipMatch[1]),
    'reconstructParamStr must NOT skip the "style" key — the queue editor must show --style <name> for imported entries');
});
