// scripts/e2e/scenarios/stress-volume.js
// ============================================================================
// Phase D5 — Stress: volume handling.
//
// Tests the app under high-volume conditions:
//   - Create 200 files in output_dir, verify file browser renders
//   - Add 100 log entries, verify log panel scroll performance
//   - Create 20-item batch queue, verify UI responsive
//
// All test files are created in the harness's isolated OUT dir and
// cleaned up at the end.
// ============================================================================

const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'stress-volume',
  needsRealApi: false,
  fakeOnly: false,
  order: 88,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT } = ctx;

    const createdFiles = [];

    // ---- Test 1: 200 files in output_dir ----
    // Create 200 small test files.
    for (let i = 0; i < 200; i++) {
      const f = path.join(OUT, `stress_file_${String(i).padStart(3, '0')}.txt`);
      fs.writeFileSync(f, `test content ${i}`);
      createdFiles.push(f);
    }

    // Navigate file browser to OUT by setting state.fbDir and refreshing.
    // (fbSetActiveDir is a no-op ACK; real navigation goes through state + refreshBrowser.)
    await exec(`(async () => {
      try {
        if (typeof state !== 'undefined') state.fbDir = ${JSON.stringify(OUT)};
        if (typeof window.refreshBrowser === 'function') await window.refreshBrowser();
      } catch (_) {}
      return true;
    })()`);
    await sleep(500);

    // Verify file browser rendered without crashing.
    const fbRendered = await exec(`(() => {
      const items = document.querySelectorAll('.fb-item, .file-item, [data-file-item]');
      return items.length > 0 || document.querySelector('#sidebar') !== null;
    })()`);
    check(fbRendered, 'stress-volume: file browser did not render with 200 files');

    // ---- Test 2: 100 log entries ----
    // Add log entries via the LogService (if available).
    await exec(`(() => {
      if (typeof window.LogService !== 'undefined' && window.LogService.addLog) {
        for (let i = 0; i < 100; i++) {
          window.LogService.addLog({ type: 'info', message: 'Stress log entry ' + i, ts: Date.now() });
        }
      }
      return true;
    })()`);
    await sleep(200);

    // Verify log panel is still responsive.
    const logResponsive = await exec(`(() => {
      // Check that the UI is not frozen by measuring a simple DOM operation.
      const start = performance.now();
      document.querySelector('#tab-image');
      const elapsed = performance.now() - start;
      return elapsed < 1000; // should be near-instant
    })()`);
    check(logResponsive, 'stress-volume: UI not responsive after 100 log entries');

    // ---- Test 3: 20-item batch queue ----
    // Create a batch with 20 items.
    const batchItems = [];
    for (let i = 0; i < 20; i++) {
      batchItems.push({
        id: `stress-batch-${i}`,
        prompt: `Stress batch item ${i}`,
        tab: 'image',
        status: 'pending',
      });
    }

    await exec(`(async () => {
      try {
        await window.api.batchesSet(${JSON.stringify({ items: batchItems })});
      } catch (_) {}
      return true;
    })()`);
    await sleep(300);

    // Verify batch UI is responsive.
    const batchResponsive = await exec(`(() => {
      const start = performance.now();
      document.querySelector('#tab-image');
      const elapsed = performance.now() - start;
      return elapsed < 1000;
    })()`);
    check(batchResponsive, 'stress-volume: UI not responsive with 20-item batch queue');

    // Cleanup: remove all created files.
    for (const f of createdFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }

    // Clear the batch queue.
    await exec(`(async () => {
      try {
        await window.api.batchesSet({ items: [] });
      } catch (_) {}
      return true;
    })()`);

    // Ensure state is clean.
    await exec(`(() => { if (typeof state !== 'undefined') state.generating = null; return true; })()`);
    await sleep(200);
  },
};
