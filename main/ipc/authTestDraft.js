// main/ipc/authTestDraft.js
// H-040 (_5 audit): "Test connection" must test the DRAFT key the user
// typed into the Settings field — not the previously-saved key. This
// module exports a registration helper that adds `mmx:authTestDraft`
// which accepts { draftKey } and probes it via `mmx quota`.
//
// Extracted from registerMmxIpc.js to stay under its frozen SIZE-BUDGET.

const { secureHandle } = require('./secureHandle');

/**
 * Register the `mmx:authTestDraft` IPC handler.
 * @param {{ getMainWindow: () => (Electron.BrowserWindow|null), runMmx: Function, sendLog: Function }} deps
 */
function registerAuthTestDraft({ getMainWindow, runMmx, sendLog }) {
  secureHandle('mmx:authTestDraft', { getMainWindow }, async (_evt, payload) => {
    try {
      const draftKey = payload && typeof payload.draftKey === 'string' ? payload.draftKey.trim() : '';
      if (!draftKey) {
        return { ok: false, error: 'No draft key provided. Enter a key first.', command: null };
      }
      // Basic shape check — MiniMax keys start with sk- and are long.
      if (draftKey.length < 10) {
        return { ok: false, error: 'Key looks too short to be valid.', command: null };
      }
      // Probe with `mmx quota` using the draft key directly (sessionOnly
      // so it never touches the persisted credential store).
      const r = await runMmx({ args: ['quota'], apiKey: draftKey, sessionOnly: true, onLog: sendLog });
      if (!r.command) {
        return { ok: false, error: r.stderr || 'mmx unavailable', command: null };
      }
      if (!r.ok) {
        let detail = r.stderr || r.stdout || `mmx exited with code ${r.code}`;
        detail = String(detail).replace(/^node\.exe\s*:\s*/gm, '').trim();
        return { ok: false, error: detail || `mmx exited with code ${r.code}`, command: r.command };
      }
      const parsed = r.parsed;
      if (parsed && typeof parsed === 'object' && parsed.base_resp) {
        const sc = parsed.base_resp.status_code;
        if (sc === 0) {
          return { ok: true, message: 'Draft key works. Quota snapshot loaded.', command: r.command };
        }
        return { ok: false, error: parsed.base_resp.status_msg || `API status_code ${sc}`, command: r.command };
      }
      return { ok: true, message: 'Draft key accepted by mmx.', command: r.command };
    } catch (e) {
      return { ok: false, error: e.message, command: null };
    }
  });
}

module.exports = { registerAuthTestDraft };
