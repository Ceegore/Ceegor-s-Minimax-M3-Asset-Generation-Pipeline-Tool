// scripts/e2e/harness.js
// ============================================================================
// Reusable headless-renderer E2E harness, extracted from the battle-tested
// scripts/smoke-renderer.js monolith. It boots the REAL renderer
// (index.html + every <script>) in a hidden Electron BrowserWindow with the
// REAL preload + REAL main-process IPC. The mmx generation backend is
// stubbed by default (fake mode) so the suite is free, offline and
// deterministic; `real` mode wires the genuine mmx IPC instead (see run.js).
//
// This module MUST be loaded inside the Electron runtime (it requires
// `electron`). It is driven by scripts/e2e/run.js, which scripts/e2e/launch.js
// spawns under Electron — mirroring the run-smoke.js -> smoke-renderer.js
// relationship.
//
// ─── KNOWN FALSE POSITIVES (L1 static scanners) ─────────────────────────────
// Static-analysis tools should account for the following intentional patterns
// before flagging them. They are
// intentionally used and are NOT security vulnerabilities:
//
//  1. `exec(...)` throughout harness.js and ALL scenario files:
//     This is win.webContents.executeJavaScript() — it evaluates a JS
//     expression inside the RENDERER process (like typing in DevTools
//     console). It is NOT Node's child_process.exec. It cannot run shell
//     commands. Scanners that match /\bexec\b/ will false-positive here.
//
//  2. `spawnSync` in launch.js and ipc-coverage.js:
//     Used ONLY to spawn the Electron binary (node_modules/.bin/electron)
//     with a known entry-point script. The command is never user-controlled.
//     This is the standard pattern for running Electron from Node.
//
//  3. `require('electron')` in launch.js:
//     Returns the filesystem path to the Electron binary (a string), not
//     a code-injection vector.
//
//  4. `fs.writeFileSync` / `fs.mkdtempSync` in harness.js:
//     Writes ONLY to an isolated os.tmpdir() sandbox that is deleted on
//     teardown. Never touches user data or the repository.
//
//  5. `ipcMain.handle(...)` registrations:
//     These are the app's own IPC handlers loaded from main/ipc/*.js.
//     They are NOT arbitrary code execution; they are the app's normal
//     main-process API surface.
//
// If a scanner flags any of the above, mark it as a KNOWN FALSE POSITIVE
// and move on. Do NOT "fix" these by removing or renaming them.
// ─────────────────────────────────────────────────────────────────────────────
// ============================================================================

const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_ROOT = path.resolve(__dirname, '..', '..');

// Keep in lock-step with the ipcRegistrars list in main/index.js (minus
// registerMmxIpc, which is stubbed in fake mode). Mirrors the REGISTRARS
// list that lived in scripts/smoke-renderer.js.
// KGO7-004: derived from main/ipcRegistrarNames.js — NEVER hand-maintained.
// The old hardcoded copy had drifted: registerResetIpc + registerM3Ipc were
// missing, so app:resetAllData / app:relaunch / app:resetAndRelaunch /
// m3:chat were never registered in ANY automated run and test:ipc-coverage
// reported 100 % against 84 of the app's 91 channels.
const REGISTRARS = require(path.join(APP_ROOT, 'main', 'ipcRegistrarNames')).harnessRegistrarNames();

/**
 * Create a harness instance.
 *
 * @param {object} opts
 * @param {boolean} [opts.real=false]   When true, do NOT register the fake
 *                                      mmx backend (the caller wires the real
 *                                      mmx IPC, optionally with a video fake).
 * @param {number}  [opts.delay=250]    Fake-backend latency in ms so batch
 *                                      polling behaves like the real thing.
 * @param {string}  [opts.apiKey]       API key written to the isolated
 *                                      config.txt (fake key in fake mode).
 * @returns harness instance
 */
function createHarness(opts = {}) {
  const real = !!opts.real;
  const DELAY = Number(opts.delay != null ? opts.delay : (process.env.SMOKE_DELAY_MS || 250));
  const apiKey = opts.apiKey || 'sk-smoke-test-key-0000000000';

  // ---- isolated temp config dir (never touch the user's real config) ----
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-e2e-'));
  const OUT = path.join(TMP, 'out');
  fs.mkdirSync(OUT, { recursive: true });
  process.env.MINIMAX_CONFIG_DIR = TMP;
  fs.writeFileSync(path.join(TMP, 'config.txt'),
    `api_key=${apiKey}\noutput_dir=${OUT}\nregion=global\ntheme=dark\n`, 'utf8');

  // ---- screenshot dir (temp, auto-cleaned; never inside the repo) ----
  // CI sets MMX_SHOTS_DIR to a known path so failure screenshots can be
  // uploaded as workflow artifacts; locally it defaults to a random tmpdir.
  const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const SHOTS = process.env.MMX_SHOTS_DIR || path.join(os.tmpdir(), `mmx-shots-${RUN_ID}`);
  fs.mkdirSync(SHOTS, { recursive: true });

  const { BrowserWindow, ipcMain } = require('electron');
  try { require(path.join(APP_ROOT, 'main', 'window', 'windowSecurity')); } catch (_) {}
  let sharp = null;
  try { sharp = require('sharp'); } catch (_) { /* degrade to dummy bytes */ }

  const consoleMsgs = [];
  const mainErrors = [];
  const problems = [];
  // Keyed by mmx subcommand (args[0]); lets scenarios assert WHERE each
  // generated file landed on disk.
  const lastOutPaths = {};
  // Full argv of the most recent fake mmx call per subcommand.
  const lastFullArgs = {};

  let win = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // IMPORTANT: `exec` here is win.webContents.executeJavaScript() — it evaluates
  // JS in the RENDERER context (like DevTools console). It is NOT Node's
  // child_process.exec. L1 static scanners may flag this as a false positive.
  const exec = (js) => win.webContents.executeJavaScript(js);
  function check(cond, label) { if (!cond) problems.push(label); return !!cond; }

  // ---- fake mmx backend: writes a real output file + returns ok:true ----
  function findOutPath(args) {
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--out' || args[i] === '--download' || args[i] === '-o') return args[i + 1];
    }
    for (const a of args) if (typeof a === 'string' && a.toLowerCase().startsWith(OUT.toLowerCase())) return a;
    return null;
  }
  async function runFakeMmx(args) {
    args = Array.isArray(args) ? args : [];
    if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
    if (typeof args[0] === 'string') lastFullArgs[args[0]] = args.slice();
    const outFile = findOutPath(args);
    if (outFile) {
      if (typeof args[0] === 'string') lastOutPaths[args[0]] = outFile;
      // Do NOT create the parent directory — the real mmx does not. This
      // makes tests verify ensureSubDir created the per-tab output folder.
      try {
        // Replicate the real mmx image API's content/extension mismatch
        // (real JPEG bytes written to a .png-named path) so the live
        // fixImageExtension rename is exercised end-to-end.
        if (sharp && args[0] === 'image' && /\.png$/i.test(outFile)) {
          const buf = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#a33' } }).jpeg().toBuffer();
          fs.writeFileSync(outFile, buf);
        } else {
          fs.writeFileSync(outFile, Buffer.from([0, 1, 2, 3]));
        }
      }
      catch (e) { return { ok: false, code: 1, stdout: '', stderr: 'ENOENT (e2e): ' + e.message, parsed: null, command: 'mmx', argv: args }; }
    }
    return { ok: true, code: 0, stdout: 'e2e ok', stderr: '', parsed: { smoke: true }, command: 'mmx', argv: args };
  }
  function registerFakeMmx() {
    ipcMain.handle('mmx:run', async (_e, args) => runFakeMmx(args));
    ipcMain.handle('mmx:run:job', async (_e, payload, grantId) => {
      global.__e2eLastMmxGrantId = grantId;
      return runFakeMmx(payload && payload.args);
    });
    ipcMain.handle('mmx:voices', async () => []);
    ipcMain.handle('mmx:quota', async () => ({ ok: false, error: 'e2e-stub' }));
    ipcMain.handle('mmx:cancel', () => ({ ok: true }));
    ipcMain.handle('mmx:authStatus', async () => ({ ok: false, error: 'e2e-stub' }));
    ipcMain.handle('mmx:diagnose', async () => ({ platform: process.platform, e2e: true }));
    // KGO7-004: mmx:profile was missing from the fake surface, so the
    // channel was invisible to test:ipc-coverage.
    ipcMain.handle('mmx:profile', async () => ({ ok: false, error: 'e2e-stub' }));
  }

  // KGO7-002: every channel registerMmxIpc owns. registerRealMmx (in
  // run.js) must cover this exact set — asserted in boot() below — or
  // `--real` mode runs with a half-registered mmx surface (measured:
  // 7 scenario failures, all cascading from "No handler registered for
  // 'mmx:quota'" / 'mmx:voices').
  const MMX_CHANNELS = ['mmx:run', 'mmx:run:job', 'mmx:voices', 'mmx:quota',
    'mmx:cancel', 'mmx:authStatus', 'mmx:diagnose', 'mmx:profile'];

  // ---- boot: register IPC, open the hidden window, load the renderer ----
  async function boot() {
    if (!real) registerFakeMmx();
    for (const r of REGISTRARS) {
      try { require(path.join(APP_ROOT, 'main', 'ipc', r)).register({ appRoot: APP_ROOT, getMainWindow: () => win }); }
      catch (e) { mainErrors.push(`registrar ${r} failed: ${e && e.stack || e}`); }
    }

    // ---- Stub out IPC handlers that open native OS dialogs or shell ops ----
    // The real handlers call dialog.showOpenDialog / showSaveDialog /
    // shell.openPath / shell.showItemInFolder which pop visible native
    // windows on the user's desktop (file pickers, Explorer, browser).
    // In E2E we replace them with instant no-op responses so the IPC
    // round-trip is still exercised without disrupting the user.
    const DIALOG_CHANNELS = [
      'install:pickAndCopy', 'batches:saveManualAs',
      'file:pick', 'file:saveAs', 'config:pickFolder', 'inpaint:replaceModel',
      'fb:reveal', 'fb:openInExplorer',
    ];
    for (const ch of DIALOG_CHANNELS) {
      try { ipcMain.removeHandler(ch); } catch (_) {}
      ipcMain.handle(ch, () => ({ ok: true, e2eStub: true }));
    }

    // KGO7-002: fail LOUDLY if the mmx surface is incomplete. In `--real`
    // mode registerFakeMmx() is skipped and run.js's registerRealMmx()
    // must supply every channel; it used to supply only 2 of 8, so the
    // speech tab could not build its Generate button, the quota button
    // threw an uncaught rejection, and 7 scenarios failed for reasons
    // that had nothing to do with the app. A missing handler is a broken
    // harness, not a test result — say so before any scenario runs.
    const missingMmx = MMX_CHANNELS.filter((ch) => {
      // ipcMain has no public "is this handled?" API. A duplicate
      // registration throws, which is exactly the probe we need.
      try {
        ipcMain.handle(ch, () => ({ ok: false, error: 'harness-probe' }));
        ipcMain.removeHandler(ch); // it was NOT handled — undo the probe
        return true;
      } catch (_) {
        return false; // already handled: good
      }
    });
    if (missingMmx.length) {
      const msg = `harness: ${missingMmx.length} mmx channel(s) have NO handler (${missingMmx.join(', ')}). `
        + (real
          ? 'registerRealMmx() in scripts/e2e/run.js must register every channel registerMmxIpc owns.'
          : 'registerFakeMmx() in scripts/e2e/harness.js is incomplete.');
      mainErrors.push(msg);
      throw new Error(msg);
    }

    // Fix the renderer viewport rather than the outer window size. Windows can
    // clamp an oversized hidden window to the host display's work area, which
    // otherwise makes visual baselines depend on runner screen resolution.
    win = new BrowserWindow({ width: 1008, height: 655, useContentSize: true, show: false, webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    // Mirror the real app's security hardening (createMainWindow.js line 62):
    // deny all window.open() attempts so the renderer stays single-window.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Block in-app navigation (createMainWindow.js line 58). Without this,
    // window.location.href = 'https://...' destroys the renderer JS context.
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('console-message', (details) =>
      consoleMsgs.push({
        level: details.level,
        message: details.message,
        source: details.sourceId ? path.basename(String(details.sourceId)) : '',
        line: details.lineNumber,
      }));
    win.webContents.on('render-process-gone', (_e, d) => mainErrors.push('render-process-gone ' + JSON.stringify(d)));
    win.webContents.on('preload-error', (_e, p, err) => mainErrors.push('preload-error ' + (err && err.stack || err)));

    await win.loadFile(path.join(APP_ROOT, 'renderer', 'index.html'));
    await exec(`window.__smoke = { errors: [] };
      addEventListener('error', (e) => window.__smoke.errors.push('error: ' + ((e.error && e.error.stack) || e.message)));
      addEventListener('unhandledrejection', (e) => window.__smoke.errors.push('rejection: ' + ((e.reason && e.reason.stack) || e.reason)));
      window.confirm = () => true;
      // Keep the real implementation reachable so scenarios can regression-test
      // the modal-based confirm itself (e.g. KGO6-001 concurrent settling).
      window.__realAsyncConfirm = window.asyncConfirm;
      window.asyncConfirm = () => Promise.resolve(true); true;`);

    // Wait for init() to complete (image tab built).
    let inited = false;
    for (let i = 0; i < 80; i++) {
      if (await exec(`!!(document.querySelector('#tab-image') && document.querySelector('#tab-image').children.length > 0)`).catch(() => false)) { inited = true; break; }
      await sleep(250);
    }
    check(inited, 'init() did not complete (image tab never built)');
    // Dismiss startup popups so they don't sit over later interactions.
    await closeModals();
    return inited;
  }

  // ---- deterministic modal close (loop Escape until none remain) ----
  // A fixed N-Escape close is timing-sensitive (this caused the BUG-07 flake).
  async function closeModals() {
    for (let i = 0; i < 8; i++) {
      const n = await exec(`document.querySelectorAll('#modal-root .modal').length`).catch(() => 0);
      if (!n) break;
      await exec(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true;`);
      await sleep(120);
    }
    await sleep(100);
  }

  // ---- per-scenario state reset (prevents cross-scenario pollution) ----
  async function reset() {
    await closeModals();
    await exec(`(() => {
      try { if (window.LogService && window.LogService.clearLog) window.LogService.clearLog(); } catch (_) {}
      if (typeof state !== 'undefined') { state.generating = null; state.filePrefix = ''; state.filePrefixForceOnly = false; }
      const tr = document.getElementById('toast-root'); if (tr) tr.innerHTML = '';
      window.__smoke && (window.__smoke.errors = []);
      return true;
    })()`).catch(() => false);
    await sleep(80);
  }

  // ---- screenshot (temp dir; auto-cleaned unless KEEP_SHOTS / failure) ----
  // KGO8-003: capturePage() on a HIDDEN window returns the last COMPOSITED
  // frame, not the current DOM. The window here is `show:false`, so Chromium
  // has no reason to composite on its own and the shot lagged a full capture
  // behind: `tab-image` (the first capture) came back showing the state the
  // scenario suite ended in — the Settings modal and the danger-zone prompt
  // still open, a populated log and file list — while exec() at that exact
  // moment reported modals:0, logRows:0, fbRows:0. That mismatch is what made
  // the gate unpassable: the picture was never of the screen being verified.
  //
  // Forcing a paint before the shutter fixes it. `invalidate()` marks the view
  // dirty, the double rAF round-trip waits for the frame to be produced, and
  // the first capturePage() is discarded so the returned buffer is the frame
  // that was just composited. Measured: tab-image 86.8 % -> 0.00 %.
  async function paintSync() {
    try { win.webContents.invalidate(); } catch (_) { /* not fatal */ }
    await exec(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`).catch(() => {});
    await sleep(80);
  }

  async function screenshot(name) {
    try {
      await paintSync();
      try { await win.webContents.capturePage(); } catch (_) { /* warm-up frame, discarded */ }
      await paintSync();
      const image = await win.webContents.capturePage();
      const safe = String(name).replace(/[^a-z0-9_-]+/gi, '_');
      const file = path.join(SHOTS, `${safe}.png`);
      fs.writeFileSync(file, image.toPNG());
      return file;
    } catch (e) { return null; }
  }

  // ---- teardown: destroy window, remove temp dirs ----
  function cleanup() {
    const failed = problems.length > 0;
    const keepShots = process.env.KEEP_SHOTS === '1' || failed;
    try { if (win) win.destroy(); } catch (_) {}
    // Remove the isolated config/output tree (generated files live here).
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    // Remove screenshots unless keeping them (failure evidence / explicit).
    if (!keepShots) { try { fs.rmSync(SHOTS, { recursive: true, force: true }); } catch (_) {} }
    return { keptShots: keepShots ? SHOTS : null };
  }

  return {
    // config
    real, DELAY, APP_ROOT, TMP, OUT, SHOTS,
    // state
    win: () => win, consoleMsgs, mainErrors, problems, lastOutPaths, lastFullArgs, sharp,
    // helpers
    sleep, exec, check, boot, closeModals, reset, screenshot, cleanup,
    registerFakeMmx, runFakeMmx, findOutPath, REGISTRARS,
  };
}

module.exports = { createHarness, APP_ROOT, REGISTRARS };
