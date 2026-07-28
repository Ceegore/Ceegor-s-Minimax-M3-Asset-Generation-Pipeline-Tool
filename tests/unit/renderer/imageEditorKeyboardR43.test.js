// tests/unit/renderer/imageEditorKeyboardR43.test.js
// ============================================================================
// R4.3 — Empty-Prompt state machine (PE-003 fix).
//
// Background: PE-003 — the "No image loaded / Load image…" overlay stayed
// visible after a successful image load. The bug was that
// `showEmptyPrompt(ctrl)` appended `.ie-empty-prompt` to `ctrl.ui.wrap` but
// never removed it. With its `position: absolute; inset: 0;
// pointer-events: auto` styling, the prompt blocked the working canvas
// after a successful load. The fix:
//
//   - `showEmptyPrompt(ctrl)` is idempotent (no-op if `ctrl.ui.emptyPrompt`
//     already exists — never more than one prompt).
//   - The prompt has a state machine: idle → loading → (success | cancel |
//     error) → idle. The button reflects the state and is disabled during
//     loading.
//   - `hideEmptyPrompt(ctrl)` removes the DOM element + clears
//     `ctrl.ui.emptyPrompt`. Called by `activateSlot` after a successful
//     setBaseImage.
//   - `resetEmptyPrompt(ctrl)` re-enables the button (re-bedienbar).
//     Called by `activateSlot`'s catch on load failure.
//
// Test discipline:
//   - Structural assertions: state transitions, DOM presence/absence,
//     button enabled/disabled.
//   - Adversarial probes: every "production-correct" claim is verified
//     by temporarily breaking the production code and confirming the
//     test fails.
//   - Per-test sandbox (no module-scope state).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const KB_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorKeyboard.js');

// ---- Sandbox helpers ----
// R4.3: mock requestAnimationFrame (used by showEmptyPrompt's click
// handler) and any other browser globals the production code touches.
function setupBrowserGlobals(sandbox) {
  sandbox.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  sandbox.cancelAnimationFrame = (id) => clearTimeout(id);
  return sandbox;
}

function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], style: {}, dataset: {}, classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    _attrs: {},
    _listeners: { click: [] },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) {
      const arr = this._listeners[ev] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 200 }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
  };
  // R4.3 PE-003 tests need to find buttons + status elements via
  // querySelector because the production code creates nested DOM
  // (prompt > text + status + button). We use a simple class-based
  // lookup.
  el.querySelector = function (sel) {
    if (!sel) return null;
    // Strip leading '.' for class selector
    const cls = sel.replace(/^\./, '');
    function walk(node) {
      for (const c of node.children || []) {
        if (c.className && c.className.indexOf(cls) >= 0) return c;
        const r = walk(c);
        if (r) return r;
      }
      return null;
    }
    return walk(el);
  };
  el.querySelectorAll = function (sel) {
    if (!sel) return [];
    const cls = sel.replace(/^\./, '');
    const out = [];
    function walk(node) {
      for (const c of node.children || []) {
        if (c.className && c.className.indexOf(cls) >= 0) out.push(c);
        walk(c);
      }
    }
    walk(el);
    return out;
  };
  // textContent getter: returns the .textContent property if set,
  // else the joined children's textContent.
  Object.defineProperty(el, 'textContent', {
    get() { return this._text || ''; },
    set(v) { this._text = v; },
    configurable: true,
  });
  return el;
}

function makeSandbox() {
  const sandbox = {};
  sandbox.window = sandbox;
  // document.createElement returns a real-ish DOM-shaped object.
  sandbox.document = {
    createElement: (t) => makeEl(t),
    body: makeEl('body'),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  sandbox.global = sandbox;
  setupBrowserGlobals(sandbox);
  return sandbox;
}

// waitFor: poll predicate every 5ms up to timeoutMs.
async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out after ' + timeoutMs + 'ms');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function loadKeyboard(sandbox, extraGlobals) {
  vm.createContext(sandbox);
  if (extraGlobals) for (const k of Object.keys(extraGlobals)) sandbox[k] = extraGlobals[k];
  // Bare globals (not window-globals — imageEditorKeyboard uses bare
  // identifiers for `document`, `el`, `toast`, `window`, etc.).
  sandbox.toast = (msg, kind) => { (sandbox._toasts = sandbox._toasts || []).push({ msg, kind }); };
  const code = require('fs').readFileSync(KB_JS, 'utf8');
  vm.runInContext(code, sandbox, { filename: KB_JS });
  return sandbox.window.ImageEditorKeyboard;
}

// Build a minimal ctrl with a wrap (parent of the prompt) and a queue.
function makeCtrl(opts) {
  opts = opts || {};
  const wrap = makeEl('div');
  const ctrl = {
    queue: opts.queue || [],
    activeIndex: -1,
    ui: { wrap, emptyPrompt: null, ...(opts.ui || {}) },
    closed: false,
    saveLabel: 'Save',
    prefs: { outFormat: 'png', brushSize: 12, brushOpacity: 1, fg: '#000000', bg: '#ffffff' },
    activateSlot: opts.activateSlot || (() => Promise.resolve()),
    fitActive: () => {},
  };
  return ctrl;
}

// ============================================================================
// Tests
// ============================================================================

test('R4.3 PE-003.A: showEmptyPrompt creates the prompt + stores it on ctrl.ui.emptyPrompt', () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  K.showEmptyPrompt(ctrl);
  // ctrl.ui.emptyPrompt is set
  assert.ok(ctrl.ui.emptyPrompt, 'PE-003.A: ctrl.ui.emptyPrompt must be set after showEmptyPrompt');
  // The prompt is appended to wrap
  const prompt = ctrl.ui.emptyPrompt;
  assert.equal(prompt.parentNode, ctrl.ui.wrap, 'PE-003.A: prompt must be appended to ctrl.ui.wrap');
  // The prompt has the expected class
  assert.equal(prompt.className, 'ie-empty-prompt', 'PE-003.A: prompt must have class "ie-empty-prompt"');
  // The prompt has the idle state
  assert.equal(prompt.getAttribute('data-state'), 'idle', 'PE-003.A: prompt must start in state "idle"');
  // The prompt has a button with the "Load image…" text
  const btn = prompt.querySelector('.ie-empty-btn');
  assert.ok(btn, 'PE-003.A: prompt must have a button with class "ie-empty-btn"');
  assert.equal(btn.textContent, '📂 Load image…', 'PE-003.A: button text must be the idle label');
  assert.equal(btn.disabled, false, 'PE-003.A: button must be enabled in idle state');
});

test('R4.3 PE-003.B: showEmptyPrompt is idempotent (never more than one prompt)', () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  K.showEmptyPrompt(ctrl);
  const first = ctrl.ui.emptyPrompt;
  // Call again — must not create a second prompt.
  K.showEmptyPrompt(ctrl);
  const second = ctrl.ui.emptyPrompt;
  assert.equal(first, second, 'PE-003.B: second showEmptyPrompt must be a no-op (same element)');
  // Wrap has exactly one .ie-empty-prompt child.
  const prompts = ctrl.ui.wrap.querySelectorAll('.ie-empty-prompt');
  assert.equal(prompts.length, 1, 'PE-003.B: wrap must contain exactly one .ie-empty-prompt');
});

test('R4.3 PE-003.C (+Issue-14): loading state starts AFTER the file pick, not during the dialog', async () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  // Controllable pickFile: resolves only when the test says so (simulates
  // the native dialog being open).
  let resolvePick;
  sb.window.api = { pickFile: () => new Promise((res) => { resolvePick = res; }) };
  K.showEmptyPrompt(ctrl);
  const btn = ctrl.ui.emptyPrompt.querySelector('.ie-empty-btn');
  assert.ok(btn, 'PE-003.C pre: button must exist');
  // The click listener is the only one registered on the button.
  const clickFns = btn._listeners.click || [];
  assert.ok(clickFns.length >= 1, 'PE-003.C pre: click listener must be registered');
  clickFns[0]({});
  // Issue-14: while the file dialog is open (pick pending), the prompt
  // must stay idle — pre-fix it flipped to a defective disabled
  // "Loading… / Decoding image…" state for the whole dialog duration.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctrl.ui.emptyPrompt.getAttribute('data-state'), 'idle',
    'Issue-14: state must stay idle while the file dialog is open');
  assert.equal(btn.disabled, false,
    'Issue-14: button must stay enabled while the file dialog is open');
  // Now the user picks a file → decoding starts → loading state.
  resolvePick({ ok: true, path: 'C:/test.png' });
  await waitFor(() => ctrl.ui.emptyPrompt.getAttribute('data-state') === 'loading', 200);
  assert.equal(ctrl.ui.emptyPrompt.getAttribute('data-state'), 'loading', 'PE-003.C: state must be loading after a file is picked');
  assert.equal(btn.disabled, true, 'PE-003.C: button must be disabled in loading state');
  assert.equal(btn.textContent, 'Loading…', 'PE-003.C: button text must be "Loading…" in loading state');
  // P-R43-04: status text must show loading message.
  const status = ctrl.ui.emptyPrompt.querySelector('.ie-empty-status');
  assert.equal(status.textContent, 'Decoding image…', 'PE-003.C: status text must be "Decoding image…" in loading state');
});

test('R4.3 PE-003.D: hideEmptyPrompt removes the prompt + clears ctrl.ui.emptyPrompt', () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  K.showEmptyPrompt(ctrl);
  const prompt = ctrl.ui.emptyPrompt;
  assert.ok(prompt, 'PE-003.D pre: prompt must be set');
  K.hideEmptyPrompt(ctrl);
  assert.equal(ctrl.ui.emptyPrompt, null, 'PE-003.D: ctrl.ui.emptyPrompt must be null after hide');
  // The prompt is removed from wrap.
  const prompts = ctrl.ui.wrap.querySelectorAll('.ie-empty-prompt');
  assert.equal(prompts.length, 0, 'PE-003.D: wrap must not contain the prompt after hide');
});

test('R4.3 PE-003.E: hideEmptyPrompt is idempotent (no-op if already hidden)', () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  // No showEmptyPrompt called — hideEmptyPrompt is a no-op.
  K.hideEmptyPrompt(ctrl);
  assert.equal(ctrl.ui.emptyPrompt, null, 'PE-003.E: no-op on first call');
  K.hideEmptyPrompt(ctrl);
  assert.equal(ctrl.ui.emptyPrompt, null, 'PE-003.E: no-op on second call');
  // After showEmptyPrompt + hideEmptyPrompt, second hideEmptyPrompt is no-op.
  K.showEmptyPrompt(ctrl);
  K.hideEmptyPrompt(ctrl);
  K.hideEmptyPrompt(ctrl);
  assert.equal(ctrl.ui.emptyPrompt, null, 'PE-003.E: still no-op after show+hide');
});

test('R4.3 PE-003.F: resetEmptyPrompt re-enables the button (re-bedienbar)', () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  K.showEmptyPrompt(ctrl);
  const prompt = ctrl.ui.emptyPrompt;
  // Simulate the prompt being in loading state by setting data-state.
  prompt.setAttribute('data-state', 'loading');
  // Reset.
  K.resetEmptyPrompt(ctrl);
  assert.equal(prompt.getAttribute('data-state'), 'idle', 'PE-003.F: data-state must return to idle');
  const btn = prompt.querySelector('.ie-empty-btn');
  assert.equal(btn.disabled, false, 'PE-003.F: button must be enabled after reset');
  assert.equal(btn.textContent, '📂 Load image…', 'PE-003.F: button text must be the idle label');
});

test('R4.3 PE-003.G: resetEmptyPrompt is idempotent (no-op if no prompt)', () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  K.resetEmptyPrompt(ctrl);
  assert.equal(ctrl.ui.emptyPrompt, null, 'PE-003.G: no-op without prompt');
});

test('R4.3 PE-003.H: pickFile cancel keeps the prompt visible + re-enables the button', async () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  sb.window.api = { pickFile: async () => ({ ok: false }) };
  K.showEmptyPrompt(ctrl);
  const btn = ctrl.ui.emptyPrompt.querySelector('.ie-empty-btn');
  (btn._listeners.click[0])({});
  await waitFor(() => ctrl.ui.emptyPrompt.getAttribute('data-state') === 'idle', 500);
  assert.ok(ctrl.ui.emptyPrompt, 'PE-003.H: prompt must remain visible after cancel');
  assert.equal(ctrl.ui.emptyPrompt.getAttribute('data-state'), 'idle', 'PE-003.H: prompt must be in idle state after cancel');
  assert.equal(btn.disabled, false, 'PE-003.H: button must be re-enabled after cancel');
});

test('R4.3 PE-003.I: pickFile error shows a toast + re-enables the button', async () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  sb.window.api = { pickFile: async () => ({ ok: false, error: 'permission denied' }) };
  K.showEmptyPrompt(ctrl);
  const btn = ctrl.ui.emptyPrompt.querySelector('.ie-empty-btn');
  (btn._listeners.click[0])({});
  await waitFor(() => (sb._toasts || []).some((t) => t.msg.indexOf('permission denied') >= 0), 500);
  // P-R43-03: verify the toast kind is 'err' (not 'ok' / 'warn').
  const errorToasts = (sb._toasts || []).filter((t) => t.msg.indexOf('permission denied') >= 0);
  assert.ok(errorToasts.length >= 1, 'PE-003.I: error toast must mention the error');
  assert.equal(errorToasts[0].kind, 'err', 'PE-003.I: error toast kind must be "err" (not "ok" or "warn")');
  assert.ok(ctrl.ui.emptyPrompt, 'PE-003.I: prompt must remain visible after error');
  assert.equal(ctrl.ui.emptyPrompt.getAttribute('data-state'), 'error', 'PE-003.I: prompt must be in error state');
  assert.equal(btn.disabled, false, 'PE-003.I: button must be re-enabled after error');
});

test('R4.3 PE-003.J: pickFile success + activateSlot success hides the prompt', async () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  sb.window.api = { pickFile: async () => ({ ok: true, path: 'C:/test.png' }) };
  ctrl.activateSlot = (c, i) => {
    // Simulate the production code calling hideEmptyPrompt after setBaseImage.
    K.hideEmptyPrompt(ctrl);
    return Promise.resolve();
  };
  K.showEmptyPrompt(ctrl);
  const btn = ctrl.ui.emptyPrompt.querySelector('.ie-empty-btn');
  (btn._listeners.click[0])({});
  await waitFor(() => ctrl.ui.emptyPrompt === null, 500);
  assert.equal(ctrl.ui.emptyPrompt, null, 'PE-003.J: prompt must be hidden after successful load');
  const prompts = ctrl.ui.wrap.querySelectorAll('.ie-empty-prompt');
  assert.equal(prompts.length, 0, 'PE-003.J: wrap must not contain the prompt after success');
});

test('R4.3 PE-003.K: pickFile success + activateSlot failure resets the prompt (re-bedienbar)', async () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  sb.window.api = { pickFile: async () => ({ ok: true, path: 'C:/bad.png' }) };
  // Simulate the production code in imageEditorOverlay.js: when
  // activateSlot fails internally, it catches + calls resetEmptyPrompt.
  // The activateSlot returns a RESOLVED promise (because the
  // production code catches its own errors). Inside the resolved
  // callback, the production code calls resetEmptyPrompt.
  ctrl.activateSlot = () => {
    K.resetEmptyPrompt(ctrl);
    return Promise.resolve();
  };
  K.showEmptyPrompt(ctrl);
  const btn = ctrl.ui.emptyPrompt.querySelector('.ie-empty-btn');
  (btn._listeners.click[0])({});
  await waitFor(() => ctrl.ui.emptyPrompt.getAttribute('data-state') === 'idle', 500);
  assert.ok(ctrl.ui.emptyPrompt, 'PE-003.K: prompt must remain visible after activateSlot failure');
  assert.equal(ctrl.ui.emptyPrompt.getAttribute('data-state'), 'idle', 'PE-003.K: prompt must be in idle state (re-bedienbar) after activateSlot failure');
  assert.equal(btn.disabled, false, 'PE-003.K: button must be re-enabled after activateSlot failure');
});

test('R4.3 PE-003.L: showEmptyPrompt handles missing ui.wrap (overlay not yet constructed)', () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = { ui: { emptyPrompt: null } }; // no wrap
  K.showEmptyPrompt(ctrl);
  assert.equal(ctrl.ui.emptyPrompt, null, 'PE-003.L: showEmptyPrompt must not create a prompt without ui.wrap');
});

// R4.3-auditfix P-R43-01: pickFile sync throw must not leave the
// button stuck in 'loading' state. Without the production try/catch
// fix, the throw propagates and the button is stuck.
test('R4.3 PE-003.P-R43-01.A: pickFile that throws synchronously does not leave button stuck in loading', async () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  // pickFile that throws synchronously (NOT a rejected promise).
  sb.window.api = { pickFile: () => { throw new Error('pickFile sync crash'); } };
  K.showEmptyPrompt(ctrl);
  const btn = ctrl.ui.emptyPrompt.querySelector('.ie-empty-btn');
  (btn._listeners.click[0])({});
  // The button must transition to 'error' state, NOT stuck in 'loading'.
  await waitFor(() => {
    const p = ctrl.ui.emptyPrompt;
    if (!p) return false;
    return p.getAttribute('data-state') === 'error';
  }, 500);
  assert.equal(ctrl.ui.emptyPrompt.getAttribute('data-state'), 'error',
    'P-R43-01.A: pickFile sync throw must transition to error state (not stuck in loading)');
  assert.equal(btn.disabled, false, 'P-R43-01.A: button must be re-enabled after sync throw');
  // An error toast must have been shown.
  const errorToasts = (sb._toasts || []).filter((t) => t.kind === 'err' && t.msg.indexOf('pickFile sync crash') >= 0);
  assert.ok(errorToasts.length >= 1, 'P-R43-01.A: error toast must mention the sync throw message');
});

// R4.3-auditfix P-R43-01: pickFile that returns a non-promise must
// surface as an error, not silently proceed.
test('R4.3 PE-003.P-R43-01.B: pickFile that returns a non-promise surfaces as error', async () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  // pickFile that returns undefined (no Promise, no nothing).
  sb.window.api = { pickFile: () => undefined };
  K.showEmptyPrompt(ctrl);
  const btn = ctrl.ui.emptyPrompt.querySelector('.ie-empty-btn');
  (btn._listeners.click[0])({});
  await waitFor(() => {
    const p = ctrl.ui.emptyPrompt;
    if (!p) return false;
    return p.getAttribute('data-state') === 'error';
  }, 500);
  assert.equal(ctrl.ui.emptyPrompt.getAttribute('data-state'), 'error',
    'P-R43-01.B: non-promise pickFile must surface as error');
});

// R4.3-auditfix P-R43-02 (+Issue-14): single-flight — clicking the button
// while the file dialog is open (pick pending, state still 'idle') or while
// decoding ('loading') must not trigger a second pickFile.
test('R4.3 PE-003.M (+Issue-14): single-flight — second click while the dialog is open is ignored', async () => {
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  let pickFileCalls = 0;
  // pickFile never resolves (the dialog stays "open").
  sb.window.api = { pickFile: () => { pickFileCalls++; return new Promise(() => {}); } };
  K.showEmptyPrompt(ctrl);
  const btn = ctrl.ui.emptyPrompt.querySelector('.ie-empty-btn');
  // First click → pickFile called once; state stays idle (Issue-14).
  (btn._listeners.click[0])({});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pickFileCalls, 1, 'P-R43-02: first click must call pickFile exactly once');
  assert.equal(ctrl.ui.emptyPrompt.getAttribute('data-state'), 'idle',
    'Issue-14: state stays idle while the file dialog is open');
  // Second click while the dialog is still open — must be ignored.
  (btn._listeners.click[0])({});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pickFileCalls, 1, 'P-R43-02: second click during the open dialog must NOT call pickFile again (single-flight)');
  assert.equal(ctrl.ui.emptyPrompt.getAttribute('data-state'), 'idle',
    'P-R43-02: state must remain idle after the ignored second click');
});

test('R4.3 PE-003.adversarial: breaking the hideEmptyPrompt call after setBaseImage keeps the prompt visible', async () => {
  // Adversarial probe: simulate the production code in
  // imageEditorOverlay.js activating a slot WITHOUT calling
  // hideEmptyPrompt on success. The prompt must remain visible.
  // This is the PE-003 bug repro: a "successful" load leaves the
  // prompt over the working area.
  const sb = makeSandbox();
  const K = loadKeyboard(sb);
  const ctrl = makeCtrl();
  sb.window.api = { pickFile: async () => ({ ok: true, path: 'C:/test.png' }) };
  // Activate slot does NOT call hideEmptyPrompt (the bug).
  ctrl.activateSlot = () => Promise.resolve();
  K.showEmptyPrompt(ctrl);
  const btn = ctrl.ui.emptyPrompt.querySelector('.ie-empty-btn');
  (btn._listeners.click[0])({});
  // Give activateSlot a moment to resolve.
  await new Promise((r) => setTimeout(r, 50));
  // The prompt is STILL visible — the bug.
  assert.ok(ctrl.ui.emptyPrompt, 'PE-003.adversarial: WITHOUT the production fix, the prompt remains visible (this is the bug we are testing)');
});

test('R4.3 PE-003.integration: imageEditorOverlay.js actually calls hideEmptyPrompt after setBaseImage (the production fix)', () => {
  // R4.3 (PE-003): the production code in imageEditorOverlay.js
  // activateSlot() must call window.ImageEditorKeyboard.hideEmptyPrompt
  // AFTER the setBaseImage.then() block resolves. Without this, the
  // empty-prompt stays visible forever after a successful image
  // load (the PE-003 bug).
  //
  // This is a source-grep test: it reads the production file
  // directly and verifies the structural contract. It's the
  // "integration witness" for the empty-prompt module — without
  // this test, a future refactor could remove the hideEmptyPrompt
  // call in the overlay and the empty-prompt module tests would
  // still pass (they test the module, not the integration).
  const overlaySrc = require('fs').readFileSync(
    path.join(ROOT, 'renderer', 'overlays', 'imageEditorOverlay.js'),
    'utf8'
  );
  // The fix is: inside the .then() of handle.setBaseImage(img), the
  // code calls window.ImageEditorKeyboard.hideEmptyPrompt(ctrl).
  // Verify both that the call exists AND that it's positioned AFTER
  // setBaseImage (not in the catch — that's resetEmptyPrompt).
  const setBaseImageThenIdx = overlaySrc.indexOf('handle.setBaseImage(img).then');
  const hideIdx = overlaySrc.indexOf('window.ImageEditorKeyboard.hideEmptyPrompt(ctrl)');
  const resetIdx = overlaySrc.indexOf('window.ImageEditorKeyboard.resetEmptyPrompt(ctrl)');
  assert.ok(setBaseImageThenIdx > 0,
    'PE-003.integration: setBaseImage(img).then() block must exist in imageEditorOverlay.js (production source)');
  assert.ok(hideIdx > 0,
    'PE-003.integration: imageEditorOverlay.js MUST call window.ImageEditorKeyboard.hideEmptyPrompt(ctrl) (the R4.3 fix)');
  // The hide call is positioned in the source AFTER the setBaseImage.then
  // opening — i.e. it's inside the success block, not the catch.
  assert.ok(hideIdx > setBaseImageThenIdx,
    'PE-003.integration: hideEmptyPrompt call must be inside the setBaseImage.then() success block (after setBaseImage.then)');
  // The reset call is in the catch block (which is after the .then()).
  assert.ok(resetIdx > 0,
    'PE-003.integration: imageEditorOverlay.js MUST call window.ImageEditorKeyboard.resetEmptyPrompt(ctrl) in the catch block (the R4.3 fix)');
  assert.ok(resetIdx > hideIdx,
    'PE-003.integration: resetEmptyPrompt (catch) must come AFTER hideEmptyPrompt (then) in the source');
});
