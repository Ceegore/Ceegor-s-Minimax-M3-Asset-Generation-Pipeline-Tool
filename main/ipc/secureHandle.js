// main/ipc/secureHandle.js
// ============================================================================
// P1-A (360° Audit H-001): Central secure IPC wrapper.
//
// Every privileged IPC channel should use `secureHandle` instead of raw
// `ipcMain.handle`. The wrapper enforces:
//
//   1. Sender validation: event.sender must be the main window's webContents.
//      A compromised child frame, extension, or DevTools context cannot
//      invoke privileged handlers.
//   2. Frame validation: event.senderFrame must be the main frame (not an
//      iframe or worker context).
//   3. Origin validation: the sender's URL must be the app's own origin
//      (file:// or app://). Blocks injected content from other origins.
//   4. Payload size limit: serialized payload must not exceed maxPayloadBytes
//      (default 1 MB). Prevents OOM/DoS via oversized IPC messages.
//   5. Optional schema validation: if a `validate` function is provided,
//      the payload is checked before the handler runs.
//
// Usage:
//   const { secureHandle } = require('./secureHandle');
//   secureHandle('my:channel', { getMainWindow, maxPayloadBytes: 512*1024 }, handler);
//
// The handler signature is unchanged: (event, ...args) => any.
// ============================================================================

// NOTE: electron is required lazily inside secureHandle() (not at module
// scope) so unit tests that swap the electron mock in require.cache between
// register() calls always hit the CURRENT mock's ipcMain, even when this
// module stays cached across those swaps.

/** Default maximum serialized payload size (1 MB). */
const DEFAULT_MAX_PAYLOAD_BYTES = 1 * 1024 * 1024;

/**
 * Estimate the serialized size of a payload. Uses JSON.stringify length
 * as a proxy (the actual IPC serialization is structured clone, but JSON
 * length is a conservative upper bound for most payloads).
 * @param {*} payload
 * @returns {number}
 */
function estimatePayloadSize(payload) {
  if (payload === undefined || payload === null) return 0;
  try {
    return JSON.stringify(payload).length;
  } catch (_) {
    // Circular or non-serializable — treat as large to fail closed.
    return Infinity;
  }
}

/**
 * Register a secure IPC handler with sender/frame/origin/size validation.
 *
 * @param {string} channel - The IPC channel name.
 * @param {{
 *   getMainWindow: () => (Electron.BrowserWindow|null),
 *   maxPayloadBytes?: number,
 *   validate?: (payload: any) => {ok: boolean, error?: string},
 *   skipSenderCheck?: boolean
 * }} opts - Options. `skipSenderCheck` is for channels that must accept
 *   calls before the window exists (e.g. app lifecycle).
 * @param {Function} handler - The actual handler: (event, ...args) => any.
 */
function secureHandle(channel, opts, handler) {
  const { ipcMain } = require('electron');
  const {
    getMainWindow,
    maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
    validate = null,
    skipSenderCheck = false,
  } = opts || {};

  ipcMain.handle(channel, (event, ...args) => {
    // --- 1. Sender validation ---
    if (!skipSenderCheck) {
      const win = getMainWindow ? getMainWindow() : null;
      if (win && win.webContents && event && event.sender) {
        if (event.sender.id !== win.webContents.id) {
          return { ok: false, error: `IPC security: sender mismatch on '${channel}'` };
        }
        // --- 2. Frame validation ---
        if (event.senderFrame && win.webContents.mainFrame) {
          if (event.senderFrame.routingId !== win.webContents.mainFrame.routingId) {
            return { ok: false, error: `IPC security: non-main-frame sender on '${channel}'` };
          }
        }
      }
      // --- 3. Origin validation ---
      try {
        const url = (event && event.senderFrame)
          ? event.senderFrame.url
          : (event && event.sender && typeof event.sender.getURL === 'function')
            ? event.sender.getURL()
            : '';
        if (url && !url.startsWith('file://') && !url.startsWith('app://') && !url.startsWith('devtools://')) {
          return { ok: false, error: `IPC security: untrusted origin on '${channel}'` };
        }
      } catch (_) {
        // If we can't determine the URL, fail closed.
        return { ok: false, error: `IPC security: unable to verify origin on '${channel}'` };
      }
    }

    // --- 4. Payload size limit ---
    // Check the first argument (the primary payload) for size.
    if (args.length > 0 && maxPayloadBytes > 0) {
      const size = estimatePayloadSize(args[0]);
      if (size > maxPayloadBytes) {
        return { ok: false, error: `IPC security: payload too large on '${channel}' (${size} > ${maxPayloadBytes} bytes)` };
      }
    }

    // --- 5. Optional schema validation ---
    if (validate && args.length > 0) {
      const vResult = validate(args[0]);
      if (vResult && !vResult.ok) {
        return { ok: false, error: `IPC validation failed on '${channel}': ${vResult.error || 'invalid payload'}` };
      }
    }

    // --- Delegate to the actual handler ---
    return handler(event, ...args);
  });
}

module.exports = { secureHandle, DEFAULT_MAX_PAYLOAD_BYTES, estimatePayloadSize };
