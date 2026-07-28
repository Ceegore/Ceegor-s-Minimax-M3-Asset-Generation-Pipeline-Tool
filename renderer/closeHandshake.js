// renderer/closeHandshake.js
// ============================================================================
// R2.5 — Renderer-side handler for the `app:prepare-close` IPC. When
// the main process sends `app:prepare-close` (after the user
// confirmed the close dialog), the renderer flushes any pending
// state-save and then acks via `window.api.ackPrepareClose()`. The
// main waits up to CLOSE_HANDSHAKE_TIMEOUT_MS (2s) for the ack, so
// a hung renderer can never trap the user in a close-hang. The
// flush is best-effort: a failed save still acks so the main can
// proceed with the destroy.
//
// Extracted from renderer/app.js to keep that file under its
// frozen 1892-LOC SIZE-BUDGET (the close-handshake handler + its
// JSDoc comment is 24 lines that don't belong in the boot
// orchestrator).
// ============================================================================

/**
 * Register the close-handshake handler. Idempotent — calling
 * multiple times is a no-op (the IPC listener attaches once and
 * `removeListener` cleans up on next registration).
 *
 * @param {{ onPrepareClose: (cb: () => void) => () => void, ackPrepareClose: () => void }} api
 *        The window.api subset needed for the handshake. Pass
 *        `window.api` directly.
 */
function installCloseHandshake(api) {
  if (!api || typeof api.onPrepareClose !== 'function') return;
  if (typeof api.ackPrepareClose !== 'function') return;
  api.onPrepareClose(() => {
    // BUG #10 fix: the ack must WAIT for the pending state-save flush.
    // Pre-fix, scheduleStateSave() was fired (a 500 ms-debounced write)
    // and the ack went out immediately — main destroys the window on
    // ack (createMainWindow), so the debounced saveAllStates never ran
    // and the final state change was lost on every edit-then-quit.
    // scheduleStateSave() returns a promise that resolves once the
    // debounced write completes (or right away when nothing is
    // pending); 500 ms + one write fits the main's 2 s budget. A
    // failed save still acks (best-effort, unchanged contract).
    const ack = () => {
      try { api.ackPrepareClose(); } catch (_) { /* best-effort; the main's timeout covers us */ }
    };
    try {
      const p = (typeof scheduleStateSave === 'function') ? scheduleStateSave() : null;
      if (p && typeof p.then === 'function') { p.then(ack, ack); } else { ack(); }
    } catch (_) { ack(); }
  });
}

// Expose to the renderer's global scope. The renderer is a
// non-module script context (no `require`); a `globalThis.install…`
// bridge is the simplest way to make the function callable from
// app.js without inflating the bundle.
if (typeof globalThis !== 'undefined') {
  globalThis.installCloseHandshake = installCloseHandshake;
}
