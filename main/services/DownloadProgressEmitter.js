// main/services/DownloadProgressEmitter.js
// Throttle-Helfer für IPC-Progress-Events. Ohne Throttle würde jeder
// 64-KB-Chunk eine `webContents.send` auslösen → der Renderer
// hängt in Event-Handling für 90-MB-Dateien fest.
//
// Strategie: maximal ein Event pro 500 KB ODER pro 250 ms —
// was auch immer zuerst kommt.

const BYTE_THRESHOLD = 500 * 1024;
const TIME_THRESHOLD_MS = 250;

/**
 * Erzeugt einen Throttled-Sender, der `target.send(payload)` nur
 * dann aufruft, wenn seit dem letzten Send genug Bytes oder Zeit
 * vergangen sind. Das erste Event und das Abschluss-Event werden
 * **immer** durchgelassen.
 *
 * @param {(payload: any) => void} target  typischerweise `(p) => win.send(channel, p)`
 * @param {() => any} makeInitial           Funktion für das "start"-Event
 * @returns {(downloaded: number, total: number, isDone?: boolean) => void}
 */
function createProgressEmitter(target, makeInitial) {
  let lastSentBytes = 0;
  let lastSentTime = Date.now();
  let started = false;

  // Initial-Event (z. B. "starting") immer zuerst senden.
  try { target(makeInitial()); } catch (_) { /* ipc-Channel tot */ }
  started = true;

  return function emit(downloaded, total, isDone) {
    const now = Date.now();
    const byteDelta = downloaded - lastSentBytes;
    const timeDelta = now - lastSentTime;
    if (isDone || byteDelta >= BYTE_THRESHOLD || timeDelta >= TIME_THRESHOLD_MS) {
      lastSentBytes = downloaded;
      lastSentTime = now;
      try { target({ downloaded, total }); } catch (_) { /* ipc-Channel tot */ }
    }
  };
}

module.exports = { createProgressEmitter, BYTE_THRESHOLD, TIME_THRESHOLD_MS };
