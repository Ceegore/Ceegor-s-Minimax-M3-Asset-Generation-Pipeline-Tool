// scripts/e2e/scenarios/real-batch.js
// ============================================================================
// Phase 4 — Tier 3 real batch generation (needsRealApi). Seeds a 2-prompt
// image batch into state.batches.image and runs startBatchGen('image'),
// proving the batch loop drives two REAL generations to disk. (The harness
// stubs window.confirm => true, so the "N paid API calls" prompt is accepted.)
// Asserts: >= 2 new non-zero image files + a log-result-ok row + no errors.
// ============================================================================

const { collectFiles, newFiles, clearState } = require('../realUtils');

module.exports = {
  name: 'real-batch',
  needsRealApi: true,
  order: 84,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT } = ctx;
    const label = 'real-batch/image-2';
    const IMG_RE = /\.(jpe?g|png|webp)$/;

    await clearState(ctx, 'image');
    const before = collectFiles(OUT);
    await exec(`(() => {
      if (typeof state !== 'undefined') {
        state.batches = state.batches || {};
        state.batches.image = [
          'A tiny green triangle on a white background, minimalist',
          'A tiny yellow star on a white background, minimalist',
        ];
      }
      return true;
    })()`);
    const started = await exec(`(() => { try { startBatchGen('image'); return true; } catch (e) { return false; } })()`);
    check(started, `${label}: startBatchGen('image') threw`);

    // Poll until BOTH batch items have landed (or time out).
    let added = [];
    let sawLog = false;
    const deadline = Date.now() + 300000;
    for (;;) {
      added = newFiles(before, collectFiles(OUT)).filter((f) => f.size > 0 && IMG_RE.test(f.path.toLowerCase()));
      sawLog = await exec(`(() => {
        const rows = [...document.querySelectorAll('#log .log-event')];
        return rows.some(r => /\\blog-result-ok\\b/.test(r.className) && /generated/i.test(
          (r.querySelector('.log-event-headline') || {}).textContent || ''));
      })()`).catch(() => false);
      if (added.length >= 2 && sawLog) break;
      if (Date.now() > deadline) break;
      await sleep(400);
    }

    check(added.length >= 2,
      `${label}: expected >= 2 new image files from the batch, found ${added.length}: ${added.map((f) => f.path).join(', ') || '(none)'}`);
    check(sawLog, `${label}: no log-result-ok "Generated" row appeared for the batch`);
    const errs = await exec(`window.__smoke.errors || []`).catch(() => []);
    check(errs.length === 0, `${label}: uncaught renderer errors: ${JSON.stringify(errs).slice(0, 300)}`);
  },
};
