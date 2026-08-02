// tests/unit/renderer/settingsDialogBehavior.test.js
//
// Behavioral test for the ⚙ Settings dialog (renderer/sections/
// section04_Settings.js + section03_Settings_tab_panes.js). Loads
// every renderer script via vm.createContext, opens the settings
// modal, edits the General pane (API key, output directory,
// region, theme, "Don't save"), clicks Save, and verifies the
// config:set IPC payload.
//
// What this catches:
//   - the "Don't save" checkbox leaking the API key into config:set
//   - a missing/extra field in the config:set payload (theme/styles
//     got silently dropped by the legacy single-modal save path;
//     the new path uses `Object.assign(merged, partial)` so we want
//     a regression test)
//   - the Save handler throwing when config:set rejects (envelope
//     {ok:false} must not crash the next line)
//   - state.config.theme not updated after a successful save
//
// Phase A: confirm the happy path with a valid config:set response.
// Phase B: confirm the "Don't save" key is stripped from the IPC
// payload but kept in state.config.api_key for the running session.
// Phase C: confirm config:set envelope errors surface a toast and
// DO NOT close the modal.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// Build a sandbox similar to tabBehavioralHarness but tailored for the
// settings dialog. The dialog only needs the renderer scripts that
// touch openSettings / buildSettingsGeneralPane / etc. We load the
// whole index.html script set so dependencies (showRevealableKey,
// helpButton, showDiagnose, scheduleStateSave) all resolve.
// ---------------------------------------------------------------------------

// Module-scope list of all toasts captured during a test run.
// section20_Structured_event_log.js declares `function toast` at
// the top level of its script — in vm.createContext that becomes a
// property of the global, shadowing the test's `sandbox.toast` mock.
// loadRendererScripts() re-wraps `sandbox.toast` AFTER the real toast
// has loaded so every call also lands here.
const liveToasts = [];

function buildSandbox() {
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
      children: [],
      attributes: {},
      style: {},
      classList: makeClassList(),
      dataset: {},
      _listeners: {},
      _value: '',
      _text: null,
      _innerHTML: '',
      parentNode: null,
      addEventListener(ev, fn) {
        (this._listeners[ev] = this._listeners[ev] || []).push(fn);
      },
      removeEventListener() {},
      dispatchEvent(event) {
        for (const fn of (this._listeners[event.type] || [])) {
          try {
            const r = fn(event);
            if (r && typeof r.catch === 'function') r.catch((_) => {});
          } catch (_) { /* swallow */ }
        }
        return true;
      },
      appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      append(...children) {
        for (const c of children.flat()) {
          if (c == null || c === false) continue;
          if (typeof c === 'string' || typeof c === 'number') {
            const t = makeEl('span');
            t._text = String(c);
            this.children.push(t);
            t.parentNode = this;
          } else if (typeof c === 'object' && c.tagName) {
            this.children.push(c);
            c.parentNode = this;
          }
        }
        return this;
      },
      removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parentNode = null; return child; },
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k] == null ? null : String(this.attributes[k]); },
      querySelector(sel) {
        if (typeof sel !== 'string') return null;
        if (sel.startsWith('#')) {
          const want = sel.slice(1);
          const stack = [...this.children];
          while (stack.length) {
            const n = stack.shift();
            if (n && n.id === want) return n;
            if (n && n.children && n.children.length) stack.push(...n.children);
          }
          return null;
        }
        if (sel.startsWith('.')) {
          const cls = sel.slice(1);
          const stack = [...this.children];
          while (stack.length) {
            const n = stack.shift();
            if (n && n.classList && n.classList._set && n.classList._set.has(cls)) return n;
            if (n && n.children && n.children.length) stack.push(...n.children);
          }
          return null;
        }
        const stack = [...this.children];
        while (stack.length) {
          const n = stack.shift();
          if (n && n.tagName === sel.toUpperCase()) return n;
          if (n && n.children && n.children.length) stack.push(...n.children);
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const stack = [...this.children];
        const matcher = (n) => {
          if (typeof sel !== 'string') return false;
          if (sel.startsWith('#')) return n.id === sel.slice(1);
          if (sel.startsWith('.')) return n.classList && n.classList._set && n.classList._set.has(sel.slice(1));
          return n.tagName === sel.toUpperCase();
        };
        while (stack.length) {
          const n = stack.shift();
          if (n && matcher(n)) out.push(n);
          if (n && n.children && n.children.length) stack.push(...n.children);
        }
        return out;
      },
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
      getBoundingClientRect() { return { top: 0, left: 0, right: 800, bottom: 200, width: 800, height: 200 }; },
      set textContent(v) { this._text = v; this.children = []; },
      // textContent must reflect children when _text is unset (the
      // common case for <button>Save</button>). The previous
      // 'this._text != null ? this._text : ...' returned '' whenever
      // _text was the initial '' (the makeEl default), even if the
      // element had a SPAN child with text.
      get textContent() { return this._text || this.children.map((c) => c.textContent || '').join(''); },
      set innerHTML(v) { this._innerHTML = v; this.children = []; },
      get innerHTML() { return this._innerHTML || ''; },
      get value() { return this._value; },
      set value(v) { this._value = v; },
      // Mirror real DOM: inp.type = 'text' must reflect in attributes.type
      // so the test's findByTag/modal.querySelector filter works.
      get type() { return this.attributes.type; },
      set type(v) { this.attributes.type = v; },
      get id() { return this.attributes.id; },
      set id(v) { this.attributes.id = v; },
      get className() { return Array.from(this.classList._set || []).join(' '); },
      set className(v) { this.classList._set.clear(); for (const cls of String(v || '').split(/\s+/).filter(Boolean)) this.classList._set.add(cls); },
      get checked() { return !!this._checked; },
      set checked(v) { this._checked = !!v; },
      get disabled() { return !!this._disabled; },
      set disabled(v) { this._disabled = !!v; },
      get readOnly() { return !!this._readonly; },
      set readOnly(v) { this._readonly = !!v; },
      get selected() { return !!this._selected; },
      set selected(v) { this._selected = !!v; },
      get files() { return this._files || []; },
      set files(v) { this._files = v; },
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
          else if (k.startsWith('data-')) { n.attributes[k] = v; }
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
    documentElement: { getPropertyValue: () => '', attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } },
    addEventListener: () => {},
    removeEventListener: () => {},
    body: getOrCreate('body'),
  };

  // Collect config:set calls for inspection.
  const setConfigCalls = [];
  const pickFolderCalls = [];
  const authStatusCalls = [];
  const configPathCalls = [];

  // Default state. Each test can override BEFORE calling openSettings.
  const state = {
    config: {
      api_key: 'sk-test-original-key',
      output_dir: 'C:\\original\\output',
      region: 'global',
      theme: 'dark',
      styles: [],
    },
    theme: 'dark',
    apiKeyNoSave: false,
    fbDir: '',
    fbDirs: { image: '', speech: '', music: '', video: '' },
    currentTab: 'image',
    batchSize: { image: 1, speech: 1, music: 1, video: 1 },
    batches: { image: [], speech: [], music: [], video: [] },
    quotas: {},
    tabSettings: { image: {}, speech: {}, music: {}, video: {} },
    jobs: [],
    jobsSnapshot: [],
    _logEvents: [],
    popupPolicy: 'never',
    seenPopups: {},
    // pipelineAdvancedSettings is also persisted via config.txt. The
    // Advanced Pipeline Settings overlay (section25) owns it.
    pipelineAdvancedSettings: {
      image: { upscale: { enabled: false }, nobg: { enabled: false } },
      audio: { mp3Quality: 2, oggQuality: 5, opusBitrate: 128000, m4aBitrate: 192000 },
    },
  };

  const api = {
    setConfig: (cfg) => {
      // Default success envelope. Tests can wrap this with their own
      // mock by reassigning sandbox.api.setConfig.
      // R2.3.1: the renderer now sends a wrapped payload
      // {cfg: merged, apiKeyNoSave: ...}; the main handler returns
      // {ok, config: <unwrapped cfg>}. We mirror that contract by
      // unwrapping the cfg here so state.config is the actual
      // saved cfg, not a wrapper.
      const unwrapped = (cfg && typeof cfg === 'object' && cfg.cfg && typeof cfg.cfg === 'object') ? cfg.cfg : cfg;
      return Promise.resolve({ ok: true, config: { ...unwrapped } });
    },
    configPath: () => {
      configPathCalls.push('configPath');
      return Promise.resolve('C:\\fake\\config.txt');
    },
    pickFolder: () => {
      pickFolderCalls.push('pickFolder');
      return Promise.resolve('C:\\user-picked\\folder');
    },
    authStatus: () => {
      authStatusCalls.push('authStatus');
      return Promise.resolve({ ok: true, message: 'Authentication OK.' });
    },
    refreshQuota: () => Promise.resolve({ ok: true }),
    refreshBrowser: () => Promise.resolve({ ok: true }),
    quota: () => Promise.resolve({ ok: true, remaining: 1000, total: 1000 }),
    fbList: () => Promise.resolve({ ok: true, entries: [] }),
  };

  // showModal captures the modal root so the test can poke it.
  const modalStack = [];
  const showModal = (builder, opts) => {
    const modal = makeEl('div');
    if (opts && opts.id) modal.id = opts.id;
    modalStack.push(modal);
    builder(modal, () => { modal._closeCalled = true; });
  };

  // `liveToasts` is module-scoped (see top of file) so loadRendererScripts
  // can re-wrap the live toast AFTER the scripts overwrite it.
  const scheduleStateSave = () => {};

  Object.assign(sandbox, {
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: (cb) => setTimeout(cb, 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    Promise, Array, Object, String, Number, Boolean, Date, Math, JSON, Map, Set, WeakMap, WeakSet, Symbol,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    URL, Blob, File, FormData, fetch,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    Audio: class { constructor() { this.src = ''; this.preload = ''; } },
    FileUrl: { fileUrl: (p) => 'file:///' + String(p).replace(/\\/g, '/'), makeFileUrl: (p) => 'file:///' + String(p).replace(/\\/g, '/') },
    api,
    state,
    $: (sel) => (typeof sel === 'string' && sel.startsWith('#') ? getOrCreate(sel.slice(1)) : null),
toast: (msg, kind, ms) => { liveToasts.push({ msg, kind, ms }); },
    // After scripts load, `toast` gets overwritten by section20. We
    // patch it again so the test can detect calls. The 'real' toast
    // (section20's version) appends to #toast-root, which we read at
    // the end of each test.
    _toast: (msg, kind, ms) => { toasts.push({ msg, kind, ms }); },
    showModal,
    refreshBrowser: () => Promise.resolve(),
    refreshQuota: () => {},
    scheduleStateSave,
    addLogEvent: () => 1,
    document,
    location: { href: 'app://ceegor/', protocol: 'app:', host: 'ceegor' },
    navigator: { userAgent: 'node-test', language: 'en', platform: 'test' },
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: () => true,
    asyncConfirm: async () => true,
    alert: () => {},
    prompt: () => null,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    devicePixelRatio: 1,
    elements,
    getOrCreate,
    _setConfigCalls: setConfigCalls,
    _toasts: liveToasts,
    _modalStack: modalStack,
    _docCreateElement: document.createElement,
  });
  // Mirror createElement so ParamRow.js's el() picks up the rich mock.
  sandbox.createElement = document.createElement;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  return sandbox;
}

// ---------------------------------------------------------------------------
// Load every renderer script in dependency order (top-down from index.html).
// ---------------------------------------------------------------------------

function loadRendererScripts(sandbox) {
  // setConfigCalls is a closure variable inside buildSandbox. We
  // reach it via the _setConfigCalls reference the sandbox exposes.
  const setConfigCalls = sandbox._setConfigCalls;
  const context = vm.createContext(sandbox);
  // Patch setInterval/setTimeout so debugLog.js etc. don't actually
  // poll. setTimeout is INTENTIONALLY a no-op (not a sync-call fn)
  // because section20_Structured_event_log.js's toast() schedules
  // `setTimeout(() => t.remove(), ms)` to auto-dismiss toasts.
  // Running that synchronously would erase the toast before the
  // test can inspect it.
  context.setInterval = () => 0;
  context.setTimeout = () => 0;
  context.clearInterval = () => {};
  context.clearTimeout = () => {};
  context.queueMicrotask = (fn) => { try { fn(); } catch (_) {} };

  const indexHtml = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  const scriptOrder = [];
  const re = /<script\s+src="([^"]+)"/g;
  let mm;
  while ((mm = re.exec(indexHtml)) !== null) scriptOrder.push(mm[1]);

  const errors = [];
  for (const rel of scriptOrder) {
    const full = path.join(ROOT, 'renderer', rel);
    let src;
    try { src = fs.readFileSync(full, 'utf8'); }
    catch (e) { errors.push(`READ FAIL ${rel}: ${e.message}`); continue; }
    src = '// ' + full + '\n' + src;
    try { vm.runInContext(src, context, { filename: full, timeout: 5000 }); }
    catch (e) { errors.push(`EVAL FAIL ${rel}: ${e.message}`); }
  }
  // section20_Structured_event_log.js declares `function toast` at
  // top level of its script, which (in vm context) becomes a property
  // of the global object — shadowing the test's `sandbox.toast`.
  // Wrap the live toast so every call also pushes into liveToasts.
  if (typeof sandbox.toast === 'function') {
    const liveToast = sandbox.toast;
    sandbox.toast = (msg, kind, ms) => {
      try { liveToasts.push({ msg, kind, ms }); } catch (_) {}
      return liveToast(msg, kind, ms);
    };
  }
  // Wrap api.setConfig so every call is captured (pushes to
  // setConfigCalls). Tests that override sandbox.api.setConfig inline
  // (e.g. the failing-envelope test) replace this wrapper entirely,
  // so they don't double-count — they push themselves via a separate
  // path. We DO push here so the basic mock (which doesn't push)
  // is still observable in the happy-path tests.
  if (typeof sandbox.api.setConfig === 'function') {
    const orig = sandbox.api.setConfig;
    const wrapped = (cfg) => {
      setConfigCalls.push({ method: 'setConfig', payload: cfg });
      return orig(cfg);
    };
    sandbox.api.setConfig = wrapped;
    sandbox.window.api.setConfig = wrapped;
  }
  // SAME WRAP FOR window.api too, since the Save handler reads
  // window.api.setConfig. In vm context window === sandbox, so
  // assigning sandbox.api.setConfig also sets window.api.setConfig.
  // The handler then calls window.api.setConfig which IS the same
  // function — so the wrap covers both reads. But scripts that
  // capture the reference at load time would be different. Log
  // a marker.
  return { context, errors };
}

// ---------------------------------------------------------------------------
// Open the settings dialog and return the modal root.
// ---------------------------------------------------------------------------

function openSettingsInSandbox(sandbox) {
  assert.ok(typeof sandbox.openSettings === 'function', 'openSettings must be exported');
  // Reset per-test state.
  sandbox._setConfigCalls.length = 0;
  sandbox._toasts.length = 0;
  // Clear any previous toast-root contents so we don't see stale toasts.
  const oldToastRoot = sandbox.getOrCreate('toast-root');
  if (oldToastRoot && oldToastRoot.children) oldToastRoot.children.length = 0;
  // Pre-set state.config so the General pane shows the original key.
  sandbox.state.config.api_key = sandbox.state.config.api_key || 'sk-test-original-key';
  sandbox.state.config.output_dir = sandbox.state.config.output_dir || 'C:\\original\\output';
  // The real showModal (section19_Modal.js) creates a `.modal` div
  // inside #modal-root. We read #modal-root directly because the
  // modal's internal _modalStack is a const inside the script and
  // not observable from outside.
  const modalRoot = sandbox.getOrCreate('modal-root');
  const beforeCount = modalRoot.children.length;
  sandbox.openSettings();
  const modal = modalRoot.children[modalRoot.children.length - 1];
  assert.ok(modal && modal !== modalRoot, 'showModal must have created a modal root');
  assert.ok(modalRoot.children.length > beforeCount, 'modal-root must have grown by one modal');
  return modal;
}

function flush(n = 30) {
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => { if (++i >= n) resolve(); else setImmediate(tick); };
    setImmediate(tick);
  });
}

// ---------------------------------------------------------------------------
// Helpers to find elements inside the modal by tag / class / data attr.
// ---------------------------------------------------------------------------

function findByTag(root, tag) {
  const out = [];
  const stack = [...root.children];
  while (stack.length) {
    const n = stack.shift();
    if (n.tagName === tag) out.push(n);
    if (n.children) for (const c of n.children) stack.push(c);
  }
  return out;
}

function findByClass(root, cls) {
  const out = [];
  const stack = [...root.children];
  while (stack.length) {
    const n = stack.shift();
    if (n.classList && n.classList._set && n.classList._set.has(cls)) out.push(n);
    if (n.children) for (const c of n.children) stack.push(c);
  }
  return out;
}

function findByText(root, regex) {
  const out = [];
  const stack = [...root.children];
  while (stack.length) {
    const n = stack.shift();
    if (regex.test(n.textContent || '')) out.push(n);
    if (n.children) for (const c of n.children) stack.push(c);
  }
  return out;
}

// ===========================================================================
// Tests
// ===========================================================================

test('settings dialog: openSettings renders 7 tab buttons + General pane', async () => {
  const sandbox = buildSandbox();
  const { errors } = loadRendererScripts(sandbox);
  if (errors.length) console.error('script load errors:', errors);
  assert.deepEqual(errors, [], 'renderer scripts must load without errors');
  assert.equal(typeof sandbox.openSettings, 'function', 'openSettings must be exported');
  // Pre-set state.config so the General pane shows the original key.
  sandbox.state.config.api_key = 'sk-test-original-key';
  sandbox.state.config.output_dir = 'C:\\original\\output';
  const modalRoot = sandbox.getOrCreate('modal-root');
  const beforeCount = modalRoot.children.length;
  sandbox.openSettings();
  const modal = modalRoot.children[modalRoot.children.length - 1];
  assert.ok(modal && modal !== modalRoot, 'showModal must have created a modal root');
  assert.ok(modalRoot.children.length > beforeCount, 'modal-root must have grown by one modal');
  // 9 tab buttons (added "Models" recently): general / image / batchgen /
  // styles / tools / popups / history / shortcuts / models.
  const tabBtns = findByClass(modal, 'settings-tab-button');
  assert.equal(tabBtns.length, 9, 'must render 9 sidebar tab buttons');
  // Save + Cancel buttons.
  const saveBtn = findByText(modal, /^Save$/).find((n) => n.tagName === 'BUTTON');
  const cancelBtn = findByText(modal, /^Cancel$/).find((n) => n.tagName === 'BUTTON');
  assert.ok(saveBtn, 'Save button must be present');
  assert.ok(cancelBtn, 'Cancel button must be present');
  // General pane must be active by default.
  const activePane = findByClass(modal, 'active').find((n) => n.tagName === 'DIV' && n.attributes['data-tab-pane'] === 'general');
  assert.ok(activePane, 'General pane must be the active tab');
  // General pane must contain an "API key" label and an output-dir input.
  const apiKeyLabels = findByText(modal, /API key/);
  assert.ok(apiKeyLabels.length > 0, 'General pane must contain an API key label');
  const dirInputs = findByText(modal, /Output directory/);
  assert.ok(dirInputs.length > 0, 'General pane must contain an Output directory row');
});

test('settings dialog: clicking Save sends a complete setConfig payload', async () => {
  const sandbox = buildSandbox();
  loadRendererScripts(sandbox);
  const modal = openSettingsInSandbox(sandbox);
  // Find input fields by walking the General pane for text inputs.
  const allInputs = findByTag(modal, 'INPUT');
  const textInputs = allInputs.filter((i) => i.attributes.type === 'text');
  assert.ok(textInputs.length >= 2, 'General pane must have at least 2 text inputs (API key + output dir)');
  // Find the input that sits next to (sibling of) a label containing
  // "API key" by walking up to the row, then looking at the row's
  // children. showRevealableKey puts the input inside a .combo div,
  // which is a SIBLING of the label (both children of the .row).
  let apiKeyInput = null;
  for (const input of textInputs) {
    let row = input;
    while (row && row.tagName !== 'BODY' && !((row.classList && row.classList._set || []).has('row'))) row = row.parentNode;
    if (!row || !row.children) continue;
    let hasApiLabel = false;
    for (const child of row.children) {
      if (child.tagName === 'LABEL' && /API key/i.test(child.textContent)) hasApiLabel = true;
    }
    if (hasApiLabel) { apiKeyInput = input; break; }
  }
  assert.ok(apiKeyInput, 'must find an input next to an API key label');
  apiKeyInput._value = 'sk-test-new-key';
  // showRevealableKey stores the typed value in a closure variable
  // (curValue) that gets updated only by the 'input' event. Dispatch
  // input so collect() returns the typed value, not the original.
  apiKeyInput.dispatchEvent({ type: 'input' });
  // Find the output dir input (sits next to the Browse… button) by
  // walking up to the row, then checking siblings for the label.
  let outInput = null;
  for (const input of textInputs) {
    let row = input;
    while (row && row.tagName !== 'BODY' && !((row.classList && row.classList._set || []).has('row'))) row = row.parentNode;
    if (!row || !row.children) continue;
    let hasOutLabel = false;
    for (const child of row.children) {
      if (child.tagName === 'LABEL' && /Output directory/i.test(child.textContent)) hasOutLabel = true;
    }
    if (hasOutLabel) { outInput = input; break; }
  }
  assert.ok(outInput, 'must find an input next to an Output directory label');
  outInput._value = 'C:\\user\\output';
  outInput.dispatchEvent({ type: 'input' });
  // Click Save.
  const saveBtn = findByText(modal, /^Save$/).find((n) => n.tagName === 'BUTTON');
  for (const fn of (saveBtn._listeners.click || [])) fn({ type: 'click', target: saveBtn });
  await flush();
  // setConfig must have been called exactly once.
  assert.equal(sandbox._setConfigCalls.length, 1, 'setConfig must fire exactly once');
  const sent = sandbox._setConfigCalls[0].payload;
  // R2.3.1: the IPC payload is wrapped — the cfg lives under .cfg,
  // and the privacy-switch signal is a top-level field. Bare-cfg is
  // also accepted by the main handler for backward compat, but the
  // renderer now uses the wrapped form.
  assert.ok(sent && typeof sent === 'object', 'payload must be an object');
  // B-007: the API key never travels inside cfg — it goes through the
  // typed apiKeyAction/apiKeyValue channel. A non-empty entered key
  // becomes an explicit 'replace' command.
  assert.ok(sent.cfg && !('api_key' in sent.cfg), 'cfg.api_key must NOT be in the payload (typed channel only)');
  assert.equal(sent.apiKeyAction, 'replace', 'a newly entered key must send apiKeyAction:replace');
  assert.equal(sent.apiKeyValue, 'sk-test-new-key', 'apiKeyValue must carry the new key');
  assert.equal(sent.cfg && sent.cfg.output_dir, 'C:\\user\\output', 'cfg.output_dir must be the new value');
  // Theme + styles MUST be preserved (the legacy bug was dropping them).
  assert.equal(sent.cfg && sent.cfg.theme, 'dark', 'cfg.theme must survive the save (M2 regression guard)');
  assert.ok(Array.isArray(sent.cfg && sent.cfg.styles), 'cfg.styles must survive the save');
  // Region must be in the payload (it's part of the general pane).
  assert.equal(sent.cfg && sent.cfg.region, 'global', 'cfg.region must be present');
  // Privacy switch signal (top-level, NOT inside cfg). Today the
  // checkbox is OFF, so the flag is false (or absent).
  assert.equal(sent.apiKeyNoSave, false, 'apiKeyNoSave must be false (checkbox off)');
  // Transient keys must NOT leak into the cfg object.
  assert.ok(sent.cfg && !('_apiKeyNoSave' in sent.cfg), '_apiKeyNoSave must be stripped from cfg');
  assert.ok(sent.cfg && !('_apiKeyValue' in sent.cfg), '_apiKeyValue must be stripped from cfg');
  assert.ok(sent.cfg && !('_apiKeyAction' in sent.cfg), '_apiKeyAction must be stripped from cfg');
  assert.ok(sent.cfg && !('_apiKeyNewValue' in sent.cfg), '_apiKeyNewValue must be stripped from cfg');
  // state.config must reflect the new values after the save resolves.
  // B-007/SEC-001: the raw api_key never round-trips through the DTO.
  assert.ok(!sandbox.state.config.api_key, 'the raw api_key must not come back in the public DTO');
  assert.equal(sandbox.state.config.output_dir, 'C:\\user\\output');
  // A "Saved." toast must have fired. The live toast() helper
  // (section20) appends to #toast-root — read from there.
  process.stderr.write('DEBUG toastRoot children=' + sandbox.getOrCreate('toast-root').children.length + '\n');
  for (const t of sandbox.getOrCreate('toast-root').children) console.log('  toast=' + JSON.stringify(t.textContent));
  const savedToasts = findByClass(sandbox.getOrCreate('toast-root'), 'toast')
    .map((n) => n.textContent)
    .filter((m) => /Saved/.test(m));
  assert.ok(savedToasts.length >= 1, 'a Saved. toast must appear');
});

test('settings dialog: "Don\'t save" checkbox strips api_key from the IPC payload but keeps it in memory', async () => {
  const sandbox = buildSandbox();
  loadRendererScripts(sandbox);
  const modal = openSettingsInSandbox(sandbox);
  // Find the "Don't save" checkbox by its id.
  const cb = modal.querySelector('#api-key-no-save');
  assert.ok(cb, 'the "Don\'t save" checkbox must be present');
  cb.checked = true;
  cb.dispatchEvent({ type: 'change' });
  // Enter a new key.
  const allInputs = findByTag(modal, 'INPUT');
  const textInputs = allInputs.filter((i) => i.attributes.type === 'text');
  let apiKeyInput = null;
  for (const input of textInputs) {
    let row = input;
    while (row && row.tagName !== 'BODY' && !((row.classList && row.classList._set || []).has('row'))) row = row.parentNode;
    if (!row || !row.children) continue;
    let hasApiLabel = false;
    for (const child of row.children) {
      if (child.tagName === 'LABEL' && /API key/i.test(child.textContent)) hasApiLabel = true;
    }
    if (hasApiLabel) { apiKeyInput = input; break; }
  }
  assert.ok(apiKeyInput, 'must find an input next to an API key label');
  apiKeyInput._value = 'sk-test-temporary-key';
  apiKeyInput.dispatchEvent({ type: 'input' });
  // Click Save.
  const saveBtn = findByText(modal, /^Save$/).find((n) => n.tagName === 'BUTTON');
  for (const fn of (saveBtn._listeners.click || [])) fn({ type: 'click', target: saveBtn });
  await flush();
  assert.equal(sandbox._setConfigCalls.length, 1);
  const sent = sandbox._setConfigCalls[0].payload;
  // R2.3.1: payload is wrapped. The privacy switch signal is the
  // top-level apiKeyNoSave; the cfg itself has the empty api_key.
  assert.equal(sent.apiKeyNoSave, true,
    'apiKeyNoSave must be true at the top level (the privacy switch signal)');
  // B-007: cfg carries no api_key field at all; in no-save mode the
  // typed channel is forced to keep/'' (Main handles the privacy clear).
  assert.ok(sent.cfg && !('api_key' in sent.cfg),
    'cfg.api_key must NOT be in the payload when "Don\'t save" is on');
  assert.equal(sent.apiKeyAction, 'keep', 'no-save mode must not send replace/clear');
  assert.equal(sent.apiKeyValue, '', 'no-save mode must not carry a persisted key value');
  // SEC-001: the raw API key no longer lives in state.config (public DTO).
  // The session key is routed to the main process via the sessionApiKey field.
  assert.equal(sent.sessionApiKey, 'sk-test-temporary-key', 'sessionApiKey must be sent to main for in-memory storage');
  // state.apiKeyNoSave must reflect the checkbox.
  assert.equal(sandbox.state.apiKeyNoSave, true, 'state.apiKeyNoSave must mirror the checkbox');
});

test('settings dialog: setConfig envelope error surfaces a toast and keeps the modal open', async () => {
  const sandbox = buildSandbox();
  loadRendererScripts(sandbox);
  // Replace setConfig with a failing envelope.
  sandbox.api.setConfig = (cfg) => Promise.resolve({ ok: false, error: 'disk full' });
// Capture unhandled rejections from the click handler.
  let unhandled = null;
  const urh = (r) => { unhandled = r; };
  process.on('unhandledRejection', urh);
  const modal = openSettingsInSandbox(sandbox);
  const modalRoot = sandbox.getOrCreate('modal-root');
  const saveBtn = findByText(modal, /^Save$/).find((n) => n.tagName === 'BUTTON');
  for (const fn of (saveBtn._listeners.click || [])) {
    try {
      const r = fn({ type: 'click', target: saveBtn });
      if (r && typeof r.catch === 'function') await r.catch((_) => {});
    } catch (_) { /* swallow */ }
  }
  await flush();
  process.off('unhandledRejection', urh);
  // section20_Structured_event_log.js declares `function toast`
  // at top level of its script, which becomes a property of the vm global and
  // shadows the test's `sandbox.toast` setter. The live toast
  // appends a div to #toast-root. Inspect that DOM instead.
  const toastRoot = sandbox.getOrCreate('toast-root');
  const liveToasts = findByClass(toastRoot, 'toast').map((n) => n.textContent);
  // A toast must mention the failure.
  const failToasts = liveToasts.filter((m) => /Save failed|disk full/i.test(m));
  assert.ok(failToasts.length >= 1, 'a "Save failed: …" toast must appear');
  // The modal must still be attached to modal-root.
  assert.ok(modal.parentNode === modalRoot, 'modal must stay attached to modal-root on setConfig failure');
  // state.config must still hold the ORIGINAL key — the failed save
  // must NOT have stomped it.
  assert.equal(sandbox.state.config.api_key, 'sk-test-original-key');
});

test('settings dialog: clicking Cancel does NOT call setConfig', async () => {
  const sandbox = buildSandbox();
  loadRendererScripts(sandbox);
  const modal = openSettingsInSandbox(sandbox);
  const modalRoot = sandbox.getOrCreate('modal-root');
  const cancelBtn = findByText(modal, /^Cancel$/).find((n) => n.tagName === 'BUTTON');
  assert.ok(cancelBtn, 'Cancel button must be present');
  for (const fn of (cancelBtn._listeners.click || [])) fn({ type: 'click', target: cancelBtn });
  await flush();
  assert.equal(sandbox._setConfigCalls.length, 0, 'Cancel must NOT call setConfig');
  // The real showModal's close() removes the modal div from
  // modal-root. The original modal object still exists in memory
  // but its parentNode is null.
  assert.equal(modal.parentNode, null, 'Cancel must detach the modal from modal-root');
  // state.config must still be the original.
  assert.equal(sandbox.state.config.api_key, 'sk-test-original-key');
});