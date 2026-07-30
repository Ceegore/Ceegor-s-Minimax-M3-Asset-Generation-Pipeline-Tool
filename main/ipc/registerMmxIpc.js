// main/ipc/registerMmxIpc.js
// IPC handlers: `mmx:run` / `mmx:run:job` / `mmx:voices` / `mmx:quota` /
// `mmx:profile` / `mmx:cancel` / `mmx:authStatus` / `mmx:diagnose`.
// Subcommands are validated via main/models/MmxSubcommandAllowlist.js.
//
// R1.5b.1: `mmx:run` and `mmx:run:job` now require a `grantId` for any
// path the renderer's `args` (or `payload.cwd`) would touch. The grant
// is the single source of truth for "is the renderer allowed to make
// mmx write to / spawn in this path?" — replacing the legacy
// PathSecurityService allow-list gate. The handler walks the same
// MMX_FILE_PATH_FLAGS / MMX_DIR_PATH_FLAGS sets it used to validate
// with `isPathUnderAny` / `isParentUnderAny` and authorises each
// path via grantAuthorizer.authorizePath(grantId, 'write', path) (or
// 'mkdir' for the cwd). One missing / unknown / revoked grant id
// fails the call closed (code -1, same envelope as the legacy
// "path is outside the allowed directories" error so the renderer's
// existing error surface is unchanged).

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const mmx = require('../../src/mmx');
const { runMmx, cancelAll, resolve, cancelOne, cancelByJobId } = mmx;
// R7.2: capability-based diagnose (replaces version-only probe).
const { getSnapshot: getCapabilitySnapshot } = require('../../src/mmxCapability');
// R2.4: snapshot builder extracted to keep this file under the
// frozen 384-LOC SIZE-BUDGET. The builder is the single source of
// truth for what fields the `mmx:diagnose` snapshot includes and
// for the deep-redaction contract (closes R0.1-002.D).
const { buildDiagnoseSnapshot } = require('./diagnoseSnapshot');
// SYS-003: defense-in-depth — every runMmx result is deep-redacted before
// it crosses the IPC boundary, even though src/mmx.js already redacts at the
// source. This catches any future emission path that bypasses the source fix.
const { redactRunMmxResult: _redactResult } = require('../../src/mmxResultRedactor');
const cfgMod = require('../../src/config');
const stateMod = require('../../src/state');

// R2.2: credential resolver extracted to ./resolveCredential.js so this
// file stays under its frozen 384-line SIZE-BUDGET. The helper is the
// single source of truth for the credential that `mmx:run` /
// `mmx:run:job` hands to `runMmx`; full contract in
// `main/ipc/resolveCredential.js`.
const { resolveCredential: _resolveCredential } = require('./resolveCredential');
const { ALLOWED_MMX_SUBCOMMANDS } = require('../models/MmxSubcommandAllowlist');
const voicesCache = require('../services/VoicesCacheService');
// R1.5b.1: the legacy `pathSecurity.isPathUnderAny` / `isParentUnderAny`
// gate has been replaced by grant-based authorisation
// (`grantAuthorizer.authorizePath` inside `mmxPathAuthz.js`) for the
// mutating handlers (`mmx:run` / `mmx:run:job`). The grant is the
// single source of truth for "is the renderer allowed to make mmx
// write to / spawn in this path?". `pathSecurity` is no longer
// needed in this file (the non-mutating handlers — `mmx:voices`,
// `mmx:quota`, `mmx:profile`, `mmx:authStatus`, `mmx:diagnose` —
// do not take any user-supplied paths).
//
// R1.5b.1: the path-taking flags + the args walker + the
// grant-based path authoriser live in `mmxPathAuthz.js` to keep
// this file under its frozen 384-line lint budget. The handler
// calls `collectMmxPathFlags(args)` to enumerate every path the
// args carry, then `authorizeMmxPaths(grantId, pathFlags, cwd)` to
// authorise them all against a single grant.
const {
  collectMmxPathFlags: _collectMmxPathFlags,
  authorizeMmxPaths: _authorizeMmxPaths,
} = require('./mmxPathAuthz');
const { sanitizeOrReject: _sanitizeOrReject } = require('../../src/mmxArgSanitizer'); // P0-C (360° Audit C-004): blocks --base-url/--config/--proxy + unknown flags
const { finalizeMmxArtifacts: _finalizeMmxArtifacts } = require('./mmxArtifactCheck'); // P4.1 (360° Audit DB-H-002/008): reject ok:true results whose --out/--download/-o artifact is missing/truncated/corrupt
const { secureHandle } = require('./secureHandle'); // P1-A (360° Audit H-001): sender/frame/origin-validated IPC wrapper

/**
 * @param {{ getMainWindow: () => (Electron.BrowserWindow|null), appRoot: string }} deps
 */
function register({ getMainWindow, appRoot }) {
  // Stream mmx logs to the renderer's log pane. The wire format is
  // { line, jobId, kind }; the preload bridge wraps the legacy string
  // payload so older renderer builds still work (see preload.js onLogRich).
  const sendLog = (line, jobId, kind) => {
    const win = getMainWindow();
    if (win) {
      try { win.webContents.send('mmx:log', { line, jobId: jobId || null, kind: kind || 'stderr' }); } catch (_) {}
    }
  };

  // Legacy: `mmx:run` still takes the raw args array (no jobId). Used
  // by the Diagnose / voices cache paths which don't need job tracking.
  //
  // R1.5b.1: `mmx:run` now takes a trailing `grantId` arg. The grant
  // is required IF the args contain a path flag (--out, --out-dir,
  // --download, -o). For args with no path flag, the call still
  // succeeds without a grant (e.g. `mmx quota`).
  secureHandle('mmx:run', { getMainWindow }, async (_e, args, grantId) => {
    try {
      if (!Array.isArray(args) || args.length < 1) {
        return { ok: false, code: -1, stdout: '', stderr: 'mmx: first arg (subcommand) is required', parsed: null };
      }
      if (typeof args[0] !== 'string' || !ALLOWED_MMX_SUBCOMMANDS.has(args[0])) {
        return { ok: false, code: -1, stdout: '', stderr: `mmx: subcommand '${String(args[0])}' is not allowed`, parsed: null };
      }
      const { err: sErr, safeArgs } = _sanitizeOrReject(args); // P0-C (C-004): block --base-url, --config, etc.
      if (sErr) return sErr;
      // R1.5b.1: collect the path flags from the args + authorise
      // them against the grant. If no path flag is present, the
      // grant is optional (the call doesn't touch the filesystem
      // via mmx). A missing grantId WITH path flags fails closed
      // (the renderer forgot to mint a grant for the output dir).
      const pathFlags = _collectMmxPathFlags(safeArgs);
      if (pathFlags.length > 0) {
        const grantAuthz = _authorizeMmxPaths(grantId, pathFlags);
        if (grantAuthz) {
          return { ok: false, code: -1, stdout: '', stderr: grantAuthz, parsed: null };
        }
      }
      // R2.2: resolve the credential from the payload (session-only
      // renderer-supplied key) or the persisted config (legacy
      // path). The helper returns a fail-closed envelope if the
      // session-only payload is missing the key.
      const cred = _resolveCredential(null);
      if (cred.error || !cred.apiKey) {
        return { ok: false, code: -1, stdout: '', stderr: cred.error || 'No API key configured. Open Settings and enter a key.', parsed: null };
      }
      return _redactResult(await _finalizeMmxArtifacts(await runMmx({ args: safeArgs, apiKey: cred.apiKey, sessionOnly: cred.sessionOnly, onLog: sendLog }), pathFlags));
    } catch (e) {
      return { ok: false, code: -1, stdout: '', stderr: `IPC error: ${e.message}`, parsed: null };
    }
  });

  // Multi-job-aware handler. The payload is `{ args, jobId, cwd? }`;
  // the runMmx child process attaches every emitted chunk to the jobId
  // so the renderer's LogService routes the line into the right log row.
  //
  // R1.5b.1: `mmx:run:job` now takes a trailing `grantId` arg. The
  // grant must authorise every path the args (and payload.cwd) would
  // touch. A missing grantId WITH a path/cwd fails closed (the
  // renderer forgot to mint a grant for the output dir / cwd).
  // For payload with no path flags AND no cwd, the call still
  // succeeds without a grant (e.g. `mmx quota` from a Diagnose flow).
  secureHandle('mmx:run:job', { getMainWindow }, async (_e, payload, grantId) => {
    try {
      const args = payload && payload.args;
      const jobId = payload && payload.jobId;
      const cwd = payload && payload.cwd;
      if (!Array.isArray(args) || args.length < 1) {
        return { ok: false, code: -1, stdout: '', stderr: 'mmx: first arg (subcommand) is required', parsed: null };
      }
      if (typeof args[0] !== 'string' || !ALLOWED_MMX_SUBCOMMANDS.has(args[0])) {
        return { ok: false, code: -1, stdout: '', stderr: `mmx: subcommand '${String(args[0])}' is not allowed`, parsed: null };
      }
      const { err: sErr, safeArgs } = _sanitizeOrReject(args); // P0-C (C-004): block --base-url, --config, etc.
      if (sErr) return sErr;
      // H9-003 (Phase B): fail closed when the installed mmx-cli is older than
      // the supported minimum. mmx 1.0.16 silently drops video duration/
      // resolution/optimizer + speech sound-effect while exiting 0 — the only
      // reliable guard against spending a paid request on the wrong settings is
      // to block the call up front. Non-generation subcommands (quota/voices)
      // are allowed through regardless (they don't spend generation quota).
      if (['image', 'speech', 'music', 'video'].includes(args[0])) {
        try {
          const v = mmx.probeMmxVersion();
          const min = mmx.SUPPORTED_MMX && mmx.SUPPORTED_MMX.min;
          if (v && min && mmx.compareSemver(v, min) < 0) {
            return {
              ok: false, code: -1, stdout: '',
              stderr: `mmx-cli v${v} is older than the supported v${min}. Some generation settings may be silently dropped by the CLI. Run \`npm install -g mmx-cli\` to update, then retry.`,
              parsed: null,
            };
          }
        } catch (_) { /* best-effort: a probe failure must never block a call */ }
      }
      // R1.5b.1: collect path flags + cwd, then authorise them all
      // against the single grant. A path flag OUTSIDE the grant or
      // a missing grant for a path-bearing call fails closed.
      const pathFlags = _collectMmxPathFlags(safeArgs);
      if (pathFlags.length > 0 || (typeof cwd === 'string' && cwd)) {
        const grantAuthz = _authorizeMmxPaths(grantId, pathFlags, cwd);
        if (grantAuthz) {
          return { ok: false, code: -1, stdout: '', stderr: grantAuthz, parsed: null };
        }
      }
      // R2.2: resolve the credential. The payload may carry
      // `sessionOnly: true` + `rendererApiKey: 'sk-…'` for
      // session-only mode; the helper then uses the in-memory key
      // for this call only. Without those fields, fall back to the
      // persisted config + the persisted apiKeyNoSave toggle.
      const cred = _resolveCredential(payload);
      if (cred.error || !cred.apiKey) {
        return { ok: false, code: -1, stdout: '', stderr: cred.error || 'No API key configured. Open Settings and enter a key.', parsed: null };
      }
      return _redactResult(await _finalizeMmxArtifacts(await runMmx({
        args: safeArgs,
        apiKey: cred.apiKey,
        cwd: cwd || undefined,
        sessionOnly: cred.sessionOnly,
        // Pass only `onChunk`, not `onLog` + `onChunk`. runMmx() calls
        // BOTH callbacks with the same line for every chunk; routing
        // both to the same sendLog IPC channel would emit one
        // `mmx:log` event per call, and the renderer's onLogRich would
        // append every line twice. `onChunk` is the structured callback
        // the renderer consumes; `onLog` is the legacy string-only
        // callback kept for backwards-compat (the legacy `mmx:run`
        // handler still uses it).
        onChunk: (p) => sendLog(p.line, p.jobId, p.kind),
        jobId: jobId || null,
      }), pathFlags));
    } catch (e) {
      return { ok: false, code: -1, stdout: '', stderr: `IPC error: ${e.message}`, parsed: null };
    }
  });

  secureHandle('mmx:voices', { getMainWindow }, async () => {
    try {
      const cred = _resolveCredential(null);
      if (cred.error || !cred.apiKey) return [];
      return await voicesCache.get(cred.apiKey, { sessionOnly: cred.sessionOnly });
    } catch (e) {
      return [];
    }
  });

  secureHandle('mmx:quota', { getMainWindow }, async () => {
    try {
      const cred = _resolveCredential(null);
      if (cred.error || !cred.apiKey) return { ok: false, error: cred.error || 'No API key configured.' };
      const r = await runMmx({ args: ['quota'], apiKey: cred.apiKey, sessionOnly: cred.sessionOnly, onLog: () => {} });
      if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'mmx quota failed', parsed: r.parsed };
      return { ok: true, parsed: r.parsed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // mmx:profile returns a lightweight, 5-minute-cached profile derived
  // from the quota response. The Diagnose modal uses it to show a
  // "your plan allows N concurrent calls" hint. If upstream doesn't
  // expose an explicit concurrentLimit we return
  // { ok: true, concurrentLimit: null } so the renderer can show a
  // neutral "parallel is enabled; upstream may throttle" message.
  const PROFILE_TTL_MS = 5 * 60 * 1000;
  let _profileCache = null;
  secureHandle('mmx:profile', { getMainWindow }, async () => {
    try {
      if (_profileCache && (Date.now() - _profileCache.ts) < PROFILE_TTL_MS) {
        return _profileCache.payload;
      }
      const cred = _resolveCredential(null);
      if (cred.error || !cred.apiKey) return { ok: false, error: cred.error || 'No API key configured.', concurrentLimit: null };
      const r = await runMmx({ args: ['quota'], apiKey: cred.apiKey, sessionOnly: cred.sessionOnly, onLog: () => {} });
      const payload = parseProfile(r);
      // Only cache successful responses. Caching an error envelope
      // would mean a single transient failure (network blip, auth
      // hiccup, 5xx) left the user staring at "quota failed" for 5
      // minutes with no retry. The renderer can re-trigger a fresh
      // fetch by calling mmx:profile again — we just don't
      // short-circuit on a stale error.
      if (payload && payload.ok === true) {
        _profileCache = { ts: Date.now(), payload };
      } else {
        // Invalidate any stale cache so a previously-good
        // response doesn't outlive a fresh error. (If the
        // previous fetch was OK and the next is not, the
        // renderer's "concurrent limit" hint is still better
        // than nothing for the 5 minutes, but we lean toward
        // honesty: surface the error immediately.)
        _profileCache = null;
      }
      return payload;
    } catch (e) {
      return { ok: false, error: e.message, concurrentLimit: null };
    }
  });
  function parseProfile(r) {
    const out = { ok: true, concurrentLimit: null, planType: null };
    if (!r || !r.ok) {
      out.ok = false;
      out.error = (r && (r.stderr || r.stdout)) || 'mmx quota failed';
      return out;
    }
    const p = r.parsed;
    if (!p) return out;
    // Heuristic: look for known concurrency / plan fields across the
    // possible response shapes. We do NOT invent numbers; if the
    // upstream doesn't expose them, we return null so the renderer
    // shows a neutral message.
    const obj = (typeof p === 'object' && !Array.isArray(p)) ? p : null;
    if (!obj) return out;
    const candidates = ['concurrent_limit', 'concurrentLimit', 'max_concurrency', 'maxConcurrency', 'concurrency'];
    for (const k of candidates) {
      if (typeof obj[k] === 'number' && obj[k] > 0 && obj[k] < 1000) {
        out.concurrentLimit = obj[k];
        break;
      }
    }
    const planCandidates = ['plan_type', 'planType', 'plan', 'tier'];
    for (const k of planCandidates) {
      if (typeof obj[k] === 'string' && obj[k]) {
        out.planType = obj[k];
        break;
      }
    }
    return out;
  }

  secureHandle('mmx:cancel', { getMainWindow }, (_e, opts) => {
    try {
      // `mmx:cancel` accepts either no payload (panic, kill everything)
      // or `{ jobId }` (per-job cancel). A job-scoped cancel kills only
      // that job's proc (tracked via src/mmx.js#cancelByJobId), leaving
      // sibling jobs on other tabs or parallel batch items running. An
      // unrecognized jobId (already finished, or started via the legacy
      // mmxRun with no jobId) is a harmless no-op rather than killing
      // everything.
      if (opts && opts.jobId) {
        cancelByJobId(opts.jobId);
        return { ok: true };
      }
      cancelAll();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  secureHandle('mmx:authStatus', { getMainWindow }, async () => {
    try {
      const cred = _resolveCredential(null);
      if (cred.error || !cred.apiKey) return { ok: false, error: cred.error || 'No API key configured.' };
      // The most reliable "is this key valid?" signal is a real API call.
      // We use `mmx quota --output json` and inspect the response.
      const r = await runMmx({ args: ['quota'], apiKey: cred.apiKey, sessionOnly: cred.sessionOnly, onLog: sendLog });
      if (!r.command) {
        return { ok: false, error: r.stderr || 'mmx unavailable', command: null, argv: null };
      }
      if (!r.ok) {
        let detail = r.stderr || r.stdout || `mmx exited with code ${r.code}`;
        // PowerShell on Windows wraps stderr in "node.exe :" — strip it
        detail = String(detail).replace(/^node\.exe\s*:\s*/gm, '').trim();
        return { ok: false, error: detail || `mmx exited with code ${r.code}`, command: r.command, argv: r.argv };
      }
      const parsed = r.parsed;
      if (parsed && typeof parsed === 'object' && parsed.base_resp) {
        const sc = parsed.base_resp.status_code;
        if (sc === 0) {
          return { ok: true, message: 'Authenticated. Quota snapshot loaded.', command: r.command };
        }
        return { ok: false, error: parsed.base_resp.status_msg || `API status_code ${sc}`, command: r.command };
      }
      return { ok: true, message: 'mmx quota returned a response.', command: r.command };
    } catch (e) {
      return { ok: false, error: e.message, command: null, argv: null };
    }
  });

  secureHandle('mmx:diagnose', { getMainWindow }, async () => {
    try {
      const cfg = cfgMod.read();
      const r = resolve();
      // R7.2: capability-based diagnose (replaces H9-003 version-only probe).
      let capSnap = null;
      try { capSnap = getCapabilitySnapshot(); } catch (_) { /* best-effort */ }
      const cliVersion = capSnap ? capSnap.version : null;
      const cliSupported = cliVersion && mmx.SUPPORTED_MMX && mmx.SUPPORTED_MMX.min
        ? mmx.compareSemver(cliVersion, mmx.SUPPORTED_MMX.min) >= 0 : null;
      // R2.4: snapshot builder does the deep-redact (closes R0.1-002.D).
      return buildDiagnoseSnapshot({
        cfg,
        state: stateMod.read ? stateMod.read() : {},
        mmxResolve: r,
        cliVersion,
        cliSupported,
        supportedMin: mmx.SUPPORTED_MMX && mmx.SUPPORTED_MMX.min,
        capabilitySnapshot: capSnap,
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // appRoot is unused here (logs go straight to the main window) but
  // stays in the DI contract for future log-file persistence.
  void appRoot;
}

module.exports = { register };
