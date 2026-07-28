// scripts/e2e/realUtils.js
// ============================================================================
// Shared helpers for the Tier-3 (real-generation) scenarios. These run in the
// Electron MAIN process, so they may use fs/path directly. Unlike the fake
// tier, there is NO argv/out-path capture here (the real mmx IPC is wired), so
// success is proven by watching the isolated output tree for a new non-zero
// file and by the renderer's own success signals (log-result-ok row + toast).
// ============================================================================

const fs = require('fs');
const path = require('path');

// Recursively collect { path -> size } for every file under dir.
function collectFiles(dir, out = new Map()) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else if (e.isFile()) { try { out.set(p, fs.statSync(p).size); } catch (_) { /* raced */ } }
  }
  return out;
}

// Files present in `after` that are new (or grew) relative to `before`.
function newFiles(before, after) {
  const added = [];
  for (const [p, size] of after) {
    if (!before.has(p) || after.get(p) > before.get(p)) added.push({ path: p, size });
  }
  return added;
}

// ---- in-page helpers (drive the real renderer through ctx.exec) ----
async function clearState(ctx, tab) {
  return ctx.exec(`(() => {
    const tr = document.getElementById('toast-root'); if (tr) tr.innerHTML = '';
    window.__smoke.errors = [];
    if (typeof state !== 'undefined') state.generating = null;
    try { showTab(${JSON.stringify(tab)}); } catch (_) {}
    return true;
  })()`);
}
async function setPrompt(ctx, tab, text) {
  return ctx.exec(`(() => {
    const p = document.querySelector('#tab-${tab}');
    for (const ta of p.querySelectorAll('textarea')) {
      ta.value = ${JSON.stringify(text)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  })()`);
}
async function clickGenerate(ctx, tab) {
  return ctx.exec(`(() => {
    const p = document.querySelector('#tab-${tab}');
    const b = [...p.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Generate');
    if (!b) return false; b.click(); return true;
  })()`);
}
async function toastText(ctx) {
  return (await ctx.exec(`(document.querySelector('#toast-root')||{textContent:''}).textContent`).catch(() => '')) || '';
}
async function hasOkGeneratedRow(ctx) {
  return ctx.exec(`(() => {
    const rows = [...document.querySelectorAll('#log .log-event')];
    return rows.some(r => /\\blog-result-ok\\b/.test(r.className) &&
      /generated/i.test((r.querySelector('.log-event-headline') || {}).textContent || ''));
  })()`).catch(() => false);
}

// Set a numeric param row (e.g. --n) by choosing a preset in its
// .combo-select-number <select>. `labelRe` matches the row's <label> text.
function setNumberParam(ctx, tab, labelRe, value) {
  return ctx.exec(`(() => {
    const p = document.querySelector('#tab-${tab}');
    for (const row of p.querySelectorAll('.row')) {
      const lbl = row.querySelector('label');
      if (lbl && ${labelRe}.test(lbl.textContent || '')) {
        const sel = row.querySelector('.combo-select-number select') || row.querySelector('select');
        if (sel) { sel.value = ${JSON.stringify(String(value))}; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
      }
    }
    return false;
  })()`);
}

/**
 * Drive one real generation end-to-end and assert the plan's success contract:
 * a new non-zero file on disk + a log-result-ok "Generated" row + a success
 * toast + no uncaught renderer errors.
 *
 * @param {object} ctx     harness context
 * @param {object} opts
 * @param {string} opts.tab          image|speech|music|video
 * @param {string} opts.label        human label for assertion messages
 * @param {string} opts.prompt       the prompt/text to generate from
 * @param {number} opts.timeoutMs    max wait for the generation to finish
 * @param {RegExp} [opts.extRe]      optional: at least one new file must match
 * @param {Array}  [opts.paramSetters] optional: async fns(ctx) run before gen
 * @returns {Array<{path,size}>} the new files that landed
 */
async function genAndVerify(ctx, opts) {
  const { exec, sleep, check, OUT } = ctx;
  const label = opts.label;
  await clearState(ctx, opts.tab);
  for (const setter of (opts.paramSetters || [])) await setter(ctx);
  await setPrompt(ctx, opts.tab, opts.prompt);
  const before = collectFiles(OUT);
  const clicked = await clickGenerate(ctx, opts.tab);
  check(clicked, `${label}: Generate button not found on the ${opts.tab} tab`);

  let sawToast = false;
  let sawLog = false;
  const deadline = Date.now() + (opts.timeoutMs || 120000);
  for (;;) {
    if (/generated/i.test(await toastText(ctx))) sawToast = true;
    if (await hasOkGeneratedRow(ctx)) { sawLog = true; break; }
    if (Date.now() > deadline) break;
    await sleep(300);
  }

  const added = newFiles(before, collectFiles(OUT)).filter((f) => f.size > 0);
  check(added.length > 0, `${label}: no new non-zero file landed under the isolated output tree`);
  if (opts.extRe && added.length) {
    check(added.some((f) => opts.extRe.test(f.path.toLowerCase())),
      `${label}: no output matched ${opts.extRe} — got: ${added.map((f) => path.basename(f.path)).join(', ')}`);
  }
  check(sawLog, `${label}: no log-result-ok "Generated" row appeared within ${opts.timeoutMs}ms`);
  check(sawToast, `${label}: no "generated" success toast appeared`);
  const errs = await exec(`window.__smoke.errors || []`).catch(() => []);
  check(errs.length === 0, `${label}: uncaught renderer errors: ${JSON.stringify(errs).slice(0, 300)}`);
  return added;
}

module.exports = { collectFiles, newFiles, genAndVerify, setNumberParam, clearState, setPrompt, clickGenerate, toastText, hasOkGeneratedRow };
