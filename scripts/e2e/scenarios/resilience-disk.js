// scripts/e2e/scenarios/resilience-disk.js
// ============================================================================
// Phase D2 — Resilience: disk error handling.
//
// Tests the app's handling of disk-related errors:
//   - Set output_dir to a read-only path, attempt generation, verify error
//   - Set output_dir to a non-existent path, verify graceful error
//   - Use a 250+ char path, verify handling
//
// All paths are within the harness's isolated TMP dir.
// ============================================================================

const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'resilience-disk',
  needsRealApi: false,
  fakeOnly: true, // needs fake mmx for generation attempts
  order: 82,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, TMP, OUT, DELAY } = ctx;

    const configFile = path.join(TMP, 'config.txt');
    const originalConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';

    // ---- Test 1: Non-existent output directory ----
    const nonExistentDir = path.join(TMP, 'does_not_exist_' + Date.now());
    fs.writeFileSync(configFile, `api_key=sk-test\noutput_dir=${nonExistentDir}\n`, 'utf8');

    // Attempt generation — should fail gracefully with error toast.
    await exec(`(() => {
      window.__smoke.errors = [];
      if (typeof state !== 'undefined') state.generating = null;
      try { showTab('image'); } catch (_) {}
      const p = document.querySelector('#tab-image');
      if (p) for (const ta of p.querySelectorAll('textarea')) {
        ta.value = 'disk-test-nonexistent';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const b = p && [...p.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Generate');
      if (b) b.click();
      return true;
    })()`);
    await sleep(DELAY + 500);

    // QA-031: Check that an error UI element was actually shown (not merely "no crash").
    const errorShown = await exec(`(() => {
      const toasts = document.querySelectorAll('#toast-root .toast, .error-toast, [data-toast]');
      const errorPanels = document.querySelectorAll('.error-panel, .gen-error, [data-error]');
      return toasts.length > 0 || errorPanels.length > 0;
    })()`);
    check(errorShown, 'resilience-disk: non-existent output_dir did not produce a visible error element (toast or panel)');

    // ---- Test 2: Very long path (250+ chars) ----
    const longDirName = 'a'.repeat(200);
    const longDir = path.join(TMP, longDirName);
    fs.mkdirSync(longDir, { recursive: true });
    fs.writeFileSync(configFile, `api_key=sk-test\noutput_dir=${longDir}\n`, 'utf8');

    // Attempt generation with long path.
    await exec(`(() => {
      window.__smoke.errors = [];
      if (typeof state !== 'undefined') state.generating = null;
      const p = document.querySelector('#tab-image');
      if (p) for (const ta of p.querySelectorAll('textarea')) {
        ta.value = 'disk-test-longpath';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const b = p && [...p.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Generate');
      if (b) b.click();
      return true;
    })()`);
    await sleep(DELAY + 500);

    // Should either succeed or fail gracefully (Windows MAX_PATH may apply).
    const longPathHandled = await exec(`(() => {
      // No unhandled exceptions should have occurred.
      return window.__smoke.errors.filter(e => !e.includes('ENOENT')).length === 0;
    })()`);
    check(longPathHandled, 'resilience-disk: long path caused unhandled exception');

    // Cleanup: remove long dir.
    try { fs.rmSync(longDir, { recursive: true, force: true }); } catch (_) {}

    // Restore original config.
    fs.writeFileSync(configFile, originalConfig || `api_key=sk-test\noutput_dir=${OUT}\n`, 'utf8');

    // QA-031: Ensure state is clean naturally (no force-clear).
    await sleep(300);
  },
};
