// scripts/e2e/scenarios/image-guards.js
// ============================================================================
// Phase-2 surface scenario (master_testplan TC_E2E_IMG_003 + the image-tab
// parameter surface of TC_E2E_IMG_001/002, no paid generation).
//
// Walks every automatable image_tab element in tests/ui_map.json (style
// preset, file prefix + force checkbox, width/height/n/seed/response-format/
// prompt-optimizer/watermark selects, subject-ref input, pipeline badge),
// then exercises the validation guards: empty-prompt rejection, the
// variants>1 -> seed-disabled interlock. All selectors via uimap.sel().
// ============================================================================

const { sel } = require('../uimap');

module.exports = {
  name: 'image-guards',
  needsRealApi: false,
  order: 15,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, closeModals } = ctx;

    await exec(`showTab('image'); true;`);
    await sleep(80);

    // ---- parameter surface: every declared select/input exists w/ options ----
    const SELECTS = [
      ['IMG_STYLE_PRESET', null],
      ['IMG_WIDTH', null],
      ['IMG_HEIGHT', null],
      ['IMG_N', ['1', '2', '3', '4']],
      ['IMG_SEED', null],
      ['IMG_RESP_FMT', ['url', 'base64']],
      ['IMG_PROMPT_OPT', null],
      ['IMG_WATERMARK', null],
    ];
    for (const [id, expectOpts] of SELECTS) {
      const s = sel(id);
      const r = await exec(`(() => {
        const el = document.querySelector(${JSON.stringify(s)});
        if (!el) return { exists: false };
        return { exists: true, tag: el.tagName, options: el.tagName === 'SELECT' ? el.options.length : null };
      })()`);
      check(r.exists, `${id}: selector "${s}" matched nothing in the image tab`);
      if (r.exists && r.tag === 'SELECT') {
        check(r.options > 0, `${id}: select has no <option>s`);
        if (expectOpts) {
          const have = await exec(`Array.from(document.querySelector(${JSON.stringify(s)}).options).map(o => o.value)`);
          for (const v of expectOpts) check(have.includes(v), `${id}: missing option "${v}" (has: ${JSON.stringify(have).slice(0, 200)})`);
        }
      }
    }

    // ---- file prefix input + force-prefix checkbox ----
    const prefixSel = sel('IMG_FILE_PREFIX');
    const forceSel = sel('IMG_FORCE_PREFIX');
    const subjSel = sel('IMG_SUBJECT_REF');
    const inputs = await exec(`(() => {
      const p = document.querySelector(${JSON.stringify(prefixSel)});
      const f = document.querySelector(${JSON.stringify(forceSel)});
      const sr = document.querySelector(${JSON.stringify(subjSel)});
      const out = { prefix: !!p, force: !!f, subj: !!sr };
      if (p) { p.value = 'guard_'; p.dispatchEvent(new Event('input', { bubbles: true })); out.prefixVal = p.value; }
      if (f) { f.checked = true; f.dispatchEvent(new Event('change', { bubbles: true })); out.forceChecked = f.checked; f.checked = false; f.dispatchEvent(new Event('change', { bubbles: true })); }
      if (p) { p.value = ''; p.dispatchEvent(new Event('input', { bubbles: true })); }
      return out;
    })()`);
    check(inputs.prefix, `IMG_FILE_PREFIX: selector "${prefixSel}" matched nothing`);
    check(inputs.force, `IMG_FORCE_PREFIX: selector "${forceSel}" matched nothing`);
    check(inputs.subj, `IMG_SUBJECT_REF: selector "${subjSel}" matched nothing`);
    check(inputs.prefixVal === 'guard_', 'IMG_FILE_PREFIX input did not accept a typed value');

    // ---- pipeline badge node exists (hidden when the board is empty) ----
    const badgeSel = sel('IMG_PIPELINE_BADGE');
    const badge = await exec(`(() => {
      const b = document.querySelector(${JSON.stringify(badgeSel)});
      return { exists: !!b, text: b ? b.textContent.trim() : null };
    })()`);
    check(badge.exists, `IMG_PIPELINE_BADGE (#pipeline-badge) missing from the image tab action bar`);

    // ---- guard: empty prompt is rejected with a warning, no job starts ----
    const empty = await exec(`(async () => {
      window.__smoke.errors = [];
      if (typeof state !== 'undefined') state.generating = null;
      const tr = document.getElementById('toast-root'); if (tr) tr.innerHTML = '';
      const p = document.querySelector('#tab-image');
      for (const ta of p.querySelectorAll('textarea')) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
      // style preset -> (no style) so nothing is prepended
      const styleSel = document.querySelector(${JSON.stringify(prefixSel.replace('target_file_prefix', 'style'))});
      const b = [...p.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Generate');
      if (!b) return { error: 'no Generate button' };
      const jobsBefore = window.JobRunner ? window.JobRunner.activeCount?.() ?? -1 : -1;
      b.click();
      await new Promise((r) => setTimeout(r, 250));
      const toasts = (document.querySelector('#toast-root') || { textContent: '' }).textContent;
      const jobsAfter = window.JobRunner ? window.JobRunner.activeCount?.() ?? -1 : -1;
      return { toasts, jobsBefore, jobsAfter, errors: window.__smoke.errors, running: window.JobRunner ? window.JobRunner.isTabRunning('image') : null };
    })()`);
    check(!empty.error, empty.error || '');
    if (!empty.error) {
      check(/prompt|required|empty/i.test(empty.toasts),
        `clicking Generate with an empty prompt must warn (toast said: "${(empty.toasts || '').slice(0, 120)}")`);
      check(empty.running === false, 'empty-prompt Generate must NOT start a job');
      check(empty.errors.length === 0, `empty-prompt guard threw: ${JSON.stringify(empty.errors).slice(0, 200)}`);
    }

    // ---- guard: a fixed seed disables the variants control ----
    // (buildVariantsRow: seeded generation + N variants would produce N
    // identical images, so the variants select locks while a seed is set)
    const interlock = await exec(`(() => {
      const variants = document.getElementById('variants-image');
      const seed = document.querySelector(${JSON.stringify(sel('IMG_SEED'))});
      if (!variants || !seed) return { error: 'variants or seed control missing' };
      const origSeed = seed.value;
      const before = variants.disabled;
      seed.value = '42'; seed.dispatchEvent(new Event('change', { bubbles: true }));
      const during = variants.disabled;
      seed.value = origSeed || ''; seed.dispatchEvent(new Event('change', { bubbles: true }));
      const after = variants.disabled;
      return { before, during, after, origSeed };
    })()`);
    check(!interlock.error, interlock.error || '');
    if (!interlock.error) {
      check(interlock.before === false, 'variants control must be enabled while the seed is Random');
      check(interlock.during === true, 'variants control must be DISABLED while a fixed seed (42) is set — seeded variants would waste quota on identical images');
      check(interlock.after === false, 'variants control must re-enable when the seed returns to Random');
    }

    // leave a clean state for the next scenario
    await exec(`(() => { const tr = document.getElementById('toast-root'); if (tr) tr.innerHTML = ''; return true; })()`);
    await closeModals();
  },
};
