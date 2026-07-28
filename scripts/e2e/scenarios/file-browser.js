// scripts/e2e/scenarios/file-browser.js
// ============================================================================
// Ported near-verbatim from scripts/smoke-renderer.js steps 4e, 4f, 5, 5a, 5b.
//
//   4e) fb:ensureDir on an already-existing directory returns ok (stat-first,
//       no mkdir — the Windows drive-root EPERM guard).
//   4f) refImageExists: missing path → exists:false, http(s) URL → exists:true.
//   5)  the asset-type filter shows only matching files.
//   5a) #fb-up climbs one level + the drives list renders ≥1 row (both used
//       to throw "ReferenceError: process is not defined" in the live renderer).
//   5b) clicking #fb-refresh / a .tab button must NOT open a help modal
//       (HelpDelegation only fires on real .help-button / .help-btn icons).
//
// Self-contained: writes its own fixture files and restores state.fbDir.
// ============================================================================

const path = require('path');

module.exports = {
  name: 'file-browser',
  needsRealApi: false,
  order: 40,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, check, OUT } = ctx;

    // ---- 4e) fb:ensureDir on an existing dir ----
    const ensureExisting = await exec(`(async () => {
      const g = await window.GrantCache.ensurePathGrant(${JSON.stringify(OUT)}, 'mkdir', { kind: 'directory', capabilities: ['mkdir', 'write'], coversRoot: true });
      return window.api.fbEnsureDir(${JSON.stringify(OUT)}, g);
    })()`);
    check(ensureExisting && ensureExisting.ok === true,
      `fb:ensureDir on an existing directory must return ok (stat-first, no mkdir) — got ${JSON.stringify(ensureExisting)}`);

    // ---- 4f) refImageExists pre-flight ----
    const refMissing = await exec(`window.api.refImageExists(${JSON.stringify(path.join(OUT, 'definitely-not-here_zzz.jpeg'))})`);
    const refUrl = await exec(`window.api.refImageExists('https://example.com/ref.png')`);
    check(refMissing && refMissing.ok === true && refMissing.exists === false,
      `refImageExists must report a missing reference image as exists:false — got ${JSON.stringify(refMissing)}`);
    check(refUrl && refUrl.ok === true && refUrl.exists === true,
      `refImageExists must treat http(s) reference URLs as present — got ${JSON.stringify(refUrl)}`);

    // ---- 5) asset-type filter ----
    const filter = await exec(`(async () => {
      const out = state.config.output_dir; const b64 = btoa('x');
      const wg = await window.GrantCache.ensurePathGrant(out, 'write', { kind: 'directory', capabilities: ['read', 'write'], coversRoot: true });
      for (const f of ['ta.png','tb.mp3']) await window.api.fbWrite(out + '\\\\' + f, b64, wg);
      state.fbDir = out; await refreshBrowser(); await new Promise(r=>setTimeout(r,200));
      const tf = document.querySelector('#fb-type-filter'); tf.value='png,jpg,jpeg,webp,gif,bmp'; tf.dispatchEvent(new Event('change'));
      await new Promise(r=>setTimeout(r,150));
      const items=[...document.querySelectorAll('#fb-list .fb-item')].filter(li=>li.dataset.name);
      const shown=items.filter(li=>li.style.display!=='none').map(li=>li.dataset.name);
      tf.value=''; tf.dispatchEvent(new Event('change'));
      return { shown };
    })()`);
    check(filter.shown.includes('ta.png') && !filter.shown.includes('tb.mp3'),
      `type filter broken (images filter showed: ${JSON.stringify(filter.shown)})`);

    // ---- 5a) #fb-up + drives list ----
    const fbUp = await exec(`(async () => {
      const out = state.config.output_dir;
      const subA = out + '\\\\smoke_subA';
      const subB = subA + '\\\\smoke_subB';
      const g = await window.api.mintGrant(out, 'mkdir', { kind: 'directory', capabilities: ['mkdir', 'read'], coversRoot: true });
      const gid = (g && g.ok) ? g.grantId : undefined;
      try { await window.api.fbEnsureDir(subA, gid); } catch (_) {}
      try { await window.api.fbEnsureDir(subB, gid); } catch (_) {}
      state.fbDir = subB;
      await refreshBrowser();
      await new Promise((r) => setTimeout(r, 250));
      const beforeUp = state.fbDir;
      const upBtn = document.querySelector('#fb-up');
      if (upBtn) upBtn.click();
      await new Promise((r) => setTimeout(r, 400));
      const afterUp = state.fbDir;
      state.fbDir = '__DRIVES__';
      await refreshBrowser();
      await new Promise((r) => setTimeout(r, 500));
      const driveRows = document.querySelectorAll('#fb-list .fb-drive-row').length;
      return { beforeUp, afterUp, driveRows, hasUpBtn: !!upBtn };
    })()`);
    check(fbUp.afterUp !== fbUp.beforeUp,
      `clicking #fb-up from a subfolder MUST change state.fbDir — before="${fbUp.beforeUp}" after="${fbUp.afterUp}" (the pre-fix code threw "ReferenceError: process is not defined" inside isDriveRoot() and the click was silently swallowed)`);
    check(fbUp.hasUpBtn, '#fb-up button must be in the DOM');
    check(fbUp.driveRows >= 1,
      `the drives list MUST render at least 1 .fb-drive-row when state.fbDir === '__DRIVES__' — got ${fbUp.driveRows} rows. The pre-fix code threw on the first iteration of the drives loop and #fb-list ended up empty.`);
    await exec(`state.fbDir = state.config.output_dir; refreshBrowser(); new Promise(r=>setTimeout(r,200));`);

    // ---- 5b) no unwanted help popups from control clicks ----
    const helpBug = await exec(`(async () => {
      const helpModalCount = () => document.querySelectorAll('#modal-root .modal.help-modal').length;
      const refreshBtn = document.querySelector('#fb-refresh');
      const before = helpModalCount();
      if (refreshBtn) refreshBtn.click();
      await new Promise((r) => setTimeout(r, 250));
      const afterRefresh = helpModalCount();
      const tabBtn = document.querySelector('.tab');
      if (tabBtn) tabBtn.click();
      await new Promise((r) => setTimeout(r, 250));
      const afterTab = helpModalCount();
      return { before, afterRefresh, afterTab, refreshFound: !!refreshBtn, tabFound: !!tabBtn };
    })()`);
    check(helpBug.refreshFound, '#fb-refresh button must be in the DOM');
    check(helpBug.tabFound, 'a .tab button must be in the DOM');
    check(helpBug.afterRefresh === helpBug.before,
      `clicking #fb-refresh MUST NOT open a help modal — opened ${helpBug.afterRefresh - helpBug.before} new help modal(s) (pre-fix: every click on a [data-help-topic] control opened one, regardless of popupPolicy)`);
    check(helpBug.afterTab === helpBug.before,
      `clicking a .tab button MUST NOT open a help modal — opened ${helpBug.afterTab - helpBug.before} new help modal(s) (pre-fix: every tab click opened one).`);
  },
};
