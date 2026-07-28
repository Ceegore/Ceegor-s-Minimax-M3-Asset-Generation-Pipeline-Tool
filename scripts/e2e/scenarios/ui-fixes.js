// scripts/e2e/scenarios/ui-fixes.js
// ============================================================================
// Ported near-verbatim from scripts/smoke-renderer.js steps 4d + 7.
//
//   4d) custom-value enum wrapper in DOM + visible on "Custom…", Browse…
//       button on file-picker rows, log pane scrolls + is text-selectable,
//       secondary mmx rows not stuck wip, popup policy 'never' still opens
//       the always-on welcome, and the pipeline<viewer<modal<toast z-order.
//   7)  #fb-options opens the Folder options modal; the log-help "?" button
//       must NOT open a help modal (hover-only icons).
//
// Self-contained: probes use disposable DOM nodes and restore modal state.
// ============================================================================

module.exports = {
  name: 'ui-fixes',
  needsRealApi: false,
  order: 30,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, check } = ctx;

    // ---- 4d) UI regression checks ----
    const uiFixes = await exec(`(async () => {
      const out = {};
      // --- custom-value input fields for parameters ---
      showTab('image');
      const wrap = document.querySelector('#tab-image .combo-select-enum');
      out.customWrapInDom = !!wrap;
      if (wrap) {
        const sel = wrap.querySelector('select');
        const input = wrap.querySelector('input.enum-custom-input');
        sel.value = '__custom__';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        out.customHasOption = [...sel.options].some((o) => o.value === '__custom__');
        out.customInputVisible = !!(input && (input.offsetWidth || input.offsetHeight));
        out.customInputDisplay = input ? getComputedStyle(input).display : null;
      }
      out.subjRefHasBrowse = !!([...document.querySelectorAll('#tab-image .text-browse-row button')]
        .find((b) => /browse/i.test(b.textContent || '')));
      // --- log pane must scroll (be height-bounded, content overflows) ---
      for (let i = 0; i < 80; i++) window.LogService.addLogEvent({ category: 'info', headline: 'scroll-probe ' + i, details: ['path C:/x/y' + i] });
      await new Promise((r) => setTimeout(r, 50));
      const logEl = document.querySelector('#log');
      out.logClientH = logEl.clientHeight;
      out.logScrollH = logEl.scrollHeight;
      out.logScrolls = logEl.scrollHeight > logEl.clientHeight + 2;
      const t0 = logEl.scrollTop;
      logEl.scrollTop = -50; const tNeg = logEl.scrollTop;
      logEl.scrollTop = 50; const tPos = logEl.scrollTop;
      out.logScrollTopMoved = (tNeg !== t0) || (tPos !== t0);
      logEl.scrollTop = 0;
      // --- log text is selectable (pane opts into user-select:text) ---
      out.logUserSelect = getComputedStyle(logEl).webkitUserSelect || getComputedStyle(logEl).userSelect;
      // --- secondary mmx output lines must NOT be stuck 'wip' ---
      const sjob = window.JobRunner.run({ tabKey: null, type: 'music', title: 'wip-probe', suppressLogRow: true, runFn: async () => ({ status: 'ok' }) });
      await sjob.done;
      window.LogService.addLogEvent({ category: 'info', headline: '{ "saved": "C:/x/y.mp3" }', jobId: sjob.jobId, _internal: true });
      await new Promise((r) => setTimeout(r, 30));
      const savedRow = [...document.querySelectorAll('#log .log-event')].find((r) => /saved/.test(r.textContent || ''));
      out.savedRowFound = !!savedRow;
      out.savedRowIsWip = savedRow ? savedRow.classList.contains('log-state-wip') : null;
      out.savedRowHasDots = savedRow ? !!savedRow.querySelector('.log-wip-dots') : null;
      // --- welcome always opens; policy still suppresses tab-intros ---
      const modalCount = () => document.querySelectorAll('#modal-root .modal').length;
      for (let i = 0; i < 8; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 30));
      state.popupPolicy = 'never';
      if (typeof resetPopupSeen === 'function') resetPopupSeen();
      const before = modalCount();
      showStartupPopup();
      showTab('speech');
      if (typeof maybeShowTabIntro === 'function') maybeShowTabIntro('speech');
      await new Promise((r) => setTimeout(r, 60));
      out.popupsBefore = before;
      out.popupsAfterNever = modalCount();
      out.neverGate = shouldShowPopup('startup');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      // Layering contract: pipeline < viewer < modal < toast.
      const zProbe = (className) => {
        const node = document.createElement('div'); node.className = className;
        document.body.appendChild(node);
        const z = Number(getComputedStyle(node).zIndex || 0);
        node.remove();
        return z;
      };
      out.zOrder = {
        pipeline: zProbe('pipeline-overlay'), viewer: zProbe('image-overlay'),
        modal: Number(getComputedStyle(document.getElementById('modal-root')).zIndex || 0),
        toast: Number(getComputedStyle(document.getElementById('toast-root')).zIndex || 0),
      };
      return out;
    })()`);
    check(uiFixes.customWrapInDom === true,
      'the enum param WRAPPER (.combo-select-enum, which holds the custom-value text input + OK button) must be in the DOM — only the bare <select> was being inserted, so "Custom…" revealed no input field');
    check(uiFixes.customInputVisible === true,
      `selecting "Custom…" must reveal the custom-value text input (visible), got display=${uiFixes.customInputDisplay}`);
    check(uiFixes.subjRefHasBrowse === true,
      'file-picker param rows (e.g. --subject-ref) must show their Browse… button — it lived in the wrapper that was being dropped from the DOM');
    check(uiFixes.logScrolls === true,
      `the log pane must be height-bounded so it scrolls — clientH=${uiFixes.logClientH} must be < scrollH=${uiFixes.logScrollH} (it was growing to full content height and clipping rows)`);
    check(uiFixes.logScrollTopMoved === true,
      'the log pane must actually scroll (scrollTop must be settable to a non-zero value)');
    check(/text/.test(String(uiFixes.logUserSelect)),
      `the log pane must be text-selectable (user-select:text) so entries can be selected + copied, got "${uiFixes.logUserSelect}"`);
    check(uiFixes.savedRowFound === true, 'the simulated mmx secondary "saved" log row should exist');
    check(uiFixes.savedRowIsWip === false,
      'a finished job secondary mmx output line (e.g. the "{ saved }" row) must NOT keep the wip/blue "still running" state');
    check(uiFixes.savedRowHasDots === false,
      'the secondary mmx output row must not show the animated wip "…" running indicator after the job finished');
    check(uiFixes.popupsAfterNever === 1,
      `with popup policy 'never', exactly the always-on welcome popup may open (tab intros stay suppressed) — opened ${uiFixes.popupsAfterNever} modal(s)`);
    check(uiFixes.neverGate === false,
      "shouldShowPopup must return false under the 'never' policy");
    check(uiFixes.zOrder.pipeline < uiFixes.zOrder.viewer && uiFixes.zOrder.viewer < uiFixes.zOrder.modal && uiFixes.zOrder.modal < uiFixes.zOrder.toast,
      `layering must remain pipeline < viewer < modal < toast, got ${JSON.stringify(uiFixes.zOrder)}`);

    // ---- 7) dead-control modals ----
    const ctrls = await exec(`(async () => {
      const mr = document.querySelector('#modal-root');
      mr.innerHTML=''; mr.classList.remove('active');
      document.querySelector('#fb-options').click(); await new Promise(r=>setTimeout(r,150));
      const opt = !!mr.querySelector('.folder-options-modal') || [...mr.querySelectorAll('h2')].some(h=>/Folder options/.test(h.textContent));
      mr.innerHTML=''; mr.classList.remove('active');
      document.querySelector('#log-help').click(); await new Promise(r=>setTimeout(r,150));
      const helpModalCount = mr.querySelectorAll('.modal.help-modal').length;
      const help = helpModalCount;
      mr.innerHTML=''; mr.classList.remove('active');
      return { opt, help };
    })()`);
    check(ctrls.opt, 'fb-options button did not open the Folder options modal');
    check(ctrls.help === 0,
      `clicking the log-help "?" button must NOT open a help modal (the ? icons are hover-only now) — got ${ctrls.help} help modal(s) in #modal-root`);
  },
};
