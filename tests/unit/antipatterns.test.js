// Repo-wide guards for bug CLASSES this codebase has demonstrably repeated.
//
// P3 of the post-KGO10 plan. Each guard below is one regex that kills a whole
// category at review time instead of in production. Every one of them
// corresponds to a bug that actually shipped — several of them more than once:
//
//   prompt()            KGO8-001  — Electron does not implement it; it THROWS.
//   sharp(<path>)       KGOOO-1, KGOOO-2, KGO10-001 — leaks a libvips handle
//                                  on webp; the file becomes undeletable.
//   node globals        recurring — the renderer runs with contextIsolation,
//                                  so process/require/__dirname are undefined
//                                  and only blow up when a handler fires.
//   `| tail` exit codes KGOOO-3, KGO7, KGO8 — a pipe reports tail's status, so
//                                  red gates read green. Bit three QA runs.
//   advisory gates      KGO8-003  — a comparison that returns ok:true while
//                                  holding failures cannot ever fail.
//
// The blocking-dialog guard is a RATCHET, not a ban: the remaining alert()/
// confirm() calls are accepted (alert IS implemented in Electron; the one
// confirm is an unreachable fallback), but no NEW ones may appear.
//
// Self-seeded: antipatternsSelfTest.test.js proves each regex actually matches
// its defect. A guard that cannot fail is worthless.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { walkJs, scan: scanFiles, scanWithStrings: scanFilesWithStrings, countPerFile } = require('../helpers/sourceScan');

const ROOT = path.resolve(__dirname, '..', '..');
const scan = (files, re) => scanFiles(ROOT, files, re);
const scanStr = (files, re) => scanFilesWithStrings(ROOT, files, re);

const RENDERER = walkJs(ROOT, 'renderer');
const MAIN_SRC = [...walkJs(ROOT, 'main'), ...walkJs(ROOT, 'src')];
const SCRIPTS = walkJs(ROOT, 'scripts');

// ---------------------------------------------------------------------------
test('antipattern: window.prompt() anywhere in the renderer (Electron THROWS)', () => {
  const hits = scan(RENDERER, /(^|[^.\w$])prompt\s*\(/);
  assert.deepStrictEqual(hits, [],
    'Electron does not implement prompt() — it throws "prompt() is not supported." and the '
    + 'handler dies as an unhandled rejection (KGO8-001 killed the whole danger-zone reset this way). '
    + 'Use window.asyncPrompt(message, expect, title).');
});

// ---------------------------------------------------------------------------
test('antipattern: path-based sharp() read on a caller-owned file', () => {
  // sharp(<x>Path) leaks a libvips handle on webp; sharp(buf) does not.
  // Note `.toFile()` chains do release, but the safe form costs nothing.
  const hits = scan(MAIN_SRC, /\bsharp\(\s*[A-Za-z_$][\w$]*[Pp]ath\s*\)/)
    // Child processes exit after each run, so a handle there dies with them.
    .filter((h) => !/inpaint_node\.js|isnetbg_node\.js/.test(h))
    // realesrgan's ≤8px branch ends in .toFile(), measured not to lock.
    .filter((h) => !/src\/realesrgan\.js/.test(h));
  assert.deepStrictEqual(hits, [],
    'sharp(<path>) keeps the file open (webp decoder), so the caller cannot delete/move it '
    + 'afterwards — EBUSY. This class has shipped THREE times (KGOOO-1, KGOOO-2, KGO10-001). '
    + 'Use sharp(await fsp.readFile(p)).');
});

// ---------------------------------------------------------------------------
test('antipattern: Node globals in the renderer (contextIsolation makes them undefined)', () => {
  const hits = scan(RENDERER, /(^|[^A-Za-z0-9_.$])(process\.(platform|env|cwd|argv|versions)|require\(|__dirname|__filename)/);
  assert.deepStrictEqual(hits, [],
    'The renderer runs with contextIsolation:true — process/require/__dirname are undefined and '
    + 'throw ReferenceError only when that DOM handler fires. Unit tests miss it because the vm '
    + 'sandboxes inject a fake `process`. Route through preload (window.api).');
});

// ---------------------------------------------------------------------------
test('antipattern: `| tail` masking a command exit code in scripts', () => {
  // | tail lives inside string literals (shell commands), so use the
  // string-aware scanner (strips comments only, keeps strings intact).
  const hits = scanStr(SCRIPTS, /\|\s*tail\b/);
  assert.deepStrictEqual(hits, [],
    'A pipeline reports the LAST command\'s status, so `cmd | tail` always looks green. '
    + 'This hid red gates in three QA runs. Capture first: out=$(cmd 2>&1); code=$?');
});

// ---------------------------------------------------------------------------
test('antipattern: a comparison gate that returns ok:true while holding failures', () => {
  const hits = scan(SCRIPTS, /ok:\s*true\s*,\s*advisory/);
  assert.deepStrictEqual(hits, [],
    'An "advisory" gate reports "failed": 0 and prints PASS over a real regression — the visual '
    + 'gate sat green over a measured 24.3 % diff for three rounds (KGO8-003). Make it fail, or '
    + 'skip it explicitly with a printed reason.');
});

// ---------------------------------------------------------------------------
// RATCHET, not a ban. alert() is implemented in Electron (it merely blocks the
// renderer thread) and the single confirm() is an unreachable fallback, so the
// existing calls are accepted. New ones are not: every dialog added from here
// should be a DOM modal (showModal / asyncConfirm / asyncPrompt).
// Counts derived with tests/helpers/sourceScan (comments + string literals
// blanked), NOT with a raw grep — a naive grep over-counted fileBrowser1.js.
const BLOCKING_DIALOG_BASELINE = {
  'renderer/pipeline/pipelineOverlay.js': 1,              // showModal fallback, only if showModal is missing
  'renderer/sections/section03_Settings_tab_panes.js': 4, // reset + archive error paths
  'renderer/widgets/ArchiveViewer.js': 2,                 // delete-failed paths
};
test('antipattern: no NEW blocking alert()/confirm() in the renderer (ratchet)', () => {
  const counts = countPerFile(ROOT, RENDERER, /(^|[^.\w$])(confirm|alert)\s*\(/gm);
  for (const [file, n] of Object.entries(counts)) {
    const allowed = BLOCKING_DIALOG_BASELINE[file] || 0;
    assert.ok(n <= allowed,
      `${file} has ${n} blocking alert()/confirm() call(s), baseline is ${allowed}. `
      + 'Use a DOM modal (showModal / asyncConfirm / asyncPrompt) — a native dialog blocks the '
      + 'renderer thread and cannot be driven by the e2e harness.');
  }
  // Ratchet down: if a file was cleaned up, lower its baseline so it cannot regress.
  for (const [file, allowed] of Object.entries(BLOCKING_DIALOG_BASELINE)) {
    const actual = counts[file] || 0;
    assert.ok(actual >= allowed,
      `${file} now has ${actual} blocking dialog(s) but the baseline still says ${allowed}. `
      + 'Lower the BLOCKING_DIALOG_BASELINE entry — baselines only move down.');
  }
});
