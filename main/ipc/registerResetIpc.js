// main/ipc/registerResetIpc.js
// "Delete all local data" — deletes ONLY the tool's own settings/state files
// (+ the mmx CLI api_key). NEVER the user's generated assets.
//
// P1-G (360° Audit H-016): destructive operations require a single-use
// confirmation token minted via native dialog. A compromised renderer
// cannot bypass the native dialog to mint tokens.
'use strict';
const { ipcMain, app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { configDir } = require('../../src/config');
const { clearApiKeyFromMmxCliConfig } = require('../../src/mmxApiKeySync');
const { mintToken, validateToken } = require('../services/ConfirmationTokenService');
// P1-A (360° Audit H-001): secure IPC wrapper with sender/frame/origin validation.
const { secureHandle } = require('./secureHandle');

// Deletes ONLY the tool's own settings/state files (+ the mmx CLI api_key).
// NEVER the user's generated assets. Returns a per-file result so the UI
// reports partial failures honestly instead of claiming a clean reset.
// HIGH-017: also deletes providers.json and SecretStore blobs.
// H-030 (_5 audit): also cancels active cloud jobs, clears in-memory
// caches (CloudJobGate, ConfirmationTokenService), and wipes the daily
// budget persistence so the reset is a true fresh start.
function deleteLocalDataFiles() {
  const dir = configDir();
  const results = [];
  // HIGH-017: added providers.json to the reset targets.
  const bases = ['config.txt', 'state.json', 'batches.json', 'state.jobs.archive.jsonl', 'providers.json'];
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
  // HIGH-017: clear SecretStore blobs (userData/secrets/).
  try {
    const secretsDir = path.join(app.getPath('userData'), 'secrets');
    if (fs.existsSync(secretsDir)) {
      fs.rmSync(secretsDir, { recursive: true, force: true });
      results.push({ file: 'secrets/', ok: true });
    } else {
      results.push({ file: 'secrets/', ok: true, skipped: 'absent' });
    }
  } catch (e) {
    results.push({ file: 'secrets/', ok: false, error: String((e && e.message) || e) });
  }
  try { results.push({ file: '~/.mmx/config.json (api_key)', ok: clearApiKeyFromMmxCliConfig() }); }
  catch (e) { results.push({ file: '~/.mmx/config.json', ok: false, error: String((e && e.message) || e) }); }
  // B-009 / H-046: also wipe the in-memory session credential so a reset
  // leaves NO credential behind (persisted OR session-only).
  try {
    require('../services/SessionCredentialStore').clearSessionCredential();
    results.push({ file: 'session credential (memory)', ok: true });
  } catch (e) {
    results.push({ file: 'session credential (memory)', ok: false, error: String((e && e.message) || e) });
  }
  // H-030 (_5 audit): cancel all active cloud job slots so no in-flight
  // job writes to a freshly-deleted output directory after reset.
  try {
    require('../services/CloudJobGate').cancelAll();
    results.push({ file: 'cloud job slots (memory)', ok: true });
  } catch (e) {
    results.push({ file: 'cloud job slots (memory)', ok: false, error: String((e && e.message) || e) });
  }
  // H-030 (_5 audit): clear all confirmation tokens so stale tokens
  // cannot be replayed after reset.
  try {
    const cts = require('../services/ConfirmationTokenService');
    if (typeof cts.clearAll === 'function') cts.clearAll();
    results.push({ file: 'confirmation tokens (memory)', ok: true });
  } catch (e) {
    results.push({ file: 'confirmation tokens (memory)', ok: false, error: String((e && e.message) || e) });
  }
  // H-030 (_5 audit): remove the persisted daily budget counter so the
  // reset truly starts fresh.
  try {
    const budgetFile = path.join(configDir(), 'daily-budget.json');
    if (fs.existsSync(budgetFile)) fs.unlinkSync(budgetFile);
    results.push({ file: 'daily-budget.json', ok: true });
  } catch (e) {
    results.push({ file: 'daily-budget.json', ok: false, error: String((e && e.message) || e) });
  }
  return { ok: results.every((r) => r.ok), results };
}

function register(deps) {
  const getMainWindow = (deps && typeof deps.getMainWindow === 'function') ? deps.getMainWindow : () => null;

  // P1-G (H-016): mint a confirmation token via native dialog.
  secureHandle('confirm:request', { getMainWindow }, async (_e, opts) => {
    return mintToken(getMainWindow(), opts);
  });

  // P1-G (H-016): destructive — requires confirmation token.
  secureHandle('app:resetAllData', { getMainWindow }, (_e, payload) => {
    const token = payload && payload.confirmationToken;
    const auth = validateToken(token, 'app:resetAllData');
    if (!auth.ok) return auth;
    return deleteLocalDataFiles();
  });

  // Plain relaunch must never delete user data.
  secureHandle('app:relaunch', { getMainWindow }, () => {
    app.relaunch();
    app.exit(0);
  });

  // P1-G (H-016): destructive — requires confirmation token.
  // P5 (M-045): only relaunch on full success.
  secureHandle('app:resetAndRelaunch', { getMainWindow }, (_e, payload) => {
    const token = payload && payload.confirmationToken;
    const auth = validateToken(token, 'app:resetAndRelaunch');
    if (!auth.ok) return auth;
    const result = deleteLocalDataFiles();
    if (!result.ok) {
      return { ok: false, error: 'Reset partially failed. Some files could not be deleted.', results: result.results };
    }
    app.relaunch();
    app.exit(0);
  });

  // B-009: single Main-owned transaction for "Delete all local data".
  // The renderer calls this ONE channel with no payload. Main:
  //   1. shows a FIXED native warning dialog (text is Main-owned and
  //      immutable — a compromised renderer cannot soften it),
  //   2. on Cancel: returns { ok:false, canceled:true } with ZERO mutation,
  //   3. on Confirm: deletes all local data files, verifies per-file
  //      results, and relaunches ONLY on full success.
  // No renderer-supplied confirmation token is involved — the native
  // dialog IS the trust gesture, inside the same handler, so the
  // renderer can neither skip it nor desynchronise delete/relaunch.
  secureHandle('app:confirmResetAndRelaunch', { getMainWindow }, async () => {
    const win = getMainWindow();
    const r = await dialog.showMessageBox(win || undefined, {
      type: 'warning',
      title: 'Delete all local data',
      message: 'Permanently delete ALL tool settings and state?',
      detail: 'This deletes: config.txt (API key, output dir, region, theme, styles), '
        + 'state.json (UI/pipeline state), batches.json (batch queues), the job archive, '
        + 'stored provider keys, and the mmx CLI api_key.\n\n'
        + 'Your generated assets (images, audio, video) are NOT touched.\n\n'
        + 'The app relaunches into first-run setup afterwards. This cannot be undone.',
      buttons: ['Delete and relaunch', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (r.response !== 0) return { ok: false, canceled: true };
    const result = deleteLocalDataFiles();
    if (!result.ok) {
      return { ok: false, error: 'Reset partially failed. Some files could not be deleted.', results: result.results };
    }
    app.relaunch();
    app.exit(0);
    // Unreachable in production (app.exit terminates), but keeps the
    // contract honest for tests that stub app.exit.
    return { ok: true, results: result.results };
  });
}
module.exports = { register };
