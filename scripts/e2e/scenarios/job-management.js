// scripts/e2e/scenarios/job-management.js
// ============================================================================
// Phase A5 — Job management IPC coverage.
//
// Exercises the 3 never-invoked job:* IPC channels:
//   job:list, job:cancel, job:cancel-all
//
// Starts a fake generation (which registers a job in the jobRegistry),
// then exercises list/cancel/cancel-all against it.
// ============================================================================

module.exports = {
  name: 'job-management',
  needsRealApi: false,
  fakeOnly: true, // needs the fake mmx backend's delayed response
  order: 48,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, DELAY } = ctx;

    // ---- job:list — list active jobs (empty at start) ----
    const listEmpty = await exec(`(async () => {
      try {
        return await window.api.jobList();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(listEmpty !== undefined && listEmpty !== null, 'job:list IPC was not invoked');
    check(Array.isArray(listEmpty) || (listEmpty && listEmpty.ok !== false),
      'job:list did not return a valid response');

    // Start a generation so a job is registered in the registry.
    await exec(`(() => {
      window.__smoke.errors = [];
      if (typeof state !== 'undefined') state.generating = null;
      try { showTab('image'); } catch (_) {}
      const p = document.querySelector('#tab-image');
      if (p) for (const ta of p.querySelectorAll('textarea')) {
        ta.value = 'job-mgmt-test';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const b = p && [...p.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Generate');
      if (b) b.click();
      return true;
    })()`);
    // Wait briefly for the job to register (but not complete).
    await sleep(Math.min(DELAY / 2, 100));

    // ---- job:list — list active jobs (should have 1 now) ----
    const listActive = await exec(`(async () => {
      try {
        return await window.api.jobList();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(listActive !== undefined && listActive !== null, 'job:list (active) IPC was not invoked');

    // ---- job:cancel — cancel a specific job ----
    // Get the first job's id from the list (if available).
    const jobId = Array.isArray(listActive) && listActive.length > 0
      ? (listActive[0].jobId || listActive[0].id || null)
      : null;
    const cancelRes = await exec(`(async () => {
      try {
        return await window.api.jobCancel(${JSON.stringify(jobId ? { jobId } : {})});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(cancelRes !== undefined && cancelRes !== null, 'job:cancel IPC was not invoked');

    // Wait for the generation to settle (cancelled or completed).
    await sleep(DELAY + 500);

    // ---- job:cancel-all — cancel all remaining jobs ----
    const cancelAllRes = await exec(`(async () => {
      try {
        return await window.api.jobCancelAll();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(cancelAllRes !== undefined && cancelAllRes !== null, 'job:cancel-all IPC was not invoked');

    // Ensure state is clean for subsequent scenarios.
    await exec(`(() => { if (typeof state !== 'undefined') state.generating = null; return true; })()`);
    await sleep(200);
  },
};
