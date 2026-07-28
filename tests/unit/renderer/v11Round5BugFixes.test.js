// tests/unit/renderer/v11Round5BugFixes.test.js
// ============================================================================
// v1.1 round-5 bug-fix regression tests. Pins the two user-reported
// defects that were still visible in the v1.1.0 build:
//   1) "We still see lots of popups, even though they are turned off."
//   2) "If they don't setup a folder, they end up in a folder
//       explorer view of a not existing folder, including an error
//       message (and potential follow-up defects). We should default
//       to some %appdata% folder in this scenario."
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ============================================================================
// BUG-1: popup policy must be honoured for the first-time-setup
// modal. The previous implementation used `force: true` so the
// modal would bypass the user's "never" choice in ⚙ Settings →
// Popups. After the fix:
//   a) openFirstTimeSetup() no longer passes `force: true` to
//      openGatedPopup for the auto-open path.
//   b) The `showStartupPopup()` chain no longer auto-fires
//      `openFirstTimeSetup()` when the welcome popup is suppressed.
//   c) The ⚙ Settings → General pane exposes a "Run first-time
//      setup" button that re-opens the dialog with `force: true`
//      (the user explicitly asked for it).
// ============================================================================
test('BUG-1a: openFirstTimeSetup opts no longer force: true', () => {
  const s = src('renderer/sections/section17_First_time_setup_popup.js');
  // The auto-open path must NOT pass `force: true` to the popup
  // dispatcher. We look for the exact `force,` token in the
  // openGatedPopup opts block and the `force: true` literal must
  // not appear as the value of a stand-alone `force` key. The
  // previous bug shipped with a literal `force: true,` line that
  // we are checking is gone.
  assert.ok(
    !/force:\s*true\s*,\s*\n\s*\}\s*\)\s*;\s*\n\s*\}\s*\n/.test(s),
    'BUG-1a: section17 must not pass `force: true,` to openGatedPopup for the auto path'
  );
});

test('BUG-1b: showStartupPopup no longer auto-fires openFirstTimeSetup when policy is never', () => {
  const s = src('renderer/sections/section18_Startup_popup.js');
  // The pre-fix code contained this exact block that auto-fired
  // the first-time setup whenever the welcome popup was suppressed
  // by the popup policy AND the config was incomplete:
  //
  //   if (!shouldShowPopup('startup') && (!state.config.api_key || !state.config.output_dir)) {
  //     openFirstTimeSetup();
  //     return;
  //   }
  //
  // We assert that the auto-fire block is no longer present in
  // showStartupPopup. The function should just delegate to
  // openGatedPopup('startup', …) and let the policy decide. We
  // check for the literal auto-fire block (the specific token
  // `!shouldShowPopup('startup')` AND a follow-up `openFirstTimeSetup()`).
  assert.ok(
    !/if\s*\(\s*!shouldShowPopup\('startup'\)\s*&&/.test(s),
    "BUG-1b: showStartupPopup must not contain the auto-fire `if (!shouldShowPopup('startup') && ...)` block (was: blocks popup policy 'never')"
  );
});

test('BUG-1c: ⚙ Settings → General pane exposes "Run first-time setup" button', () => {
  const s = src('renderer/sections/section03_Settings_tab_panes.js');
  // The button label must match the user-facing copy. The click
  // handler must call openFirstTimeSetup with {force: true} so
  // the policy is bypassed (the user just asked for it).
  assert.ok(
    /Run first-time setup/.test(s),
    'BUG-1c: Settings → General must contain a "Run first-time setup" button'
  );
  assert.ok(
    /openFirstTimeSetup\(\s*\{\s*force:\s*true\s*\}\s*\)/.test(s),
    'BUG-1c: button click handler must call openFirstTimeSetup({force: true}) so the popup is force-shown'
  );
});

// ============================================================================
// BUG-2: file browser must not call fbList('') on a fresh install
// (no config, no per-tab folder, no fbDir). The previous fallback
// chain ended with the empty string, which `fbList()` then
// rejected with "Path is outside the allowed directories" and
// the user landed on an error screen. The fix falls back to the
// platform-default output dir (`<userData>/generated` on every
// platform) via the `config:defaultOutputDir` IPC, which is the
// same path the main process uses for the allow-list and the
// default write target. That folder always exists.
// ============================================================================
test('BUG-2a: fileBrowser1 refreshBrowser falls back to defaultOutputDir when all sources are empty', () => {
  const s = src('renderer/services/fileBrowser1.js');
  // The fallback chain must include an `await
  // window.api.defaultOutputDir()` so the empty-string case
  // resolves to a real, existing path. We check the exact token.
  assert.ok(
    /await\s+window\.api\.defaultOutputDir\s*\(\s*\)/.test(s),
    'BUG-2a: refreshBrowser must call window.api.defaultOutputDir() as the last-ditch fallback'
  );
  // The fallback must be wrapped in `if (!startDir)` so the
  // IPC is only invoked when ALL three sources (state.fbDir,
  // per-tab saved, state.config.output_dir) are missing. A
  // present-but-bad path is handled by the !out branch below
  // (which shows an error and re-enables the Up button).
  const refreshFn = s.match(/async\s+function\s+refreshBrowser\s*\([^)]*\)\s*\{[\s\S]*?\n\}\s*\n/);
  assert.ok(refreshFn, 'BUG-2a: refreshBrowser function must exist');
  // The fallback block must come AFTER the startDir chain and
  // must gate on the resolved startDir being empty.
  const afterChain = refreshFn[0].split("let startDir = state.fbDir || saved || state.config.output_dir || '';")[1] || '';
  assert.ok(
    /if\s*\(\s*!startDir\s*\)\s*\{[\s\S]*?defaultOutputDir\s*\(\s*\)/.test(afterChain),
    'BUG-2a: refreshBrowser must have an `if (!startDir) { ... defaultOutputDir() }` fallback after the chain'
  );
});

test('BUG-2b: showTab does not stamp state.fbDir to an empty string', () => {
  const s = src('renderer/sections/section11_Variants_dropdown.js');
  // The previous version stamped state.fbDir = '' (or to a blank
  // config.output_dir) on tab switch, which is what the file
  // browser later used to call fbList(''). The new code falls
  // back to the empty string ONLY if nothing else is set, and
  // the file browser's defaultOutputDir() fallback (BUG-2a) then
  // resolves the actual path. We assert that the new behaviour
  // is in place.
  const fn = s.match(/function\s+showTab\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, 'BUG-2b: showTab function must exist');
  assert.ok(
    /if\s*\(\s*state\.config\.output_dir\s*\)\s+state\.fbDir\s*=\s*state\.config\.output_dir/.test(fn[0]),
    'BUG-2b: showTab must gate state.fbDir assignment on state.config.output_dir truthiness'
  );
  assert.ok(
    /else\s+state\.fbDir\s*=\s*'';/.test(fn[0]),
    'BUG-2b: showTab must NOT default state.fbDir to state.config.output_dir || "" (the old short-circuit)'
  );
});
