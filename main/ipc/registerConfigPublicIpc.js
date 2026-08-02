// main/ipc/registerConfigPublicIpc.js
// P0-B (360° Audit C-001): secret-free config DTO for the renderer.
// `config:getPublic` returns everything EXCEPT the raw api_key. The renderer
// only needs to know WHETHER a key is set (hasApiKey) and a masked tail for
// display (apiKeyLast4). The raw key NEVER crosses the IPC boundary through
// this channel. Split out of registerConfigIpc.js (frozen size budget).

const cfgMod = require('../../src/config');
// P1-A (360° Audit H-001): secure IPC wrapper with sender/frame/origin validation.
const { secureHandle } = require('./secureHandle');
// B-006: one Main-side resolver for key presence (persisted OR session).
const { credentialPresence } = require('../services/credentialPresence');
// H-046 (_5 audit): canonical clamp for the safe numeric cost-cap field.
const { clampBatchMaxUnits } = require('../services/batchUnitsGate');

/**
 * @param {{ getMainWindow: () => (Electron.BrowserWindow|null) }} deps
 */
function register({ getMainWindow }) {
  secureHandle('config:getPublic', { getMainWindow }, () => {
    try {
      const c = cfgMod.read();
      const cfg = (c && typeof c === 'object') ? c : {};
      // B-006: hasApiKey must be true when EITHER a persisted key
      // (config.txt) OR a session-only key (SessionCredentialStore)
      // exists — otherwise "Don't save my API key" mode blocks every tab.
      const presence = credentialPresence(cfg);
      return {
        ok: true,
        hasApiKey: presence.hasApiKey,
        hasPersistedApiKey: presence.hasPersistedApiKey,
        hasSessionApiKey: presence.hasSessionApiKey,
        apiKeyLast4: presence.apiKeyLast4,
        output_dir: cfg.output_dir || '',
        report_dir: cfg.report_dir || '',
        region: cfg.region === 'cn' ? 'cn' : 'global',
        theme: cfg.theme === 'light' ? 'light' : 'dark',
        // H-046: safe numeric field — without it the renderer's cost gate
        // computed parseInt(undefined) || 200 and ignored the configured cap.
        batch_max_units: clampBatchMaxUnits(cfg.batch_max_units),
        styles: Array.isArray(cfg.styles) ? cfg.styles : [],
        external_tools: Array.isArray(cfg.external_tools) ? cfg.external_tools : [],
      };
    } catch (_) {
      return { ok: true, hasApiKey: false, hasPersistedApiKey: false, hasSessionApiKey: false, apiKeyLast4: '', output_dir: '', report_dir: '', region: 'global', theme: 'dark', batch_max_units: 200, styles: [], external_tools: [] };
    }
  });
}

module.exports = { register };
