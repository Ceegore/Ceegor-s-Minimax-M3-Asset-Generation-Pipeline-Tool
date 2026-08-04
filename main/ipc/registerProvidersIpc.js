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
const providersStore = require('../../src/providersStore');
// V104-H004: strict payload schema for providers:set (full replacements
// must never wipe the store or orphan credential blobs).
const { validateProvidersSetPayload } = require('../../src/providersPayloadSchema');
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
// H-001/H-002/H-003 (hhhhu2 audit): DNS-pinned HTTP, unified finalizer, transaction journal.
const SafeHttpClient = require('../services/SafeHttpClient');
const { finalize } = require('../services/ArtifactFinalizer');
const { OutputTransactionService } = require('../services/OutputTransactionService');
const { app } = require('electron');

const ADAPTERS = { openrouter: openaiCompat, 'custom-openai': openaiCompat, replicate };
const inflight = new Map();   // jobId -> AbortController (for cancel)

// H-016 (_5 audit): per-job output budget (file count + total bytes).
const MAX_OUTPUT_FILES = 10;

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

// hhhhu2 audit H-001/H-002: the legacy downloadToFile + validateMagicBytes
// helpers were replaced by ArtifactFinalizer + SafeHttpClient (see the
// providers:generate handler below); they were removed to keep this module
// within the 500-line hard limit.

// RQ-006 fix: a provider whose persisted credential blob is missing or
// unreadable must fail FAST with an actionable repair message instead of
// reaching the adapter with no usable key. Returns an error string when
// the stored key is corrupt, else null.
function corruptKeyError(providerId) {
  const repo = providersStore._getCredentialRepo();
  if (!repo || typeof repo.getPublic !== 'function') return null;
  let pub = null;
  try { pub = (repo.getPublic() || []).find((x) => x.id === providerId); } catch (_) { return null; }
  if (pub && pub.credentialState === 'corrupt') {
    return `Provider "${providerId}": the stored API key is corrupt or unreadable. Open Provider Settings and re-enter the key to repair it.`;
  }
  return null;
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
      // H-010 (hhhhu3 audit): key presence/state comes from the credential
      // repository (persisted blob or in-memory session map), NEVER from a
      // raw apiKey field — the public status and the live resolver must
      // agree. The repository is constructed on the SAME providers.json the
      // live store uses (B-005), so both views hit one file.
      const credRepo = providersStore._getCredentialRepo();
      let stateById = null;
      if (credRepo && typeof credRepo.getPublic === 'function') {
        try {
          stateById = new Map(credRepo.getPublic().map((pub) => [pub.id, pub]));
        } catch (_) { stateById = null; }
      }
      const providers = (d.providers || []).map((p) => {
        const pub = stateById && stateById.get(p.id);
        const hasKey = pub ? !!pub.hasKey : !!(p.apiKey && p.apiKey.length > 0);
        return {
          id: p.id,
          label: p.label,
          kind: p.kind,
          baseUrl: p.baseUrl || '',
          hasKey,
          credentialState: pub ? pub.credentialState : ((p.apiKey && p.apiKey.length > 0) ? 'legacy-plaintext' : 'none'),
          // Only the no-repo legacy path can show a tail; encrypted keys
          // never expose even 4 chars through this DTO.
          apiKeyLast4: (!pub && p.apiKey && p.apiKey.length >= 4) ? p.apiKey.slice(-4) : '',
        };
      });
      return { ok: true, providers, selections: d.selections || {} };
    } catch (_) {
      return { ok: true, providers: [], selections: {} };
    }
  });

  secureHandle('providers:set', { getMainWindow }, async (_e, data) => {
    try {
      // V104-H004: STRICT top-level schema BEFORE anything else. A
      // malformed full replacement is rejected atomically — no store
      // write and no key operation happens, so an empty/duplicate-id/
      // builtin-dropping payload can neither wipe providers.json nor
      // orphan encrypted credential blobs.
      const schema = validateProvidersSetPayload(data);
      if (!schema.ok) return { ok: false, error: schema.error };
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
      // P1-D (C-008, H-020): SSRF-validate every provider base URL.
      // V104-H004: structural per-entry checks (id/kind/baseUrl types)
      // moved into src/providersPayloadSchema.js (see the schema gate above).
      for (const p of data.providers) {
        if (p.baseUrl && p.baseUrl.length > 0) {
          // H-018 (_5 audit): async DNS-validating variant catches a
          // hostname that resolves to a private IP at set-time.
          const urlCheck = await validateProviderUrlWithDns(p.baseUrl, { allowHttp: !app.isPackaged });
          if (!urlCheck.ok) {
            return { ok: false, error: `Provider "${p.label || p.id}": ${urlCheck.error}` };
          }
        }
      }
      // B-006 (hhhhu3 audit): provider key changes are TYPED ACTIONS routed
      // exclusively through the encrypted ProviderCredentialRepository. Raw
      // key fields never reach the metadata store: they are lifted out of
      // the payload here, the metadata is written key-free, and the key
      // operations are applied afterwards (the providers must exist in the
      // store before replacePersisted can bind a blob to them).
      //
      // Action resolution: an explicit `keyAction` wins; otherwise a
      // non-empty apiKey means 'replace' and an absent/empty one means
      // 'keep' (the renderer's "empty input = keep existing" contract).
      const credRepo = providersStore._getCredentialRepo();
      const keyOps = [];
      if (data && Array.isArray(data.providers)) {
        for (const p of data.providers) {
          const rawKey = (typeof p.apiKey === 'string') ? p.apiKey.trim() : '';
          let action = (typeof p.keyAction === 'string') ? p.keyAction : '';
          if (action && action !== 'keep' && action !== 'replace' && action !== 'session' && action !== 'clear') {
            return { ok: false, error: `Provider "${p.id}": keyAction must be 'keep', 'replace', 'session' or 'clear'.` };
          }
          if (!action) action = rawKey ? 'replace' : 'keep';
          if ((action === 'replace' || action === 'session') && !rawKey) {
            return { ok: false, error: `Provider "${p.id}": keyAction '${action}' requires a non-empty apiKey.` };
          }
          if (action !== 'keep') keyOps.push({ id: p.id, action, value: rawKey });
          delete p.keyAction;
          delete p.apiKey;      // raw keys never reach the metadata store
          delete p._sessionKey;
          // RQ-007 hardening: DTO status fields round-tripped from
          // providers:getPublic must never be persisted to providers.json.
          delete p.hasKey;
          delete p.credentialState;
          delete p.apiKeyLast4;
        }
      }
      const keyWarnings = [];
      if (credRepo) {
        providersStore.write(data); // metadata only — no key material
        for (const op of keyOps) {
          try {
            if (op.action === 'replace') credRepo.replacePersisted(op.id, op.value);
            else if (op.action === 'session') credRepo.useSessionOnly(op.id, op.value);
            else if (op.action === 'clear') credRepo.clear(op.id);
          } catch (opErr) {
            // Metadata is committed; report the key failure via the typed
            // outcome below so the renderer can surface it and stay open
            // for repair (RQ-007), without retrying the whole save.
            keyWarnings.push(`Provider "${op.id}": key ${op.action} failed (${(opErr && opErr.message) || opErr})`);
          }
        }
      } else {
        // No encrypted repository registered (tests / dev without Main
        // boot): keep the legacy plaintext flow functional.
        for (const op of keyOps) {
          if (op.action === 'clear') continue;
          const entry = (data.providers || []).find((x) => x.id === op.id);
          if (entry) entry.apiKey = op.value;
        }
        providersStore.write(data);
      }
      // RQ-007 fix: TYPED outcome (committed/partial/failed). The old
      // ok=true+warnings shape let the renderer show false success after a
      // partial credential update. ok stays true (metadata IS saved) but
      // the renderer must surface unresolved key failures and stay open.
      if (keyWarnings.length) {
        const status = (keyWarnings.length >= keyOps.length) ? 'failed' : 'partial';
        return { ok: true, status, warnings: keyWarnings, error: keyWarnings.join('; ') };
      }
      return { ok: true, status: 'committed' };
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
      const corruptErr = corruptKeyError(providerId); // RQ-006
      if (corruptErr) return { ok: false, error: corruptErr };
      const p = providersStore.provider(providerId);
      const a = ADAPTERS[p.kind];
      if (!a || !a.listModels) return { ok: true, models: [] };
      const gateSlot = cloudJobGate.acquire(p.baseUrl || providerId, { metadata: true });
      if (!gateSlot.ok) return { ok: false, error: gateSlot.error };
      try {
        // H-001 (hhhhu3 audit): model listing goes through SafeHttpClient
        // (DNS pinning, caps) like every other provider request.
        return { ok: true, models: await a.listModels({ baseUrl: p.baseUrl, apiKey: p.apiKey, http: SafeHttpClient }) };
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
    // RQ-006: never spend money on a paid call for a corrupt stored key.
    const corruptErr = corruptKeyError(req.providerId);
    if (corruptErr) return { ok: false, error: corruptErr };
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

      // H-002 (hhhhu3 audit): canonicalize and AUTHORIZE the output root
      // BEFORE any mkdir, probe, transaction, or paid request. Previously
      // writeProbe() created directories/files at the requested path with no
      // grant check — a compromised renderer could mutate arbitrary
      // OS-writable paths without a valid path grant.
      const resolvedOut = path.resolve(req.outDir);
      const rootAuth = authorizePath(req.grantId, 'write', path.join(resolvedOut, 'probe'));
      if (!rootAuth.ok) return { ok: false, error: 'grant: ' + rootAuth.error };

      // H-016: write-probe BEFORE the paid API call — fail fast if outDir is unwritable.
      const probe = writeProbe(resolvedOut);
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
        // H-001 (hhhhu3 audit): inject the DNS-pinned HTTP client so the
        // adapter's listing/submission/polling never touches global fetch.
        http: SafeHttpClient,
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

      // H-001/H-002/H-003 (hhhhu2 audit): Route ALL provider outputs through
      // ArtifactFinalizer (strict base64, type-from-bytes, semantic validation)
      // and OutputTransactionService (journaled crash-consistent promotion).
      // SafeHttpClient provides DNS-pinned downloads for URL-based outputs.
      const finalizerModality = (req.modality === 'speech' || req.modality === 'music') ? 'audio' : req.modality;
      // H-002 (hhhhu3 audit): resolvedOut + grant authorization already
      // happened above, BEFORE the probe and the paid call.

      // Begin a journaled transaction.
      const journalDir = path.join(app.getPath('userData'), 'output-transactions');
      const txnService = new OutputTransactionService({ journalDir });
      const { transactionId, stageDir } = txnService.begin({ canonicalRoot: resolvedOut, leaseId: req.jobId || null });

      const files = [];
      try {
        for (let i = 0; i < outputs.length; i++) {
          const o = outputs[i];
          // Build the source descriptor for ArtifactFinalizer.
          let descriptor;
          if (o.b64) {
            // H-003: strict base64 decoding is handled inside finalize().
            descriptor = { data: o.b64 };
          } else {
            // H-001: URL downloads go through SafeHttpClient (DNS-pinned).
            const urlCheck = validateOutputUrl(o.url);
            if (!urlCheck.ok) return { ok: false, error: 'Output URL blocked: ' + urlCheck.error };
            descriptor = { url: o.url };
            // Attach auth headers if the output requires bearer auth.
            if (o.authPolicy === 'bearer' && p.apiKey) {
              const trusted = Array.isArray(o.trustedOrigins) ? o.trustedOrigins : [];
              let urlOrigin = '';
              try { urlOrigin = new URL(o.url).origin; } catch (_) {}
              if (trusted.includes(urlOrigin)) {
                descriptor.headers = { authorization: 'Bearer ' + p.apiKey };
              }
            }
          }

          // H-002: finalize through the unified validator.
          const result = await finalize(descriptor, {
            modality: finalizerModality,
            stageDirectory: stageDir,
            signal: ctrl.signal,
            http: SafeHttpClient,
          });

          // Determine the final filename.
          const finalName = req.modality + '_' + randomUUID() + (outputs.length > 1 ? '_' + (i + 1) : '') + '.' + result.extension;
          const finalPath = path.join(resolvedOut, finalName);

          // Register with the transaction journal.
          txnService.addFile(transactionId, {
            stagedPath: result.stagedPath,
            finalPath,
            bytes: result.bytes,
            sha256: result.sha256,
          });
          files.push(finalPath);
        }

        // H-002: commit through the transaction service (verify hashes, journal,
        // install, verify installed, mark committed, clean stage).
        txnService.commit(transactionId);
      } catch (e) {
        // Rollback: cancel the transaction (removes stage + journal).
        try { txnService.cancel(transactionId); } catch (_) {}
        throw e;
      }
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
