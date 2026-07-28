// scripts/e2e/scenarios/stress-concurrent.js
// ============================================================================
// Phase D4 — Stress: concurrent generation.
//
// Tests the app under concurrent load:
//   - Generate on all 4 tabs simultaneously
//   - Verify all 4 complete, no state corruption, no stuck buttons
//   - Rapid generate-cancel-generate cycle (5x)
// ============================================================================

module.exports = {
  name: 'stress-concurrent',
  needsRealApi: false,
  fakeOnly: true, // needs fake mmx backend
  order: 86,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, DELAY } = ctx;

    // ---- Test 1: Generate on all 4 tabs simultaneously ----
    const tabs = ['image', 'speech', 'music', 'video'];

    // Set up prompts on all tabs first.
    for (const tab of tabs) {
      await exec(`(() => {
        try { showTab(${JSON.stringify(tab)}); } catch (_) {}
        const p = document.querySelector('#tab-${tab}');
        if (p) for (const ta of p.querySelectorAll('textarea')) {
          ta.value = 'stress-concurrent-${tab}';
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      })()`);
    }

    // Click Generate on all tabs rapidly.
    await exec(`(() => {
      window.__smoke.errors = [];
      if (typeof state !== 'undefined') state.generating = null;
      const tabs = ${JSON.stringify(tabs)};
      for (const tab of tabs) {
        const p = document.querySelector('#tab-' + tab);
        if (!p) continue;
        const b = [...p.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Generate');
        if (b) b.click();
      }
      return true;
    })()`);

    // Wait for all generations to complete.
    // The app may serialize generations (one at a time via state.generating),
    // so 4 tabs × DELAY + overhead requires a generous wait.
    await sleep(DELAY * 6 + 2000);

    // QA-031 fix: do NOT force-clear state.generating. Assert it resolves
    // naturally after all jobs complete (the JobRunner._syncLegacyGenerating
    // fix from QA-021 ensures this).
    await sleep(500);

    // Verify no stuck generating state (natural, not forced).
    const notStuck = await exec(`(() => {
      if (typeof state === 'undefined') return true;
      return state.generating === null || state.generating === undefined;
    })()`);
    check(notStuck, 'stress-concurrent: generating state stuck after concurrent generation (QA-021 regression)');

    // QA-031: assert all 4 jobs reached terminal status naturally.
    const jobsDone = await exec(`(() => {
      if (!window.JobRunner) return true;
      const tabs = ${JSON.stringify(tabs)};
      return tabs.every(t => !window.JobRunner.isTabRunning(t));
    })()`);
    check(jobsDone, 'stress-concurrent: not all 4 jobs reached terminal status after wait');

    // Verify no unhandled errors.
    const noErrors = await exec(`window.__smoke.errors.length === 0`);
    check(noErrors, 'stress-concurrent: unhandled errors during concurrent generation');

    // ---- Test 2: Rapid generate-cancel-generate cycle ----
    await exec(`(() => {
      try { showTab('image'); } catch (_) {}
      return true;
    })()`);

    for (let i = 0; i < 5; i++) {
      // Generate (QA-031: no force-clear; cancel should reset state naturally).
      await exec(`(() => {
        const p = document.querySelector('#tab-image');
        if (p) for (const ta of p.querySelectorAll('textarea')) {
          ta.value = 'stress-cycle-' + ${i};
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const b = p && [...p.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Generate');
        if (b) b.click();
        return true;
      })()`);
      await sleep(50);

      // Cancel immediately.
      await exec(`(async () => {
        try { await window.api.mmxCancel(); } catch (_) {}
        return true;
      })()`);
      await sleep(50);
    }

    // Wait for any pending operations to settle.
    await sleep(DELAY + 500);

    // QA-031: assert state is clean naturally (no force-clear).
    const cleanAfterCycles = await exec(`(() => {
      if (typeof state === 'undefined') return true;
      return state.generating === null || state.generating === undefined;
    })()`);
    check(cleanAfterCycles, 'stress-concurrent: state not clean after rapid generate-cancel cycles (QA-021 regression)');

    const noActiveJobs = await exec(`(() => {
      if (!window.JobRunner) return true;
      const count = typeof window.JobRunner.activeCount === 'function' ? window.JobRunner.activeCount() : (typeof window.JobRunner.activeJobs === 'function' ? window.JobRunner.activeJobs().length : 0);
      return count === 0;
    })()`);
    check(noActiveJobs, 'stress-concurrent: active jobs remain after rapid cycles');

    // No file artifacts to clean up.
  },
};
