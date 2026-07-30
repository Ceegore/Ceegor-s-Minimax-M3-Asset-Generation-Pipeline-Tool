// main/ipc/registerAppIpc.js
// IPC-Handler: `app:version` (Renderer liest die Build-Version aus package.json).

const { ipcMain } = require('electron');
const path = require('path');
// P1-A (360° Audit H-001): secure IPC wrapper.
const { secureHandle } = require('./secureHandle');

/**
 * @param {{ appRoot: string, getMainWindow: () => (Electron.BrowserWindow|null) }} deps
 */
function register({ appRoot, getMainWindow }) {
  secureHandle('app:version', { getMainWindow }, () => {
    try {
      const pkg = require(path.join(appRoot, 'package.json'));
      return {
        version: pkg.version || 'unknown',
        name: pkg.name || '',
        productName: (pkg.build && pkg.build.productName) || '',
      };
    } catch (e) {
      return { version: 'unknown', name: '', productName: '', error: String((e && e.message) || e) };
    }
  });
}

module.exports = { register };
