// src/mmx.js
// Thin wrapper around the `mmx` CLI. Parses --output json, streams stderr to the renderer.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
// stdout/stderr cap + truncation-marker logic lives in src/mmxStreamCaps.js
// (see that file for the rationale and the marker-emission contract).
const { MAX_STDOUT_BYTES, MAX_STDERR_BYTES, makeCappedAppender } = require('./mmxStreamCaps');
// R2.4: extracted to keep this file under the frozen 542-LOC SIZE-BUDGET.
const { stripRendererSuppliedApiKey: _stripRendererSuppliedApiKey } = require('./mmxArgSanitizer');
const { redactRunMmxResult: _redactRunMmxResult, redactStderrChunk: _redactStderrChunk, redactArgv: _redactArgv, redactCmdLine: _redactCmdLine } = require('./mmxResultRedactor');
// H11-5: node/mmx-entry resolution lives in src/mmxResolve.js (extracted so this
// file stays within its frozen size budget). The bundled mmx-cli is preferred.
const { findNodeExe, findMmxEntry, needsRunAsNode, isWindows } = require('./mmxResolve');

const AGENT_FLAGS = ['--non-interactive'];
// mmx-cli 1.0.18 notices MINIMAX_API_KEY but does not promote it to the
// non-interactive command context. This bootstrap consumes the ephemeral env
// value inside the child and injects it into process.argv only after spawn, so
// the key never appears in the operating-system process command line.
const SESSION_KEY_BOOTSTRAP = "const{pathToFileURL}=require('url');const[e,...a]=process.argv.slice(1);const k=process.env.MINIMAX_API_KEY;delete process.env.MINIMAX_API_KEY;process.argv=[process.execPath,e,...a,'--api-key',k];import(pathToFileURL(e).href)";

// Route the API key through mmx-cli's own config file instead of --api-key argv.
// On Windows, any local process can read every other process's argv via WMI,
// exposing the key for the entire call duration. mmx-cli resolves auth from
// ~/.mmx/config.json, so we sync the key into that file before each spawn and
// let mmx-cli read it directly. File exposure requires filesystem access (which
// already implies the attacker could read our config.txt), so this narrows the
// exposure surface. The sync is best-effort: a failure falls back to the
// legacy --api-key argv path so the call still works when ~/.mmx is unwritable.
// The API-key sync lives in src/mmxApiKeySync.js. It tracks the file's
// mtime+size so an external `mmx config set` is detected even when the
// in-memory hash matches. The test harness clears both the mmx.js and
// mmxApiKeySync.js module caches in withMmxMocks so the latest `fs` mock
// is picked up.
const { syncApiKeyToMmxCliConfig: _syncApiKeyToMmxCliConfig } = require('./mmxApiKeySync');

// Build a minimal env for the spawned mmx process. We deliberately do
// NOT pass `process.env` wholesale: that would leak every environment
// variable the parent shell set (AWS_*, GITHUB_TOKEN, SSH_AUTH_SOCK,
// MINIMAX_NODE_PATH and any other secrets the user has loaded) into the
// mmx child, which then forwards them to the network when it talks to
// the mmx API. The whitelist below keeps the child functional on
// Windows / macOS / Linux while making sure we don't accidentally pass
// anything that isn't strictly required to locate node + load the CLI.
function buildChildEnv() {
  const env = {};
  // PATH so node (when on POSIX) / mmx (when on Windows resolving the
  // shim) can find the executables they need.
  if (process.env.PATH) env.PATH = process.env.PATH;
  // Platform-specific home / profile so the child can find user
  // configs (npm global node_modules on Windows lives under APPDATA).
  if (process.platform === 'win32') {
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    if (process.env.APPDATA) env.APPDATA = process.env.APPDATA;
    if (process.env.LOCALAPPDATA) env.LOCALAPPDATA = process.env.LOCALAPPDATA;
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
    if (process.env.TEMP) env.TEMP = process.env.TEMP;
    if (process.env.TMP) env.TMP = process.env.TMP;
    if (process.env.HOMEDRIVE) env.HOMEDRIVE = process.env.HOMEDRIVE;
    if (process.env.HOMEPATH) env.HOMEPATH = process.env.HOMEPATH;
    // PATHEXT so .cmd / .bat lookups work
    if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
  } else {
    if (process.env.HOME) env.HOME = process.env.HOME;
    if (process.env.USER) env.USER = process.env.USER;
    if (process.env.LANG) env.LANG = process.env.LANG;
    if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  }
  // Allow the user to opt-in to a custom node path (used by the
  // findNodeExe resolver) — but only that one explicit variable, not
  // every MINIMAX_* var.
  if (process.env.MINIMAX_NODE_PATH) env.MINIMAX_NODE_PATH = process.env.MINIMAX_NODE_PATH;
  // Node-specific: tell node where to find the mmx-cli module.
  if (process.env.NODE_PATH) env.NODE_PATH = process.env.NODE_PATH;
  // Explicit network-only opt-ins. Proxy settings are required for users
  // whose browser works through a corporate/system proxy while Node does not.
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

// Cache the resolved mmx.mjs path + the node executable to use.
let resolved = null;

// H11-5: findNodeExe / findMmxEntry / isWindows / needsRunAsNode are imported
// from src/mmxResolve.js (extracted so this file stays within its frozen size
// budget). The bundled mmx-cli is preferred; Electron's own node is preferred.

// H9-003: probe the installed mmx-cli version so the app can warn (and, in a
// later step, block) when the installed runtime is known to silently drop
// settings. mmx 1.0.16 silently drops video duration/resolution/optimizer +
// speech sound-effect while exiting 0 — there is no other way to detect that
// class of bug. Cached after the first call.
//
// `mmx --version` is a top-level flag (not a subcommand), so it bypasses the
// subcommand allowlist gate. We run it via the resolved node + entry directly.
let _probedVersion = undefined; // undefined=not-probed, null=probe-failed, string=version
function probeMmxVersion() {
  if (_probedVersion !== undefined) return _probedVersion;
  try {
    const node = findNodeExe();
    const entry = findMmxEntry();
    if (!node || !entry) { _probedVersion = null; return null; }
    // 6s cap: a hung probe must never block the UI. windowsHide so no console
    // window flashes on Windows.
    // H11-5: when node is Electron's process.execPath, set ELECTRON_RUN_AS_NODE=1.
    // BUG FIX: spread process.env so the child inherits PATH, USERPROFILE, etc.
    // The old code replaced the entire env (stripping everything the CLI needs).
    const probeEnv = needsRunAsNode(node) ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : undefined;
    const r = spawnSync(node, [entry, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 6000, env: probeEnv });
    const out = ((r && (r.stdout || '') ) + ' ' + (r && (r.stderr || ''))).trim();
    // mmx emits e.g. "mmx-cli/1.0.16" or "1.0.16" — take the first x.y.z token.
    const m = out.match(/(\d+\.\d+\.\d+)/);
    _probedVersion = m ? m[1] : null;
    return _probedVersion;
  } catch (_) {
    _probedVersion = null;
    return null;
  }
}

// Compare two semver x.y.z strings. Returns -1/0/1 (a vs b); NaN versions sort
// below everything. Pure — unit-testable.
function compareSemver(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10));
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = Number.isFinite(pa[i]) ? pa[i] : -1;
    const bi = Number.isFinite(pb[i]) ? pb[i] : -1;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

// The mmx-cli range this build was developed + tested against. An installed
// runtime outside the tested range triggers a warn (Phase A) / block (Phase B).
// Bump the floor as the project's pinned/tested version advances.
const SUPPORTED_MMX = { min: '1.0.16', recommended: '1.0.18' };

// safeCall wraps a best-effort renderer callback so a throw (e.g. a buggy
// onLog in the LogService) cannot abort a long-running mmx job. Used for
// every onLog / onChunk call site. The callbacks are best-effort by
// definition (UI notifications); their failure must not propagate back to
// runMmx. It also logs the throw to the main process console (without the
// user's input data) so a future crash is diagnosable.
function safeCall(cb, ...args) {
  if (typeof cb !== 'function') return;
  try {
    cb(...args);
  } catch (e) {
    try { console.error('[mmx] safeCall: callback threw:', e && (e.message || e)); } catch (_) { /* ignore */ }
  }
}

// R2.4: strip any `--api-key=VALUE` (single-token = form) or
// `--api-key VALUE` (two-token form) that the renderer may have
// smuggled into its `args`. Without this, a malicious or buggy
// renderer could put the api key in the spawn argv — and on
// Windows, any local process can read every other process's argv
// via WMI for the entire call duration (the comment block above
// explains why we never use the legacy --api-key argv path). The
// helper returns a new array; the original is left untouched so
// the caller can still inspect it (e.g. for IPC logging).
//
// Note: this is purely a defence against a renderer that TRIES to
// bypass the SessionCredentialStore flow. The legitimate API key
// routing (--api-key argv fallback when ~/.mmx sync fails) still
// runs in its own controlled block below — that path uses the
// Main-side `apiKey` parameter, not the renderer's `args`.
// R2.4: argv sanitizer lives in src/mmxArgSanitizer.js.

// cwd validation: see src/mmxCwd.js for the full rationale. We accept cwd
// only when it is undefined/null (OS default) or an absolute path; anything
// else is silently coerced to undefined.
const { safeCwd: _safeCwd } = require('./mmxCwd');

function resolve() {
  if (resolved) return resolved;
  // H11-5: on all platforms, prefer the bundled mmx-cli run under node. This
  // makes the tool work out-of-the-box (no global mmx-cli install needed).
  // The bundled entry + Electron's node are found by findMmxEntry/findNodeExe.
  const node = findNodeExe();
  const entry = findMmxEntry();
  if (!isWindows()) {
    // POSIX: if a bundled entry + node were found, use them. Otherwise fall
    // back to a system `mmx` on PATH (legacy behaviour for users who have it).
    if (node && entry) {
      resolved = { command: node, prefix: [entry], node, entry, error: null };
    } else {
      resolved = { command: 'mmx', prefix: [], node: null };
    }
    return resolved;
  }
  if (!node) {
    resolved = { command: null, prefix: [], node: null, entry, error: 'Could not find node.exe on PATH. Install Node.js 18+ so `mmx` can run.' };
    return resolved;
  }
  if (!entry) {
    resolved = { command: node, prefix: [], node, entry: null, error: 'Could not find mmx-cli installation. Run `npm install -g mmx-cli`.' };
    return resolved;
  }
  resolved = { command: node, prefix: [entry], node, entry, error: null };
  return resolved;
}

function runMmx({ args, apiKey, cwd, onLog, onChunk, jobId, sessionOnly }) {
  return new Promise((resolveP) => {
    const r = resolve();
    if (!r.command) {
      const msg = `[mmx] ${r.error}`;
      safeCall(onLog, msg);
      safeCall(onChunk, { line: msg, jobId: jobId || null, kind: 'stderr' });
      // Include command/argv on the early-fail path so diagnostics degrade gracefully.
      resolveP({ ok: false, code: -1, canceled: false, stdout: '', stderr: r.error || 'mmx unavailable', parsed: null, command: r.command || '', argv: [] });
      return;
    }
    const safeCwd = _safeCwd(cwd);
    // Defensive: the renderer always passes an array, but a future caller
    // (or a corrupted IPC payload) might not. Bail out cleanly instead of
    // throwing a cryptic "args is not iterable" from the spread below.
    if (!Array.isArray(args)) {
      resolveP({ ok: false, code: -1, canceled: false, stdout: '', stderr: 'mmx: args must be an array', parsed: null, command: r.command || '', argv: [] });
      return;
    }
    // R2.4: defence-in-depth against a renderer that tries to smuggle
    // `--api-key=VALUE` or `--api-key VALUE` into the spawn argv.
    const sanitisedArgs = _stripRendererSuppliedApiKey(args);
    const fullArgs = [
      ...r.prefix,
      ...sanitisedArgs,
      '--output', 'json',
      ...AGENT_FLAGS,
    ];
    // Route the API key through mmx-cli's own ~/.mmx/config.json instead of
    // --api-key argv. argv is readable by any local process on Windows via
    // WMI; the file path is readable only via filesystem access (which already
    // implies the attacker could read our config.txt). When the sync fails
    // (e.g. ~/.mmx is read-only), fall back to the legacy --api-key argv so
    // the call still works.
    //
    // Session-only mode (H7-022): the user opted out of persisting the key.
    // We must NOT write it to ~/.mmx/config.json (that would break the
    // "credentials never touch disk" promise). The argv fallback would also
    // put the key on disk via the OS command audit log, so we route the key
    // through an ephemeral process-local env var and child bootstrap instead. The
    // env is never persisted and dies with the child process.
    let keySyncedToConfig = false;
    let keyInArgv = false;
    let childEnv = buildChildEnv();
    let spawnArgs = fullArgs;
    if (apiKey) {
      if (sessionOnly) {
        // Ephemeral env: process-local, never written to disk, gone when the
        // child exits. The bootstrap injects --api-key only inside the child,
        // after the OS process command line has already been created.
        childEnv = { ...childEnv, MINIMAX_API_KEY: apiKey };
        spawnArgs = ['-e', SESSION_KEY_BOOTSTRAP, ...fullArgs];
      } else {
        keySyncedToConfig = _syncApiKeyToMmxCliConfig(apiKey);
        if (!keySyncedToConfig) {
          fullArgs.push('--api-key', apiKey);
          keyInArgv = true;
        }
      }
    }
    // Build a REDACTED argv copy for IPC/diagnostics (H7-013). R2.4: delegated to mmxResultRedactor.
    const redactedArgs = _redactArgv(fullArgs);

    // Log the command line, but redact the API key (R2.4: delegated to mmxResultRedactor).
    const cmdLine = `$ ${r.command} ${fullArgs.map(quote).join(' ')}`;
    const redactedCmdLine = _redactCmdLine(cmdLine);
    safeCall(onLog, redactedCmdLine);
    safeCall(onChunk, { line: redactedCmdLine, jobId: jobId || null, kind: 'stderr' });

    let stdout = '';
    let stderr = '';
    let lastStdoutTrim = '';
    // The cap constants and the _appendCapped closure live in
    // src/mmxStreamCaps.js. A fresh appender per runMmx() call keeps the
    // truncation flag per-job, so a slow mmx child that fills the cap does
    // not affect the next run's marker.
    const _appendCapped = makeCappedAppender();
    // Hard timeout so a hung mmx child cannot leave a job stuck on
    // "running" forever. 30 min is the generous ceiling — the longest
    // legitimate job (a 6-second video at the API's slowest) takes ~3 min;
    // leave headroom for slow connections + retries. A timed-out proc is
    // SIGKILLed so even a child that catches SIGTERM is reaped.
    const TIMEOUT_MS = 30 * 60 * 1000;
    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      try { proc.kill(); } catch (_) {}
    // Windows: proc.kill uses TerminateProcess (no signal). POSIX:
    // SIGTERM by default. Give the child a 2s grace, then SIGKILL.
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 2000).unref();
      const msg = `[mmx] timed out after ${Math.round(TIMEOUT_MS / 60000)} min and was killed.`;
      safeCall(onLog, msg);
      safeCall(onChunk, { line: msg, jobId: jobId || null, kind: 'stderr' });
      currentGenProcs.delete(proc);
      if (jobId) procsByJobId.delete(jobId);
      // R2.4: deepRedact the timeout envelope too.
      resolveP({ ok: false, code: -1, canceled: false, stdout, stderr: stderr + '\n' + msg, parsed: null, command: r.command || '', argv: redactedArgs });
    }, TIMEOUT_MS).unref();
    let proc;
    try {
      // H11-5: when running under Electron's own node, set ELECTRON_RUN_AS_NODE=1.
      if (needsRunAsNode(r.command)) childEnv = { ...childEnv, ELECTRON_RUN_AS_NODE: '1' };
      // Use a whitelisted env instead of the full process.env — see
      // buildChildEnv for the rationale.
      proc = spawn(r.command, spawnArgs, { cwd: safeCwd, windowsHide: true, env: childEnv });
      // Track every active proc in a Set so cancelOne(proc) can kill a
      // specific in-flight generation while leaving sibling procs (e.g. a
      // parallel quota check) alone. cancelAll() remains the "panic" button.
      currentGenProcs.add(proc);
      // Also index by jobId so cancelByJobId (JobRunner.cancel ->
      // mmx:cancel {jobId}) can kill exactly this proc without touching
      // sibling jobs. If a duplicate jobId arrives (rare — the renderer's
      // JobRunner hands out unique ids, but a corrupted state or a
      // hand-crafted IPC payload could collide), kill the orphaned prior
      // proc explicitly so it can't keep running untracked.
      if (jobId) {
        const priorProc = procsByJobId.get(jobId);
        if (priorProc && priorProc !== proc) {
          try { _killWithEscalation(priorProc); } catch (_) {}
          currentGenProcs.delete(priorProc);
        }
        procsByJobId.set(jobId, proc);
      }
    } catch (err) {
      clearTimeout(killTimer);
      // Include command/argv on every error path so diagnostics degrade
      // gracefully (the success path already returns them). r.command is
      // null when resolve() failed; the empty string is a safer placeholder
      // than undefined for the IPC marshal.
      resolveP({ ok: false, code: -1, canceled: false, stdout: '', stderr: String(err), parsed: null, command: r.command || '', argv: redactedArgs });
      return;
    }

    proc.stdout.on('data', (b) => {
      const s = b.toString('utf8');
      // SYS-003: redact stdout chunk before accumulation so the final
      // result envelope never carries a raw secret (mirrors stderr path).
      const sRed = _redactStderrChunk(s);
      stdout = _appendCapped('stdout', stdout, sRed, MAX_STDOUT_BYTES);
      // Forward a trimmed view of stdout to the log so the user sees
      // multi-line JSON responses broken into readable chunks. Skip empty
      // chunks (common with TTY-style output) and skip the last chunk if
      // it duplicates what we already logged, to avoid noise.
      const trimmed = sRed.trim();
      if (trimmed && trimmed !== lastStdoutTrim) {
        lastStdoutTrim = trimmed;
        // Only log if it looks like JSON or contains an error keyword — we
        // don't want to spam the log with progress lines if mmx-cli ever
        // grows them.
        if (/^[\s]*[{[]/.test(trimmed) || /error|warning|failed/i.test(trimmed)) {
          safeCall(onLog, trimmed);
          safeCall(onChunk, { line: trimmed, jobId: jobId || null, kind: 'stdout' });
        }
      }
    });
    proc.stderr.on('data', (b) => {
      const s = b.toString('utf8');
      // R2.4: redact the chunk before it lands in the `stderr`
      // accumulator. Otherwise the final `r.stderr` IPC field
      // could carry the raw secret even though onLog/onChunk saw
      // a redacted copy.
      const sRedacted = _redactStderrChunk(s);
      stderr = _appendCapped('stderr', stderr, sRedacted, MAX_STDERR_BYTES);
      // filter the noisy PowerShell wrapping
      const trimmed = sRedacted.replace(/^node\.exe\s*:\s*/gm, '').trimEnd();
      if (trimmed) {
        safeCall(onLog, trimmed);
        safeCall(onChunk, { line: trimmed, jobId: jobId || null, kind: 'stderr' });
      }
    });
    proc.on('error', (err) => {
      if (killed) return;
      clearTimeout(killTimer);
      currentGenProcs.delete(proc);
      if (jobId) procsByJobId.delete(jobId);
      // R2.4: deepRedact the error path (R0.1-003.C).
      resolveP({ ok: false, code: -1, canceled: false, stdout, stderr: stderr + '\n' + String(err), parsed: null, command: r.command || '', argv: redactedArgs });
    });
    proc.on('close', (code) => {
      if (killed) return;
      clearTimeout(killTimer);
      currentGenProcs.delete(proc);
      if (jobId) procsByJobId.delete(jobId);
      // H7-025: a user-initiated cancel (cancelOne/cancelByJobId/cancelAll)
      // tags the proc with _canceledByUser. Surface that as a neutral
      // { canceled: true } result instead of a bare code:null error so the
      // renderer renders "Canceled by user." rather than the generic
      // "mmx exited with code null".
      const userCanceled = !!(proc && proc._canceledByUser);
      const parsed = tryParseAll(stdout);
      const ok = code === 0;
      if (!ok && !parsed && !userCanceled) {
        const exitLine = `[mmx] exit code ${code}`;
        safeCall(onLog, exitLine);
        safeCall(onChunk, { line: exitLine, jobId: jobId || null, kind: 'stderr' });
      }
      // R2.4: deepRedact the close-path envelope.
      resolveP({ ok, code, canceled: userCanceled, stdout, stderr: userCanceled ? 'Canceled by user' : stderr, parsed, command: r.command, argv: redactedArgs });
    });
  });
}

// Parse one-or-more JSON documents out of a stdout blob.
//
// mmx with `--output json` emits:
//   • a single JSON document (image / quota / voices), OR
//   • TWO pretty-printed, multi-line JSON objects back-to-back
//     (speech synthesize --subtitles emits the audio result and the
//     subtitle result as two separate indented objects).
//
// The earlier line-by-line parser could not handle the second case: a
// pretty-printed object spans many lines, so `JSON.parse(line)` failed for
// every line and the whole blob collapsed to a plain string (H7-024). This
// brace-aware scanner walks the text, tracks string/brace context, and
// extracts each top-level object so multi-line objects parse correctly.
function tryParseAll(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Fast path: the whole blob is a single JSON document.
  try { return JSON.parse(trimmed); } catch (_) { /* not a single doc */ }
  // Scan for top-level { ... } / [ ... ] objects using a context tracker.
  const docs = [];
  let i = 0;
  const n = trimmed.length;
  while (i < n) {
    // Skip whitespace and any non-structural text between documents.
    while (i < n && /\s/.test(trimmed[i])) i++;
    if (i >= n) break;
    const start = trimmed[i];
    if (start !== '{' && start !== '[') {
      // Leading junk before the first document — skip one char and retry.
      i++;
      continue;
    }
    const close = start === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < n; j++) {
      const c = trimmed[j];
      if (inStr) {
        if (esc) { esc = false; }
        else if (c === '\\') { esc = true; }
        else if (c === '"') { inStr = false; }
      } else {
        if (c === '"') { inStr = true; }
        else if (c === start) { depth++; }
        else if (c === close) { depth--; if (depth === 0) { j++; break; } }
      }
    }
    if (depth !== 0) break; // unbalanced — give up on structured parse
    const slice = trimmed.slice(i, j);
    try { docs.push(JSON.parse(slice)); }
    catch (_) { /* malformed slice — skip */ }
    i = j;
  }
  if (docs.length === 1) return docs[0];
  if (docs.length > 1) return docs;
  // No structured document found at all — degrade to the trimmed string so
  // downstream consumers still see *something* (e.g. an error message).
  return trimmed;
}

function quote(v) {
  if (v == null) return '""';
  const s = String(v);
  if (/[\s"']/.test(s)) return '"' + s.replace(/"/g, '\\"') + '"';
  return s;
}

// Track every active mmx proc so individual jobs can be cancelled on demand.
// The renderer runs multiple jobs in parallel (one per tab + secondary jobs
// for post-processing), so a single-slot tracker no longer works. We track
// the whole Set and expose cancelOne(proc) / getActiveProcs() / cancelAll()
// helpers. cancelAll() remains the "panic" button.
const currentGenProcs = new Set();
// Map<jobId, proc> alongside the Set above, populated only when
// runMmx({..., jobId}) is given one. Lets JobRunner.cancel(jobId) kill exactly
// that job's proc instead of every in-flight generation.
const procsByJobId = new Map();
function getActiveProcs() {
  return Array.from(currentGenProcs);
}
// SIGKILL escalation. Windows is fine (proc.kill uses TerminateProcess which
// can't be caught), but on macOS/Linux a mmx child that catches SIGTERM
// survives. Send SIGTERM, then SIGKILL after 2s, mirroring the isnetbg
// timeout pattern. We tag the proc as user-canceled so the close handler can
// resolve with { canceled: true } instead of a bare code:null error (H7-025).
function _killWithEscalation(proc, opts) {
  if (opts && opts.userCanceled && proc) {
    try { proc._canceledByUser = true; } catch (_) {}
  }
  try { proc.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => {
    try {
      // Only escalate if the proc is still running. proc.killed is
      // true after a successful kill(); on Windows TerminateProcess
      // already reaped the proc so this is a no-op.
      if (!proc.killed) proc.kill('SIGKILL');
    } catch (_) {}
  }, 2000).unref();
}
function cancelOne(proc) {
  if (!proc) return false;
  if (!currentGenProcs.has(proc)) return false;
  _killWithEscalation(proc, { userCanceled: true });
  return true;
}
function cancelByJobId(jobId) {
  if (!jobId) return false;
  const proc = procsByJobId.get(jobId);
  if (!proc) return false;
  return cancelOne(proc);
}
function cancelAll() {
  for (const p of currentGenProcs) {
    _killWithEscalation(p, { userCanceled: true });
  }
  currentGenProcs.clear();
  procsByJobId.clear();
}

module.exports = { runMmx, resolve, cancelAll, cancelOne, cancelByJobId, getActiveProcs, tryParseAll, probeMmxVersion, compareSemver, SUPPORTED_MMX };
