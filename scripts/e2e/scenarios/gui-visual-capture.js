// scripts/e2e/scenarios/gui-visual-capture.js
// ============================================================================
// Visual regression / latent-GUI-defect sweep (STD-VISUAL).
//
// Walks every main tab and the three header overlays (Styles, Settings, Image
// Editor), captures a screenshot of each state for offline inspection, and runs
// a programmatic LAYOUT AUDIT that flags the class of defects a human would
// otherwise only catch by eye:
//
//   • document-level horizontal overflow (a panel wider than the viewport →
//     an unwanted horizontal scrollbar)
//   • visible elements that spill past the right edge of the viewport
//   • overlays/modals whose content box extends beyond the viewport
//
// The overflow audit is a hard check (real layout bug); the per-element spill
// counts are reported as soft diagnostics so a single quirky absolutely-positioned
// widget doesn't fail the suite, but still surfaces in the report for review.
// ============================================================================

const { sel } = require('../uimap');

// Layout audit run inside the renderer. Returns overflow metrics + offenders.
const LAYOUT_AUDIT = `(() => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const scrollW = document.documentElement.scrollWidth;
  const issues = [];
  if (scrollW > vw + 1) issues.push('document horizontal overflow: scrollWidth=' + scrollW + ' > clientWidth=' + vw);
  const all = document.querySelectorAll('body *');
  let offRight = 0, offBottom = 0;
  const offenders = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    let style;
    try { style = getComputedStyle(el); } catch (_) { continue; }
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
    // Only count elements that START inside the viewport but extend past the
    // right edge (true overflow), ignoring intentionally off-canvas carousels.
    if (r.left >= 0 && r.left < vw && r.right > vw + 2) {
      offRight++;
      if (offenders.length < 10) offenders.push((el.id ? '#' + el.id : (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : el.tagName)) + ' right=' + Math.round(r.right));
    }
    if (style.position !== 'fixed' && r.top >= 0 && r.top < vh && r.bottom > vh + 2) offBottom++;
  }
  return { vw, vh, scrollW, scrollH: document.documentElement.scrollHeight, docOverflow: scrollW > vw + 1, offRight, offBottom, offenders, issues };
})()`;

module.exports = {
  name: 'gui-visual-capture',
  needsRealApi: false,
  order: 8,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, screenshot, closeModals } = ctx;

    const audits = {};

    // ---- walk the four main tabs, screenshot + audit each ----
    const tabs = [['TAB_IMAGE', 'image'], ['TAB_SPEECH', 'speech'], ['TAB_MUSIC', 'music'], ['TAB_VIDEO', 'video']];
    for (const [id, key] of tabs) {
      const tabSel = sel(id);
      await exec(`(() => { const b = document.querySelector(${JSON.stringify(tabSel)}); if (b) b.click(); return true; })()`);
      await sleep(220);
      await screenshot('tab-' + key);
      const a = await exec(LAYOUT_AUDIT);
      audits['tab-' + key] = a;
      check(!a.docOverflow, `tab '${key}' has document-level horizontal overflow (${a.scrollW} > ${a.vw}); offenders: ${(a.offenders || []).join(', ')}`);
    }

    // ---- Styles overlay ----
    const stylesSel = sel('BTN_STYLES');
    await exec(`(() => { const b = document.querySelector(${JSON.stringify(stylesSel)}); if (b) b.click(); return true; })()`);
    await sleep(220);
    await screenshot('overlay-styles');
    audits['overlay-styles'] = await exec(LAYOUT_AUDIT);
    for (let i = 0; i < 8; i++) await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true;`);
    await sleep(120);
    await closeModals();

    // ---- Settings dialog ----
    const settingsSel = sel('BTN_SETTINGS');
    await exec(`(() => { const b = document.querySelector(${JSON.stringify(settingsSel)}); if (b) b.click(); return true; })()`);
    await sleep(220);
    await screenshot('overlay-settings');
    audits['overlay-settings'] = await exec(LAYOUT_AUDIT);
    for (let i = 0; i < 8; i++) await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true;`);
    await sleep(120);
    await closeModals();

    // ---- Image editor overlay (empty prompt state) ----
    const editorSel = sel('BTN_IMAGE_EDIT');
    await exec(`(() => { const b = document.querySelector(${JSON.stringify(editorSel)}); if (b) b.click(); return true; })()`);
    await sleep(300);
    await screenshot('overlay-editor');
    audits['overlay-editor'] = await exec(LAYOUT_AUDIT);
    for (let i = 0; i < 8; i++) await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true;`);
    await sleep(120);
    await closeModals();

    // ---- hard check: no overlay may overflow the document horizontally ----
    for (const k of Object.keys(audits)) {
      if (k.startsWith('overlay-')) {
        check(!audits[k].docOverflow, `'${k}' has document-level horizontal overflow; offenders: ${(audits[k].offenders || []).join(', ')}`);
      }
    }

    // ---- soft diagnostic: report per-state element spill counts ----
    const spill = Object.keys(audits).map((k) => `${k}: offRight=${audits[k].offRight} offBottom=${audits[k].offBottom}`).join('; ');
    check(true, `layout spill diagnostics -> ${spill}`);
  },
};
