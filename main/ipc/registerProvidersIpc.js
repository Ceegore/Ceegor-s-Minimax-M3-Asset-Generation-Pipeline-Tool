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
const { validateProviderUrl, validateOutputUrl, validateProviderUrlWithDns } = require('../../src/providers/urlPolicy');
// P1-A (360° Audit H-001): secure IPC wrapper with sender/frame/origin validation.
const { secureHandle } = require('./secureHandle');
// P2-C (360° Audit H-014, H-015): cloud job concurrency & rate limiting.
const cloudJobGate = require('../services/CloudJobGate');
// H-046 (_5 audit): Main-side authoritative batch_max_units cost cap.
const { checkProviderUnits } = require('../services/batchUnitsGate');
// H-027 (_5 audit): extended grant TTL for long-running provider jobs.
const { defaultService: pathGrantService, PROVIDER_JOB_TTL_MS } = require('../services/PathGrantService');
// H-012 (_5 audit): persistent remote job ledger for resume after restart/timeout.
const remoteJobLedger = require('../../src/services/remoteJobLedger');

const ADAPTERS = { openrouter: openaiCompat, 'custom-openai': openaiCompat, replicate };
const inflight = new Map();   // jobId -> AbortController (for cancel)

// Hard cap for provider output downloads. Streams to disk (never buffers the
// whole body in main-process memory) and aborts past this size so a runaway or
// huge URL cannot OOM the main process.
const MAX_PROVIDER_DOWNLOAD = 512 * 1024 * 1024; // 512 MB (video outputs can be large)
// H-014/H-018 (_5 audit): max redirect hops for output downloads.
const MAX_REDIRECTS = 5;
// H-016 (_5 audit): per-job output budget (file count + total bytes).
const MAX_OUTPUT_FILES = 10;
const MAX_TOTAL_OUTPUT_BYTES = 1024 * 1024 * 1024; // 1 GB aggregate

// H-016: magic byte signatures for output validation.
const MAGIC = {
  jpg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  png: [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
  gif: [Buffer.from('GIF87a'), Buffer.from('GIF89a')],
  webp: [Buffer.from('RIFF')],
  mp4: [Buffer.from('ftyp', 'ascii')], // offset 4
  mp3: [Buffer.from('ID3'), Buffer.from([0xFF, 0xFB]), Buffer.from([0xFF, 0xF3])],
};

/**
 * H-016: validate that a file's leading bytes match the expected format.
 * @param {string} filePath
 * @param {string} ext - e.g. 'png', 'jpg', 'mp4'
 * @returns {{ ok: boolean, error?: string }}
 */
function validateMagicBytes(filePath, ext) {
  const sigs = MAGIC[ext];
  if (!sigs) return { ok: true }; // unknown ext — skip validation
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, buf, 0, 12, 0);
    if (bytesRead < 4) return { ok: false, error: 'file too small (' + bytesRead + ' bytes)' };
    if (ext === 'mp4') {
      // ftyp box: bytes 4-7 are 'ftyp'
      if (buf.slice(4, 8).equals(sigs[0])) return { ok: true };
      return { ok: false, error: 'mp4 magic mismatch' };
    }
    for (const sig of sigs) {
      if (buf.slice(0, sig.length).equals(sig)) return { ok: true };
    }
    return { ok: false, error: ext + ' magic mismatch' };
  } catch (e) {
    return { ok: false, error: 'read failed: ' + (e.message || e) };
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  }
}

/**
 * H-016: write-probe — verify the output directory is actually writable
 * BEFORE spending money on a paid API call.
 * @param {string} dir
 * @returns {{ ok: boolean, error?: string }}
 */
function writeProbe(dir) {
  const probe = path.join(dir, '.write-probe-' + Date.now().toString(36));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'output dir not writable: ' + (e.message || e) };
  }
}

/**
 * Download a provider output URL to a local file.
 * H-014: supports authPolicy — attaches Authorization only when the URL's
 * origin is in the output's trustedOrigins list.
 * H-018: uses redirect:'manual' and validates each hop against SSRF policy.
 *
 * @param {string} url - The output URL to download.
 * @param {string} dest - Local file path to write.
 * @param {AbortSignal} signal - Caller abort signal.
 * @param {{ authPolicy?: string, apiKey?: string, trustedOrigins?: string[] }} [authOpts]
 */
async function downloadToFile(url, dest, signal, authOpts) {
  const { validateOutputUrlWithDns } = require('../../src/providers/urlPolicy');
  let currentUrl = url;
  let response = null;
  let hops = 0;
  // Determine the initial origin for auth attachment.
  let currentOrigin = '';
  try { currentOrigin = new URL(currentUrl).origin; } catch (_) {}

  for (;;) {
    // H-018: validate every URL (initial + redirects) against SSRF policy
    // with async DNS resolution (detects rebinding to private IPs).
    const urlCheck = await validateOutputUrlWithDns(currentUrl);
    if (!urlCheck.ok) throw new Error('download blocked: ' + urlCheck.error);

    // H-014: attach Authorization ONLY when authPolicy is 'bearer' and the
    // current URL's origin is in the trusted list. Strip on origin change.
    const headers = {};
    if (authOpts && authOpts.authPolicy === 'bearer' && authOpts.apiKey) {
      const trusted = Array.isArray(authOpts.trustedOrigins) ? authOpts.trustedOrigins : [];
      if (trusted.includes(currentOrigin)) {
        headers['Authorization'] = 'Bearer ' + authOpts.apiKey;
      }
    }

    const res = await fetch(currentUrl, { signal, redirect: 'manual', headers });

    // H-018: handle redirects manually with re-validation.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error('download redirect with no Location header');
      // Resolve relative redirects.
      currentUrl = new URL(location, currentUrl).href;
      let newOrigin = '';
      try { newOrigin = new URL(currentUrl).origin; } catch (_) {}
      // If origin changed, update currentOrigin (auth will be stripped unless
      // the new origin is also trusted).
      currentOrigin = newOrigin;
      hops++;
      if (hops > MAX_REDIRECTS) throw new Error('download exceeded ' + MAX_REDIRECTS + ' redirects');
      continue; // re-validate the new URL at the top of the loop
    }

    response = res;
    break;
  }

  if (!response.ok) throw new Error('download HTTP ' + response.status);
  if (!response.body) throw new Error('download returned no body');
  const declared = Number(response.headers.get('content-length') || 0);
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
    await pipeline(Readable.fromWeb(response.body), counter, ws);
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

  secureHandle('providers:set', { getMainWindow }, async (_e, data) => {
    try {
      // B-004: built-in provider origins are immutable — reject any attempt
      // to change the baseUrl or kind of openrouter/replicate outright (the
      // store additionally re-pins them at read/write time as defense in
      // depth). Without this a compromised renderer could redirect Bearer
      // API keys to an attacker origin with a single providers:set call.
      if (data && Array.isArray(data.providers)) {
        for (const p of data.providers) {
          const pin = p && p.id && providersStore.BUILTIN_ORIGINS[p.id];
          if (!pin) continue;
          if ((p.baseUrl || '') !== pin.baseUrl || (p.kind && p.kind !== pin.kind)) {
            return { ok: false, error: `Provider "${p.id}" is built-in; its base URL and kind cannot be changed.` };
          }
        }
      }
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
            // H-018 (_5 audit): use the ASYNC DNS-validating variant so a
            // hostname that resolves to a private IP is caught at set-time.
            const urlCheck = await validateProviderUrlWithDns(p.baseUrl, { allowHttp: !require('electron').app.isPackaged });
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

  // H-023 (_5 audit): explicit API key deletion. The empty-field-means-keep
  // convention in providers:set prevents accidental loss, but users need a
  // deliberate way to remove a stored key (account change, compromised key,
  // shared machine). This handler is the only path that truly clears a key.
  secureHandle('providers:clearKey', { getMainWindow }, (_e, { providerId }) => {
    try {
      if (!providerId || typeof providerId !== 'string') {
        return { ok: false, error: 'providerId is required.' };
      }
      return providersStore.clearApiKey(providerId);
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // ---- Model discovery ----
  // MED-005: gate model listing through CloudJobGate so a compromised
  // renderer cannot flood the provider's /models endpoint.
  secureHandle('providers:listModels', { getMainWindow }, async (_e, { providerId }) => {
    try {
      const p = providersStore.provider(providerId);
      const a = ADAPTERS[p.kind];
      if (!a || !a.listModels) return { ok: true, models: [] };
      const gateSlot = cloudJobGate.acquire(p.baseUrl || providerId, { metadata: true });
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
    // Bug fix: validate outDir BEFORE the paid API call. Without this, a
    // missing/empty outDir passes the conditional writeProbe (line below),
    // the expensive provider call executes, and path.join(req.outDir, ...)
    // throws a TypeError in the saving stage — money spent, no output.
    if (!req.outDir || typeof req.outDir !== 'string' || !req.outDir.trim()) {
      return { ok: false, error: 'providers:generate requires a valid outDir.' };
    }
    // H-046: authoritative cost cap — checked BEFORE the gate slot / API call
    // so an over-cap request never spends money, even from a manipulated
    // renderer (the renderer's aggregate estimate gate is UX only).
    const unitsErr = checkProviderUnits(req.params);
    if (unitsErr) return { ok: false, error: unitsErr };
    // P2-C (H-014, H-015): acquire cloud job gate slot before API call.
    // MED-040: pass baseUrl for origin-based rate limiting.
    const provider = providersStore.provider(req.providerId);
    const gateSlot = cloudJobGate.acquire((provider && provider.baseUrl) || req.providerId || 'unknown');
    if (!gateSlot.ok) return { ok: false, error: gateSlot.error };
    // H-027 (_5 audit): extend the write grant's TTL to cover the full
    // provider job lifecycle (submit + poll up to 10min + download).
    // Without this, a grant minted at job start can expire between a
    // successful paid generation and the local file save.
    if (req.grantId) {
      pathGrantService.extendGrant(req.grantId, Date.now() + PROVIDER_JOB_TTL_MS);
    }
    const ctrl = new AbortController();
    // H-017 (_5 audit): reject duplicate in-flight jobIds. If the same
    // jobId is submitted twice, inflight.set would overwrite the first
    // controller — making the first job uncancelable and the second
    // job's finally-delete would remove the wrong entry.
    if (req.jobId && inflight.has(req.jobId)) {
      cloudJobGate.release(gateSlot.id);
      return { ok: false, error: 'Job ' + req.jobId + ' is already in-flight. Cancel it first or use a new jobId.' };
    }
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

      // H-016: write-probe BEFORE the paid API call — fail fast if outDir is unwritable.
      const probe = writeProbe(req.outDir);
      if (!probe.ok) return { ok: false, error: probe.error };

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
        // H-012: persist remote job identity for resume after restart/timeout.
        onSubmitted: (info) => {
          if (req.modality === 'video' && req.jobId) {
            remoteJobLedger.add({ localJobId: req.jobId, providerId: req.providerId, remoteJobId: info.remoteJobId, pollUrl: info.pollUrl, model: req.model, modality: req.modality, outDir: req.outDir || '' });
          }
        },
      });

      send({ stage: 'saving' });
      // QA-014 fix: reject empty output set instead of reporting success.
      if (!outputs || outputs.length === 0) {
        return { ok: false, error: 'Provider returned no output files.' };
      }
      // H-016: enforce per-job file count budget.
      if (outputs.length > MAX_OUTPUT_FILES) {
        return { ok: false, error: 'Too many outputs (' + outputs.length + ', cap ' + MAX_OUTPUT_FILES + ').' };
      }
      // H-016: transactional save — write to temp dir, validate, then promote.
      const tmpDir = path.join(req.outDir, '.tmp-' + (req.jobId || randomUUID()));
      const files = [];
      const tmpFiles = [];
      let totalBytes = 0;
      let dirCreated = false;
      try {
        for (let i = 0; i < outputs.length; i++) {
          const o = outputs[i];
          const ext = o.ext || 'bin';
          const name = req.modality + '_' + randomUUID() + (outputs.length > 1 ? '_' + (i + 1) : '') + '.' + ext;
          const dest = path.join(req.outDir, name);
          const auth = authorizePath(req.grantId, 'write', dest);
          if (!auth.ok) return { ok: false, error: 'grant: ' + auth.error };
          if (!dirCreated) { fs.mkdirSync(tmpDir, { recursive: true }); dirCreated = true; }
          const tmpPath = path.join(tmpDir, name);
          if (o.b64) {
            const buf = Buffer.from(o.b64, 'base64');
            totalBytes += buf.length;
            if (totalBytes > MAX_TOTAL_OUTPUT_BYTES) throw new Error('total output exceeds ' + MAX_TOTAL_OUTPUT_BYTES + ' bytes');
            fs.writeFileSync(tmpPath, buf);
          } else {
            const urlCheck = validateOutputUrl(o.url);
            if (!urlCheck.ok) return { ok: false, error: 'Output URL blocked: ' + urlCheck.error };
            await downloadToFile(o.url, tmpPath, ctrl.signal, {
              authPolicy: o.authPolicy || 'none',
              apiKey: p.apiKey,
              trustedOrigins: o.trustedOrigins || [],
            });
            totalBytes += fs.statSync(tmpPath).size;
            if (totalBytes > MAX_TOTAL_OUTPUT_BYTES) throw new Error('total output exceeds ' + MAX_TOTAL_OUTPUT_BYTES + ' bytes');
          }
          // H-016: validate magic bytes for downloaded files (b64 is pre-validated by adapter).
          if (!o.b64) {
            const magic = validateMagicBytes(tmpPath, ext);
            if (!magic.ok) throw new Error('output ' + (i + 1) + ' failed validation: ' + magic.error);
          }
          tmpFiles.push({ tmpPath, dest });
          files.push(dest);
        }
        // H-016: atomic promotion — all outputs validated, rename to final paths.
        for (const { tmpPath, dest } of tmpFiles) {
          fs.renameSync(tmpPath, dest);
        }
      } catch (e) {
        // H-016: rollback — clean up temp files on any failure.
        for (const { tmpPath } of tmpFiles) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        throw e;
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      send({ stage: 'done' });
      // H-012: mark ledger entry completed.
      if (req.jobId) remoteJobLedger.update(req.jobId, { status: 'completed', resultUrls: files });
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
      // H-012: mark ledger entry failed/cancelled.
      if (req.jobId) remoteJobLedger.update(req.jobId, { status: ctrl.signal.aborted ? 'cancelled' : 'failed', error: raw.slice(0, 200) });
      return { ok: false, error: redacted, canceled: ctrl.signal.aborted };
    } finally {
      // H-017 (_5 audit): identity-based cleanup — only delete OUR controller.
      if (req.jobId && inflight.get(req.jobId) === ctrl) inflight.delete(req.jobId);
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

  // ---- H-012: Pending remote jobs (for resume on restart) ----
  secureHandle('providers:pendingJobs', { getMainWindow }, () => {
    return { ok: true, jobs: remoteJobLedger.getPending() };
  });
}

module.exports = { register };
