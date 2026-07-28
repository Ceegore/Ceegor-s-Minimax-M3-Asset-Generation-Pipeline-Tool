// tests/unit/renderer/audioCutterBehavior.test.js
//
// Behavioral test for the AudioCutter "✂ Export trimmed clip" button.
// Loads audioCutter.js into a vm sandbox, mocks the modal / DOM / api
// surface, then clicks the export button and verifies the audio:cut
// IPC payload contains the expected fields (startSec, endSec, fade,
// fadeMs, copy, quality, dstPath).
//
// Phase A: confirm the happy path. Phase B: confirm error paths
// (empty name, no selection, backend error).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// Mock DOM / window surface. The audioCutter module reaches into:
//   - window.el / window.createElement   (DOM helpers)
//   - window.showModal                   (modal system)
//   - window.toast                       (notifications)
//   - window.refreshBrowser              (file browser refresh)
//   - window.addLogEvent                 (log pane)
//   - window.api.audioProbe              (probe audio file)
//   - window.api.audioDecodePeaks        (downsample for waveform)
//   - window.api.audioCut                (the actual cut IPC)
//   - window.FileUrl.fileUrl             (file:// URL helper)
//   - document.documentElement           (CSS variable reads)
// ---------------------------------------------------------------------------

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
      children: [],
      attributes: {},
      style: {},
      classList: makeClassList(),
      dataset: {},
      _listeners: {},
      _value: '',
      parentNode: null,
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
      querySelector() { return null; },
      querySelectorAll() { return []; },
      focus() {}, blur() {},
      click() { this.dispatchEvent({ type: 'click', target: this }); },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      contains() { return false; },
      closest() { return null; },
      getBoundingClientRect() { return { top: 0, left: 0, right: 800, bottom: 200, width: 800, height: 200 }; },
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

  // Build a basic DOM with getElementById, createElement, etc.
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
    documentElement: { getPropertyValue: () => '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  // 2D canvas mock — the waveform renderer needs getContext('2d').
  const ctx2d = new Proxy({}, { get: () => () => {} });
  document.createElement = ((orig) => (tag, attrs, ...rest) => {
    const n = orig(tag, attrs, ...rest);
    if ((tag || '').toLowerCase() === 'canvas') {
      n.getContext = (kind) => (kind === '2d' ? ctx2d : null);
      n.width = 800;
      n.height = 200;
    }
    return n;
  })(document.createElement);

  // Collect audio:cut IPC calls for inspection.
  const cutCalls = [];

  // Configure the audioCutter module's expectations.
  const api = {
    audioProbe: (p) => Promise.resolve({
      ok: true,
      duration: 12.345,
      codec: 'mp3',
      sampleRate: 44100,
      channels: 2,
    }),
    audioDecodePeaks: (p, opts) => Promise.resolve({
      ok: true,
      peaks: new Array(800).fill(0).map((_, i) => Math.sin(i / 12) * 0.7),
    }),
    audioCut: (src, dst, opts) => {
      cutCalls.push({ src, dst, opts });
      return Promise.resolve({ ok: true, outputPath: dst });
    },
    // R7: the single-cut export now probes the destination before cutting
    // (audioCut runs ffmpeg -y). Report "doesn't exist" so the export proceeds.
    fbExists: (p, grantId) => Promise.resolve({ ok: true, exists: false }),
  };

  const state = {
    config: { api_key: 'sk-test-1234567890', output_dir: '' },
    pipelineAdvancedSettings: {
      audio: { mp3Quality: 2, oggQuality: 5, opusBitrate: 128000, m4aBitrate: 192000 },
    },
  };

  // showModal invokes the builder with (modalRoot, close) — we capture
  // the modalRoot so the test can poke it (find buttons, change inputs)
  // after audioCutter's builder finishes wiring it.
  const modal = makeEl('div');
  let modalCloseCalled = false;
  const showModal = (builder) => { builder(modal, () => { modalCloseCalled = true; }); };

  const toasts = [];
  const refreshBrowser = () => Promise.resolve();
  const addLogEvent = () => 1;

  Object.assign(sandbox, {
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: (cb) => setTimeout(cb, 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    Promise, Array, Object, String, Number, Boolean, Date, Math, JSON, Map, Set, WeakMap, WeakSet, Symbol,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    URL, Blob, File, FormData, fetch,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    Audio: class { constructor() { this.src = ''; this.preload = ''; } },
    FileUrl: { fileUrl: (p) => 'file:///' + String(p).replace(/\\/g, '/') },
    api,
    state,
    $: (sel) => (typeof sel === 'string' && sel.startsWith('#') ? getOrCreate(sel.slice(1)) : null),
    toast: (msg, kind, ms) => { toasts.push({ msg, kind, ms }); },
    showModal,
    refreshBrowser,
    addLogEvent,
    document,
    location: { href: 'app://ceegor/', protocol: 'app:', host: 'ceegor' },
    navigator: { userAgent: 'node-test', language: 'en', platform: 'test' },
    FileUrl: { fileUrl: (p) => 'file:///' + String(p).replace(/\\/g, '/'), makeFileUrl: (p) => 'file:///' + String(p).replace(/\\/g, '/') },
    // ParamRow.js sets window.el = window.createElement || ... — so
    // window.createElement must be present (and rich) for the el()
    // helper to actually return proper elements. Without this,
    // audioCutter's `el('button', ...)` falls through to the
    // `() => document.createElement('div')` fallback and every
    // button becomes a div with no click handler.
    createElement: document.createElement,
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
    _cutCalls: cutCalls,
    _toasts: toasts,
    _modal: modal,
    _modalCloseCalled: () => modalCloseCalled,
    _domCreateElement: document.createElement,
  });
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  return sandbox;
}

// ---------------------------------------------------------------------------
// Load audioCutter.js into a fresh VM context and invoke showAudioCutter.
// ---------------------------------------------------------------------------

function loadAndShowAudioCutter(srcPath) {
  const sandbox = makeSandbox();
  const context = vm.createContext(sandbox);
  // Load ParamRow.js first so audioCutter's `el = window.el || ...`
  // fallback chain has a creator available (just for completeness).
  const indexHtml = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  // Load only audioCutter.js (it self-registers as window.showAudioCutter).
  const src = fs.readFileSync(path.join(ROOT, 'renderer/audioCutter.js'), 'utf8');
  const wrapped = '// ' + path.join(ROOT, 'renderer/audioCutter.js') + '\n' + src;
  vm.runInContext(wrapped, context, { filename: path.join(ROOT, 'renderer/audioCutter.js'), timeout: 5000 });
  // Now call the entry point. The modal builder runs synchronously
  // (probe + decodePeaks fire async, after).
  sandbox.showAudioCutter(srcPath);
  return { sandbox, context };
}

// ---------------------------------------------------------------------------
// Wait for `n` setImmediate ticks so any pending microtasks / awaited
// IPC mocks can resolve.
// ---------------------------------------------------------------------------

function flush(n = 30) {
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => { if (++i >= n) resolve(); else setImmediate(tick); };
    setImmediate(tick);
  });
}

// ===========================================================================
// Tests
// ===========================================================================

test('audioCutter: showAudioCutter registers and opens the modal', async () => {
  const { sandbox } = loadAndShowAudioCutter('C:\\fake\\song.mp3');
  await flush();
  assert.ok(typeof sandbox.showAudioCutter === 'function', 'showAudioCutter must be exported');
  const modal = sandbox._modal;
  console.log('DEBUG modal.children.length=' + modal.children.length);
  for (let i = 0; i < modal.children.length; i++) {
    const c = modal.children[i];
    console.log('  modal.child[' + i + '].tagName=' + c.tagName + ' children=' + (c.children || []).length);
  }
  // The modal must contain the "✂ Export trimmed clip" button.
  let exportBtn = null;
  (function walk(n) {
    if (!n) return;
    if (n.tagName === 'BUTTON' && /Export trimmed clip/.test(n.textContent)) exportBtn = n;
    if (n.children) n.children.forEach(walk);
  })(modal);
  assert.ok(exportBtn, 'modal must contain an Export trimmed clip button');
});

test('audioCutter: clicking Export sends audioCut IPC with the expected payload', async () => {
  const { sandbox } = loadAndShowAudioCutter('C:\\fake\\song.mp3');
  await flush();
  const modal = sandbox._modal;
  // Find the input fields the user fills in.
  let exportBtn = null;
  let nameInp = null;
  let startInp = null;
  let endInp = null;
  (function walk(n) {
    if (!n) return;
    if (n.tagName === 'BUTTON' && /Export trimmed clip/.test(n.textContent)) exportBtn = n;
    if (n.tagName === 'INPUT' && n.classList._set.has('ac-name-inp')) nameInp = n;
    if (n.tagName === 'INPUT' && n.classList._set.has('ac-time-inp')) {
      if (!startInp) startInp = n; else endInp = n;
    }
    if (n.children) n.children.forEach(walk);
  })(modal);
  assert.ok(exportBtn && nameInp && startInp && endInp, 'must find export + name + start/end inputs');
  // Set a selection: 1.0s -> 3.5s.
  startInp.value = '0:01.000';
  endInp.value = '0:03.500';
  // Sanity: the modal must have probed the file and set duration to 12.345.
  // Force selection sync by dispatching input events.
  startInp.dispatchEvent({ type: 'input' });
  endInp.dispatchEvent({ type: 'input' });
  // Click Export.
  const listeners = (exportBtn._listeners && exportBtn._listeners.click) || [];
  assert.ok(listeners.length > 0, 'export button must have a click handler');
  for (const fn of listeners) { fn({ type: 'click', target: exportBtn }); }
  await flush(60);
  const cutCalls = sandbox._cutCalls;
  assert.ok(cutCalls.length >= 1, `audioCut IPC must fire; got ${cutCalls.length} call(s)`);
  const call = cutCalls[cutCalls.length - 1];
  assert.equal(call.src, 'C:\\fake\\song.mp3');
  assert.match(call.dst, /song_trim\.mp3$/, 'dst must end with song_trim.mp3 (the auto-generated name)');
  assert.equal(typeof call.opts.startSec, 'number', 'startSec must be a number');
  assert.equal(typeof call.opts.endSec, 'number', 'endSec must be a number');
  assert.ok(call.opts.endSec > call.opts.startSec, 'endSec > startSec');
  assert.ok(call.opts.fadeMs >= 0, 'fadeMs must be a non-negative number');
  assert.equal(typeof call.opts.fade, 'boolean');
  assert.equal(typeof call.opts.copy, 'boolean');
  // Quality must be forwarded from pipelineAdvancedSettings.audio.
  assert.ok(call.opts.quality, 'quality must be forwarded');
  assert.equal(call.opts.quality.mp3Quality, 2);
  assert.equal(call.opts.quality.oggQuality, 5);
  assert.equal(call.opts.quality.opusBitrate, 128000);
  assert.equal(call.opts.quality.m4aBitrate, 192000);
});

test('audioCutter: clicking Export with empty name shows an error (no IPC)', async () => {
  const { sandbox } = loadAndShowAudioCutter('C:\\fake\\song.mp3');
  await flush();
  const modal = sandbox._modal;
  let exportBtn = null;
  let nameInp = null;
  (function walk(n) {
    if (!n) return;
    if (n.tagName === 'BUTTON' && /Export trimmed clip/.test(n.textContent)) exportBtn = n;
    if (n.tagName === 'INPUT' && n.classList._set.has('ac-name-inp')) nameInp = n;
    if (n.children) n.children.forEach(walk);
  })(modal);
  // Empty the name field — the renderer must show the inline error and
  // NOT fire audioCut.
  nameInp.value = '';
  const listeners = (exportBtn._listeners && exportBtn._listeners.click) || [];
  for (const fn of listeners) { fn({ type: 'click', target: exportBtn }); }
  await flush();
  const cutCalls = sandbox._cutCalls;
  assert.equal(cutCalls.length, 0, 'audioCut must NOT fire when the output name is empty');
  // The renderer should have set the .ac-error box.
  let errBox = null;
  (function walk2(n) {
    if (!n) return;
    if (n.tagName === 'DIV' && n.classList._set.has('ac-error')) errBox = n;
    if (n.children) n.children.forEach(walk2);
  })(modal);
  assert.ok(errBox, 'modal must contain an .ac-error element');
  assert.ok(errBox.textContent && /name/i.test(errBox.textContent),
    `error box must mention the name; got: ${JSON.stringify(errBox.textContent)}`);
});