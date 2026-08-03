// tests/unit/architecture-wiring.hhhhu3.test.js
// ============================================================================
// L-001 (hhhhu3 audit): the older "architecture integration" suite asserted
// on source STRINGS (src.includes(...)), which proves a name appears in a
// file — not that the wiring executes. This suite supplements it with
// BEHAVIOR tests that run the real code paths:
//
//   1. preload exposes the API — load the real preload.js and INVOKE the
//      bridge functions, recording the ipcRenderer channels/args;
//   2. renderer calls it — load the real fbIntentBridge/fbListPaged into a
//      mock window and drive them through a recording window.api;
//   3. repositories point to the same file — every relative require inside
//      main/ resolves to an existing module (dead imports fail loudly);
//   4. services are invoked in the correct order — confirm-before-execute
//      and listStart -> listNext -> listClose orderings are observed on
//      the recorded call sequences;
//   5. recovery is run at boot — main/index.js runs output-transaction
//      recovery BEFORE the IPC registrar loop, and the real
//      OutputTransactionService.recover() demonstrably cleans a seeded
//      incomplete journal.
// ============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// 1. preload exposes the API (execute, not grep).
// ---------------------------------------------------------------------------
function loadPreload() {
  const invokes = [];
  let exposedName = null;
  let api = null;
  // Clear any cached preload/electron so the stub takes effect.
  try { delete require.cache[require.resolve(path.join(ROOT, 'preload.js'))]; } catch (_) {}
  require.cache[require.resolve('electron')] = {
    exports: {
      contextBridge: {
        exposeInMainWorld(name, exposed) { exposedName = name; api = exposed; },
      },
      ipcRenderer: {
        invoke(channel, ...args) { invokes.push({ channel, args }); return Promise.resolve({ ok: true }); },
        on() {}, removeListener() {}, send() {},
      },
    },
  };
  require(path.join(ROOT, 'preload.js'));
  return { api, exposedName, invokes };
}

test('L-001: preload exposes fbConfirmDestructive and invoking it reaches the fb:confirmDestructive channel', async () => {
  const { api, exposedName, invokes } = loadPreload();
  assert.equal(exposedName, 'api');
  assert.equal(typeof api.fbConfirmDestructive, 'function', 'the confirm bridge must be exposed');
  const spec = { operation: 'delete', sourcePath: 'C:\\work\\a.txt', sourceGrantId: 'g1' };
  await api.fbConfirmDestructive(spec);
  const call = invokes.find((i) => i.channel === 'fb:confirmDestructive');
  assert.ok(call, 'invoking the exposed fn must reach fb:confirmDestructive');
  assert.deepEqual(call.args, [spec], 'the spec must be forwarded unchanged');
});

test('L-001: preload fbDelete/fbRename/fbMove forward the intentId as the trailing arg', async () => {
  const { api, invokes } = loadPreload();
  await api.fbDelete('C:\\work\\a.txt', 'g1', 'intent-1');
  await api.fbRename('C:\\work\\a.txt', 'b.txt', 'g1', 'intent-2');
  await api.fbMove('C:\\work\\a.txt', 'C:\\work\\out', 'g1', 'g2', 'intent-3');
  const del = invokes.find((i) => i.channel === 'fb:delete');
  const ren = invokes.find((i) => i.channel === 'fb:rename');
  const mov = invokes.find((i) => i.channel === 'fb:move');
  assert.deepEqual(del.args, ['C:\\work\\a.txt', 'g1', 'intent-1']);
  assert.deepEqual(ren.args, ['C:\\work\\a.txt', 'b.txt', 'g1', 'intent-2']);
  assert.deepEqual(mov.args, ['C:\\work\\a.txt', 'C:\\work\\out', 'g1', 'g2', 'intent-3']);
});

test('L-001: preload exposes the paginated listing surface and reaches fb:listStart/Next/Close', async () => {
  const { api, invokes } = loadPreload();
  assert.equal(typeof api.fbListStart, 'function');
  assert.equal(typeof api.fbListNext, 'function');
  assert.equal(typeof api.fbListClose, 'function');
  await api.fbListStart({ dir: 'C:\\work', grantId: 'g1' });
  await api.fbListNext({ sessionId: 's1', cursor: 'c1' });
  await api.fbListClose({ sessionId: 's1' });
  const chans = invokes.map((i) => i.channel);
  assert.ok(chans.includes('fb:listStart'));
  assert.ok(chans.includes('fb:listNext'));
  assert.ok(chans.includes('fb:listClose'));
});

// ---------------------------------------------------------------------------
// 2. renderer bridges call the exposed API, in the correct order (execute).
// ---------------------------------------------------------------------------
function freshWindow() {
  const win = {};
  win.window = win;
  return win;
}

function loadBridges(win) {
  // The bridges read the free `window` global at CALL time, so the mock
  // must stay installed while the test drives them. Each bridge test
  // installs its own window before driving, so no teardown is needed.
  global.window = win;
  for (const rel of ['fbIntentBridge.js', 'fbListPaged.js']) {
    const p = path.join(ROOT, 'renderer', 'services', rel);
    delete require.cache[require.resolve(p)];
    require(p);
  }
}

test('L-001: FbIntent.del executes confirm-THEN-delete and forwards the minted intentId', async () => {
  const win = freshWindow();
  const calls = [];
  win.api = {
    fbConfirmDestructive: async (spec) => { calls.push(['confirm', spec]); return { ok: true, intentId: 'tok-9' }; },
    fbDelete: async (p, grantId, intentId) => { calls.push(['delete', p, grantId, intentId]); return { ok: true }; },
  };
  loadBridges(win);
  const r = await win.FbIntent.del('C:\\work\\a.txt', 'g1');
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2, 'exactly confirm + delete');
  assert.equal(calls[0][0], 'confirm', 'confirmation must run FIRST');
  assert.equal(calls[0][1].operation, 'delete');
  assert.equal(calls[1][0], 'delete');
  assert.equal(calls[1][3], 'tok-9', 'the minted intentId must reach fbDelete');
});

test('L-001: a canceled confirmation stops the mutation (quiet no-op envelope)', async () => {
  const win = freshWindow();
  const calls = [];
  win.api = {
    fbConfirmDestructive: async () => { calls.push('confirm'); return { ok: false, canceled: true }; },
    fbDelete: async () => { calls.push('delete'); return { ok: true }; },
  };
  loadBridges(win);
  const r = await win.FbIntent.del('C:\\work\\a.txt', 'g1');
  assert.equal(win.FbIntent.isCanceled(r), true, 'the envelope must be recognisable as a cancel');
  assert.deepEqual(calls, ['confirm'], 'fbDelete must NOT run after a cancel');
});

test('L-001: FbListPaged.drain walks listStart -> listNext -> listClose and concatenates pages in order', async () => {
  const win = freshWindow();
  const order = [];
  win.api = {
    fbListStart: async (opts) => {
      order.push('start');
      assert.equal(opts.pageSize, 500, 'the renderer must request the max page size');
      return { ok: true, sessionId: 's1', dir: opts.dir, cursor: 'c1', hasMore: true, totalCount: 3, items: [{ name: 'a.png', isDir: false, ext: '.png' }] };
    },
    fbListNext: async (opts) => {
      order.push('next');
      assert.deepEqual(opts, { sessionId: 's1', cursor: 'c1' }, 'the session id + opaque cursor must be echoed back');
      return { ok: true, cursor: null, hasMore: false, items: [{ name: 'b.png', isDir: false, ext: '.png' }, { name: 'c.png', isDir: false, ext: '.png' }] };
    },
    fbListClose: async (opts) => { order.push('close'); assert.equal(opts.sessionId, 's1'); return { ok: true }; },
    fbList: async () => { order.push('legacy'); return { ok: false, error: 'legacy must not run when the paginated surface exists' }; },
  };
  loadBridges(win);
  const r = await win.FbListPaged.drain('C:\\work', 'g1');
  assert.equal(r.ok, true);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.items.map((it) => it.name), ['a.png', 'b.png', 'c.png'], 'pages concatenate in server order');
  assert.ok(r.items.every((it) => typeof it.path === 'string' && it.path.startsWith('C:\\work')), 'items are normalised to the legacy shape (path joined)');
  assert.equal(order[0], 'start', 'listStart first');
  assert.ok(order.indexOf('next') > order.indexOf('start'), 'listNext after listStart');
  assert.ok(order.includes('close'), 'the session must be closed');
  assert.ok(!order.includes('legacy'), 'the legacy fbList fallback must not run');
});

test('L-001: FbListPaged.drain falls back to legacy fbList when the paginated surface is absent', async () => {
  const win = freshWindow();
  win.api = { fbList: async (dir, grantId) => ({ ok: true, dir, grantId, items: [{ name: 'x.png' }] }) };
  loadBridges(win);
  const r = await win.FbListPaged.drain('C:\\work', 'g7');
  assert.equal(r.ok, true);
  assert.equal(r.grantId, 'g7', 'the fallback must still thread the grant');
});

// ---------------------------------------------------------------------------
// 3. repositories/modules point to the same file: every relative require
//    inside main/ resolves to an existing module (execute require.resolve).
// ---------------------------------------------------------------------------
function walkJs(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('L-001: every relative require() in main/ resolves to an existing module', () => {
  const files = walkJs(path.join(ROOT, 'main'), []);
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      try {
        require.resolve(path.resolve(path.dirname(f), m[1]));
      } catch (_) {
        bad.push(path.relative(ROOT, f) + ' -> ' + m[1]);
      }
    }
  }
  assert.deepEqual(bad, [], 'dead relative requires found:\n' + bad.join('\n'));
});

// ---------------------------------------------------------------------------
// 5. recovery is run at boot: ordering in main/index.js + the real
//    OutputTransactionService.recover() cleaning a seeded journal.
// ---------------------------------------------------------------------------
test('L-001: main/index.js runs output-transaction recovery BEFORE the IPC registrar loop', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'index.js'), 'utf8');
  const recoverIdx = src.indexOf('txnService.recover()');
  const registrarIdx = src.indexOf('for (const entry of ipcRegistrars)');
  assert.ok(recoverIdx >= 0, 'boot must construct+recover the transaction service');
  assert.ok(registrarIdx >= 0, 'boot must register IPC handlers');
  assert.ok(recoverIdx < registrarIdx, 'recovery must run BEFORE the registrars (renderer cannot race a half-recovered store)');
});

test('L-001: the real OutputTransactionService.recover() cleans a seeded incomplete journal', () => {
  const { OutputTransactionService } = require(path.join(ROOT, 'main', 'services', 'OutputTransactionService'));
  const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l001-journal-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l001-root-'));
  try {
    const txnId = crypto.randomUUID();
    const stageDir = path.join(root, `.mmas-stage-${txnId}`);
    fs.mkdirSync(stageDir);
    const journal = {
      schemaVersion: 1,
      transactionId: txnId,
      state: 'PREPARING',
      canonicalRoot: root,
      leaseId: null,
      createdAt: Date.now(),
      stageDir,
      files: [],
    };
    fs.writeFileSync(path.join(journalDir, `${txnId}.json`), JSON.stringify(journal));

    const svc = new OutputTransactionService({ journalDir });
    const r = svc.recover();
    assert.equal(r.recovered, 1, 'the incomplete PREPARING journal must be recovered');
    assert.ok(!fs.existsSync(path.join(journalDir, `${txnId}.json`)), 'journal removed');
    assert.ok(!fs.existsSync(stageDir), 'stage dir removed');
  } finally {
    fs.rmSync(journalDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
