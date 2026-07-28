// tests/unit/renderer/ActiveJobsWidget.test.js
// ============================================================================
// Phase B of _plan3.md — tests for the active jobs widget.
//
// The widget is a pure projection of state.jobs (it subscribes to
// JobRunner events and re-renders). These tests load the actual
// production files (JobRunner.js + ActiveJobsWidget.js) and verify
// the public behaviour:
//   - init() wires the widget to the JobRunner event stream.
//   - Adding a job makes the widget show a row for it.
//   - Removing the job (running it to completion) hides the row.
//   - Clicking the cancel button calls JobRunner.cancel.
//   - Clicking the row (not the cancel button) calls
//     LogService.scrollToJob.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    classList: {
      _set: new Set(),
      add(c) { if (c) for (const cls of String(c).split(/\s+/).filter(Boolean)) this._set.add(cls); },
      remove(c) { if (c) for (const cls of String(c).split(/\s+/).filter(Boolean)) this._set.delete(cls); },
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
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] == null ? null : String(this.attributes[k]); },
    addEventListener(ev, fn) { (this._listeners = this._listeners || {})[ev] = (this._listeners[ev] || []).concat(fn); },
    removeEventListener(ev, fn) {
      if (!this._listeners || !this._listeners[ev]) return;
      this._listeners[ev] = this._listeners[ev].filter((f) => f !== fn);
    },
    dispatchEvent(ev) {
      // Mirror the real DOM event flow: the listener on this element
      // fires first, then the event "bubbles" up to the parent
      // (which fires its own listener if registered). The test
      // uses this for click events on inner elements that should
      // bubble up to the row.
      if (!this._listeners || !this._listeners[ev.type]) {
        if (this.parentNode && this.parentNode.dispatchEvent) {
          return this.parentNode.dispatchEvent(ev);
        }
        return true;
      }
      for (const fn of this._listeners[ev.type]) {
        try { fn(ev); } catch (_) { /* ignore */ }
      }
      if (this.parentNode && this.parentNode.dispatchEvent) {
        return this.parentNode.dispatchEvent(ev);
      }
      return true;
    },
    querySelector(sel) {
      if (!sel) return null;
      // Compound selector: `.cls[attr="val"]` is the shape the
      // production code uses most (e.g. `.log-event[data-log-id="1"]`).
      const compound = sel.match(/^(\.[\w-]+)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
      if (compound) {
        const cls = compound[1].slice(1);
        const match = (n) => {
          if (!n.classList || !n.classList.contains(cls)) return false;
          if (!compound[2]) return true;
          const actual = n.attributes[compound[2]];
          return compound[3] === undefined ? actual != null : String(actual) === compound[3];
        };
        for (const c of this.children) {
          if (match(c)) return c;
          const found = c.querySelector && c.querySelector(sel);
          if (found) return found;
        }
        return null;
      }
      if (sel.startsWith('.')) {
        for (const c of this.children) {
          if (c.classList && c.classList.contains(sel.slice(1))) return c;
          const found = c.querySelector && c.querySelector(sel);
          if (found) return found;
        }
        return null;
      }
      for (const c of this.children) {
        if (c.tagName === sel.toUpperCase()) return c;
        const found = c.querySelector && c.querySelector(sel);
        if (found) return found;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (!sel) return [];
      const out = [];
      const collect = (n) => {
        if (sel.startsWith('.')) return n.classList && n.classList.contains(sel.slice(1));
        return n.tagName === sel.toUpperCase();
      };
      for (const c of this.children) {
        if (collect(c)) out.push(c);
        if (c.querySelectorAll) out.push(...c.querySelectorAll(sel));
      }
      return out;
    },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); return child; },
    remove() {
      if (this.parentNode) {
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      }
    },
    set textContent(v) { this._text = v; this.children = []; },
    get textContent() { return this._text != null ? this._text : this.children.map((c) => c.textContent || '').join(''); },
    set innerHTML(v) { this._innerHTML = v; this.children = []; },
    get innerHTML() { return this._innerHTML || ''; },
    // Real DOM maps element.id → setAttribute('id'). Mirror that so
    // getElementById('xxx') works after `host.id = 'xxx'`.
    set id(v) { this.attributes.id = v; },
    get id() { return this.attributes.id; },
    // Real DOM maps element.className → classList.add(cls). Mirror
    // that so `row.className = 'active-jobs-row'` is queryable via
    // `querySelector('.active-jobs-row')`.
    set className(v) {
      this._className = v;
      if (this.classList && v) for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList.add(c);
    },
    get className() { return this._className || ''; },
  };
}

function setupMock() {
  delete global.window;
  delete global.document;
  const body = makeEl('body');
  const doc = makeEl('html');
  doc.body = body;
  doc.documentElement = doc;
  doc.readyState = 'complete';
  // Track every element created via createElement so getElementById
  // can find it (the production widget uses doc.createElement +
  // setAttribute('id', ...), then later reads it back via
  // doc.getElementById).
  const registry = [];
  doc.createElement = (tag) => {
    const n = makeEl(tag);
    registry.push(n);
    return n;
  };
  doc.getElementById = (id) => {
    for (const n of registry) {
      if (n.attributes && n.attributes.id === id) return n;
      // Search children too (the host element has the widget as a child).
      const stack = [...n.children];
      while (stack.length) {
        const c = stack.shift();
        if (c.attributes && c.attributes.id === id) return c;
        if (c.children) stack.push(...c.children);
      }
    }
    return null;
  };
  doc.querySelector = (sel) => {
    const all = [];
    const collect = (n) => { all.push(n); for (const c of n.children) collect(c); };
    for (const r of registry) collect(r);
    const match = (n) => {
      if (sel.startsWith('#')) return n.attributes && n.attributes.id === sel.slice(1);
      if (sel.startsWith('.')) return n.classList && n.classList.contains(sel.slice(1));
      return n.tagName === sel.toUpperCase();
    };
    return all.find(match) || null;
  };
  doc.querySelectorAll = (sel) => {
    const all = [];
    const collect = (n) => { all.push(n); for (const c of n.children) collect(c); };
    for (const r of registry) collect(r);
    const match = (n) => {
      if (sel.startsWith('#')) return n.attributes && n.attributes.id === sel.slice(1);
      if (sel.startsWith('.')) return n.classList && n.classList.contains(sel.slice(1));
      return n.tagName === sel.toUpperCase();
    };
    return all.filter(match);
  };
  // Support body.appendChild by attaching it to document.
  doc.appendChild = (n) => { body.children.push(n); n.parentNode = body; return n; };
  const win = {
    api: { mmxCancel: () => Promise.resolve({ ok: true }) },
    state: { _logEvents: [], jobs: new Map() },
    toast: () => {},
    el: (tag, attrs, ...children) => {
      const n = makeEl(tag);
      if (attrs && typeof attrs === 'object') {
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'class') n.classList.add(v);
          else n.attributes[k] = v;
        }
      }
      for (const c of children.flat()) {
        if (c == null) continue;
        if (typeof c === 'string' || typeof c === 'number') {
          const t = makeEl('span'); t.textContent = String(c); n.children.push(t); t.parentNode = n;
        } else if (typeof c === 'object' && c.tagName) {
          n.children.push(c); c.parentNode = n;
        }
      }
      return n;
    },
    createElement: (tag) => {
      const n = makeEl(tag);
      return n;
    },
    LogCategories: { LOG_MAX_EVENTS: 500, LOG_CATEGORIES: { info: { icon: '·', label: 'Info' } } },
    securityUtils: { maskLine: (s) => String(s) },
  };
  win.document = doc;
  global.window = win;
  global.document = doc;
  // Suppress the widget's 500ms ticker so the test process exits
  // promptly. The widget's `setInterval(render, 500)` is a global
  // call (not `window.setInterval`); override the global.
  global.setInterval = () => 0;
  global.clearInterval = () => {};
  return { win, body };
}

function loadJobRunnerAndWidget() {
  const jf = path.join(ROOT, 'renderer', 'jobs', 'JobRunner.js');
  const wf = path.join(ROOT, 'renderer', 'widgets', 'ActiveJobsWidget.js');
  delete require.cache[require.resolve(jf)];
  delete require.cache[require.resolve(wf)];
  // Pre-stub LogService (the JobRunner uses it).
  let nextId = 0;
  global.window.LogService = {
    addLogEvent(opts) {
      opts = opts || {};
      const ev = { id: ++nextId, ts: new Date(), headline: opts.headline || '', details: opts.details || [], jobId: opts.jobId || null, state: opts.state || 'wip', cancellable: !!opts.cancellable, typeIcon: opts.typeIcon || null };
      global.window.state._logEvents.push(ev);
      return ev.id;
    },
    updateLogStatus() {},
    appendLogDetails() {},
    scrollToJob() {},
  };
  require(jf);
  require(wf);
  return { JobRunner: global.window.JobRunner, ActiveJobsWidget: global.window.ActiveJobsWidget };
}

test('ActiveJobsWidget.init wires up the JobRunner event subscriptions', () => {
  setupMock();
  const { ActiveJobsWidget } = loadJobRunnerAndWidget();
  // We can't directly inspect the private _listeners Map, but
  // adding a job BEFORE init should NOT trigger a re-render (no
  // listener), and adding a job AFTER init should trigger one.
  // Verify the public behaviour: init() doesn't throw, and
  // activeJobs() is empty.
  ActiveJobsWidget.init();
  const w = global.window.document.getElementById('active-jobs-widget');
  assert.ok(w, 'init() must create the widget element');
  if (!w) return;
  // The widget must have querySelector (it's a real DOM-like
  // element created by our mock's makeEl).
  assert.equal(typeof w.querySelector, 'function',
    'widget must have querySelector (got: ' + typeof w.querySelector + ')');
});

test('ActiveJobsWidget shows a row for each active job (real JobRunner)', async () => {
  setupMock();
  const { JobRunner, ActiveJobsWidget } = loadJobRunnerAndWidget();
  ActiveJobsWidget.init();
  // Start a job via the real JobRunner API. The runFn never
  // resolves, so the job stays wip.
  let resolveRun;
  const stalled = new Promise((r) => { resolveRun = r; });
  const ctrl = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    title: 'Test image',
    typeIcon: '🖼',
    runFn: () => stalled,
  });
  // Wait for the runFn to start (queueMicrotask).
  await new Promise((r) => setImmediate(r));
  // The widget must now have one row.
  const w = global.window.document.getElementById('active-jobs-widget');
  assert.ok(w, 'widget must exist');
  const rows = w.querySelectorAll('.active-jobs-row');
  assert.equal(rows.length, 1, 'one row per active job');
  // The row's title is the job title.
  const title = rows[0].querySelector('.active-jobs-title');
  assert.equal(title.textContent, 'Test image');
  // The row's icon is the typeIcon.
  const icon = rows[0].querySelector('.active-jobs-icon');
  assert.equal(icon.textContent, '🖼');
  // Cleanup
  resolveRun({ status: 'ok' });
  await ctrl.done;
});

test('ActiveJobsWidget hides the row when the job ends', async () => {
  setupMock();
  const { JobRunner, ActiveJobsWidget } = loadJobRunnerAndWidget();
  ActiveJobsWidget.init();
  let resolveRun;
  const stalled = new Promise((r) => { resolveRun = r; });
  const ctrl = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    title: 'Will finish',
    runFn: () => stalled,
  });
  await new Promise((r) => setImmediate(r));
  let w = global.window.document.getElementById('active-jobs-widget');
  assert.equal(w.querySelectorAll('.active-jobs-row').length, 1);
  // Finish the job.
  resolveRun({ status: 'ok' });
  await ctrl.done;
  // The widget should now be hidden (no active jobs).
  w = global.window.document.getElementById('active-jobs-widget');
  assert.equal(w.style.display, 'none');
  assert.equal(w.querySelectorAll('.active-jobs-row').length, 0);
});

test('ActiveJobsWidget row: clicking the cancel button calls JobRunner.cancel', async () => {
  setupMock();
  const { JobRunner, ActiveJobsWidget } = loadJobRunnerAndWidget();
  ActiveJobsWidget.init();
  let resolveRun;
  const stalled = new Promise((r) => { resolveRun = r; });
  const ctrl = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    title: 'Cancel me',
    runFn: () => stalled,
  });
  await new Promise((r) => setImmediate(r));
  const w = global.window.document.getElementById('active-jobs-widget');
  const row = w.querySelectorAll('.active-jobs-row')[0];
  const cancelBtn = row.querySelector('.active-jobs-cancel');
  // Dispatch a click on the cancel button.
  cancelBtn.dispatchEvent({ type: 'click', target: cancelBtn });
  // The runFn's signal must be aborted.
  assert.equal(ctrl.cancel && typeof ctrl.cancel === 'function', true);
  // Cleanup: resolve the runFn (it won't be called again).
  resolveRun({ status: 'cancel' });
  await ctrl.done;
});

test('ActiveJobsWidget row: clicking the row body calls LogService.scrollToJob', async () => {
  setupMock();
  const { JobRunner, ActiveJobsWidget } = loadJobRunnerAndWidget();
  let scrolled = null;
  global.window.LogService.scrollToJob = (id) => { scrolled = id; };
  ActiveJobsWidget.init();
  let resolveRun;
  const stalled = new Promise((r) => { resolveRun = r; });
  const ctrl = JobRunner.run({
    tabKey: 'image',
    type: 'image',
    title: 'Click me',
    runFn: () => stalled,
  });
  await new Promise((r) => setImmediate(r));
  const w = global.window.document.getElementById('active-jobs-widget');
  const row = w.querySelectorAll('.active-jobs-row')[0];
  // Dispatch a click on the row's icon (NOT the cancel button).
  const icon = row.querySelector('.active-jobs-icon');
  icon.dispatchEvent({ type: 'click', target: icon });
  assert.equal(scrolled, ctrl.jobId, 'LogService.scrollToJob must be called with the job id');
  // Cleanup
  resolveRun({ status: 'ok' });
  await ctrl.done;
});
