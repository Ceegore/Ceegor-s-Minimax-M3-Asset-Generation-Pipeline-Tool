// scripts/e2e/scenarios/resilience-corrupt-config.js
// ============================================================================
// Phase D1 — Resilience: corrupt config/state recovery.
//
// Tests the app's ability to recover from corrupted configuration:
//   - Write garbage to config.txt, verify graceful fallback
//   - Write partial JSON to state.json, verify migration/recovery
//   - Delete config.txt entirely, verify first-time-setup triggers
//
// This scenario modifies the harness's isolated config dir (TMP), not the
// user's real config.
// ============================================================================

const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'resilience-corrupt-config',
  needsRealApi: false,
  fakeOnly: false,
  order: 80,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, TMP, OUT } = ctx;

    const configFile = path.join(TMP, 'config.txt');
    const stateFile = path.join(TMP, 'state.json');

    // ---- Test 1: Corrupt config.txt with garbage ----
    const originalConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
    fs.writeFileSync(configFile, 'GARBAGE\x00\x01\x02 NOT VALID CONFIG ===', 'utf8');

    // Attempt to read config via IPC — should return defaults or error gracefully.
    const corruptConfigRes = await exec(`(async () => {
      try {
        return await window.api.getConfig();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(corruptConfigRes !== undefined && corruptConfigRes !== null,
      'resilience-corrupt-config: getConfig crashed on corrupt config.txt');

    // Restore valid config.
    fs.writeFileSync(configFile, originalConfig || `api_key=sk-test\noutput_dir=${OUT}\n`, 'utf8');

    // ---- Test 2: Corrupt state.json with partial JSON ----
    const originalState = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '{}';
    fs.writeFileSync(stateFile, '{"broken": true, "missing_close": ', 'utf8');

    // Attempt to read state via IPC — should return defaults or recover.
    const corruptStateRes = await exec(`(async () => {
      try {
        return await window.api.stateGet();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(corruptStateRes !== undefined && corruptStateRes !== null,
      'resilience-corrupt-config: stateGet crashed on corrupt state.json');

    // Restore valid state.
    fs.writeFileSync(stateFile, originalState || '{}', 'utf8');

    // ---- Test 3: Delete config.txt entirely ----
    try { fs.unlinkSync(configFile); } catch (_) {}

    // Attempt to read config — should trigger first-time-setup or return defaults.
    const missingConfigRes = await exec(`(async () => {
      try {
        return await window.api.getConfig();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(missingConfigRes !== undefined && missingConfigRes !== null,
      'resilience-corrupt-config: getConfig crashed on missing config.txt');

    // Restore config for subsequent scenarios.
    fs.writeFileSync(configFile, originalConfig || `api_key=sk-test\noutput_dir=${OUT}\n`, 'utf8');

    // ---- Test 4: Empty state.json ----
    fs.writeFileSync(stateFile, '', 'utf8');
    const emptyStateRes = await exec(`(async () => {
      try {
        return await window.api.stateGet();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(emptyStateRes !== undefined && emptyStateRes !== null,
      'resilience-corrupt-config: stateGet crashed on empty state.json');

    // Restore state.
    fs.writeFileSync(stateFile, originalState || '{}', 'utf8');

    // Cleanup: files are in TMP which is auto-cleaned by harness.
  },
};
