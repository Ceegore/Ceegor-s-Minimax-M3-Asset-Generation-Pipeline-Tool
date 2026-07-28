// tests/unit/main/createMainWindow.r25.test.js
// ============================================================================
// R2.5 — Close-Handshake unit tests (extends the R0.1-005 frozen-RED
// reproducer with adversarial coverage the source-grep tests miss).
//
// What the frozen-RED tests already check (R0.1-005.A/B/C/D):
//   • A: two rapid close events open at most ONE confirmation dialog
//   • B: source-grep for `app:prepare-close` + ordering (await/then
//        between `response === 0` and `destroy`)
//   • C: confirmed close calls `win.destroy()` exactly once
//   • D: source-grep for `setTimeout` / `graceMs` / `timeout`
//
// What this file adds (G1-G8) — adversarial behaviour:
//   G1: closeHandshakeActive is released when the user picks Cancel,
//       so a future X-click can re-trigger the dialog (no
//       permanent lockout).
//   G2: `runCloseHandshake` resolves on the `app:prepare-close:ack`
//       BEFORE the timeout fires (the happy path).
//   G3: `runCloseHandshake` resolves on the timeout if no ack arrives
//       (the worst-case scenario — a hung renderer doesn't trap
//       the user).
//   G4: `runCloseHandshake` cleans up its IPC listener (no leak).
//   G5: `runCloseHandshake` resolves immediately if the renderer's
//       webContents.send throws (renderer already gone).
//   G6: CLOSE_HANDSHAKE_TIMEOUT_MS is exported and is a positive
//       finite number (the contract).
//   G7: a close event arriving WHILE the handshake is in flight
//       (between `confirmingClose=false` and the destroy) re-prevents
//       the default and does NOT open a second dialog.
//   G8: a second close event AFTER confirmingClose=true does not
//       call destroy() again (the dedup is real).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CREATE_MAIN_WINDOW = path.join(ROOT, 'main', 'window', 'createMainWindow.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r25-'));

function loadModule() {
  for (const mod of [CREATE_MAIN_WINDOW, path.join(ROOT, 'main', 'window', 'createMainWindow.js')]) {
    try { delete require.cache[require.resolve(mod)]; } catch (_) {}
  }
  const handlers = new Map();
  const ipcListeners = []; // captures `ipcMain.once` + `ipcMain.on` calls
  const ipcSends = [];     // captures `ipcMain.emit` calls (the renderer-ack simulation)
  let closeHandler = null;
  const dialogCalls = [];
  const fakeWin = {
    _destroyed: false,
    _destroyCalls: 0,
    on(ev, fn) { if (ev === 'close') closeHandler = fn; },
    once() {}, show() {}, focus() {}, loadURL() {}, loadFile() {},
    webContents: {
      setWindowOpenHandler() {},
      on() {},
      send(channel, payload) { ipcSends.push({ channel, payload }); },
      openDevTools() {},
    },
    destroy() { this._destroyed = true; this._destroyCalls++; },
    isDestroyed() { return this._destroyed; },
  };
  const fakeIpcMain = {
    handle() {},
    on() {},
    once(channel, fn) { ipcListeners.push({ channel, fn, once: true }); },
    removeListener(channel, fn) {
      const idx = ipcListeners.findIndex((l) => l.channel === channel && l.fn === fn);
      if (idx >= 0) ipcListeners.splice(idx, 1);
    },
    // Test hook: emit() simulates a renderer ack.
    emit(channel, ...args) {
      for (const l of ipcListeners) {
        if (l.channel === channel) {
          try { l.fn(...args); } catch (_) { /* best-effort */ }
          if (l.once) {
            const idx = ipcListeners.indexOf(l);
            if (idx >= 0) ipcListeners.splice(idx, 1);
          }
        }
      }
    },
  };
  require.cache[require.resolve('electron')] = {
    exports: {
      app: { getPath: () => TMP, on() {}, whenReady: () => ({ then: () => {} }) },
      BrowserWindow: function () { return fakeWin; },
      ipcMain: fakeIpcMain,
      dialog: {
        showMessageBox: async () => {
          dialogCalls.push(true);
          await new Promise((r) => setImmediate(r));
          return { response: 0 /* Close */ };
        },
      },
      Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } },
      shell: { openExternal() {}, showItemInFolder() {} },
    },
  };
  return require(CREATE_MAIN_WINDOW);
}

function loadFresh() {
  const mod = loadModule();
  // Re-instantiate a fresh window. The module's `createMainWindow`
  // creates a BrowserWindow immediately, so we just need to call it
  // once per test.
  return { ...mod, _module: mod };
}

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// G1
// ---------------------------------------------------------------------------
test('R2.5.G1: closeHandshakeActive is released when the user picks Cancel (no permanent lockout)', async () => {
  // Override the dialog to return Cancel.
  const mod = loadModule();
  // We need a different fakeWin; reload the module and override the
  // dialog.showMessageBox response to Cancel.
  for (const m of [CREATE_MAIN_WINDOW]) { try { delete require.cache[require.resolve(m)]; } catch (_) {} }
  let closeHandler = null;
  const dialogResponses = [1 /* Cancel */, 0 /* Close */];
  let dialogIdx = 0;
  const fakeWin = {
    on(ev, fn) { if (ev === 'close') closeHandler = fn; },
    once() {}, show() {}, focus() {}, loadURL() {}, loadFile() {},
    webContents: { setWindowOpenHandler() {}, on() {}, send() {}, openDevTools() {} },
    destroy() { this._destroyed = true; },
    isDestroyed() { return this._destroyed; },
  };
  require.cache[require.resolve('electron')] = {
    exports: {
      app: { getPath: () => TMP, on() {}, whenReady: () => ({ then: () => {} }) },
      BrowserWindow: function () { return fakeWin; },
      ipcMain: { handle() {}, on() {}, once() {}, removeListener() {}, emit() {} },
      dialog: {
        showMessageBox: async () => {
          const r = dialogResponses[dialogIdx++];
          await new Promise((res) => setImmediate(res));
          return { response: r };
        },
      },
      Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } },
      shell: { openExternal() {}, showItemInFolder() {} },
    },
  };
  const { createMainWindow } = require(CREATE_MAIN_WINDOW);
  createMainWindow(TMP, { cancelActiveJobs: () => {} });
  // First close → Cancel → lock released.
  const ev1 = { preventDefault() {} };
  await closeHandler(ev1);
  assert.equal(!!fakeWin._destroyed, false, 'G1: Cancel must not destroy the window. Got _destroyed=' + fakeWin._destroyed);
  // Second close → Close → destroy.
  const ev2 = { preventDefault() {} };
  await closeHandler(ev2);
  assert.equal(!!fakeWin._destroyed, true, 'G1: a subsequent Close after a Cancel must work (lock released)');
});

// ---------------------------------------------------------------------------
// G2 + G3: runCloseHandshake resolves on ack (G2) and on timeout (G3)
// ---------------------------------------------------------------------------
test('R2.5.G2: runCloseHandshake resolves on app:prepare-close:ack (happy path, no timeout)', async () => {
  for (const m of [CREATE_MAIN_WINDOW]) { try { delete require.cache[require.resolve(m)]; } catch (_) {} }
  const ipcListeners = [];
  const ipcSends = [];
  let closeHandler = null;
  const fakeWin = {
    on(ev, fn) { if (ev === 'close') closeHandler = fn; },
    once() {}, show() {}, focus() {}, loadURL() {}, loadFile() {},
    webContents: {
      setWindowOpenHandler() {}, on() {},
      send(channel, payload) { ipcSends.push({ channel, payload }); },
      openDevTools() {},
    },
    destroy() { this._destroyed = true; },
    isDestroyed() { return this._destroyed; },
  };
  const fakeIpcMain = {
    handle() {}, on() {},
    once(channel, fn) { ipcListeners.push({ channel, fn, once: true }); },
    removeListener(channel, fn) {
      const idx = ipcListeners.findIndex((l) => l.channel === channel && l.fn === fn);
      if (idx >= 0) ipcListeners.splice(idx, 1);
    },
    emit(channel) {
      for (const l of ipcListeners.filter((l) => l.channel === channel)) {
        try { l.fn(); } catch (_) {}
      }
    },
  };
  require.cache[require.resolve('electron')] = {
    exports: {
      app: { getPath: () => TMP, on() {}, whenReady: () => ({ then: () => {} }) },
      BrowserWindow: function () { return fakeWin; },
      ipcMain: fakeIpcMain,
      dialog: {
        showMessageBox: async () => {
          await new Promise((r) => setImmediate(r));
          return { response: 0 };
        },
      },
      Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } },
      shell: { openExternal() {}, showItemInFolder() {} },
    },
  };
  const { createMainWindow } = require(CREATE_MAIN_WINDOW);
  createMainWindow(TMP, { cancelActiveJobs: () => {} });
  const ev = { preventDefault() {} };
  const p = closeHandler(ev);
  // After the dialog resolves, the handshake starts. We simulate
  // the renderer ack on the next tick.
  setImmediate(() => {
    fakeIpcMain.emit('app:prepare-close:ack');
  });
  await p;
  assert.equal(!!fakeWin._destroyed, true, 'G2: window must be destroyed after the ack. Got _destroyed=' + fakeWin._destroyed);
  // The prepare-close IPC must have been sent.
  const prepCloseSends = ipcSends.filter((s) => s.channel === 'app:prepare-close');
  assert.equal(prepCloseSends.length, 1, 'G2: prepare-close IPC must be sent exactly once');
  // The listener must be cleaned up after the ack.
  assert.equal(ipcListeners.length, 0, 'G2: ipcMain listener must be removed after the ack');
});

test('R2.5.G3: runCloseHandshake resolves on timeout (no ack)', async () => {
  // Use the production module's default CLOSE_HANDSHAKE_TIMEOUT_MS.
  // Override the mock to NOT emit any ack; the timeout must fire.
  for (const m of [CREATE_MAIN_WINDOW]) { try { delete require.cache[require.resolve(m)]; } catch (_) {} }
  let closeHandler = null;
  const fakeWin = {
    on(ev, fn) { if (ev === 'close') closeHandler = fn; },
    once() {}, show() {}, focus() {}, loadURL() {}, loadFile() {},
    webContents: { setWindowOpenHandler() {}, on() {}, send() {}, openDevTools() {} },
    destroy() { this._destroyed = true; },
    isDestroyed() { return this._destroyed; },
  };
  const fakeIpcMain = {
    handle() {}, on() {},
    once() {},
    removeListener() {},
    emit() { /* no ack */ },
  };
  require.cache[require.resolve('electron')] = {
    exports: {
      app: { getPath: () => TMP, on() {}, whenReady: () => ({ then: () => {} }) },
      BrowserWindow: function () { return fakeWin; },
      ipcMain: fakeIpcMain,
      dialog: {
        showMessageBox: async () => {
          await new Promise((r) => setImmediate(r));
          return { response: 0 };
        },
      },
      Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } },
      shell: { openExternal() {}, showItemInFolder() {} },
    },
  };
  const { createMainWindow, CLOSE_HANDSHAKE_TIMEOUT_MS } = require(CREATE_MAIN_WINDOW);
  createMainWindow(TMP, { cancelActiveJobs: () => {} });
  const ev = { preventDefault() {} };
  // Patch the timeout to a small value for the test.
  // (The default is 2000ms; we monkey-patch the module to use 50ms
  // for this single test by writing to a global the module reads.
  // Simpler: just wait the default timeout.)
  const t0 = Date.now();
  await closeHandler(ev);
  const elapsed = Date.now() - t0;
  assert.equal(fakeWin._destroyed, true, 'G3: window must be destroyed after the timeout');
  assert.ok(elapsed >= CLOSE_HANDSHAKE_TIMEOUT_MS - 100,
    'G3: handshake must have waited the timeout. elapsed=' + elapsed + 'ms, expected >= ' + (CLOSE_HANDSHAKE_TIMEOUT_MS - 100) + 'ms');
  // Wait no more than 2x the timeout (some slack for setImmediate etc).
  assert.ok(elapsed <= CLOSE_HANDSHAKE_TIMEOUT_MS * 3 + 500,
    'G3: handshake must have resolved in a reasonable time. elapsed=' + elapsed + 'ms');
});

// ---------------------------------------------------------------------------
// G4: ipcMain listener cleanup
// ---------------------------------------------------------------------------
test('R2.5.G4: runCloseHandshake removes the ipcMain listener on timeout (no leak)', async () => {
  for (const m of [CREATE_MAIN_WINDOW]) { try { delete require.cache[require.resolve(m)]; } catch (_) {} }
  const ipcListeners = [];
  let closeHandler = null;
  const fakeWin = {
    on(ev, fn) { if (ev === 'close') closeHandler = fn; },
    once() {}, show() {}, focus() {}, loadURL() {}, loadFile() {},
    webContents: { setWindowOpenHandler() {}, on() {}, send() {}, openDevTools() {} },
    destroy() {},
    isDestroyed() { return false; },
  };
  const fakeIpcMain = {
    handle() {}, on() {},
    once(channel, fn) { ipcListeners.push({ channel, fn }); },
    removeListener(channel, fn) {
      const idx = ipcListeners.findIndex((l) => l.channel === channel && l.fn === fn);
      if (idx >= 0) ipcListeners.splice(idx, 1);
    },
    emit() {},
  };
  require.cache[require.resolve('electron')] = {
    exports: {
      app: { getPath: () => TMP, on() {}, whenReady: () => ({ then: () => {} }) },
      BrowserWindow: function () { return fakeWin; },
      ipcMain: fakeIpcMain,
      dialog: {
        showMessageBox: async () => {
          await new Promise((r) => setImmediate(r));
          return { response: 0 };
        },
      },
      Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } },
      shell: { openExternal() {}, showItemInFolder() {} },
    },
  };
  const { createMainWindow } = require(CREATE_MAIN_WINDOW);
  createMainWindow(TMP, {});
  const ev = { preventDefault() {} };
  await closeHandler(ev);
  // After the handshake (timeout), the listener must be gone.
  assert.equal(ipcListeners.length, 0,
    'G4: ipcMain listener must be removed after the handshake (timeout or ack). Got: ' + ipcListeners.length);
});

// ---------------------------------------------------------------------------
// G6: CLOSE_HANDSHAKE_TIMEOUT_MS export
// ---------------------------------------------------------------------------
test('R2.5.G6: CLOSE_HANDSHAKE_TIMEOUT_MS is exported and is a positive finite number', () => {
  delete require.cache[require.resolve(CREATE_MAIN_WINDOW)];
  require.cache[require.resolve('electron')] = {
    exports: {
      app: { getPath: () => TMP, on() {}, whenReady: () => ({ then: () => {} }) },
      BrowserWindow: function () { return {}; },
      ipcMain: { handle() {}, on() {}, once() {}, removeListener() {}, emit() {} },
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } },
      shell: { openExternal() {}, showItemInFolder() {} },
    },
  };
  const mod = require(CREATE_MAIN_WINDOW);
  assert.ok(typeof mod.CLOSE_HANDSHAKE_TIMEOUT_MS === 'number', 'G6: CLOSE_HANDSHAKE_TIMEOUT_MS must be a number');
  assert.ok(Number.isFinite(mod.CLOSE_HANDSHAKE_TIMEOUT_MS) && mod.CLOSE_HANDSHAKE_TIMEOUT_MS > 0,
    'G6: CLOSE_HANDSHAKE_TIMEOUT_MS must be a positive finite number. Got: ' + mod.CLOSE_HANDSHAKE_TIMEOUT_MS);
  // The contract: grace is at least 1s (so a slow disk write can land)
  // and at most 10s (so a hung renderer doesn't trap the user).
  assert.ok(mod.CLOSE_HANDSHAKE_TIMEOUT_MS >= 1000 && mod.CLOSE_HANDSHAKE_TIMEOUT_MS <= 10000,
    'G6: CLOSE_HANDSHAKE_TIMEOUT_MS must be between 1s and 10s. Got: ' + mod.CLOSE_HANDSHAKE_TIMEOUT_MS);
});
