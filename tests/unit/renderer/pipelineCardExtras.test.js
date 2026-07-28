// tests/unit/renderer/pipelineCardExtras.test.js
// Unit tests for the Pipeline card extras (Task 0/1/1.1): info-panel warning
// logic, duplicate-item insertion order, and the saveAndRemove/batch flow.
// Loaded into a vm sandbox with mocked globals (no DOM needed for the pure
// logic; DOM-touching paths are smoke-tested via the renderer harness).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function makeSandbox() {
  const sandbox = {};
  function makeEl(tag) {
    const e = {
      tagName: (tag || 'div').toUpperCase(), children: [], style: {}, classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      append(...cs) { cs.forEach((c) => { if (c == null) return; this.children.push(c); c.parentNode = this; }); },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      addEventListener() {}, setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; },
    };
    return e;
  }
  sandbox.window = {
    PipelineModel: {
      safeBaseName: (n) => n, nextColumn: (c) => ({ original: 'upscale', upscale: 'removebg' }[c] || null),
    },
    state: { pipeline: { image: { items: [], trash: [], workspace: 'C:/ws', counter: 0 } } },
    api: {
      pipelineImport: () => Promise.resolve({ results: [{ ok: true, dst: 'C:/ws/original/img_new_a.png', imageId: 'img_new' }] }),
      pipelineTrash: () => Promise.resolve({ ok: true }),
      fbCopy: () => Promise.resolve({ ok: true }),
      pickFolder: () => Promise.resolve('C:/out'),
    },
    scheduleStateSave: () => {},
  };
  sandbox.el = (t) => makeEl(t);
  sandbox.console = console;
  sandbox.asyncConfirm = async () => true; // KGO4-005: non-blocking confirm
  sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
  Object.defineProperty(sandbox, 'self', { value: sandbox, configurable: true });
  vm.createContext(sandbox);
  return sandbox;
}

function loadIn(sb, rel) { vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sb, { filename: rel }); }

test('duplicateItem inserts the new item directly BELOW the original (createdAt + 1)', async () => {
  const sb = makeSandbox();
  // stub loadImageFromFile so buildInfoPanel (called if a card renders) doesn't reject
  sb.window.PureFuncs = { loadImageFromFile: () => Promise.resolve({ naturalWidth: 0, naturalHeight: 0 }) };
  sb.window.PipelineBoard = { render() {}, refreshBadge() {}, save() {}, toast() {} };
  sb.window.toast = () => {};
  // confirm() must return true so duplicate proceeds
  sb.window.confirm = () => true;
  sb.asyncConfirm = async () => true;
  loadIn(sb, 'renderer/pipeline/pipelineCardExtras.js');
  const X = sb.window.PipelineCardExtras;

  const orig = { id: 'img_a', column: 'upscale', name: 'a', createdAt: 1000,
    files: { original: 'C:/o.png', upscale: 'C:/ws/upscale/img_a_a_2x.png' },
    settings: { upscale: { multiplier: 2 } }, history: [], status: 'idle', error: null };
  sb.window.state.pipeline.image.items = [orig];

  await X.duplicateItem(orig);
  const items = sb.window.state.pipeline.image.items;
  assert.strictEqual(items.length, 2, 'item inserted');
  assert.strictEqual(items[0].id, 'img_a', 'original stays first');
  assert.strictEqual(items[1].id, 'img_new', 'new item second');
  assert.strictEqual(items[1].column, 'upscale', 'duplicated at the SAME column');
  assert.ok(items[1].createdAt > orig.createdAt, 'new createdAt after original (sorts below)');
  assert.strictEqual(items[1].files.upscale, 'C:/ws/original/img_new_a.png', 'new file path recorded');
  // settings copied (compare field-by-field — deepStrictEqual fails cross-vm-realm)
  assert.ok(items[1].settings && items[1].settings.upscale, 'settings.upscale copied');
  assert.strictEqual(items[1].settings.upscale.multiplier, 2, 'multiplier preserved');
  // history starts fresh with a single duplicate provenance entry (not inherited)
  assert.ok(Array.isArray(items[1].history), 'history is an array');
  assert.strictEqual(items[1].history.length, 1, 'history starts fresh (1 duplicate entry)');
  assert.strictEqual(items[1].history[0].action, 'duplicate', 'history entry is the duplicate');
});

test('duplicateItem refuses a running item and an item with no file', async () => {
  const sb = makeSandbox();
  sb.window.PipelineBoard = { render() {}, refreshBadge() {}, save() {}, toast() {} };
  sb.window.toast = () => {};
  sb.window.confirm = () => { throw new Error('confirm should not be called'); };
  sb.asyncConfirm = async () => { throw new Error('confirm should not be called'); };
  loadIn(sb, 'renderer/pipeline/pipelineCardExtras.js');
  const X = sb.window.PipelineCardExtras;
  // running → refuses
  await X.duplicateItem({ id: 'r', column: 'upscale', files: { upscale: 'x.png' }, status: 'running' });
  assert.strictEqual(sb.window.state.pipeline.image.items.length, 0, 'running item not added');
  // no file in current column → refuses
  await X.duplicateItem({ id: 'nf', column: 'upscale', files: { original: 'x.png' }, status: 'idle' });
  assert.strictEqual(sb.window.state.pipeline.image.items.length, 0, 'no-file item not added');
});

test('duplicateItem honours a confirm() = false (cancels)', async () => {
  const sb = makeSandbox();
  sb.window.PipelineBoard = { render() {}, refreshBadge() {}, save() {}, toast() {} };
  sb.window.toast = () => {};
  sb.window.confirm = () => false;
  sb.asyncConfirm = async () => false;
  loadIn(sb, 'renderer/pipeline/pipelineCardExtras.js');
  const orig = { id: 'a', column: 'original', name: 'a', createdAt: 1, files: { original: 'a.png' }, status: 'idle' };
  sb.window.state.pipeline.image.items = [orig];
  await sb.window.PipelineCardExtras.duplicateItem(orig);
  assert.strictEqual(sb.window.state.pipeline.image.items.length, 1, 'confirm-cancel aborts');
});

test('batchExportAndRemoveFinal exports + removes only finalized items', async () => {
  const sb = makeSandbox();
  sb.window.PipelineBoard = { render() {}, refreshBadge() {}, save() {}, toast() {} };
  sb.window.toast = () => {};
  loadIn(sb, 'renderer/pipeline/pipelineCardExtras.js');
  const X = sb.window.PipelineCardExtras;
  sb.window.state.pipeline.image.items = [
    { id: 'f1', column: 'final', files: { original: 'o.png', final: 'C:/ws/final/f1.png' } },
    { id: 'u1', column: 'upscale', files: { original: 'o.png', upscale: 'u.png' } }, // not final → untouched
    { id: 'f2', column: 'final', files: { original: 'o.png', final: 'C:/ws/final/f2.png' } },
  ];
  const r = await X.batchExportAndRemoveFinal();
  assert.strictEqual(r.saved, 2, 'both finals exported');
  assert.strictEqual(r.removed, 2, 'both finals removed');
  const remaining = sb.window.state.pipeline.image.items;
  assert.strictEqual(remaining.length, 1, 'only the non-final item remains');
  assert.strictEqual(remaining[0].id, 'u1', 'the upscaled item was left alone');
});
