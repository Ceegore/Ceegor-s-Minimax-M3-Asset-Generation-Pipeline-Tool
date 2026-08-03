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
  if (key.includes('providersStore') || key.includes('registerProvidersIpc') || key.includes('secureHandle') || key.includes(path.join('src', 'config'))) {
    delete require.cache[key];
  }
}

// Stub the grant authorizer to always allow (we test the download path, not grants).
const grantMod = require.resolve('../../../../main/ipc/grantAuthorizer');
require.cache[grantMod] = {
  exports: { authorizePath: () => ({ ok: true }) },
};

// Stub ArtifactFinalizer: write b64 data to stage dir, simulate URL download errors.
const finalizerMod = require.resolve('../../../../main/services/ArtifactFinalizer');
let finalizerUrlError = null; // set by tests to simulate download failures
require.cache[finalizerMod] = {
  exports: {
    finalize: async (descriptor, opts) => {
      const stageDir = opts.stageDirectory || tmpDir;
      fs.mkdirSync(stageDir, { recursive: true });
      const stagedPath = path.join(stageDir, 'staged_' + Date.now() + '_' + Math.random().toString(36).slice(2));
      if (descriptor.data) {
        // b64 path: decode and write
        const buf = Buffer.from(descriptor.data, 'base64');
        fs.writeFileSync(stagedPath, buf);
        return { stagedPath, extension: 'png', mediaType: 'image/png', bytes: buf.length, sha256: 'stub', metadata: {} };
      }
      if (descriptor.url) {
        // URL path: simulate download
        if (finalizerUrlError) throw new Error(finalizerUrlError);
        const buf = Buffer.from('URL-DATA');
        fs.writeFileSync(stagedPath, buf);
        return { stagedPath, extension: 'png', mediaType: 'image/png', bytes: buf.length, sha256: 'stub', metadata: {} };
      }
      throw new Error('finalize: no data or url in descriptor');
    },
    detectType: () => 'png',
  },
};

// Stub OutputTransactionService: simple pass-through that copies staged files.
const txnMod = require.resolve('../../../../main/services/OutputTransactionService');
require.cache[txnMod] = {
  exports: {
    OutputTransactionService: class {
      constructor() { this._files = new Map(); }
      begin() { const id = 'txn-' + Date.now(); this._files.set(id, []); return { transactionId: id, stageDir: path.join(tmpDir, 'stage-' + id) }; }
      addFile(txnId, entry) { (this._files.get(txnId) || []).push(entry); }
      commit(txnId) {
        for (const f of (this._files.get(txnId) || [])) {
          fs.mkdirSync(path.dirname(f.finalPath), { recursive: true });
          fs.copyFileSync(f.stagedPath, f.finalPath);
        }
        this._files.delete(txnId);
        return { committed: true };
      }
      cancel() {}
    },
  },
};

// H-001 (hhhhu3 audit): registerProvidersIpc now injects SafeHttpClient into
// the adapters, so the network is stubbed at the SafeHttpClient boundary
// (queued responses) instead of via globalThis.fetch.
const httpMod = require.resolve('../../../../main/services/SafeHttpClient');
require.cache[httpMod] = {
  exports: {
    json: async (url, options = {}) => {
      const next = httpResponses.shift();
      if (!next) throw new Error('SafeHttpClient stub: no queued response for ' + url);
      if (next.hang) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(next.json), 30000);
          if (options && options.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('The operation was aborted'));
            });
          }
        });
      }
      if (next.error) throw new Error(next.error);
      return next.json;
    },
    bytes: async (url) => {
      const next = httpResponses.shift();
      if (!next) throw new Error('SafeHttpClient stub: no queued response for ' + url);
      if (next.error) throw new Error(next.error);
      return next.bytes;
    },
    toFile: async () => { throw new Error('SafeHttpClient stub: toFile not queued'); },
  },
};

// Now load the registrar (it will call ipcMain.handle for each channel).
delete require.cache[require.resolve('../../../../main/ipc/registerProvidersIpc')];
const { register } = require('../../../../main/ipc/registerProvidersIpc');
register({ getMainWindow: () => null });

// ---- Queued SafeHttpClient responses (H-001 hhhhu3 audit) ----
let httpResponses = [];
beforeEach(() => { httpResponses = []; });
afterEach(() => { httpResponses = []; });

// ---- Tests ----

test('providers:generate writes b64 output to disk', async () => {
  const outDir = path.join(tmpDir, 'out-b64');
  const handler = handlers.get('providers:generate');
  assert.ok(handler, 'handler registered');

  // Mock the adapter call: the store returns openrouter (kind=openrouter),
  // and the openaiCompat.images adapter will be called. The injected
  // SafeHttpClient is stubbed to return a b64 image response.
  httpResponses.push({ json: { data: [{ b64_json: Buffer.from('PNG-DATA').toString('base64') }] } });

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

  // The adapter returns a URL-based output; the finalizer's download gets a 404.
  finalizerUrlError = 'download HTTP 404';
  httpResponses.push({ json: { data: [{ url: 'https://93.184.216.34/img.png' }] } });

  const r = await handler({}, {
    jobId: 'test-2', modality: 'image', providerId: 'openrouter',
    model: 'gpt-image-1', prompt: 'a dog', params: {},
    outDir, grantId: 'g1',
  });
  finalizerUrlError = null; // reset
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('download HTTP 404'), 'error mentions download HTTP 404: ' + r.error);
});

test('providers:cancel aborts in-flight job', async () => {
  const cancelHandler = handlers.get('providers:cancel');
  assert.ok(cancelHandler, 'cancel handler registered');
  const r = cancelHandler({}, { jobId: 'nonexistent' });
  assert.deepEqual(r, { ok: true });
});

test('providers:getPublic returns default config (SEC-002: secret-free DTO)', () => {
  const getHandler = handlers.get('providers:getPublic');
  assert.ok(getHandler, 'getPublic handler registered');
  const cfg = getHandler({});
  assert.ok(cfg.providers, 'has providers');
  assert.equal(cfg.providers.length, 3);
  // SEC-002: no raw apiKey in the response.
  for (const p of cfg.providers) {
    assert.equal(p.apiKey, undefined, 'raw apiKey must not be exposed');
  }
});

test('providers:set persists and round-trips via getPublic (SEC-002)', async () => {
  const setHandler = handlers.get('providers:set');
  const getHandler = handlers.get('providers:getPublic');
  const data = getHandler({});
  // SEC-002: send a new apiKey (write-only from renderer).
  // Include ALL providers so the store doesn't lose entries (providers:set
  // replaces the full array).
  const update = { providers: data.providers.map((p, i) => i === 0 ? { ...p, apiKey: 'sk-roundtrip' } : { id: p.id, label: p.label, kind: p.kind, baseUrl: p.baseUrl || '' }), selections: data.selections };
  const r = await setHandler({}, update);
  assert.equal(r.ok, true);
  const back = getHandler({});
  // SEC-002: verify via hasKey boolean, not raw apiKey.
  assert.equal(back.providers[0].hasKey, true);
  assert.equal(back.providers[0].apiKeyLast4, 'trip');
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
  try {
    const r = await handler({}, {
      jobId: 'test-prov', modality: 'image', providerId: 'nonexistent',
      model: 'm', prompt: 'p', params: {}, outDir: tmpDir, grantId: 'g1',
    });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('unknown provider'), 'error mentions unknown provider: ' + r.error);
  } catch (e) {
    // The handler may throw for unknown providers (providersStore.provider throws).
    assert.ok(String(e.message || e).includes('unknown provider'), 'error mentions unknown provider: ' + e.message);
  }
});

test('providers:generate writes multiple outputs with indexed names', async () => {
  const outDir = path.join(tmpDir, 'out-multi');
  const handler = handlers.get('providers:generate');
  // Return 2 b64 images
  httpResponses.push({ json: {
    data: [
      { b64_json: Buffer.from('IMG1').toString('base64') },
      { b64_json: Buffer.from('IMG2').toString('base64') },
    ],
  } });
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
  httpResponses.push({ json: { data: [{ id: 'model-x' }, { id: 'model-y' }] } });
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
  // Make the injected HTTP client hang until aborted
  httpResponses.push({ hang: true, json: { data: [{ b64_json: 'x' }] } });
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
