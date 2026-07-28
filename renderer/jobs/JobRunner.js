// renderer/jobs/JobRunner.js — Multi-job runner.
//
// Owns the renderer's job lifecycle. Each tab's generate handler wraps
// its body in JobRunner.run({ tabKey, type, title, subtitle, runFn,
// parentJobId }) instead of the old single `state.generating` slot
// (which only allowed one in-flight job at a time across all tabs).
//
// Model:
//   • state.jobs is a Map<jobId, Job>. Multiple jobs in different tabs
//     can run in parallel.
//   • Each job has exactly one primary log row (the log event with
//     jobId set in addLogEvent). Secondary stderr chunks are folded
//     into that row's expanded details via attachSecondaryToJob.
//   • Per-tab "is anything running?" check is `jobsForTab(tabKey)`
//     (any wip job for that tab), NOT the global `state.generating`.
//     state.generating is kept as a DERIVED projection (one tabKey
//     or 'mixed' or null) so legacy readers continue to work — see
//     _syncLegacyGenerating below.
//
// Public API:
//   JobRunner.run({ tabKey, type, title, subtitle, runFn, parentJobId })
//     -> { jobId, cancel, done }
//   JobRunner.cancel(jobId)
//   JobRunner.cancelAll()
//   JobRunner.jobsForTab(tabKey)   -> Job[]
//   JobRunner.isTabRunning(tabKey) -> boolean
//   JobRunner.on(event, cb) / off()  — for ActiveJobsWidget
//
// Events (the widget is the only consumer):
//   'jobrunner:job-added'
//   'jobrunner:job-updated'
//   'jobrunner:job-removed'
//
// Hard cap: 16 concurrent jobs. Past that, run() rejects with a
// friendly toast and the caller is expected to bail (the per-tab
// re-entrancy check makes the cap practically unreachable; the limit
// is just a safety net against runaway loops).

(function () {
  const HARD_CAP = 16;
  // Cap on the number of FINISHED jobs kept in `_jobs` for query/scrollback.
  // Finished jobs are intentionally NOT pruned at completion (see _wipJobCount
  // below) because tests/UI (scrollToJob, childLogIds lookups right after
  // `await ctrl.done`) expect a finished job to stay queryable in the same
  // tick. Without a cap, a marathon batch session would accumulate
  // finished-job records for the whole session with no bound. We keep the
  // most recent FINISHED_JOB_KEEP entries (in insertion order, which is
  // chronological because ids are monotonic) and evict the oldest finished
  // ones whenever a new job is added. WIP jobs are NEVER evicted.
  const FINISHED_JOB_KEEP = 200;
  const _jobs = new Map();
  const _listeners = new Map(); // event -> Set<cb>

  // Persist a `state.jobs` reference so legacy code (and tests) that
  // look at `state.jobs` see the same Map.
  if (typeof window !== 'undefined' && window.state) {
    window.state.jobs = _jobs;
  }

  function _emit(event, payload) {
    const set = _listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try { cb(payload); } catch (e) { console.warn('JobRunner listener failed:', e); }
    }
  }

  function on(event, cb) {
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(cb);
    return () => off(event, cb);
  }
  function off(event, cb) {
    const set = _listeners.get(event);
    if (set) set.delete(cb);
  }

  function _newJobId() {
    // Session-unique id. `${type}-${counter}` per type, monotonic.
    _jobs._idCounter = (_jobs._idCounter || 0) + 1;
    return `job-${Date.now().toString(36)}-${_jobs._idCounter}`;
  }

  function jobsForTab(tabKey) {
    if (!tabKey) return [];
    const out = [];
    for (const j of _jobs.values()) {
      if (j.tab === tabKey) out.push(j);
    }
    return out;
  }
  function isTabRunning(tabKey) {
    if (!tabKey) return false;
    for (const j of _jobs.values()) {
      if (j.tab === tabKey && j.status === 'wip') return true;
    }
    return false;
  }
  function activeJobs() {
    const out = [];
    for (const j of _jobs.values()) if (j.status === 'wip') out.push(j);
    return out;
  }

  // Counts only WIP jobs against the cap. Finished jobs are not pruned at
  // completion (see FINISHED_JOB_KEEP above); counting them against the cap
  // would block every future generation once 16 jobs had ever run in a
  // session. Existing tests/UI (scrollToJob, the childLogIds/job.status
  // lookups right after `await ctrl.done`) expect a finished job to stay
  // queryable in `_jobs`/`state.jobs`.
  function _wipJobCount() {
    let n = 0;
    for (const j of _jobs.values()) if (j.status === 'wip') n++;
    return n;
  }

  // Bound the finished-job history. Called from run() right after a new job is
  // inserted. Walks the map in insertion order (Map iteration is
  // insertion-ordered, and ids are monotonic by _newJobId, so "oldest" ==
  // "first inserted") and evicts finished jobs past FINISHED_JOB_KEEP. WIP
  // jobs and the just-inserted job are always retained. Emits
  // jobrunner:job-removed for each eviction so ActiveJobsWidget / listeners
  // stay in sync. Best-effort: a listener throwing does not abort the sweep.
  // Also strips evicted ids from state.jobsSnapshot so the snapshot and _jobs
  // stay consistent (snapshot ⊂ _jobs).
  function _pruneFinishedJobs() {
    if (_jobs.size <= FINISHED_JOB_KEEP) return;
    let finishedCount = 0;
    for (const j of _jobs.values()) {
      if (j.status !== 'wip') finishedCount++;
    }
    if (finishedCount <= FINISHED_JOB_KEEP) return;
    const toEvict = finishedCount - FINISHED_JOB_KEEP;
    const evictedIds = []; // collected for snapshot cleanup
    let evicted = 0;
    for (const [id, j] of _jobs) {
      if (evicted >= toEvict) break;
      if (j.status === 'wip') continue;
      _jobs.delete(id);
      evictedIds.push(id);
      try { _emit('jobrunner:job-removed', j); } catch (_) { /* best-effort */ }
      evicted++;
    }
    // Strip evicted ids from state.jobsSnapshot so the snapshot and _jobs
    // stay in lock-step.
    if (evictedIds.length && typeof window !== 'undefined' && window.state
        && Array.isArray(window.state.jobsSnapshot)) {
      const evictedSet = new Set(evictedIds);
      window.state.jobsSnapshot = window.state.jobsSnapshot.filter(
        (e) => !evictedSet.has(e && e.id),
      );
    }
  }

  // Legacy projection: keep `state.generating` truthy while ANY
  // JobRunner job is running. Single tab -> its key, multiple ->
  // 'mixed'. When NO JobRunner job is in flight, clear the field
  // so per-tab guards never permanently block a modality after
  // concurrent completions (QA-021 fix).
  function _syncLegacyGenerating() {
    if (typeof window === 'undefined' || !window.state) return;
    const tabs = new Set();
    for (const j of _jobs.values()) {
      if (j.status === 'wip' && j.tab) tabs.add(j.tab);
    }
    if (tabs.size === 0) {
      window.state.generating = null;
      return;
    }
    if (tabs.size === 1) window.state.generating = Array.from(tabs)[0];
    else window.state.generating = 'mixed';
  }

  function _createJob(opts) {
    const id = _newJobId();
    const now = new Date();
    return {
      id,
      type: opts.type || 'image',
      tab: opts.tabKey || null,
      parentJobId: opts.parentJobId || null,
      title: opts.title || 'Generation',
      subtitle: opts.subtitle || '',
      status: 'wip',
      startedAt: now,
      finishedAt: null,
      progress: opts.progress || null,
      error: null,
      logEventId: null,        // primary row id (filled in by addLogEvent)
      childLogIds: [],         // secondary stderr chunks
      outputPaths: [],         // filled from runFn's result on completion
      _abortController: null,  // AbortController for the runFn signal
      _cancellable: true,      // matches opts.cancellable
    };
  }

  // Persist a summary of a finished job into state.jobsSnapshot so the L2
  // boot-render (bootstrap.js), History/ArchiveViewer, and JobSummary panel
  // get data. The shape mirrors what LogService.renderPersistedL2 /
  // ArchiveViewer read: { id, type, tab, title, subtitle, status,
  // finishedAt, outputPaths, error }. Does NOT remove the job from `_jobs` —
  // see _wipJobCount above for why finished jobs intentionally stay
  // queryable.
  function _pushJobSnapshot(job) {
    if (typeof window === 'undefined' || !window.state) return;
    if (!Array.isArray(window.state.jobsSnapshot)) window.state.jobsSnapshot = [];
    window.state.jobsSnapshot.push({
      id: job.id,
      type: job.type,
      tab: job.tab,
      title: job.title,
      subtitle: job.subtitle,
      status: job.status,
      finishedAt: job.finishedAt,
      outputPaths: Array.isArray(job.outputPaths) ? job.outputPaths.slice() : [],
      error: job.error || null,
    });
    // Trim the in-memory L2 list to jobsArchiveCap right here, after every
    // push. Without client-side trimming the array only ever grows, and
    // saveAllStates() sends the full untrimmed array on every save, so
    // src/state.js write() re-archives the same overflow entries on every
    // save. Trimming client-side means the persisted array is already the
    // post-trim shape, and the server-side trim becomes a defensive no-op
    // for the normal path. The cap is clamped to [20, 1000] to match
    // src/state.js write()'s clamp.
    const cap = Math.max(20, Math.min(1000, Number(window.state.jobsArchiveCap) || 200));
    if (window.state.jobsSnapshot.length > cap) {
      window.state.jobsSnapshot = window.state.jobsSnapshot.slice(-cap);
    }
    if (typeof window.scheduleStateSave === 'function') {
      try { window.scheduleStateSave(); } catch (_) { /* ignore */ }
    }
  }

  function _addLogSecondary(job, line) {
    if (!job || !line) return;
    const Log = (typeof window !== 'undefined' && window.LogService) || null;
    if (!Log) return;
    const safeLine = String(line);
    // If the job has a primary row, fold the line into the row's `details`
    // array (so it shows in the expanded view of the primary row, not as a
    // separate standalone row). Routing it through addLogEvent with
    // _internal:true would skip addLogEvent's routing check
    // (`!ev._internal`) and turn every line into its own row; combined with
    // the main process sending each line twice (onLog + onChunk — see
    // main/ipc/registerMmxIpc.js), that doubled every mmx line in the pane.
    // Folding into the primary row's details also matches the intent of
    // attachSecondaryToJob.
    if (job.logEventId != null
        && typeof Log.appendLogDetails === 'function') {
      // Cap secondary lines per job to avoid runaway log spam.
      // The DOM stays small because the details section is the
      // only place they're rendered, but a runaway mmx process
      // could otherwise grow the array unbounded.
      if (job.childLogIds.length >= 500) {
        // Drop the oldest. We don't bother removing it from the
        // DOM (appendLogDetails is incremental), but the cap
        // prevents the array from growing without bound.
        job.childLogIds.shift();
      }
      Log.appendLogDetails(job.logEventId, [safeLine]);
      job.childLogIds.push(job.logEventId);
      return;
    }
    // No primary row (suppressLogRow: true) — fall back to
    // creating a separate log row so the user still sees the
    // mmx output. We use addLogEvent WITHOUT the _internal
    // flag so the routing check still applies (free-form, no
    // jobId, so no routing anyway).
    if (typeof Log.addLogEvent !== 'function') return;
    if (job.childLogIds.length >= 500) job.childLogIds.shift();
    const evId = Log.addLogEvent({
      category: 'info',
      headline: safeLine.slice(0, 200),
      details: [safeLine],
      jobId: job.id,
      // _internal: true tells addLogEvent NOT to re-route through
      // attachSecondaryToJob (infinite recursion safeguard). The
      // routing check (`!ev._internal`) means this event won't
      // fold into the primary row — but we already established
      // above that there IS no primary row (logEventId is null),
      // so the routing check is moot.
      _internal: true,
    });
    if (evId != null) job.childLogIds.push(evId);
  }

  function _markJobDone(job, status, errorMsg, details, outputPaths) {
    job.status = status;
    job.finishedAt = new Date();
    if (errorMsg) job.error = String(errorMsg).slice(0, 500);
    if (Array.isArray(outputPaths)) job.outputPaths = outputPaths.slice();
    job._cancellable = false;
    if (job.logEventId != null && typeof window.LogService !== 'undefined') {
      // Update the primary row's status classes + add an "ok"/"err"
      // detail line so the user sees the final outcome in the
      // expanded view.
      window.LogService.updateLogStatus && window.LogService.updateLogStatus(job.logEventId, {
        status,
        result: status === 'ok' ? 'ok' : status === 'warn' ? null : status === 'cancel' ? 'warn' : 'err',
      });
    }
    if (details && details.length && typeof window.LogService !== 'undefined') {
      window.LogService.appendLogDetails && window.LogService.appendLogDetails(job.logEventId, details);
    }
    _emit('jobrunner:job-updated', job);
    // Do NOT emit 'job-removed' here. The job is still in `_jobs`
    // (intentionally — finished jobs stay queryable for scrollback/`await
    // ctrl.done` lookups, and are only evicted later by
    // _pruneFinishedJobs once the FINISHED_JOB_KEEP cap is crossed).
    // Emitting 'job-removed' for a job still in the map is a semantic trap
    // for any listener that treats the event as "this id is gone from
    // state.jobs", and it caused every finishing job to fire
    // 'job-removed' twice (once here, once when eventually pruned).
    _syncLegacyGenerating();
    _pushJobSnapshot(job);
  }

  // Attach a free-form log line to a job's primary row (not as its own
  // row). Used by the IPC layer to route `mmx:log` chunks to the right
  // job. Returns the new event id.
  function attachSecondaryToJob(jobId, line) {
    const job = _jobs.get(jobId);
    if (!job) return null;
    _addLogSecondary(job, line);
    return job.logEventId;
  }

  // Public: run a job. The caller's `runFn` is an async function that
  // receives { signal, onProgress, onSecondary, onWarn } and either
  // resolves to a structured result or throws. The job is created
  // synchronously, the primary log row is appended up front, and the
  // runFn is invoked in the next microtask so the caller can register
  // listeners on the returned job before the first event fires.
  function run(opts) {
    opts = opts || {};
    // Re-assert window.state.jobs here. The one-time assignment at script-load
    // time no-ops if window.state doesn't exist yet (this file loads before
    // the state module defines it). By the time run() is called a real
    // generation is starting, so state is guaranteed to exist. Idempotent and
    // cheap.
    if (typeof window !== 'undefined' && window.state && window.state.jobs !== _jobs) {
      window.state.jobs = _jobs;
    }
    if (_wipJobCount() >= HARD_CAP) {
      const msg = `Too many jobs running (limit ${HARD_CAP}). Wait for one to finish and try again.`;
      if (typeof window !== 'undefined' && window.toast) window.toast(msg, 'err', 5000);
      return Promise.reject(new Error(msg));
    }
    const tabKey = opts.tabKey || null;
    // Per-tab gate. Different tabs can run in parallel, but the same tab
    // cannot start a second job while one is wip.
    if (tabKey && isTabRunning(tabKey)) {
      const msg = `A generation is already running on the ${tabKey} tab.`;
      if (typeof window !== 'undefined' && window.toast) window.toast(msg, 'warn', 3000);
      return Promise.reject(new Error(msg));
    }

    const job = _createJob(opts);
    _jobs.set(job.id, job);
    // Bound finished-job history so a long batch session can't grow
    // `_jobs` without limit. The new job (still wip here) is always
    // retained; only old finished jobs past FINISHED_JOB_KEEP are evicted.
    _pruneFinishedJobs();
    _emit('jobrunner:job-added', job);
    _syncLegacyGenerating();

    // Append the primary log row up front. The caller gets a stable
    // logEventId back so it can attach stderr chunks etc.
    // opts.suppressLogRow lets a caller that already does its own manual
    // logging register with JobRunner for ActiveJobsWidget / jobId-scoped
    // cancel without getting a second, redundant primary row.
    // job.logEventId stays null, and every downstream LogService call in
    // _markJobDone is guarded on `logEventId != null`, so it no-ops.
    let logEventId = null;
    if (!opts.suppressLogRow && typeof window !== 'undefined' && window.LogService && window.LogService.addLogEvent) {
      logEventId = window.LogService.addLogEvent({
        category: opts.logCategory || 'gen',
        headline: opts.title || 'Generation',
        details: opts.subtitle ? [opts.subtitle] : [],
        jobId: job.id,
        pinToBottom: true,
        cancellable: true,
        typeIcon: opts.typeIcon,
      });
    }
    job.logEventId = logEventId;
    _emit('jobrunner:job-updated', job);

    // The runFn runs in the next microtask so the caller can wire up
    // cancellation on the returned object before any event fires.
    const ac = new AbortController();
    job._abortController = ac;
    const done = new Promise((resolve) => {
      queueMicrotask(async () => {
        const ctx = {
          signal: ac.signal,
          onProgress: (step, total) => {
            job.progress = { step: step | 0, total: total | 0 };
            _emit('jobrunner:job-updated', job);
          },
          onSecondary: (line) => _addLogSecondary(job, line),
          onWarn: (msg) => _addLogSecondary(job, '[warn] ' + msg),
        };
        let result = null;
        let threw = null;
        try {
          result = await opts.runFn(ctx);
        } catch (e) {
          threw = e;
        }
        const outputPaths = (result && Array.isArray(result.outputPaths)) ? result.outputPaths : [];
        if (ac.signal.aborted) {
          _markJobDone(job, 'cancel', threw ? (threw.message || String(threw)) : null, ['Cancelled by user.'], outputPaths);
        } else if (threw) {
          _markJobDone(job, 'err', threw.message || String(threw), ['Error: ' + (threw.message || String(threw))], outputPaths);
        } else if (result && result.status === 'warn') {
          _markJobDone(job, 'warn', null, result.details || [], outputPaths);
        } else if (result && result.status === 'err') {
          _markJobDone(job, 'err', result.error || null, result.details || [], outputPaths);
        } else if (result && result.status === 'cancel') {
          // A runFn that returns {status: 'cancel'} without going through
          // the abort signal (e.g. a programmatic cancel) is mapped to
          // 'cancel' rather than falling through to 'ok'. The abort path
          // above covers the common case; this branch covers the rest.
          _markJobDone(job, 'cancel', null, ['Cancelled.'], outputPaths);
        } else {
          _markJobDone(job, 'ok', null, result && result.details ? result.details : [], outputPaths);
        }
        resolve({ job, status: job.status, error: job.error });
      });
    });

    return { jobId: job.id, cancel: () => _cancelJob(job), done };
  }

  function _cancelJob(job) {
    if (!job || job.status !== 'wip') return;
    job._cancellable = false;
    if (job._abortController) {
      try { job._abortController.abort('user-cancel'); } catch (_) { /* ignore */ }
    }
    // The runFn is expected to honour the abort signal. We DON'T
    // delete the job here — _markJobDone will fire when the runFn
    // resolves / rejects and the cleanup below keeps the row visible
    // long enough for the user to see the cancel colour.
    if (typeof window !== 'undefined' && window.api && typeof window.api.mmxCancel === 'function') {
      // Pass the jobId so main kills only this job's mmx proc
      // (src/mmx.js#cancelByJobId), not every in-flight generation on
      // every tab. Tab handlers route their mmx call through
      // mmxRunJob({ args, jobId: job.id }); if a legacy caller omits the
      // jobId, main no-ops for this jobId rather than cancelling
      // unrelated jobs.
      // R5: try/catch alone can't catch the async IPC rejection — wrap in
      // Promise.resolve().catch() so a rejecting mmxCancel never surfaces as
      // an unhandled rejection (mirrors the batchManager stop-handler pattern).
      try { Promise.resolve(window.api.mmxCancel({ jobId: job.id })).catch(() => {}); } catch (_) { /* ignore */ }
    }
  }

  function cancel(jobId) {
    const job = _jobs.get(jobId);
    if (job) _cancelJob(job);
  }
  function cancelAll() {
    for (const j of _jobs.values()) {
      if (j.status === 'wip') _cancelJob(j);
    }
  }

  // Persist an honest 'cancel' record for any job still wip when the app
  // is about to exit. The mmx child is about to be killed along with the
  // process, so these jobs are interrupted regardless; flushing avoids
  // silently dropping them from history on quit.
  function flushBatchSummaries() {
    for (const job of _jobs.values()) {
      if (job.status === 'wip') {
        job.status = 'cancel';
        job.finishedAt = new Date();
        if (!job.error) job.error = 'Interrupted by app shutdown.';
        _pushJobSnapshot(job);
      }
    }
  }

  // ---- expose ----
  window.JobRunner = {
    run,
    cancel,
    cancelAll,
    jobsForTab,
    isTabRunning,
    activeJobs,
    attachSecondaryToJob,
    flushBatchSummaries,
    syncLegacyGenerating: _syncLegacyGenerating,
    on,
    off,
    HARD_CAP,
  };
})();
