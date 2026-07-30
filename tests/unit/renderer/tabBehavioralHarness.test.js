// tests/unit/renderer/tabBehavioralHarness.test.js
// ============================================================================
// Comprehensive behavioral harness for every tab. Uses a SHARED VM
// context so function declarations from each script are visible to
// the next (mirroring how browser <script> tags share global scope).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// Add `append` to the makeEl element (HTMLElement.append is standard DOM).
function _appendToEl(self, ...children) {
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') {
      const t = makeEl('span');
      t._text = String(c);
      self.children.push(t);
      t.parentNode = self;
    } else if (typeof c === 'object' && c.tagName) {
      self.children.push(c);
      c.parentNode = self;
    }
  }
  return self;
}

function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    classList: {
      _set: new Set(),
      add(c) {
        if (c == null) return;
        for (const cls of String(c).split(/\s+/).filter(Boolean)) this._set.add(cls);
      },
      remove(c) {
        if (c == null) return;
        for (const cls of String(c).split(/\s+/).filter(Boolean)) this._set.delete(cls);
      },
      contains(c) { return this._set.has(c); },
      toggle(c, force) {
        if (force === true) this.add(c);
        else if (force === false) this.remove(c);
        else if (this._set.has(c)) this.remove(c);
        else this.add(c);
        return this._set.has(c);
      },
    },
    parentNode: null,
    dataset: {},
    _listeners: {},
    _value: '',
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) {
      if (!this._listeners[ev]) return;
      this._listeners[ev] = this._listeners[ev].filter((f) => f !== fn);
    },
    dispatchEvent(event) {
      for (const fn of (this._listeners[event.type] || [])) {
        try { fn(event); } catch (e) { console.error('handler threw:', e.message); }
      }
      return true;
    },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    append(...children) { return _appendToEl(this, ...children); },
    prepend() {}, // noop for tests
    before() {}, // noop for tests
    after() {}, // noop for tests
    replaceWith() {}, // noop for tests
    remove() {}, // noop for tests
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(k, v) {
      this.attributes[k] = v;
      if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    },
    getAttribute(k) { return this.attributes[k] == null ? null : String(this.attributes[k]); },
    // Mirror real DOM: `el.id` is a reflected attribute.
    get id() { return this.attributes.id; },
    set id(v) { this.attributes.id = v; },
    // Mirror real DOM: `el.className` is a reflected setter that updates
    // classList. DomHelpers.js (loaded before ParamRow.js) uses
    // `el.className = v` directly, so without this setter the .row
    // rows created by buildParamRow never end up in classList._set and
    // the appendFlag _flagForParam helper can't find them.
    get className() {
      return Array.from(this.classList._set || []).join(' ');
    },
    set className(v) {
      this.classList._set.clear();
      for (const cls of String(v || '').split(/\s+/).filter(Boolean)) this.classList._set.add(cls);
    },
    querySelector(sel) {
      // Limited CSS selector support: `#id`, `.className`, and bare
      // `tagName`. The renderer calls querySelector('label') inside
      // appendFlag's _flagForParam helper to read the row's label text
      // (which contains the flag name like "--n").
      const stack = [...this.children];
      const want = (s) => {
        if (s.startsWith('#')) return (n) => n.id === s.slice(1);
        if (s.startsWith('.')) {
          const cls = s.slice(1);
          return (n) => n.classList && n.classList._set && n.classList._set.has(cls);
        }
        return (n) => n.tagName === s.toUpperCase();
      };
      const matcher = want(sel);
      while (stack.length) {
        const n = stack.shift();
        if (n && matcher(n)) return n;
        if (n && n.children && n.children.length) stack.push(...n.children);
      }
      return null;
    },
    querySelectorAll() { return []; },
    focus() {},
    blur() {},
    click() { this.dispatchEvent({ type: 'click', target: this }); },
    contains() { return false; },
    closest(sel) {
      // Limited selector support: only `.className` and `#id`.
      // Walk parents via parentNode until we find a match.
      if (typeof sel !== 'string') return null;
      const match = (n) => {
        if (sel.startsWith('.')) {
          const cls = sel.slice(1);
          return n.classList && n.classList._set && n.classList._set.has(cls);
        }
        if (sel.startsWith('#')) {
          return n.id === sel.slice(1);
        }
        return false;
      };
      let cur = this;
      while (cur) {
        if (match(cur)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
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
    // Mirror real DOM: inp.type = 'text' reflects in attributes.type.
    get type() { return this.attributes.type; },
    set type(v) { this.attributes.type = v; },
  };
  return el;
}

// ============================================================================
// Create a single VM sandbox that mirrors the live renderer globals.
// All scripts run in this context, so `function buildParamRow(...) { ... }`
// declared in ParamRow.js is visible as `buildParamRow` to imageTab.js.
// ============================================================================
function buildSandbox() {
  const ipcCalls = [];
  const elements = {};
  const getOrCreate = (id) => {
    if (!elements[id]) {
      elements[id] = makeEl('div');
      elements[id].id = id;
    }
    return elements[id];
  };
  const api = {
    mmxRunJob: (payload) => { ipcCalls.push({ method: 'mmxRunJob', payload }); return Promise.resolve({ ok: true, code: 0, stdout: '{}', stderr: '' }); },
    mmxRun: (args) => { ipcCalls.push({ method: 'mmxRun', args }); return Promise.resolve({ ok: true, code: 0 }); },
    mmxProfile: () => Promise.resolve({ region: 'global', hasKey: true }),
    mmxVoices: () => Promise.resolve({ voices: ['English_default', 'English_narrator'] }),
    voices: () => Promise.resolve(['English_default', 'English_narrator']),
    quota: () => Promise.resolve({ ok: true, remaining: 100, dailyLimit: 1000 }),
    authStatus: () => Promise.resolve({ ok: true }),
    mmxCancel: () => Promise.resolve({ ok: true }),
    fbList: (p) => Promise.resolve({ ok: true, dir: p || '', parent: null, items: [] }),
    fbMkdir: () => Promise.resolve({ ok: true }),
    fbEnsureDir: () => Promise.resolve({ ok: true }),
    fbListDrives: () => Promise.resolve({ ok: true, drives: [{ name: 'C:\\', label: 'C:\\' }] }),
    fbRename: () => Promise.resolve({ ok: true }),
    fbDelete: () => Promise.resolve({ ok: true }),
    fbMove: () => Promise.resolve({ ok: true }),
    fbCopy: () => Promise.resolve({ ok: true }),
    fbReveal: () => Promise.resolve({ ok: true }),
    fbOpenInExplorer: () => Promise.resolve({ ok: true }),
    fbRead: () => Promise.resolve({ ok: true, base64: '' }),
    fbExists: () => Promise.resolve({ ok: true, exists: true }),
    fbWrite: () => Promise.resolve({ ok: true }),
    fbOpenDialog: () => Promise.resolve(null),
    setConfig: () => Promise.resolve({ ok: true, config: {} }),
    getConfig: () => Promise.resolve({ api_key: 'sk-test', output_dir: 'C:\\temp\\pipeline-test', region: 'global', theme: 'dark', styles: [] }),
    configPath: () => Promise.resolve('C:\\Users\\me\\AppData\\Roaming\\MiniMaxAssetTool\\config.txt'),
    defaultOutputDir: () => Promise.resolve('C:\\Users\\me\\AppData\\Roaming\\MiniMaxAssetTool\\generated'),
    pickFolder: () => Promise.resolve(null),
    pickFile: () => Promise.resolve(null),
    batchesGet: () => Promise.resolve({ image: [], speech: [], music: [], video: [] }),
    batchesSet: () => Promise.resolve({ ok: true }),
    batchesGenerateExamples: () => Promise.resolve({ ok: true }),
    stateGet: () => Promise.resolve({}),
    stateSet: () => Promise.resolve({ ok: true }),
    refImageExists: () => Promise.resolve({ ok: true, exists: true }),
    fixImageExtension: () => Promise.resolve({ ok: true, path: 'fixed.jpg' }),
    realesrganAvailable: () => Promise.resolve({ available: false, modelPresent: false }),
    isnetbgAvailable: () => Promise.resolve({ available: false, modelPresent: false }),
    realesrganDownload: () => Promise.resolve({ ok: true }),
    realesrganRun: () => Promise.resolve({ ok: true }),
    isnetbgRun: () => Promise.resolve({ ok: true }),
    optimizeImage: () => Promise.resolve({ ok: true }),
    audioProbe: () => Promise.resolve({ ok: true, duration: 1 }),
    audioTrimSilence: () => Promise.resolve({ ok: true, outputPath: 'trimmed.mp3' }),
    audioCut: () => Promise.resolve({ ok: true, outputPath: 'cut.mp3' }),
    audioDecodePeaks: () => Promise.resolve({ ok: true, peaks: [] }),
    logToFile: () => Promise.resolve({ ok: true }),
    onLog: () => () => {},
    onLogRich: () => () => {},
    onRealesrganDownloadProgress: () => () => {},
    onBeforeQuit: () => () => {},
    stateArchiveRead: () => Promise.resolve(null),
    stateArchiveClear: () => Promise.resolve({ ok: true }),
    stateArchiveSize: () => Promise.resolve({ bytes: 0 }),
    stateArchiveDelete: () => Promise.resolve({ ok: true }),
    getAppVersion: () => Promise.resolve({ version: '1.1.18' }),
    installOpenUrl: () => Promise.resolve({ ok: true }),
    installPickAndCopy: () => Promise.resolve({ ok: true }),
  };
  // The shared global `state` object — many renderer files read
  // `var state = window.state;` at module top-level so this needs
  // to exist before any tab loads.
  const state = {
    config: { api_key: 'sk-test-1234567890', output_dir: 'C:\\temp\\pipeline-test', region: 'global', theme: 'dark', styles: [] },
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
    api_key: 'sk-test-1234567890',
    output_dir: 'C:\\temp\\pipeline-test',
  };
  const $ = (sel) => {
    if (typeof sel !== 'string') return null;
    if (sel.startsWith('#')) return getOrCreate(sel.slice(1));
    return null;
  };
  const sandbox = {
    window: undefined, // populated below (cycle)
    document: {
      activeElement: getOrCreate('body'),
      body: getOrCreate('body'),
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: (tag, attrs, ...children) => {
      const n = makeEl(tag);
      if (attrs && typeof attrs === 'object') {
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'class') n.classList.add(v);
          else if (k === 'style' && typeof v === 'string') n.attributes.style = v;
          else if (k.startsWith('data-')) {
            n.attributes[k] = v;
            n.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
          }
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
      getElementById: (id) => getOrCreate(id),
      querySelector: (sel) => (typeof sel === 'string' && sel.startsWith('#') ? getOrCreate(sel.slice(1)) : null),
      querySelectorAll: () => [],
    },
    location: { href: 'app://ceegor/', protocol: 'app:', host: 'ceegor' },
    // ParamRow.js does `window.el = window.createElement || ...`. We
    // provide window.createElement below (after `document` exists) so the
    // helper captures the rich mock (preserves attrs/children) rather
    // than the bare `(tag) => document.createElement('div')` fallback
    // that drops every attribute and child text.
    navigator: { userAgent: 'node-test', language: 'en', platform: 'test' },
    FileUrl: { makeFileUrl: () => 'file:///fake' },
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: () => true,
    asyncConfirm: async () => true,
    alert: () => {},
    prompt: () => null,
    // debugLog.js sets setInterval(... 50ms ...) to poll for window.api.
    // That keeps the event loop alive forever. In tests, we want
    // setInterval to run ONCE (like setTimeout).
    setInterval: (fn, _ms) => { try { fn(); } catch (_) {} return 0; },
    setTimeout: (fn, _ms) => { try { fn(); } catch (_) {} return 0; },
    clearInterval: () => {},
    clearTimeout: () => {},
    process,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Promise, Array, Object, String, Number, Boolean, Date, Math, JSON, Map, Set, WeakMap, WeakSet, Symbol,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    URL, Blob, File, FormData, fetch,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    api,
    state,
    $,
    toast: () => {},
    showModal: () => {},
    showTab: () => {},
    refreshBrowser: () => {},
    refreshQuota: () => {},
    buildParamRow: (label, def, id) => ({
      row: makeEl('div'),
      input: {
        ...makeEl('input'),
        getValue: () => def && def.default != null ? String(def.default) : '',
        el: makeEl('select'),
      },
      sel: makeEl('select'),
      getValue: () => def && def.default != null ? String(def.default) : '',
    }),
    openSettings: () => {},
    openStyleSettings: () => {},
    showHelp: () => {},
    showAudioCutter: () => {},
    showUpscaleSettings: () => {},
    showImagePreview: () => {},
    openOptionalAddons: () => {},
    openFirstTimeSetup: () => {},
    openAllBatchDashboard: () => {},
    openBatchManager: () => {},
    openFolderOptions: () => {},
    appendFlag: () => {},
    appendBoolFlag: () => {},
    buildFinalPrompt: () => 'a happy cyberpunk cat in Tokyo at night',
    uniquePath: () => 'out/file.png',
    timestamp: () => '20260624_120000',
    slugify: () => 'test',
    ensureSubDir: async () => 'C:\\temp\\pipeline-test',
    armGenBtnWithCancel: (btn, label, jobId) => {
      // The live function returns a `cancel` object with .cancel(),
      // .wasCancelled(), etc. We return a no-op so the renderer
      // doesn't trip on undefined methods.
      const cancel = { cancelled: false, cancel() { this.cancelled = true; }, wasCancelled() { return this.cancelled; }, cleanup() {}, jobId };
      // Pretend the button was swapped so subsequent re-entrancy
      // checks pass.
      return cancel;
    },
    addLogEvent: () => 1,
    notifyImageGenerated: () => {},
    applyFileSearch: () => {},
    bumpGenerationCounter: () => {},
    bumpGenerationCounter: () => {},
    validateTabAgainstSpec: () => [],
    buildStyleRow: () => ({ row: makeEl('div'), sel: makeEl('select') }),
    buildFilePrefixRow: () => makeEl('div'),
    buildAddToBatchBtn: () => makeEl('button'),
    getStyleText: () => '',
    attachImageDimGuards: () => makeEl('div'),
    attachSubjectRefGuard: () => makeEl('div'),
    showUpscaleSettings: () => {},
    JobRunner: {
      run: ({ runFn }) => {
        const ctx = { signal: { addEventListener: () => {} } };
        const ctrl = { jobId: 'test-job-' + Math.random().toString(36).slice(2, 8) };
        sandbox._runFnLog = [];
        const tracedRun = async () => {
          try {
            await runFn(ctx);
            sandbox._runFnLog.push('runFn completed');
          } catch (e) {
            sandbox._runFnLog.push('runFn error: ' + (e && e.message || e));
            sandbox._runFnError = e;
          }
        };
        Promise.resolve().then(tracedRun);
        return Object.assign(ctrl, { done: Promise.resolve(), catch: () => ctrl });
      },
      isTabRunning: () => false,
      cancel: () => {},
    },
    notifyImageGenerated: () => {},
    // P4.2 mock: the image tab's --n>1 path mints a private run subdir.
    BatchDirectRunner: {
      mintRunSubdir: (base) => ({ ok: true, runSubdir: base + '\\run_test123' }),
      ensureRunSubdir: (dir) => Promise.resolve({ ok: true, path: dir }),
    },
    applyFileSearch: () => {},
    formatMmxError: () => '',
    classifyMmxError: () => 'unknown',
    escapeHtml: (s) => String(s || ''),
    TABS: {},
    elements,
    getOrCreate,
    ipcCalls,
  };
  sandbox.window = sandbox; // self-reference so `window.X = ...` writes into the sandbox
  // Mirror createElement onto the global too, so ParamRow.js's
  // `window.el = window.createElement || …` picks up the rich mock.
  sandbox.createElement = sandbox.document.createElement;
  // `globalThis` / `global` need to expose the sandbox properties so
  // scripts that do `var el = window.el;` work.
  // `globalThis` / `global` need to expose the sandbox properties so
  // scripts that do `var el = window.el;` work.
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  return sandbox;
}

// ============================================================================
// Load a tab in a fresh VM context.
// ============================================================================
function loadTabInSandbox(tabKey) {
  const sandbox = buildSandbox();
  const context = vm.createContext(sandbox);
  sandbox.setInterval = () => 0;
  sandbox.setTimeout = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.clearTimeout = () => {};
  sandbox.queueMicrotask = (fn) => { try { fn(); } catch (_) {} };
  const indexHtml = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  const scriptOrder = [];
  const re = /<script\s+src="([^"]+)"/g;
  let mm;
  while ((mm = re.exec(indexHtml)) !== null) {
    let rel = mm[1];
    if (rel.startsWith('tabs/')) {
      const isSpeechVoices = rel.endsWith('speechTabVoices.js');
      const isOurTab = rel.endsWith(`${tabKey}Tab.js`);
      const isSharedHelper = rel.endsWith('styleHelpers.js');
      const isOtherTab = rel.endsWith('Tab.js') && !isOurTab && !isSpeechVoices;
      if (isOtherTab) continue;
      if (!isOurTab && !isSpeechVoices && !isSharedHelper) continue;
    }
    scriptOrder.push(rel);
  }
  const errors = [];
  for (const rel of scriptOrder) {
    const full = path.join(ROOT, 'renderer', rel);
    let src;
    try {
      src = fs.readFileSync(full, 'utf8');
    } catch (e) {
      errors.push(`READ FAIL ${rel}: ${e.message}`);
      continue;
    }
    src = '// ' + full + '\n' + src;
    try {
      vm.runInContext(src, context, { filename: full, timeout: 3000 });
    } catch (e) {
      errors.push(`EVAL FAIL ${rel}: ${e.message}`);
    }
  }
  // v1.1.18: section24_State.js sets window.state = {config: {api_key:'', ...}}
  // (the defaults). The live renderer then runs `init()` which loads
  // the real state from disk via the state:get IPC. We don't run init
  // here, so the test must set the config explicitly AFTER section24
  // has registered the state object.
  sandbox.state.config.api_key = 'sk-test-1234567890';
  sandbox.state.config.output_dir = 'C:\\temp\\pipeline-test';
  // Pre-register the <section id="tab-XXX"> elements so the tab's
  // `const root = $('#tab-image');` returns the SAME element we'll
  // pass to build(). The tab does NOT take a root argument —
  // it looks up the section by id and populates IT in place.
  sandbox.elements[`tab-${tabKey}`] = makeEl('section');
  sandbox.elements[`tab-${tabKey}`].id = `tab-${tabKey}`;
  return { sandbox, context, errors };
}

// ============================================================================
// Find a button by visible text content (DFS).
// ============================================================================
function findButtonByText(root, text) {
  function walk(node) {
    if (!node) return null;
    if (node.tagName === 'BUTTON' && node.textContent === text) return node;
    if (node.children) {
      for (const c of node.children) {
        const r = walk(c);
        if (r) return r;
      }
    }
    return null;
  }
  return walk(root);
}

// Build the instrumented JobRunner mock that we install AFTER the real
// JobRunner.js has loaded (which overwrites window.JobRunner with its
// IPC-bound implementation). The mock schedules runFn via
// Promise.resolve().then — NOT sandbox.queueMicrotask — so runFn reads
// `ctrl.jobId` AFTER the click handler's `ctrl = window.JobRunner.run(...)`
// assignment has completed (otherwise the runFn throws "Cannot read
// properties of undefined").
function makeMockJobRunner(sandbox) {
  return {
    run: ({ runFn }) => {
      const ctx = { signal: { addEventListener: () => {} } };
      const ctrl = { jobId: 'test-job-' + Math.random().toString(36).slice(2, 8) };
      sandbox._runFnLog = [];
      const tracedRun = async () => {
        try {
          await runFn(ctx);
          sandbox._runFnLog.push('runFn completed');
        } catch (e) {
          sandbox._runFnLog.push('runFn error: ' + (e && e.message || e));
          sandbox._runFnError = e;
        }
      };
      Promise.resolve().then(tracedRun);
      return Object.assign(ctrl, { done: Promise.resolve(), catch: () => ctrl });
    },
    isTabRunning: () => false,
    cancel: () => {},
    cancelAll: () => {},
    jobsForTab: () => [],
    activeJobs: () => [],
    attachSecondaryToJob: () => {},
    flushBatchSummaries: () => {},
    on: () => () => {},
    off: () => {},
    HARD_CAP: 12,
  };
}

// ============================================================================
// Tests
// ============================================================================

for (const tab of ['image', 'speech', 'music', 'video']) {
  test(`TAB ${tab}: build() runs without throwing`, () => {
    const { sandbox, context, errors } = loadTabInSandbox(tab);
    if (errors.length) {
      console.error(`${tab} errors:`, errors);
    }
    assert.deepEqual(errors, [], `${tab}: scripts must load without errors`);
    const tabs = sandbox.TABS;
    assert.ok(tabs, `${tab}: window.TABS must be defined`);
    assert.ok(tabs[tab], `${tab}: window.TABS.${tab} must be registered`);
    assert.equal(typeof tabs[tab].build, 'function', `${tab}.build must be a function`);
    const root = sandbox.elements[`tab-${tab}`];
    try {
      tabs[tab].build(root);
    } catch (e) {
      assert.fail(`${tab}.build() threw: ${e.message}\n${e.stack}`);
    }
    assert.ok(root.children.length > 0, `${tab}.build(root) must produce children (got 0)`);
  });
}

async function buildAndClickGenerate(tabKey) {
  const { sandbox, context, errors } = loadTabInSandbox(tabKey);
  const root = sandbox.elements[`tab-${tabKey}`];
  // Wrap api so we can inspect mmxRunJob calls. The basic api's
  // mmxRunJob also pushes to sandbox.ipcCalls, but the Proxy is
  // what the click handler actually reads (after we re-install it
  // post-build).
  const apiCalls = [];
  const wrappedApi = new Proxy(sandbox.api, {
    get(target, prop) {
      const orig = target[prop];
      if (typeof orig === 'function') {
        return (...args) => {
          apiCalls.push({ method: prop, args });
          return orig(...args);
        };
      }
      return orig;
    },
  });
  sandbox.api = wrappedApi;
  sandbox.window.api = wrappedApi;
  // Re-install the instrumented JobRunner mock — the real JobRunner.js
  // loaded during buildSandbox overwrites window.JobRunner with its
  // IPC-bound implementation; we want the test mock so we can observe
  // the runFn without touching the filesystem.
  sandbox.JobRunner = makeMockJobRunner(sandbox);
  const tab = sandbox.TABS[tabKey];
  tab.build(root);
  // Pre-set the prompt (textarea) and api_key + output_dir so the
  // generic per-tab guards (api_key check, prompt-non-empty check)
  // pass without each test having to wire them up individually.
  sandbox.state.config.api_key = sandbox.state.config.api_key || 'sk-test-1234567890';
  sandbox.state.config.output_dir = sandbox.state.config.output_dir || 'C:\\temp\\pipeline-test';
  sandbox.api.fbEnsureDir = () => Promise.resolve({ ok: true, path: sandbox.state.config.output_dir });
  sandbox.api.fbMkdir = () => Promise.resolve({ ok: true });
  // Fill any textarea with a non-empty prompt.
  let ta = null;
  (function walk(n) {
    if (!n) return;
    if (n.tagName === 'TEXTAREA') ta = n;
    if (n.children) n.children.forEach(walk);
  })(root);
  if (ta) {
    ta._value = 'a happy cyberpunk cat in Tokyo at night';
    ta.dispatchEvent({ type: 'input' });
  }
  const genBtn = findButtonByText(root, 'Generate');
  if (!genBtn) return { sandbox, root, errors, genBtn: null, apiCalls, missing: true };
  try {
    // Manually iterate click listeners so async throws are observable.
    const listeners = (genBtn._listeners && genBtn._listeners.click) || [];
    for (const fn of listeners) {
      try {
        const result = fn({ type: 'click', target: genBtn });
        if (result && typeof result.catch === 'function') {
          result.catch((e) => console.error('ASYNC HANDLER REJECTED:', e && e.message || e));
        }
      } catch (e) {
        console.error('HANDLER SYNC THROW:', e && e.message || e);
      }
    }
  } catch (e) {
    errors.push(`click threw: ${e.message}`);
    return { sandbox, root, errors, genBtn, apiCalls, clickThrew: e.message };
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setImmediate(r));
  }
  return { sandbox, root, errors, genBtn, apiCalls };
}

test('IMAGE: Generate click sends a valid image generate argv', async () => {
  const toasts = [];
  const apiCalls = [];
  const { sandbox, errors } = loadTabInSandbox('image');
  sandbox.toast = (msg) => toasts.push(msg);
  // Wrap every api method to log.
  const wrappedApi = new Proxy(sandbox.api, {
    get(target, prop) {
      const orig = target[prop];
      if (typeof orig === 'function') {
        return (...args) => {
          apiCalls.push({ method: prop, args });
          return orig(...args);
        };
      }
      return orig;
    },
  });
  sandbox.api = wrappedApi;
  // window.api is what the renderer reads; replace it. (Both sandbox.api
  // AND sandbox.window.api — the renderer reads `window.api.mmxRunJob`
  // but our sandbox object IS window, so they're the same reference.
  sandbox.window.api = wrappedApi;
  const tab = sandbox.TABS.image;
  const root = sandbox.elements['tab-image'];
  tab.build(root);
  sandbox.api.fbEnsureDir = () => Promise.resolve({ ok: true, path: 'C:\\temp\\pipeline-test' });
  sandbox.api.fbMkdir = () => Promise.resolve({ ok: true });
  // The real JobRunner.js (loaded by index.html) overwrites window.JobRunner
  // with a real implementation that goes through IPC. Re-install our
  // instrumented mock so the test can observe the runFn chain without
  // touching the real filesystem / IPC layer.
  sandbox.JobRunner = makeMockJobRunner(sandbox);
  // Set the prompt so the prompt guard passes. Find the textarea.
  let ta = null;
  (function walk(n) {
    if (!n) return;
    if (n.tagName === 'TEXTAREA') ta = n;
    if (n.children) n.children.forEach(walk);
  })(root);
  assert.ok(ta, 'image tab must have a prompt textarea');
  ta._value = 'a happy cyberpunk cat in Tokyo at night';
  ta.dispatchEvent({ type: 'input' });
  const genBtn = findButtonByText(root, 'Generate');
  assert.ok(genBtn, 'Generate button must exist');
  // Manually iterate click listeners so we can observe async throws.
  const listeners = (genBtn._listeners && genBtn._listeners.click) || [];
  for (const fn of listeners) {
    try {
      const result = fn({ type: 'click', target: genBtn });
      if (result && typeof result.catch === 'function') {
        result.catch((e) => console.error('ASYNC HANDLER REJECTED:', e && e.message || e));
      }
    } catch (e) {
      console.error('HANDLER SYNC THROW:', e && e.message || e);
    }
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setImmediate(r));
  }
  const calls = apiCalls.filter((c) => c.method === 'mmxRunJob');
  if (calls.length === 0) {
    assert.fail('image Generate did NOT call mmxRunJob. Toasts fired: ' + JSON.stringify(toasts) + '. API calls: ' + JSON.stringify(apiCalls.map(c => c.method)) + '. runFn log: ' + JSON.stringify(sandbox._runFnLog) + '. runFn error: ' + (sandbox._runFnError && sandbox._runFnError.message) + '. state.config: ' + JSON.stringify(sandbox.state && sandbox.state.config));
  }
  // wrappedApi records args[0] = { args, jobId }.
  const args = calls[0].args[0].args;
  assert.equal(args[0], 'image');
  assert.equal(args[1], 'generate');
  const promptIdx = args.indexOf('--prompt');
  assert.ok(promptIdx >= 0, 'image argv must include --prompt');
  assert.ok(args[promptIdx + 1] && args[promptIdx + 1].length > 0, 'image argv must include the prompt text');
});

test('IMAGE: --n 2 (Custom mode) sends --n 2 + --out-dir (NOT --out)', async () => {
  const { sandbox } = loadTabInSandbox('image');
  const root = sandbox.elements['tab-image'];
  const tab = sandbox.TABS.image;
  // Wrap api so we can inspect mmxRunJob calls.
  const apiCalls = [];
  const wrappedApi = new Proxy(sandbox.api, {
    get(target, prop) {
      const orig = target[prop];
      if (typeof orig === 'function') {
        return (...args) => {
          apiCalls.push({ method: prop, args });
          return orig(...args);
        };
      }
      return orig;
    },
  });
  sandbox.api = wrappedApi;
  sandbox.window.api = wrappedApi;
  sandbox.JobRunner = makeMockJobRunner(sandbox);
  tab.build(root);
  // Find the --n <select> by looking for the one with options 1/2/3/4 + Custom.
  let nSel = null;
  const allSelects = [];
  (function walk(n) {
    if (!n) return;
    if (n.tagName === 'SELECT') {
      allSelects.push(n);
      const opts = (n.children || []).map((c) => c._value || (c.attributes && c.attributes.value));
      if (opts.includes('1') && opts.includes('2') && opts.includes('3') && opts.includes('4') && opts.includes('__custom__')) {
        nSel = n;
      }
    }
    if (n.children) n.children.forEach(walk);
  })(root);
  assert.ok(nSel, 'image tab must have a --n <select> with options 1..4 + Custom');
  nSel._value = '__custom__';
  nSel.dispatchEvent({ type: 'change' });
  // Now find the revealed <input type="number"> inside the wrapper.
  let nInput = null;
  (function walk(n) {
    if (!n) return;
    if (n.tagName === 'INPUT' && n.attributes && n.attributes.type === 'number') nInput = n;
    if (n.children) n.children.forEach(walk);
  })(root);
  assert.ok(nInput, 'Custom mode must reveal the number input');
  // Find the n input specifically (max=4) — other inputs in the tab
  // (--width 2048, --seed INT_MAX, etc.) also use type=number, so a
  // bare type check isn't enough.
  let realNInput = null;
  (function walk(n) {
    if (!n) return;
    if (n.tagName === 'INPUT' && n.attributes && n.attributes.type === 'number' && n.attributes.max === 4) realNInput = n;
    if (n.children) n.children.forEach(walk);
  })(root);
  assert.ok(realNInput, 'must find --n input (type=number, max=4)');
  realNInput._value = '2';
  realNInput.dispatchEvent({ type: 'input' });
  // Also set the prompt so the prompt guard passes.
  let ta = null;
  (function walk2(n) {
    if (!n) return;
    if (n.tagName === 'TEXTAREA') ta = n;
    if (n.children) n.children.forEach(walk2);
  })(root);
  assert.ok(ta, 'image tab must have a prompt textarea');
  ta._value = 'a happy cyberpunk cat in Tokyo at night';
  ta.dispatchEvent({ type: 'input' });
  // Click Generate.
  const genBtn = findButtonByText(root, 'Generate');
  assert.ok(genBtn);
  genBtn.click();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const calls = apiCalls.filter((c) => c.method === 'mmxRunJob');
  assert.ok(calls.length >= 1, 'mmxRunJob must be called');
  // mmxRunJob is invoked as window.api.mmxRunJob({ args, jobId }),
  // so wrappedApi records args[0] = { args, jobId }.
  const args = calls[0].args[0].args;
  const nIdx = args.indexOf('--n');
  assert.ok(nIdx >= 0, 'argv must include --n');
  assert.equal(args[nIdx + 1], '2', 'argv must include --n 2 (verbatim from typed Custom value, NOT clamped to max)');
  assert.ok(args.includes('--out-dir'), 'argv with --n 2 must include --out-dir (mmx CLI rejects --out + --n > 1)');
  assert.ok(!args.includes('--out'), 'argv with --n 2 must NOT include --out');
});

test('SPEECH: --voice default flows through to mmx argv', async () => {
  const { apiCalls } = await buildAndClickGenerate('speech');
  const calls = apiCalls.filter((c) => c.method === 'mmxRunJob');
  assert.ok(calls.length >= 1, 'speech Generate must call mmxRunJob');
  // wrappedApi records args[0] = { args, jobId }.
  const args = calls[0].args[0].args;
  assert.equal(args[0], 'speech');
  assert.equal(args[1], 'synthesize');
  const textIdx = args.indexOf('--text');
  assert.ok(textIdx >= 0, 'speech argv must include --text');
  const voiceIdx = args.indexOf('--voice');
  assert.ok(voiceIdx >= 0, 'speech argv must include --voice');
  // v1.1.17 bug: --voice was being sent as the empty string because
  // populateVoices had nuked the wrapper's innerHTML.
  // v1.1.17 fix: pass voice.input.el so the inner <select> gets populated.
  assert.notEqual(args[voiceIdx + 1], '', 'speech argv --voice must NOT be empty (v1.1.17 bug)');
  assert.equal(args[voiceIdx + 1], 'English_expressive_narrator',
    'speech argv --voice must be the default English_expressive_narrator (verified end-to-end)');
});

test('MUSIC: Generate click sends a valid music generate argv', async () => {
  const { apiCalls } = await buildAndClickGenerate('music');
  const calls = apiCalls.filter((c) => c.method === 'mmxRunJob');
  assert.ok(calls.length >= 1, 'music Generate must call mmxRunJob');
  const args = calls[0].args[0].args;
  assert.equal(args[0], 'music');
  assert.equal(args[1], 'generate');
  const promptIdx = args.indexOf('--prompt');
  assert.ok(promptIdx >= 0, 'music argv must include --prompt');
});

test('VIDEO: Generate click sends a valid video generate argv', async () => {
  const { apiCalls } = await buildAndClickGenerate('video');
  const calls = apiCalls.filter((c) => c.method === 'mmxRunJob');
  assert.ok(calls.length >= 1, 'video Generate must call mmxRunJob');
  const args = calls[0].args[0].args;
  assert.equal(args[0], 'video');
  assert.equal(args[1], 'generate');
  const promptIdx = args.indexOf('--prompt');
  assert.ok(promptIdx >= 0, 'video argv must include --prompt');
});

// Behavioral: every tab's argv must not have undefined / empty / NaN values.
test('Every tab argv has no undefined / empty / NaN values', async () => {
  for (const tab of ['image', 'speech', 'music', 'video']) {
    const { apiCalls } = await buildAndClickGenerate(tab);
    const calls = apiCalls.filter((c) => c.method === 'mmxRunJob');
    if (!calls.length) continue;
    const args = calls[0].args[0].args;
    for (let i = 2; i < args.length; i++) {
      if (typeof args[i] !== 'string') continue;
      if (args[i].startsWith('--')) {
        const val = args[i + 1];
        assert.ok(
          typeof val === 'string' && val.length > 0 && val !== 'undefined' && val !== 'NaN',
          `${tab}: argv has invalid value for ${args[i]}: ${JSON.stringify(val)}`
        );
      }
    }
  }
});