// scripts/e2e/scenarios/i18n-input.js
// ============================================================================
// Phase 3 — multilingual input acceptance (Tier 2, fake backend).
//
// The tool's UI stays English-only, but EVERY input path must accept
// arbitrary Unicode and pass it through intact to the mmx CLI. For each tab
// we type Chinese / Japanese / Arabic / emoji / mixed-direction prompts into
// the real textarea, generate against the fake backend, and assert:
//   (a) the prompt character counter counts Unicode CODE POINTS (not UTF-16
//       code units / bytes) — section12 uses Array.from().length;
//   (b) the captured argv contains the EXACT UTF-8 prompt token;
//   (c) no uncaught renderer errors fire;
//   (d) the "generation started" log row renders the text intact (its
//       title attribute carries the full, untruncated prompt).
//
// fakeOnly: asserts on the fake backend's lastFullArgs capture.
// ============================================================================

module.exports = {
  name: 'i18n-input',
  needsRealApi: false,
  fakeOnly: true,
  order: 62,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, DELAY, lastFullArgs } = ctx;

    // The argv flag that carries the free-text prompt differs per tab:
    // speech synthesizes --text, everything else generates --prompt.
    const PROMPT_FLAG = { image: '--prompt', speech: '--text', music: '--prompt', video: '--prompt' };

    const PROMPTS = [
      { label: 'chinese', text: '一只穿着宇航服的猫在月球上吃月饼' },
      { label: 'japanese', text: '桜の花びらが舞う静かな湖畔の風景' },
      { label: 'arabic', text: 'قطة ترتدي بدلة فضاء على سطح القمر' },
      { label: 'emoji', text: 'rocket 🚀🌕✨ cat 😺🐾 moon' },
      { label: 'mixed', text: '猫 cat 🐱 قطة mixé 中文!' },
    ];

    // Wait until a "generated"/success toast appears (or time out).
    async function waitForDone() {
      const deadline = Date.now() + 6000;
      for (;;) {
        const toasts = await exec(`(document.querySelector('#toast-root')||{textContent:''}).textContent`).catch(() => '');
        if (/generated/i.test(toasts || '')) return true;
        if (Date.now() > deadline) return false;
        await sleep(80);
      }
    }

    for (const tab of ['image', 'speech', 'music', 'video']) {
      const flag = PROMPT_FLAG[tab];
      for (const { label, text } of PROMPTS) {
        const expectedCount = Array.from(text).length; // code points
        // Fresh slate so we never read a stale capture from a prior gen.
        delete lastFullArgs[tab];
        await exec(`(() => {
          const tr = document.getElementById('toast-root'); if (tr) tr.innerHTML = '';
          window.__smoke.errors = [];
          if (typeof state !== 'undefined') state.generating = null;
          try { showTab(${JSON.stringify(tab)}); } catch (_) {}
          return true;
        })()`);
        // Type the prompt into the tab's textarea and fire input so the
        // character counter (section12) recomputes.
        await exec(`(() => {
          const p = document.querySelector('#tab-${tab}');
          for (const ta of p.querySelectorAll('textarea')) {
            ta.value = ${JSON.stringify(text)};
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return true;
        })()`);

        // (a) counter counts code points, not code units/bytes.
        const counter = await exec(`(() => {
          const wrap = document.querySelector('#counter-${tab}') ||
                       document.querySelector('#tab-${tab} .prompt-counter');
          if (!wrap) return { found: false, val: null, err: false };
          const valEl = wrap.querySelector('.prompt-counter-val');
          return { found: true, val: valEl ? parseInt(valEl.textContent, 10) : null, err: wrap.classList.contains('err') };
        })()`);
        check(counter.found, `${tab}/${label}: prompt counter not rendered`);
        check(counter.val === expectedCount,
          `${tab}/${label}: counter shows ${counter.val}, expected ${expectedCount} code points ` +
          `(String.length would be ${text.length}) — the counter must count code points, not UTF-16 units`);
        check(counter.err === false,
          `${tab}/${label}: counter flagged a ${expectedCount}-code-point prompt as over the limit`);

        // Generate against the fake backend.
        const clicked = await exec(`(() => {
          const p = document.querySelector('#tab-${tab}');
          const b = [...p.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Generate');
          if (!b) return false; b.click(); return true;
        })()`);
        check(clicked, `${tab}/${label}: Generate button not found`);
        const done = await waitForDone();
        await sleep(150);

        // (c) no uncaught errors.
        const errors = await exec(`window.__smoke.errors || []`).catch(() => []);
        check(errors.length === 0,
          `${tab}/${label}: threw on generate: ${JSON.stringify(errors).slice(0, 300)}`);
        check(done, `${tab}/${label}: generation never reported success`);

        // (b) the captured argv carries the exact UTF-8 prompt token.
        const argv = lastFullArgs[tab] || [];
        const idx = argv.indexOf(flag);
        const sent = idx >= 0 ? argv[idx + 1] : undefined;
        check(idx >= 0, `${tab}/${label}: argv is missing the ${flag} flag (argv: ${JSON.stringify(argv).slice(0, 200)})`);
        check(sent === text,
          `${tab}/${label}: ${flag} token was corrupted in transit.\n  expected: ${text}\n  got:      ${sent}`);

        // (d) the "generation started" log row renders the text intact — its
        // title attribute holds the full, untruncated prompt (fullText).
        const logTitle = await exec(`(() => {
          const rows = [...document.querySelectorAll('#log .log-event')];
          const started = rows.filter(r => /generation started/i.test(
            (r.querySelector('.log-event-headline') || {}).textContent || '')).pop();
          const hl = started && started.querySelector('.log-event-headline');
          return hl ? hl.getAttribute('title') : null;
        })()`);
        check(logTitle === text,
          `${tab}/${label}: log row did not render the prompt intact (title=${JSON.stringify(logTitle)})`);
      }
    }
  },
};
