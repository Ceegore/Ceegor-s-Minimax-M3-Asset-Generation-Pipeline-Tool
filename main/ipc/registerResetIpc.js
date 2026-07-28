// main/ipc/registerResetIpc.js
// "Delete all local data" — deletes ONLY the tool's own settings/state files
// (+ the mmx CLI api_key). NEVER the user's generated assets.
'use strict';
const { ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { configDir } = require('../../src/config');
const { clearApiKeyFromMmxCliConfig } = require('../../src/mmxApiKeySync');

// Deletes ONLY the tool's own settings/state files (+ the mmx CLI api_key).
// NEVER the user's generated assets. Returns a per-file result so the UI
// reports partial failures honestly instead of claiming a clean reset.
function deleteLocalDataFiles() {
  const dir = configDir();
  const results = [];
  const bases = ['config.txt', 'state.json', 'batches.json', 'state.jobs.archive.jsonl'];
  try {
    const entries = fs.readdirSync(dir);
    for (const base of bases) {
      // Match the file AND its temp/backup siblings (base.tmp-*, base.corrupt-*).
      const matches = entries.filter((e) => e === base || e.startsWith(base + '.'));
      if (!matches.length) { results.push({ file: base, ok: true, skipped: 'absent' }); continue; }
      for (const m of matches) {
        try { fs.unlinkSync(path.join(dir, m)); results.push({ file: m, ok: true }); }
        catch (e) { results.push({ file: m, ok: false, error: String((e && e.message) || e) }); }
      }
    }
  } catch (e) {
    results.push({ file: dir, ok: false, error: 'readdir failed: ' + String((e && e.message) || e) });
  }
  try { results.push({ file: '~/.mmx/config.json (api_key)', ok: clearApiKeyFromMmxCliConfig() }); }
  catch (e) { results.push({ file: '~/.mmx/config.json', ok: false, error: String((e && e.message) || e) }); }
  return { ok: results.every((r) => r.ok), results };
}

function register() {
  ipcMain.handle('app:resetAllData', () => deleteLocalDataFiles());

  // Plain relaunch must never delete user data.
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  // Separate destructive handler so the renderer can show the result BEFORE relaunching.
  // Re-run deletion immediately before the relaunch in case a debounced state
  // save fires after the initial reset.
  // Between `app:resetAllData` and `app:relaunch` the renderer is still alive
  // and its 500 ms-debounced state save can fire (it writes state.json back
  // from the in-memory snapshot), which is why settings appeared to "survive"
  // a reset. Re-deleting at the very last moment — right before app.exit(0)
  // tears the process down — guarantees the on-disk data is gone no matter
  // what the renderer flushed in that window.
  ipcMain.handle('app:resetAndRelaunch', () => {
    try { deleteLocalDataFiles(); } catch (_) { /* best-effort final guard */ }
    app.relaunch();
    app.exit(0);
  });
}
module.exports = { register };
