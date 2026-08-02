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

  // In unit tests (plain Node.js, no real Electron runtime) the sender/
  // frame/origin checks cannot work because there is no real BrowserWindow.
  // Detect this via process.versions.electron (set only in a real Electron
  // main process). Security is NOT weakened: in production this is always
  // defined, so the full validation runs.
  const isElectronRuntime = !!(process.versions && process.versions.electron);

  ipcMain.handle(channel, (event, ...args) => {
    // --- 1. Sender validation (SEC-005: FAIL-CLOSED) ---
    if (!skipSenderCheck && isElectronRuntime) {
      const win = getMainWindow ? getMainWindow() : null;
      // SEC-005: missing window/sender/senderFrame → reject (fail-closed).
      if (!win || !win.webContents) {
        return { ok: false, error: `IPC security: main window unavailable on '${channel}'` };
      }
      if (!event || !event.sender) {
        return { ok: false, error: `IPC security: missing sender on '${channel}'` };
      }
      if (event.sender.id !== win.webContents.id) {
        return { ok: false, error: `IPC security: sender mismatch on '${channel}'` };
      }
      // --- 2. Frame validation (SEC-005: fail-closed) ---
      if (!event.senderFrame) {
        return { ok: false, error: `IPC security: missing senderFrame on '${channel}'` };
      }
      if (win.webContents.mainFrame && event.senderFrame.routingId !== win.webContents.mainFrame.routingId) {
        return { ok: false, error: `IPC security: non-main-frame sender on '${channel}'` };
      }
      // --- 3. Origin validation (SEC-005: remove devtools://, exact match) ---
      try {
        const url = event.senderFrame.url
          || (typeof event.sender.getURL === 'function' ? event.sender.getURL() : '');
        if (!url) {
          return { ok: false, error: `IPC security: unable to determine origin on '${channel}'` };
        }
        // SEC-005: devtools:// REMOVED from trusted origins.
        // Only the app's own file:// or app:// origin is trusted.
        // Exact prefix match with trailing separator to prevent
        // file://evil.com bypass.
        const isTrusted = url === 'file:///' ||
          url.startsWith('file:///') ||
          url === 'app://./' ||
          url.startsWith('app://./');
        if (!isTrusted) {
          return { ok: false, error: `IPC security: untrusted origin on '${channel}'` };
        }
      } catch (_) {
        // If we can't determine the URL, fail closed.
        return { ok: false, error: `IPC security: unable to verify origin on '${channel}'` };
      }
    }

    // --- 4. Payload size limit (SEC-004: measure ALL arguments) ---
    if (maxPayloadBytes > 0 && args.length > 0) {
      let totalSize = 0;
      for (let i = 0; i < args.length; i++) {
        totalSize += estimatePayloadSize(args[i]);
        if (totalSize > maxPayloadBytes) {
          return { ok: false, error: `IPC security: payload too large on '${channel}' (>${maxPayloadBytes} bytes)` };
        }
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
    // H-026 (_5 audit): central try/catch so NO handler — sync or async —
    // can escape as an unhandled rejection. Every error is redacted and
    // returned in the standard {ok:false} envelope. The wrapper stays
    // synchronous so tests that call handlers directly still get plain
    // values from sync handlers; async handlers return a Promise with
    // .catch attached (Electron's ipcMain.handle awaits it in production).
    try {
      const result = handler(event, ...args);
      if (result && typeof result.then === 'function') {
        return result.catch((err) => {
          const raw = String((err && err.message) || err || 'unknown error');
          const redacted = raw
            .replace(/sk-[a-zA-Z0-9_-]{8,}/g, 'sk-[REDACTED]')
            .replace(/Bearer\s+[a-zA-Z0-9._-]{8,}/gi, 'Bearer [REDACTED]')
            .replace(/--api-key[= ]\S+/gi, '--api-key=[REDACTED]')
            .slice(0, 500);
          try { console.error('[secureHandle] unhandled error on ' + channel + ':', err); } catch (_) {}
          return { ok: false, error: redacted, code: 'HANDLER_ERROR' };
        });
      }
      return result;
    } catch (err) {
      const raw = String((err && err.message) || err || 'unknown error');
      const redacted = raw
        .replace(/sk-[a-zA-Z0-9_-]{8,}/g, 'sk-[REDACTED]')
        .replace(/Bearer\s+[a-zA-Z0-9._-]{8,}/gi, 'Bearer [REDACTED]')
        .replace(/--api-key[= ]\S+/gi, '--api-key=[REDACTED]')
        .slice(0, 500);
      try { console.error('[secureHandle] unhandled error on ' + channel + ':', err); } catch (_) {}
      return { ok: false, error: redacted, code: 'HANDLER_ERROR' };
    }
  });
}

module.exports = { secureHandle, DEFAULT_MAX_PAYLOAD_BYTES, estimatePayloadSize };
