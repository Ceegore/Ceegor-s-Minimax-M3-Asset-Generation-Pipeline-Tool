// tests/unit/security/closeFlush.security.test.js
// ============================================================================
// R0.1-005 — Reproduktionsgate für SYS-005 (360°-Audit design contract §5)
//
// Invariante:
//   1. Zwei schnelle Close-Events dürfen NICHT zwei Bestätigungsdialoge
//      öffnen (Doppelprompt).
//   2. Vor `win.destroy()` muss der Main-Prozess dem Renderer Zeit
//      geben, hängigen State (in-flight Save, Logs, Job-Status) zu
//      flushen. Ein blinder `destroy()`-Aufruf verwirft potenziell
//      letzte, nicht persistierte UI-Zustände.
//
// Heute:
//   • `createMainWindow.js` setzt `confirmingClose=true` NUR NACHDEM
//     `dialog.showMessageBox` resolved hat. Während des awaits ist
//     die Flag noch `false`, und ein zweites close-Event passiert
//     die Guard ungehindert → zwei Dialoge.
//   • `createMainWindow.js` ruft `win.destroy()` direkt nach
//     `cancelActiveJobs()`. Es gibt keinen `app:prepare-close` IPC,
//     kein `await saveAllStates()`, keinen Timeout → Renderer-State
//     kann verloren gehen.
//
// Diese Tests sind ROT heute; nach R2.5 (Close-Handshake) müssen sie
// GRÜN sein.
// Schreibt NUR in OS-Temp (kein tatsächlicher App-Shutdown).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CREATE_MAIN_WINDOW = path.join(ROOT, 'main', 'window', 'createMainWindow.js');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r01-sys005-'));

test.after(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
});

// Hilfsfunktion: lädt `createMainWindow.createMainWindow` mit gemockten
// electron-Anhängigkeiten. Die Funktion registriert `win.on('close', ...)`
// und übergibt ein fake `win`-Objekt. Wir können close-Events triggern
// und die Bestätigungsdialog-Antwort kontrollieren.
function loadCreateMainWindow({ dialogResponse }) {
  for (const mod of [CREATE_MAIN_WINDOW, path.join(ROOT, 'main', 'window', 'createMainWindow.js')]) {
    try { delete require.cache[require.resolve(mod)]; } catch (_) {}
  }
  const handlers = new Map();
  let closeHandler = null;
  const dialogPromises = [];
  const fakeWin = {
    _destroyed: false,
    _destroyCalls: 0,
    on(ev, fn) { if (ev === 'close') closeHandler = fn; },
    once() {}, show() {}, focus() {}, loadURL() {}, loadFile() {},
    webContents: {
      setWindowOpenHandler() {},
      on() {},
      send(channel, payload) { handlers.set(channel, payload); },
      openDevTools() {},
    },
    destroy() { this._destroyed = true; this._destroyCalls++; },
    isDestroyed() { return this._destroyed; },
  };
  const fakeIpcMain = { handle() {}, on() {} };
  require.cache[require.resolve('electron')] = {
    exports: {
      app: { getPath: () => TMP_HOME, on() {}, whenReady: () => ({ then: () => {} }) },
      BrowserWindow: function () { return fakeWin; },
      ipcMain: fakeIpcMain,
      dialog: {
        showMessageBox: async () => {
          dialogPromises.push(true);
          // Simuliert die Latenz eines echten Modal-Dialogs.
          await new Promise(r => setImmediate(r));
          return dialogResponse;
        },
      },
      Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } },
      shell: { openExternal() {}, showItemInFolder() {} },
    },
  };
  const { createMainWindow } = require(CREATE_MAIN_WINDOW);
  createMainWindow(TMP_HOME, { cancelActiveJobs: () => {} });
  return { closeHandler, fakeWin, dialogPromises };
}

function srcBody() {
  return fs.readFileSync(CREATE_MAIN_WINDOW, 'utf8');
}

// ---------------------------------------------------------------------------
// Test A: Zwei schnelle close-Events öffnen heute zwei Dialoge. SOLL:
// genau ein Dialog, der zweite Event wird ignoriert.
// ---------------------------------------------------------------------------
test('R0.1-005.A: two rapid close events must open at most ONE confirmation dialog', async () => {
  // Beide Events wählen "Cancel" (response !== 0), damit destroy
  // nicht aufgerufen wird und wir sauber testen können.
  const { closeHandler, dialogPromises } = loadCreateMainWindow({ dialogResponse: { response: 1 /* Cancel */ } });
  // close-Event-Payload: e.preventDefault() muss aufgerufen werden,
  // damit der Default-Destroy nicht greift.
  const preventCount = { n: 0 };
  const ev1 = { preventDefault: () => { preventCount.n++; } };
  const ev2 = { preventDefault: () => { preventCount.n++; } };
  // Zwei Events "gleichzeitig" triggern.
  const p1 = closeHandler(ev1);
  const p2 = closeHandler(ev2);
  await Promise.all([p1, p2]);
  // Erwartung: genau 1 Dialog.
  assert.equal(dialogPromises.length, 1,
    'SYS-005 confirmed: two close events opened ' + dialogPromises.length + ' confirmation dialogs ' +
    '(target: exactly one). The lock `confirmingClose=true` is set AFTER dialog resolves, leaving the guard open during the await.');
});

// ---------------------------------------------------------------------------
// Test B: Vor `win.destroy()` muss ein Renderer-Flush-Handshake
// stattfinden. Heute: kein `app:prepare-close` (oder gleichwertiger)
// IPC an den Renderer, kein `await saveAllStates()`.
// ---------------------------------------------------------------------------
test('R0.1-005.B: close-confirmed must trigger a "prepare-close" IPC to the renderer and await flush', async () => {
  // User klickt "Close" (response === 0).
  const { closeHandler, fakeWin } = loadCreateMainWindow({ dialogResponse: { response: 0 /* Close */ } });
  const ev = { preventDefault: () => {} };
  await closeHandler(ev);
  // SOLL: vor destroy() muss ein prepare-close-IPC an den Renderer
  // gesendet worden sein und das ack muss abgewartet werden.
  const s = srcBody();
  const hasPrepareClose = /app:prepare-close|prepare-close|prepareClose|saveAllStates|flushState/i.test(s);
  assert.equal(hasPrepareClose, true,
    'SYS-005 fix: createMainWindow must send a "prepare-close" (or equivalent) IPC to the renderer and await a flush ack before win.destroy(). ' +
    'Today: win.destroy() is called immediately after cancelActiveJobs(); renderer state in flight is discarded.');
  // Zusatz: destroy() darf erst NACH dem Ack aufgerufen werden.
  // Wir prüfen das Source-Pattern: nach der dialog-Bestätigung folgt
  // ein await / then, BEVOR destroy() aufgerufen wird.
  const properOrdering = /response\s*===\s*0[\s\S]{0,400}?(?:await|then)[\s\S]{0,400}?destroy/.test(s);
  assert.equal(properOrdering, true,
    'SYS-005 fix: destroy() must be called AFTER a renderer flush (await/then between dialog-confirm and destroy).');
});

// ---------------------------------------------------------------------------
// Test C: Doppel-Confirm (zwei Mal response:0) darf trotzdem nur
// genau ein destroy() auslösen.
// ---------------------------------------------------------------------------
test('R0.1-005.C: a confirmed close must call win.destroy() exactly once (no double-destroy)', async () => {
  const { closeHandler, fakeWin } = loadCreateMainWindow({ dialogResponse: { response: 0 } });
  // Erster Close → Confirm.
  await closeHandler({ preventDefault: () => {} });
  // Zweiter Close (z.B. App-Menü "Quit" parallel zu X-Klick).
  // confirmingClose sollte jetzt true sein; der zweite Event MUSS
  // ein No-op sein.
  const callsBefore = fakeWin._destroyCalls;
  await closeHandler({ preventDefault: () => {} });
  const callsAfter = fakeWin._destroyCalls;
  assert.equal(callsAfter - callsBefore, 0,
    'SYS-005 fix: a second close event during the confirmed-shutdown must NOT call win.destroy() again; got ' +
    (callsAfter - callsBefore) + ' extra destroy calls');
});

// ---------------------------------------------------------------------------
// Test D: Disk-Fehler beim Renderer-Flush dürfen den Close-Hang
// nicht endlos laufen lassen. SOLL: Timeout-Policy (z.B. 2 s) und
// sichtbarer Fehler. Heute: kein Timeout, weil kein Flush-Handshake
// überhaupt existiert.
// ---------------------------------------------------------------------------
test('R0.1-005.D: a close handshake must have a timeout policy (no infinite hang on disk error)', () => {
  const s = srcBody();
  // Der Close-Handler MUSS einen expliziten Timeout / eine
  // TimeoutPolicy referenzieren, die ein endloses Hängen verhindert.
  const hasTimeout = /setTimeout|graceMs|timeout/i.test(s);
  assert.equal(hasTimeout, true,
    'SYS-005 fix: createMainWindow must define a timeout policy for the close handshake (e.g. graceMs / setTimeout) so a non-responding renderer cannot trap the app in a close-hang.');
});
