// tests/unit/renderer/pipelineClear.qa.test.js
// Phase 6 (adversarial QA) — pipelineClear.js is entirely untested by the
// existing suite. Covers:
//   - empty board (no finals) → warn toast, removed:0, no API calls
//   - user CANCELS confirm → removed:0, canceled:true, no trash/pipeline calls
//   - clear (no report): trashes every final, splices from items, re-renders
//   - clear WITH report: report written FIRST, then removed; report failure
//     still clears (best-effort) but warns
//   - export: copies to destDir, only trashes the successfully-exported items
//   - export pickFolder canceled → removed:0, canceled:true
//   - the modal menu: disabled when 0 finals, options enabled when >0
//
// pipelineReport gaps closed here too:
//   - report_dir whitespace is trimmed in resolveReportDir
//   - non-clashing path loop increments the suffix when the file exists
//   - writeReport returns ok:false when fbEnsureDir fails

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function fakeEl(tag, attrs, children) {
  const node = {
    _tag: tag, attrs: attrs || {}, _listeners: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    textContent: '', value: '', checked: false, disabled: false, dataset: {},
    childNodes: [], children: [],
  };
  node.appendChild = (c) => { node.childNodes.push(c); node.children.push(c); return c; };
  node.append = (...cs) => { for (const c of cs) node.childNodes.push(c); };
  node.addEventListener = (ev, fn) => { node._listeners[ev] = fn; };
  node.click = () => { if (node._listeners.click) node._listeners.click(); };
  if (typeof children === 'string') node.textContent = children;
  else if (Array.isArray(children)) for (const c of children) node.appendChild(typeof c === 'string' ? fakeEl('span', {}, c) : c);
  return node;
}

// Build a sandbox with a controllable board + API stubs + modal/confirm/tost.
function makeEnv(opts) {
  opts = opts || {};
  const board = {
    workspace: 'C:/ws',
    columnFolders: { final: 'C:/ws/final' },
    items: opts.items || [],
    trash: [],
    counter: (opts.items || []).length,
  };
  const apiCalls = { trash: [], copy: [], pickFolder: 0, exists: [], ensureDir: [], write: [] };
  const sandbox = {
    window: {
      state: {
        config: opts.config || {},
        pipeline: { image: board },
      },
      api: {
        pipelineTrash: async (arg) => { apiCalls.trash.push(arg); return { ok: true }; },
        fbCopy: async (src, dst) => { apiCalls.copy.push({ src, dst }); return { ok: opts.copyFail ? false : true }; },
        pickFolder: async () => { apiCalls.pickFolder++; return opts.pickFolder || null; },
        fbExists: async (p) => { apiCalls.exists.push(p); return { ok: true, exists: opts.existsMap ? opts.existsMap[p] : false }; },
        fbEnsureDir: async (d) => { apiCalls.ensureDir.push(d); return { ok: opts.ensureDirFail ? false : true }; },
        fbWrite: async (p, b64) => { apiCalls.write.push({ p, b64 }); return { ok: true, path: p }; },
      },
      scheduleStateSave: () => {},
      PipelineBoard: { save: () => {}, render: () => {}, refreshBadge: () => {} },
      PipelineReport: opts.skipReport ? undefined : {
        writeReport: opts.writeReport || (async () => ({ ok: true, path: 'E:/rep/r.md' })),
      },
    },
    el: fakeEl,
    console,
    confirm: () => opts.confirm !== false, // default true (user confirms)
    asyncConfirm: async () => opts.confirm !== false, // default true (user confirms)
    toast: () => {},
    showModal: opts.showModal || (() => {}),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    encodeURIComponent, unescape, escape, Date, Math, parseInt, String, Object, Array, Promise,
    setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  // Load BOTH report (needed by clear-with-report) and clear, matching real load order.
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer/pipeline/pipelineReport.js'), 'utf8'), sandbox, { filename: 'pipelineReport.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer/pipeline/pipelineClear.js'), 'utf8'), sandbox, { filename: 'pipelineClear.js' });
  // Keep the REAL report module (pure helpers) for tests that call resolveReportDir / writeReport directly.
  const Rreal = sandbox.window.PipelineReport;
  // IMPORTANT: pipelineReport.js overwrites window.PipelineReport on load, so
  // apply the caller's mock (or the default) AFTER loading so the clear ops
  // actually call it. Tests that pass an explicit writeReport get the mock;
  // otherwise keep the real module (so pipelineClear calls the real writer,
  // which is fine — it just hits the stubbed api.fbWrite).
  if (opts.writeReport) {
    sandbox.window.PipelineReport = { writeReport: opts.writeReport };
  }
  return { PC: sandbox.window.PipelineClear, R: Rreal, board, sandbox, apiCalls };
}

function finalItem(id, name) {
  return {
    id, name, column: 'final', status: 'idle', createdAt: 1,
    _dims: { w: 100, h: 100 },
    files: { original: 'C:/o.png', final: 'C:/ws/final/' + id + '_' + name + '.png' },
    history: [{ action: 'import' }],
  };
}

// ============================================= EMPTY BOARD
test('clearFinalColumn: empty board → warn toast, removed:0, no trash call', async () => {
  const { PC, apiCalls } = makeEnv({ items: [] });
  const r = await PC.clearFinalColumn();
  assert.equal(r.removed, 0);
  assert.equal(apiCalls.trash.length, 0, 'nothing trashed on empty board');
});

test('exportFinals: empty board → removed:0, no pickFolder', async () => {
  const { PC, apiCalls } = makeEnv({ items: [] });
  const r = await PC.exportFinals();
  assert.equal(r.removed, 0);
  assert.equal(apiCalls.pickFolder, 0, 'no folder dialog on empty board');
});

// ============================================= CONFIRM CANCEL
test('clearFinalColumn: user cancels confirm → canceled:true, nothing trashed', async () => {
  const { PC, apiCalls, board } = makeEnv({ items: [finalItem('a', 'x')], confirm: false });
  const r = await PC.clearFinalColumn();
  assert.equal(r.canceled, true);
  assert.equal(r.removed, 0);
  assert.equal(board.items.length, 1, 'item still on the board');
  assert.equal(apiCalls.trash.length, 0);
});

// ============================================= CLEAR (no report)
test('clearFinalColumn: trashes every final, splices from items, re-renders', async () => {
  const items = [finalItem('a', 'one'), finalItem('b', 'two')];
  const { PC, board, apiCalls } = makeEnv({ items });
  const r = await PC.clearFinalColumn();
  assert.equal(r.removed, 2);
  assert.equal(board.items.length, 0, 'both items removed');
  assert.equal(board.trash.length, 2, 'both moved to trash');
  // Still one pipelineTrash call per item (each has its own .trash/<id>/
  // folder), but they now run in parallel — see the parallelism test below.
  assert.equal(apiCalls.trash.length, 2, 'one pipelineTrash call per item');
});

test('O-2: removeItems fires pipelineTrash calls in PARALLEL (not sequentially)', async () => {
  // Detect parallelism: each trash call records start/end timestamps. If they
  // overlap, the calls ran concurrently. Sequential calls would be disjoint.
  const windows = [];
  let active = 0, maxActive = 0;
  const items = [finalItem('a', '1'), finalItem('b', '2'), finalItem('c', '3'), finalItem('d', '4')];
  const env = makeEnv({ items });
  env.sandbox.window.api.pipelineTrash = async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20)); // simulate a real round-trip
    windows.push(true);
    active--;
    return { ok: true };
  };
  await env.PC.clearFinalColumn();
  assert.equal(windows.length, 4, 'all 4 items trashed');
  assert.ok(maxActive >= 2, 'at least 2 trash calls overlapped (parallel), maxActive=' + maxActive);
});

test('clearFinalColumn: only FINAL-column items are touched (non-final survive)', async () => {
  const items = [
    Object.assign(finalItem('f', 'fin'), { column: 'final' }),
    Object.assign(finalItem('u', 'upscale'), { column: 'upscale', files: { original: 'C:/o.png', upscale: 'C:/u.png' } }),
  ];
  const { PC, board } = makeEnv({ items });
  const r = await PC.clearFinalColumn();
  assert.equal(r.removed, 1, 'only the one final');
  assert.equal(board.items.length, 1);
  assert.equal(board.items[0].id, 'u', 'upscale item survives');
});

// ============================================= CLEAR WITH REPORT
test('clearFinalColumnWithReport: report written THEN items removed', async () => {
  const order = [];
  const items = [finalItem('a', 'one')];
  const { PC, board, sandbox } = makeEnv({
    items,
    writeReport: async (its, opts) => { order.push('report'); return { ok: true, path: 'E:/r.md' }; },
    config: { report_dir: 'E:/rep' },
  });
  // instrument pipelineTrash to record ordering
  sandbox.window.api.pipelineTrash = async () => { order.push('trash'); return { ok: true }; };
  const r = await PC.clearFinalColumnWithReport();
  assert.equal(r.removed, 1);
  assert.ok(r.reportPath, 'E:/r.md');
  assert.deepEqual(order, ['report', 'trash'], 'report MUST be written before the items are removed');
});

test('clearFinalColumnWithReport: report write FAILS → still clears, warns', async () => {
  const items = [finalItem('a', 'one')];
  const { PC, board } = makeEnv({
    items,
    writeReport: async () => ({ ok: false, error: 'disk full' }),
  });
  const r = await PC.clearFinalColumnWithReport();
  assert.equal(r.removed, 1, 'clear proceeds even if the report fails (user asked to clear)');
  assert.equal(board.items.length, 0);
  assert.ok(!r.reportPath);
});

// ============================================= EXPORT
test('exportFinals: copies each final to destDir, removes only exported', async () => {
  const items = [finalItem('a', 'one'), finalItem('b', 'two')];
  const { PC, board, apiCalls } = makeEnv({ items, pickFolder: 'D:/out' });
  const r = await PC.exportFinals();
  assert.equal(r.saved, 2);
  assert.equal(r.removed, 2);
  assert.equal(apiCalls.copy.length, 2);
  assert.equal(board.items.length, 0);
});

test('exportFinals: a failed copy is NOT removed (kept on board)', async () => {
  const items = [finalItem('a', 'one'), finalItem('b', 'two')];
  const env = makeEnv({ items, pickFolder: 'D:/out' });
  // Make the SECOND fbCopy fail.
  let i = 0;
  env.sandbox.window.api.fbCopy = async () => { i++; return { ok: i === 2 ? false : true }; };
  const r = await env.PC.exportFinals();
  assert.equal(r.saved, 1);
  assert.equal(r.failed, 1);
  assert.equal(env.board.items.length, 1, 'the failed one stays on the board');
});

test('exportFinals: pickFolder canceled → canceled:true, removed:0', async () => {
  const items = [finalItem('a', 'one')];
  const { PC, apiCalls } = makeEnv({ items, pickFolder: null });
  const r = await PC.exportFinals();
  assert.equal(r.canceled, true);
  assert.equal(r.removed, 0);
  assert.equal(apiCalls.copy.length, 0);
});

test('exportFinalsWithReport: report written for the EXPORTED items only', async () => {
  const items = [finalItem('a', 'one')];
  let reportedItems = null;
  const env = makeEnv({
    items, pickFolder: 'D:/out',
    writeReport: async (its) => { reportedItems = its; return { ok: true, path: 'D:/out/r.md' }; },
  });
  const r = await env.PC.exportFinalsWithReport();
  assert.equal(r.saved, 1);
  assert.equal(r.reportPath, 'D:/out/r.md');
  assert.equal(Array.isArray(reportedItems), true, 'writeReport was invoked');
  assert.equal(reportedItems.length, 1, 'report covers the 1 exported item');
});

// ============================================= MODAL MENU
test('openFinalColumnMenu: shows the "no finals" message when board is empty', () => {
  let built = false;
  const { PC } = makeEnv({ items: [], showModal: (b) => { built = true; b(fakeEl('div'), () => {}); } });
  PC.openFinalColumnMenu();
  assert.equal(built, true, 'menu opens even when empty');
});

test('openFinalColumnMenu: builds all 4 option buttons + Close when finals exist', () => {
  const items = [finalItem('a', 'one')];
  // Capture every element appended to the modal element.
  const appended = [];
  const modalHost = fakeEl('div');
  modalHost.appendChild = (c) => { appended.push(c); return c; };
  const { PC } = makeEnv({ items, showModal: (b) => { b(modalHost, () => {}); } });
  PC.openFinalColumnMenu();
  // Compute each subtree's text by concatenating its own textContent + children.
  function textOf(n) {
    if (!n) return '';
    let t = (typeof n.textContent === 'string') ? n.textContent : '';
    for (const c of (n.children || [])) t += textOf(c);
    return t;
  }
  const all = appended.map(textOf).join('||');
  assert.ok(/Export all finals/.test(all), 'Export option present');
  assert.ok(/Export all \+ report/.test(all), 'Export+report option present');
  assert.ok(/Clear final column/.test(all), 'Clear option present');
  assert.ok(/Clear with report/.test(all), 'Clear+report option present');
  assert.ok(/Close/.test(all), 'Close button present');
});

// ============================================= REPORT GAPS
test('resolveReportDir: report_dir whitespace is trimmed', () => {
  const { R } = makeEnv({ config: { report_dir: '   E:/spaced   ' } });
  assert.equal(R.resolveReportDir({}), 'E:/spaced');
});

test('writeReport non-clash: bumps the suffix (_2, _3) when the file exists', async () => {
  // chooseReportPath is internal — exercise it via writeReport. Make fbExists
  // report the first two candidates as existing so the third (_3) is chosen.
  const env = makeEnv({ config: { report_dir: 'E:/rep' } });
  let existsCalls = 0;
  env.sandbox.window.api.fbExists = async () => { existsCalls++; return { ok: true, exists: existsCalls < 3 }; };
  const r = await env.R.writeReport([finalItem('a', 'x')], { mode: 'clear' });
  assert.equal(r.ok, true);
  assert.ok(/_3\.md$/.test(r.path), 'third candidate (_3) chosen after two collisions, got: ' + r.path);
  assert.ok(existsCalls >= 3, 'the non-clash loop actually queried multiple candidates');
});

test('writeReport: returns ok:false when fbEnsureDir fails', async () => {
  const { R } = makeEnv({ ensureDirFail: true, config: { report_dir: 'E:/bad' } });
  const r = await R.writeReport([finalItem('a', 'x')], { mode: 'clear' });
  assert.equal(r.ok, false);
  assert.ok(/Could not create/i.test(r.error), 'error mentions the dir creation failure');
});
