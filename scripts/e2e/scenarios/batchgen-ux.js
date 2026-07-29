// scripts/e2e/scenarios/batchgen-ux.js
// ============================================================================
// BatchGen UX overhaul (T2–T7) — live coverage of the two NEW UI surfaces:
//
//   T2) All-types dashboard rows: the ↑ ↓ ✎ ✕ actions sit LEFT of the item
//       text (the 1s auto-refresh resets horizontal scroll, so right-side
//       buttons would be scrolled out of view), and ↑/↓/✕ actually mutate
//       state.batches through batchesSet.
//   T3/T4/T6) startAllBatchGen shows ONE combined confirm modal for all
//       queued types (per-type counts, grand total, 💾 Save to row with
//       Change… picker, subfolder opt-out checkbox). Cancel resolves null
//       and starts nothing; ▶ Start all runs every type back-to-back with
//       no further prompts and routes outputs into <base>\<type>.
//   T7) On a clean finish the per-type overlay auto-closes (no stuck
//       "N/N" overlay) and the final success toast fires.
//
// Self-contained: seeds its own state.batches.*, restores fbDir, and leaves
// the queues empty + modals closed for downstream scenarios.
// ============================================================================

const path = require('path');
const fs = require('fs');

function countFiles(dir) {
  try { return fs.readdirSync(dir).length; } catch (_) { return 0; }
}

module.exports = {
  name: 'batchgen-ux',
  needsRealApi: false,
  fakeOnly: true, // drives the fake mmx backend
  order: 21, // right after batch.js (20); cleans up so later scenarios/visuals are unaffected
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT, closeModals } = ctx;

    // Defensive: remove any stale overlays left by earlier scenarios (e.g.
    // batch.js's cancelled video batch keeps its overlay open per T7 design).
    await exec(`document.querySelectorAll('.batch-overlay').forEach((o) => o.remove()); true;`);

    // ---- T2: dashboard row actions (left of text, functional) ----
    await exec(`(async () => {
      window.__smoke.errors = [];
      state.batches = { image: ['dash-a', 'dash-b', 'dash-c'], speech: [], music: [], video: [] };
      await window.api.batchesSet(state.batches);
      _refreshBatchButtons();
      openAllBatchDashboard();
      return true;
    })()`);
    await sleep(200);
    const dash = await exec(`(() => {
      const modal = [...document.querySelectorAll('#modal-root .modal')].pop();
      if (!modal) return { modal: false };
      const rows = [...modal.querySelectorAll('.batch-dashboard-item')];
      const row = rows[0];
      const kids = row ? [...row.children].map((c) => c.className || '') : [];
      const actionsIdx = kids.findIndex((c) => c.includes('batch-dashboard-item-actions'));
      const textIdx = kids.findIndex((c) => c.includes('batch-dashboard-item-text'));
      const btns = row ? [...row.querySelectorAll('.batch-dashboard-item-actions button')].map((b) => (b.textContent || '').trim()) : [];
      return { modal: true, rowCount: rows.length, actionsIdx, textIdx, btns };
    })()`);
    check(dash.modal, 'batchgen-ux: openAllBatchDashboard() did not open a modal');
    check(dash.rowCount === 3, `batchgen-ux: dashboard should list 3 queued image items, got ${dash.rowCount}`);
    check(dash.actionsIdx >= 0 && dash.textIdx >= 0 && dash.actionsIdx < dash.textIdx,
      `batchgen-ux (T2): the row actions span must precede the item text (1s refresh resets horizontal scroll) — actionsIdx=${dash.actionsIdx}, textIdx=${dash.textIdx}`);
    check(dash.btns.join('') === '↑↓✎✕',
      `batchgen-ux (T2): expected row buttons ↑↓✎✕, got ${JSON.stringify(dash.btns)}`);

    // ↓ on the first row swaps items 0 and 1 (persisted via batchesSet).
    await exec(`(() => {
      const modal = [...document.querySelectorAll('#modal-root .modal')].pop();
      const row = modal && modal.querySelector('.batch-dashboard-item');
      const down = row && [...row.querySelectorAll('.batch-dashboard-item-actions button')].find((b) => (b.textContent || '').trim() === '↓');
      if (down) down.click();
      return true;
    })()`);
    await sleep(300);
    const afterMove = await exec(`(state.batches.image || []).join(',')`);
    check(afterMove === 'dash-b,dash-a,dash-c',
      `batchgen-ux (T2): ↓ on row 1 must swap items 0/1, got [${afterMove}]`);

    // ✕ on the (new) first row removes it from the queue.
    await exec(`(() => {
      const modal = [...document.querySelectorAll('#modal-root .modal')].pop();
      const row = modal && modal.querySelector('.batch-dashboard-item');
      const rm = row && [...row.querySelectorAll('.batch-dashboard-item-actions button')].find((b) => (b.textContent || '').trim() === '✕');
      if (rm) rm.click();
      return true;
    })()`);
    await sleep(300);
    const afterRemove = await exec(`(state.batches.image || []).join(',')`);
    check(afterRemove === 'dash-a,dash-c',
      `batchgen-ux (T2): ✕ on row 1 must remove the entry, got [${afterRemove}]`);
    await closeModals();

    // ---- T3/T6: combined confirm modal — content + Cancel path ----
    await exec(`(async () => {
      window.__smoke.errors = [];
      state.batchesAutoRemove = true;
      state.batches = { image: ['ux-i1', 'ux-i2'], speech: ['ux-s1'], music: [], video: [] };
      await window.api.batchesSet(state.batches);
      _refreshBatchButtons();
      window.__smokeAllGenDone = window.BatchManager.startAllBatchGen();
      return true;
    })()`);
    await sleep(200);
    const confirm1 = await exec(`(() => {
      const modal = [...document.querySelectorAll('#modal-root .modal')].pop();
      if (!modal) return { modal: false };
      const text = modal.textContent || '';
      const btns = [...modal.querySelectorAll('button')].map((b) => (b.textContent || '').trim());
      return {
        modal: true,
        title: modal.querySelector('h2') ? modal.querySelector('h2').textContent : '',
        listItems: [...modal.querySelectorAll('ul li')].map((li) => li.textContent),
        totalLine: text.includes('Total: 3 items → 3 paid API calls'),
        hasSaveTo: text.includes('💾 Save to:'),
        hasChangeBtn: btns.includes('Change…'),
        hasSubCheckbox: !!modal.querySelector('input[type=checkbox]'),
        subLabel: text.includes('Do not use/create sub-folders for assets types'),
        hasStart: btns.some((t) => t.includes('Start all')),
        hasCancel: btns.includes('Cancel'),
      };
    })()`);
    check(confirm1.modal, 'batchgen-ux: startAllBatchGen() did not open the combined confirm modal');
    check(confirm1.title === 'Start BatchGen — all types',
      `batchgen-ux (T6): unexpected modal title: ${JSON.stringify(confirm1.title)}`);
    check(confirm1.listItems.length === 2
        && /^IMAGE: 2 items → 2 paid API calls$/.test(confirm1.listItems[0] || '')
        && /^SPEECH: 1 item → 1 paid API call$/.test(confirm1.listItems[1] || ''),
      `batchgen-ux (T6): per-type rows wrong: ${JSON.stringify(confirm1.listItems)}`);
    check(confirm1.totalLine, 'batchgen-ux (T6): grand-total line "Total: 3 items → 3 paid API calls" missing');
    check(confirm1.hasSaveTo && confirm1.hasChangeBtn,
      'batchgen-ux (T3): the 💾 Save to row with a Change… picker button must be in the combined confirm');
    check(confirm1.hasSubCheckbox && confirm1.subLabel,
      'batchgen-ux (T4): the "Do not use/create sub-folders for assets types" checkbox must be in the combined confirm');
    check(confirm1.hasStart && confirm1.hasCancel,
      `batchgen-ux (T6): modal must offer ▶ Start all + Cancel, got ${JSON.stringify(confirm1)}`);

    // Cancel must resolve null: nothing starts, queues stay untouched.
    const cancelled = await exec(`(async () => {
      const modal = [...document.querySelectorAll('#modal-root .modal')].pop();
      const cancel = modal && [...modal.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Cancel');
      if (cancel) cancel.click();
      await window.__smokeAllGenDone;
      return {
        image: (state.batches.image || []).length,
        speech: (state.batches.speech || []).length,
        modals: document.querySelectorAll('#modal-root .modal').length,
        overlays: document.querySelectorAll('.batch-overlay').length,
        running: window.JobRunner ? window.JobRunner.activeJobs().length : 0,
        errors: window.__smoke.errors,
      };
    })()`);
    check(cancelled.image === 2 && cancelled.speech === 1,
      `batchgen-ux (T6): Cancel must not consume the queues (image=${cancelled.image}, speech=${cancelled.speech})`);
    check(cancelled.modals === 0 && cancelled.overlays === 0 && cancelled.running === 0,
      `batchgen-ux (T6): Cancel must start nothing (modals=${cancelled.modals}, overlays=${cancelled.overlays}, jobs=${cancelled.running})`);
    check((cancelled.errors || []).length === 0,
      `batchgen-ux: cancel path threw: ${JSON.stringify(cancelled.errors).slice(0, 200)}`);

    // ---- T4/T6/T7: ▶ Start all — full run, subfolders, auto-close, toast ----
    // Pin the base folder to the harness OUT dir (fbDir would win otherwise).
    const imgDir = path.join(OUT, 'image');
    const spDir = path.join(OUT, 'speech');
    const imgBefore = countFiles(imgDir);
    const spBefore = countFiles(spDir);
    await exec(`(async () => {
      window.__smoke.errors = [];
      window.__smokeSavedFbDir = state.fbDir;
      state.fbDir = ''; // base falls back to config.output_dir (the harness OUT dir)
      window.__smokeAllGenDone2 = window.BatchManager.startAllBatchGen();
      return true;
    })()`);
    await sleep(200);
    const started = await exec(`(() => {
      const modal = [...document.querySelectorAll('#modal-root .modal')].pop();
      if (!modal) return false;
      const start = [...modal.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Start all'));
      if (!start) return false;
      start.click(); // subfolder checkbox left unchecked → per-type subfolders (T4 default)
      return true;
    })()`);
    check(started, 'batchgen-ux: could not click ▶ Start all on the combined confirm modal');
    const finished = await exec(`(async () => {
      await window.__smokeAllGenDone2;
      state.fbDir = window.__smokeSavedFbDir;
      const toasts = [...document.querySelectorAll('#toast-root .toast, .toast')].map((t) => t.textContent || '');
      return {
        image: (state.batches.image || []).length,
        speech: (state.batches.speech || []).length,
        overlays: document.querySelectorAll('.batch-overlay').length,
        modals: document.querySelectorAll('#modal-root .modal').length,
        finishToast: toasts.some((t) => t.includes('All BatchGen types finished')),
        errors: window.__smoke.errors,
      };
    })()`);
    check(finished.image === 0 && finished.speech === 0,
      `batchgen-ux (T6): all queued items must drain after ▶ Start all (image=${finished.image}, speech=${finished.speech})`);
    check(finished.overlays === 0,
      `batchgen-ux (T7): the per-type batch overlay must AUTO-CLOSE on a clean finish (found ${finished.overlays} stuck overlay(s))`);
    check(finished.modals === 0,
      `batchgen-ux (T6): no further confirm modals may appear mid-run (found ${finished.modals})`);
    check(finished.finishToast,
      'batchgen-ux (T7): the "✅ All BatchGen types finished." success toast must fire after the last type');
    check((finished.errors || []).length === 0,
      `batchgen-ux: start-all run threw: ${JSON.stringify(finished.errors).slice(0, 200)}`);

    // T4: outputs must have landed in <OUT>\image and <OUT>\speech.
    const imgAfter = countFiles(imgDir);
    const spAfter = countFiles(spDir);
    check(fs.existsSync(imgDir) && imgAfter > imgBefore,
      `batchgen-ux (T4): image outputs must land in the auto-created <base>\\image subfolder (${imgBefore} → ${imgAfter} files)`);
    check(fs.existsSync(spDir) && spAfter > spBefore,
      `batchgen-ux (T4): speech outputs must land in the auto-created <base>\\speech subfolder (${spBefore} → ${spAfter} files)`);

    // Leave the batch state clean for downstream scenarios.
    await exec(`(async () => {
      state.batches = { image: [], speech: [], music: [], video: [] };
      try { await window.api.batchesSet(state.batches); } catch (_) {}
      try { _refreshBatchButtons(); } catch (_) {}
      state.batchesAutoRemove = true;
      return true;
    })()`).catch(() => false);
    await closeModals();
  },
};
