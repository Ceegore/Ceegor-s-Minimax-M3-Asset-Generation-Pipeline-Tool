// scripts/e2e/scenarios/setup-nav.js
// ============================================================================
// Phase-2 surface scenario (master_testplan TC_E2E_SETUP_001, non-paid parts).
//
// Drives the main-interface chrome straight off tests/ui_map.json ids:
// brand + version, all four tab buttons, quota cluster, theme toggle,
// styles/settings/editor openers, and the statusbar. Every selector comes
// from uimap.sel() so the surface report counts exactly what ui_map.json
// declares, and the in-page recorder sees the real interactions.
// ============================================================================

const { sel } = require('../uimap');

module.exports = {
  name: 'setup-nav',
  needsRealApi: false,
  order: 5,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, closeModals } = ctx;

    // ---- brand + version render ----
    const brandSel = sel('BRAND');
    const brandVerSel = sel('BRAND_VERSION');
    const brand = await exec(`(() => {
      const b = document.querySelector(${JSON.stringify(brandSel)});
      const v = document.querySelector(${JSON.stringify(brandVerSel)});
      return { brand: !!b, brandText: b ? b.textContent.trim() : null, ver: !!v, verText: v ? v.textContent.trim() : null };
    })()`);
    check(brand.brand, 'BRAND (.brand) missing from the header');
    check(/MiniMax/i.test(brand.brandText || ''), `BRAND text should contain "MiniMax" (got "${brand.brandText}")`);
    check(brand.ver, 'BRAND_VERSION (#brand-version) missing from the header');

    // ---- clicking the brand reopens the welcome popup (force:true) ----
    const welcome = await exec(`(async () => {
      document.querySelector(${JSON.stringify(brandSel)}).click();
      await new Promise((r) => setTimeout(r, 150));
      const n = document.querySelectorAll('#modal-root .modal').length;
      return n;
    })()`);
    check(welcome >= 1, 'clicking .brand must reopen the welcome popup (force:true)');
    await closeModals();

    // ---- theme toggle flips and restores ----
    const themeSel = sel('BTN_THEME');
    const theme = await exec(`(async () => {
      const btn = document.querySelector(${JSON.stringify(themeSel)});
      if (!btn) return { error: 'no #btn-theme' };
      const cur = () => document.documentElement.getAttribute('data-theme');
      const before = cur();
      btn.click(); await new Promise((r) => setTimeout(r, 120));
      const toggled = cur();
      btn.click(); await new Promise((r) => setTimeout(r, 120));
      const restored = cur();
      return { before, toggled, restored };
    })()`);
    check(!theme.error, theme.error || '');
    if (!theme.error) {
      check(theme.toggled !== theme.before, `BTN_THEME click did not flip data-theme ("${theme.before}" -> "${theme.toggled}")`);
      check(theme.restored === theme.before, 'second BTN_THEME click did not restore the original data-theme');
    }

    // ---- all four tabs switch via their ui_map tab buttons ----
    for (const [id, key] of [['TAB_IMAGE', 'image'], ['TAB_SPEECH', 'speech'], ['TAB_MUSIC', 'music'], ['TAB_VIDEO', 'video']]) {
      const tabSel = sel(id);
      const r = await exec(`(() => {
        const btn = document.querySelector(${JSON.stringify(tabSel)});
        if (!btn) return { error: 'missing ${id}' };
        btn.click();
        const panel = document.querySelector('#tab-${key}');
        return { clicked: true, panelBuilt: !!(panel && panel.children.length > 0), active: btn.classList.contains('active') || btn.getAttribute('aria-selected') === 'true' || btn.dataset.active === '1' };
      })()`);
      check(!r.error, r.error || '');
      if (!r.error) {
        check(r.panelBuilt, `${id}: #tab-${key} panel not built after clicking the tab button`);
      }
    }

    // ---- quota cluster exists; refresh button survives a click (fake stub) ----
    const quotaLabelSel = sel('QUOTA_LABEL');
    const quotaValueSel = sel('QUOTA_VALUE');
    const quotaBtnSel = sel('BTN_QUOTA_REFRESH');
    const quota = await exec(`(async () => {
      const lbl = document.querySelector(${JSON.stringify(quotaLabelSel)});
      const val = document.querySelector(${JSON.stringify(quotaValueSel)});
      const btn = document.querySelector(${JSON.stringify(quotaBtnSel)});
      if (!lbl || !val || !btn) return { error: 'quota cluster incomplete', lbl: !!lbl, val: !!val, btn: !!btn };
      window.__smoke.errors = [];
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true, label: lbl.textContent.trim(), valueText: val.textContent.trim(), errors: window.__smoke.errors };
    })()`);
    check(!quota.error, `quota cluster incomplete: ${JSON.stringify(quota)}`);
    if (!quota.error) {
      check(/quota/i.test(quota.label), `QUOTA_LABEL should read "Quota …" (got "${quota.label}")`);
      check(quota.errors.length === 0, `BTN_QUOTA_REFRESH click threw: ${JSON.stringify(quota.errors).slice(0, 200)}`);
    }

    // ---- header openers: styles, settings, image editor ----
    const stylesSel = sel('BTN_STYLES');
    const settingsSel = sel('BTN_SETTINGS');
    const editorSel = sel('BTN_IMAGE_EDIT');
    const openers = await exec(`(async () => {
      const out = {};
      const modalCount = () => document.querySelectorAll('#modal-root .modal').length;
      // Styles overlay (Ctrl+T button)
      const sb = document.querySelector(${JSON.stringify(stylesSel)});
      out.stylesBtn = !!sb;
      if (sb) { sb.click(); await new Promise((r) => setTimeout(r, 150)); out.stylesOpened = modalCount() > 0 || !!document.querySelector('.style-settings-modal, .styles-modal'); }
      for (let i = 0; i < 8; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 100));
      // Settings dialog (Ctrl+S button)
      const st = document.querySelector(${JSON.stringify(settingsSel)});
      out.settingsBtn = !!st;
      if (st) { st.click(); await new Promise((r) => setTimeout(r, 150)); out.settingsOpened = !!document.querySelector('.settings-modal'); }
      for (let i = 0; i < 8; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 100));
      // Image editor (✏ button)
      const ed = document.querySelector(${JSON.stringify(editorSel)});
      out.editorBtn = !!ed;
      if (ed) { ed.click(); await new Promise((r) => setTimeout(r, 150)); out.editorOpened = !!document.querySelector('.image-editor-modal'); }
      for (let i = 0; i < 8; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 100));
      return out;
    })()`);
    check(openers.stylesBtn && openers.stylesOpened, 'BTN_STYLES did not open the style settings overlay');
    check(openers.settingsBtn && openers.settingsOpened, 'BTN_SETTINGS did not open the .settings-modal dialog');
    check(openers.editorBtn && openers.editorOpened, 'BTN_IMAGE_EDIT did not open the .image-editor-modal');
    await closeModals();

    // ---- statusbar shows Ready when idle ----
    const statusSel = sel('STATUSBAR');
    const status = await exec(`(() => {
      const s = document.querySelector(${JSON.stringify(statusSel)});
      return { exists: !!s, text: s ? s.textContent.trim() : null, busy: s ? s.classList.contains('busy') : null };
    })()`);
    check(status.exists, 'STATUSBAR (#statusbar) missing');
    check(status.exists && !status.busy, `STATUSBAR should not be .busy when idle (text: "${status.text}")`);
  },
};
