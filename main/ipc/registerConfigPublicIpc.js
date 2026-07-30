// main/ipc/registerConfigPublicIpc.js
// P0-B (360° Audit C-001): secret-free config DTO for the renderer.
// `config:getPublic` returns everything EXCEPT the raw api_key. The renderer
// only needs to know WHETHER a key is set (hasApiKey) and a masked tail for
// display (apiKeyLast4). The raw key NEVER crosses the IPC boundary through
// this channel. Split out of registerConfigIpc.js (frozen size budget).

const cfgMod = require('../../src/config');
// P1-A (360° Audit H-001): secure IPC wrapper with sender/frame/origin validation.
const { secureHandle } = require('./secureHandle');

/**
 * @param {{ getMainWindow: () => (Electron.BrowserWindow|null) }} deps
 */
function register({ getMainWindow }) {
  secureHandle('config:getPublic', { getMainWindow }, () => {
    try {
      const c = cfgMod.read();
      const cfg = (c && typeof c === 'object') ? c : {};
      const key = typeof cfg.api_key === 'string' ? cfg.api_key : '';
      return {
        ok: true,
        hasApiKey: key.length > 0,
        apiKeyLast4: key.length >= 4 ? key.slice(-4) : '',
        output_dir: cfg.output_dir || '',
        report_dir: cfg.report_dir || '',
        region: cfg.region === 'cn' ? 'cn' : 'global',
        theme: cfg.theme === 'light' ? 'light' : 'dark',
        styles: Array.isArray(cfg.styles) ? cfg.styles : [],
        external_tools: Array.isArray(cfg.external_tools) ? cfg.external_tools : [],
      };
    } catch (_) {
      return { ok: true, hasApiKey: false, apiKeyLast4: '', output_dir: '', report_dir: '', region: 'global', theme: 'dark', styles: [], external_tools: [] };
    }
  });
}

module.exports = { register };
