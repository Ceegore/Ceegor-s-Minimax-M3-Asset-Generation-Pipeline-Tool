// tests/unit/main/ipc/registerBatchesIpc.h053h054.test.js
// ============================================================================
// H-054 regression: `batches:generateExamples` must only create the CHOSEN
// format, under an exclusively-created free name — it must never overwrite an
// existing file and never delete a sibling file it didn't create this run.
//
// H-053 regression (IPC layer): while batches.json is in recovery,
// `batches:set` fails with EBATCHRECOVERY, `batches:recoveryStatus` reports
// the pending recovery, and `batches:acknowledgeRecovery` is Main-owned (the
// native dialog decides; Cancel keeps writes blocked).
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function purgeProjectCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ROOT) && key !== __filename) delete require.cache[key];
  }
}

async function withBatchesIpc(run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batches-ipc-'));
  const outputDir = path.join(tmp, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const prevEnv = process.env.MINIMAX_CONFIG_DIR;
  process.env.MINIMAX_CONFIG_DIR = tmp;
  purgeProjectCache();

  const handlers = {};
  const messageBoxCalls = [];
  // Response queue for dialog.showMessageBox: shift per call, default OK (0).
  const messageBoxResponses = [];
  const electronMock = {
    ipcMain: {
      handle(channel, fn) { handlers[channel] = fn; },
      on() {},
    },
    dialog: {
      async showMessageBox(...args) {
        messageBoxCalls.push(args);
        const response = messageBoxResponses.length ? messageBoxResponses.shift() : 0;
        return { response };
      },
      async showSaveDialog() { return { canceled: true }; },
      async showOpenDialog() { return { canceled: true, filePaths: [] }; },
    },
    app: {
      getPath() { return tmp; },
    },
    BrowserWindow: class BrowserWindow {},
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const config = require(path.join(ROOT, 'src', 'config.js'));
    config.write({ api_key: '', output_dir: outputDir, region: 'global' });
    const registrar = require(path.join(ROOT, 'main', 'ipc', 'registerBatchesIpc.js'));
    registrar.register({ appRoot: ROOT, getMainWindow: () => null });
    const batchMod = require(path.join(ROOT, 'src', 'batches.js'));
    return await run({ tmp, outputDir, handlers, batchMod, messageBoxCalls, messageBoxResponses });
  } finally {
    Module._load = originalLoad;
    if (prevEnv == null) delete process.env.MINIMAX_CONFIG_DIR;
    else process.env.MINIMAX_CONFIG_DIR = prevEnv;
    purgeProjectCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// H-054
// ---------------------------------------------------------------------------

test('H-054: generateExamples writes ONLY the chosen format', async () => {
  await withBatchesIpc(async ({ outputDir, handlers }) => {
    const res = await handlers['batches:generateExamples'](null, 'md');
    assert.equal(res.ok, true);
    assert.equal(res.format, 'md');
    assert.equal(res.path, path.join(outputDir, 'example_batch_import.md'));
    assert.equal(fs.existsSync(res.path), true);
    // The non-chosen format is never created (so it can't be "cleaned up").
    assert.equal(fs.existsSync(path.join(outputDir, 'example_batch_import.txt')), false);
    // The legacy mdPath/txtPath fields (which implied both files exist) are gone.
    assert.equal('mdPath' in res, false);
    assert.equal('txtPath' in res, false);
  });
});

test('H-054: existing user files are never overwritten or deleted', async () => {
  await withBatchesIpc(async ({ outputDir, handlers }) => {
    const userMd = path.join(outputDir, 'example_batch_import.md');
    const userTxt = path.join(outputDir, 'example_batch_import.txt');
    fs.writeFileSync(userMd, 'MY PRECIOUS MD NOTES', 'utf8');
    fs.writeFileSync(userTxt, 'MY PRECIOUS TXT NOTES', 'utf8');

    const res = await handlers['batches:generateExamples'](null, 'md');
    assert.equal(res.ok, true);
    // Collision -> the export lands on the next free suffixed name.
    assert.equal(res.path, path.join(outputDir, 'example_batch_import (1).md'));
    assert.equal(fs.existsSync(res.path), true);
    // BOTH user files survive with their exact content (the old code
    // overwrote the .md and DELETED the .txt here).
    assert.equal(fs.readFileSync(userMd, 'utf8'), 'MY PRECIOUS MD NOTES');
    assert.equal(fs.readFileSync(userTxt, 'utf8'), 'MY PRECIOUS TXT NOTES');
  });
});

test('H-054: repeated exports keep allocating free suffixed names', async () => {
  await withBatchesIpc(async ({ outputDir, handlers }) => {
    const r1 = await handlers['batches:generateExamples'](null, 'txt');
    const r2 = await handlers['batches:generateExamples'](null, 'txt');
    const r3 = await handlers['batches:generateExamples'](null, 'txt');
    assert.equal(r1.path, path.join(outputDir, 'example_batch_import.txt'));
    assert.equal(r2.path, path.join(outputDir, 'example_batch_import (1).txt'));
    assert.equal(r3.path, path.join(outputDir, 'example_batch_import (2).txt'));
    for (const r of [r1, r2, r3]) {
      assert.equal(r.ok, true);
      assert.equal(r.format, 'txt');
      assert.ok(fs.readFileSync(r.path, 'utf8').length > 0);
    }
    // The md sibling was never created nor touched.
    assert.equal(fs.existsSync(path.join(outputDir, 'example_batch_import.md')), false);
  });
});

// ---------------------------------------------------------------------------
// H-053 (IPC layer)
// ---------------------------------------------------------------------------

test('H-053 IPC: recovery blocks batches:set until the native dialog confirms', async () => {
  await withBatchesIpc(async ({ tmp, handlers, messageBoxCalls, messageBoxResponses }) => {
    const file = path.join(tmp, 'batches.json');
    const corrupt = '{ definitely not json';
    fs.writeFileSync(file, corrupt, 'utf8');

    // batches:get returns safe defaults but latches recovery + backup.
    const got = handlers['batches:get']();
    assert.deepEqual(got, { image: [], speech: [], music: [], video: [] });

    const status = handlers['batches:recoveryStatus']();
    assert.equal(status.ok, true);
    assert.equal(status.pending.reason, 'parse-failed');
    assert.equal(fs.existsSync(status.pending.backupPath), true);

    // Writes are refused with the coded error; the corrupt source survives.
    const denied = handlers['batches:set'](null, { image: ['wipe attempt'], speech: [], music: [], video: [] });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'EBATCHRECOVERY');
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt);

    // Cancel in the native dialog keeps writes blocked.
    messageBoxResponses.push(1);
    const canceled = await handlers['batches:acknowledgeRecovery'](null);
    assert.equal(canceled.ok, true);
    assert.equal(canceled.acknowledged, false);
    assert.equal(messageBoxCalls.length, 1);
    const stillDenied = handlers['batches:set'](null, { image: [], speech: [], music: [], video: [] });
    assert.equal(stillDenied.ok, false);
    assert.equal(stillDenied.code, 'EBATCHRECOVERY');

    // OK acknowledges: writes resume, the backup stays on disk.
    messageBoxResponses.push(0);
    const acked = await handlers['batches:acknowledgeRecovery'](null);
    assert.equal(acked.ok, true);
    assert.equal(acked.acknowledged, true);
    const saved = handlers['batches:set'](null, { image: ['fresh'], speech: [], music: [], video: [] });
    assert.deepEqual(saved, { ok: true });
    assert.equal(fs.existsSync(status.pending.backupPath), true);
    assert.deepEqual(handlers['batches:get']().image, ['fresh']);
  });
});

test('H-053 IPC: acknowledge without a pending recovery skips the dialog', async () => {
  await withBatchesIpc(async ({ handlers, messageBoxCalls }) => {
    const res = await handlers['batches:acknowledgeRecovery'](null);
    assert.equal(res.ok, true);
    assert.equal(res.acknowledged, true);
    assert.equal(res.pending, null);
    assert.equal(messageBoxCalls.length, 0, 'no native dialog when there is nothing to recover');
  });
});
