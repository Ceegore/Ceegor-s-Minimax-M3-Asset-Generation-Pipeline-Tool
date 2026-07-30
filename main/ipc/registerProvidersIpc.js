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
const { randomUUID } = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const providersStore = require('../../src/providersStore');
const openaiCompat = require('../../src/providers/openaiCompatible');
const replicate = require('../../src/providers/replicate');
// Reuse (call-only) the SAME grant authorizer the tested mmx write path uses.
const { authorizePath } = require('./grantAuthorizer');
// P0-A (360° Audit C-008): feature-flag gate for custom provider URLs.
const { customProviderUrlsEnabled } = require('../services/FeatureFlags');
// P1-D (360° Audit C-008, H-020): SSRF protection for provider base URLs.
const { validateProviderUrl, validateOutputUrl } = require('../../src/providers/urlPolicy');
// P1-A (360° Audit H-001): secure IPC wrapper with sender/frame/origin validation.
const { secureHandle } = require('./secureHandle');
// P2-C (360° Audit H-014, H-015): cloud job concurrency & rate limiting.
const cloudJobGate = require('../services/CloudJobGate');

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
  // SEC-002: `providers:get` REMOVED. The raw provider config (including
  // apiKey values) no longer crosses the IPC boundary. The renderer uses
  // `providers:getPublic` which returns a secret-free DTO.

  // P0-B (360° Audit C-002): secret-free provider DTO for the renderer.
  // Returns provider metadata with `hasKey` boolean instead of raw apiKey.
  secureHandle('providers:getPublic', { getMainWindow }, () => {
    try {
      const d = providersStore.read();
      const providers = (d.providers || []).map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        baseUrl: p.baseUrl || '',
        hasKey: !!(p.apiKey && p.apiKey.length > 0),
        apiKeyLast4: (p.apiKey && p.apiKey.length >= 4) ? p.apiKey.slice(-4) : '',
      }));
      return { ok: true, providers, selections: d.selections || {} };
    } catch (_) {
      return { ok: true, providers: [], selections: {} };
    }
  });

  secureHandle('providers:set', { getMainWindow }, (_e, data) => {
    try {
      // P0-A (C-008): block custom baseUrl changes in production.
      if (!customProviderUrlsEnabled() && data && Array.isArray(data.providers)) {
        const defaults = providersStore._default();
        for (const p of data.providers) {
          if (p.kind === 'custom-openai' && p.baseUrl) {
            const existing = (defaults.providers || []).find((d) => d.id === p.id);
            if (!existing || p.baseUrl !== existing.baseUrl) {
              return { ok: false, error: 'Custom provider base-URL changes are disabled in production builds for security (audit C-008). Use a development build to enable.' };
            }
          }
        }
      }
      // P1-D (C-008, H-020): validate ALL provider base URLs for SSRF safety.
      // Even in dev mode, block localhost/private IPs to prevent accidental SSRF.
      // MED-041: basic schema validation for each provider entry.
      if (data && Array.isArray(data.providers)) {
        for (const p of data.providers) {
          // MED-041: reject entries without a string id or with unknown fields
          // that could confuse the store.
          if (!p.id || typeof p.id !== 'string') {
            return { ok: false, error: 'Each provider must have a string "id" field.' };
          }
          if (p.kind && typeof p.kind !== 'string') {
            return { ok: false, error: `Provider "${p.id}": "kind" must be a string.` };
          }
          if (p.baseUrl && typeof p.baseUrl !== 'string') {
            return { ok: false, error: `Provider "${p.id}": "baseUrl" must be a string.` };
          }
          if (p.baseUrl && typeof p.baseUrl === 'string' && p.baseUrl.length > 0) {
            const urlCheck = validateProviderUrl(p.baseUrl, { allowHttp: !require('electron').app.isPackaged });
            if (!urlCheck.ok) {
              return { ok: false, error: `Provider "${p.label || p.id}": ${urlCheck.error}` };
            }
          }
        }
      }
      providersStore.write(data);
      return { ok: true };
    }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // ---- Model discovery ----
  // MED-005: gate model listing through CloudJobGate so a compromised
  // renderer cannot flood the provider's /models endpoint.
  secureHandle('providers:listModels', { getMainWindow }, async (_e, { providerId }) => {
    try {
      const p = providersStore.provider(providerId);
      const a = ADAPTERS[p.kind];
      if (!a || !a.listModels) return { ok: true, models: [] };
      const gateSlot = cloudJobGate.acquire(p.baseUrl || providerId);
      if (!gateSlot.ok) return { ok: false, error: gateSlot.error };
      try {
        return { ok: true, models: await a.listModels({ baseUrl: p.baseUrl, apiKey: p.apiKey }) };
      } finally {
        cloudJobGate.release(gateSlot.id);
      }
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // ---- Generate ----
  // Payload: {jobId, modality, providerId, model, prompt, input, params, outDir, grantId}
  secureHandle('providers:generate', { getMainWindow, maxPayloadBytes: 4 * 1024 * 1024 }, async (_e, req) => {
    // Guard BEFORE any req.* access: a null/malformed payload must return a
    // clean envelope instead of throwing outside the try/catch below (which
    // would surface as an unstructured rejection in the renderer).
    if (!req || typeof req !== 'object') {
      return { ok: false, error: 'providers:generate requires a request object.' };
    }
    // P2-C (H-014, H-015): acquire cloud job gate slot before API call.
    // MED-040: pass baseUrl for origin-based rate limiting.
    const provider = providersStore.provider(req.providerId);
    const gateSlot = cloudJobGate.acquire((provider && provider.baseUrl) || req.providerId || 'unknown');
    if (!gateSlot.ok) return { ok: false, error: gateSlot.error };
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
        // P5 (M-022): UUID-based filenames prevent collision races
        // (Date.now() can collide on parallel n>1 outputs).
        const name = req.modality + '_' + randomUUID() + (outputs.length > 1 ? '_' + (i + 1) : '') + '.' + (o.ext || 'bin');
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
          // SEC-006: validate output URL before download (SSRF protection).
          const urlCheck = validateOutputUrl(o.url);
          if (!urlCheck.ok) {
            return { ok: false, error: 'Output URL blocked: ' + urlCheck.error };
          }
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
      // P5 (M-037): redact provider error bodies before sending to the
      // renderer. Raw HTTP response bodies may contain internal server
      // details, stack traces, or partial credentials in URLs.
      const raw = String(e.message || e);
      const redacted = raw
        .replace(/sk-[a-zA-Z0-9_-]{8,}/g, 'sk-[REDACTED]')
        .replace(/Bearer\s+[a-zA-Z0-9._-]{8,}/gi, 'Bearer [REDACTED]')
        .replace(/https?:\/\/[^\s"']+@/g, 'https://[REDACTED]@')
        .slice(0, 500);
      return { ok: false, error: redacted, canceled: ctrl.signal.aborted };
    } finally {
      if (req.jobId) inflight.delete(req.jobId);
      cloudJobGate.release(gateSlot.id);
    }
  });

  // ---- Cancel ----
  // MED-008: null safety — a missing/invalid jobId is a no-op, not a crash.
  secureHandle('providers:cancel', { getMainWindow }, (_e, payload) => {
    const jobId = payload && payload.jobId;
    if (!jobId || typeof jobId !== 'string') return { ok: true, skipped: 'no-jobId' };
    const c = inflight.get(jobId);
    if (c) c.abort();
    return { ok: true };
  });
}

module.exports = { register };
