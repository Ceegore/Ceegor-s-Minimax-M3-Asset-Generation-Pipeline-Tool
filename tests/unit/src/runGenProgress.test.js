// tests/unit/src/runGenProgress.test.js
// R6.6.6: Run-ID Progress-Filterung — verifies that the upscale IPC handler
// includes `runGen` in progress events so the renderer can filter stale
// progress from a prior run generation.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('R6.6.6.A: registerUpscaleIpc forwards runGen in progress event', async () => {
  // Capture the progress event payload.
  let progressPayload = null;
  const mockWin = {
    send: (channel, data) => {
      if (channel === 'upscale:realesrgan:progress') progressPayload = data;
    },
  };
  const mockEvent = { sender: mockWin };

  // Mock realesrgan.run to invoke onProgress with a known pct.
  const mockRealesrgan = {
    run: async (_src, _dst, opts) => {
      if (typeof opts.onProgress === 'function') opts.onProgress(42);
      return { ok: true, code: 0, stderr: '', outputPath: _dst };
    },
    isAvailable: () => true,
    getBinaryPath: () => 'C:\\fake\\realesrgan.exe',
    probeVersion: () => '0.2.5.0',
    resetCache: () => {},
  };

  // Mock ipcMain.handle to capture the handler.
  let runHandler = null;
  const mockIpcMain = {
    handle: (channel, handler) => {
      if (channel === 'upscale:realesrgan:run') runHandler = handler;
    },
  };

  // Load registerUpscaleIpc with mocks.
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { ipcMain: mockIpcMain, dialog: {} };
    if (request.endsWith('realesrgan') || request === '../../src/realesrgan') return mockRealesrgan;
    if (request.endsWith('grantAuthorizer') || request === './grantAuthorizer') {
      return { authorizePath: () => ({ ok: true }) };
    }
    if (request.endsWith('legacyAdapter') || request === './legacyAdapter') {
      return { wrapInpaintHandler: (fn) => fn, adaptInpaintResult: (r) => r };
    }
    if (request.endsWith('InstallDownloadService') || request.includes('InstallDownloadService')) {
      return { downloadRealesrgan: async () => ({ ok: true }) };
    }
    return realLoad.call(this, request, parent, isMain);
  };

  const ipcPath = require.resolve(path.join(ROOT, 'main', 'ipc', 'registerUpscaleIpc.js'));
  delete require.cache[ipcPath];
  // P4.1 (DB-H-002/008): the handler now validates the output artifact, so
  // the dst must be a real (valid, >= 64 byte) PNG — the mocked run() writes
  // nothing.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rungen-'));
  const dstPng = path.join(tmpDir, 'dst.png');
  // H-064: the finalizer now fully decodes image artifacts, so the dst must
  // be a REAL decodable PNG (1x1 transparent, ~70 bytes ≥ minSize 64).
  fs.writeFileSync(dstPng, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  ));
  try {
    const mod = require(ipcPath);
    mod.register({ appRoot: 'C:\\fake' });
    assert.ok(runHandler, 'upscale:realesrgan:run handler must be registered');

    // Call the handler with runGen in opts.
    const result = await runHandler(mockEvent, 'C:\\fake\\src.png', dstPng, {
      progressKey: 'img_test',
      runGen: 7,
    }, 'fake-grant');

    assert.ok(result.ok, 'handler should succeed');
    assert.ok(progressPayload, 'progress event must have been sent');
    assert.equal(progressPayload.key, 'img_test');
    assert.equal(progressPayload.pct, 42);
    assert.equal(progressPayload.runGen, 7, 'runGen must be forwarded in the progress event');
  } finally {
    Module._load = realLoad;
    delete require.cache[ipcPath];
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('R6.6.6.B: pipelineCardProgress source contains runGen stale-filter', async () => {
  // Structural test: verify the renderer-side filter is present.
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineCardProgress.js'), 'utf8');
  assert.ok(src.includes('data.runGen'), 'must check data.runGen');
  assert.ok(src.includes('item._runGen'), 'must check item._runGen');
  assert.ok(src.includes('data.runGen !== item._runGen'), 'must compare runGen values for stale filtering');
});

test('R6.6.6.C: pipelineOps source increments _runGen and passes it to IPC', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineOps.js'), 'utf8');
  assert.ok(src.includes('item._runGen = (item._runGen || 0) + 1'), 'must increment _runGen on each run');
  assert.ok(src.includes('runGen: item._runGen'), 'must pass runGen to the IPC call');
});
