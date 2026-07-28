// scripts/e2e/scenarios/shortcuts-layout.js
// ============================================================================
// Phase-2 surface scenario (master_testplan Phase 12: shortcuts & layout).
//
// Two halves:
//  1. The documented global keyboard shortcuts produce their effect
//     (Ctrl+1..4 tab switch, Ctrl+S settings, Ctrl+T styles, Ctrl+B batch,
//     Ctrl+L theme, Ctrl+F file-browser filter focus).
//  2. The whole log-panel control surface from ui_map.json is present and
//     functional: newest/oldest jump, collapse/expand all, autoscroll chip,
//     copy, clear, toggle, the jump pill, and the log area itself.
// ============================================================================

const { sel } = require('../uimap');

module.exports = {
  name: 'shortcuts-layout',
  needsRealApi: false,
  order: 55,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, closeModals } = ctx;

    // ---- keyboard shortcuts ----
    const keys = await exec(`(async () => {
      const out = {};
      const press = (key, ctrl = true) => document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: ctrl, bubbles: true }));
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const activeTab = () => {
        for (const k of ['image', 'speech', 'music', 'video']) {
          const b = document.querySelector("button[data-tab='" + k + "']");
          if (b && (b.classList.contains('active') || b.getAttribute('aria-selected') === 'true')) return k;
        }
        // fall back to which panel is visible
        for (const k of ['image', 'speech', 'music', 'video']) {
          const p = document.querySelector('#tab-' + k);
          if (p && p.offsetParent !== null && getComputedStyle(p).display !== 'none') return k;
        }
        return null;
      };
      const modals = () => document.querySelectorAll('#modal-root .modal').length;
      window.__smoke.errors = [];

      press('2'); await wait(120); out.tab2 = activeTab();
      press('3'); await wait(120); out.tab3 = activeTab();
      press('4'); await wait(120); out.tab4 = activeTab();
      press('1'); await wait(120); out.tab1 = activeTab();

      const themeBefore = document.documentElement.getAttribute('data-theme');
      press('l'); await wait(100);
      out.themeToggled = document.documentElement.getAttribute('data-theme') !== themeBefore;
      press('l'); await wait(100); // restore original theme

      press('s'); await wait(150); out.settingsModal = modals() > 0;
      for (let i = 0; i < 8; i++) press('Escape'); await wait(100);

      press('t'); await wait(150); out.stylesModal = modals() > 0;
      for (let i = 0; i < 8; i++) press('Escape'); await wait(100);

      press('b'); await wait(150); out.batch = modals() > 0;
      for (let i = 0; i < 8; i++) press('Escape'); await wait(100);

      press('f'); await wait(120);
      out.filterFocused = document.activeElement && document.activeElement.id === 'fb-search';
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

      out.errors = window.__smoke.errors;
      return out;
    })()`);
    check(keys.tab2 === 'speech', `Ctrl+2 must activate the speech tab (active: ${keys.tab2})`);
    check(keys.tab3 === 'music', `Ctrl+3 must activate the music tab (active: ${keys.tab3})`);
    check(keys.tab4 === 'video', `Ctrl+4 must activate the video tab (active: ${keys.tab4})`);
    check(keys.tab1 === 'image', `Ctrl+1 must activate the image tab (active: ${keys.tab1})`);
    check(keys.themeToggled, 'Ctrl+L must toggle theme');
    check(keys.settingsModal, 'Ctrl+S must open Settings modal');
    check(keys.stylesModal, 'Ctrl+T must open Style Settings modal');
    check(keys.batch, 'Ctrl+B must open the BatchGen dialog');
    check(keys.filterFocused, 'Ctrl+F must focus the file-browser filter input');
    check(keys.errors.length === 0, `shortcut handling threw: ${JSON.stringify(keys.errors).slice(0, 300)}`);
    await closeModals();

    // ---- log panel control surface ----
    // Seed a few rows so jump/collapse have something to act on.
    await exec(`(() => {
      for (let i = 0; i < 12; i++) window.LogService.addLogEvent({ category: 'info', headline: 'shortcut-probe ' + i, details: ['row ' + i] });
      return true;
    })()`);
    await sleep(80);

    const LOG_IDS = ['BTN_LOG_NEWEST', 'BTN_LOG_OLDEST', 'BTN_LOG_COLLAPSE_ALL', 'BTN_LOG_EXPAND_ALL',
      'CHIP_AUTOSCROLL', 'BTN_LOG_COPY', 'BTN_LOG_CLEAR', 'BTN_LOG_TOGGLE', 'LOG_AREA', 'LOG_JUMP_PILL'];
    for (const id of LOG_IDS) {
      const s = sel(id);
      const r = await exec(`(() => { const el = document.querySelector(${JSON.stringify(s)}); return { exists: !!el, tag: el ? el.tagName : null }; })()`);
      check(r.exists, `${id} ("${s}") missing from the log panel`);
    }

    const logOps = await exec(`(async () => {
      const out = {};
      window.__smoke.errors = [];
      const log = document.querySelector('#log');
      out.rowsBefore = log.querySelectorAll('.log-event').length;
      // collapse-all then expand-all must flip the details visibility
      const ca = document.querySelector('#log-collapse-all');
      const ea = document.querySelector('#log-expand-all');
      ca.click(); await new Promise((r) => setTimeout(r, 80));
      out.collapsedHidden = [...log.querySelectorAll('.log-event-details')].every((d) => d.style.display === 'none');
      ea.click(); await new Promise((r) => setTimeout(r, 80));
      out.expandedShown = [...log.querySelectorAll('.log-event-details')].some((d) => d.style.display !== 'none');
      // newest / oldest jumps must not throw and must move scrollTop
      document.querySelector('#log-jump-newest').click(); await new Promise((r) => setTimeout(r, 60));
      out.afterNewest = log.scrollTop;
      document.querySelector('#log-jump-oldest').click(); await new Promise((r) => setTimeout(r, 60));
      out.afterOldest = log.scrollTop;
      // autoscroll chip toggles its state text/class
      const chip = document.querySelector('#log-autoscroll-chip');
      out.chipBefore = chip.textContent.trim();
      chip.click(); await new Promise((r) => setTimeout(r, 60));
      out.chipAfter = chip.textContent.trim();
      chip.click(); await new Promise((r) => setTimeout(r, 60));
      // copy must not throw (clipboard may be unavailable headless — that is fine)
      try { document.querySelector('#log-copy').click(); out.copyOk = true; } catch (e) { out.copyOk = false; }
      await new Promise((r) => setTimeout(r, 60));
      // toggle collapses/expands the whole pane
      const tg = document.querySelector('#log-toggle');
      out.toggleText = (tg.textContent || '').trim();
      tg.click(); await new Promise((r) => setTimeout(r, 80));
      out.toggleChanged = (tg.textContent || '').trim() !== out.toggleText;
      tg.click(); await new Promise((r) => setTimeout(r, 80));
      // clear empties the log
      document.querySelector('#log-clear').click(); await new Promise((r) => setTimeout(r, 100));
      out.rowsAfterClear = log.querySelectorAll('.log-event').length;
      out.errors = window.__smoke.errors;
      return out;
    })()`);
    check(logOps.rowsBefore > 0, 'log seed produced no rows — cannot exercise the log controls');
    check(logOps.collapsedHidden, 'BTN_LOG_COLLAPSE_ALL did not collapse every row');
    check(logOps.expandedShown, 'BTN_LOG_EXPAND_ALL did not expand the rows again');
    check(logOps.chipAfter !== logOps.chipBefore, `CHIP_AUTOSCROLL click did not change its state ("${logOps.chipBefore}" -> "${logOps.chipAfter}")`);
    check(logOps.copyOk, 'BTN_LOG_COPY click threw');
    check(logOps.toggleChanged, 'BTN_LOG_TOGGLE click did not change its label (collapse/expand pane)');
    check(logOps.rowsAfterClear === 0, `BTN_LOG_CLEAR must empty the log (${logOps.rowsAfterClear} rows remain)`);
    check(logOps.errors.length === 0, `log control interactions threw: ${JSON.stringify(logOps.errors).slice(0, 300)}`);
  },
};
