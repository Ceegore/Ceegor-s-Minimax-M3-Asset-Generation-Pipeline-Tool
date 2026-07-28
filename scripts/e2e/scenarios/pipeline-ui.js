// scripts/e2e/scenarios/pipeline-ui.js
// ============================================================================
// Phase-2 surface scenario (master_testplan TC_E2E_PIPELINE_* , non-paid).
//
// Opens the pipeline board via window.Pipeline.open() (the same entry point
// the 🛤 Pipeline button uses) and asserts the ui_map pipeline_overlay
// surface: the overlay node itself, the header dropzone, the summary line,
// the card filter input, the stage columns, and that Escape closes it.
// Drag-drop import stays @manual (native DnD cannot be synthesised).
// ============================================================================

const { sel } = require('../uimap');

module.exports = {
  name: 'pipeline-ui',
  needsRealApi: false,
  order: 45,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check } = ctx;

    const dropSel = sel('DROPZONE');
    const sumSel = sel('SUMMARY');
    const filterSel = sel('INPUT_FILTER');
    const cardSel = sel('card');

    const r = await exec(`(async () => {
      window.__smoke.errors = [];
      if (!(window.Pipeline && typeof window.Pipeline.open === 'function')) return { error: 'window.Pipeline.open missing' };
      await window.Pipeline.open();
      await new Promise((r) => setTimeout(r, 250));
      const ov = document.getElementById('pipeline-overlay');
      if (!ov) return { error: 'pipeline overlay did not mount' };
      const out = { mounted: true };
      out.dropzone = !!ov.querySelector(${JSON.stringify(dropSel)});
      const summary = ov.querySelector(${JSON.stringify(sumSel)});
      out.summary = !!summary;
      out.summaryText = summary ? summary.textContent.trim() : null;
      const filter = ov.querySelector(${JSON.stringify(filterSel)});
      out.filter = !!filter;
      if (filter) {
        filter.value = 'zz'; filter.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 80));
        filter.value = ''; filter.dispatchEvent(new Event('input', { bubbles: true }));
      }
      out.cards = ov.querySelectorAll(${JSON.stringify(cardSel)}).length;
      // stage columns: the documented 7 stages
      out.columns = [...ov.querySelectorAll('[id^="pl-count-"]')].map((e) => e.id);
      out.zIndex = Number(getComputedStyle(ov).zIndex || 0);
      out.errors = window.__smoke.errors;
      return out;
    })()`);
    check(!r.error, r.error || '');
    if (!r.error) {
      check(r.dropzone, `DROPZONE ("${dropSel}") missing from the pipeline header`);
      check(r.summary, `SUMMARY ("${sumSel}") missing from the pipeline header`);
      check(r.filter, `INPUT_FILTER ("${filterSel}") missing from the pipeline header`);
      check(r.columns.length >= 5, `pipeline board should render its stage columns (found ${r.columns.length}: ${JSON.stringify(r.columns)})`);
      check(r.errors.length === 0, `pipeline board interactions threw: ${JSON.stringify(r.errors).slice(0, 300)}`);
      check(r.zIndex >= 100, `pipeline overlay z-index should be >=100 per the layering contract (got ${r.zIndex})`);
    }

    // ---- Escape closes the board (no input focused) ----
    const closed = await exec(`(async () => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 200));
      return !document.getElementById('pipeline-overlay');
    })()`);
    check(closed, 'Escape (with no input focused) must close the pipeline overlay');

    // ---- the pipeline badge on the image tab action bar ----
    const badgeSel = sel('IMG_PIPELINE_BADGE');
    const badge = await exec(`!!document.querySelector(${JSON.stringify(badgeSel)})`);
    check(badge, `IMG_PIPELINE_BADGE ("${badgeSel}") missing after the board was opened once`);
  },
};
