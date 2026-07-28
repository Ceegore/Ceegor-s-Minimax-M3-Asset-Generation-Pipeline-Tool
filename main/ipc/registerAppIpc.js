// main/ipc/registerAppIpc.js
// IPC-Handler: `app:version` (Renderer liest die Build-Version aus package.json).

const { ipcMain } = require('electron');
const path = require('path');

/**
 * @param {{ appRoot: string }} deps
 */
function register({ appRoot }) {
  ipcMain.handle('app:version', () => {
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
