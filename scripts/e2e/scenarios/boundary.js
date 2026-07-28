// scripts/e2e/scenarios/boundary.js
// ============================================================================
// Phase 3 — edge cases / boundary conditions (Tier 2, fake backend).
//
// Covers the "feedback #4" edge-case matrix that the happy-path scenarios
// never hit:
//   • a prompt exactly AT the image limit (1500) generates fine;
//   • a prompt ONE OVER the limit (1501) is rejected up-front with a precise
//     toast and never starts a job;
//   • an EMPTY prompt is rejected with the "required" guard;
//   • an OVERSIZED prompt (5000 chars) trips the counter's .err state and the
//     generate guard;
//   • special chars / XSS payloads are rendered as inert text (CSP + textContent
//     construction) — nothing executes, no element is injected;
//   • rapid tab-switching + modal-stack re-entrancy (the EDGE_002 sequence)
//     leaves no errors and no stuck modals.
//
// fakeOnly: the over-limit / empty guards fire before any backend call, but the
// at-limit happy path asserts on the fake backend's capture.
// ============================================================================

module.exports = {
  name: 'boundary',
  needsRealApi: false,
  fakeOnly: true,
  order: 64,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, DELAY, lastFullArgs } = ctx;

    async function clearToasts() {
      return exec(`(() => { const tr = document.getElementById('toast-root'); if (tr) tr.innerHTML = ''; return true; })()`);
    }
    async function toasts() {
      return (await exec(`(document.querySelector('#toast-root')||{textContent:''}).textContent`).catch(() => '')) || '';
    }
    async function setPrompt(tab, text) {
      return exec(`(() => {
        try { showTab(${JSON.stringify(tab)}); } catch (_) {}
        const p = document.querySelector('#tab-${tab}');
        for (const ta of p.querySelectorAll('textarea')) {
          ta.value = ${JSON.stringify(text)};
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      })()`);
    }
    async function clickGenerate(tab) {
      return exec(`(() => {
        const p = document.querySelector('#tab-${tab}');
        const b = [...p.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Generate');
        if (!b) return false; b.click(); return true;
      })()`);
    }
    async function imageRunning() {
      return exec(`(window.JobRunner && typeof window.JobRunner.isTabRunning === 'function')
        ? window.JobRunner.isTabRunning('image') : null`).catch(() => null);
    }

    // ---- 1500 chars: exactly at the limit -> generates fine ----
    await clearToasts();
    await exec(`window.__smoke.errors = []; if (typeof state!=='undefined') state.generating = null; true;`);
    delete lastFullArgs.image;
    const at1500 = 'a'.repeat(1500);
    await setPrompt('image', at1500);
    await clickGenerate('image');
    let done1500 = false;
    for (let i = 0; i < 60; i++) { if (/generated/i.test(await toasts())) { done1500 = true; break; } await sleep(80); }
    check(done1500, 'a 1500-char prompt (exactly at the image limit) must generate, but no success toast appeared');
    check((lastFullArgs.image || []).includes(at1500),
      'a 1500-char prompt must reach the mmx argv intact');

    // ---- 1501 chars: one over -> rejected up-front, no job started ----
    await clearToasts();
    await exec(`window.__smoke.errors = []; if (typeof state!=='undefined') state.generating = null; true;`);
    delete lastFullArgs.image;
    await setPrompt('image', 'a'.repeat(1501));
    await clickGenerate('image');
    await sleep(DELAY + 300);
    const over = await toasts();
    check(/1501/.test(over) && /(at most|over|max)/i.test(over),
      `a 1501-char prompt must be rejected with a precise over-limit toast (got: ${over.slice(-160)})`);
    check((await imageRunning()) === false,
      'a 1501-char prompt must NOT start a job (isTabRunning should stay false)');
    check(!(lastFullArgs.image || []).some(a => typeof a === 'string' && a.length === 1501),
      'a 1501-char prompt must never reach the mmx backend');

    // ---- empty prompt -> "required" guard ----
    await clearToasts();
    await exec(`if (typeof state!=='undefined') state.generating = null; true;`);
    await setPrompt('image', '');
    await clickGenerate('image');
    await sleep(200);
    const emptyToast = await toasts();
    check(/prompt is required|required/i.test(emptyToast),
      `an empty prompt must be rejected with the "required" guard (got: ${emptyToast.slice(-160)})`);
    check((await imageRunning()) === false, 'an empty prompt must NOT start a job');

    // ---- oversized (5000 chars) -> counter .err + generate guard ----
    await clearToasts();
    await setPrompt('image', 'x'.repeat(5000));
    const oversizedCounter = await exec(`(() => {
      const wrap = document.querySelector('#counter-image') || document.querySelector('#tab-image .prompt-counter');
      return wrap ? wrap.classList.contains('err') : null;
    })()`);
    check(oversizedCounter === true,
      'a 5000-char prompt must put the character counter into its .err (over-limit) state');
    await clickGenerate('image');
    await sleep(200);
    const oversizedToast = await toasts();
    check(/5000/.test(oversizedToast),
      `an oversized prompt must be rejected citing its length (got: ${oversizedToast.slice(-160)})`);
    check((await imageRunning()) === false, 'an oversized prompt must NOT start a job');

    // ---- special chars / XSS: rendered as inert text, nothing executes ----
    await clearToasts();
    await exec(`window.__xssProbe = 0; window.__smoke.errors = []; if (typeof state!=='undefined') state.generating = null; true;`);
    delete lastFullArgs.image;
    const xss = '<img src=x onerror="window.__xssProbe=1"><script>window.__xssProbe=2<\/script>"\'&<>';
    await setPrompt('image', xss);
    await clickGenerate('image');
    let xssDone = false;
    for (let i = 0; i < 60; i++) { if (/generated/i.test(await toasts())) { xssDone = true; break; } await sleep(80); }
    check(xssDone, 'a special-chars prompt must still generate (it is valid API input)');
    const probe = await exec(`window.__xssProbe`).catch(() => 'read-error');
    check(probe === 0,
      `XSS payload executed! __xssProbe became ${probe} — the prompt was injected as live markup (must be inert text)`);
    const injected = await exec(`document.querySelectorAll('#log script, #log img[src="x"], #toast-root script').length`).catch(() => -1);
    check(injected === 0,
      `XSS payload injected ${injected} live element(s) into the log/toast DOM (must render as escaped text)`);
    check((lastFullArgs.image || []).includes(xss),
      'the special-chars prompt must reach the mmx argv byte-for-byte intact');
    // The started log row must show the payload as literal text (textContent),
    // not as parsed HTML.
    const renderedAsText = await exec(`(() => {
      const rows = [...document.querySelectorAll('#log .log-event')];
      const started = rows.filter(r => /generation started/i.test(
        (r.querySelector('.log-event-headline') || {}).textContent || '')).pop();
      return started ? started.textContent.includes('<img src=x') : false;
    })()`);
    check(renderedAsText === true,
      'the XSS payload must be visible as literal text in the log row (proves textContent rendering, not innerHTML)');

    // ---- rapid tab-switch + modal-stack re-entrancy (EDGE_002) ----
    await exec(`window.__smoke.errors = []; true;`);
    await ctx.closeModals();
    await exec(`(() => {
      for (const t of ['speech','music','video','image','speech','music','image','video']) {
        try { showTab(t); } catch (_) {}
      }
      return true;
    })()`);
    await sleep(150);
    // Re-enter the modal stack: open settings, then styles on top, then close
    // them one at a time with Escape (each Escape must pop exactly one).
    await exec(`(() => { try { openSettings(); } catch (_) {} return true; })()`);
    await sleep(150);
    await exec(`(() => { try { openStyleSettings(); } catch (_) {} return true; })()`);
    await sleep(150);
    const stacked = await exec(`document.querySelectorAll('#modal-root .modal').length`).catch(() => 0);
    check(stacked >= 1, 'modal re-entrancy: opening settings then styles must leave at least one modal open');
    await ctx.closeModals();
    const remaining = await exec(`document.querySelectorAll('#modal-root .modal').length`).catch(() => -1);
    check(remaining === 0, `after Escape-closing, ${remaining} modal(s) remain stuck open`);
    const edgeErrors = await exec(`window.__smoke.errors || []`).catch(() => []);
    check(edgeErrors.length === 0,
      `rapid tab-switch + modal re-entrancy threw: ${JSON.stringify(edgeErrors).slice(0, 300)}`);
  },
};
