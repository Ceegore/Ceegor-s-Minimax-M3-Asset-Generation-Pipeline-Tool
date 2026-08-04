// scripts/e2e/scenarios/persistence.js
// ============================================================================
// Ported from scripts/smoke-renderer.js step 8a (end-to-end persistence).
//
// The job-history stack used to be dead because jobsSnapshot/jobsArchiveCap
// and four other settings were missing from the renderer's STATE_PERSIST_KEYS.
// This scenario sets known values on state.*, triggers a save, reads the REAL
// state.json from the isolated temp config dir, and asserts the keys
// round-trip — exercising the full chain (renderer state → saveAllStates →
// IPC → main → src/state.js write → disk).
//
// Self-contained: the monolith relied on earlier steps having completed a
// bunch of generation jobs (so jobsSnapshot would be non-empty). The harness
// reset() does not clear state.jobs, but under --isolate this scenario gets a
// fresh harness, so it runs ONE quick image generation first to guarantee the
// jobs stack is non-empty before asserting on jobsSnapshot.
// ============================================================================

const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'persistence',
  needsRealApi: false,
  fakeOnly: true, // seeds jobs via the fast fake backend (real-gen timing differs)
  order: 70,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, TMP, DELAY } = ctx;

    // Seed the jobs stack with one completed generation so jobsSnapshot is
    // non-empty regardless of scenario order / isolation.
    await exec(`(() => {
      window.__smoke.errors = [];
      if (typeof state !== 'undefined') state.generating = null;
      try { showTab('image'); } catch (_) {}
      const p = document.querySelector('#tab-image');
      if (p) for (const ta of p.querySelectorAll('textarea')) { ta.value='persist-probe'; ta.dispatchEvent(new Event('input',{bubbles:true})); }
      const b = p && [...p.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Generate');
      if (b) b.click();
      return true;
    })()`);
    await sleep(DELAY + 900);

    // Set known values + trigger a save.
    await exec(`(() => {
      state.jobsArchiveCap = 150;
      state.apiKeyNoSave = true;
      state.fbTypeFilter = 'png,jpg';
      state.batchesAutoRemove = false;
      state.batchesExportFormat = 'txt';
      if (typeof saveAllStates === 'function') saveAllStates();
      return true;
    })()`);

    // Read the REAL state.json back. saveAllStates debounces and follow-on
    // autosaves (job-status updates) may still be in flight, so poll until a
    // complete, parseable document carrying the value we just set lands on
    // disk. The write itself is atomic (tmp + rename in src/state.js), so a
    // parseable snapshot is guaranteed once the debounced save has swapped in.
    let persisted = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 10 && !persisted; attempt++) {
      await sleep(300);
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'state.json'), 'utf8'));
        if (raw && raw.jobsArchiveCap === 150) persisted = raw;
        else lastErr = new Error('saved value not persisted yet');
      } catch (e) {
        lastErr = e;
      }
    }
    if (!persisted) {
      check(false, `could not read state.json from disk: ${lastErr && lastErr.message}`);
    }
    if (persisted) {
      check(Array.isArray(persisted.jobsSnapshot),
        `state.json must carry jobsSnapshot as an array — the renderer was not sending it before the fix (got ${typeof persisted.jobsSnapshot})`);
      check(Array.isArray(persisted.jobsSnapshot) && persisted.jobsSnapshot.length > 0,
        `state.json jobsSnapshot should be non-empty after a generation run (got length ${Array.isArray(persisted.jobsSnapshot) ? persisted.jobsSnapshot.length : 0})`);
      check(persisted.jobsArchiveCap === 150,
        `state.json jobsArchiveCap should round-trip the value 150 set on state.* (got ${persisted.jobsArchiveCap}) — the cap setting was resetting on every restart before the fix`);
      check(persisted.apiKeyNoSave === true,
        `state.json apiKeyNoSave should be true (got ${persisted.apiKeyNoSave}) — the checkbox state was resetting on every restart before the fix`);
      check(persisted.fbTypeFilter === 'png,jpg',
        `state.json fbTypeFilter should round-trip "png,jpg" (got ${JSON.stringify(persisted.fbTypeFilter)})`);
      check(persisted.batchesAutoRemove === false,
        `state.json batchesAutoRemove should be false (got ${persisted.batchesAutoRemove}) — the preference was resetting on every restart before the fix`);
      check(persisted.batchesExportFormat === 'txt',
        `state.json batchesExportFormat should be "txt" (got ${JSON.stringify(persisted.batchesExportFormat)})`);
    }
  },
};
