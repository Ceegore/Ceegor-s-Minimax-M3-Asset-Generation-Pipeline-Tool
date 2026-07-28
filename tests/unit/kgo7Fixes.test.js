// tests/unit/kgo7Fixes.test.js
// Regression guards for the KGO7 remediation batch (_kgooo7.md).
// Each test names the finding it locks down and states the measured
// behaviour it prevents from coming back.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Several assertions below check that a pattern is ABSENT from the code.
// The fixes deliberately QUOTE the removed code in their explanatory
// comments, so those checks must look at code only.
// NOTE: deliberately strips ONLY whole-line `//` comments. A naive
// block-comment regex is unsafe here: scripts/e2e/harness.js contains the
// literal `'*.js'` inside a line comment, which such a regex reads as the
// start of a block comment and then swallows 1876 characters of real code
// (including the REGISTRARS line this file asserts on). Every comment that
// quotes removed code in this batch is a `//` comment.
const LINE_COMMENT = new RegExp('^\\s*//');
const readCode = (rel) => read(rel)
  .split(/\r?\n/)
  .filter((l) => !LINE_COMMENT.test(l))
  .join('\n');

// ---------------------------------------------------------------------------
// KGO7-003 — a config:set response must NEVER wipe the session-only API key.
//
// Measured before the fix: with "Don't save API key" on, saving a style
// preset from Settings -> Style presets took state.config.api_key from
// 24 chars to 0, and every generation then failed with "No API key
// configured" while the Settings field looked empty.
// ---------------------------------------------------------------------------
function loadAdoptConfig(state) {
  const sandbox = { window: { state }, toast: () => {} };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(read('renderer/utils/ipcResult.js'), sandbox);
  return sandbox.window.adoptConfig;
}

test('KGO7-003: adoptConfig keeps the session key when the privacy switch is on', () => {
  const state = { apiKeyNoSave: true, config: { api_key: 'sk-SESSION-0123456789', theme: 'dark' } };
  const adoptConfig = loadAdoptConfig(state);
  assert.equal(typeof adoptConfig, 'function', 'ipcResult.js must expose window.adoptConfig');
  // The envelope read back from disk has an EMPTY key (by design).
  const fromDisk = { api_key: '', theme: 'light', styles: [{ name: 'x', value: 'y' }] };
  const adopted = adoptConfig(fromDisk);
  assert.equal(adopted.api_key, 'sk-SESSION-0123456789',
    'the session key must survive a save made under the privacy switch');
  assert.equal(adopted.theme, 'light', 'every other field must come from the response');
  assert.equal(adopted.styles.length, 1, 'the saved styles must come from the response');
});

test('KGO7-003: adoptConfig does NOT resurrect a key the user actually cleared', () => {
  // Privacy switch OFF: an empty api_key in the response is a real value.
  const state = { apiKeyNoSave: false, config: { api_key: 'sk-OLD-0123456789' } };
  const adoptConfig = loadAdoptConfig(state);
  assert.equal(adoptConfig({ api_key: '' }).api_key, '',
    'with the privacy switch off, an empty key in the response must win');
});

test('KGO7-003: adoptConfig never downgrades a key the response carries', () => {
  const state = { apiKeyNoSave: true, config: { api_key: 'sk-OLD' } };
  const adoptConfig = loadAdoptConfig(state);
  assert.equal(adoptConfig({ api_key: 'sk-NEW' }).api_key, 'sk-NEW',
    'a non-empty key in the response is authoritative');
});

test('KGO7-003: every state.config = <response>.config site goes through adoptConfig', () => {
  const sites = [
    ['renderer/sections/section03_Settings_tab_panes.js', /state\.config\s*=\s*\(window\.adoptConfig/],
    ['renderer/tabs/batchImportHelper.js', /state\.config\s*=\s*\(window\.adoptConfig/],
    ['renderer/sections/section04_Settings.js', /window\.adoptConfig\s*\?\s*window\.adoptConfig\(saved\)/],
    ['renderer/sections/section17_First_time_setup_popup.js', /window\.adoptConfig\s*\?\s*window\.adoptConfig\(result\.config\)/],
  ];
  for (const [file, re] of sites) {
    assert.match(read(file), re,
      `${file} must adopt the config through adoptConfig (KGO7-003) — a raw assignment wipes the session key`);
  }
});

// ---------------------------------------------------------------------------
// KGO7-006 — a failed privacy scrub must not be announced as "Saved."
// ---------------------------------------------------------------------------
test('KGO7-006: the settings save reads warnings[] and says "Saved with warnings."', () => {
  const src = read('renderer/sections/section04_Settings.js');
  assert.match(src, /result\.warnings/, 'the save handler must read the envelope warnings');
  assert.match(src, /Saved with warnings/, 'a partial failure must not be reported as a plain "Saved."');
  const idxWarn = src.indexOf('const _warnings');
  const idxToast = src.indexOf("toast(_warnings.length ? 'Saved with warnings.'");
  assert.ok(idxWarn >= 0 && idxToast > idxWarn,
    'the warnings must be collected before the success toast decides its wording');
});

// ---------------------------------------------------------------------------
// KGO7-015 — asyncConfirm: same question dedupes, every caller still settles.
// ---------------------------------------------------------------------------

// A DOM stub thin enough to write, real enough to drive section19's OWN
// showModal (the file defines showModal itself, so stubbing it would test
// nothing). asyncConfirm's dedup must hold through the real modal stack.
function makeNode(tag) {
  const node = {
    tag,
    children: [],
    parentNode: null,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    setAttribute() {},
    removeAttribute() {},
    focus() {},
    appendChild(n) { n.parentNode = node; node.children.push(n); return n; },
    remove() {
      if (!node.parentNode) return;
      const i = node.parentNode.children.indexOf(node);
      if (i >= 0) node.parentNode.children.splice(i, 1);
      node.parentNode = null;
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  return node;
}

function makeModalSandbox() {
  const modalRoot = makeNode('div');
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    String,
    JSON,
    Map,
    Set,
    document: {
      addEventListener() {},
      removeEventListener() {},
      activeElement: null,
      contains() { return false; },
      createElement: (t) => makeNode(t),
    },
    el: (tag, attrs, kids) => {
      const node = makeNode(tag);
      node.attrs = attrs || {};
      if (attrs && typeof attrs.onclick === 'function') node.click = attrs.onclick;
      if (Array.isArray(kids)) for (const k of kids) node.appendChild(k);
      else if (kids && typeof kids === 'object') node.appendChild(kids);
      else if (kids != null) node.textContent = String(kids);
      return node;
    },
    $: (sel) => (sel === '#modal-root' ? modalRoot : null),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('renderer/sections/section19_Modal.js'), sandbox);

  // Every open confirm dialog, newest last, with its two buttons.
  Object.defineProperty(sandbox, '__modals', {
    get() {
      return modalRoot.children.map((m) => {
        const buttons = [];
        const walk = (n) => { if (n.tag === 'button') buttons.push(n); (n.children || []).forEach(walk); };
        walk(m);
        const cancelBtn = buttons.find((b) => b.attrs && b.attrs.class === 'btn-secondary');
        const confirmBtn = buttons.find((b) => b.attrs && b.attrs.class === 'primary');
        return {
          confirm: () => confirmBtn.click(),
          cancel: () => cancelBtn.click(),
        };
      });
    },
  });
  return sandbox;
}

test('KGO7-015: asyncConfirm dedupes by message, never by a static modal id', () => {
  const code = readCode('renderer/sections/section19_Modal.js');
  assert.match(code, /_asyncConfirmPending/, 'asyncConfirm must dedupe in-flight promises by question');
  assert.ok(!/id:\s*'async-confirm'/.test(code),
    'the static showModal id must stay removed — it early-returns before wiring onClose, '
    + 'which left the second concurrent caller pending forever (KGO6-001)');
});

test('KGO7-015: two calls with the SAME question share one dialog and both settle', async () => {
  const sandbox = makeModalSandbox();
  const p1 = sandbox.asyncConfirm('Delete 3 files?');
  const p2 = sandbox.asyncConfirm('Delete 3 files?');
  assert.equal(sandbox.__modals.length, 1, 'the same question must reuse the open dialog');
  sandbox.__modals[0].confirm();
  assert.deepEqual(await Promise.all([p1, p2]), [true, true], 'both callers must settle');
});

test('KGO7-015: two DIFFERENT questions stack, and both settle independently', async () => {
  const sandbox = makeModalSandbox();
  const p1 = sandbox.asyncConfirm('Delete 3 files?');
  const p2 = sandbox.asyncConfirm('Overwrite output.png?');
  // Snapshot: answering one removes it from the live list.
  const open = sandbox.__modals;
  assert.equal(open.length, 2, 'two distinct questions need two answers');
  open[0].confirm();
  open[1].cancel();
  assert.deepEqual(await Promise.all([p1, p2]), [true, false]);
  assert.equal(sandbox.__modals.length, 0, 'both dialogs must close after being answered');
});

test('KGO7-015: the same question can be asked again after it settled', async () => {
  const sandbox = makeModalSandbox();
  const p1 = sandbox.asyncConfirm('Proceed?');
  assert.equal(sandbox.__modals.length, 1);
  sandbox.__modals[0].cancel();
  assert.equal(await p1, false);
  assert.equal(sandbox.__modals.length, 0, 'the answered dialog must be gone');
  // Asking again must open a NEW dialog, not reuse the settled slot.
  const p2 = sandbox.asyncConfirm('Proceed?');
  assert.equal(sandbox.__modals.length, 1, 'the dedup slot must be released once settled');
  sandbox.__modals[0].confirm();
  assert.equal(await p2, true, 'the second answer must be independent of the first');
});

// ---------------------------------------------------------------------------
// KGO7-016 — the 20 ms floor must behave the same in both branches.
// ---------------------------------------------------------------------------
test('KGO7-016: an explicit sub-20ms range is REJECTED, not silently widened', () => {
  const code = readCode('src/audio/AudioTrimCut.js');
  assert.ok(!/Math\.max\(startSec \+ 0\.02, opts\.endSec\)/.test(code),
    'the explicit-endSec branch must not widen the range before validating it — '
    + 'a 5 ms request measured as a 20 ms file reporting ok:true');
  assert.match(code, /Cut range must be at least 20 ms \(got/,
    'the rejection must tell the user how short their range actually was');
});

// ---------------------------------------------------------------------------
// KGO7-004 — one source of truth for the IPC registrar list.
// ---------------------------------------------------------------------------
test('KGO7-004: main/index.js and every harness derive registrars from one list', () => {
  const { IPC_REGISTRAR_NAMES, harnessRegistrarNames, HARNESS_STUBBED_REGISTRARS } =
    require(path.join(ROOT, 'main', 'ipcRegistrarNames'));
  for (const n of IPC_REGISTRAR_NAMES) {
    assert.ok(fs.existsSync(path.join(ROOT, 'main', 'ipc', n + '.js')),
      `main/ipc/${n}.js is listed but does not exist`);
  }
  // Every register*Ipc module on disk must be listed (nothing orphaned).
  const onDisk = fs.readdirSync(path.join(ROOT, 'main', 'ipc'))
    .filter((f) => /^register.*Ipc\.js$/.test(f))
    .map((f) => f.replace(/\.js$/, ''));
  for (const f of onDisk) {
    assert.ok(IPC_REGISTRAR_NAMES.includes(f),
      `main/ipc/${f}.js exists but is not in IPC_REGISTRAR_NAMES — it would never be loaded`);
  }
  const expected = IPC_REGISTRAR_NAMES.filter((n) => !HARNESS_STUBBED_REGISTRARS[n]);
  assert.deepEqual(harnessRegistrarNames(), expected);
  assert.deepEqual(Object.keys(HARNESS_STUBBED_REGISTRARS), ['registerMmxIpc'],
    'only registerMmxIpc may be stubbed, and the reason must be recorded');
  for (const f of ['scripts/e2e/harness.js', 'scripts/smoke-renderer.js', 'scripts/smoke-eval.js']) {
    const code = readCode(f);
    assert.match(code, /harnessRegistrarNames\(\)/,
      `${f} must derive REGISTRARS from main/ipcRegistrarNames.js`);
    assert.ok(!/const REGISTRARS = \[/.test(code),
      `${f} still has a hand-maintained registrar array — that is exactly what drifted`);
  }
});

test('KGO7-004: the IPC coverage census scans main/ statically and fails on drift', () => {
  const code = readCode('scripts/e2e/ipc-coverage.js');
  assert.match(code, /function scanDeclaredChannels/,
    'the census must derive the denominator from the source, not from what the harness registered');
  assert.match(code, /neverRegistered/, 'drift must be reported as its own category');
  assert.match(code, /INTENTIONALLY_UNINVOKED/,
    'channels excluded on purpose must be listed WITH a reason, not silently dropped');
  assert.match(code, /IPC COVERAGE GATE FAILED/,
    'harness drift must be a hard failure, not a warning');
});

// ---------------------------------------------------------------------------
// KGO7-002 — the real-mode mmx surface must be complete.
// ---------------------------------------------------------------------------
test('KGO7-002: registerRealMmx registers the full mmx surface, not just the run channels', () => {
  const code = readCode('scripts/e2e/run.js');
  assert.match(code, /'registerMmxIpc'\)\)/,
    '--real mode must load the REAL registerMmxIpc so voices/quota/authStatus/diagnose/profile exist');
  const idxReg = code.indexOf("'registerMmxIpc'");
  const idxOverride = code.indexOf("ipcMain.handle('mmx:run'");
  assert.ok(idxReg >= 0 && idxOverride > idxReg,
    'the harness must register the real module FIRST, then take over only mmx:run + mmx:run:job');
  assert.match(code, /removeHandler\(ch\)/,
    'the run channels must be removed before being re-registered, or the handle() call throws');
});

test('KGO7-002: the harness fails loudly when an mmx channel has no handler', () => {
  const code = readCode('scripts/e2e/harness.js');
  assert.match(code, /MMX_CHANNELS/, 'the harness must know the full mmx channel set');
  assert.match(code, /mmx:profile/, 'mmx:profile was missing from the fake surface');
  assert.match(code, /have NO handler/,
    'a missing handler must abort boot with a clear message — it is a broken harness, not a test result');
});

// ---------------------------------------------------------------------------
// KGO7-001 / 009 / 011 / 012 / 013 — visual + report integrity.
// ---------------------------------------------------------------------------
test('KGO7-001: visual capture and compare apply the same deterministic reset', () => {
  const src = read('scripts/e2e/visual-baseline.js');
  assert.match(src, /const RESET_JS/, 'a shared scrub must exist');
  const capture = src.slice(src.indexOf('async function captureBaselines'), src.indexOf('async function compareBaselines'));
  const compare = src.slice(src.indexOf('async function compareBaselines'));
  assert.match(capture, /applyReset\(exec\)|stableReset\(exec/, 'captureBaselines must scrub before the shutter');
  assert.match(compare, /applyReset\(exec\)|stableReset\(exec/, 'compareBaselines must apply the SAME scrub');
  assert.match(capture, /stableReset\(exec, sleep, name\)/, 'the capture shutter must wait for a scrub that holds');
  assert.match(compare, /stableReset\(exec, sleep, name\)/, 'the compare shutter must wait for the SAME stable scrub');
  // Selectors MEASURED against the live renderer. The first attempt used
  // `#log-list` / `.assets-preview` — neither exists — so the scrub was a
  // silent no-op and the gate stayed flaky while appearing to have a reset.
  for (const sel of ['#log', '#fb-list', '#fb-path', '#fb-preview-content', '#toast-root', 'textarea', '#statusbar']) {
    assert.ok(src.includes(sel), `RESET_JS must neutralise ${sel} (it carries run-specific content)`);
  }
  assert.match(src, /RESET_REQUIRED_KEYS/,
    'a stale selector must FAIL loudly — a no-op scrub is what made this gate useless');
  assert.match(src, /function stableReset/,
    'the scrub must be verified to still hold before the shutter (the app repaints asynchronously)');
});

// KGO8-003 REPLACES KGO7-001c, which asserted the opposite.
//
// KGO7-001c froze "the comparison is advisory" into a test, on the premise
// that the residual diffs were an unavoidable repaint race. They were not:
// RESET_HOLDS simply did not check the textareas or the scroll offsets that
// RESET_JS resets, so stableReset() returned while un-scrubbed content was
// still on screen — on the capture side too, which is how a baseline full of
// one run's timestamped filenames got committed. With that closed the gate
// can be honest again, and it must be: an advisory gate reports "failed": 0
// and prints E2E_PASS over a measured 24.3 % regression.
test('KGO8-003: the pixel comparison FAILS on a difference (no advisory escape)', () => {
  const src = read('scripts/e2e/visual-baseline.js');
  assert.doesNotMatch(src, /return \{ ok: true, advisory: true/,
    'the advisory branch must be gone — it made the only full-suite visual gate incapable of failing');
  assert.match(src, /return \{ ok: false, failures \}/,
    'a non-empty failures list must produce ok:false');
});

test('KGO8-003: the scrub-still-holds check covers everything the scrub resets', () => {
  const src = read('scripts/e2e/visual-baseline.js');
  const holds = src.slice(src.indexOf('const RESET_HOLDS'), src.indexOf('async function stableReset'));
  assert.match(holds, /textarea/,
    'RESET_JS blanks every textarea, so RESET_HOLDS must verify they stayed blanked');
  assert.match(holds, /scrollTop/,
    'RESET_JS resets every scroll offset, so RESET_HOLDS must verify they stayed reset');
});

test('KGO7-013: a failed visual comparison keeps the evidence', () => {
  const src = read('scripts/e2e/visual-baseline.js');
  assert.match(src, /mmx-visual-fail/, 'failures must be copied somewhere inspectable');
  assert.match(src, /copyFileSync\(baselinePath/, 'the baseline must be kept alongside the current shot');
});

test('KGO7-009: the visual phase runs in --isolate mode too', () => {
  const code = readCode('scripts/e2e/run.js');
  const main = code.slice(code.indexOf('async function main()'), code.indexOf('const { app } = require'));
  assert.ok(!/visual: null/.test(main),
    '--isolate must not return visual:null — the mode documented as "strictest; CI" was skipping the check');
  assert.equal((main.match(/compareBaselines\(vctx\)/g) || []).length, 1,
    'the visual phase must exist exactly once, outside the isolate/shared branch');
});

test('KGO7-011: summary.failed counts visual regressions', () => {
  const code = readCode('scripts/e2e/run.js');
  assert.match(code, /visualFailed/, 'visual failures must be counted');
  assert.match(code, /report\.summary = \{[^}]*scenarioFailed[^}]*visualFailed/,
    'the report must expose the combined total AND both sources');
});

test('KGO7-012: a filtered run does not clobber coverage/surface.json', () => {
  assert.match(read('scripts/e2e/surface-report.js'), /surface\.partial\.json/,
    'a partial run needs its own artifact');
  assert.match(readCode('scripts/e2e/run.js'), /partial = !!ONLY/,
    '--only must mark the surface report partial');
});

test('KGO7-017: orphaned bin/ temp files fail the preflight check', () => {
  const code = readCode('scripts/check.js');
  assert.match(code, /leakedTemps/, 'check.js must count orphaned temp files');
  assert.match(code, /tmp-/, 'and match the .tmp- download pattern');
  assert.match(readCode('src/isnetbg/modelDownload.js'), /function sweepStaleTemps/,
    'the downloader must be able to reclaim its own leaks');
  assert.match(readCode('main/ipc/registerIsnetbgIpc.js'), /sweepStaleTemps/,
    'the sweep must actually be called at startup — an unused function fixes nothing');
});

test('KGO7-017: sweepStaleTemps removes old temps and spares fresh ones', () => {
  const os = require('os');
  const { sweepStaleTemps } = require(path.join(ROOT, 'src', 'isnetbg', 'modelDownload.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgo7-sweep-'));
  try {
    const stale = path.join(dir, 'isnet.onnx.tmp-1234-0fcb71cf-bcc0-4f14-9117-002026e53f0d');
    const fresh = path.join(dir, 'isnet.onnx.tmp-9999-1fcb71cf-bcc0-4f14-9117-002026e53f0d');
    const keep = path.join(dir, 'isnet.onnx');
    for (const p of [stale, fresh, keep]) fs.writeFileSync(p, 'x');
    // Age the stale one past the 6 h window.
    const old = Date.now() - (7 * 60 * 60 * 1000);
    fs.utimesSync(stale, old / 1000, old / 1000);
    const r = sweepStaleTemps(dir);
    assert.equal(r.removed.length, 1, 'exactly the aged temp must be removed');
    assert.ok(!fs.existsSync(stale), 'the aged temp must be gone');
    assert.ok(fs.existsSync(fresh), 'a temp from an in-flight download must be spared');
    assert.ok(fs.existsSync(keep), 'the real model file must never be touched');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('KGO7-021: the coverage gate does NOT ratchet, and records why', () => {
  // The finding proposed a ratchet. Building and measuring it showed the
  // metric has ~+/-3 points of run-to-run noise on an unchanged tree, so a
  // ratchet fails every honest run. The measurement must stay next to the
  // code so nobody re-adds it from the report alone.
  const src = read('scripts/check-unit-coverage.js');
  assert.match(src, /deliberately removed/,
    'the removed ratchet must be documented, not silently absent');
  assert.match(src, /56\.41/,
    'the measured noise band must be recorded so the decision is checkable');
  const code = readCode('scripts/check-unit-coverage.js');
  assert.ok(!/RATCHET_FILE/.test(code),
    'no ratchet file: the metric is not reproducible enough to support one');
  assert.match(code, /linePct < THRESHOLD/, 'the fixed floor must still gate');
});

test('KGO7-022: verify:release rejects an archive older than the source', () => {
  const vr = require(path.join(ROOT, 'scripts', 'verify-release.js'));
  assert.equal(typeof vr.verifyArchiveFreshness, 'function',
    'verify-release must expose a freshness check');
  const code = readCode('scripts/verify-release.js');
  assert.match(code, /Archive is STALE/, 'the failure must name the problem plainly');
  assert.match(code, /Freshness:/, 'and be reported in the console summary');
});

// ---------------------------------------------------------------------------
// KGO7-007 — the file-browser Up button must reflect the real ceiling.
// ---------------------------------------------------------------------------
test('KGO7-007: the dead fbTrustAncestors calls are gone', () => {
  const code = readCode('renderer/app.js');
  assert.ok(!/window\.api\.fbTrustAncestors\(/.test(code),
    'fbTrustAncestors has no preload binding and no main handler (removed by the S1 model) — '
    + 'the guarded call was a permanent no-op that made the Up button look functional');
  assert.match(code, /function isAtOutputRoot/, 'the ceiling must be an explicit, testable condition');
  assert.match(code, /window\.updateFbUpButton = updateFbUpButton/,
    'refreshBrowser re-enables #fb-up unconditionally, so it must be able to re-apply the rule');
  assert.match(readCode('renderer/services/fileBrowser1.js'), /window\.updateFbUpButton\(\)/,
    'refreshBrowser must re-apply the Up-button state after re-enabling it');
});

test('KGO7-007: fbTrustAncestors has no preload binding (the guard was hiding that)', () => {
  assert.ok(!/fbTrustAncestors/.test(read('preload.js')),
    'preload must not expose fbTrustAncestors — it was removed with fb:trust-ancestors');
});

// ---------------------------------------------------------------------------
// KGO7-014 — no permanent console error from an invalid meta CSP directive.
// ---------------------------------------------------------------------------
test('KGO7-014: frame-ancestors is a real header, not an ignored meta directive', () => {
  const html = read('renderer/index.html');
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  assert.ok(meta, 'the meta CSP must still exist');
  assert.ok(!/frame-ancestors/.test(meta[1]),
    'frame-ancestors in a <meta> CSP is ignored by Chromium and logs a console ERROR on every boot');
  assert.match(meta[1], /default-src 'none'/, 'the rest of the policy must stay in the meta tag');
  const sec = read('main/window/windowSecurity.js');
  assert.match(sec, /frame-ancestors 'none'/, 'the protection must move to a response header, not just be deleted');
  assert.match(sec, /onHeadersReceived/, 'and be delivered via onHeadersReceived');
});

// ---------------------------------------------------------------------------
// KGO7-010 / 020 — warnings that reach the user.
// ---------------------------------------------------------------------------
test('KGO7-010: onnxruntime noise is filtered out of warnings[]', () => {
  const code = readCode('main/ipc/legacyAdapter.js');
  assert.match(code, /onnxruntime/,
    'ORT chatter must be filtered before it becomes a user-facing warning toast');
  assert.match(code, /VerifyEachNodeIsAssignedToAnEp/,
    'the specific line every successful ONNX run emits must be filtered');
  assert.ok(require(path.join(ROOT, 'main', 'ipc', 'legacyAdapter.js')), 'legacyAdapter must still load');
});

test('KGO7-010: the isnetbg model fallback has real renderer consumers', () => {
  const ipc = readCode('main/ipc/registerIsnetbgIpc.js');
  assert.match(ipc, /result\.fellBack = true/, 'isnetbg:run must flag the fallback');
  assert.match(ipc, /result\.requestedModel/, 'and echo what was asked for');
  // One shared implementation, called from all three isnetbgRun sites.
  assert.match(readCode('renderer/sections/section08Helpers.js'), /function warnModelFallback/,
    'the fallback warning must have exactly one implementation');
  for (const f of [
    'renderer/sections/section08_Image_pipeline__Upscale___Crop___Convert_.js',
    'renderer/overlays/imageEditorActions.js',
    'renderer/overlays/imageEditorAssetBg.js',
  ]) {
    assert.match(readCode(f), /warnModelFallback/, `${f} must surface the fallback — a flag with no consumer fixes nothing`);
  }
});

test('KGO7-020: the resize clamp notice reaches every call site', () => {
  assert.match(readCode('main/ipc/registerImageIpc.js'), /r\.warnings = Array\.isArray/,
    'image:resize must attach the clamp notice to warnings[] behind the IPC boundary');
  assert.match(readCode('renderer/utils/ipcResult.js'), /function reportIpcWarnings/,
    'the renderer needs one shared warning reporter');
  // Monkey-patching window.api does NOT work (contextBridge objects are
  // frozen — measured: __autoWarnWrapped === false), so EVERY direct
  // resizeImage call site must report explicitly. This is the check that
  // stops the sixth one being forgotten again.
  // KGO8-011 widened this: `optimizeImage` returns warnings too (the
  // "kept the original, re-encoding would have grown it" notice), and its
  // call sites silently dropped them while the resize sites reported. The
  // invariant is now "every resize AND every optimize call reports".
  const sites = [
    'renderer/pipeline/pipelineOps.js',
    'renderer/services/batchPostprocess.js',
    'renderer/sections/section08_Image_pipeline__Upscale___Crop___Convert_.js',
    'renderer/sections/section08Helpers.js',
  ];
  let calls = 0; let reports = 0;
  for (const f of sites) {
    const code = readCode(f);
    calls += (code.match(/window\.api\.resizeImage\(/g) || []).length;
    calls += (code.match(/window\.api\.optimizeImage\(/g) || []).length;
    reports += (code.match(/reportIpcWarnings\(/g) || []).length;
    assert.match(code, /reportIpcWarnings/, `${f} calls resizeImage/optimizeImage but never reports its warnings`);
  }
  assert.ok(calls > 0, 'expected to find resizeImage/optimizeImage call sites');
  assert.equal(reports, calls,
    `every resizeImage/optimizeImage call must report its warnings (${calls} calls, ${reports} reports)`);
});
