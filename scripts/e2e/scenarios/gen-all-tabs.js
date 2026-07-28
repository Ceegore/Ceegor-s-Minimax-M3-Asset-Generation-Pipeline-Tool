// scripts/e2e/scenarios/gen-all-tabs.js
// ============================================================================
// Ported near-verbatim from scripts/smoke-renderer.js steps 2, 3, 3b, 3c, 3d.
//
//   2) every critical global helper is defined.
//   3) clicking Generate on every tab runs the full happy path, resets the
//      button, lands the file in the output root, shows the ActiveJobsWidget
//      with a cancellable row, and renders a clean success log row.
//   3b) two tabs generate genuinely in parallel.
//   3c) the "Target file prefix" is honoured on all four tabs.
//   3d) the speech --format enum actually changes argv + output extension.
//
// Self-contained: relies only on the harness reset() state (clean log, no
// generating flag, empty prefix), so it can run in any order / isolation.
// ============================================================================

const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'gen-all-tabs',
  needsRealApi: false,
  fakeOnly: true, // asserts on the fake backend's argv/out-path captures
  order: 10,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT, DELAY, lastOutPaths, lastFullArgs, sharp } = ctx;
    const normPath = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

    // ---- 2) critical globals ----
    const CRIT = ['ensureSubDir','slugify','timestamp','uniquePath','formatMmxError','classifyMmxError','bumpGenerationCounter',
      'armGenBtnWithCancel','applyFileSearch','showModal','showTab','refreshBrowser','buildParamRow','buildStyleRow',
      'validateTabAgainstSpec','appendFlag','escapeHtml','buildFinalPrompt','showAudioPreview','showVideoPreview',
      'notifyImageGenerated','openAllBatchDashboard','openFolderOptions','showHelp','showAudioCutter','startBatchGen','openBatchManager'];
    const globals = await exec(`(() => { const o={}; for (const n of ${JSON.stringify(CRIT)}) { try { o[n]=typeof window[n]; } catch(e){ o[n]='throw'; } } return o; })()`);
    for (const n of CRIT) check(globals[n] === 'function', `global ${n} is not a function (got ${globals[n]})`);

    // ---- 3) generate on every tab ----
    const JOBRUNNER_MIGRATED_TABS = ['image', 'speech', 'music', 'video'];
    for (const key of ['image', 'speech', 'music', 'video']) {
      const res = { built: false, clicked: false, generating: null, toasts: '', errors: [] };
      await exec(`(() => { const tr = document.getElementById('toast-root'); if (tr) tr.innerHTML = ''; return true; })()`);
      res.built = await exec(`(() => { try { showTab('${key}'); } catch(e){} const p=document.querySelector('#tab-${key}'); return !!(p && p.children.length>0); })()`);
      await exec(`(() => { window.__smoke.errors=[]; if (typeof state!=='undefined') state.generating=null;
        const p=document.querySelector('#tab-${key}'); if(p) for (const ta of p.querySelectorAll('textarea')) { ta.value='smoke ${key}'; ta.dispatchEvent(new Event('input',{bubbles:true})); } return true; })()`);
      res.clicked = await exec(`(() => { const p=document.querySelector('#tab-${key}'); const b=[...p.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Generate'); if(!b) return false; b.click(); return true; })()`);
      if (JOBRUNNER_MIGRATED_TABS.includes(key)) {
        const widgetScript = `(() => {
          const w = document.getElementById('active-jobs-widget');
          if (!w) return { found: false };
          const row = w.querySelector('.active-jobs-row');
          return {
            found: true,
            visible: w.style.display !== 'none',
            rowCount: w.querySelectorAll('.active-jobs-row').length,
            hasCancelBtn: !!(row && row.querySelector('.active-jobs-cancel')),
          };
        })()`;
        let widget = { found: false };
        for (let i = 0; i < 20; i++) {
          widget = await exec(widgetScript);
          if (widget.found && widget.rowCount > 0) break;
          await sleep(15);
        }
        check(widget.found, `tab ${key}: #active-jobs-widget was never created — JobRunner.run() is not wired up`);
        check(widget.visible, `tab ${key}: active-jobs-widget exists but is hidden during a run`);
        check(widget.rowCount === 1, `tab ${key}: expected exactly 1 active-jobs-row during the run, got ${widget.rowCount}`);
        check(widget.hasCancelBtn, `tab ${key}: active-jobs-row is missing its inline cancel (✕) button`);
      }
      await sleep(DELAY + 900);
      const readAfter = () => exec(`(() => {
        const rows = [...document.querySelectorAll('#log .log-event')];
        const okRow = rows.find(r => /generated/i.test((r.querySelector('.log-event-headline') || {}).textContent || ''));
        return {
          generating: (typeof state!=='undefined'? state.generating : null),
          errors: window.__smoke.errors||[],
          toasts: (document.querySelector('#toast-root')||{textContent:''}).textContent,
          logRowFound: !!okRow,
          logRowClass: okRow ? okRow.className : null,
          logRowHasDots: okRow ? !!okRow.querySelector('.log-wip-dots') : null,
        };
      })()`);
      let after = await readAfter();
      const toastDeadline = Date.now() + 4000;
      while (!/generated/i.test(after.toasts || '') && Date.now() < toastDeadline) {
        await sleep(100);
        after = await readAfter();
      }
      res.generating = after.generating; res.errors = after.errors; res.toasts = (after.toasts || '').replace(/\s+/g, ' ').trim();
      check(res.built, `tab ${key} did not build`);
      check(res.clicked, `tab ${key} Generate button not found`);
      check(res.errors.length === 0, `tab ${key} threw on generate: ${JSON.stringify(res.errors).slice(0, 300)}`);
      check(/generated/i.test(res.toasts), `tab ${key} did not report success (toast: ${res.toasts.slice(-120)})`);
      check(res.generating == null, `tab ${key} left state.generating set (stuck button)`);
      const dupRows = await exec(`(() => {
        const rows = [...document.querySelectorAll('#log .log-event .log-event-headline')];
        const dupes = [];
        for (let i = 1; i < rows.length; i++) {
          const a = (rows[i - 1] && rows[i - 1].textContent) || '';
          const b = (rows[i] && rows[i].textContent) || '';
          if (a && a === b) dupes.push({ idx: i, headline: a });
        }
        return { total: rows.length, dupes };
      })()`);
      check(dupRows.dupes.length === 0,
        `tab ${key} produced ${dupRows.dupes.length} duplicate adjacent log row(s) — the mmx stderr output is doubled (first duplicate: ${JSON.stringify(dupRows.dupes[0])} of ${dupRows.total} total rows). The job-aware path must drop the legacy onLog callback and de-dup consecutive identical lines within 250ms; a failure here means one of those safeguards regressed.`);
      check(after.logRowFound, `tab ${key} no log row found for the "Generated" success line`);
      check(!!after.logRowClass && /\blog-result-ok\b/.test(after.logRowClass), `tab ${key} success log row missing log-result-ok class (got: ${after.logRowClass})`);
      check(!!after.logRowClass && !/\blog-state-wip\b/.test(after.logRowClass), `tab ${key} success log row still has log-state-wip class (got: ${after.logRowClass})`);
      check(after.logRowHasDots === false, `tab ${key} success log row still has an animated wip-dots spinner`);
      const outFile = lastOutPaths[key];
      check(!!outFile, `tab ${key}: fake mmx backend never saw a resolvable --out/--download path`);
      if (outFile) {
        check(normPath(path.dirname(outFile)) === normPath(OUT),
          `tab ${key}: generated file landed in "${path.dirname(outFile)}" instead of the output root "${OUT}"`);
      }
      if (key === 'image' && outFile && sharp) {
        const expectedRenamed = outFile.replace(/\.png$/i, '.jpg');
        check(fs.existsSync(expectedRenamed),
          `tab image: fixImageExtension did not rename the JPEG-content file to .jpg (expected "${expectedRenamed}" to exist)`);
        check(!fs.existsSync(outFile),
          `tab image: the old .png-named file should no longer exist after the rename (still found "${outFile}")`);
      }
    }

    // ---- 3b) cross-tab parallelism ----
    const parallel = await exec(`(async () => {
      window.__smoke.errors = [];
      if (typeof state!=='undefined') { state.generating=null; }
      showTab('music');
      const mp = document.querySelector('#tab-music');
      for (const ta of mp.querySelectorAll('textarea')) { ta.value='smoke-parallel-music'; ta.dispatchEvent(new Event('input',{bubbles:true})); }
      const musicBtn = [...mp.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Generate');
      musicBtn.click();
      showTab('image');
      const ip = document.querySelector('#tab-image');
      for (const ta of ip.querySelectorAll('textarea')) { ta.value='smoke-parallel-image'; ta.dispatchEvent(new Event('input',{bubbles:true})); }
      const imageBtn = [...ip.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Generate');
      imageBtn.click();
      return { musicClicked: !!musicBtn, imageClicked: !!imageBtn };
    })()`);
    check(parallel.musicClicked && parallel.imageClicked, 'cross-tab parallel test: could not find both Generate buttons');

    let sawBothWipTogether = false;
    for (let i = 0; i < 30; i++) {
      const snap = await exec(`(() => ({
        music: (window.JobRunner ? window.JobRunner.isTabRunning('music') : null),
        image: (window.JobRunner ? window.JobRunner.isTabRunning('image') : null),
      }))()`);
      if (snap.music && snap.image) { sawBothWipTogether = true; break; }
      await sleep(15);
    }
    check(sawBothWipTogether,
      'music and image were never simultaneously wip — cross-tab parallelism is broken (one tab is serialized behind the other)');

    await sleep(DELAY + 900);

    const parallelAfter = await exec(`(() => ({
      generating: (typeof state!=='undefined' ? state.generating : 'undefined'),
      musicRunning: (window.JobRunner ? window.JobRunner.isTabRunning('music') : null),
      imageRunning: (window.JobRunner ? window.JobRunner.isTabRunning('image') : null),
      toasts: (document.querySelector('#toast-root')||{textContent:''}).textContent,
      errors: window.__smoke.errors||[],
    }))()`);
    check(parallelAfter.errors.length === 0, `cross-tab parallel test threw: ${JSON.stringify(parallelAfter.errors).slice(0, 300)}`);
    check(parallelAfter.musicRunning === false, 'cross-tab parallel: music job did not finish after both ran in parallel');
    check(parallelAfter.imageRunning === false, 'cross-tab parallel: image job did not finish after both ran in parallel');
    check(parallelAfter.generating == null,
      `cross-tab parallel: state.generating is stuck at "${parallelAfter.generating}" after both parallel jobs finished (armGenBtnWithCancel / JobRunner state.generating ownership race)`);
    check(/generated/i.test(parallelAfter.toasts), `cross-tab parallel test: missing a "generated" toast (got: ${parallelAfter.toasts.slice(-160)})`);

    // ---- 3c) file prefix honoured on all four tabs ----
    const B2_PREFIX = 'ZZPRE_';
    for (const k of ['image', 'speech', 'music', 'video']) delete lastOutPaths[k];
    for (const key of ['image', 'speech', 'music', 'video']) {
      await exec(`(() => {
        window.__smoke.errors = [];
        state.generating = null;
        state.filePrefix = ${JSON.stringify(B2_PREFIX)};
        state.filePrefixForceOnly = false;
        for (const sel of ['#tab-image #file-prefix', '#tab-speech #file-prefix', '#tab-music #file-prefix', '#tab-video #file-prefix']) {
          const inp = document.querySelector(sel);
          if (inp) { inp.value = state.filePrefix; inp.dispatchEvent(new Event('input', { bubbles: true })); }
        }
        showTab(${JSON.stringify(key)});
        const p = document.querySelector('#tab-' + ${JSON.stringify(key)});
        for (const ta of p.querySelectorAll('textarea')) {
          ta.value = 'smoke-prefix-' + ${JSON.stringify(key)};
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const b = [...p.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Generate');
        if (b) b.click();
        return true;
      })()`);
      await sleep(DELAY + 900);
      const outFile = lastOutPaths[key];
      check(!!outFile, `file-prefix: tab ${key}: fake mmx backend never saw a resolvable --out/--download path`);
      if (outFile) {
        const base = path.basename(outFile);
        check(base.startsWith(B2_PREFIX),
          `file-prefix: tab ${key} generated file "${base}" should start with prefix "${B2_PREFIX}" — the file-prefix feature was silently ignored on music/video in normal mode`);
      }
    }
    await exec(`state.filePrefix = ''; state.filePrefixForceOnly = false; true;`);

    // ---- 3d) speech --format enum changes argv + output extension ----
    for (const k of ['image', 'speech', 'music', 'video']) {
      delete lastFullArgs[k];
      delete lastOutPaths[k];
    }
    await exec(`(() => {
      window.__smoke.errors = [];
      state.generating = null;
      showTab('speech');
      const sp = document.querySelector('#tab-speech');
      let fmtSel = null;
      for (const row of sp.querySelectorAll('.row')) {
        const lbl = row.querySelector('label');
        if (lbl && /--format\\b/.test(lbl.textContent || '')) {
          fmtSel = row.querySelector('.combo-select-enum select');
          break;
        }
      }
      if (fmtSel) {
        fmtSel.value = 'wav';
        fmtSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      for (const ta of sp.querySelectorAll('textarea')) {
        ta.value = 'smoke-wav-format';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const b = [...sp.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Generate');
      if (b) b.click();
      return !!fmtSel;
    })()`);
    await sleep(DELAY + 900);
    const speechOut = lastOutPaths.speech;
    const speechArgs = lastFullArgs.speech || [];
    check(!!speechOut, 'speech generation did not produce an output file');
    if (speechOut) {
      check(speechOut.toLowerCase().endsWith('.wav'),
        `speech output should end in .wav when format is wav (got "${path.basename(speechOut)}") — the wrapper .value bug hardcoded .mp3 before the fix`);
    }
    check(speechArgs.includes('--format') && speechArgs[speechArgs.indexOf('--format') + 1] === 'wav',
      `speech argv must include --format wav (got argv: ${JSON.stringify(speechArgs).slice(0, 300)})`);
    // Restore the speech format so later scenarios see the default.
    await exec(`(() => {
      const sp = document.querySelector('#tab-speech');
      for (const row of sp.querySelectorAll('.row')) {
        const lbl = row.querySelector('label');
        if (lbl && /--format\\b/.test(lbl.textContent || '')) {
          const s = row.querySelector('.combo-select-enum select');
          if (s) { s.value = 'mp3'; s.dispatchEvent(new Event('change', { bubbles: true })); }
          break;
        }
      }
      return true;
    })()`).catch(() => false);
  },
};
