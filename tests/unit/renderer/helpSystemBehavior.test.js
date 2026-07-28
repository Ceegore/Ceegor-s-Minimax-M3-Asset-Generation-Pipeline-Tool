// tests/unit/renderer/helpSystemBehavior.test.js
// ============================================================================
// BEHAVIORAL TEST for the v1.1.18 help system. Loads section23 in a real
// harness and exercises showHelp() + deriveTitleFromDom() to verify the
// "Help" title bug is fixed (the modal title must NOT be just "Help"
// when an inline help string is passed).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function setupWindowMock() {
  delete global.window;
  delete global.document;
  const elements = {};
  const getOrCreate = (id, tag) => {
    if (!elements[id]) {
      const n = makeEl(tag || 'div');
      n.id = id;
      elements[id] = n;
    }
    return elements[id];
  };
  const win = {
    elements,
    getOrCreate,
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => makeEl(tag),
    addEventListener: () => {},
    body: makeEl('body'),
  };
  global.window = win;
  return win;
}

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    id: '',
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
    },
    parentNode: null,
    dataset: {},
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) {
      if (!this._listeners[ev]) return;
      this._listeners[ev] = this._listeners[ev].filter((f) => f !== fn);
    },
    dispatchEvent(event) {
      for (const fn of (this._listeners[event.type] || [])) fn(event);
      return true;
    },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    insertBefore(child, ref) {
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(child);
      else this.children.splice(i, 0, child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    closest(sel) {
      // .row lookup
      if (sel === '.row') return this._row || null;
      return null;
    },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] == null ? null : String(this.attributes[k]); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    blur() { global.window.activeElement = global.window.body; },
    set textContent(v) { this._text = v; this.children = []; },
    get textContent() { return this._text != null ? this._text : this.children.map((c) => c.textContent || '').join(''); },
    set innerHTML(v) { this._innerHTML = v; this.children = []; },
    get innerHTML() { return this._innerHTML || ''; },
  };
}

// Capture modal calls so we can assert on the title.
// Must be called AFTER the el factory is set up, otherwise the
// build callback throws ReferenceError on `el(...)`.
function setupShowModalCapture() {
  const captured = [];
  const modalFn = (build, opts) => {
    // Run the build callback to populate the modal contents.
    const m = makeEl('div');
    build(m, () => {});
    // Extract the <h2> title (first child).
    const titleEl = m.children[0];
    captured.push({
      title: titleEl ? (titleEl.textContent || '').replace(/^[^A-Za-z0-9]+/, '') : '',
      body: m.textContent || '',
    });
    return m;
  };
  global.showModal = modalFn;
  return captured;
}

test('showHelp synthesizes a title from the parent <label> when the topic key is an inline string', () => {
  const win = setupWindowMock();
  // Define the el factory FIRST so it's set up before section23 loads.
  const elFactory = (tag, attrs, ...children) => {
    const n = win.createElement(tag);
    if (attrs && typeof attrs === 'object') {
      for (const [k, v] of Object.entries(attrs)) n.attributes[k] = v;
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      if (typeof c === 'string' || typeof c === 'number') {
        const t = makeEl('span');
        t.textContent = String(c);
        n.children.push(t);
      } else if (typeof c === 'object' && c.tagName) {
        n.children.push(c);
      }
    }
    return n;
  };
  global.window.el = elFactory;
  global.el = elFactory;
  // Capture showModal calls (after el is set up).
  const captured = setupShowModalCapture();
  // Stub the DOM: a row containing a label + a help button. The
  // help button is "focused" (it's the activeElement) when
  // showHelp runs.
  const row = win.createElement('div');
  row._row = row; // for closest('.row')
  const label = win.createElement('label');
  label.textContent = '--voice';
  const btn = win.createElement('button');
  btn.classList._set.add('help-btn');
  // Build the DOM hierarchy: <div class="row"><label>--voice</label><button class="help-btn">?</button></div>
  const labelWithContent = {
    ...label,
    textContent: '--voice',
    closest: () => row,
  };
  row.querySelector = (sel) => (sel === 'label' ? labelWithContent : null);
  btn.closest = (sel) => (sel === '.row' ? row : null);
  // Set the focused element.
  global.window.activeElement = btn;
  global.document = {
    activeElement: btn,
    querySelector: () => null,
    body: { tagName: 'BODY' },
  };
  // Load section23 AFTER window is set up.
  delete require.cache[require.resolve(path.join(ROOT, 'renderer/sections/section23_Centralized_help_system.js'))];
  require(path.join(ROOT, 'renderer/sections/section23_Centralized_help_system.js'));
  // Now call showHelp with an inline string (the path the user
  // hits when buildParamRow({help: 'Some text'}) is rendered).
  global.window.showHelp('Some inline help text', null);
  assert.equal(captured.length, 1, 'showHelp must have invoked showModal');
  // The title must NOT be the literal "Help" — that's the bug
  // the user reported. The synthesize-from-DOM title is "--voice".
  assert.notEqual(captured[0].title, 'Help',
    'showHelp must NOT use the literal "Help" as a title (user-reported bug)');
  assert.ok(captured[0].title.length > 0,
    'showHelp must synthesize a title when the topic is an inline string');
});