// scripts/e2e/scenarios/a11y-keyboard.js
// ============================================================================
// Phase 3 — accessibility & keyboard operability (Tier 2).
//
// Two tiers of assertion, per the plan ("report-only at first, then gate once
// the baseline is green"):
//
//   GATED (check() -> fails the run):
//     • every documented global shortcut produces its effect;
//     • Escape closes ONLY the topmost modal of a stacked pair;
//     • focus returns to the invoking element when a modal closes;
//     • every icon-only button exposes an accessible name (aria-label/title).
//
//   REPORT-ONLY (printed to the run log, never fails the run):
//     • Tab-order reachability of the primary controls (native Tab focus
//       movement cannot be synthesised in-page, so we audit the focusable set
//       and confirm the primary controls are members of it).
// ============================================================================

module.exports = {
  name: 'a11y-keyboard',
  needsRealApi: false,
  order: 66,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check } = ctx;

    const key = (k, mods = {}) => exec(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', Object.assign(
        { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }, ${JSON.stringify(mods)})));
      return true;
    })()`);
    const modalCount = () => exec(`document.querySelectorAll('#modal-root .modal').length`).catch(() => -1);

    // ---- GATED: every documented global shortcut produces its effect ----
    await ctx.closeModals();
    await exec(`try { showTab('image'); } catch (_) {} true;`);

    // Ctrl+1..4 switch tabs.
    const tabs = ['image', 'speech', 'music', 'video'];
    for (let i = 0; i < tabs.length; i++) {
      await key(String(i + 1), { ctrlKey: true });
      await sleep(60);
      const cur = await exec(`(typeof state !== 'undefined') ? state.currentTab : null`).catch(() => null);
      check(cur === tabs[i], `Ctrl+${i + 1} must switch to the ${tabs[i]} tab (current: ${cur})`);
    }

    // Global shortcuts Ctrl+S, Ctrl+T, Ctrl+L perform their registered actions.
    await key('s', { ctrlKey: true }); await sleep(150);
    check((await modalCount()) >= 1, 'Ctrl+S must open Settings modal');
    await ctx.closeModals();

    await key('t', { ctrlKey: true }); await sleep(150);
    check((await modalCount()) >= 1, 'Ctrl+T must open Style Settings modal');
    await ctx.closeModals();

    // Ctrl+B opens the batch manager.
    await key('b', { ctrlKey: true });
    await sleep(150);
    check((await modalCount()) >= 1, 'Ctrl+B must open the batch manager modal');
    await ctx.closeModals();

    // Ctrl+L toggles theme.
    const themeBefore = await exec(`document.documentElement.getAttribute('data-theme')`).catch(() => null);
    await key('l', { ctrlKey: true });
    await sleep(100);
    const themeAfter = await exec(`document.documentElement.getAttribute('data-theme')`).catch(() => null);
    check(themeBefore !== themeAfter, `Ctrl+L must toggle theme (before: ${themeBefore}, after: ${themeAfter})`);
    await key('l', { ctrlKey: true }); // restore original theme
    await sleep(100);

    // Ctrl+F focuses the file-browser filter.
    await key('f', { ctrlKey: true });
    await sleep(120);
    const fbFocused = await exec(`document.activeElement && document.activeElement.id === 'fb-search'`).catch(() => false);
    check(fbFocused === true, 'Ctrl+F must move focus to the #fb-search filter input');
    await exec(`if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); true;`);

    // ---- GATED: Escape closes ONLY the topmost modal of a stacked pair ----
    await ctx.closeModals();
    await exec(`(() => { try { openSettings(); } catch (_) {} return true; })()`);
    await sleep(150);
    await exec(`(() => { try { openStyleSettings(); } catch (_) {} return true; })()`);
    await sleep(150);
    const twoOpen = await modalCount();
    check(twoOpen === 2, `expected a stacked pair of modals (settings + styles), found ${twoOpen}`);
    await key('Escape');
    await sleep(150);
    const afterOneEsc = await modalCount();
    check(afterOneEsc === 1, `a single Escape must close ONLY the topmost modal (expected 1 left, found ${afterOneEsc})`);
    await key('Escape');
    await sleep(150);
    check((await modalCount()) === 0, 'a second Escape must close the remaining modal');

    // ---- GATED: focus returns to the invoker when a modal closes ----
    await ctx.closeModals();
    const invokerId = await exec(`(() => {
      const b = document.getElementById('btn-settings') ||
        [...document.querySelectorAll('button')].find(x => /settings/i.test(x.textContent || '') && x.offsetParent !== null);
      if (!b) return null;
      b.focus();
      return document.activeElement === b ? (b.id || '(anon)') : null;
    })()`).catch(() => null);
    if (invokerId) {
      await exec(`(() => { try { openSettings(); } catch (_) {} return true; })()`);
      await sleep(180);
      await key('Escape');
      await sleep(180);
      const returned = await exec(`(() => {
        const ae = document.activeElement;
        return ae ? (ae.id || ae.tagName || 'unknown') : 'none';
      })()`).catch(() => 'read-error');
      const invokerSel = await exec(`(() => { const b = document.getElementById('btn-settings'); return b ? (b.id || b.tagName) : ''; })()`).catch(() => '');
      check(returned === invokerSel || returned === invokerId,
        `focus must return to the invoking element on modal close (invoker=${invokerSel || invokerId}, focused after close=${returned})`);
    } else {
      check(false, 'could not locate/focus a settings invoker button to test focus-return');
    }
    await ctx.closeModals();

    // ---- GATED: every icon-only button exposes an accessible name ----
    const unnamed = await exec(`(() => {
      const out = [];
      for (const b of document.querySelectorAll('button')) {
        const text = (b.textContent || '').trim();
        if (text) continue; // has visible text -> named
        const named = b.getAttribute('aria-label') || b.getAttribute('title') ||
          (b.getAttribute('aria-labelledby') && document.getElementById(b.getAttribute('aria-labelledby')));
        if (!named) out.push(b.id || b.className || '(no id/class)');
      }
      return out;
    })()`).catch(() => []);
    check(unnamed.length === 0,
      `${unnamed.length} icon-only button(s) have no accessible name (aria-label/title): ${unnamed.slice(0, 10).join(', ')}`);

    // ---- REPORT-ONLY: Tab-order reachability of the primary controls ----
    // Native Tab focus movement cannot be synthesised in-page, so audit the
    // focusable set instead: every primary control must be a focusable member.
    const reach = await exec(`(() => {
      const focusable = new Set();
      for (const el of document.querySelectorAll('button, [href], input, select, textarea, [tabindex]')) {
        if (el.disabled) continue;
        if ((el.getAttribute('tabindex') | 0) < 0) continue;
        focusable.add(el);
      }
      // Build a practical primary-control list from live queries.
      const checks = [];
      const add = (label, el) => checks.push({ label, present: !!el, focusable: !!el && focusable.has(el) });
      add('#btn-settings', document.getElementById('btn-settings'));
      add('#btn-styles', document.getElementById('btn-styles'));
      add('#fb-search', document.getElementById('fb-search'));
      for (const t of ['image', 'speech', 'music', 'video']) {
        add('tab button: ' + t, document.querySelector('.tab[data-tab="' + t + '"]'));
        const p = document.querySelector('#tab-' + t);
        const gen = p ? [...p.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Generate') : null;
        add('Generate (' + t + ')', gen);
      }
      const missing = checks.filter(c => !c.focusable);
      return { total: focusable.size, checks, missing };
    })()`).catch(() => null);
    if (reach) {
      const okCount = reach.checks.length - reach.missing.length;
      // eslint-disable-next-line no-console
      console.log(`[a11y-keyboard][report] focusable elements: ${reach.total}; primary controls reachable via Tab-order set: ${okCount}/${reach.checks.length}` +
        (reach.missing.length ? ` — NOT reachable: ${reach.missing.map(m => m.label + (m.present ? ' (present but unfocusable)' : ' (absent)')).join(', ')}` : ''));
    } else {
      // eslint-disable-next-line no-console
      console.log('[a11y-keyboard][report] focus-order audit could not run');
    }
  },
};
