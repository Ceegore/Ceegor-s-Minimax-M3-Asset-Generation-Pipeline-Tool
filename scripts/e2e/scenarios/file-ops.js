// scripts/e2e/scenarios/file-ops.js
// ============================================================================
// Phase-2 surface scenario (master_testplan TC_E2E_SETUP_003, minus the
// native-dialog and drag interactions which stay @manual).
//
// Covers the ui_map sidebar + preview + splitter surface: FB_PATH, the
// search filter, the sort select, the list itself, the bulk toolbar node,
// new-folder modal, preview pane + clear button, and all three splitters.
// BTN_FB_PICK / BTN_FB_OPEN open NATIVE OS dialogs — asserted to exist but
// never clicked (a native dialog would block the headless runner).
//
// Self-seeding: writes a real PNG into the isolated output dir (sharp) so
// the list/preview assertions work even under --isolate (fresh harness).
// ============================================================================

const path = require('path');
const fs = require('fs');
const { sel } = require('../uimap');

module.exports = {
  name: 'file-ops',
  needsRealApi: false,
  order: 35,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT, sharp, closeModals } = ctx;

    // ---- seed a real image file so the browser has something to show ----
    let seeded = null;
    try {
      if (sharp) {
        seeded = path.join(OUT, 'fileops_seed.png');
        fs.writeFileSync(seeded, await sharp({ create: { width: 8, height: 8, channels: 3, background: '#3a7' } }).png().toBuffer());
      } else {
        seeded = path.join(OUT, 'fileops_seed.txt');
        fs.writeFileSync(seeded, 'seed');
      }
    } catch (_) { seeded = null; }

    // ---- FB_PATH reflects the configured output dir ----
    const fbPathSel = sel('FB_PATH');
    const fbPath = await exec(`(() => {
      const el = document.querySelector(${JSON.stringify(fbPathSel)});
      return { exists: !!el, text: el ? el.textContent.trim() : null };
    })()`);
    check(fbPath.exists, 'FB_PATH (#fb-path) missing from the sidebar');
    if (fbPath.exists && fbPath.text) {
      const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
      check(norm(fbPath.text) === norm(OUT) || norm(fbPath.text).includes(norm(path.basename(OUT))),
        `FB_PATH should show the configured output dir "${OUT}" (got "${fbPath.text}")`);
    }

    // ---- refresh + FB_LIST renders the seeded file ----
    const listSel = sel('FB_LIST');
    const VIS_ROWS = `Array.from(document.querySelectorAll('.fb-item')).filter((i) => i.style.display !== 'none')`;
    const list = await exec(`(async () => {
      if (typeof refreshBrowser === 'function') await refreshBrowser();
      await new Promise((r) => setTimeout(r, 400));
      const l = document.querySelector(${JSON.stringify(listSel)});
      if (!l) return { exists: false };
      return { exists: true, rowCount: ${VIS_ROWS}.length, total: document.querySelectorAll('.fb-item').length };
    })()`);
    check(list.exists, 'FB_LIST (#fb-list) missing');
    check(list.rowCount > 0, `FB_LIST rendered no visible rows after refresh (seeded "${seeded}")`);

    // ---- INPUT_FB_SEARCH filters the list (rows hide via display:none) ----
    const searchSel = sel('INPUT_FB_SEARCH');
    const filter = await exec(`(async () => {
      const inp = document.querySelector(${JSON.stringify(searchSel)});
      if (!inp) return { exists: false };
      const count = () => ${VIS_ROWS}.length;
      const before = count();
      inp.value = 'zz_no_such_file_zz';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const filtered = count();
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const restored = count();
      return { exists: true, before, filtered, restored };
    })()`);
    check(filter.exists, 'INPUT_FB_SEARCH (#fb-search) missing');
    if (filter.exists) {
      check(filter.filtered === 0 || filter.filtered < filter.before,
        `typing a non-matching filter must hide rows (before=${filter.before}, filtered=${filter.filtered})`);
      check(filter.restored >= filter.before, 'clearing the filter must restore the rows');
    }

    // ---- SELECT_FB_SORT offers the documented modes + accepts a change ----
    const sortSel = sel('SELECT_FB_SORT');
    const sort = await exec(`(() => {
      const s = document.querySelector(${JSON.stringify(sortSel)});
      if (!s) return { exists: false };
      const opts = [...s.options].map((o) => o.value);
      window.__smoke.errors = [];
      const orig = s.value;
      const newest = s.options[[...s.options].findIndex((o) => /new/i.test(o.textContent + o.value))];
      if (newest) { s.value = newest.value; s.dispatchEvent(new Event('change', { bubbles: true })); }
      s.value = orig; s.dispatchEvent(new Event('change', { bubbles: true }));
      return { exists: true, opts, errors: window.__smoke.errors };
    })()`);
    check(sort.exists, 'SELECT_FB_SORT (#fb-sort) missing');
    if (sort.exists) {
      check(sort.opts.length >= 5, `SELECT_FB_SORT should offer the documented sort modes (has ${JSON.stringify(sort.opts)})`);
      check(sort.errors.length === 0, `changing the sort threw: ${JSON.stringify(sort.errors).slice(0, 200)}`);
    }

    // ---- bulk toolbar node exists (hidden until checkboxes are ticked) ----
    const bulkSel = sel('FB_BULK_TOOLBAR');
    const bulk = await exec(`(() => {
      const el = document.querySelector(${JSON.stringify(bulkSel)});
      return { exists: !!el, display: el ? getComputedStyle(el).display : null };
    })()`);
    check(bulk.exists, 'FB_BULK_TOOLBAR (#fb-bulk-toolbar) missing from the sidebar');

    // ---- new-folder button opens a modal (then close it) ----
    const newBtnSel = sel('BTN_FB_NEW');
    const nf = await exec(`(async () => {
      const b = document.querySelector(${JSON.stringify(newBtnSel)});
      if (!b) return { exists: false };
      const before = document.querySelectorAll('#modal-root .modal').length;
      b.click();
      await new Promise((r) => setTimeout(r, 150));
      const after = document.querySelectorAll('#modal-root .modal').length;
      return { exists: true, opened: after > before };
    })()`);
    check(nf.exists, 'BTN_FB_NEW (#fb-new) missing');
    check(nf.opened, 'BTN_FB_NEW click did not open the new-folder modal');
    await closeModals();

    // ---- native-dialog buttons exist but are NOT clicked (would block) ----
    for (const id of ['BTN_FB_PICK', 'BTN_FB_OPEN']) {
      const s = sel(id);
      const r = await exec(`!!document.querySelector(${JSON.stringify(s)})`);
      check(r, `${id} ("${s}") missing from the sidebar`);
    }

    // ---- clicking a row selects it; preview pane + clear button work ----
    const previewSel = sel('PREVIEW_CONTENT');
    const clearSel = sel('BTN_PREVIEW_CLEAR');
    const prev = await exec(`(async () => {
      const rows = Array.from(document.querySelectorAll('.fb-item')).filter((i) => i.style.display !== 'none' && i.dataset.name);
      let fileRow = rows.find((r) => /fileops_seed/.test(r.dataset.name || '')) || rows[rows.length - 1];
      const out = { previewExists: !!document.querySelector(${JSON.stringify(previewSel)}), clearExists: !!document.querySelector(${JSON.stringify(clearSel)}), clickedRow: !!fileRow };
      if (fileRow) {
        fileRow.click();
        await new Promise((r) => setTimeout(r, 300));
        const pc = document.querySelector(${JSON.stringify(previewSel)});
        out.previewHasContent = pc ? pc.children.length > 0 || (pc.textContent || '').trim().length > 0 : false;
        const cb = document.querySelector(${JSON.stringify(clearSel)});
        if (cb) { cb.click(); await new Promise((r) => setTimeout(r, 150)); }
      }
      return out;
    })()`);
    check(prev.previewExists, 'PREVIEW_CONTENT (#fb-preview-content) missing');
    check(prev.clearExists, 'BTN_PREVIEW_CLEAR (#preview-clear) missing');
    if (prev.clickedRow) check(prev.previewHasContent, 'clicking a file row did not populate the preview pane');

    // ---- the three layout splitters exist ----
    for (const id of ['SPLITTER_SIDEBAR', 'SPLITTER_LOGBAR', 'SPLITTER_LOG_PREVIEW']) {
      const s = sel(id);
      const r = await exec(`(() => { const el = document.querySelector(${JSON.stringify(s)}); return { exists: !!el, cls: el ? el.className : null }; })()`);
      check(r.exists, `${id} ("${s}") missing from the layout`);
      if (r.exists) check(/splitter/.test(r.cls || ''), `${id} should carry a .splitter class (got "${r.cls}")`);
    }
  },
};
