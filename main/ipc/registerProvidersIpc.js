// main/ipc/registerProvidersIpc.js
// ============================================================================
// IPC handlers for the "Other APIs" tab (non-MiniMax providers).
// Fully isolated: new channels (providers:*), new config (providers.json),
// new adapters. Reuses the tested grant authorizer for write gating.
// ============================================================================
'use strict';
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const providersStore = require('../../src/providersStore');
const openaiCompat = require('../../src/providers/openaiCompatible');
const replicate = require('../../src/providers/replicate');
// Reuse (call-only) the SAME grant authorizer the tested mmx write path uses.
const { authorizePath } = require('./grantAuthorizer');

const ADAPTERS = { openrouter: openaiCompat, 'custom-openai': openaiCompat, replicate };
const inflight = new Map();   // jobId -> AbortController (for cancel)

// Hard cap for provider output downloads. Streams to disk (never buffers the
// whole body in main-process memory) and aborts past this size so a runaway or
// huge URL cannot OOM the main process.
const MAX_PROVIDER_DOWNLOAD = 512 * 1024 * 1024; // 512 MB (video outputs can be large)
async function downloadToFile(url, dest, signal) {
  const dl = await fetch(url, { signal });
  if (!dl.ok) throw new Error('download HTTP ' + dl.status);
  if (!dl.body) throw new Error('download returned no body');
  const declared = Number(dl.headers.get('content-length') || 0);
  if (declared > MAX_PROVIDER_DOWNLOAD) {
    throw new Error('download too large (' + declared + ' bytes, cap ' + MAX_PROVIDER_DOWNLOAD + ')');
  }
  let written = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length;
      if (written > MAX_PROVIDER_DOWNLOAD) { cb(new Error('download exceeded ' + MAX_PROVIDER_DOWNLOAD + ' bytes')); return; }
      cb(null, chunk);
    },
  });
  const ws = fs.createWriteStream(dest);
  try {
    await pipeline(Readable.fromWeb(dl.body), counter, ws);
  } catch (e) {
    try { fs.unlinkSync(dest); } catch (_) { /* best-effort cleanup of the partial file */ }
    throw e;
  }
}

function register({ getMainWindow }) {
  // ---- Config persistence ----
  ipcMain.handle('providers:get', () => providersStore.read());
  ipcMain.handle('providers:set', (_e, data) => {
    try { providersStore.write(data); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // ---- Model discovery ----
  ipcMain.handle('providers:listModels', async (_e, { providerId }) => {
    try {
      const p = providersStore.provider(providerId);
      const a = ADAPTERS[p.kind];
      if (!a || !a.listModels) return { ok: true, models: [] };
      return { ok: true, models: await a.listModels({ baseUrl: p.baseUrl, apiKey: p.apiKey }) };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // ---- Generate ----
  // Payload: {jobId, modality, providerId, model, prompt, input, params, outDir, grantId}
  ipcMain.handle('providers:generate', async (_e, req) => {
    // Guard BEFORE any req.* access: a null/malformed payload must return a
    // clean envelope instead of throwing outside the try/catch below (which
    // would surface as an unstructured rejection in the renderer).
    if (!req || typeof req !== 'object') {
      return { ok: false, error: 'providers:generate requires a request object.' };
    }
    const ctrl = new AbortController();
    if (req.jobId) inflight.set(req.jobId, ctrl);
    const send = (payload) => {
      const w = getMainWindow && getMainWindow();
      if (w) try { w.webContents.send('providers:progress', Object.assign({ jobId: req.jobId }, payload)); } catch (_) { /* window closed */ }
    };
    try {
      const p = providersStore.provider(req.providerId);
      const a = ADAPTERS[p.kind];
      const fn = a && a[req.modality];
      if (!fn) return { ok: false, error: 'Provider ' + req.providerId + ' does not support ' + req.modality };

      send({ stage: 'submitting' });
      const outputs = await fn({
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: req.model,
        prompt: req.prompt,
        input: req.input,
        voice: req.voice,
        format: req.format,
        params: req.params || {},
        signal: ctrl.signal,
        onProgress: (pr) => send(pr),
      });

      send({ stage: 'saving' });
      // QA-014 fix: reject empty output set instead of reporting success.
      if (!outputs || outputs.length === 0) {
        return { ok: false, error: 'Provider returned no output files.' };
      }
      const files = [];
      // QA-008 fix: do NOT mkdirSync before authorization. Create the
      // directory lazily inside the loop, only after the grant check passes.
      let dirCreated = false;
      for (let i = 0; i < outputs.length; i++) {
        const o = outputs[i];
        const name = req.modality + '_' + Date.now() + (outputs.length > 1 ? '_' + (i + 1) : '') + '.' + (o.ext || 'bin');
        const dest = path.join(req.outDir, name);
        // SAME grant gate as the mmx write path — never write outside the granted dir.
        // Authorize BEFORE downloading so a rejected grant never wastes a download.
        const auth = authorizePath(req.grantId, 'write', dest);
        if (!auth.ok) return { ok: false, error: 'grant: ' + auth.error };
        // QA-008: create outDir only after authorization succeeds.
        if (!dirCreated) { fs.mkdirSync(req.outDir, { recursive: true }); dirCreated = true; }
        if (o.b64) {
          fs.writeFileSync(dest, Buffer.from(o.b64, 'base64'));
        } else {
          // Stream to disk with a hard cap — the old Buffer.from(arrayBuffer())
          // buffered the entire body in main-process memory with no size limit.
          try {
            await downloadToFile(o.url, dest, ctrl.signal);
          } catch (e) {
            throw new Error('download for output ' + (i + 1) + ' failed: ' + ((e && e.message) || e));
          }
        }
        files.push(dest);
      }
      send({ stage: 'done' });
      return { ok: true, files };
    } catch (e) {
      return { ok: false, error: String(e.message || e), canceled: ctrl.signal.aborted };
    } finally {
      if (req.jobId) inflight.delete(req.jobId);
    }
  });

  // ---- Cancel ----
  ipcMain.handle('providers:cancel', (_e, { jobId }) => {
    const c = inflight.get(jobId);
    if (c) c.abort();
    return { ok: true };
  });
}

module.exports = { register };
