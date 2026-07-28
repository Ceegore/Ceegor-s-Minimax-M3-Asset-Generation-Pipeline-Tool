// scripts/e2e/scenarios/settings-styles.js
// ============================================================================
// Phase-2 surface scenario (master_testplan TC_E2E_SETUP_002, non-API parts).
//
// Opens the settings dialog via its ui_map trigger and walks the panes:
// the 9 tab buttons render, the automatable controls declared in
// ui_map.json exist (CB_NO_SAVE_KEY, CB_AUTO_REMOVE, INPUT_HISTORY_CAP),
// the archive viewer opens from the history pane (covering its search /
// status / info / list surface), and the style overlay opens via BTN_STYLES
// with its list + name/value inputs. Everything closes deterministically.
// ============================================================================

const { sel } = require('../uimap');

module.exports = {
  name: 'settings-styles',
  needsRealApi: false,
  order: 40,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, closeModals } = ctx;

    // ---- open settings; all documented panes render ----
    const open = await exec(`(async () => {
      window.__smoke.errors = [];
      if (typeof openSettings === 'function') openSettings();
      else document.querySelector('#btn-settings').click();
      await new Promise((r) => setTimeout(r, 250));
      const m = document.querySelector('.settings-modal');
      if (!m) return { opened: false };
      const tabBtns = [...m.querySelectorAll('.settings-tab-button')];
      const tabs = tabBtns.map((b) => b.dataset.tabButton || b.textContent.trim());
      // click through every pane so each renders at least once
      const panes = [];
      for (const b of tabBtns) {
        b.click();
        await new Promise((r) => setTimeout(r, 60));
        panes.push(b.dataset.tabButton || b.textContent.trim());
      }
      return { opened: true, tabs, panes, errors: window.__smoke.errors };
    })()`);
    check(open.opened, 'settings dialog (.settings-modal) did not open');
    if (open.opened) {
      check(open.tabs.length >= 8, `settings dialog should expose its documented panes as tab buttons (found ${open.tabs.length}: ${JSON.stringify(open.tabs)})`);
      check(open.errors.length === 0, `clicking through settings panes threw: ${JSON.stringify(open.errors).slice(0, 300)}`);
    }

    // ---- automatable settings controls from ui_map.json ----
    const noSaveSel = sel('CB_NO_SAVE_KEY');
    const autoRmSel = sel('CB_AUTO_REMOVE');
    const histCapSel = sel('INPUT_HISTORY_CAP');
    const ctrls = await exec(`(async () => {
      const out = {};
      // CB_NO_SAVE_KEY lives on the general pane
      const genBtn = document.querySelector(".settings-tab-button[data-tab-button='general']");
      if (genBtn) { genBtn.click(); await new Promise((r) => setTimeout(r, 60)); }
      const ns = document.querySelector(${JSON.stringify(noSaveSel)});
      out.noSave = !!ns;
      if (ns) { ns.checked = !ns.checked; ns.dispatchEvent(new Event('change', { bubbles: true })); ns.checked = !ns.checked; ns.dispatchEvent(new Event('change', { bubbles: true })); }
      // CB_AUTO_REMOVE lives on the batchgen pane
      const bgBtn = document.querySelector(".settings-tab-button[data-tab-button='batchgen']");
      if (bgBtn) { bgBtn.click(); await new Promise((r) => setTimeout(r, 60)); }
      const ar = document.querySelector(${JSON.stringify(autoRmSel)});
      out.autoRemove = !!ar;
      // INPUT_HISTORY_CAP lives on the history pane
      const hBtn = document.querySelector(".settings-tab-button[data-tab-button='history']");
      if (hBtn) { hBtn.click(); await new Promise((r) => setTimeout(r, 60)); }
      const hc = document.querySelector(${JSON.stringify(histCapSel)});
      out.historyCap = !!hc;
      if (hc) { out.historyCapValue = hc.value; }
      return out;
    })()`);
    check(ctrls.noSave, `CB_NO_SAVE_KEY ("${noSaveSel}") missing on the settings general pane`);
    check(ctrls.autoRemove, `CB_AUTO_REMOVE ("${autoRmSel}") missing on the settings batchgen pane`);
    check(ctrls.historyCap, `INPUT_HISTORY_CAP ("${histCapSel}") missing on the settings history pane`);

    // ---- archive viewer opens from the history pane ----
    const arch = await exec(`(async () => {
      const btns = [...document.querySelectorAll('.settings-modal button')];
      const b = btns.find((x) => /archive/i.test(x.textContent || ''));
      if (!b) return { error: 'no "Open archive…" button on the history pane' };
      b.click();
      await new Promise((r) => setTimeout(r, 250));
      const m = document.getElementById('archive-viewer-modal');
      return {
        opened: !!m,
        search: !!(m && m.querySelector('#archive-viewer-search')),
        status: !!(m && m.querySelector('#archive-viewer-status')),
        info: !!(m && m.querySelector('#archive-viewer-info')),
        list: !!(m && m.querySelector('#archive-viewer-list')),
      };
    })()`);
    check(!arch.error, arch.error || '');
    if (!arch.error) {
      check(arch.opened, 'the archive viewer modal did not open from the history pane');
      const aSearchSel = sel('INPUT_SEARCH');
      const aStatusSel = sel('SELECT_STATUS');
      const aInfoSel = sel('INFO_LABEL');
      const aListSel = sel('LIST');
      check(arch.search, `archive viewer: INPUT_SEARCH ("${aSearchSel}") missing`);
      check(arch.status, `archive viewer: SELECT_STATUS ("${aStatusSel}") missing`);
      check(arch.info, `archive viewer: INFO_LABEL ("${aInfoSel}") missing`);
      check(arch.list, `archive viewer: LIST ("${aListSel}") missing`);
      // type into the filter — must not throw even on an empty archive
      if (arch.search) {
        const errs = await exec(`(() => {
          window.__smoke.errors = [];
          const s = document.querySelector('#archive-viewer-search');
          s.value = 'zz'; s.dispatchEvent(new Event('input', { bubbles: true }));
          s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));
          return window.__smoke.errors;
        })()`);
        check(errs.length === 0, `archive viewer filter threw: ${JSON.stringify(errs).slice(0, 200)}`);
      }
    }
    await closeModals();

    // ---- style overlay via BTN_STYLES ----
    const stylesSel = sel('BTN_STYLES');
    const styles = await exec(`(async () => {
      document.querySelector(${JSON.stringify(stylesSel)}).click();
      await new Promise((r) => setTimeout(r, 200));
      const m = document.querySelector('#modal-root .modal');
      if (!m) return { opened: false };
      const inputs = [...m.querySelectorAll('input')];
      return {
        opened: true,
        title: ((m.querySelector('h2') || m.querySelector('h3') || {}).textContent || '').trim(),
        inputCount: inputs.length,
        hasList: !!m.querySelector('.style-list, ul, table, .styles-list'),
        buttons: [...m.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 12),
      };
    })()`);
    check(styles.opened, 'BTN_STYLES did not open the style settings overlay');
    if (styles.opened) {
      check(/style/i.test(styles.title), `style overlay title should mention "Style" (got "${styles.title}")`);
      check(styles.inputCount >= 1, 'style overlay must expose name/value inputs');
      check(styles.buttons.some((t) => /save/i.test(t)), `style overlay must offer a Save action (buttons: ${JSON.stringify(styles.buttons)})`);
    }
    await closeModals();

    // ---- KGO6-001: two CONCURRENT asyncConfirms must both settle ----
    // (the old static dedup id swallowed the second caller's onClose,
    // leaving its promise pending forever = a deadlocked feature).
    // The harness stubs window.asyncConfirm to auto-resolve, so this
    // deliberately drives the REAL implementation kept on __realAsyncConfirm.
    const concurrent = await exec(`(async () => {
      const real = window.__realAsyncConfirm;
      if (typeof real !== 'function') return { settled: false, noReal: true };
      const p1 = real('E2E concurrent confirm #1');
      const p2 = real('E2E concurrent confirm #2');
      // dismiss every stacked confirm via its Cancel button
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 120));
        const c = document.querySelector('#modal-root .confirm-modal button.btn-secondary');
        if (c) c.click(); else break;
      }
      return Promise.race([
        Promise.all([p1, p2]).then((v) => ({ settled: true, values: v })),
        new Promise((r) => setTimeout(() => r({ settled: false }), 3000)),
      ]);
    })()`);
    check(!concurrent.noReal, 'harness must expose __realAsyncConfirm for the KGO6-001 regression check');
    check(concurrent.settled, 'KGO6-001 regression: a concurrent asyncConfirm promise never settled (dedup deadlock is back)');
    await closeModals();

    // ---- premade style import (config:getPremadeStyles + confirm flow) ----
    // Exercises the one IPC channel no other scenario touches. The harness
    // auto-confirms asyncConfirm, so the click imports immediately. State is
    // restored afterwards so later scenarios see the original style list.
    const premade = await exec(`(async () => {
      window.__smoke.errors = [];
      if (typeof openSettings === 'function') openSettings();
      else document.querySelector('#btn-settings').click();
      await new Promise((r) => setTimeout(r, 250));
      const sBtn = document.querySelector(".settings-tab-button[data-tab-button='styles']");
      if (!sBtn) return { error: 'no styles pane tab' };
      sBtn.click();
      await new Promise((r) => setTimeout(r, 100));
      const prevStyles = JSON.parse(JSON.stringify(state.config.styles || []));
      const btn = [...document.querySelectorAll('.settings-modal button')].find((b) => /premade/i.test(b.textContent || ''));
      if (!btn) return { error: 'no "Add premade styles" button on the styles pane' };
      btn.click();
      // the stubbed asyncConfirm resolves true instantly -> import runs now
      await new Promise((r) => setTimeout(r, 600));
      const after = (state.config.styles || []).length;
      const imported = after - prevStyles.length;
      // cleanup: restore the original style list (mirrors persistStyles)
      state.config.styles = prevStyles;
      const _cfg = Object.assign({}, state.config);
      if (state.apiKeyNoSave) _cfg.api_key = '';
      const restore = await window.api.setConfig(_cfg);
      if (restore && restore.ok && restore.config) state.config = restore.config;
      return { imported, restored: !!(restore && restore.ok), errors: window.__smoke.errors };
    })()`);
    check(!premade.error, premade.error || '');
    if (!premade.error) {
      check(premade.imported >= 1, `premade style import should add presets (imported ${premade.imported})`);
      check(premade.restored, 'style list restore (cleanup) failed');
      check(premade.errors.length === 0, `premade import threw: ${JSON.stringify(premade.errors).slice(0, 300)}`);
    }
    await closeModals();
  },
};
