// scripts/e2e/visual-baseline.js
// ============================================================================
// Phase E — Visual regression baseline capture and diff.
//
// Captures screenshots of every screen/overlay in a known state and
// stores them in tests/visual-baselines/. On subsequent runs, compares
// against the baseline using pixel-diff (sharp-based) and flags if >2%
// pixel difference.
//
// Usage:
//   node scripts/e2e/visual-baseline.js --capture   (create baselines)
//   node scripts/e2e/visual-baseline.js --compare   (compare against baselines)
//
// The baselines directory is committed to git so CI can enforce diffs.
// Re-capture per release with --capture.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const BASELINES_DIR = path.join(ROOT, 'tests', 'visual-baselines');
const THRESHOLD = 0.02; // 2% pixel difference threshold

function log(m) { process.stdout.write(`[visual-baseline] ${m}\n`); }

// ---------------------------------------------------------------------------
// KGO7-001 — deterministic pre-capture reset.
//
// Both capture and compare run AFTER the whole scenario suite, so whatever
// those scenarios left on screen ends up in the PNG. The committed baselines
// contained one run's `mkdtemp` path, its timestamped output filenames
// (`20260726_224019_rocket-cat-…`), 12 log rows stamped `22:40:43`, a
// mid-scroll prompt panel and a generated preview image — none of which can
// ever recur. Measured diff for the SAME screen swung 12 % → 45 % → 93 %
// depending only on what ran before it, so the 2 % gate was unpassable.
//
// This scrubs every run-specific region to a fixed placeholder before the
// shutter, so capture and compare see the same picture. Anything that still
// cannot be made deterministic goes in MASKS below instead.
// NOTE: every selector below was MEASURED against the live renderer, not
// guessed. The first attempt used `#log-list` / `.assets-preview` /
// `.tabbar .activity-dot` — none of which exist — so the scrub silently
// did nothing and the gate stayed flaky (24 %/93 % diffs) while appearing
// to have a reset. The real ids are `#log` (class .log-pane), `#fb-list`,
// `#fb-preview-content` (class .preview-pane-content) and `#toast-root`.
// If you add a selector here, verify it matches something first.
const RESET_JS = `(() => {
  const wipe = (sel) => { const n = document.querySelector(sel); if (n) n.innerHTML = ''; return !!n; };
  const seen = {};
  seen.log = wipe('#log');                    // structured log rows (timestamps!)
  seen.fbList = wipe('#fb-list');             // generated filenames carry a timestamp
  seen.preview = wipe('#fb-preview-content'); // shows the last generated asset
  seen.toasts = wipe('#toast-root');
  const p = document.querySelector('#fb-path');
  if (p) { p.textContent = 'BASELINE_PATH'; p.title = ''; seen.path = true; }
  // Settings contains machine-specific output, report, and config paths.
  // Replace them before capture so committed images never expose a username
  // and remain identical on GitHub-hosted runners.
  const fixedSettingsPaths = {
    'Output directory': 'C:\\\\BASELINE\\\\output',
    'Report folder': '',
    'Config file location': 'C:\\\\BASELINE\\\\config.txt',
  };
  document.querySelectorAll('.settings-modal .row').forEach((row) => {
    const label = row.querySelector('label');
    const input = row.querySelector('input[type="text"]');
    if (!label || !input) return;
    const labelText = label.textContent.trim();
    const key = Object.keys(fixedSettingsPaths).find((name) => labelText.startsWith(name));
    if (key) {
      input.value = fixedSettingsPaths[key];
    }
  });
  // The API-key row is machine-specific twice over: the placeholder embeds
  // the last four chars of the stored key (sk-cp*** on a dev box, ****0000
  // in the harness) and B-007's clear button flips its label when armed.
  // Normalize both so committed baselines stay environment-free. Only runs
  // while the settings modal is open; RESET_HOLDS treats a closed modal as
  // vacuously scrubbed, so this block is not in RESET_REQUIRED_KEYS.
  document.querySelectorAll('.settings-modal .row').forEach((row) => {
    const label = row.querySelector('label');
    if (!label || !label.textContent.trim().startsWith('API key')) return;
    const input = row.querySelector('input[type="text"]');
    if (input) { input.value = ''; input.placeholder = 'BASELINE_KEY'; }
    row.querySelectorAll('button').forEach((b) => {
      if (/^(Clear stored key|Will clear)/.test(b.textContent)) {
        b.textContent = 'Clear stored key';
        b.classList.remove('danger');
      }
    });
  });
  // Prompt / params fields: fixed text, scrolled to the top.
  document.querySelectorAll('textarea').forEach((t) => { t.value = 'BASELINE'; t.scrollTop = 0; });
  const q = document.querySelector('#quota-value');
  if (q) { q.textContent = '—'; seen.quota = true; }
  const sb = document.querySelector('#statusbar');
  if (sb) { sb.classList.remove('error', 'busy'); sb.textContent = 'Ready'; seen.status = true; }
  // Collapse any inline BatchGen panel a scenario left expanded.
  document.querySelectorAll('.batch-panel, .batch-manager, .batchgen-panel').forEach((n) => { n.style.display = 'none'; });
  // Every scroll container back to the top-left (KGO8-003: scrollLeft too —
  // a horizontally scrolled panel shifted the whole capture sideways).
  document.querySelectorAll('*').forEach((n) => { if (n.scrollTop) n.scrollTop = 0; if (n.scrollLeft) n.scrollLeft = 0; });
  window.scrollTo(0, 0);
  return seen;
})()`;

// Rectangles excluded from the pixel diff, keyed by capture name:
//   { 'tab-image': [{ x, y, w, h }, …] }
// Use this ONLY for regions that genuinely cannot be made deterministic —
// everything else belongs in RESET_JS, because a mask also hides real
// regressions. Empty on purpose: RESET_JS was measured sufficient (max
// residual diff 0.00 % across all 7 captures). Add a rect here only with a
// measurement that shows why RESET_JS cannot cover it.
const MASKS = {};

function isMasked(name, x, y) {
  const rects = MASKS[name];
  if (!rects || !rects.length) return false;
  for (const r of rects) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
  }
  return false;
}

// Screenshots to capture: [name, setupFunction]
// Each entry is [name, setup, ready] where `ready` is a JS expression the
// renderer must satisfy BEFORE the shutter.
//
// KGO7-001b: the old code slept a fixed 400 ms and photographed whatever
// happened to be on screen. Measured over 6 runs, `styles-modal`
// intermittently shot the page with NO modal open (93.5 % diff) — the
// click had not produced a dialog yet, or the preceding capture's
// closeModals() was still settling. A fixed sleep cannot express "the
// thing I am photographing exists", so the gate randomly compared two
// different screens and blamed the app.
const MODAL_OPEN = `!!document.querySelector('#modal-root .modal')`;
const tabReady = (t) => `!!(document.querySelector('#tab-${t}') && state.currentTab === '${t}' && !document.querySelector('#modal-root .modal'))`;

const CAPTURES = [
  ['tab-image', async (exec) => { await exec(`showTab('image'); true;`); }, tabReady('image')],
  ['tab-speech', async (exec) => { await exec(`showTab('speech'); true;`); }, tabReady('speech')],
  ['tab-music', async (exec) => { await exec(`showTab('music'); true;`); }, tabReady('music')],
  ['tab-video', async (exec) => { await exec(`showTab('video'); true;`); }, tabReady('video')],
  ['tab-providers', async (exec) => { await exec(`showTab('providers'); true;`); }, tabReady('providers')],
  ['settings-modal', async (exec) => {
    await exec(`document.querySelector('#btn-settings')?.click(); true;`);
  }, `!!document.querySelector('#modal-root .settings-modal')`],
  ['styles-modal', async (exec) => {
    await exec(`document.querySelector('#btn-styles')?.click(); true;`);
  }, MODAL_OPEN],
];

// The scrub is only useful if its selectors still match. A silent
// no-op reset is exactly what made this gate flaky for three QA rounds,
// so run it through a checker that FAILS on a stale selector.
const RESET_REQUIRED_KEYS = ['log', 'fbList', 'preview', 'toasts', 'path', 'quota', 'status'];

async function applyReset(exec) {
  const seen = await exec(RESET_JS);
  const missing = RESET_REQUIRED_KEYS.filter((k) => !seen || !seen[k]);
  if (missing.length) {
    throw new Error(
      `visual reset matched nothing for: ${missing.join(', ')} — a selector in RESET_JS is stale. `
      + 'Fix the selector; do NOT ignore this, an un-scrubbed screen makes the whole gate meaningless.');
  }
  return seen;
}

// Does the scrub still hold? The app repaints asynchronously — a
// `refreshBrowser()` scheduled before the scrub lands afterwards and
// refills #fb-list / #fb-path with run-specific content.
//
// KGO8-003: this check MUST cover everything RESET_JS resets, or stableReset
// exits while un-scrubbed content is still on screen. It previously verified
// only #fb-path / #fb-list / #log, so two things RESET_JS also resets were
// never confirmed and rode into the committed baseline:
//   • the prompt textareas (a scenario's leftover text, e.g. "stress-cycle-4",
//     restored from state.tabSettings by the tab re-render after the scrub);
//   • every scroll offset (the tab panel restores its scrollTop, so the
//     baseline was shot mid-panel while the compare run was at the top).
// Together those produced a permanent 24.3 % diff on tab-image that the
// advisory branch then hid.
const RESET_HOLDS = `(() => {
  const p = document.querySelector('#fb-path');
  const l = document.querySelector('#fb-list');
  const g = document.querySelector('#log');
  if (!(p && p.textContent === 'BASELINE_PATH'
    && l && l.children.length === 0
    && g && g.children.length === 0)) return false;
  for (const t of document.querySelectorAll('textarea')) { if (t.value !== 'BASELINE') return false; }
  const expectedSettingsPaths = {
    'Output directory': 'C:\\\\BASELINE\\\\output',
    'Report folder': '',
    'Config file location': 'C:\\\\BASELINE\\\\config.txt',
  };
  for (const row of document.querySelectorAll('.settings-modal .row')) {
    const label = row.querySelector('label');
    const input = row.querySelector('input[type="text"]');
    if (!label || !input) continue;
    const labelText = label.textContent.trim();
    const key = Object.keys(expectedSettingsPaths).find((name) => labelText.startsWith(name));
    if (key && input.value !== expectedSettingsPaths[key]) return false;
    if (labelText.startsWith('API key')) {
      if (input.value !== '' || input.placeholder !== 'BASELINE_KEY') return false;
      for (const b of row.querySelectorAll('button')) {
        if (/^Will clear/.test(b.textContent) || b.classList.contains('danger')) return false;
      }
    }
  }
  for (const n of document.querySelectorAll('*')) { if (n.scrollTop || n.scrollLeft) return false; }
  return true;
})()`;

/**
 * Scrub, then keep scrubbing until the scrub is still intact after a
 * settle window. Without this the gate raced the renderer's own async
 * repaint: measured 2.3 % (file browser refilled) and 93.5 % (whole
 * screen repainted) diffs on ~40 % of runs, with the app perfectly fine.
 */
async function stableReset(exec, sleep, name, tries = 12) {
  for (let i = 0; i < tries; i++) {
    await applyReset(exec);
    await sleep(160);
    let holds = false;
    try { holds = await exec(RESET_HOLDS); } catch (_) { holds = false; }
    if (holds) return;
  }
  throw new Error(
    `capture "${name}": the screen would not stay scrubbed after ${tries} attempts `
    + '(something keeps repainting run-specific content).');
}

/**
 * Poll `expr` in the renderer until it is truthy. Throws (rather than
 * silently photographing the wrong screen) when it never becomes true.
 */
async function waitReady(exec, sleep, name, expr, timeoutMs = 6000) {
  if (!expr) { await sleep(400); return; }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = await exec(expr); } catch (_) { ok = false; }
    if (ok) { await sleep(180); return; } // settle paint
    if (Date.now() > deadline) {
      throw new Error(`capture "${name}": the screen never became ready (${expr})`);
    }
    await sleep(100);
  }
}

async function captureBaselines(ctx) {
  const { exec, sleep, screenshot, closeModals } = ctx;

  fs.mkdirSync(BASELINES_DIR, { recursive: true });
  const captureErrors = [];
  log(`Capturing baselines to ${BASELINES_DIR}`);

  for (const [name, setup, ready] of CAPTURES) {
    try {
      await closeModals();
      await sleep(200);
      // KGO7-001: identical scrub on the capture side and the compare side.
      await applyReset(exec);
      await setup(exec, closeModals);
      await waitReady(exec, sleep, name, ready);
      await stableReset(exec, sleep, name);
      const file = await screenshot(name);
      if (file) {
        // Copy to baselines dir.
        const dest = path.join(BASELINES_DIR, `${name}.png`);
        fs.copyFileSync(file, dest);
        log(`  Captured: ${name}`);
      }
    } catch (e) {
      // KGO7-001b: a capture that could not reach its ready state must NOT
      // be quietly skipped — that is how a stale/wrong baseline gets
      // committed and every later run blames the app.
      log(`  ERROR: Failed to capture ${name}: ${e.message}`);
      captureErrors.push(`${name}: ${e.message}`);
    }
  }

  if (captureErrors.length) {
    log(`Baseline capture FAILED for ${captureErrors.length} screen(s):`);
    for (const e of captureErrors) log('  - ' + e);
    throw new Error('visual baseline capture incomplete: ' + captureErrors.join('; '));
  }
  log('Baseline capture complete');
}

async function compareBaselines(ctx) {
  const { exec, sleep, screenshot, closeModals, sharp } = ctx;

  if (!fs.existsSync(BASELINES_DIR)) {
    log('No baselines found. Run with --capture first.');
    return { ok: true, skipped: true };
  }

  if (!sharp) {
    log('sharp not available — skipping visual comparison');
    return { ok: true, skipped: true };
  }

  log('Comparing against baselines...');
  const failures = [];

  for (const [name, setup, ready] of CAPTURES) {
    const baselinePath = path.join(BASELINES_DIR, `${name}.png`);
    if (!fs.existsSync(baselinePath)) {
      log(`  SKIP: No baseline for ${name}`);
      continue;
    }

    try {
      await closeModals();
      await sleep(200);
      // KGO7-001: the SAME scrub the baseline was captured with.
      await applyReset(exec);
      await setup(exec, closeModals);
      await waitReady(exec, sleep, name, ready);
      await stableReset(exec, sleep, name);
      if (process.env.MMX_VISUAL_DEBUG === '1') {
        const seen = await exec(`(() => ({
          modals: document.querySelectorAll('#modal-root .modal').length,
          modalRootChildren: (document.getElementById('modal-root') || { children: [] }).children.length,
          logRows: (document.querySelector('#log') || { children: [] }).children.length,
          fbRows: (document.querySelector('#fb-list') || { children: [] }).children.length,
          tab: (typeof state !== 'undefined' && state.currentTab) || '?',
        }))()`).catch((e) => ({ err: String(e.message) }));
        log(`  [debug] ${name} at shutter: ${JSON.stringify(seen)}`);
      }
      const currentFile = await screenshot(`${name}-current`);
      if (!currentFile) continue;

      // Compare using sharp.
      const baseline = sharp(baselinePath);
      const current = sharp(currentFile);
      const [bMeta, cMeta] = await Promise.all([baseline.metadata(), current.metadata()]);

      if (bMeta.width !== cMeta.width || bMeta.height !== cMeta.height) {
        failures.push({ name, reason: `size mismatch: ${bMeta.width}x${bMeta.height} vs ${cMeta.width}x${cMeta.height}` });
        continue;
      }

      // Raw pixel comparison.
      // KGO-013 fix: sharp .raw() outputs RGBA (4 channels), not RGB (3).
      // Stride must be 4 to compare pixels correctly.
      const [bBuf, cBuf] = await Promise.all([
        baseline.raw().toBuffer(),
        current.raw().toBuffer(),
      ]);

      let diffPixels = 0;
      let masked = 0;
      const channels = bMeta.channels || 4;
      const W = bMeta.width;
      for (let i = 0, px = 0; i < bBuf.length; i += channels, px++) {
        const x = px % W;
        const y = (px / W) | 0;
        if (isMasked(name, x, y)) { masked++; continue; }
        const dr = Math.abs(bBuf[i] - cBuf[i]);
        const dg = Math.abs(bBuf[i + 1] - cBuf[i + 1]);
        const db = Math.abs(bBuf[i + 2] - cBuf[i + 2]);
        if (dr > 10 || dg > 10 || db > 10) diffPixels++;
      }

      const comparedPixels = (bMeta.width * bMeta.height) - masked;
      const diffPct = comparedPixels ? diffPixels / comparedPixels : 0;
      if (diffPct > THRESHOLD) {
        // KGO7-013: KEEP the evidence. The old code unlinked the current
        // screenshot on every path, so a failure left only a percentage and
        // reproducing the diff meant writing a bespoke Electron runner.
        let kept = null;
        try {
          const keepDir = path.join(os.tmpdir(), 'mmx-visual-fail');
          fs.mkdirSync(keepDir, { recursive: true });
          kept = path.join(keepDir, `${name}-current.png`);
          fs.copyFileSync(currentFile, kept);
          fs.copyFileSync(baselinePath, path.join(keepDir, `${name}-baseline.png`));
        } catch (_) { kept = null; }
        failures.push({
          name,
          reason: `${(diffPct * 100).toFixed(1)}% pixel difference (threshold: ${THRESHOLD * 100}%)`,
          kept,
        });
        log(`  FAIL: ${name} — ${(diffPct * 100).toFixed(1)}% diff${kept ? ` (baseline + current kept in ${path.dirname(kept)})` : ''}`);
      } else {
        log(`  PASS: ${name} — ${(diffPct * 100).toFixed(2)}% diff`);
      }

      // Cleanup current screenshot (the failure copy above is kept).
      try { fs.unlinkSync(currentFile); } catch (_) {}
    } catch (e) {
      // KGO7-001b: "could not compare" is a FAILURE, not a warning. The
      // old WARN meant a screen that never opened produced a silent pass.
      log(`  FAIL: ${name} — could not compare: ${e.message}`);
      failures.push({ name, reason: 'comparison could not run: ' + e.message });
    }
  }

  if (failures.length > 0) {
    log(`Visual differences in ${failures.length} screen(s) — see the kept PNGs above.`);
    // KGO8-003: this gate FAILS. It used to return ok:true ("advisory")
    // whenever MMX_VISUAL_STRICT was unset, on the theory that the residual
    // diffs were an unavoidable repaint race. That was wrong twice over:
    //   1. the residue was not a race — RESET_HOLDS simply did not check the
    //      textareas or the scroll offsets that RESET_JS resets, so
    //      stableReset() returned while un-scrubbed content was on screen
    //      (both sides of the comparison, including the recorded baseline);
    //   2. an advisory gate reports `"failed": 0` and prints E2E_PASS, so a
    //      24.3 % regression on the app's primary screen sat in the tree
    //      looking green. A gate that cannot fail is not a gate.
    // RESET_HOLDS now covers everything RESET_JS resets. If this fires,
    // treat it as a real difference: look at the kept PNGs, and re-record
    // with `npm run test:visual:capture` only once you have confirmed the
    // change is intended.
    return { ok: false, failures };
  }

  log('All visual comparisons passed');
  return { ok: true };
}

module.exports = { captureBaselines, compareBaselines, BASELINES_DIR };
