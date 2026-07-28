// tests/unit/renderer/v11Round6BugFixes.test.js
// ============================================================================
// v1.1 round-6 bug-fix regression tests. Pins every defect the user
// reported after the v1.1.0 build went out:
//   1) "OK buttons are not needed actually, as long as the tool reads
//       the typed values after starting generation." — the OK button
//       on the number kind SILENTLY rewrote a typed value of 10 to
//       4 (the dropdown's max) without showing a clear toast. The
//       OK button has been removed from both kinds; typed values
//       flow through to Generate unchanged.
//   2) "--n > 1 always fails with -1" — image generation with
//       --n 2 returned code -1 from the IPC. findInvalidMmxPath
//       accepted the argv; the actual mmx call also succeeded.
//       The fix is the path validator: --out-dir's value MUST be
//       on the allow-list, AND when the user's output_dir doesn't
//       exist the renderer must fall back to the defaultOutputDir
//       (already covered by BUG-2; this test ensures it stays).
//   3) "ENOENT if no path was setup during initial setup" — the
//       file browser used to surface an ENOENT toast when the
//       user's output_dir was set but the folder didn't exist
//       (a drive unmounted between launches, or a hand-typed
//       path that was never created). The fix adds a
//       defaultOutputDir fallback after the first list failure.
//   4) "Up one level button has no functionality (except
//       triggering the popup)" — the Up button had a
//       `data-help-topic` attribute, so the click delegation
//       caught the click and opened a help popup. The
//       file-browser navigation handler still ran (it was
//       attached on the same element) BUT in some sessions
//       (state.fbDir empty) the handler bailed out and the
//       popup was the only visible feedback. Two fixes: remove
//       `data-help-topic` from the Up button, and handle the
//       empty-fbDir case by jumping to output_dir / drives.
//   5) "ddm --voice is defective and shown only as text" —
//       populateVoices was passed the wrapper DIV (not the inner
//       <select>), so `sel.innerHTML = ''` / `appendChild(...)`
//       were no-ops. The <select> kept its single placeholder
//       option and the user saw all three voices as inline text.
//       Fix: pass voice.input.el (the inner <select>).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ============================================================================
// BUG-R6-01: ParamRow number kind has NO OK button. Typed values flow
// through to Generate unchanged. The 50/50 layout (dropdown shrinks to
// 50%, text input takes the other 50%) is preserved via the wrapper
// class `number-custom-active`.
// ============================================================================
test('BUG-R6-01a: ParamRow number kind no longer creates an OK button', () => {
  const s = src('renderer/components/ParamRow.js');
  // The number-kind code path must NOT create a button element.
  // (We grep for the specific construction pattern used pre-v1.1.17.)
  assert.ok(
    !/numOkBtn\s*=\s*el\(/.test(s),
    'BUG-R6-01a: number kind must NOT create a numOkBtn (user reported: "OK buttons are not needed actually, as long as the tool reads the typed values after starting generation")'
  );
  // The number-kind wrapper must be the two-element [sel, num] form.
  // Locate the wrapper creation line directly.
  assert.ok(
    /\[sel, num\]/.test(s),
    'BUG-R6-01a: number-kind wrapper must contain only [sel, num] (no OK button)'
  );
});

test('BUG-R6-01b: ParamRow enum kind has NO OK button either', () => {
  const s = src('renderer/components/ParamRow.js');
  // The enum-kind code path must NOT create an OK button.
  assert.ok(
    !/okBtn\s*=\s*el\(/.test(s),
    'BUG-R6-01b: enum kind must NOT create an okBtn (user-reported: "OK buttons are not needed actually")'
  );
  // The enum wrapper must contain only [sel, text].
  assert.ok(
    /\[sel, text\]/.test(s),
    'BUG-R6-01b: enum-kind wrapper must contain only [sel, text] (no OK button)'
  );
});

test('BUG-R6-01c: number kind getValue() returns the typed value unchanged (no silent clamp)', () => {
  const s = src('renderer/components/ParamRow.js');
  // The number-kind getValue must just return num.value when the
  // dropdown is on "Custom…". No clamp, no min/max override, no
  // replace-with-max. The previous version had a separate OK button
  // handler that did `num.value = String(def.max)` on overflow.
  const getValue = s.match(/if \(sel\.value === ['"]__custom__['"]\)\s*return\s*num\.value;\s*\n\s*return\s*sel\.value;/);
  assert.ok(getValue, 'BUG-R6-01c: number kind getValue must return num.value in Custom mode (the typed value, unmodified)');
});

test('BUG-R6-01d: number kind input is type=number (so the browser can still display up/down)', () => {
  const s = src('renderer/components/ParamRow.js');
  // The pre-v1.1.17 OK-button clamp had a side benefit: the
  // min/max/step were advertised on the input so the browser
  // showed the spinner hints. Preserve that affordance: the inner
  // input is still type=number with min/max/step. We removed the
  // *clamping* (which silently rewrote the typed value); we kept
  // the visual hint (so the user sees the supported range).
  assert.ok(
    /type:\s*['"]number['"][\s\S]{0,200}?max:\s*def\.max/.test(s),
    'BUG-R6-01d: number-kind inner input must still advertise max: def.max as a hint (visual only — we no longer clamp)'
  );
});

// ============================================================================
// BUG-R6-02: --n > 1 must produce a valid argv and reach runMmx. The
// path validator (findInvalidMmxPath) must accept `--n 2 --out-dir
// <user-output>` when <user-output> is on the allow-list, and the
// IPC must NOT short-circuit on --n. We verify by reading the live
// source for the argv construction + the IPC's path check.
// ============================================================================
test('BUG-R6-02a: imageTab uses appendFlag(args, n.input) for --n (no special-casing that drops the value)', () => {
  const s = src('renderer/tabs/imageTab.js');
  // The argv must include appendFlag(args, n.input) — the same
  // helper that every other flag uses, so a user-selected 2 in the
  // --n dropdown flows through verbatim.
  assert.ok(
    /appendFlag\(args, n\.input\)/.test(s),
    'BUG-R6-02a: imageTab must call appendFlag(args, n.input) so the --n value flows into the argv verbatim'
  );
});

test('BUG-R6-02b: findInvalidMmxPath accepts --out-dir value when it equals an allowed root', () => {
  // The validator MUST accept the user's output_dir even if it
  // is exactly the root (not a subdir). isPathUnder handles that
  // case via `pLow === rLow`. The smoke-renderer.js test that
  // --n 2 produces a working build is the behavioural counterpart.
  const s = src('src/pathUtils.js');
  assert.ok(
    /if \(pLow === rLow\) return true;/.test(s),
    'BUG-R6-02b: isPathUnder must treat p === root as a hit (so --out-dir <exact-root> is allowed)'
  );
});

// ============================================================================
// BUG-R6-03: ENOENT on a stale output_dir must fall back to
// defaultOutputDir in the file browser. The file browser must try
// defaultOutputDir AFTER the first fbList failure (not before — we
// still want to honour the user's choice when their output_dir
// exists and lists successfully).
// ============================================================================
test('BUG-R6-03a: fileBrowser1 refreshBrowser falls back to defaultOutputDir after first fbList failure', () => {
  const s = src('renderer/services/fileBrowser1.js');
  // The fallback chain ends with `await window.api.defaultOutputDir()`
  // at TWO points: (a) when the initial startDir is empty (the
  // BUG-2 fix from v1.1.16), and (b) after fbList returns !ok
  // (this fix). Both must be present.
  assert.ok(
    /await\s+window\.api\.defaultOutputDir\s*\(\s*\)/.test(s),
    'BUG-R6-03a: fileBrowser1 must call window.api.defaultOutputDir() as a fallback'
  );
  // The post-failure fallback must come AFTER the fbList call —
  // we don't want to use the default dir when the user's
  // output_dir works fine. Verify the call sequence in the
  // function body.
  const fn = s.match(/async\s+function\s+refreshBrowser\s*\([^)]*\)\s*\{[\s\S]*?\n\}\s*\n/);
  assert.ok(fn, 'BUG-R6-03a: refreshBrowser must be locatable');
  const fbListIdx = fn[0].indexOf('await fbListWithGrant(startDir)');
  const fallbackIdx = fn[0].lastIndexOf('await window.api.defaultOutputDir()');
  assert.ok(fbListIdx >= 0 && fallbackIdx > fbListIdx,
    'BUG-R6-03a: defaultOutputDir fallback must run AFTER the fbList call (so the user\'s working output_dir is honoured first)');
});

// ============================================================================
// BUG-R6-04: Up button must navigate, not just trigger a help popup.
// The button is <button id="fb-up">. It MUST NOT have
// data-help-topic (the help-delegation on document would catch
// every click and open a modal). It MUST still have a click handler
// attached by app.js (the navigation logic).
// ============================================================================
test('BUG-R6-04a: #fb-up has no data-help-topic (so the help delegation does not swallow the click)', () => {
  const s = src('renderer/index.html');
  // Look for the button element. The pre-v1.1.17 line was:
  //   <button id="fb-up" class="btn-mini" title="Up" data-help-topic="sidebar.upBtn">↑</button>
  // We must NOT see `data-help-topic` on the same line as `id="fb-up"`.
  const fbUpLine = s.match(/<button[^>]*id=['"]fb-up['"][^>]*>/);
  assert.ok(fbUpLine, 'BUG-R6-04a: #fb-up button must be in index.html');
  assert.ok(
    !/data-help-topic/.test(fbUpLine[0]),
    'BUG-R6-04a: #fb-up must NOT have data-help-topic (the help-delegation would swallow the click and open a popup)'
  );
});

test('BUG-R6-04b: #fb-up click handler handles empty state.fbDir by jumping to output_dir or drives', () => {
  const s = src('renderer/app.js');
  // The up-button click handler must include the empty-fbDir
  // fallback path that the previous version was missing (it just
  // `return;`-ed, which made the click look like a no-op).
  // v1.1.26: the handler now opens with a logAction() call and
  // is wrapped in a try/catch — multiple `});` are inside the
  // 2000/4000-char window, and non-greedy matching stops at the
  // first one. Use a sentinel: grab the block from the listener
  // registration up to the first `if (!state.fbDir)` line (we
  // test that the branch is reachable).
  const upHandlerIdx = s.indexOf("$('#fb-up').addEventListener('click'");
  assert.ok(upHandlerIdx >= 0, 'BUG-R6-04b: #fb-up click handler must be locatable in app.js');
  const upBranch = s.slice(upHandlerIdx, upHandlerIdx + 4000);
  // The early-return for empty fbDir must be REPLACED by a
  // jump-to-output-dir-or-drives branch.
  assert.ok(
    /if\s*\(\s*!state\.fbDir\s*\)/.test(upBranch),
    'BUG-R6-04b: #fb-up must have a `if (!state.fbDir)` branch (jumping to output_dir or drives list)'
  );
  assert.ok(
    /state\.fbDir\s*=\s*outRoot/.test(upBranch) || /state\.fbDir\s*=\s*FB_DRIVES_SENTINEL/.test(upBranch),
    'BUG-R6-04b: #fb-up empty-state handler must jump to output_dir OR the drives list (so the click is never a no-op)'
  );
});

// ============================================================================
// BUG-R6-05: speechTab populateVoices must be passed voice.input.el
// (the inner <select>), NOT voice.input (the wrapper DIV). The
// wrapper gets innerHTML='' no-op'd; the <select> is left with its
// single placeholder option and the user sees the placeholder
// voices as inline text.
// ============================================================================
test('BUG-R6-05a: speechTab.populateVoices is passed voice.input.el (the inner <select>)', () => {
  const s = src('renderer/tabs/speechTab.js');
  // The call site must read voice.input.el (not voice.input).
  assert.ok(
    /populateVoices\(\s*voice\.input\.el\s*\|\|\s*voice\.input\s*\)/.test(s),
    'BUG-R6-05a: speechTab must call populateVoices(voice.input.el || voice.input) so the inner <select> is populated, not the wrapper DIV'
  );
  // AND must NOT pass only voice.input (the buggy pre-v1.1.17 form).
  assert.ok(
    !/populateVoices\(\s*voice\.input\s*\)\.catch/.test(s),
    'BUG-R6-05a: speechTab must NOT pass only voice.input (pre-v1.1.17 bug — populateVoices called innerHTML= on the wrapper DIV, a no-op)'
  );
});

// ============================================================================
// BUG-R6-06: popup policy must be honoured end-to-end. The user reported
// "we still see popups even if turned off" — we ship the fix and
// pin it so a future regression is caught. We assert on three things:
//   (a) state.js declares popupPolicy default 'never'
//   (b) openGatedPopup gates by shouldShowPopup, not by force
//   (c) showStartupPopup no longer auto-fires openFirstTimeSetup
//       when the welcome popup is suppressed
// ============================================================================
test('BUG-R6-06a: popupPolicy defaults to "never" on a fresh state', () => {
  const s = src('renderer/sections/section24_State.js');
  assert.ok(
    /popupPolicy:\s*['"]never['"]/.test(s),
    'BUG-R6-06a: default state must include popupPolicy: "never"'
  );
});

test('BUG-R6-06b: openGatedPopup gates every popup by the policy (force is opt-in, not default)', () => {
  const s = src('renderer/sections/section18_Startup_popup.js');
  // openGatedPopup's first guard must read `opts && opts.force`
  // and `shouldShowPopup(id)` — that's the policy gate.
  const fn = s.match(/function\s+openGatedPopup\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, 'BUG-R6-06b: openGatedPopup must be locatable');
  assert.ok(
    /if\s*\(\s*!\(\s*opts\s*&&\s*opts\.force\s*\)\s*&&\s*!shouldShowPopup\(id\)\s*\)/.test(fn[0]),
    'BUG-R6-06b: openGatedPopup must check `!(opts && opts.force) && !shouldShowPopup(id)` so every popup is policy-gated'
  );
});

test('BUG-R6-06c: showStartupPopup no longer auto-fires openFirstTimeSetup on a suppressed welcome popup', () => {
  const s = src('renderer/sections/section18_Startup_popup.js');
  // The pre-v1.1.17 / pre-v1.1.16 line was:
  //   if (!shouldShowPopup('startup') && (!state.config.api_key || !state.config.output_dir)) {
  //     openFirstTimeSetup();
  //     return;
  //   }
  // That auto-fire contradicted the "default off" policy.
  assert.ok(
    !/if\s*\(\s*!shouldShowPopup\(['"]startup['"]\)\s*&&\s*\(?\s*!state\.config\.api_key/.test(s),
    'BUG-R6-06c: showStartupPopup must NOT auto-fire openFirstTimeSetup when the welcome popup is suppressed (was: bypassed the popup policy)'
  );
});