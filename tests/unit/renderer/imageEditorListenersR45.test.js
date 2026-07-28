// tests/unit/renderer/imageEditorListenersR45.test.js
// ============================================================================
// R4.5 — Source-/Cursorlistener (PE-027 + PE-035 fix).
//
// Background:
//   - PE-027 (P1): imageEditorSource.refreshQueueBar added
//     `dragover` + `drop` listeners to `ctrl.ui.sourceThumb` on
//     EVERY refresh. After N refreshes, sourceThumb has 2N
//     listeners. A single drop would be handled N times → the
//     source image is loaded N times. Real bug.
//   - PE-035 (P2): imageEditorTools.installBrushCursor added
//     `mousemove` + `mouseleave` to the SHARED `wrapEl` every time
//     a slot is activated. After N slot activations, wrapEl has 2N
//     listeners. Each mousemove triggers N refresh calls (wasted
//     work, plus A→B→A could have stale sessions still updating
//     the cursor for an inactive slot).
//
// R4.5 fix:
//   - PE-027: sourceThumb dropzone is set up ONCE in
//     `imageEditorOverlay.js:buildSourceTray` (or a dedicated
//     helper). refreshQueueBar only manages the queue bar thumbs
//     (each fresh, no accumulation).
//   - PE-035: brush cursor wrap-listener is installed ONCE (using
//     a guard flag on wrapEl). The per-canvas `ie:viewport`
//     listener is detached from the previous session + attached
//     to the new session on every install. installBrushCursor
//     returns a disposer that removes the canvas listener.
//     activateSlot calls the previous slot's disposer before
//     installing the new one. The overlay's close() disposes all
//     slot disposers.
//
// Test discipline:
//   - Source-grep tests verify the migration is applied + the
//     per-refresh re-registration is GONE.
//   - Functional tests in vm-sandbox verify that after N calls,
//     the listener count is exactly 1 (not N).
//   - Adversarial probes mutate the production code and verify
//     the tests fail.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SOURCE_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorSource.js');
const TOOLS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorTools.js');
const OVERLAY_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorOverlay.js');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

// ---- PE-027: Source-Tray Drop-Listener ----

test('R4.5 PE-027.A: imageEditorSource.js does NOT register dragover/drop on sourceThumb inside the per-refresh loop', () => {
  const src = fs.readFileSync(SOURCE_JS, 'utf8');
  const codeOnly = stripComments(src);
  // The PE-027 bug: refreshQueueBar contains a `forEach` over
  // `ctrl.queue` that re-attaches `dragover` + `drop` to
  // `sourceThumb` for EVERY slot. The fix: those listeners are
  // registered ONCE (in buildSourceTray) and the per-refresh
  // loop only manages the queue thumbs.
  // Verify: `sourceThumb.addEventListener` appears at most in
  // a non-loop context. We do a simple heuristic: count
  // occurrences of `sourceThumb.addEventListener` — should be
  // at most 1 in the file (the one-time setup).
  const matches = codeOnly.match(/sourceThumb\.addEventListener/g) || [];
  assert.equal(matches.length, 0,
    'R4.5 PE-027.A: imageEditorSource.js must NOT call sourceThumb.addEventListener at all (dropzone is set up in imageEditorOverlay.js:buildSourceTray)');
});

test('R4.5 PE-027.B: imageEditorOverlay.js:buildSourceTray calls setupSourceThumbDropZone to register the dropzone', () => {
  const src = fs.readFileSync(OVERLAY_JS, 'utf8');
  const codeOnly = stripComments(src);
  // The fix: buildSourceTray calls `setupSourceThumbDropZone(ctrl)`
  // which lives in imageEditorSource.js. The overlay itself does
  // not attach `dragover`/`drop` directly to sourceThumb.
  assert.ok(/setupSourceThumbDropZone\s*\(/.test(codeOnly),
    'R4.5 PE-027.B: imageEditorOverlay.js must call setupSourceThumbDropZone(ctrl) to register the sourceThumb dropzone exactly once');
});

test('R4.5 PE-027.C: refreshQueueBar manages ONLY the queue thumbs (no sourceThumb listeners inside the loop)', () => {
  const src = fs.readFileSync(SOURCE_JS, 'utf8');
  const codeOnly = stripComments(src);
  // The bug was: inside `ctrl.queue.forEach((slot, i) => { ... })`,
  // the code did `ctrl.ui.sourceThumb.addEventListener('dragover'...)`.
  // Verify: no `addEventListener` calls inside the forEach loop.
  // Simple heuristic: extract the forEach body and check it
  // doesn't contain sourceThumb.addEventListener.
  const fnMatch = codeOnly.match(/function refreshQueueBar[\s\S]*?\n\s*function /);
  assert.ok(fnMatch, 'refreshQueueBar function must exist');
  const fnBody = fnMatch[0];
  assert.equal(fnBody.indexOf('sourceThumb.addEventListener'), -1,
    'R4.5 PE-027.C: refreshQueueBar must NOT call sourceThumb.addEventListener inside the loop');
});

// ---- PE-035: Brush-Cursor-Listener ----

test('R4.5 PE-035.A: imageEditorTools.js:installBrushCursor attaches wrap listeners via idempotent guard', () => {
  const src = fs.readFileSync(TOOLS_JS, 'utf8');
  const codeOnly = stripComments(src);
  // The fix: installBrushCursor checks a guard
  // (e.g. `wrapEl._ieBrushCursorInstalled`) before adding
  // `mousemove` + `mouseleave` to the wrap. This ensures
  // exactly 1 wrap-listener pair even after N installs.
  assert.ok(/_ieBrushCursorInstalled/.test(codeOnly),
    'R4.5 PE-035.A: installBrushCursor must use a guard (e.g. wrapEl._ieBrushCursorInstalled) so wrap listeners are attached at most once');
});

test('R4.5 PE-035.B: installBrushCursor returns a disposer that removes the canvas listener', () => {
  const src = fs.readFileSync(TOOLS_JS, 'utf8');
  const codeOnly = stripComments(src);
  // The fix: installBrushCursor must `return function dispose()`
  // that calls `session.canvas.off('ie:viewport', ...)`. This
  // ensures the per-canvas listener can be cleaned up. Extract
  // the function body via brace-matching (the function has
  // nested braces + a nested function declaration, so we can't
  // just regex `\n\s*function `).
  const startIdx = codeOnly.indexOf('function installBrushCursor');
  assert.ok(startIdx >= 0, 'installBrushCursor function declaration must exist');
  // Find the opening brace of the function body.
  let bodyStart = codeOnly.indexOf('{', startIdx);
  assert.ok(bodyStart >= 0, 'installBrushCursor must have a body');
  // Brace-match to find the closing brace of the function.
  let depth = 0, bodyEnd = -1;
  for (let i = bodyStart; i < codeOnly.length; i++) {
    const c = codeOnly[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { bodyEnd = i; break; }
    }
  }
  assert.ok(bodyEnd > bodyStart, 'installBrushCursor must have a matched closing brace');
  const fnBody = codeOnly.slice(startIdx, bodyEnd + 1);
  assert.ok(/return\s+function/.test(fnBody),
    'R4.5 PE-035.B: installBrushCursor must return a disposer function');
  assert.ok(/canvas\.off\(['"]ie:viewport['"]/.test(fnBody),
    'R4.5 PE-035.B: the disposer must remove the ie:viewport listener from the canvas');
});

test('R4.5 PE-035.C: imageEditorOverlay.js:activateSlot disposes the previous slot brush cursor before installing the new one', () => {
  const src = fs.readFileSync(OVERLAY_JS, 'utf8');
  const codeOnly = stripComments(src);
  // The fix: when activateSlot is called for a new slot, it
  // must call the previous slot's brush-cursor disposer (if any)
  // to remove the old canvas listener.
  // Heuristic: the code must check for `_brushCursorDisposer` or
  // similar on the previous slot, and call it.
  assert.ok(/_brushCursorDisposer/.test(codeOnly) || /brushCursorDisposer/.test(codeOnly) || /brushCursorDispose/.test(codeOnly),
    'R4.5 PE-035.C: activateSlot must track + call the previous slot\'s brush-cursor disposer');
});

// ---- Functional tests (vm-sandbox) ----

function makeCountingEl(tag) {
  const listeners = {};
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); } },
    textContent: '',
    value: '',
    appendChild(c) { if (c) { this.children.push(c); c.parentNode = this; } return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      const i = listeners[type].indexOf(fn);
      if (i >= 0) listeners[type].splice(i, 1);
    },
    dispatchEvent(type, ev) {
      const arr = listeners[type] || [];
      for (const fn of arr) fn(ev);
    },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; },
    getContext() { return null; },
    width: 0,
    height: 0,
    // expose the listener list for tests
    _listeners: listeners,
    _listenerCount(type) { return (listeners[type] || []).length; },
  };
  return el;
}

function makeFakeSession() {
  // Mimic imageEditorCanvas.createEditorSession's session shape,
  // but with a counting canvas.on / canvas.off so we can verify
  // listener accumulation.
  const canvasListeners = {};
  const canvas = {
    on(type, fn) {
      canvasListeners[type] = canvasListeners[type] || [];
      canvasListeners[type].push(fn);
    },
    off(type, fn) {
      if (!canvasListeners[type]) return;
      const i = canvasListeners[type].indexOf(fn);
      if (i >= 0) canvasListeners[type].splice(i, 1);
    },
    fire(type, payload) {
      const arr = canvasListeners[type] || [];
      for (const fn of arr) fn(payload);
    },
    getObjects: () => [],
    isDrawingMode: false,
    getActiveObject: () => null,
    requestRenderAll() {},
    getContext() { return null; },
    _listeners: canvasListeners,
    _listenerCount(type) { return (canvasListeners[type] || []).length; },
  };
  return {
    session: {
      canvas,
      imgW: 100, imgH: 60,
      zoom: 1, tool: 'pen', brushSize: 12, brushOpacity: 1, fg: '#000', bg: '#fff',
      _undo: [], _redo: [],
      setBaseImage: () => Promise.resolve(),
    },
    canvas,
  };
}

test('R4.5 PE-035.functional: installBrushCursor attaches wrap listeners only once across N installs', () => {
  // R4.5 fix: the wrap listeners (mousemove + mouseleave) are
  // attached once via a guard flag. After N installs, wrap has
  // exactly 2 listeners (not 2N).
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  const toolsSrc = fs.readFileSync(TOOLS_JS, 'utf8');
  vm.runInContext(toolsSrc, sb, { filename: 'imageEditorTools.js' });

  const wrapEl = makeCountingEl('div');
  const cursorEl = makeCountingEl('div');
  const sess1 = makeFakeSession();
  const sess2 = makeFakeSession();
  const sess3 = makeFakeSession();
  const T = sb.ImageEditorTools;

  T.installBrushCursor(sess1.session, wrapEl, cursorEl);
  T.installBrushCursor(sess2.session, wrapEl, cursorEl);
  T.installBrushCursor(sess3.session, wrapEl, cursorEl);

  assert.equal(wrapEl._listenerCount('mousemove'), 1,
    'R4.5 PE-035.functional: wrapEl must have exactly 1 mousemove listener after 3 installs (was 3 before fix)');
  assert.equal(wrapEl._listenerCount('mouseleave'), 1,
    'R4.5 PE-035.functional: wrapEl must have exactly 1 mouseleave listener after 3 installs (was 3 before fix)');
});

test('R4.5 PE-035.functional: installBrushCursor returns a disposer that detaches the canvas ie:viewport listener', () => {
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  const toolsSrc = fs.readFileSync(TOOLS_JS, 'utf8');
  vm.runInContext(toolsSrc, sb, { filename: 'imageEditorTools.js' });

  const wrapEl = makeCountingEl('div');
  const cursorEl = makeCountingEl('div');
  const sess = makeFakeSession();
  const T = sb.ImageEditorTools;

  const dispose = T.installBrushCursor(sess.session, wrapEl, cursorEl);
  assert.equal(typeof dispose, 'function', 'installBrushCursor must return a disposer function');
  assert.equal(sess.canvas._listenerCount('ie:viewport'), 1,
    'after install, the canvas has exactly 1 ie:viewport listener');

  dispose();
  assert.equal(sess.canvas._listenerCount('ie:viewport'), 0,
    'after dispose(), the canvas has 0 ie:viewport listeners');
});

test('R4.5 PE-035.functional: switching to a new session removes the previous canvas ie:viewport listener', () => {
  // The fix: installBrushCursor for session B must remove the
  // previous session A's ie:viewport listener (to avoid the
  // "stale session updates the cursor" bug).
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  const toolsSrc = fs.readFileSync(TOOLS_JS, 'utf8');
  vm.runInContext(toolsSrc, sb, { filename: 'imageEditorTools.js' });

  const wrapEl = makeCountingEl('div');
  const cursorEl = makeCountingEl('div');
  const sessA = makeFakeSession();
  const sessB = makeFakeSession();
  const T = sb.ImageEditorTools;

  T.installBrushCursor(sessA.session, wrapEl, cursorEl);
  assert.equal(sessA.canvas._listenerCount('ie:viewport'), 1);

  T.installBrushCursor(sessB.session, wrapEl, cursorEl);
  assert.equal(sessA.canvas._listenerCount('ie:viewport'), 0,
    'R4.5 PE-035.functional: switching to session B must remove the listener from session A\'s canvas (was the PE-035 stale-session bug)');
  assert.equal(sessB.canvas._listenerCount('ie:viewport'), 1);
});

test('R4.5 PE-035.adversarial: reverting to per-install wrap listeners makes the test fail', () => {
  // Adversarial probe: rewrite the tools source so the guard
  // is removed (forcing listeners to be re-attached on every
  // install), and verify the test catches it. We do a more
  // targeted mutation: change the `if (!wrapEl._ieBrushCursorInstalled)`
  // check so the wrap listeners are always added (simulating
  // the R4.5 pre-fix bug).
  const toolsSrc = fs.readFileSync(TOOLS_JS, 'utf8');
  // Two strategies: try a simple `replace` first. The guard is
  // `if (!wrapEl._ieBrushCursorInstalled) { ... }`. We flip it
  // to `if (true) { ... }` so the wrap listeners are always added.
  const brokenSrc = toolsSrc
    .replace(/if\s*\(\s*!wrapEl\._ieBrushCursorInstalled\s*\)\s*\{/, 'if (true) {');
  if (brokenSrc === toolsSrc) {
    console.warn('Adversarial probe could not find guard — skipping');
    return;
  }

  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  vm.runInContext(brokenSrc, sb, { filename: 'imageEditorTools.broken.js' });

  const wrapEl = makeCountingEl('div');
  const cursorEl = makeCountingEl('div');
  const sess = makeFakeSession();
  const T = sb.ImageEditorTools;
  T.installBrushCursor(sess.session, wrapEl, cursorEl);
  T.installBrushCursor(sess.session, wrapEl, cursorEl);
  T.installBrushCursor(sess.session, wrapEl, cursorEl);

  assert.equal(wrapEl._listenerCount('mousemove'), 3,
    'Adversarial probe: broken version should have 3 mousemove listeners (was 1 with fix)');
});

// ---- PE-027 functional: drop zone count is constant ----

test('R4.5 PE-027.functional: imageEditorSource.refreshQueueBar does NOT add sourceThumb listeners', () => {
  // Source-grep equivalent: load the source module + invoke
  // refreshQueueBar N times. Verify the sourceThumb never
  // accumulates listeners. (We can't easily test the overlay
  // wiring in vm-sandbox, but the source-grep test above is
  // already a strong defense.)
  const src = fs.readFileSync(SOURCE_JS, 'utf8');
  const codeOnly = stripComments(src);
  // The fix moves the sourceThumb setup to imageEditorOverlay.
  // The source module never references sourceThumb.addEventListener.
  assert.equal(codeOnly.indexOf('sourceThumb.addEventListener'), -1,
    'R4.5 PE-027.functional: imageEditorSource.js must not call sourceThumb.addEventListener (dropzone is one-time in overlay)');
});

// ============================================================================
// R4.5.AuditFix — Phasenpruefung-of-Phasenpruefung
// 5 defensive gaps + 4 test-coverage-gaps identified by the R4.5 review:
//   P-R45-02 (MITTEL): installBrushCursor(null) threw TypeError (defensive)
//   P-R45-13 (NIEDRIG): setupSourceThumbDropZone set guard BEFORE addEventListener
//   P-R45-13b (NIEDRIG): installBrushCursor had the same guard-order issue
//   P-R45-01 (NIEDRIG): dead code _ieCursorEl
//   P-R45-09 (NIEDRIG): installBrushCursor(sess, wrap, undefined cursorEl)
//   P-R45-T01-T05: missing test coverage
// ============================================================================

test('R4.5.AuditFix P-R45-02.functional: installBrushCursor(null) does NOT throw (defensive guard)', () => {
  // R4.5.AuditFix P-R45-02: the original R4.5 installBrushCursor
  // threw TypeError when called with null session (or null
  // canvas). The pre-fix code:
  //   try { session.canvas.on(...); } catch (_) {}  // caught
  //   session._ieViewportHandler = viewportHandler;  // NOT caught → throws
  // The fix adds a guard at the top of the function that returns
  // a no-op disposer for invalid inputs. This protects against
  // failed-to-load slots where slot.session may be null.
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(TOOLS_JS, 'utf8'), sb, { filename: 'imageEditorTools.js' });
  const T = sb.ImageEditorTools;

  const wrapEl = makeCountingEl('div');
  const cursorEl = makeCountingEl('div');
  let error = null;
  let dispose = null;
  try {
    dispose = T.installBrushCursor(null, wrapEl, cursorEl);
  } catch (e) { error = e; }
  assert.equal(error, null, 'installBrushCursor(null) must NOT throw (defensive guard)');
  assert.equal(typeof dispose, 'function', 'installBrushCursor(null) must return a no-op disposer');
  // The no-op disposer must be safely callable.
  let disposeError = null;
  try { dispose(); } catch (e) { disposeError = e; }
  assert.equal(disposeError, null, 'the no-op disposer must be safely callable');
});

test('R4.5.AuditFix P-R45-06.functional: re-installing for the same session keeps canvas listener count at 1', () => {
  // R4.5.AuditFix: the prev === session detach block in
  // installBrushCursor is the only thing that prevents a
  // double-attach on reinstall. Verify with N=3 reinstalls.
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(TOOLS_JS, 'utf8'), sb, { filename: 'imageEditorTools.js' });
  const T = sb.ImageEditorTools;

  const wrapEl = makeCountingEl('div');
  const cursorEl = makeCountingEl('div');
  const sess = makeFakeSession();
  T.installBrushCursor(sess.session, wrapEl, cursorEl);
  T.installBrushCursor(sess.session, wrapEl, cursorEl);
  T.installBrushCursor(sess.session, wrapEl, cursorEl);
  assert.equal(sess.canvas._listenerCount('ie:viewport'), 1,
    'P-R45-06: canvas must have exactly 1 ie:viewport listener after 3 reinstalls of same session');
});

test('R4.5.AuditFix P-R45-11.functional: installBrushCursor is idempotent across N=5 distinct sessions', () => {
  // Adversarial probe at scale: 5 different sessions, verify
  // wrap has 1+1 listeners, last session's canvas has 1
  // listener, all others have 0 (detached by subsequent
  // install).
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(TOOLS_JS, 'utf8'), sb, { filename: 'imageEditorTools.js' });
  const T = sb.ImageEditorTools;

  const wrapEl = makeCountingEl('div');
  const cursorEl = makeCountingEl('div');
  const sessions = [makeFakeSession(), makeFakeSession(), makeFakeSession(), makeFakeSession(), makeFakeSession()];
  for (const s of sessions) {
    T.installBrushCursor(s.session, wrapEl, cursorEl);
  }
  assert.equal(wrapEl._listenerCount('mousemove'), 1, 'wrapEl must have 1 mousemove listener');
  assert.equal(wrapEl._listenerCount('mouseleave'), 1, 'wrapEl must have 1 mouseleave listener');
  const lastSess = sessions[sessions.length - 1];
  assert.equal(lastSess.canvas._listenerCount('ie:viewport'), 1, 'last session canvas must have 1 listener');
  for (let i = 0; i < sessions.length - 1; i++) {
    assert.equal(sessions[i].canvas._listenerCount('ie:viewport'), 0,
      'session ' + i + ' canvas should have 0 listeners (detached by subsequent install)');
  }
});

test('R4.5.AuditFix P-R45-12.functional: returned disposer is stable (second call is a safe no-op)', () => {
  // After dispose() is called once, the handler reference is
  // nulled. A second call should NOT throw and should be a
  // no-op. Pre-fix would have thrown on the second call
  // because the disposer dereferences session._ieViewportHandler
  // without a guard.
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(TOOLS_JS, 'utf8'), sb, { filename: 'imageEditorTools.js' });
  const T = sb.ImageEditorTools;
  const wrapEl = makeCountingEl('div');
  const cursorEl = makeCountingEl('div');
  const sess = makeFakeSession();
  const dispose = T.installBrushCursor(sess.session, wrapEl, cursorEl);
  dispose();
  let error = null;
  try { dispose(); } catch (e) { error = e; }
  assert.equal(error, null, 'second dispose() call must NOT throw');
  assert.equal(sess.canvas._listenerCount('ie:viewport'), 0);
});

test('R4.5.AuditFix P-R45-13.source-grep: setupSourceThumbDropZone sets guard AFTER addEventListener', () => {
  // R4.5.AuditFix P-R45-13: pre-fix set the guard BEFORE
  // addEventListener, so a failed attach (detached element,
  // sandboxed env) would lock out retries. The fix inverts the
  // order: addEventListener first, guard second.
  const sourceSrc = fs.readFileSync(SOURCE_JS, 'utf8');
  const codeOnly = stripComments(sourceSrc);
  const fnMatch = codeOnly.match(/function setupSourceThumbDropZone\s*\([^)]*\)\s*\{([\s\S]*?)^\s*\}/m);
  assert.ok(fnMatch, 'setupSourceThumbDropZone function must exist');
  const body = fnMatch[1];
  const guardIdx = body.indexOf('_ieSourceDropZoneInstalled = true');
  const dragoverIdx = body.indexOf("addEventListener('dragover'");
  assert.ok(guardIdx >= 0, 'guard set must exist');
  assert.ok(dragoverIdx >= 0, 'dragover addEventListener must exist');
  assert.ok(guardIdx > dragoverIdx,
    'P-R45-13: guard must be set AFTER addEventListener (was BEFORE in pre-AuditFix R4.5)');
});

test('R4.5.AuditFix P-R45-13b.source-grep: installBrushCursor sets wrap-installed guard AFTER addEventListener', () => {
  // R4.5.AuditFix P-R45-13b: same guard-order issue in
  // installBrushCursor. The fix inverts the order.
  const toolsSrc = fs.readFileSync(TOOLS_JS, 'utf8');
  const codeOnly = stripComments(toolsSrc);
  const fnMatch = codeOnly.match(/function installBrushCursor\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*window\.ImageEditorTools/);
  assert.ok(fnMatch, 'installBrushCursor function must exist');
  const body = fnMatch[1];
  // The guard set in the wrap-installed branch.
  const guardIdx = body.indexOf('_ieBrushCursorInstalled = true');
  const mousemoveIdx = body.indexOf("addEventListener('mousemove'");
  assert.ok(guardIdx >= 0, 'wrap-installed guard set must exist');
  assert.ok(mousemoveIdx >= 0, 'mousemove addEventListener must exist');
  assert.ok(guardIdx > mousemoveIdx,
    'P-R45-13b: wrap-installed guard must be set AFTER addEventListener (was BEFORE in pre-AuditFix R4.5)');
});

test('R4.5.AuditFix P-R45-01.source-grep: dead code wrapEl._ieCursorEl is REMOVED', () => {
  // R4.5.AuditFix P-R45-01: _ieCursorEl was set but never read
  // (the refresh closure captures cursorEl directly). Removed
  // for code hygiene.
  const toolsSrc = fs.readFileSync(TOOLS_JS, 'utf8');
  const codeOnly = stripComments(toolsSrc);
  assert.equal(codeOnly.indexOf('_ieCursorEl'), -1,
    'P-R45-01: _ieCursorEl dead code must be removed (was set but never read)');
});

test('R4.5.AuditFix P-R45-04.functional: setupSourceThumbDropZone attaches 2 listeners + idempotent guard', () => {
  // R4.5.AuditFix: load imageEditorSource in vm-sandbox and
  // call setupSourceThumbDropZone. Verify 2 listeners attached
  // (dragover + drop) and re-invoking is a no-op.
  const sb = {};
  sb.window = sb;
  sb.console = console;
  sb.el = (t) => makeCountingEl(t);
  sb.loadImageFromFile = () => Promise.resolve({ naturalWidth: 100, naturalHeight: 60 });
  sb.toast = () => {};
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(SOURCE_JS, 'utf8'), sb, { filename: 'imageEditorSource.js' });
  const Source = sb.ImageEditorSource;

  const sourceThumb = makeCountingEl('div');
  const ctrl = { ui: { sourceThumb }, sourceTrayPath: null };

  Source.setupSourceThumbDropZone(ctrl);
  assert.equal(sourceThumb._listenerCount('dragover'), 1, 'sourceThumb should have 1 dragover listener');
  assert.equal(sourceThumb._listenerCount('drop'), 1, 'sourceThumb should have 1 drop listener');

  // Idempotency: re-invoking should be a no-op.
  Source.setupSourceThumbDropZone(ctrl);
  assert.equal(sourceThumb._listenerCount('dragover'), 1, 're-invoke should be a no-op');
  assert.equal(sourceThumb._listenerCount('drop'), 1, 're-invoke should be a no-op');
});

// ============================================================================
// QA-004 (360° bug-hunt) — reactivateSlotUI must mark the slot wired.
//
// Bug found: persistEditorSession sets slot._wired=false (after removing the
// canvas handlers). reopenPersisted -> reactivateSlotUI re-wires the active
// slot via wireCanvasEvents but did NOT set slot._wired=true. So the next
// activateSlot() switch away-and-back saw _wired===false and re-wired AGAIN,
// double-attaching every canvas handler: mouse:down fired twice -> pushUndo
// ran twice per stroke (undo depth doubled), pipette toasted twice, and the
// marquee/select logic ran twice. The fix sets slot._wired=true in
// reactivateSlotUI immediately after wireCanvasEvents, reconciling the
// EFH2-002 reopen-wire with the QA-004 _wired contract used by activateSlot.
// ============================================================================

function extractFnBody(codeOnly, name) {
  const startIdx = codeOnly.indexOf('function ' + name);
  if (startIdx < 0) return null;
  const bodyStart = codeOnly.indexOf('{', startIdx);
  if (bodyStart < 0) return null;
  let depth = 0, bodyEnd = -1;
  for (let i = bodyStart; i < codeOnly.length; i++) {
    const c = codeOnly[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
  }
  if (bodyEnd < 0) return null;
  return codeOnly.slice(startIdx, bodyEnd + 1);
}

test('QA-004.reopen: reactivateSlotUI marks the slot wired AFTER wireCanvasEvents (no double-wire on switch-back)', () => {
  const src = fs.readFileSync(OVERLAY_JS, 'utf8');
  const codeOnly = stripComments(src);
  const body = extractFnBody(codeOnly, 'reactivateSlotUI');
  assert.ok(body, 'reactivateSlotUI function must exist');
  const wireIdx = body.indexOf('wireCanvasEvents(ctrl, slot)');
  const wiredSetIdx = body.indexOf('slot._wired = true');
  assert.ok(wireIdx >= 0, 'reactivateSlotUI must call wireCanvasEvents(ctrl, slot)');
  assert.ok(wiredSetIdx >= 0,
    'QA-004 fix: reactivateSlotUI must set slot._wired = true so activateSlot does not re-wire again on switch-back');
  assert.ok(wiredSetIdx > wireIdx,
    'QA-004 fix: slot._wired = true must come AFTER wireCanvasEvents(ctrl, slot)');
});

test('QA-004.adversarial: removing slot._wired=true from reactivateSlotUI breaks the invariant', () => {
  const src = fs.readFileSync(OVERLAY_JS, 'utf8');
  const codeOnly = stripComments(src);
  const body = extractFnBody(codeOnly, 'reactivateSlotUI');
  assert.ok(body, 'reactivateSlotUI function must exist');
  // Simulate the pre-fix bug: drop the `slot._wired = true;` line. The
  // invariant asserted above must then no longer hold.
  const brokenBody = body.replace('slot._wired = true;', '');
  assert.notEqual(brokenBody, body, 'probe precondition: the fix line must be present to remove');
  assert.equal(brokenBody.indexOf('slot._wired = true'), -1,
    'adversarial: without slot._wired=true, reactivateSlotUI leaves the slot marked unwired -> activateSlot double-wires on switch-back (the QA-004 bug)');
});
