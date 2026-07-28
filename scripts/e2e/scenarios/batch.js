// scripts/e2e/scenarios/batch.js
// ============================================================================
// Ported near-verbatim from scripts/smoke-renderer.js steps 4, 4a, 4b, 4c.
//
//   4)  BatchGen auto-remove drains the queue + pure-batch mints a grant.
//   4a) the "■ Stop batch" button survives the tab's preview.innerHTML
//       status updates while an item is actively generating.
//   4b) the whole batch is one parent JobRunner job (tab:null, "Batch: Music")
//       and JobSummary.emit() logs "Batch finished: N/M ok".
//   4c) cancelling the parent job via JobRunner.cancel(jobId) settles it to
//       'cancel' and bridges into window._batchAbortByTab.
//
// Self-contained: seeds its own state.batches.* and clears state._fbGrantId.
// ============================================================================

module.exports = {
  name: 'batch',
  needsRealApi: false,
  fakeOnly: true, // drives the fake backend's grant capture + polling timing
  order: 20,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check } = ctx;

    // ---- 4) batch auto-remove drains the queue ----
    // Clear state._fbGrantId to simulate a PURE-BATCH flow (no prior
    // interactive Generate). The batch must mint its own grant and forward it.
    global.__e2eLastMmxGrantId = undefined;
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
    check(typeof global.__e2eLastMmxGrantId === 'string' && global.__e2eLastMmxGrantId.length > 0,
      `pure-batch must forward a non-empty grantId to mmx:run:job (got: ${JSON.stringify(global.__e2eLastMmxGrantId)})`);

    // ---- 4a) Stop batch button survives preview.innerHTML updates ----
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

    // ---- 4b) whole batch as one parent JobRunner job + JobSummary ----
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

    // ---- 4c) cancel a batch mid-run via JobRunner.cancel(jobId) ----
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

    // Leave the batch state clean for downstream scenarios.
    await exec(`(async () => {
      state.batches = { image: [], speech: [], music: [], video: [] };
      try { await window.api.batchesSet(state.batches); } catch (_) {}
      try { _refreshBatchButtons(); } catch (_) {}
      state.batchesAutoRemove = true;
      return true;
    })()`).catch(() => false);
  },
};
