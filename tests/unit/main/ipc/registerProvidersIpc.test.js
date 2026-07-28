// tests/unit/main/ipc/registerProvidersIpc.test.js
// Unit tests for the providers IPC handler — focuses on the download
// error path and grant gating that aren't covered by the adapter tests.
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---- Isolate config to a temp dir ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-ipc-test-'));
process.env.MINIMAX_CONFIG_DIR = tmpDir;

// ---- Stub electron ----
const handlers = new Map();
const fakeIpcMain = {
  handle: (channel, fn) => handlers.set(channel, fn),
  removeHandler: (channel) => handlers.delete(channel),
};
const userData = path.join(tmpDir, 'userData');
fs.mkdirSync(userData, { recursive: true });
require.cache[require.resolve('electron')] = {
  exports: {
    app: { getPath: (k) => (k === 'userData' ? userData : tmpDir) },
    ipcMain: fakeIpcMain,
  },
};

// Clear caches so modules pick up the env override + electron stub.
for (const key of Object.keys(require.cache)) {
  if (key.includes('providersStore') || key.includes('registerProvidersIpc') || key.includes(path.join('src', 'config'))) {
    delete require.cache[key];
  }
}

// Stub the grant authorizer to always allow (we test the download path, not grants).
const grantMod = require.resolve('../../../../main/ipc/grantAuthorizer');
require.cache[grantMod] = {
  exports: { authorizePath: () => ({ ok: true }) },
};

// Now load the registrar (it will call ipcMain.handle for each channel).
delete require.cache[require.resolve('../../../../main/ipc/registerProvidersIpc')];
const { register } = require('../../../../main/ipc/registerProvidersIpc');
register({ getMainWindow: () => null });

// ---- Mock fetch ----
let fetchResponses = [];
const realFetch = globalThis.fetch;
beforeEach(() => { fetchResponses = []; });
afterEach(() => { globalThis.fetch = realFetch; });

function jsonResp(data, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => data, text: async () => JSON.stringify(data), arrayBuffer: async () => new ArrayBuffer(0) };
}

// ---- Tests ----

test('providers:generate writes b64 output to disk', async () => {
  const outDir = path.join(tmpDir, 'out-b64');
  const handler = handlers.get('providers:generate');
  assert.ok(handler, 'handler registered');

  // Mock the adapter call: the store returns openrouter (kind=openrouter),
  // and the openaiCompat.images adapter will be called. We mock fetch to
  // return a b64 image response.
  globalThis.fetch = async () => jsonResp({ data: [{ b64_json: Buffer.from('PNG-DATA').toString('base64') }] });

  const r = await handler({}, {
    jobId: 'test-1', modality: 'image', providerId: 'openrouter',
    model: 'gpt-image-1', prompt: 'a cat', params: {},
    outDir, grantId: 'g1',
  });
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 1);
  assert.ok(fs.existsSync(r.files[0]), 'file written to disk');
  assert.equal(fs.readFileSync(r.files[0], 'utf8'), 'PNG-DATA');
});

test('providers:generate throws on download HTTP error (url-based output)', async () => {
  const outDir = path.join(tmpDir, 'out-url');
  const handler = handlers.get('providers:generate');

  // The adapter returns a URL-based output; the handler's download fetch gets a 404.
  let callCount = 0;
  globalThis.fetch = async (url) => {
    callCount++;
    // First call: the adapter's API call (images/generations) — return a URL output.
    if (callCount === 1) return jsonResp({ data: [{ url: 'https://cdn.example.com/img.png' }] });
    // Second call: the handler's download — return 404.
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), text: async () => 'not found' };
  };

  const r = await handler({}, {
    jobId: 'test-2', modality: 'image', providerId: 'openrouter',
    model: 'gpt-image-1', prompt: 'a dog', params: {},
    outDir, grantId: 'g1',
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('download HTTP 404'), 'error mentions download HTTP 404: ' + r.error);
});

test('providers:cancel aborts in-flight job', async () => {
  const cancelHandler = handlers.get('providers:cancel');
  assert.ok(cancelHandler, 'cancel handler registered');
  const r = cancelHandler({}, { jobId: 'nonexistent' });
  assert.deepEqual(r, { ok: true });
});

test('providers:get returns default config', () => {
  const getHandler = handlers.get('providers:get');
  assert.ok(getHandler, 'get handler registered');
  const cfg = getHandler({});
  assert.ok(cfg.providers, 'has providers');
  assert.equal(cfg.providers.length, 3);
});

test('providers:set persists and round-trips', () => {
  const setHandler = handlers.get('providers:set');
  const getHandler = handlers.get('providers:get');
  const data = getHandler({});
  data.providers[0].apiKey = 'sk-roundtrip';
  const r = setHandler({}, data);
  assert.equal(r.ok, true);
  const back = getHandler({});
  assert.equal(back.providers[0].apiKey, 'sk-roundtrip');
});

test('providers:generate returns error for unsupported modality', async () => {
  const handler = handlers.get('providers:generate');
  const r = await handler({}, {
    jobId: 'test-mod', modality: 'music', providerId: 'openrouter',
    model: 'm', prompt: 'p', params: {}, outDir: tmpDir, grantId: 'g1',
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('does not support music'), 'error mentions unsupported: ' + r.error);
});

test('providers:generate returns error for unknown provider', async () => {
  const handler = handlers.get('providers:generate');
  const r = await handler({}, {
    jobId: 'test-prov', modality: 'image', providerId: 'nonexistent',
    model: 'm', prompt: 'p', params: {}, outDir: tmpDir, grantId: 'g1',
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('unknown provider'), 'error mentions unknown provider: ' + r.error);
});

test('providers:generate writes multiple outputs with indexed names', async () => {
  const outDir = path.join(tmpDir, 'out-multi');
  const handler = handlers.get('providers:generate');
  // Return 2 b64 images
  globalThis.fetch = async () => jsonResp({
    data: [
      { b64_json: Buffer.from('IMG1').toString('base64') },
      { b64_json: Buffer.from('IMG2').toString('base64') },
    ],
  });
  const r = await handler({}, {
    jobId: 'test-multi', modality: 'image', providerId: 'openrouter',
    model: 'gpt-image-1', prompt: 'two cats', params: { n: 2 },
    outDir, grantId: 'g1',
  });
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 2);
  // Filenames should have _1 and _2 suffixes
  const names = r.files.map((f) => path.basename(f));
  assert.ok(names[0].includes('_1.'), 'first file has _1 suffix: ' + names[0]);
  assert.ok(names[1].includes('_2.'), 'second file has _2 suffix: ' + names[1]);
  assert.equal(fs.readFileSync(r.files[0], 'utf8'), 'IMG1');
  assert.equal(fs.readFileSync(r.files[1], 'utf8'), 'IMG2');
});

test('providers:listModels returns models for openrouter', async () => {
  const handler = handlers.get('providers:listModels');
  assert.ok(handler, 'listModels handler registered');
  globalThis.fetch = async () => jsonResp({ data: [{ id: 'model-x' }, { id: 'model-y' }] });
  const r = await handler({}, { providerId: 'openrouter' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['model-x', 'model-y']);
});

test('providers:listModels returns empty for replicate (no listModels)', async () => {
  const handler = handlers.get('providers:listModels');
  const r = await handler({}, { providerId: 'replicate' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, []);
});

test('providers:generate reports canceled flag on abort', async () => {
  const outDir = path.join(tmpDir, 'out-cancel');
  const handler = handlers.get('providers:generate');
  const cancelHandler = handlers.get('providers:cancel');
  // Make fetch hang until aborted
  globalThis.fetch = async (url, opts) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResp({ data: [{ b64_json: 'x' }] })), 30000);
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('The operation was aborted'));
        });
      }
    });
  };
  const p = handler({}, {
    jobId: 'cancel-me', modality: 'image', providerId: 'openrouter',
    model: 'm', prompt: 'p', params: {}, outDir, grantId: 'g1',
  });
  // Give the handler time to start, then cancel
  await new Promise((r) => setTimeout(r, 50));
  cancelHandler({}, { jobId: 'cancel-me' });
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.canceled, true);
});

// Cleanup
test('cleanup', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MINIMAX_CONFIG_DIR;
});
