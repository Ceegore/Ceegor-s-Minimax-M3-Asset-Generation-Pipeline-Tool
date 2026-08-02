// scripts/smoke-renderer.js — comprehensive headless renderer regression test.
//
// Boots the REAL renderer (index.html + every <script>) in a hidden
// Electron BrowserWindow with the REAL preload + REAL main-process IPC
// (only the mmx generation backend is stubbed, so no network / no mmx
// binary is needed). It then exercises the main user flows and asserts
// they actually work — catching the class of bug that unit tests on the
// pure helpers cannot see, because that code only runs when the real DOM
// handlers fire.
//
// Coverage (each is a hard assertion; any failure → exit code 1):
//   1. init() completes and every tab builds.
//   2. The critical global helpers are all defined.
//   3. Clicking Generate on every tab runs the full happy path
//      (ReferenceError-free) and resets the button. The generated file
//      must land directly in the output root, not a hidden
//      <output_dir>/<tab> subfolder. Every tab is migrated to
//      JobRunner.run() — the ActiveJobsWidget must appear with a
//      cancellable row while each job is wip, and (3b) starting
//      Generate on two different tabs back-to-back must run them
//      genuinely in parallel, not block one on the other.
//   4. BatchGen auto-remove drains completed items from the queue.
//   5. The folder-browser asset-type filter shows matching files only.
//   6. The audio-cutter modal (window.showAudioCutter) opens, probes,
//      and exports a trimmed clip.
//   7. The "⚙ Options" and log "?" buttons open their modals.
//   8. No uncaught errors / error-level console messages anywhere.
//
// Run via:  node scripts/run-smoke.js   (sets up env + electron)
// Output:   JSON report between SMOKE_BEGIN/SMOKE_END, then PASS/FAIL.

const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_ROOT = path.resolve(__dirname, '..');
// Backend latency so the BatchGen runner (which polls state.generating)
// behaves like it would against the real, slow mmx backend.
const DELAY = Number(process.env.SMOKE_DELAY_MS) || 250;

// ---- isolated temp config dir (never touch the user's real config) ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-smoke-'));
const OUT = path.join(TMP, 'out');
fs.mkdirSync(OUT, { recursive: true });
process.env.MINIMAX_CONFIG_DIR = TMP;
fs.writeFileSync(path.join(TMP, 'config.txt'),
  `api_key=sk-smoke-test-key-0000000000\noutput_dir=${OUT}\nregion=global\ntheme=dark\n`, 'utf8');

const { app, BrowserWindow, ipcMain } = require('electron');
try { require(path.join(APP_ROOT, 'main', 'window', 'windowSecurity')); } catch (_) {}
let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* smoke degrades to dummy bytes if sharp is unavailable */ }
// Replicates the real mmx image output (real JPEG bytes) so the smoke run
// reproduces the actual content/extension mismatch instead of writing
// meaningless dummy bytes.

const consoleMsgs = [];
const mainErrors = [];
// Keyed by the mmx subcommand (args[0], e.g. 'image'/'speech'/'music'/'video')
// so the smoke run can assert WHERE each generated file actually landed on
// disk — not just that the write succeeded. Confirms at the live-renderer
// level that a fresh, never-visited tab resolves its output to the
// configured root (OUT), not a hidden <OUT>/<tab> subfolder.
const lastOutPaths = {};
// Full argv of the most recent fake mmx call per subcommand, so the smoke
// can assert that mode/format flags are actually pushed (they used to be
// silently dropped by the .input.value-on-wrapper bug).
const lastFullArgs = {};

// ---- fake mmx backend: writes a real output file + returns ok:true ----
function findOutPath(args) {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--out' || args[i] === '--download' || args[i] === '-o') return args[i + 1];
  }
  for (const a of args) if (typeof a === 'string' && a.toLowerCase().startsWith(OUT.toLowerCase())) return a;
  return null;
}
async function runFakeMmx(args) {
  args = Array.isArray(args) ? args : [];
  if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
  if (typeof args[0] === 'string') lastFullArgs[args[0]] = args.slice();
  const outFile = findOutPath(args);
  if (outFile) {
    if (typeof args[0] === 'string') lastOutPaths[args[0]] = outFile;
    // Do NOT create the parent directory — the real mmx does not. This
    // makes the test actually verify that ensureSubDir created the
    // per-tab output folder. If it didn't, the write fails with ENOENT
    // and a failure is returned, exactly like the real mmx (regression
    // guard for the drive-root mkdir bug).
    try {
      // The real mmx image API has no output-format parameter, so the
      // CDN bytes it returns sometimes don't match the .png extension the
      // renderer hardcodes. Replicate that exact mismatch (real JPEG
      // bytes written to a .png-named path) so the smoke run exercises
      // the live fixImageExtension rename end-to-end, not just a dummy
      // write.
      if (sharp && args[0] === 'image' && /\.png$/i.test(outFile)) {
        const buf = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#a33' } }).jpeg().toBuffer();
        fs.writeFileSync(outFile, buf);
      } else {
        fs.writeFileSync(outFile, Buffer.from([0, 1, 2, 3]));
      }
    }
    catch (e) { return { ok: false, code: 1, stdout: '', stderr: 'ENOENT (smoke): ' + e.message, parsed: null, command: 'mmx', argv: args }; }
  }
  return { ok: true, code: 0, stdout: 'smoke ok', stderr: '', parsed: { smoke: true }, command: 'mmx', argv: args };
}
function registerFakeMmx() {
  ipcMain.handle('mmx:run', async (_e, args) => runFakeMmx(args));
  // The real registerMmxIpc.js also registers mmx:run:job (used once a tab
  // is migrated to JobRunner.run, so jobId flows through for per-job cancel
  // + log routing) — without this, a migrated tab's mmxRunJob call has no
  // handler in the smoke harness and fails with a misleading
  // "No handler registered" error unrelated to the code under test.
  // B.3: capture the trailing grantId so the batch step can assert it.
  ipcMain.handle('mmx:run:job', async (_e, payload, grantId) => {
    global.__smokeLastMmxGrantId = grantId;
    return runFakeMmx(payload && payload.args);
  });
  ipcMain.handle('mmx:voices', async () => []);
  ipcMain.handle('mmx:quota', async () => ({ ok: false, error: 'smoke-stub' }));
  ipcMain.handle('mmx:cancel', () => ({ ok: true }));
  ipcMain.handle('mmx:authStatus', async () => ({ ok: false, error: 'smoke-stub' }));
  ipcMain.handle('mmx:diagnose', async () => ({ platform: process.platform, smoke: true }));
}

// Keep in lock-step with the ipcRegistrars list in main/index.js (minus
// registerMmxIpc, which is stubbed above). 360° audit 2026-07-11: the four
// registrars added for external tools / Pipeline / editor Heal were missing
// here, so the whole Pipeline + inpaint IPC surface was invisible to the
// smoke harness ("No handler registered for 'pipeline:import'").
// KGO7-004: derived from main/ipcRegistrarNames.js — NEVER hand-maintained.
// This list drifted from main/index.js three separate times (pathGrant in
// R7.5, jobIpc in BGR-007, reset+m3+providers in KGO7), each time making a
// real handler invisible to the smoke run.
const REGISTRARS = require(path.join(APP_ROOT, 'main', 'ipcRegistrarNames')).harnessRegistrarNames();

let win = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exec = (js) => win.webContents.executeJavaScript(js);

const problems = [];
function check(cond, label) { if (!cond) problems.push(label); return !!cond; }

async function run() {
  registerFakeMmx();
  for (const r of REGISTRARS) {
    try { require(path.join(APP_ROOT, 'main', 'ipc', r)).register({ appRoot: APP_ROOT, getMainWindow: () => win }); }
    catch (e) { mainErrors.push(`registrar ${r} failed: ${e && e.stack || e}`); }
  }

  win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: {
    preload: path.join(APP_ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (details) =>
    consoleMsgs.push({
      level: details.level,
      message: details.message,
      source: details.sourceId ? path.basename(String(details.sourceId)) : '',
      line: details.lineNumber,
    }));
  win.webContents.on('render-process-gone', (_e, d) => mainErrors.push('render-process-gone ' + JSON.stringify(d)));
  win.webContents.on('preload-error', (_e, p, err) => mainErrors.push('preload-error ' + (err && err.stack || err)));

  await win.loadFile(path.join(APP_ROOT, 'renderer', 'index.html'));
  await exec(`window.__smoke = { errors: [] };
    addEventListener('error', (e) => window.__smoke.errors.push('error: ' + ((e.error && e.error.stack) || e.message)));
    addEventListener('unhandledrejection', (e) => window.__smoke.errors.push('rejection: ' + ((e.reason && e.reason.stack) || e.reason)));
    // Auto-confirm so a pre-generation warning dialog can never block the
    // headless run (the validator's correctness is covered by unit tests).
    window.confirm = () => true;
    window.asyncConfirm = () => Promise.resolve(true); true;`);

  // 1) init completes
  let inited = false;
  for (let i = 0; i < 80; i++) {
    if (await exec(`!!(document.querySelector('#tab-image') && document.querySelector('#tab-image').children.length > 0)`).catch(() => false)) { inited = true; break; }
    await sleep(250);
  }
  check(inited, 'init() did not complete (image tab never built)');

  // dismiss startup popups so they don't sit over later interactions
  await exec(`for (let i=0;i<6;i++) document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true;`);
  await sleep(150);

  // 2) critical globals
  const CRIT = ['ensureSubDir','slugify','timestamp','uniquePath','formatMmxError','classifyMmxError','bumpGenerationCounter',
    'armGenBtnWithCancel','applyFileSearch','showModal','showTab','refreshBrowser','buildParamRow','buildStyleRow',
    'validateTabAgainstSpec','appendFlag','escapeHtml','buildFinalPrompt','showAudioPreview','showVideoPreview',
    'notifyImageGenerated','openAllBatchDashboard','openFolderOptions','showHelp','showAudioCutter','startBatchGen','openBatchManager'];
  const globals = await exec(`(() => { const o={}; for (const n of ${JSON.stringify(CRIT)}) { try { o[n]=typeof window[n]; } catch(e){ o[n]='throw'; } } return o; })()`);
  for (const n of CRIT) check(globals[n] === 'function', `global ${n} is not a function (got ${globals[n]})`);

  // 3) generate on every tab
  const normPath = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  // Tabs migrated to JobRunner.run() so far — grown as each tab's generate
  // handler is migrated. Drives the ActiveJobsWidget assertion below.
  const JOBRUNNER_MIGRATED_TABS = ['image', 'speech', 'music', 'video'];
  const tabs = {};
  for (const key of ['image', 'speech', 'music', 'video']) {
    const res = { built: false, clicked: false, generating: null, toasts: '', errors: [] };
    // BGR-006 fix: reset the toast accumulator before each tab's generation
    // test so per-tab assertions are isolated (no cross-tab toast bleed).
    await exec(`(() => { const tr = document.getElementById('toast-root'); if (tr) tr.innerHTML = ''; return true; })()`);
    res.built = await exec(`(() => { try { showTab('${key}'); } catch(e){} const p=document.querySelector('#tab-${key}'); return !!(p && p.children.length>0); })()`);
    // showTab() resetting fbDir instead of inheriting the previous tab's
    // folder is not meaningfully exercisable here — in a fresh install
    // every tab's "leftover" fbDir converges on the output root anyway via
    // refreshBrowser()'s own subfolder-preference fallback, so old (buggy)
    // and new (fixed) showTab() code observe the same value in this linear
    // single-pass flow. That precise regression guard lives in
    // realCodeHarness.test.js (source-pinned on the exact else-branch).
    await exec(`(() => { window.__smoke.errors=[]; if (typeof state!=='undefined') state.generating=null;
      const p=document.querySelector('#tab-${key}'); if(p) for (const ta of p.querySelectorAll('textarea')) { ta.value='smoke ${key}'; ta.dispatchEvent(new Event('input',{bubbles:true})); } return true; })()`);
    res.clicked = await exec(`(() => { const p=document.querySelector('#tab-${key}'); const b=[...p.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Generate'); if(!b) return false; b.click(); return true; })()`);
    if (JOBRUNNER_MIGRATED_TABS.includes(key)) {
      // Verify "ActiveJobsWidget appears during a run." genBtn.click()
      // returns as soon as the async click handler hits its FIRST await
      // (ensureSubDir, near the top) — JobRunner.run() isn't called until
      // after that resolves, so the widget isn't guaranteed to exist the
      // instant click() returns. Poll briefly (well within the fake mmx
      // backend's DELAY) instead of checking exactly once.
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
    // The image tab's success toast lands only AFTER its heavy post-gen work
    // (per-file refreshBrowser + preview rebuild), which can exceed the fixed
    // 900ms window on a busy machine — a fixed single read made this check
    // flaky (X3-07). Poll up to ~4s more for the success toast; break as soon
    // as it appears so a healthy run stays fast.
    let after = await readAfter();
    const toastDeadline = Date.now() + 4000;
    while (!/generated/i.test(after.toasts || '') && Date.now() < toastDeadline) {
      await sleep(100);
      after = await readAfter();
    }
    res.generating = after.generating; res.errors = after.errors; res.toasts = (after.toasts || '').replace(/\s+/g, ' ').trim();
    tabs[key] = res;
    check(res.built, `tab ${key} did not build`);
    check(res.clicked, `tab ${key} Generate button not found`);
    check(res.errors.length === 0, `tab ${key} threw on generate: ${JSON.stringify(res.errors).slice(0, 300)}`);
    check(/generated/i.test(res.toasts), `tab ${key} did not report success (toast: ${res.toasts.slice(-120)})`);
    check(res.generating == null, `tab ${key} left state.generating set (stuck button)`);
    // Regression guard for doubled mmx log rows. The main process used to
    // emit each mmx stderr line twice (once via onLog, once via onChunk),
    // and the renderer folded neither into the primary row. The fix drops
    // onLog from the job-aware path and adds a 250ms consecutive-line
    // de-dup window. After a generation completes, no two adjacent log
    // rows may carry the same headline text.
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
    // A successful generation's log row must render its real result colour,
    // not a permanently-spinning blue "in progress" row.
    check(after.logRowFound, `tab ${key} no log row found for the "Generated" success line`);
    check(!!after.logRowClass && /\blog-result-ok\b/.test(after.logRowClass), `tab ${key} success log row missing log-result-ok class (got: ${after.logRowClass})`);
    check(!!after.logRowClass && !/\blog-state-wip\b/.test(after.logRowClass), `tab ${key} success log row still has log-state-wip class (got: ${after.logRowClass})`);
    check(after.logRowHasDots === false, `tab ${key} success log row still has an animated wip-dots spinner`);
    // On a fresh tab (fbDir === output root per the check above), the
    // generated file must land directly in the root, NOT a hidden
    // <output_dir>/<tab> subfolder the browser isn't even showing.
    const outFile = lastOutPaths[key];
    check(!!outFile, `tab ${key}: fake mmx backend never saw a resolvable --out/--download path`);
    if (outFile) {
      check(normPath(path.dirname(outFile)) === normPath(OUT),
        `tab ${key}: generated file landed in "${path.dirname(outFile)}" instead of the output root "${OUT}"`);
    }
    // The fake mmx backend wrote real JPEG bytes to a .png-named path for
    // the image tab (replicating the actual CDN/extension mismatch). The
    // live renderer must sniff this and rename the file to .jpg
    // end-to-end before any downstream code (preview, the log row,
    // notifyImageGenerated) captures the old name.
    if (key === 'image' && outFile && sharp) {
      const expectedRenamed = outFile.replace(/\.png$/i, '.jpg');
      check(fs.existsSync(expectedRenamed),
        `tab image: fixImageExtension did not rename the JPEG-content file to .jpg (expected "${expectedRenamed}" to exist)`);
      check(!fs.existsSync(outFile),
        `tab image: the old .png-named file should no longer exist after the rename (still found "${outFile}")`);
    }
  }

  // 3b) cross-tab parallelism: a job on one tab must NOT block Generate on
  // a different tab, and both must complete correctly without clobbering
  // each other's state.generating / ActiveJobsWidget tracking. Start
  // music, then — WITHOUT awaiting anything in between, so both clicks
  // land before either's fake-mmx DELAY elapses — start image too. This
  // is the core requirement: a music batch + image batch + a manual
  // speech can run simultaneously.
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

  // genBtn.click() returns as soon as the async handler hits its FIRST
  // await (ensureSubDir, near the top, BEFORE JobRunner.run() is even
  // called) — so neither job is guaranteed to be wip the instant both
  // click() calls above return (this bit the single-tab ActiveJobsWidget
  // check earlier too). Poll for a window where BOTH are wip AT THE SAME
  // TIME — if cross-tab parallelism were broken (one tab serialized
  // behind the other), music would fully finish before image ever
  // started, so no sampled instant would ever show both true.
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

  // Poll until BOTH parallel jobs finish (fixed sleep was flaky under load).
  for (let i = 0; i < 200; i++) {
    const snap = await exec(`(() => ({
      m: (window.JobRunner ? window.JobRunner.isTabRunning('music') : false),
      g: (window.JobRunner ? window.JobRunner.isTabRunning('image') : false),
    }))()`);
    if (!snap.m && !snap.g) break;
    await sleep(25);
  }
  // Small settle so the generate handler's finally{} clears state.generating.
  await sleep(150);

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

  // 3c) The "Target file prefix" feature was silently ignored on the Music
  // and Video tabs in normal (non-force) mode — image/speech prepended
  // `state.filePrefix` to the generated filename, but music/video did
  // not. Force-prefix-only mode worked on all four; the normal-mode path
  // was missing the `${prefix}` interpolation in the uniquePath() call.
  //
  // This step sets a known prefix, generates on ALL FOUR tabs, and
  // asserts the prefix appears at the START of every generated filename.
  // This is the live end-to-end regression guard.
  const B2_PREFIX = 'ZZPRE_'; // distinctive so it can't appear by accident
  // Reset per-tab state and clear the lastOutPaths captures so we
  // can assert about ONLY this run's filenames.
  for (const k of ['image', 'speech', 'music', 'video']) delete lastOutPaths[k];
  // Drive all four tabs through Generate with the prefix set. Use a
  // serial loop (not parallel) so each tab's filename is captured
  // cleanly in lastOutPaths[k] without any race.
  for (const key of ['image', 'speech', 'music', 'video']) {
    await exec(`(() => {
      window.__smoke.errors = [];
      state.generating = null;
      state.filePrefix = ${JSON.stringify(B2_PREFIX)};
      state.filePrefixForceOnly = false;
      // Mirror the prefix input so a future "input change → save state"
      // path doesn't overwrite state.filePrefix mid-run.
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
    // Poll until the fake backend records the output (fixed sleep was flaky).
    for (let i = 0; i < 200; i++) {
      if (lastOutPaths[key]) break;
      await sleep(25);
    }
    const outFile = lastOutPaths[key];
    check(!!outFile, `file-prefix: tab ${key}: fake mmx backend never saw a resolvable --out/--download path`);
    if (outFile) {
      const base = path.basename(outFile);
      check(base.startsWith(B2_PREFIX),
        `file-prefix: tab ${key} generated file "${base}" should start with prefix "${B2_PREFIX}" — the file-prefix feature was silently ignored on music/video in normal mode`);
    }
  }
  // Clear the prefix so downstream smoke steps aren't affected.
  await exec(`state.filePrefix = ''; state.filePrefixForceOnly = false; true;`);

  // 3d) The music tab's "Vocal mode" dropdown and --format fields are
  // `kind: 'enum'` ParamRows, so their `.input` is a wrapper DIV. The tab
  // handlers used to read `.input.value` (undefined on a div), so:
  //   - selecting "Instrumental" NEVER pushed `--instrumental` to argv
  //   - selecting a non-mp3 speech format NEVER changed the output
  //     extension (always .mp3)
  // This step sets speech format → wav, generates, and asserts the
  // resulting argv + filename reflect the real selections. Live
  // end-to-end regression guard.
  for (const k of ['image', 'speech', 'music', 'video']) {
    delete lastFullArgs[k];
    delete lastOutPaths[k];
  }

  // Music mode check was removed because Vocal Mode was completely removed.
  // Speech: set --format to wav, assert the output file ends in .wav.
  await exec(`(() => {
    window.__smoke.errors = [];
    state.generating = null;
    showTab('speech');
    const sp = document.querySelector('#tab-speech');
    // The speech tab has several combo-select-enum rows (model, voice,
    // format, ...). Find the FORMAT row specifically by its label text
    // so we set the right <select> (querying '.combo-select-enum select'
    // would match the model row first).
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
  // Poll until the fake backend records the speech output (fixed sleep was flaky).
  for (let i = 0; i < 200; i++) {
    if (lastOutPaths.speech) break;
    await sleep(25);
  }
  const speechOut = lastOutPaths.speech;
  const speechArgs = lastFullArgs.speech || [];
  check(!!speechOut, 'speech generation did not produce an output file');
  if (speechOut) {
    check(speechOut.toLowerCase().endsWith('.wav'),
      `speech output should end in .wav when format is wav (got "${path.basename(speechOut)}") — the wrapper .value bug hardcoded .mp3 before the fix`);
  }
  check(speechArgs.includes('--format') && speechArgs[speechArgs.indexOf('--format') + 1] === 'wav',
    `speech argv must include --format wav (got argv: ${JSON.stringify(speechArgs).slice(0, 300)})`);

  // 4) batch auto-remove drains the queue
  // B.3: clear state._fbGrantId to simulate a PURE-BATCH flow (no prior
  // interactive Generate). The batch must mint its own grant and forward it.
  global.__smokeLastMmxGrantId = undefined;
  const batch = await exec(`(async () => {
    window.__smoke.errors=[];
    state._fbGrantId = undefined; // simulate pure-batch (no prior ensureSubDir)
    state.batchesAutoRemove = true;
    state.batches.image = ['ba','bb','bc'];
    await window.api.batchesSet(state.batches);
    _refreshBatchButtons();
    await startBatchGen('image');
    return { remaining: (state.batches.image||[]).length, errors: window.__smoke.errors };
  })()`);
  check(batch.remaining === 0, `batch auto-remove failed: ${batch.remaining} items left (expected 0)`);
  check((batch.errors || []).length === 0, `batch threw: ${JSON.stringify(batch.errors).slice(0, 200)}`);
  // B.3: the pure-batch flow must mint + forward a real grant to mmxRunJob.
  check(typeof global.__smokeLastMmxGrantId === 'string' && global.__smokeLastMmxGrantId.length > 0,
    `pure-batch must forward a non-empty grantId to mmx:run:job (got: ${JSON.stringify(global.__smokeLastMmxGrantId)})`);

  // 4a) The BatchGen "■ Stop batch" button used to live INSIDE .preview,
  // which the tab's own generate handler wipes via preview.innerHTML =
  // '<spinner>' during generation — clobbering the button out of the DOM
  // within the first item's generation, almost immediately. It must now
  // survive as a sibling of .preview. Use 'speech' (separate from the
  // 'image' batch test above) so the two don't interact.
  await exec(`(async () => {
    window.__smoke.errors = [];
    state.batchesAutoRemove = true;
    state.batches.speech = ['sa', 'sb'];
    await window.api.batchesSet(state.batches);
    _refreshBatchButtons();
    window.__smokeSpeechBatchDone = startBatchGen('speech');
    return true;
  })()`);
  let stopBtnFoundMidRun = false;
  for (let i = 0; i < 60; i++) {
    const snap = await exec(`(() => ({
      running: (window.JobRunner ? window.JobRunner.isTabRunning('speech') : null),
      stopBtnFound: !!([...document.querySelectorAll('#tab-speech button')].find((b) => (b.textContent||'').includes('Stop batch'))),
    }))()`);
    if (snap.running) { stopBtnFoundMidRun = snap.stopBtnFound; break; }
    await sleep(15);
  }
  check(stopBtnFoundMidRun,
    'the BatchGen "Stop batch" button must remain findable in the DOM while a batch item is actively generating, not just at the instant the batch was started (it must survive the tab\'s own preview.innerHTML status updates)');
  const speechBatchResult = await exec(`(async () => {
    await window.__smokeSpeechBatchDone;
    return { remaining: (state.batches.speech || []).length, errors: window.__smoke.errors };
  })()`);
  check(speechBatchResult.remaining === 0, `speech batch auto-remove failed: ${speechBatchResult.remaining} items left (expected 0)`);
  check((speechBatchResult.errors || []).length === 0, `speech batch threw: ${JSON.stringify(speechBatchResult.errors).slice(0, 200)}`);

  // 4b) Represent the WHOLE batch as one parent JobRunner job
  // (tabKey:null, so ActiveJobsWidget shows a single "Batch: Music (2
  // items)" row instead of N individual jobs flickering by) and feed
  // JobSummary.emit() at the end. Use 'music' (not yet used by a batch
  // test in this file) so it can't interact with the image/speech batch
  // tests above.
  await exec(`(async () => {
    window.__smoke.errors = [];
    state.batchesAutoRemove = true;
    state.batches.music = ['ma', 'mb'];
    await window.api.batchesSet(state.batches);
    _refreshBatchButtons();
    window.__smokeMusicBatchDone = startBatchGen('music');
    return true;
  })()`);
  let musicParentJobId = null;
  let musicParentJobTitle = null;
  for (let i = 0; i < 60; i++) {
    const snap = await exec(`(() => {
      const jobs = window.JobRunner ? window.JobRunner.activeJobs() : [];
      const parent = jobs.find((j) => j.type === 'music' && j.tab === null);
      return parent ? { id: parent.id, title: parent.title } : null;
    })()`);
    if (snap) { musicParentJobId = snap.id; musicParentJobTitle = snap.title; break; }
    await sleep(15);
  }
  check(!!musicParentJobId,
    'startBatchGen must register a PARENT JobRunner job with tabKey:null (job.tab === null) — ActiveJobsWidget needs this to show one "Batch: …" row instead of N individual jobs flickering by');
  check(/^Batch: Music/.test(musicParentJobTitle || ''),
    `the parent job's title should start with "Batch: Music", got: ${JSON.stringify(musicParentJobTitle)}`);
  const musicBatchResult = await exec(`(async () => {
    await window.__smokeMusicBatchDone;
    const summaryRow = state._logEvents.slice().reverse().find((e) => /^Batch finished:/.test(e.headline || ''));
    return {
      remaining: (state.batches.music || []).length,
      errors: window.__smoke.errors,
      summaryHeadline: summaryRow ? summaryRow.headline : null,
      summaryJobId: summaryRow ? summaryRow.jobId : null,
    };
  })()`);
  check(musicBatchResult.remaining === 0, `music batch auto-remove failed: ${musicBatchResult.remaining} items left (expected 0)`);
  check((musicBatchResult.errors || []).length === 0, `music batch threw: ${JSON.stringify(musicBatchResult.errors).slice(0, 200)}`);
  check(!!musicBatchResult.summaryHeadline,
    'JobSummary.emit() must log a "Batch finished: N/M ok" row once the batch parent job settles');
  check(/^Batch finished: 2\/2 ok/.test(musicBatchResult.summaryHeadline || ''),
    `expected a "Batch finished: 2/2 ok" summary row, got: ${JSON.stringify(musicBatchResult.summaryHeadline)}`);
  check(musicBatchResult.summaryJobId === musicParentJobId,
    `the summary row's jobId must point at the batch PARENT job (${JSON.stringify(musicParentJobId)}), got: ${JSON.stringify(musicBatchResult.summaryJobId)}`);

  // 4c) cancel a batch mid-run via the JobRunner-level API directly — NOT
  // a simulated DOM click. Driving cancellation through the overlay's
  // button raced with the still-in-flight generation and intermittently
  // hung earlier versions of this harness (the Stop button is itself
  // clobbered out of the DOM almost immediately by the tab's own
  // preview.innerHTML status updates — a separate pre-existing UX issue).
  // window.JobRunner.cancel(jobId) is the exact same call
  // ActiveJobsWidget's ✕ button makes, so this exercises the real
  // cancellation path (ac.signal.abort -> ctx.signal 'abort' listener ->
  // window._batchAbortByTab[tabKey] -> the existing per-item loop)
  // without depending on any element's DOM lifetime.
  await exec(`(async () => {
    window.__smoke.errors = [];
    state.batchesAutoRemove = true;
    state.batches.video = ['va', 'vb'];
    await window.api.batchesSet(state.batches);
    _refreshBatchButtons();
    window.__smokeVideoBatchDone = startBatchGen('video');
    return true;
  })()`);
  let videoParentJobId = null;
  for (let i = 0; i < 60; i++) {
    const snap = await exec(`(() => {
      const jobs = window.JobRunner ? window.JobRunner.activeJobs() : [];
      const parent = jobs.find((j) => j.type === 'video' && j.tab === null);
      return parent ? parent.id : null;
    })()`);
    if (snap) { videoParentJobId = snap; break; }
    await sleep(15);
  }
  check(!!videoParentJobId, 'video batch must register a parent JobRunner job before any item starts');
  await exec(`window.JobRunner.cancel(${JSON.stringify(videoParentJobId)}); true;`);
  const videoCancelResult = await exec(`(async () => {
    await window.__smokeVideoBatchDone;
    const job = state.jobs.get(${JSON.stringify(videoParentJobId)});
    return {
      jobStatus: job ? job.status : null,
      remaining: (state.batches.video || []).length,
      abortFlag: window._batchAbortByTab.video,
      errors: window.__smoke.errors,
    };
  })()`);
  check(videoCancelResult.jobStatus === 'cancel',
    `cancelling the batch PARENT job via JobRunner.cancel(jobId) (the same call ActiveJobsWidget's ✕ makes) must settle it to status 'cancel', got: ${JSON.stringify(videoCancelResult.jobStatus)}`);
  check(videoCancelResult.abortFlag === true,
    "cancelling the parent job must bridge through ctx.signal's abort event into window._batchAbortByTab[tabKey] so the existing per-item loop actually stops");
  check(videoCancelResult.remaining > 0,
    `a batch cancelled right after starting must not silently run to completion — expected at least 1 item still queued, got ${videoCancelResult.remaining} remaining`);
  check((videoCancelResult.errors || []).length === 0, `video batch threw: ${JSON.stringify(videoCancelResult.errors).slice(0, 200)}`);

  // A live two-batches-plus-mid-flight-cancel scenario here proved fragile
  // to script reliably (the BatchGen overlay's Stop button is itself
  // clobbered out of the DOM almost immediately by the tab's own
  // preview.innerHTML status updates — a separate, pre-existing UX issue
  // — and driving the abort via a different path raced with the
  // still-in-flight generation in ways that intermittently hung the
  // harness). The per-tab window._batchAbortByTab fix is instead pinned
  // precisely at the source level — see realCodeHarness.test.js — and the
  // cross-tab parallelism behaviour it depends on (step 3b above) is
  // verified live.

  // 4d) UI regression checks. Each reproduces a behaviour that was
  // observed in the built app and asserts the fixed behaviour live in the
  // real renderer.
  const uiFixes = await exec(`(async () => {
    const out = {};
    // --- #4: custom-value input fields for parameters ---
    // The composite param rows (enum/number) must actually insert their
    // WRAPPER (with the hidden custom text input + OK button) into the
    // DOM. Previously only the bare <select> was inserted, so picking
    // "Custom…" revealed nothing.
    showTab('image');
    const wrap = document.querySelector('#tab-image .combo-select-enum');
    out.customWrapInDom = !!wrap;
    if (wrap) {
      const sel = wrap.querySelector('select');
      const input = wrap.querySelector('input.enum-custom-input');
      sel.value = '__custom__';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      out.customHasOption = [...sel.options].some((o) => o.value === '__custom__');
      out.customInputVisible = !!(input && (input.offsetWidth || input.offsetHeight));
      out.customInputDisplay = input ? getComputedStyle(input).display : null;
    }
    // Browse button must also be present on file-picker param rows
    // (e.g. the --subject-ref reference image row).
    out.subjRefHasBrowse = !!([...document.querySelectorAll('#tab-image .text-browse-row button')]
      .find((b) => /browse/i.test(b.textContent || '')));
    // --- #5: log pane must scroll (be height-bounded, content overflows) ---
    for (let i = 0; i < 80; i++) window.LogService.addLogEvent({ category: 'info', headline: 'scroll-probe ' + i, details: ['path C:/x/y' + i] });
    await new Promise((r) => setTimeout(r, 50));
    const logEl = document.querySelector('#log');
    out.logClientH = logEl.clientHeight;
    out.logScrollH = logEl.scrollHeight;
    out.logScrolls = logEl.scrollHeight > logEl.clientHeight + 2;
    // and it must actually be scrollable (scrollTop can move). The pane is
    // flex-direction:column-reverse (newest-on-top, as the user wanted),
    // so the scroll range is NEGATIVE in Chromium — test both directions
    // so the check is column-reverse-agnostic.
    const t0 = logEl.scrollTop;
    logEl.scrollTop = -50; const tNeg = logEl.scrollTop;
    logEl.scrollTop = 50; const tPos = logEl.scrollTop;
    out.logScrollTopMoved = (tNeg !== t0) || (tPos !== t0);
    logEl.scrollTop = 0;
    // --- #6: log text is selectable (pane opts into user-select:text) ---
    out.logUserSelect = getComputedStyle(logEl).webkitUserSelect || getComputedStyle(logEl).userSelect;
    // --- #7: secondary mmx output lines must NOT be stuck 'wip' ---
    // Simulate a finished suppressLogRow job's secondary line the way
    // onLogRich -> attachSecondaryToJob does, and assert the resulting
    // row is neutral (no wip/blue/spinner), not perpetually "running".
    const sjob = window.JobRunner.run({ tabKey: null, type: 'music', title: 'wip-probe', suppressLogRow: true, runFn: async () => ({ status: 'ok' }) });
    await sjob.done;
    window.LogService.addLogEvent({ category: 'info', headline: '{ "saved": "C:/x/y.mp3" }', jobId: sjob.jobId, _internal: true });
    await new Promise((r) => setTimeout(r, 30));
    const savedRow = [...document.querySelectorAll('#log .log-event')].find((r) => /saved/.test(r.textContent || ''));
    out.savedRowFound = !!savedRow;
    out.savedRowIsWip = savedRow ? savedRow.classList.contains('log-state-wip') : null;
    out.savedRowHasDots = savedRow ? !!savedRow.querySelector('.log-wip-dots') : null;
    // --- #3: welcome always opens; policy still suppresses tab-intros ---
    const modalCount = () => document.querySelectorAll('#modal-root .modal').length;
    for (let i = 0; i < 8; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 30));
    state.popupPolicy = 'never';
    if (typeof resetPopupSeen === 'function') resetPopupSeen();
    const before = modalCount();
    showStartupPopup();
    showTab('speech');
    if (typeof maybeShowTabIntro === 'function') maybeShowTabIntro('speech');
    await new Promise((r) => setTimeout(r, 60));
    out.popupsBefore = before;
    out.popupsAfterNever = modalCount();
    out.neverGate = shouldShowPopup('startup');
    // Leave the renderer clean for the remaining smoke probes.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    // Layering contract: pipeline < viewer < modal < toast. Use disposable
    // probes so this test does not alter the live UI state.
    const zProbe = (className) => {
      const node = document.createElement('div'); node.className = className;
      document.body.appendChild(node);
      const z = Number(getComputedStyle(node).zIndex || 0);
      node.remove();
      return z;
    };
    out.zOrder = {
      pipeline: zProbe('pipeline-overlay'), viewer: zProbe('image-overlay'),
      modal: Number(getComputedStyle(document.getElementById('modal-root')).zIndex || 0),
      toast: Number(getComputedStyle(document.getElementById('toast-root')).zIndex || 0),
    };
    return out;
  })()`);
  check(uiFixes.customWrapInDom === true,
    'the enum param WRAPPER (.combo-select-enum, which holds the custom-value text input + OK button) must be in the DOM — only the bare <select> was being inserted, so "Custom…" revealed no input field');
  check(uiFixes.customInputVisible === true,
    `selecting "Custom…" must reveal the custom-value text input (visible), got display=${uiFixes.customInputDisplay}`);
  check(uiFixes.subjRefHasBrowse === true,
    'file-picker param rows (e.g. --subject-ref) must show their Browse… button — it lived in the wrapper that was being dropped from the DOM');
  check(uiFixes.logScrolls === true,
    `the log pane must be height-bounded so it scrolls — clientH=${uiFixes.logClientH} must be < scrollH=${uiFixes.logScrollH} (it was growing to full content height and clipping rows)`);
  check(uiFixes.logScrollTopMoved === true,
    'the log pane must actually scroll (scrollTop must be settable to a non-zero value)');
  check(/text/.test(String(uiFixes.logUserSelect)),
    `the log pane must be text-selectable (user-select:text) so entries can be selected + copied, got "${uiFixes.logUserSelect}"`);
  check(uiFixes.savedRowFound === true, 'the simulated mmx secondary "saved" log row should exist');
  check(uiFixes.savedRowIsWip === false,
    'a finished job secondary mmx output line (e.g. the "{ saved }" row) must NOT keep the wip/blue "still running" state');
  check(uiFixes.savedRowHasDots === false,
    'the secondary mmx output row must not show the animated wip "…" running indicator after the job finished');
  check(uiFixes.popupsAfterNever === 1,
    `with popup policy 'never', exactly the always-on welcome popup may open (tab intros stay suppressed) — opened ${uiFixes.popupsAfterNever} modal(s)`);
  check(uiFixes.neverGate === false,
    "shouldShowPopup must return false under the 'never' policy");
  check(uiFixes.zOrder.pipeline < uiFixes.zOrder.viewer && uiFixes.zOrder.viewer < uiFixes.zOrder.modal && uiFixes.zOrder.modal < uiFixes.zOrder.toast,
    `layering must remain pipeline < viewer < modal < toast, got ${JSON.stringify(uiFixes.zOrder)}`);

  // 4e) fb:ensureDir must succeed (not EPERM) for an already-existing
  // directory. On Windows a DRIVE ROOT (e.g. D:\) can't be mkdir'd even
  // with recursive:true; the stat-first guard returns ok for any existing
  // dir without calling mkdir. The smoke OUT dir always exists, so this
  // exercises the early-return path that prevents the reported
  // "EPERM ... mkdir 'D:\\'" failure. (The mkdir-throws case is unit
  // tested in tests/unit/main/ipc/registerFileBrowserIpc.test.js.)
  const ensureExisting = await exec(`(async () => {
    // R7.5: fb:ensureDir is grant-gated (R1.3). Mint a directory-root grant
    // on OUT (a trusted root) exactly as the production ensureSubDir does.
    const g = await window.GrantCache.ensurePathGrant(${JSON.stringify(OUT)}, 'mkdir', { kind: 'directory', capabilities: ['mkdir', 'write'], coversRoot: true });
    return window.api.fbEnsureDir(${JSON.stringify(OUT)}, g);
  })()`);
  check(ensureExisting && ensureExisting.ok === true,
    `fb:ensureDir on an existing directory must return ok (stat-first, no mkdir) — got ${JSON.stringify(ensureExisting)}`);

  // 4f) refImageExists pre-flight — a missing reference path reports
  // exists:false (so the image tab can abort with a clear message instead
  // of a cryptic, 4×-retried mmx ENOENT), an existing file reports true,
  // and http(s) URLs report true (validated server-side).
  const refMissing = await exec(`window.api.refImageExists(${JSON.stringify(path.join(OUT, 'definitely-not-here_zzz.jpeg'))})`);
  const refUrl = await exec(`window.api.refImageExists('https://example.com/ref.png')`);
  check(refMissing && refMissing.ok === true && refMissing.exists === false,
    `refImageExists must report a missing reference image as exists:false — got ${JSON.stringify(refMissing)}`);
  check(refUrl && refUrl.ok === true && refUrl.exists === true,
    `refImageExists must treat http(s) reference URLs as present — got ${JSON.stringify(refUrl)}`);

  // restore a clean log + state for the steps below
  await exec(`(() => { if (window.LogService && window.LogService.clearLog) { try { window.LogService.clearLog(); } catch(e){} } state.popupPolicy = 'never'; for (let i=0;i<8;i++) document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return true; })()`);

  // 5) asset-type filter
  const filter = await exec(`(async () => {
    const out = state.config.output_dir; const b64 = btoa('x');
    // R7.5: fb:write is grant-gated (R1.3) — mint a directory-root grant on
    // the output dir (trusted root) so the fixture files can be written.
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

  // 5a) Live regression guard for two dead-in-the-live-renderer paths:
  // the #fb-up "Up one level" button and the drives-list feature. Both
  // threw `ReferenceError: process is not defined` on click because the
  // renderer is a browser and `process` doesn't exist there. The unit
  // tests passed only because they injected a fake `process` into the
  // sandbox. This step boots the real renderer (no fake globals
  // available to the handler), clicks the actual #fb-up element, and
  // asserts the observable state (state.fbDir) actually changed. It also
  // asserts the drives list renders ≥1 row when state.fbDir is the
  // __DRIVES__ sentinel. If either handler regresses to using `process`,
  // this step fails — even if every unit test is green. This is the only
  // class of test that proves the live app does what it claims.
  const fbUp = await exec(`(async () => {
    const out = state.config.output_dir;
    // Up from a subfolder must climb one level. The pre-fix code threw
    // ReferenceError on the very first click, so state.fbDir never
    // changed. Create the subdirs on disk so the security allow-list +
    // the actual fs read both pass.
    const subA = out + '\\\\smoke_subA';
    const subB = subA + '\\\\smoke_subB';
    // KGO4-009: fb:ensureDir requires a grantId. Mint a directory-root
    // grant on output_dir (covers all descendants) before creating dirs.
    const g = await window.api.mintGrant(out, 'mkdir', { kind: 'directory', capabilities: ['mkdir', 'read'], coversRoot: true });
    const gid = (g && g.ok) ? g.grantId : undefined;
    try { await window.api.fbEnsureDir(subA, gid); } catch (_) {}
    try { await window.api.fbEnsureDir(subB, gid); } catch (_) {}
    state.fbDir = subB;
    await refreshBrowser();
    await new Promise((r) => setTimeout(r, 250));
    const beforeUp = state.fbDir;
    // Click the actual #fb-up element.
    const upBtn = document.querySelector('#fb-up');
    if (upBtn) upBtn.click();
    await new Promise((r) => setTimeout(r, 400));
    const afterUp = state.fbDir;
    // drives list must render ≥1 row. The pre-fix code threw on the
    // first iteration of the for-loop, so #fb-list ended up empty.
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
  // Restore the test-stable state for downstream steps (the
  // audio-cutter step + type-filter step expect output_dir
  // as the current folder).
  await exec(`state.fbDir = state.config.output_dir; refreshBrowser(); new Promise(r=>setTimeout(r,200));`);

  // 5b) Live regression guard for unwanted help popups. The live
  // renderer's HelpDelegation hijacked EVERY click on any
  // [data-help-topic] element — but that attribute is also sprinkled on
  // real control buttons in index.html (the tabs, #fb-refresh, #fb-up,
  // #fb-options, the topbar buttons, …). The delegation then opened the
  // help modal on every click and the popupPolicy=never gate didn't help
  // (it only covers showStartupPopup / maybeShowTabIntro).
  //
  // The fix: HelpDelegation only fires on .help-button / .help-btn (real
  // help icons), not on every [data-help-topic]. This step clicks the
  // actual #fb-refresh control + a tab button in the real renderer and
  // asserts NO help modal opens. If the bug regresses, this is the one
  // assertion that catches it.
  const helpBug = await exec(`(async () => {
    // Count help modal opens. The help modal is rendered into
    // #modal-root with class="modal help-modal" (the latter
    // distinguishes it from other modals).
    const helpModalCount = () => document.querySelectorAll('#modal-root .modal.help-modal').length;
    // 1) Click the real #fb-refresh button (which carries
    //    data-help-topic="sidebar.refreshBtn"). Pre-fix: this opened a
    //    help modal over the file browser.
    const refreshBtn = document.querySelector('#fb-refresh');
    const before = helpModalCount();
    if (refreshBtn) refreshBtn.click();
    await new Promise((r) => setTimeout(r, 250));
    const afterRefresh = helpModalCount();
    // 2) Click a tab button. Each tab has data-help-topic=… pre-fix,
    //    the help modal opened on every tab click.
    const tabBtn = document.querySelector('.tab');
    if (tabBtn) tabBtn.click();
    await new Promise((r) => setTimeout(r, 250));
    const afterTab = helpModalCount();
    // 3) Confirm the original help-icon path still works: the log-help
    //    "?" icon has its own click handler in app.js that opens the
    //    help modal (delegation only matches .help-button / .help-btn).
    //    Not asserted here (separate code path); the unit test covers
    //    the delegation-only path.
    return { before, afterRefresh, afterTab, refreshFound: !!refreshBtn, tabFound: !!tabBtn };
  })()`);
  check(helpBug.refreshFound, '#fb-refresh button must be in the DOM');
  check(helpBug.tabFound, 'a .tab button must be in the DOM');
  check(helpBug.afterRefresh === helpBug.before,
    `clicking #fb-refresh MUST NOT open a help modal — opened ${helpBug.afterRefresh - helpBug.before} new help modal(s) (pre-fix: every click on a [data-help-topic] control opened one, regardless of popupPolicy)`);
  check(helpBug.afterTab === helpBug.before,
    `clicking a .tab button MUST NOT open a help modal — opened ${helpBug.afterTab - helpBug.before} new help modal(s) (pre-fix: every tab click opened one).`);
  // Close any leftover modal so downstream steps start clean.

  // 5c) Live regression guard for dead log-chevron buttons. The reported
  // symptom: every log entry has a > button on its right side that does
  // nothing. Root cause: LogService.setupLogClicks() (which wires the
  // click + keyboard handler on #log, including the chevron expand/
  // collapse) was never called. bootstrap.js defined it but no other
  // file called LogService.init(), so every click on a .log-event-chev
  // was a dead button. The fix: call LogService.init() from bootstrap.js.
  // This step boots the real renderer, fires a log event with details,
  // clicks the chev, and asserts the row expanded.
  const logChev = await exec(`(async () => {
    const log = document.querySelector('#log');
    if (!log) return { error: 'no #log' };
    // Find a row with details (a recent log action with a JSON payload).
    // The previous step just clicked a bunch of controls, so there
    // should be at least one row with details in the log.
    const row = log.querySelector('.log-event');
    if (!row) return { error: 'no log rows' };
    const chev = row.querySelector('.log-event-chev');
    if (!chev) return { error: 'no chev in first row' };
    const details = row.querySelector('.log-event-details');
    if (!details) return { error: 'no details in first row (nothing to expand)' };
    const beforeDisp = details.style.display;
    const beforeChev = chev.textContent;
    chev.click();
    await new Promise((r) => setTimeout(r, 100));
    const afterDisp = details.style.display;
    const afterChev = chev.textContent;
    return { beforeDisp, beforeChev, afterDisp, afterChev,
      rowCount: log.querySelectorAll('.log-event').length,
      hasDetails: !!details };
  })()`);
  check(!logChev.error, `log pane has no row to click the chev on: ${logChev.error || 'unknown'}`);
  if (!logChev.error) {
    check(logChev.beforeDisp === 'none',
      `the first log row's details should start collapsed — got display="${logChev.beforeDisp}"`);
    check(logChev.afterDisp !== logChev.beforeDisp,
      `clicking the chev MUST change the details display from "${logChev.beforeDisp}" to something else. The chev click handler is wired by LogService.init() (called from bootstrap.js) — if it's not wired, this assertion fails.`);
    check(logChev.afterChev !== logChev.beforeChev,
      `clicking the chev MUST change its text from "${logChev.beforeChev}" to something else (e.g. "▸" ↔ "▾")`);
  }
  await exec(`for (let i=0;i<4;i++) document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); new Promise(r=>setTimeout(r,100));`);

  // 6) audio cutter open + probe + export
  const audio = await exec(`(async () => {
    function wav(sec, sr){ const n=Math.floor(sec*sr), dl=n*2, buf=new ArrayBuffer(44+dl), dv=new DataView(buf);
      const ws=(o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i));};
      ws(0,'RIFF');dv.setUint32(4,36+dl,true);ws(8,'WAVE');ws(12,'fmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);
      dv.setUint16(22,1,true);dv.setUint32(24,sr,true);dv.setUint32(28,sr*2,true);dv.setUint16(32,2,true);dv.setUint16(34,16,true);
      ws(36,'data');dv.setUint32(40,dl,true);
      for(let i=0;i<n;i++)dv.setInt16(44+i*2,Math.round(Math.sin(2*Math.PI*440*i/sr)*30000),true);
      let bin='';const b=new Uint8Array(buf);for(let i=0;i<b.length;i++)bin+=String.fromCharCode(b[i]);return btoa(bin); }
    const out = state.config.output_dir; const src = out + '\\\\sm_tone.wav';
    // R7.5: fb:write + audio:* are grant-gated (R1.3 / R1.5a). Mint one
    // directory-root grant on OUT (a trusted root) and reuse it for the
    // fixture write + the final probe assertion.
    const ag = await window.GrantCache.ensurePathGrant(out, 'write', { kind: 'directory', capabilities: ['read', 'write'], coversRoot: true });
    await window.api.fbWrite(src, wav(2.0, 8000), ag);
    const mr = document.querySelector('#modal-root'); mr.innerHTML=''; mr.classList.remove('active');
    window.showAudioCutter(src); await new Promise(r=>setTimeout(r,1200));
    const m = mr.querySelector('.audio-cutter-modal'); if (!m) return { opened:false };
    const inps = m.querySelectorAll('.ac-time-inp');
    inps[0].value='0:00.500'; inps[0].dispatchEvent(new Event('change'));
    inps[1].value='0:01.500'; inps[1].dispatchEvent(new Event('change'));
    m.querySelector('.ac-name-inp').value='sm_tone_cut.wav';
    [...m.querySelectorAll('button')].find(b=>/Export/.test(b.textContent)).click();
    await new Promise(r=>setTimeout(r,2500));
    // fbExists returns { ok, exists } — pull the boolean out of .exists so
    // the smoke test's 'exists' field still has the documented shape
    // (true/false, not an envelope). Use single quotes here: a template
    // literal doesn't process JS comments, so backticks inside a comment
    // would close the template early.
    const existsRes = await window.api.fbExists(out + '\\\\sm_tone_cut.wav', ag);
    const exists = !!(existsRes && existsRes.exists);
    const pr = await window.api.audioProbe(out + '\\\\sm_tone_cut.wav', ag);
    return { opened:true, exists, dur: pr && pr.duration };
  })()`);
  check(audio.opened, 'audio cutter modal did not open');
  check(audio.exists, 'audio cutter did not produce a trimmed file');
  check(audio.dur && Math.abs(audio.dur - 1.0) < 0.2, `audio cutter trim duration wrong (${audio.dur}, expected ~1.0)`);

  // 7) dead-control modals. The `?` icons are hover-only. The log-help
  // `?` button used to open a help modal on click; now it must NOT open a
  // modal (the help text is shown on mouseover via the HelpTooltip system
  // and the `data-help` attribute). Assert the modal does NOT appear.
  const ctrls = await exec(`(async () => {
    const mr = document.querySelector('#modal-root');
    mr.innerHTML=''; mr.classList.remove('active');
    document.querySelector('#fb-options').click(); await new Promise(r=>setTimeout(r,150));
    const opt = !!mr.querySelector('.folder-options-modal') || [...mr.querySelectorAll('h2')].some(h=>/Folder options/.test(h.textContent));
    mr.innerHTML=''; mr.classList.remove('active');
    document.querySelector('#log-help').click(); await new Promise(r=>setTimeout(r,150));
    const helpModalCount = mr.querySelectorAll('.modal.help-modal').length;
    const help = helpModalCount;
    mr.innerHTML=''; mr.classList.remove('active');
    return { opt, help };
  })()`);
  check(ctrls.opt, 'fb-options button did not open the Folder options modal');
  check(ctrls.help === 0,
    `clicking the log-help "?" button must NOT open a help modal (the ? icons are hover-only now) — got ${ctrls.help} help modal(s) in #modal-root`);

  // 8) no uncaught / error-console anywhere
  const consoleErrors = consoleMsgs.filter((m) => /uncaught|referenceerror|typeerror|is not defined|is not a function|cannot read|syntaxerror/i.test(m.message));
  check(consoleErrors.length === 0, `console errors: ${JSON.stringify(consoleErrors).slice(0, 400)}`);
  check(mainErrors.length === 0, `main-process errors: ${JSON.stringify(mainErrors).slice(0, 400)}`);

  // 8a) end-to-end persistence check. The job-history stack used to be
  // dead because jobsSnapshot/jobsArchiveCap and four other settings were
  // missing from the renderer's STATE_PERSIST_KEYS — so saveAllStates()
  // never sent them and the disk state.json never carried them. This step
  // sets known values on state.*, triggers a save, reads the REAL
  // state.json file from disk, and asserts the keys are present. This is
  // the only test that exercises the FULL chain (renderer state →
  // saveAllStates → IPC → main → src/state.js write → disk) — a
  // regression on either side (renderer list OR main whitelist) fails
  // here.
  await exec(`(() => {
    state.jobsArchiveCap = 150;
    state.apiKeyNoSave = true;
    state.fbTypeFilter = 'png,jpg';
    state.batchesAutoRemove = false;
    state.batchesExportFormat = 'txt';
    if (typeof saveAllStates === 'function') saveAllStates();
    return true;
  })()`);
  // saveAllStates debounces; wait a beat for the write to land.
  await sleep(800);
  let persisted = null;
  try {
    persisted = JSON.parse(fs.readFileSync(path.join(TMP, 'state.json'), 'utf8'));
  } catch (e) {
    check(false, `could not read state.json from disk: ${e && e.message}`);
  }
  if (persisted) {
    // jobsSnapshot must be in the persisted payload. By this point many
    // generation jobs have completed (steps 3, 3b, 3c, 4), so the
    // snapshot should be a non-empty array.
    check(Array.isArray(persisted.jobsSnapshot),
      `state.json must carry jobsSnapshot as an array — the renderer was not sending it before the fix (got ${typeof persisted.jobsSnapshot})`);
    check(Array.isArray(persisted.jobsSnapshot) && persisted.jobsSnapshot.length > 0,
      `state.json jobsSnapshot should be non-empty after all the generation runs in this smoke pass (got length ${Array.isArray(persisted.jobsSnapshot) ? persisted.jobsSnapshot.length : 0})`);
    check(persisted.jobsArchiveCap === 150,
      `state.json jobsArchiveCap should round-trip the value 150 set on state.* (got ${persisted.jobsArchiveCap}) — the cap setting was resetting on every restart before the fix`);
    // the four previously-lost settings.
    check(persisted.apiKeyNoSave === true,
      `state.json apiKeyNoSave should be true (got ${persisted.apiKeyNoSave}) — the checkbox state was resetting on every restart before the fix`);
    check(persisted.fbTypeFilter === 'png,jpg',
      `state.json fbTypeFilter should round-trip "png,jpg" (got ${JSON.stringify(persisted.fbTypeFilter)})`);
    check(persisted.batchesAutoRemove === false,
      `state.json batchesAutoRemove should be false (got ${persisted.batchesAutoRemove}) — the preference was resetting on every restart before the fix`);
    check(persisted.batchesExportFormat === 'txt',
      `state.json batchesExportFormat should be "txt" (got ${JSON.stringify(persisted.batchesExportFormat)})`);
  }

  const result = { inited, globals, tabs, batch, filter, audio, ctrls, consoleErrors, mainErrors, problems };
  process.stdout.write('\nSMOKE_BEGIN\n' + JSON.stringify(result, null, 2) + '\nSMOKE_END\n');
  process.stdout.write(problems.length ? `\nSMOKE_FAIL (${problems.length}):\n - ${problems.join('\n - ')}\n` : '\nSMOKE_PASS\n');
}

let exitCode = 0;
// Defensive guard. If this file is ever run outside the Electron runtime
// (e.g. via `node scripts/smoke-renderer.js` instead of `npm run test:smoke`
// which spawns Electron), `app` is undefined and the original code crashed
// with an opaque "TypeError: Cannot read properties of undefined (reading
// 'whenReady')". Detect that and exit with a helpful, actionable error
// message. The proper entry point is `scripts/run-smoke.js` (which spawns
// Electron with this file as the first arg) or `npm run test:smoke`.
if (typeof app === 'undefined' || !app || typeof app.whenReady !== 'function') {
  process.stdout.write(
    '\nSMOKE_FATAL\n' +
    'scripts/smoke-renderer.js must be run inside the Electron runtime.\n' +
    'Use one of:\n' +
    '  - npm run test:smoke\n' +
    '  - node scripts/run-smoke.js\n' +
    'Do NOT invoke it directly with `node scripts/smoke-renderer.js`\n' +
    '(that gives no `app` global and the harness produces zero signal).\n',
  );
  process.exit(1);
}
app.whenReady().then(async () => {
  // Suppress Electron's blocking native error dialog for uncaught
  // main-process errors: log to stdout so the run is never blocked.
  process.on('uncaughtException', (err) => { process.stdout.write('\n[smoke] uncaughtException: ' + ((err && err.stack) || err) + '\n'); });
  process.on('unhandledRejection', (reason) => { process.stdout.write('\n[smoke] unhandledRejection: ' + ((reason && reason.stack) || reason) + '\n'); });
  const killer = setTimeout(() => { process.stdout.write('\nSMOKE_TIMEOUT\n'); app.exit(2); }, 90000);
  try {
    await run();
    exitCode = problems.length ? 1 : 0;
  } catch (e) {
    process.stdout.write('\nSMOKE_FATAL\n' + (e && e.stack || e) + '\n');
    exitCode = 1;
  } finally {
    clearTimeout(killer);
    try { if (win) win.destroy(); } catch (_) {}
    // app.exit(code) force-exits with the given code immediately. We do
    // NOT call app.quit() first — it races this and the process would
    // exit 0 before app.exit(exitCode) runs, masking a SMOKE_FAIL.
    app.exit(exitCode);
  }
});
