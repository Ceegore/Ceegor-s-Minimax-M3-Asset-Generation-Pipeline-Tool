// tests/unit/renderer/fbUpButtonBehavior.test.js
//
// Verifies the file browser Up button (#fb-up) handler logic in
// renderer/app.js. The handler is responsible for navigating the
// folder hierarchy through FOUR distinct levels:
//   1) A real folder inside output_dir → one level up
//   2) output_dir itself                → parent (or drives list)
//   3) A drive root                     → the DRIVES list
//   4) The DRIVES list                  → DISABLED (no-op)

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// Reuse the same sandbox shape as tabBehavioralHarness.
function makeSandbox() {
  const sandbox = {};
  const elements = {};
  const getOrCreate = (id) => {
    if (!elements[id]) {
      elements[id] = makeEl('div');
      elements[id].id = id;
    }
    return elements[id];
  };
  function makeEl(tag) {
    const el = {
      tagName: (tag || 'div').toUpperCase(),
      children: [], attributes: {}, style: {},
      classList: makeClassList(), dataset: {},
      _listeners: {}, _value: '', parentNode: null,
      addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
      removeEventListener() {},
      dispatchEvent(event) {
        for (const fn of (this._listeners[event.type] || [])) {
          try { fn(event); } catch (_) {}
        }
        return true;
      },
      appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      append(...children) {
        for (const c of children.flat()) {
          if (c == null || c === false) continue;
          if (typeof c === 'string' || typeof c === 'number') {
            const t = makeEl('span'); t._text = String(c);
            this.children.push(t); t.parentNode = this;
          } else if (typeof c === 'object' && c.tagName) {
            this.children.push(c); c.parentNode = this;
          }
        }
        return this;
      },
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k] == null ? null : String(this.attributes[k]); },
      querySelector(sel) {
        if (typeof sel !== 'string') return null;
        const stack = [...this.children];
        while (stack.length) {
          const n = stack.shift();
          if (sel.startsWith('#') && n && n.id === sel.slice(1)) return n;
          if (sel.startsWith('.') && n && n.classList && n.classList._set && n.classList._set.has(sel.slice(1))) return n;
          if (n && n.tagName === sel.toUpperCase()) return n;
          if (n && n.children && n.children.length) stack.push(...n.children);
        }
        return null;
      },
      querySelectorAll() { return []; },
      focus() {}, blur() {},
      click() { this.dispatchEvent({ type: 'click', target: this }); },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      contains() { return false; },
      closest(sel) {
        if (typeof sel !== 'string') return null;
        const match = (n) => {
          if (sel.startsWith('.')) return n.classList && n.classList._set && n.classList._set.has(sel.slice(1));
          if (sel.startsWith('#')) return n.id === sel.slice(1);
          return n.tagName === sel.toUpperCase();
        };
        let cur = this;
        while (cur) { if (match(cur)) return cur; cur = cur.parentNode; }
        return null;
      },
      set textContent(v) { this._text = v; this.children = []; },
      get textContent() { return this._text || this.children.map((c) => c.textContent || '').join(''); },
      set innerHTML(v) { this._innerHTML = v; this.children = []; },
      get innerHTML() { return this._innerHTML || ''; },
      get value() { return this._value; },
      set value(v) { this._value = v; },
      get type() { return this.attributes.type; },
      set type(v) { this.attributes.type = v; },
      get id() { return this.attributes.id; },
      set id(v) { this.attributes.id = v; },
      get className() { return Array.from(this.classList._set || []).join(' '); },
      set className(v) { this.classList._set.clear(); for (const cls of String(v || '').split(/\s+/).filter(Boolean)) this.classList._set.add(cls); },
      get disabled() { return !!this._disabled; },
      set disabled(v) { this._disabled = !!v; },
      get checked() { return !!this._checked; },
      set checked(v) { this._checked = !!v; },
    };
    return el;
  }
  function makeClassList() {
    const set = new Set();
    return {
      _set: set,
      add(c) { if (c != null) for (const cls of String(c).split(/\s+/).filter(Boolean)) set.add(cls); },
      remove(c) { if (c != null) for (const cls of String(c).split(/\s+/).filter(Boolean)) set.delete(cls); },
      contains(c) { return set.has(c); },
      toggle(c, force) { if (force === true) set.add(c); else if (force === false) set.delete(c); else if (set.has(c)) set.delete(c); else set.add(c); return set.has(c); },
    };
  }

  const fbUp = makeEl('button'); fbUp.id = 'fb-up'; elements['fb-up'] = fbUp;
  const fbList = makeEl('div'); fbList.id = 'fb-list'; elements['fb-list'] = fbList;
  const fbPath = makeEl('div'); fbPath.id = 'fb-path'; elements['fb-path'] = fbPath;

  const document = {
    getElementById: (id) => getOrCreate(id),
    querySelector: (sel) => (typeof sel === 'string' && sel.startsWith('#') ? getOrCreate(sel.slice(1)) : null),
    querySelectorAll: () => [],
    createElement: (tag, attrs, ...children) => {
      const n = makeEl(tag);
      if (attrs && typeof attrs === 'object') {
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'class') n.classList.add(v);
          else if (k === 'style' && typeof v === 'string') n.attributes.style = v;
          else if (k.startsWith('data-')) n.attributes[k] = v;
          else if (k === 'value') n._value = v;
          else if (k === 'text') n._text = v;
          else if (k === 'id') { n.attributes.id = v; n.id = v; }
          else n.attributes[k] = v;
        }
      }
      if (children && children.length) n.append(...children);
      return n;
    },
    createTextNode: (text) => { const n = makeEl('span'); n._text = String(text); return n; },
    documentElement: { getPropertyValue: () => '' },
    addEventListener: () => {}, removeEventListener: () => {},
    body: getOrCreate('body'),
  };

  const refreshBrowserCalls = [];
  const toasts = [];
  const refreshBrowser = async () => { refreshBrowserCalls.push({ fbDir: state.fbDir }); };

  const state = {
    config: { api_key: 'sk-test', output_dir: 'C:\\Users\\me\\Pictures\\MiniMax-Assets', region: 'global', theme: 'dark', styles: [] },
    theme: 'dark', apiKeyNoSave: false,
    fbDir: '', fbDirs: { image: '', speech: '', music: '', video: '' },
    currentTab: 'image', genStatus: { image: 'idle', speech: 'idle', music: 'idle', video: 'idle' },
    popupPolicy: 'never', seenPopups: {},
    batchSize: { image: 1, speech: 1, music: 1, video: 1 },
    batches: { image: [], speech: [], music: [], video: [] },
    quotas: {}, tabSettings: { image: {}, speech: {}, music: {}, video: {} },
    jobs: [], jobsSnapshot: [], _logEvents: [],
  };

  const api = {
    fbList: () => Promise.resolve({ ok: true, entries: [] }),
    fbListDrives: () => Promise.resolve({ ok: true, drives: [{ name: 'C:\\', label: 'C:\\' }, { name: 'D:\\', label: 'D:\\' }] }),
    fbEnsureDir: () => Promise.resolve({ ok: true, path: 'C:\\fake' }),
    fbMkdir: () => Promise.resolve({ ok: true }),
  };

  Object.assign(sandbox, {
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: (cb) => setTimeout(cb, 16), cancelAnimationFrame: () => {},
    Promise, Array, Object, String, Number, Boolean, Date, Math, JSON, Map, Set, WeakMap, WeakSet, Symbol,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    URL, Blob, File, FormData, fetch,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    Audio: class { constructor() { this.src = ''; this.preload = ''; } },
    FileUrl: { fileUrl: () => 'file:///fake', makeFileUrl: () => 'file:///fake' },
    api, state,
    $: (sel) => (typeof sel === 'string' && sel.startsWith('#') ? getOrCreate(sel.slice(1)) : null),
    // KGO7-007: capture toasts so the "Up is refused at output_dir" test
    // can assert the user was actually told why.
    toast: (msg, kind, ms) => { toasts.push({ msg: String(msg), kind, ms }); },
    showModal: () => {}, refreshBrowser, scheduleStateSave: () => {},
    addLogEvent: () => 1, document,
    location: { href: 'app://ceegor/', protocol: 'app:', host: 'ceegor' },
    navigator: { userAgent: 'node-test', language: 'en', platform: 'test' },
    addEventListener: () => {}, removeEventListener: () => {},
    confirm: () => true, asyncConfirm: async () => true, alert: () => {}, prompt: () => null,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    devicePixelRatio: 1,
    elements, getOrCreate,
    _refreshBrowserCalls: refreshBrowserCalls,
    _toasts: toasts,
    // BUG-9-01a regression guard (_temp9.md): the REAL renderer has
    // NO `process` global (contextIsolation:true, nodeIntegration:false).
    // An earlier version of this test injected `process: { platform: 'win32' }`
    // to "make the handler work in Node", which silently hid a
    // `ReferenceError: process is not defined` that fired on every Up
    // click in the live renderer. We now deliberately do NOT inject
    // `process` (the helper is shape-based, not platform-based), and
    // there is a dedicated test below ("fb-up: handler must NOT
    // reference the `process` global") that asserts the handler
    // runs cleanly with `process` absent.
  });
  sandbox.createElement = document.createElement;
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.global = sandbox;
  return sandbox;
}

function loadAppJs(sandbox) {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');

  // Find the listener. We use a balanced-brace scan from the start
  // of the arrow body to its matching close brace.
  const startMarker = "$('#fb-up')";
  const rawStartIdx = src.indexOf(startMarker);
  if (rawStartIdx < 0) throw new Error('fb-up listener not found');
  const arrowOpen = src.indexOf('() => {', rawStartIdx);
  if (arrowOpen < 0) throw new Error('arrow body open not found');
  const bodyStart = arrowOpen + '() => {'.length;
  // Balanced-brace scan. We start at depth=1 because we just
  // entered the listener arrow body (`() => {` opened a brace we
  // haven't counted yet). Scan forward; each `{` increments, each
  // `}` decrements; stop when depth returns to 0.
  let depth = 1;
  let i = bodyStart;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
    i++;
  }
  const bodyEnd = i;
  // Slice the body content INSIDE the braces (bodyEnd points one
  // past the closing `}` so we subtract 1).
  const handlerBody = src.slice(bodyStart, bodyEnd - 1);

  // Also need the helpers (FB_DRIVES_SENTINEL, isDrivesList,
  // isDriveRoot, updateFbUpButton) which are declared inside
  // init()'s closure. We extract them so they can be re-declared
  // in the vm sandbox before the handler runs.
  const helperMarker = 'const FB_DRIVES_SENTINEL';
  let helperStart = src.lastIndexOf(helperMarker, rawStartIdx);
  if (helperStart < 0) throw new Error('FB_DRIVES_SENTINEL helper not found');
  // The helper block ends with the close of updateFbUpButton().
  // The marker "btn.title = 'Up one level';" sits in the else-
  // branch body, with two `}` after it (else-block close, then
  // updateFbUpButton close). Walk forward, tracking brace depth;
  // break when depth returns to 0 AFTER the marker.
  const helperEndMarker = "btn.title = 'Up one level';";
  const helperEndStart = src.indexOf(helperEndMarker, helperStart);
  if (helperEndStart < 0) throw new Error('updateFbUpButton end marker not found');
  let d = 0; let k2 = helperStart;
  let hitMarker = false;
  while (k2 < src.length) {
    const c = src[k2];
    if (c === '{') d++;
    else if (c === '}') {
      d--;
      if (d === 0 && hitMarker) { k2++; break; }
    }
    if (k2 >= helperEndStart) hitMarker = true;
    k2++;
  }
  const helpers = src.slice(helperStart, k2);

  // Extract parentDir from pureFuncs.js. Use '\nfunction ' to
  // skip matches inside the file header comment.
  const pureSrc = fs.readFileSync(path.join(ROOT, 'renderer/utils/pureFuncs.js'), 'utf8');
  const pureStart = pureSrc.indexOf('\nfunction parentDir') + 1;
  let parentDirEndSrc = pureSrc.indexOf('\nfunction ', pureStart);
  if (parentDirEndSrc < 0) parentDirEndSrc = pureSrc.length;
  const parentDirSrc = pureSrc.slice(pureStart, parentDirEndSrc > 0 ? parentDirEndSrc : pureSrc.length);

  const ctx = vm.createContext(sandbox);
  ctx.setInterval = () => 0;
  ctx.setTimeout = () => 0;
  ctx.queueMicrotask = (fn) => { try { fn(); } catch (_) {} };
  ctx.console = console;

  // Concatenate string-by-string to avoid template-literal
  // interpolation conflicts (handlerBody contains backticks).
  const script =
    parentDirSrc + '\n' +
    helpers + '\n' +
    'window.__fbUpHandler = function() {\n' +
    handlerBody + '\n' +
    '};\n' +
    "document.getElementById('fb-up').addEventListener('click', window.__fbUpHandler);\n";
  vm.runInContext(script, ctx);
  return ctx;
}

function clickFbUp(sandbox) {
  const btn = sandbox.getOrCreate('fb-up');
  for (const fn of (btn._listeners.click || [])) fn({ type: 'click', target: btn });
}

function flush(n = 5) {
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => { if (++i >= n) resolve(); else setImmediate(tick); };
    setImmediate(tick);
  });
}

// ===========================================================================
// Tests
// ===========================================================================

// KGO7-007: output_dir is the browse CEILING. This test previously
// asserted that Up climbs to the parent — behaviour the app could not
// actually deliver: the climb depended on `window.api.fbTrustAncestors`,
// a binding removed with `fb:trust-ancestors` by the S1 security model
// (asserted absent by tests/unit/security/setActiveDir.security.test.js).
// Guarded by `typeof … === 'function'`, that call was a permanent no-op,
// so fb:list on the parent was rejected and refreshBrowser() reverted —
// measured live: fbDir unchanged after 3 clicks, button still enabled.
// The app now refuses explicitly and disables the button.
test('fb-up: at output_dir, Up refuses to climb and says why (output_dir is the ceiling)', async () => {
  const sandbox = makeSandbox();
  loadAppJs(sandbox);
  sandbox.state.fbDir = 'C:\\Users\\me\\Pictures\\MiniMax-Assets';
  const before = sandbox._refreshBrowserCalls.length;
  clickFbUp(sandbox);
  await flush();
  assert.equal(sandbox.state.fbDir, 'C:\\Users\\me\\Pictures\\MiniMax-Assets',
    'Up at output_dir must NOT change fbDir (the app may not browse above it)');
  assert.equal(sandbox._refreshBrowserCalls.length, before,
    'no pointless refresh: the navigation is refused up front');
  const toasts = (sandbox._toasts || []).map((t) => String(t && t.msg !== undefined ? t.msg : t));
  assert.ok(toasts.some((t) => /output folder|authorise|authorize/i.test(t)),
    'the user must be told why the click did nothing. Toasts: ' + JSON.stringify(toasts));
});

test('fb-up: the button is DISABLED at output_dir (not enabled-but-dead)', async () => {
  const sandbox = makeSandbox();
  loadAppJs(sandbox);
  sandbox.state.fbDir = 'C:\\Users\\me\\Pictures\\MiniMax-Assets';
  assert.equal(typeof sandbox.window.updateFbUpButton, 'function',
    'app.js must expose updateFbUpButton so refreshBrowser can re-apply it');
  sandbox.window.updateFbUpButton();
  const btn = sandbox.document.querySelector('#fb-up');
  assert.equal(btn.disabled, true, 'the Up button must be disabled at the output root');
  assert.ok(/output folder/i.test(btn.title || ''),
    'the tooltip must explain the ceiling. Got: ' + btn.title);
});

test('fb-up: at the drives sentinel, Up is a no-op', async () => {
  const sandbox = makeSandbox();
  loadAppJs(sandbox);
  sandbox.state.fbDir = '__DRIVES__';
  const before = sandbox._refreshBrowserCalls.length;
  clickFbUp(sandbox);
  await flush();
  assert.equal(sandbox.state.fbDir, '__DRIVES__', 'Up at drives list must be a no-op');
  assert.equal(sandbox._refreshBrowserCalls.length, before, 'refreshBrowser must NOT be called at drives list');
});

test('fb-up: at a drive root (not output_dir), Up jumps to the drives list', async () => {
  const sandbox = makeSandbox();
  sandbox.state.config.output_dir = 'C:\\Users\\me\\Pictures\\MiniMax-Assets';
  loadAppJs(sandbox);
  sandbox.state.fbDir = 'D:\\';
  clickFbUp(sandbox);
  await flush();
  assert.equal(sandbox.state.fbDir, '__DRIVES__', 'Up from a drive root (not the output_dir) must jump to the drives list');
});

test('fb-up: empty state.fbDir jumps to output_dir, or to drives list when no output_dir', async () => {
  const sandbox = makeSandbox();
  loadAppJs(sandbox);
  // No fbDir, output_dir set.
  sandbox.state.fbDir = '';
  clickFbUp(sandbox);
  await flush();
  assert.equal(sandbox.state.fbDir, sandbox.state.config.output_dir,
    'Up with empty fbDir and a real output_dir must jump to output_dir');

  // No fbDir, no output_dir → drives sentinel.
  sandbox.state.fbDir = '';
  sandbox.state.config.output_dir = '';
  clickFbUp(sandbox);
  await flush();
  assert.equal(sandbox.state.fbDir, '__DRIVES__',
    'Up with empty fbDir and no output_dir must go to drives list');
});

test('fb-up: in a real subfolder of output_dir, Up climbs one level', async () => {
  const sandbox = makeSandbox();
  loadAppJs(sandbox);
  sandbox.state.fbDir = 'C:\\Users\\me\\Pictures\\MiniMax-Assets\\2024';
  clickFbUp(sandbox);
  await flush();
  assert.equal(sandbox.state.fbDir, 'C:\\Users\\me\\Pictures\\MiniMax-Assets',
    'Up from a subfolder must climb one level');
});

// BUG-9-01a regression guard (_temp9.md): the live renderer has
// NO `process` global. The previous version of this test file
// injected `process: { platform: 'win32' }` into the sandbox,
// which hid a `ReferenceError: process is not defined` that
// fired on every Up click in the real app. We now assert the
// handler runs cleanly WITHOUT any `process` global in the
// sandbox — exactly the live-renderer shape.
test('fb-up: handler must NOT reference the `process` global (real renderer has none)', async () => {
  const sandbox = makeSandbox();
  // Defensive: if a future change re-adds `process` to the
  // sandbox, fail loudly so the test stops "lying" about
  // behaviour it doesn't actually verify.
  assert.equal(sandbox.process, undefined,
    'this test only proves anything when the sandbox has NO `process` global — the live renderer is the same shape');
  loadAppJs(sandbox);
  // The exact case that threw in production: Up from a real
  // subfolder. Pre-fix: handler reached `process.platform`,
  // threw, try/catch swallowed it, fbDir never changed.
  sandbox.state.fbDir = 'C:\\Users\\me\\Pictures\\MiniMax-Assets\\2024\\deeper';
  clickFbUp(sandbox);
  await flush();
  assert.equal(sandbox.state.fbDir, 'C:\\Users\\me\\Pictures\\MiniMax-Assets\\2024',
    'Up from a subfolder MUST climb one level even when `process` is undefined (live renderer has no `process`)');
  // Drive-root case: a click on Up while at D:\ used to throw
  // inside isDriveRoot() and the click was silently swallowed.
  sandbox.state.fbDir = 'D:\\';
  clickFbUp(sandbox);
  await flush();
  assert.equal(sandbox.state.fbDir, '__DRIVES__',
    'Up from a drive root MUST jump to the drives list even when `process` is undefined');
});