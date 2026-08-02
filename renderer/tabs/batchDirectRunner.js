// renderer/tabs/batchDirectRunner.js
// H11-3: the direct (snapshot) execution path for BatchGen.
//
// Instead of mutating the live tab DOM + clicking Generate + restoring (which
// inherits whatever's currently in the UI for fields not in the row), this
// builds the mmx argv directly from the parsed row params, calls mmxRunJob,
// runs the per-row postprocess (bg-removal/crop/resize/optimize/trim), and
// optionally enqueues to the pipeline. Rows become self-contained snapshots.
//
// R6.2 (JobWorkspace für n>1): every direct run mints its own
// `runSubdir = <outputDir>/run_<id>/` so the n>1 case can list that
// subdir for the new files (no mtime scan — the subdir by construction
// only contains files from THIS run, even if the parent outputDir is
// shared with concurrent runs or with the user's pre-existing files).
//
// The batch runner calls runVariantDirect(tabKey, item, ctxOverrides) per
// variant. Returns { ok, outFile, error } (a cancel additionally carries
// status: 'partial'|'cancel' + outputPaths — see P4.6 below; a generation
// that succeeded but whose row-requested postprocess FAILED carries
// status: 'partial' + postprocessErrors — see H-056 below).

(function () {
  'use strict';

  // Build the context the argv builders need from current global state.
  // R6.2: if `overrides.runSubdir` is provided (the caller has just minted
  // a per-run subdir), the ctx is scoped to that subdir so the ArgvBuilder's
  // --out-dir + uniquePath all write inside the run workspace. Without an
  // explicit runSubdir the ctx falls back to the user's normal outputDir
  // (single-image runs / pre-R6.2 callers).
  function makeCtx(overrides) {
    overrides = overrides || {};
    const st = window.state || {};
    // R6.2: a per-run subdir scopes all of the run's writes (ArgvBuilder
    // --out-dir, --out, uniquePath, nextFreeForcePrefixPath) to that one
    // subdir. `runSubdir` is preferred over the user-facing outputDir.
    const baseOutputDir = overrides.outputDir || st.fbDir || (st.config && st.config.output_dir) || '';
    const outputDir = overrides.runSubdir || baseOutputDir;
    // R6.5: styles can be snapshotted at batch start (overrides.styles) so a
    // mid-batch style edit doesn't affect subsequent items.
    const styles = overrides.styles || (st.config && st.config.styles) || [];
    return {
      outputDir,
      baseOutputDir,
      runSubdir: overrides.runSubdir || null,
      grantId: overrides.grantId || (st._fbGrantId) || null, // B.2: batch-owned grant
      filePrefix: overrides.filePrefix != null ? overrides.filePrefix : (st.filePrefix || ''),
      filePrefixForceOnly: overrides.filePrefixForceOnly != null ? overrides.filePrefixForceOnly : !!st.filePrefixForceOnly,
      styles,
      slugify: window.slugify || ((s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')),
      uniquePath: window.uniquePath || ((dir, name) => { const sep = dir.includes('\\') ? '\\' : '/'; return dir + sep + name; }),
      nextFreeForcePrefixPath: window.nextFreeForcePrefixPath || (async (dir, counter, prefix, ext) => { const sep = dir.includes('\\') ? '\\' : '/'; counter.n = (counter.n || 0) + 1; return dir + sep + (prefix || '') + String(counter.n).padStart(6, '0') + '.' + ext; }),
      timestamp: window.timestamp || (() => { const d = new Date(); return d.getFullYear() + '' + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0'); }),
      forceCounter: overrides.forceCounter || { n: 0 },
    };
  }

  // R6.2: mint a per-run subdir under the user-facing outputDir. The
  // returned path is what every write (ArgvBuilder --out/--out-dir,
  // uniquePath) gets scoped to. The id is monotonic-in-time + a short
  // random tail to avoid collisions when two batch items race to mint
  // at the same millisecond.
  function mintRunSubdir(baseOutputDir) {
    if (!baseOutputDir) return { ok: false, error: 'no baseOutputDir' };
    const sep = baseOutputDir.includes('\\') ? '\\' : '/';
    const t = Date.now();
    const tail = Math.random().toString(36).slice(2, 8);
    const id = `run_${t}_${tail}`;
    return { ok: true, id, runSubdir: baseOutputDir + sep + id };
  }

  // R6.2: create a directory via the same path the rest of the app uses
  // (fb:ensureDir falls back to mkdir-p semantics; fb:mkdir requires the
  // parent to already exist). The grant lives in window.state; the
  // renderer's IPC layer attaches it from the caller's session grant.
  async function ensureRunSubdir(runSubdir, grantId) {
    if (!runSubdir) return { ok: false, error: 'no runSubdir' };
    if (window.api && typeof window.api.fbEnsureDir === 'function') {
      try {
        const st = window.state || {};
        const gid = grantId || st._fbGrantId || undefined;
        const r = await window.api.fbEnsureDir(runSubdir, gid);
        if (r && r.ok) return { ok: true, path: r.path || runSubdir };
        return { ok: false, error: r && r.error || 'fbEnsureDir failed' };
      } catch (e) {
        return { ok: false, error: e && (e.message || String(e)) };
      }
    }
    // No IPC helper available (test harness / future renderer wiring):
    // fall back to a no-op success so the caller still gets a runSubdir.
    // Production code always has fbEnsureDir (it ships in main/ipc).
    return { ok: true, path: runSubdir, note: 'fbEnsureDir unavailable — subdir not actually created' };
  }

  // P4.6 (DB-H-007): inventory the deliverable files inside a private run
  // dir. Shared by the success-path discovery and the cancel-path partial-
  // output inventory. The dir only ever holds THIS run's files (P4.2: a
  // failed mint aborts before mmx spawns), so no mtime filtering; the
  // extension filter drops the .meta.json / .tmp / .part files mmx-cli
  // sometimes leaves behind.
  async function listRunDirFiles(dir) {
    if (!dir || !window.api || typeof window.api.fbList !== 'function') return [];
    try {
      const _g = (window.GrantHelper && window.GrantHelper.ensureDirList) ? await window.GrantHelper.ensureDirList(dir) : undefined;
      const list = (_g && _g.ok === false) ? _g : await window.api.fbList(dir, _g);
      if (list && list.ok && Array.isArray(list.items)) {
        return list.items
          .filter((it) => !it.isDir && ['.png', '.jpg', '.jpeg', '.webp'].includes(it.ext))
          .sort((a, b) => (a.name || a.path || '').localeCompare(b.name || b.path || ''))
          .map((it) => it.path);
      }
    } catch (_) { /* best-effort */ }
    return [];
  }

  // Run ONE generation directly (no DOM mutation). Handles postprocess + enqueue.
  // Returns { ok, outFile, error }.
  async function runVariantDirect(tabKey, item, ctxOverrides) {
    // A batch row can be a bare string (the "+ Add prompt" / "Bulk paste"
    // shape — src/batches.js explicitly preserves this shape alongside
    // object rows). The pure builders read params.prompt/params.text, both
    // undefined on a string, which silently produced an empty --prompt/--text.
    if (typeof item === 'string') item = { prompt: item };

    // BGR-012 fix: fenced-JSON imports preserve the leading '--' on keys
    // (e.g. {'--model': 'image-01'}). ArgvBuilders expect bare kebab-case
    // keys. Normalize before building — and BEFORE the runSubdir n-check
    // below, so a dashed '--n' key also triggers per-run subdir minting.
    let normalizedItem = item;
    if (item && typeof item === 'object') {
      const hasDashed = Object.keys(item).some((k) => k.startsWith('--'));
      if (hasDashed) {
        normalizedItem = {};
        for (const [k, v] of Object.entries(item)) {
          normalizedItem[k.replace(/^--/, '')] = v;
        }
      }
    }

    // R6.2: mint a per-run subdir BEFORE building the ctx. The ctx then
    // scopes every write (--out, --out-dir, uniquePath) to the runSubdir.
    // P4.2 (DB-H-001): the n>1 case MUST run in its private subdir — a
    // failed mint/mkdir ABORTS the item. Falling back to the shared
    // outputDir would revive the racy mtime discovery the subdir exists to
    // prevent (concurrent runs claiming each other's files).
    const _seedCtx = makeCtx(ctxOverrides || {});
    let runSubdir = null;
    {
      // R6.2 only mints a runSubdir for the n>1 (out-dir) case. Single-file
      // runs (n=1) keep writing directly to the user-facing outputDir —
      // a per-run subdir per single image would multiply the user's folder
      // count by the batch size, which is exactly the noise R6.1 fought.
      const nRaw = (normalizedItem && (normalizedItem.n || (normalizedItem.params && normalizedItem.params.n))) || '1';
      const nCount = (nRaw === '' || nRaw == null) ? 1 : Math.max(1, parseInt(nRaw, 10) || 1);
      if (nCount > 1) {
        const minted = mintRunSubdir(_seedCtx.outputDir);
        const ensured = minted.ok ? await ensureRunSubdir(minted.runSubdir, _seedCtx.grantId) : minted;
        if (!ensured.ok) {
          return { ok: false, outFile: null, error: 'Private run directory could not be created: ' + (ensured.error || 'unknown') + ' — aborted (would fall back to the shared output folder).' };
        }
        runSubdir = ensured.path;
      }
    }

    const ctx = makeCtx(Object.assign({}, ctxOverrides || {}, { runSubdir }));
    if (!window.ArgvBuilders || typeof window.ArgvBuilders.buildArgs !== 'function') {
      return { ok: false, outFile: null, error: 'ArgvBuilders not loaded.' };
    }
    // Build the argv from the row params (pure — no DOM reads).
    let built;
    try {
      built = await window.ArgvBuilders.buildArgs(tabKey, normalizedItem, ctx);
    } catch (e) {
      return { ok: false, outFile: null, error: 'Argv build failed: ' + (e && e.message || e) };
    }
    const { args, outFile } = built;
    if (!Array.isArray(args) || args.length < 2) {
      return { ok: false, outFile: null, error: 'Built argv is empty.' };
    }
    // B-002: mint read grants for any local input reference paths the built
    // argv carries (--subject-ref image=, --first-frame, …) — the batch's
    // output grant does not cover arbitrary ref locations. URLs are skipped.
    const readGrantIds = (window.GrantHelper && window.GrantHelper.ensureMmxReadGrants)
      ? await window.GrantHelper.ensureMmxReadGrants(args) : [];
    // Call mmx directly (the IPC layer is DOM-agnostic). Wrap the call in
    // JobRunner.run({tabKey}) exactly like the tab handlers do for an
    // interactive generation (imageTab.js/speechTab.js etc.) — this is
    // parity with the OLD DOM path, which also registered a per-item
    // JobRunner job under the tab via genBtn.click(). Without it the direct
    // path never held any "tab busy" state: JobRunner.isTabRunning(tabKey)
    // (what _isTabRunningNow in batchManager.js, ActiveJobsWidget, and the
    // BatchGen Stop-button visibility all rely on) stayed false for the
    // whole batch, letting a manual generation race the batch's mmx
    // subprocess. suppressLogRow:true avoids a duplicate primary log row
    // (the batch overlay already logs its own line per item/variant).
    const st = window.state || (window.state = {});
    let r;
    if (window.JobRunner && typeof window.JobRunner.run === 'function') {
      let ctrl;
      try {
        ctrl = window.JobRunner.run({
          tabKey,
          type: tabKey,
          title: `Batch item (${tabKey})`,
          suppressLogRow: true,
          // Pass the JobRunner job's OWN id as the mmx jobId (exactly like the
          // DOM tab handlers do) so main indexes the mmx proc under the same id
          // JobRunner.cancel() uses — otherwise ActiveJobsWidget's per-item ✕
          // (which cancels via job.id) would not match the running proc and the
          // mmx subprocess would keep running. ctrl is assigned before runFn
          // executes (runFn runs in a later microtask), so ctrl.jobId is safe.
          runFn: async (jobCtx) => {
            // R7.5 (S1 §6 R1.5b): forward the stashed output grant so the
            // mmx --out/--out-dir write is authorised (same grant
            // ensureRunSubdir uses for fb:ensureDir above).
            // B.2: ctx.grantId is the batch-owned grant from makeCtx (not
            // the JobRunner's jobCtx, which only carries signal/abort).
            r = await window.api.mmxRunJob({ args, jobId: ctrl.jobId, readGrantIds }, ctx.grantId);
            if (jobCtx.signal.aborted) return { status: 'cancel' };
            const okInner = !!(r && (r.ok || r.code === 0));
            return okInner ? { status: 'ok' } : { status: 'err', error: (r && (r.stderr || r.error)) || 'mmx failed' };
          },
        });
      } catch (e) {
        return { ok: false, outFile, error: 'JobRunner rejected: ' + (e && e.message || e) };
      }
      // BUG #2 fix: JobRunner.run returns a REJECTED PROMISE (not a sync
      // throw) on the hard-cap / same-tab gate, which the try/catch above
      // cannot see. Without this guard `ctrl` would be that rejected
      // promise: ctrl.done is undefined (the item fails later with the
      // misleading 'mmxRunJob returned null') and the rejection goes
      // unobserved. Mirror the guard in batchManager.js /
      // imageEditorAssetGen.js.
      if (ctrl && typeof ctrl.catch === 'function') {
        let msg = 'JobRunner rejected the job.';
        try { await ctrl; } catch (e) { msg = 'JobRunner rejected: ' + (e && e.message || e); }
        return { ok: false, outFile, error: msg };
      }
      const doneRes = await ctrl.done;
      // JobRunner's _syncLegacyGenerating() SETS state.generating while our
      // job is wip, but deliberately never CLEARS it — that cleanup is
      // normally done by armGenBtnWithCancel's cleanup() (app.js:
      // `if (state.generating === tabKey) state.generating = null;`), which
      // the direct path never calls. Without this, state.generating would
      // stay stuck at tabKey forever after the first batch item, and
      // batchManager's `while (_isTabRunningNow(tabKey))` gate (which OR's
      // in state.generating === tabKey) would then spin forever before
      // every subsequent variant/item — hanging the whole batch.
      if (st.generating === tabKey) st.generating = null;
      // R9: a cancelled child's runFn returns { status: 'cancel' } — `r` is
      // whatever the killed proc resolved to (often null), which the `!r`
      // guard below would misreport as "mmxRunJob returned null" and log as
      // ✗ FAILED. Report the cancel accurately instead.
      // P4.6 (DB-H-007): before returning, inventory the private runSubdir —
      // a killed n>1 run may already have written deliverables. Policy:
      // keepPartialOutputs (default true) keeps them on disk and reports
      // status 'partial' with the discovered paths; false deletes the whole
      // runSubdir (best-effort, mirrors the mmx-failure cleanup below).
      if (doneRes && (doneRes.status === 'cancel' || doneRes.status === 'partial')) {
        const keep = !(ctxOverrides && ctxOverrides.keepPartialOutputs === false);
        let partialPaths = runSubdir ? await listRunDirFiles(runSubdir) : [];
        if (runSubdir && !keep) {
          if (window.api && typeof window.api.fbDelete === 'function') {
            try { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(runSubdir) : undefined; await window.api.fbDelete(runSubdir, dg); } catch (_) { /* best-effort */ }
          }
          partialPaths = [];
        }
        return {
          ok: false,
          outFile: partialPaths[0] || null,
          outputPaths: partialPaths,
          status: partialPaths.length ? 'partial' : 'cancel',
          error: partialPaths.length ? `cancelled — ${partialPaths.length} partial output(s) kept in ${runSubdir}` : 'cancelled',
        };
      }
    } else {
      // No JobRunner (e.g. a bare test harness) — plain call with a synthetic
      // jobId so mmxCancel/main proc-tracking still has a key to work with.
      const jobId = 'batch-direct-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      try {
        r = await window.api.mmxRunJob({ args, jobId, readGrantIds }, ctx.grantId);
      } catch (e) {
        return { ok: false, outFile, error: 'mmxRunJob threw: ' + (e && e.message || e) };
      }
    }
    if (!r) return { ok: false, outFile, error: 'mmxRunJob returned null.' };
    const ok = !!(r.ok || (r.code === 0));
    if (!ok) {
      // R6.2: an mmx failure left the per-run subdir on disk. Delete the
      // empty (or partial) subdir so the user's outputDir doesn't accumulate
      // dead run_<id>/ folders. The fb:delete call is best-effort — a
      // permissions error or an OS-level failure must NOT mask the original
      // mmx error we're returning to the caller.
      if (runSubdir && window.api && typeof window.api.fbDelete === 'function') {
        // BGR-009 fix: mint delete grant (R1.3 gate).
        try { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(runSubdir) : undefined; await window.api.fbDelete(runSubdir, dg); } catch (_) { /* best-effort */ }
      }
      return { ok: false, outFile, error: r.stderr || r.error || 'mmx failed' };
    }

    // Collect the output file(s). The builder produces one outFile per call;
    // for the image n>1 case (--out-dir), mmx names the files itself, so
    // inventory the private per-run subdir (P4.2/DB-H-001: a failed mint
    // aborts above, so the dir only ever holds THIS run's files — no mtime
    // filter needed; see listRunDirFiles).
    let outFiles = [];
    if (outFile) {
      outFiles.push(outFile);
    } else if (built.outDir) {
      outFiles = await listRunDirFiles(built.outDir);
    }

    // Run per-row postprocess (bg-removal/crop/resize/optimize/trim) directly —
    // the DOM path's tab handler does this; the direct path does it here.
    // BGR-017 fix: prefer the per-call override (concurrent batch safety);
    // fall back to the global for backwards compatibility.
    const pp = (ctxOverrides && ctxOverrides.rowPostprocess) || (window.state && window.state._batchRowPostprocess) || null;
    // H-056: a postprocess op the ROW explicitly requested (crop/resize/
    // optimize/remove-bg/upscale/trim) is a required part of the deliverable —
    // its failure must not be reduced to a toast while the run reports full
    // success (the caller's auto-remove would then delete the queue row).
    // Collected errors are returned as status:'partial' + postprocessErrors.
    let ppErrors = [];
    if (pp && outFiles.length > 0 && window.BatchPostprocess && typeof window.BatchPostprocess.runRowPostprocess === 'function') {
      try {
        const result = await window.BatchPostprocess.runRowPostprocess(outFiles, pp);
        // The postprocess writes NEW files (e.g. _nobg.png, _crop.png) rather
        // than modifying in place. Those are the real deliverables — replace
        // outFiles with them so the pipeline enqueue + returned outFile below
        // reflect the post-processed result, not the raw generation.
        if (result.outputs && result.outputs.length) {
          outFiles = result.outputs.slice();
        }
        // BGR-016 fix: surface partial-failure errors instead of swallowing
        // them silently. The user needs to know when a postprocess op failed.
        if (result.errors && result.errors.length > 0) {
          ppErrors = result.errors.slice(); // H-056: propagate to the return value
          const errMsg = result.errors.join('; ');
          if (typeof toast === 'function') toast('Post-process partial failure: ' + errMsg, 'warn', 6000);
          if (typeof window.logWarn === 'function') window.logWarn('batch-direct', 'postprocess-partial', { errors: result.errors });
        }
      } catch (e) {
        // H-056: a throwing postprocess runner is just as much a failed
        // requested step as a per-op error — report it, don't swallow it.
        ppErrors.push('postprocess runner threw: ' + (e && e.message || e));
        if (typeof toast === 'function') toast('Post-process failed: ' + (e && e.message || e), 'warn', 5000);
      }
    }

    // Optional pipeline enqueue (mirrors the tab handler's enqueue logic).
    // BGR-017 fix: prefer the per-call override (concurrent batch safety).
    const pipelineEnabled = (ctxOverrides && ctxOverrides.autoPipelineEnabled != null) ? ctxOverrides.autoPipelineEnabled : st.autoPipelineEnabled;
    if (pipelineEnabled && outFiles.length > 0 && window.Pipeline && typeof window.Pipeline.enqueueFromPaths === 'function') {
      try {
        await window.Pipeline.enqueueFromPaths(outFiles, { settings: pp || {} });
      } catch (e) { /* best-effort */ }
    }

    // Refresh the file browser so the new file shows up (mirrors refreshBrowser
    // in the tab handler's success path).
    if (typeof window.refreshBrowser === 'function') {
      try { await window.refreshBrowser(); } catch (_) {}
    }

    // R9: generation succeeded but if we could not discover any output files
    // (grant denied / fbList failed / empty listing for the n>1 case), do not
    // report a deliverable-less success — the batch would log "✓ OK" with
    // nothing on disk to show for it.
    if (!outFiles.length && !outFile) {
      return { ok: false, outFile: null, error: 'Generation succeeded but output files could not be discovered.' };
    }
    // H-056: generation delivered files but a row-requested postprocess step
    // failed. ok stays true (the raw / last-successful deliverable exists on
    // disk — guaranteed by the BGR-024/R6.3 outputs contract), but the result
    // is a PARTIAL success: the caller must not auto-remove the queue row and
    // history must record the failed step so the user can repair + re-run.
    if (ppErrors.length) {
      return { ok: true, status: 'partial', postprocessErrors: ppErrors, outFile: outFiles[0] || outFile, error: null };
    }
    return { ok: true, outFile: outFiles[0] || outFile, error: null };
  }

  // R6.2: expose the runSubdir mint + mkdir helpers so the test suite (and
  // future consumers like the per-item run loop in batchManager.js) can
  // mint their own run workspaces without reaching into private state.
  window.BatchDirectRunner = {
    runVariantDirect,
    makeCtx,
    mintRunSubdir,
    ensureRunSubdir,
  };
})();
