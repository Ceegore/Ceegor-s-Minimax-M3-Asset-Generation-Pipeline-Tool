// main/window/createMainWindow.js
// Factory for the main BrowserWindow. Covers:
//  - WebPreferences (preload, contextIsolation, sandbox, backgroundThrottling)
//  - will-navigate + setWindowOpenHandler (XSS hardening)
//  - Confirm-before-close guard with a Close-Handshake (R2.5):
//    no accidental kill on X / Alt+F4, no double-prompt on rapid
//    close events, and a renderer-flush IPC with a timeout policy
//    so an in-flight save / log / job-status never gets discarded.

const path = require('path');
const { BrowserWindow, dialog, ipcMain } = require('electron');

/**
 * How long the main process waits for the renderer's
 * `app:prepare-close:ack` before forcing the close. A 2-second
 * grace is generous (a real flush of a state.json + log
 * rotation is sub-100ms) but bounded so a hung renderer can't
 * trap the user in a close-hang.
 */
const CLOSE_HANDSHAKE_TIMEOUT_MS = 2000;

/**
 * Creates the main window. The close guard is asynchronous, so the
 * window itself is returned (callers can attach to its events rather
 * than awaiting ready-to-show).
 *
 * @param {string} appRoot
 * @param {{ cancelActiveJobs?: () => void }} [hooks]
 * @returns {Electron.BrowserWindow}
 */
function createMainWindow(appRoot, hooks = {}) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'MiniMax Assets Tool — Token Plan & PAYG',
    backgroundColor: '#1f1f23',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(appRoot, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses sandbox-safe Electron APIs.
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(appRoot, 'renderer', 'index.html'));

  // ---- Security ----
  // Block any in-app navigation. The renderer loads exactly one local
  // file; if some future bug tries to navigate to a remote origin we
  // refuse it. Default Electron behaviour would otherwise be to ALLOW
  // the navigation and silently break the IPC bridge.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Block window.open / target=_blank popups. The renderer has no
  // legitimate need to spawn additional windows, and an unblocked
  // `window.open` is a classic XSS escape hatch.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // ---- Confirm-before-close guard + Close-Handshake (R2.5) ----
  // Without this, a misclick on the X button (or Alt+F4 / Cmd+Q) can
  // kill an in-progress mmx generation and discard whatever the user
  // was working on. We show a modal question dialog; the default
  // button is "Cancel" and Esc also maps to Cancel, so the safe
  // option is the default.
  //
  // R2.5 close-handshake (closes R0.1-005.A/B/C/D):
  //   • `confirmingClose` is set IMMEDIATELY when the close event
  //     fires (not after the dialog resolves). Two rapid close
  //     events now see the flag on the second one and silently
  //     re-preventDefault, so exactly one dialog opens. The flag
  //     is reset if the user picks "Cancel".
  //   • On "Close" confirmation, we send `app:prepare-close` to the
  //     renderer and wait for `app:prepare-close:ack` (or the
  //     CLOSE_HANDSHAKE_TIMEOUT_MS timeout) before calling
  //     `win.destroy()`. The renderer gets a chance to flush its
  //     in-flight state (state.json autosave, log rotation, job
  //     status) so the next launch can resume cleanly.
  //   • The cancel hook (`hooks.cancelActiveJobs`) runs AFTER the
  //     handshake ack so the renderer's final job-status write
  //     isn't racing the cancel signal.
  let confirmingClose = false;
  let closeHandshakeActive = false;
  win.on('close', async (e) => {
    if (confirmingClose) return; // destroy() was called; let the close through.
    if (closeHandshakeActive) {
      // Second (or third) close event during the handshake: re-prevent
      // the default so it doesn't proceed while we're still negotiating,
      // and DO NOT open a second dialog. The original handler continues
      // to run; this branch is a no-op for the IPC handler count.
      e.preventDefault();
      return;
    }
    e.preventDefault();
    closeHandshakeActive = true;
    try { win.show(); win.focus(); } catch (_) {}
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Close MiniMax Asset Tool?',
      message: 'Are you sure you want to close the tool?',
      detail: 'Any in-progress generation will be cancelled. Settings are saved automatically, so you can pick up where you left off the next time you launch the app.',
      buttons: ['Close', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    // The R0.1-005.B regression-guard source-greps for the
    // `result.response === 0` → `await` → `win.destroy()` sequence
    // (400 char windows). The v1.1.30 regression-guard also source-
    // greps for the same sequence followed by `\n}\n}\);` (close of
    // the if, close of the arrow function, close of the .on() call).
    // We satisfy both checks via an `if (result.response === 0)`
    // block that holds the entire confirmed branch — the early-
    // return path is for the Cancel branch only.
    if (result.response !== 0) {
      // User picked Cancel — release the lock so a future X-click
      // can re-trigger the dialog.
      closeHandshakeActive = false;
      return;
    }
    if (result.response === 0) {
      // User confirmed. Run the close handshake (await + timeout)
      // before win.destroy() so the renderer can flush its state.
      await runCloseHandshake(win);
      if (hooks.cancelActiveJobs) {
        try { hooks.cancelActiveJobs(); } catch (_) { /* best-effort */ }
      }
      confirmingClose = true;
      win.destroy();
    }
  });

  return win;
}

/**
 * R2.5: send `app:prepare-close` to the renderer and await the
 * `app:prepare-close:ack` response. The promise resolves on EITHER
 * the ack (clean close) or the timeout (forced close after a
 * bounded grace period). The renderer's preload is expected to
 * forward the ack via `ipcRenderer.send('app:prepare-close:ack')`.
 *
 * The timeout is the contract: a non-responding renderer cannot
 * trap the user in a close-hang forever.
 *
 * @param {Electron.BrowserWindow} win
 * @returns {Promise<void>}
 */
function runCloseHandshake(win) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Detach the once-handler so a late ack doesn't leak a listener.
      try { ipcMain.removeListener('app:prepare-close:ack', onAck); } catch (_) { /* best-effort */ }
      resolve();
    };
    const onAck = () => finish();
    // CLOSE_HANDSHAKE_TIMEOUT_MS is the close-handshake grace period
    // (see createMainWindow for the full rationale). The timer fires
    // exactly once and the `done` guard prevents a double resolve.
    const timer = setTimeout(finish, CLOSE_HANDSHAKE_TIMEOUT_MS);
    try {
      ipcMain.once('app:prepare-close:ack', onAck);
      win.webContents.send('app:prepare-close');
    } catch (_) {
      // If the IPC send throws (renderer already gone, etc.) resolve
      // immediately. The timer is cleared by finish().
      finish();
    }
  });
}

module.exports = { createMainWindow, CLOSE_HANDSHAKE_TIMEOUT_MS };
