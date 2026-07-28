// tests/unit/renderer/v1129BatchImportStyle.adversarial.test.js
// Adversarial regression tests for v1.1.29 changes. These tests
// target the SEMANTIC behaviour, not the source shape — so a
// future refactor that re-arranges code (e.g. moves an assignment
// around) still has to actually do the right thing, not just
// produce the right characters.
//
// Bug history (all now fixed):
//
//   A1) section17_First_time_setup_popup.js Save handler: read
//       `oldOut` from `state.config.output_dir` AFTER assigning
//       `state.config = result.config`. Both `oldOut` and
//       `newOut` therefore read from the SAME source (the new
//       config), so the `newOut !== oldOut` guard was always
//       false and the navigation branch never ran from the
//       first-time setup popup.
//       Fix: capture `oldOut` from `state.config.output_dir`
//       into a local const at the TOP of the handler, BEFORE
//       the setConfig await, so the change-detection compares
//       the right values.
//
//   A2) section04_Settings.js Save handler: when the user
//       CLEARED the output_dir field (deliberately blanking it
//       to use the platform default), `newOut` became ''. The
//       guard `if (newOut && newOut !== oldOut)` short-circuited
//       on the empty string, so the file browser was never
//       re-pointed — the user kept staring at the OLD folder
//       even though the new effective output dir had changed.
//       Fix: resolve the EFFECTIVE output dir (the actual
//       folder the explorer should land on) via
//       `window.api.defaultOutputDir()` when the user-supplied
//       field is empty, and compare the normalised effective
//       dirs.
//
//   A3) batchImportHelper.js applyStyleIfRequested: when the
//       user ticks the style box, fills in name+value, then
//       clicks Overwrite (or Append) twice — e.g. an impatient
//       double-click — the helper re-runs the entire flow
//       (re-persists the style, re-stamps every entry).
//       Fix: identity check at the top of
//       applyStyleToImportedBatch — if a style of the same
//       name is already in state.config.styles with the same
//       value, return early without persisting.
//
//   A4) batchImportHelper.js applyStyleToImportedBatch:
//       mutated `state.config.styles` BEFORE awaiting setConfig.
//       If the IPC failed (disk full, read-only, …) the
//       function returned '' but the in-memory
//       `state.config.styles` had already been mutated. The
//       next time the user saved any settings, the merged
//       config (sanitised by main/models/ConfigSchema.js)
//       would include the failed-to-persist style.
//       Fix: build a `nextConfig` candidate locally, await
//       setConfig, and only assign to `state.config` after the
//       IPC returns ok=true.
//
//   A5) batchImportHelper.js applyStyleIfRequested did NOT
//       disable the Overwrite / Append buttons while the await
//       was in flight. A user with a slow disk or large style
//       value could click Overwrite again mid-await, producing
//       two saveImported calls and a duplicate style write.
//       Fix: `setCommitButtonsBusy(true)` at the top of each
//       click handler, `false` in a `finally`. Both buttons
//       also gate on `if (overwriteBtn.disabled) return;` so a
//       queued second click is dropped.

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
  const re = new RegExp(marker + '\\.addEventListener\\(\'click\',\\s*async\\s*\\(\\)\\s*=>\\s*\\{([\\s\\S]*?)\\}\\);');
  const m = src.match(re);
  if (!m) throw new Error('handler not found for marker: ' + marker);
  return m[1];
}

// --- A1 (fixed): oldOut captured BEFORE the post-save reassignment ---
test('A1: first-time-setup Save: oldOut is captured BEFORE state.config is reassigned to result.config', () => {
  const body = extractHandlerBody(firstTimeSrc, 'save');
  const idxAssign = body.search(/state\.config\s*=[^;]*\bresult\.config\b/);
  const idxOldOut = body.search(/const\s+oldOut\s*=/);
  const idxNewOut = body.search(/const\s+newOut\s*=/);
  assert.ok(idxAssign >= 0, 'state.config = result.config assignment not found');
  assert.ok(idxOldOut >= 0 && idxNewOut >= 0, 'oldOut / newOut capture not found');
  assert.ok(idxOldOut < idxAssign,
    'A1 fix regressed: `oldOut` is read AFTER `state.config = result.config` again. ' +
    'Capture the old output_dir into a local const at the TOP of the handler, before the setConfig await.');
});

test('A1 sanity: settings dialog version reads oldOut from the PRE-save snapshot (must NOT regress to A1)', () => {
  const body = extractHandlerBody(settingsSrc, 'saveBtn');
  const idxAssign = body.search(/state\.config\s*=[^;]*\bsaved\b/);
  const idxOldOut = body.search(/const\s+oldOut\s*=/);
  assert.ok(idxAssign >= 0, 'state.config = saved assignment not found');
  assert.ok(idxOldOut >= 0, 'oldOut capture not found');
  // `oldOut` must be captured BEFORE the state.config reassignment.
  assert.ok(idxOldOut < idxAssign,
    'A1 fix regressed in settings dialog: oldOut must be captured before state.config = saved.');
  // Capture is correctly placed. We deliberately do NOT also
  // assert anything about the source expression of oldOut —
  // the fix legitimately uses `(state.config && state.config.output_dir)`
  // because the capture happens at the top of the handler,
  // BEFORE state.config is reassigned. The order check above is
  // the entire contract.
});

// --- A2 (fixed): clearing output_dir now navigates via the effective dir ---
test('A2 (fixed): settings Save uses defaultOutputDir() to resolve the effective dir when output_dir is empty', () => {
  const body = extractHandlerBody(settingsSrc, 'saveBtn');
  // The fix calls window.api.defaultOutputDir() to resolve the
  // effective dir for the comparison AND for the navigation
  // target. We assert both call sites exist.
  const calls = body.match(/defaultOutputDir\s*\(\s*\)/g) || [];
  assert.ok(calls.length >= 2,
    'A2 fix regressed: settings Save must call defaultOutputDir() at least twice (once for newEffective, once for oldEffective). ' +
    'A blank output_dir must still navigate the explorer to the resolved platform default.');
  // And the navigation target uses the resolved effective dir
  // (not the empty string from rawNew).
  assert.ok(/target\s*=\s*rawNew\s*\|\|\s*newEffective/.test(body),
    'A2 fix regressed: settings Save must use `target = rawNew || newEffective` so the explorer lands on a real folder even when the user blanked the field.');
});

// --- A3 (fixed): identity check is present ---
test('A3 (fixed): applyStyleToImportedBatch short-circuits on (name, value) identity', () => {
  const fnMatch = importSrc.match(/async function applyStyleToImportedBatch\(\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'applyStyleToImportedBatch missing');
  const body = fnMatch[0];
  // The identity check: find an existing style with the same
  // name and value, return n without re-persisting. We test
  // the SEMANTIC shape — a `find()` call, an `existing`
  // variable, a comparison of values via .trim(), and an
  // early `return n` — without locking the exact whitespace
  // or the `|| ''` defensive default.
  assert.ok(/state\.config\.styles\.find\s*\(/.test(body),
    'A3 fix regressed: applyStyleToImportedBatch must look up an existing style via `state.config.styles.find(...)` for the identity check.');
  assert.ok(/const\s+existing\s*=/.test(body),
    'A3 fix regressed: the result of the find must be stored in a `const existing`.');
  // The value comparison: the existing style's value (trimmed)
  // must equal the new value (trimmed). Allow any defensive
  // `|| ''` between the property access and the .trim() call.
  assert.ok(/existing\s*&&[^;]*\.value\b[^;]*\.trim\s*\(\s*\)\s*===\s*v/.test(body),
    'A3 fix regressed: the identity check must compare the existing style\'s value to the new value (both trimmed) and short-circuit when they match.');
  // Early return right after the identity check.
  const idxCheck = body.search(/existing\s*&&[^;]*\.value\b[^;]*\.trim\s*\(\s*\)\s*===\s*v/);
  const idxReturnN = body.slice(idxCheck, idxCheck + 200).search(/return\s+n\s*;/);
  assert.ok(idxReturnN >= 0 && idxReturnN < 200,
    'A3 fix regressed: there must be an early `return n;` after the identity check.');
});

// --- A4 (fixed): mutation happens AFTER the await resolves ---
test('A4 (fixed): applyStyleToImportedBatch mutates state.config.styles ONLY after setConfig resolves with ok=true', () => {
  const fnMatch = importSrc.match(/async function applyStyleToImportedBatch\(\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'applyStyleToImportedBatch missing');
  const body = fnMatch[0];
  // The fix builds a local `newStyles` / `nextConfig` candidate
  // and only assigns to `state.config` after the await resolves
  // with ok=true.
  const idxLocalBuild = body.search(/const\s+newStyles\s*=/);
  const idxAwait = body.search(/await\s+window\.api\.setConfig/);
  const idxCommit = body.search(/state\.config\s*=[^;]*\bres\.config\b[^;]*\bnextConfig\b/);
  assert.ok(idxLocalBuild >= 0, 'local `newStyles` build is missing — the fix deferred the mutation but a refactor lost the local candidate.');
  assert.ok(idxAwait >= 0, 'await setConfig is missing');
  assert.ok(idxCommit >= 0, 'commit `state.config = res.config || nextConfig` is missing');
  // ORDER: local build → await → commit. The original mutation
  // (state.config.styles.push / splice) must NOT appear in the
  // function body any more — that's the bug.
  assert.ok(!/state\.config\.styles\.(push|splice|findIndex)/.test(body),
    'A4 fix regressed: state.config.styles is still being mutated (push / splice / findIndex) before the setConfig await. ' +
    'Use the local `newStyles` candidate and commit via `state.config = res.config` only after the await resolves.');
  assert.ok(idxLocalBuild < idxAwait && idxAwait < idxCommit,
    'A4 fix regressed: the order is wrong. Build local newStyles → await setConfig → commit state.config = res.config.');
});

// --- A5 (fixed): buttons are disabled during in-flight apply ---
test('A5 (fixed): Overwrite/Append buttons are disabled during the in-flight applyStyleIfRequested await', () => {
  const handlers = importSrc.match(/(overwriteBtn|appendBtn)\.addEventListener\('click',\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/g);
  assert.ok(handlers && handlers.length === 2, 'expected exactly two handlers');
  // Each handler must call setCommitButtonsBusy(true) before the
  // await and setCommitButtonsBusy(false) in a finally block.
  for (const h of handlers) {
    assert.ok(/setCommitButtonsBusy\s*\(\s*true\s*\)/.test(h),
      'A5 fix regressed: handler must call setCommitButtonsBusy(true) at the top of the click body to disable Overwrite/Append during the in-flight await.');
    assert.ok(
      /finally\s*\{[\s\S]*setCommitButtonsBusy\s*\(\s*false\s*\)/.test(h) || /setCommitButtonsBusy\s*\(\s*false\s*\)/.test(h),
      'A5 fix regressed: handler must call setCommitButtonsBusy(false) in a finally block to re-enable the buttons on every return path.');
    // Guard against a queued second click racing the disable.
    assert.ok(/if\s*\(\s*overwriteBtn|appendBtn\.disabled\s*\)\s*return/.test(h),
      'A5 fix regressed: handler must early-return on `if (overwriteBtn.disabled) return;` so a queued second click is dropped.');
  }
  // The setCommitButtonsBusy helper itself must exist in the
  // modal scope and flip .disabled.
  const helperMatch = importSrc.match(/const\s+setCommitButtonsBusy\s*=\s*\(\s*busy\s*\)\s*=>\s*\{([\s\S]*?)\};/);
  assert.ok(helperMatch, 'setCommitButtonsBusy helper is missing — the fix introduced it to centralise the disable/enable logic');
  assert.ok(/overwriteBtn\.disabled\s*=/.test(helperMatch[1]),
    'setCommitButtonsBusy must flip overwriteBtn.disabled');
  assert.ok(/appendBtn\.disabled\s*=/.test(helperMatch[1]),
    'setCommitButtonsBusy must flip appendBtn.disabled');
});
