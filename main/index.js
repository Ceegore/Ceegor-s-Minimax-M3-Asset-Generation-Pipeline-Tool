// main/index.js — Electron main process composition root.
// Configures global switches, registers all IPC handlers, and creates
// the main BrowserWindow. Contains no business logic.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const APP_ROOT = __dirname;
const PARENT_ROOT = path.resolve(APP_ROOT, '..'); // __dirname = main/, parent = project root

require('../src/assetPaths').init({
  appRoot: PARENT_ROOT,
  resourcesPath: app.isPackaged ? process.resourcesPath : '',
  userDataPath: app.getPath('userData')
});

// Pick a writable location for renderer-error.log that works in both
// dev and packaged builds. In dev, PARENT_ROOT (the project root) is
// writable. In a packaged build it resolves inside the read-only asar,
// so we fall back to app.getPath('logs'), an Electron-blessed writable
// directory the OS creates for us.
function _resolveRendererLogPath() {
  const candidates = [
    path.join(PARENT_ROOT, 'renderer-error.log'),
    (() => { try { return path.join(app.getPath('logs'), 'renderer-error.log'); } catch (_) { return null; } })(),
    path.join(process.cwd(), 'renderer-error.log'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      fs.writeFileSync(p, ''); // verify writability (truncate on app start)
      return p;
    } catch (_) { /* read-only / no permission — try next */ }
  }
  return null;
}
const RENDERER_LOG = _resolveRendererLogPath();
// SYS-006: async log queue with size/rate limiting + rotation.
// Replaces the legacy synchronous appendFileSync that could block the
// main-process event loop and had no upper bound on data acceptance.
const _LOG_MAX_LINE = 10240;      // per-line cap (10 KB)
const _LOG_MAX_PER_SEC = 200;     // rate limit
const _LOG_FLUSH_MS = 250;        // flush interval
const _LOG_ROTATE_BYTES = 2 * 1024 * 1024; // 2 MB rotation threshold
let _logBuf = [];
let _logCount = 0;
let _logWinStart = Date.now();
let _logTimer = null;
function _flushLog() {
  _logTimer = null;
  if (!_logBuf.length || !RENDERER_LOG) return;
  const chunk = _logBuf.join('');
  _logBuf = [];
  fs.appendFile(RENDERER_LOG, chunk, () => {
    try {
      const st = fs.statSync(RENDERER_LOG);
      if (st.size > _LOG_ROTATE_BYTES) {
        fs.renameSync(RENDERER_LOG, RENDERER_LOG + '.old');
      }
    } catch (_) { /* best-effort rotation */ }
  });
}
function _queueLog(line) {
  if (!RENDERER_LOG) return;
  const now = Date.now();
  if (now - _logWinStart > 1000) { _logWinStart = now; _logCount = 0; }
  if (++_logCount > _LOG_MAX_PER_SEC) return;
  let s = String(line == null ? '' : line);
  if (s.length > _LOG_MAX_LINE) s = s.slice(0, _LOG_MAX_LINE) + '…[truncated]';
  _logBuf.push(s + '\n');
  if (!_logTimer) _logTimer = setTimeout(_flushLog, _LOG_FLUSH_MS);
}
ipcMain.on('renderer:log', (event, line) => { _queueLog(line); });
if (RENDERER_LOG) {
  try { fs.writeFileSync(RENDERER_LOG, '=== renderer-error.log @ ' + new Date().toISOString() + ' ===\n'); }
  catch (_) {}
}

process.on('uncaughtException', (err) => {
  try {
    const ts = new Date().toISOString().slice(11, 23);
    const msg = `[main] uncaughtException: ${err && err.stack ? err.stack : err}`;
    if (RENDERER_LOG) fs.appendFileSync(RENDERER_LOG, ts + ' ' + msg + '\n');
    console.error(msg);
  } catch (_) {}
});

process.on('unhandledRejection', (reason) => {
  try {
    const ts = new Date().toISOString().slice(11, 23);
    const msg = `[main] unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`;
    if (RENDERER_LOG) fs.appendFileSync(RENDERER_LOG, ts + ' ' + msg + '\n');
    console.error(msg);
  } catch (_) {}
});

// Global Electron switches (DPI, occlusion).
require('./window/windowSecurity');

const { createMainWindow } = require('./window/createMainWindow');

// IPC registrations — each file encapsulates one domain.
// SYS-006: core registrars are fail-fast — if any of them throws during
// register(), the app cannot function correctly, so we abort boot with
// a visible error dialog instead of limping along with a half-registered
// API surface. Non-core registrars log and continue.
// KGO7-004: the names + core flags live in ./ipcRegistrarNames.js, which
// the test harnesses import too. Duplicating this list is what let
// registerResetIpc / registerM3Ipc silently vanish from every harness.
const { IPC_REGISTRARS } = require('./ipcRegistrarNames');
const ipcRegistrars = IPC_REGISTRARS.map((r) => ({
  mod: require('./ipc/' + r.name),
  core: r.core,
  name: r.name,
}));

let mainWindow = null;

const getMainWindow = () => mainWindow;

app.whenReady().then(() => {
  // Ensure the effective output directory exists before the renderer's first
  // `fb:list`. Electron auto-creates `userData` but NOT a `generated`
  // subfolder under it; without this, a clean first launch shows
  // `ENOENT: ... scandir ...\generated` in the right-hand file browser
  // (H7-004). Best-effort: a read-only/permission failure is logged but
  // must not abort boot (the user can still pick a different folder).
  try {
    const cfgMod = require('../src/config');
    cfgMod.ensureOutputDir(cfgMod.read());
  } catch (e) {
    _queueLog('[main] ensureOutputDir failed: ' + (e && e.stack ? e.stack : String(e)));
    console.error('[main] ensureOutputDir failed:', e);
  }

  for (const entry of ipcRegistrars) {
    try { entry.mod.register({ appRoot: PARENT_ROOT, getMainWindow }); }
    catch (e) {
      const msg = '[main] IPC registrar failed: ' + (e && e.stack ? e.stack : String((e && e.message) || e));
      _queueLog(msg);
      console.error('[main] IPC registrar failed:', e);
      if (entry.core) {
        // SYS-006: fail-fast — a core registrar that throws means the app
        // would boot with a broken API surface. Abort with a visible error.
        const { dialog: dlg } = require('electron');
        try { dlg.showErrorBox('Startup Error', 'A core service failed to initialise. The application cannot continue.\n\n' + ((e && e.message) || String(e))); } catch (_) {}
        app.exit(1);
        return;
      }
    }
  }

  mainWindow = createMainWindow(PARENT_ROOT, {
    cancelActiveJobs: () => {
      try { require('../src/mmx').cancelAll(); } catch (_) {}
      // R6.6.1: also kill any backend processes registered with the
      // shared jobRegistry (Real-ESRGAN, IS-Net, Inpaint, Sharp).
      try { require('../src/jobRegistry').cancelAll(); } catch (_) {}
    },
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow(PARENT_ROOT, {
        cancelActiveJobs: () => {
          try { require('../src/mmx').cancelAll(); } catch (_) {}
          try { require('../src/jobRegistry').cancelAll(); } catch (_) {}
        },
      });
    }
  });
});

app.on('window-all-closed', () => {
  // R2.1 Phasenpruefung-of-Phasenpruefung (PP-1): on macOS, closing
  // the last window does NOT quit the app (Electron convention). The
  // before-quit handler is therefore NEVER called when the user
  // presses Cmd+W, and the session credential would survive in
  // memory until the user explicitly quits via Cmd+Q. Wipe the
  // store defensively here so the privacy contract "no credential
  // outlives the app surface" holds on every platform.
  try {
    const sessionStore = require('./services/SessionCredentialStore');
    sessionStore.clearSessionCredential();
  } catch (_) { /* best-effort */ }
  if (process.platform !== 'darwin') app.quit();
});

// R2.1 (PP-1 mirror): wipe the store on window 'close' as well. The
// window 'close' event fires BEFORE the renderer's last IPC handler
// can race with the wipe, so a renderer-fired `mmx:run:job` cannot
// re-set the credential after we've cleared it. We only register
// this if mainWindow exists (it does after whenReady).
function _wipeSessionStoreBestEffort() {
  try {
    const sessionStore = require('./services/SessionCredentialStore');
    sessionStore.clearSessionCredential();
  } catch (_) { /* best-effort */ }
}
app.on('browser-window-created', (_e, win) => {
  if (!win || win.isDestroyed()) return;
  win.on('close', _wipeSessionStoreBestEffort);
});

// Graceful shutdown: ask the renderer to flush in-flight job summaries,
// then cancel every active mmx proc. Best-effort — if the renderer
// doesn't respond or the procs don't exit in time, the app exits anyway.
let _shuttingDown = false;
app.on('before-quit', () => {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try {
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('app:before-quit', { graceMs: 500 }); } catch (_) {}
    }
  } catch (_) { /* best-effort */ }
  try {
    const { cancelAll } = require('../src/mmx');
    cancelAll();
  } catch (_) { /* best-effort */ }
  // R6.6.1: also kill any backend processes registered with the shared jobRegistry.
  try { require('../src/jobRegistry').cancelAll(); } catch (_) { /* best-effort */ }
  // R2.1: defensively wipe the in-memory session credential so a
  // crash-dump / process snapshot taken after this point never
  // contains the user's API key. Best-effort; the store is Main-side
  // and never throws on clear.
  _wipeSessionStoreBestEffort();
});

// R2.1 (PP-1 mirror): will-quit fires AFTER all windows are closed
// and just before the process exits. Wiping here catches the
// `before-quit → window-close → will-quit` race where the renderer
// could fire a `mmx:run:job` after the before-quit wipe but before
// the window is destroyed.
app.on('will-quit', _wipeSessionStoreBestEffort);
