// renderer/tabs/batchManager.js
// BatchGen management: openBatchManager(tabKey) shows the per-tab batch
// queue editor; startBatchGen(tabKey) runs the generation loop.
// Wired by app.js init() + Ctrl+B shortcut.

// reconstructParamStr is defined in batchImportHelper.js (loaded first)
// and read via window.BatchManager below — NOT re-declared here.

// Per-tab abort flags (keyed by tabKey so each tab's Stop button only
// affects its own run — a single shared flag would abort both tabs).
window._batchAbortByTab = window._batchAbortByTab || {};

// Per-tab "is anything running?" gate: OR of JobRunner.isTabRunning(tabKey)
// and the legacy state.generating === tabKey signal.
function _isTabRunningNow(tabKey) {
  if (window.JobRunner && typeof window.JobRunner.isTabRunning === 'function'
      && window.JobRunner.isTabRunning(tabKey)) {
    return true;
  }
  return !!(window.state && window.state.generating === tabKey);
}
function openBatchManager(tabKey) {
  const tabName = tabKey.charAt(0).toUpperCase() + tabKey.slice(1);
  const current = (state.batches[tabKey] || []).slice();
  // Resolve the helpers defensively — the editor's <script> tag (this
  // file) is loaded AFTER batchImportHelper, but tests and bundling
  // reshuffles can break that ordering, and a missing helper here would
  // mean every imported batch entry stringified to "[object Object]".
  const getEntryText = (window.BatchManager && window.BatchManager.batchEntryText)
    || ((e) => (typeof e === 'string' ? e : ''));
  const setEntryText = (window.BatchManager && window.BatchManager.withBatchEntryText)
    || ((e, t) => (typeof e === 'string' ? String(t || '') : ''));
  showModal((m, close) => {
    m.appendChild(el('h2', {}, `BatchGen — ${tabName} Tab`));
    m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
      `Enter up to 100 prompts/texts. They will be generated one after another with the tab's current options + the selected style preset. "Start Batch" runs them sequentially in the tab.${tabName === 'Video' ? ' Note: video generations are subject to plan quota limits — check the quota indicator in the top bar for your current allowance.' : ''}`));

    // List of textareas
    const list = el('div', { class: 'batch-list' });
    function renderList() {
      list.innerHTML = '';
      if (!current.length) {
        list.appendChild(el('div', { class: 'batch-empty' }, 'No prompts yet. Click "+ Add prompt" below to add the first one.'));
        return;
      }
      current.forEach((entry, i) => {
        const isObj = entry && typeof entry === 'object';
        const entryWrap = el('div', { class: 'batch-entry' });
        const row = el('div', { class: 'batch-row' });
        const num = el('div', { class: 'batch-num' }, String(i + 1));
        // Extract text from either shape (string or {prompt, params...});
        // seeding the textarea with the raw entry would render object
        // entries as "[object Object]".
        const ta = el('textarea', {}, getEntryText(entry));
        ta.placeholder = tabKey === 'speech' ? 'Text to read…' : 'Prompt for asset…';
        const up = el('button', { class: 'btn-mini', title: 'Move up', onclick: () => { if (i > 0) { [current[i-1], current[i]] = [current[i], current[i-1]]; renderList(); } } }, '↑');
        const down = el('button', { class: 'btn-mini', title: 'Move down', onclick: () => { if (i < current.length-1) { [current[i+1], current[i]] = [current[i], current[i+1]]; renderList(); } } }, '↓');
        const del = el('button', { class: 'btn-mini danger', title: 'Remove', onclick: () => { current.splice(i, 1); renderList(); } }, '✕');
        row.append(num, ta, up, down, del);
        entryWrap.appendChild(row);

        // Per-entry parameters editor + live defective check. Object
        // entries (imported rows, or "+ Add" snapshots) carry CLI-style
        // flags; they are surfaced as an editable field so a defective
        // entry can be REPAIRED right here.
        // Pure string entries have no params and stay simple.
        let reasonsEl = null;
        let paramsInp = null;
        const refreshDefective = () => {
          const cur = current[i];
          const def = cur && typeof cur === 'object' && Array.isArray(cur._defective) ? cur._defective : null;
          if (def && def.length) { entryWrap.classList.add('batch-entry-defective'); if (reasonsEl) reasonsEl.textContent = '⚠ ' + def.join('  •  '); }
          else { entryWrap.classList.remove('batch-entry-defective'); if (reasonsEl) reasonsEl.textContent = ''; }
        };
        const revalidate = () => {
          if (!paramsInp) return;
          const parse = (window.BatchManager && window.BatchManager.parseParams) || (() => ({}));
          const make = (window.BatchManager && window.BatchManager.buildImportedEntry) || ((t, p, pr) => ({ prompt: p, ...pr }));
          const np = parse(paramsInp.value);
          current[i] = make(tabKey, getEntryText(current[i]), np);
          refreshDefective();
        };
        ta.addEventListener('input', () => {
          current[i] = setEntryText(current[i], ta.value);
          revalidate();
        });
        if (isObj) {
          paramsInp = el('input', {
            type: 'text', class: 'batch-params-input',
            value: ((window.BatchManager && window.BatchManager.reconstructParamStr) || (() => ''))(entry),
            placeholder: '--model … --bitrate … (CLI-style flags)',
            title: 'Per-entry parameters. Edit these to repair a defective entry; valid values clear the ⚠ flag.',
          });
          paramsInp.addEventListener('input', revalidate);
          reasonsEl = el('div', { class: 'batch-defective-reasons' });
          entryWrap.appendChild(paramsInp);
          entryWrap.appendChild(reasonsEl);
        }
        refreshDefective();
        list.appendChild(entryWrap);
      });
    }
    renderList();
    m.appendChild(list);

    // Add / Clear / Paste-many controls
    const ctrls = el('div', { class: 'row', style: 'margin-top: 8px; flex-direction: row; gap: 6px; align-items: center;' });
    const addBtn = el('button', { class: 'btn-mini', onclick: () => { if (current.length >= 100) { toast('Max 100 entries.', 'warn'); return; } current.push(''); renderList(); setTimeout(() => { const ta = list.querySelectorAll('textarea'); ta[ta.length-1]?.focus(); }, 0); } }, '+ Add prompt');
    const clearBtn = el('button', { class: 'btn-mini', onclick: async () => { if (current.length && !await asyncConfirm('Clear all ' + current.length + ' entries?')) return; current.length = 0; renderList(); } }, 'Clear all');
    const pasteBtn = el('button', { class: 'btn-mini', onclick: () => {
      const ta = el('textarea', { placeholder: 'Paste one prompt per line, then click Import.' });
      const dialog = showModal((dm, dclose) => {
        dm.appendChild(el('h2', {}, 'Bulk import'));
        dm.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px;' }, 'One prompt per line. Empty lines are ignored.'));
        dm.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Prompts'), ta]));
        const ok = el('button', { class: 'primary' }, 'Import');
        const cancel = el('button', { onclick: dclose }, 'Cancel');
        dm.appendChild(el('div', { class: 'footer' }, [cancel, ok]));
        ok.addEventListener('click', async () => {
          const lines = ta.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          const room = 100 - current.length;
          const toAdd = lines.slice(0, room);
          for (const l of toAdd) current.push(l);
          dclose();
          renderList();
          if (lines.length > room) toast(`Imported ${room} (skipped ${lines.length - room} to stay under 100).`, 'warn');
          else toast(`Imported ${toAdd.length} prompts.`, 'ok');
        });
      });
    } }, 'Bulk paste…');
    ctrls.append(addBtn, pasteBtn, clearBtn);
    m.appendChild(ctrls);

    // Save / Close
    const save = el('button', { class: 'primary' }, `Save (${current.length})`);
    const closeBtn = el('button', { onclick: close }, 'Close');
    save.addEventListener('click', async () => {
      // Trim + filter empties via the shape-aware helpers so a snapshot
      // entry keeps its params after the user edits the prompt. A plain
      // `String(s)` on an object would lose all the per-entry settings
      // the BatchGen runner reads at run time.
      const cleaned = current
        .map((e) => setEntryText(e, getEntryText(e).trim()))
        .filter((e) => getEntryText(e).length > 0)
        .slice(0, 100);
      if (cleaned.length === 0) {
        if (!await asyncConfirm('Save an EMPTY batch (this removes the Start Batch button)?')) return;
      }
      const next = { ...state.batches, [tabKey]: cleaned };
      const r = await window.api.batchesSet(next);
      if (!r.ok) { toast('Save failed: ' + r.error, 'err'); return; }
      state.batches = { ...state.batches, [tabKey]: cleaned };
      toast(`Saved ${cleaned.length} prompt${cleaned.length === 1 ? '' : 's'} for ${tabName}.`, 'ok');
      _refreshBatchButtons();
      close();
    });
    m.appendChild(el('div', { class: 'footer' }, [closeBtn, save]));
  });
}

// R6.5 / T6: expected paid units for a queue (each variant = 1 API call;
// defective entries are skipped). P4.3 (DB-H-003): for image, --n multiplies
// the billable images per call — pass { callsOnly: true } for the raw call
// count. Shared by startBatchGen's own confirm below and the combined
// all-types confirmation in batchImportHelper.js.
function computeExpectedCalls(tabKey, items, opts) {
  const _vr = $(`#tab-${tabKey}`) && $(`#tab-${tabKey}`).querySelector('.variants-select');
  const _dv = _vr ? Math.max(1, Math.min(5, parseInt(_vr.value, 10) || 1)) : 1;
  return (items || []).reduce((s, it) => {
    if (it && typeof it === 'object' && Array.isArray(it._defective) && it._defective.length) return s;
    const v = (it && typeof it === 'object') ? (it.variants || it['--variants']) : undefined;
    const calls = v !== undefined ? Math.max(1, Math.min(5, parseInt(v, 10) || 1)) : _dv;
    const nRaw = (it && typeof it === 'object') ? (it.n || it['--n'] || (it.params && it.params.n)) : undefined;
    const n = (tabKey === 'image' && !(opts && opts.callsOnly) && nRaw !== undefined) ? Math.max(1, Math.min(9, parseInt(nRaw, 10) || 1)) : 1;
    return s + calls * n;
  }, 0);
}

// opts (all optional — the per-tab ▶ button passes none):
//   skipConfirm      — true when startAllBatchGen already showed the ONE
//                      combined cost confirmation covering all types, so
//                      the run is never interrupted by another prompt.
//   outputDirBase    — base output folder chosen in the combined confirm
//                      overlay (overrides state.fbDir / config.output_dir).
//   noTypeSubfolders — true disables the per-asset-type subfolder routing
//                      (default: generations go to <base>\<tabKey>).
async function startBatchGen(tabKey, opts) {
  opts = opts || {};
  const items = (state.batches[tabKey] || []).slice();
  if (!items.length) { toast('Batch is empty.', 'warn'); return; }
  if (!state.config.hasApiKey) { toast('No API key configured. Click ⚙ to open Settings.', 'err'); return; }
  // H9-016: per-queue run lock. Two concurrent starts for the same queue would
  // race queue mutation + duplicate work. The parent job deliberately carries
  // no tabKey (so JobRunner's per-tab gate doesn't block it), so without this
  // guard nothing mutual-excludes at the entry point.
  window._batchRunningByTab = window._batchRunningByTab || {};
  if (window._batchRunningByTab[tabKey]) {
    toast(`A ${tabKey} batch is already running. Stop it first.`, 'warn', 4000);
    return;
  }
  if (!opts.skipConfirm && tabKey === 'video' && items.length > 3) {
    if (!await asyncConfirm(`This batch has ${items.length} videos. Your Token Plan includes only 3 free video generations per week — the rest will fail with a quota error. Continue?`)) return;
  }
  // R6.5/P4.3 (DB-H-003): expected cost — units = calls × image --n; the hard max-units gate applies even with skipConfirm (config.txt batch_max_units).
  const expectedCalls = computeExpectedCalls(tabKey, items, { callsOnly: true });
  const expectedUnits = computeExpectedCalls(tabKey, items);
  const maxUnits = Math.max(1, parseInt(state.config && state.config.batch_max_units, 10) || 200);
  if (expectedUnits > maxUnits) { toast(`Batch would generate ${expectedUnits} unit(s) — over the ${maxUnits}-unit limit (batch_max_units in config.txt). Trim the queue or raise the limit.`, 'err', 8000); return; }
  const costMsg = expectedUnits > expectedCalls ? `Batch: ${items.length} item(s) → this will generate up to ${expectedUnits} images (${expectedCalls} paid API call(s)). Continue?` : `Batch: ${items.length} item(s) → ${expectedCalls} paid API call(s). Continue?`;
  if (!opts.skipConfirm && expectedCalls > 1 && !await asyncConfirm(costMsg)) return;

  window._batchAbortByTab[tabKey] = false;
  window._batchRunningByTab[tabKey] = true;
  // Successful items are removed from state.batches[tabKey] as they finish
  // unless ⚙ Settings → BatchGen "Keep completed items in list" disables it;
  // failed items are NEVER auto-removed — retry/skip is a manual decision.
  const autoRemove = state.batchesAutoRemove !== false;
  const tabName = tabKey.charAt(0).toUpperCase() + tabKey.slice(1);
  // Represent the WHOLE batch as one parent JobRunner job (single
  // ActiveJobsWidget row + progress bar) and feed JobSummary.emit() at the
  // end. tabKey: null is deliberate: each ITEM's own genBtn.click() calls
  // JobRunner.run({tabKey}) for the SAME tab (via the migrated tab
  // handlers) — if the parent occupied that tab's "wip" slot every child
  // item would immediately self-reject. The parent is tracked (visible,
  // progress bar, cancellable) without joining the per-tab mutual
  // exclusion that only makes sense between actual generation attempts.
  const batchResults = [];
  let batchCtrl;
  batchCtrl = window.JobRunner.run({
    tabKey: null,
    type: tabKey,
    title: `Batch: ${tabName} (${items.length} item${items.length === 1 ? '' : 's'})`,
    subtitle: '',
    typeIcon: '∑',
    runFn: async (ctx) => {
      // External cancellation (ActiveJobsWidget ✕ on the parent row)
      // must behave exactly like clicking "■ Stop batch" in the
      // overlay — flip the per-tab flag AND kill the active child mmx
      // job (R5 M4: the flag alone only stops the loop BETWEEN items, so
      // the running item's generation would otherwise finish first).
      ctx.signal.addEventListener('abort', () => { window._batchAbortByTab[tabKey] = true; if (window.JobRunner && window.JobRunner.jobsForTab) for (const j of window.JobRunner.jobsForTab(tabKey)) if (j && j.status === 'wip') window.JobRunner.cancel(j.id); });
  const tabRoot = $(`#tab-${tabKey}`);
  const promptTa = tabRoot.querySelector('textarea');        // first textarea = main prompt
  const styleSel = tabRoot.querySelector('.row select');      // first select = style preset
  // BUG #5 fix: scope to `.actions` — in DOM-fallback mode the
  // unscoped 'button.primary' grabs the FIRST primary button in the
  // tab, which on imageTab is the stale Retry button inside .preview
  // (.preview precedes .actions in DOM order). Benign today only
  // because Retry forwards to Generate via its closure.
  const genBtn = tabRoot.querySelector('.actions button.primary');
  const preview = tabRoot.querySelector('.preview');
  if (!promptTa || !genBtn) { toast('Could not locate tab controls.', 'err'); window._batchRunningByTab[tabKey] = false; return { status: 'err', error: 'Could not locate tab controls.' }; } // R8: release the run lock (set before run()) — this return precedes the try/finally that normally releases it, else the tab is "already running" forever
  // Guard preview — it CAN be null in edge cases (e.g. a future tab
  // layout that omits .preview, or a DOM mutation race). Dereferencing
  // preview.parentNode unconditionally would throw outside the try block
  // and reject runFn directly. Fall back to a no-op stub so the rest of
  // the batch still runs even when the per-tab preview is missing.
  const previewEl = preview || { parentNode: null, innerHTML: '' };

  // Save current state
  const savedPrompt = promptTa.value;
  const savedStyle = styleSel ? styleSel.value : '';
  const variantsSel = tabRoot.querySelector('.variants-select');
  const savedVariants = variantsSel ? variantsSel.value : '1';
  const variantsCount = Math.max(1, Math.min(5, parseInt(savedVariants, 10) || 1));
  // H9-004: BatchGen owns variant expansion (it loops currentVariantsCount times
  // below, clicking Generate once per variant). If the tab's own variants
  // selector is left at the user's value, EACH click ALSO multiplies — so
  // imported variants=4 with a tab value of 4 produced up to 16 calls/outputs.
  // Force the tab selector to 1 for the whole run; the original value is
  // restored in the finally block below.
  if (variantsSel) {
    variantsSel.value = '1';
    variantsSel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const savedUpscaleEnabled = state.upscaleEnabled;
  const savedUpscaleSettings = state.upscaleSettings ? { ...state.upscaleSettings } : null;

  // Show progress overlay
  const overlay = el('div', { class: 'batch-overlay' });
  overlay.appendChild(el('div', { class: 'batch-overlay-title' }, `BatchGen — ${tabName}`));
  const counter = el('div', { class: 'batch-overlay-counter' }, `0 / ${items.length}`);
  const _bar = (window.Spinner && window.Spinner.determinateBar) ? window.Spinner.determinateBar(0) : null; // H11-1C: i/total bar
  const currentPrompt = el('div', { class: 'batch-overlay-prompt' }, '');
  const elapsed = el('div', { class: 'batch-overlay-elapsed' }, '');
  const log = el('div', { class: 'batch-overlay-log' });
  const stopBtn = el('button', { class: 'danger' }, '■ Stop batch');
  // R5 (H1): named handler so finally can removeEventListener it before repurposing to "Close" (a stale listener fired global mmxCancel on every Close click).
  const onStopClick = () => {
    window._batchAbortByTab[tabKey] = true;
    // H9-016: cancel the ACTIVE CHILD mmx job (the parent runFn only polls the abort flag BETWEEN items). R5 (M1): target ONLY this tab's wip child via JobRunner — the old global mmxCancel() killed every in-flight generation on every tab.
    if (window.JobRunner && window.JobRunner.jobsForTab) for (const j of window.JobRunner.jobsForTab(tabKey)) if (j && j.status === 'wip') window.JobRunner.cancel(j.id);
    // Also route through the parent job's cancel() so JobRunner marks it 'cancel' (the flag alone leaves ac.signal un-aborted → false "ok").
    if (batchCtrl && typeof batchCtrl.cancel === 'function') batchCtrl.cancel();
    stopBtn.disabled = true;
    stopBtn.textContent = 'Stopping…';
  };
  stopBtn.addEventListener('click', onStopClick);
  overlay.append(counter, _bar ? _bar.bar : null, currentPrompt, elapsed, log, stopBtn);
  // The overlay is a SIBLING of .preview (same parent, .tab-footer for
  // every tab), not a child of .preview. The tab's own generate handler
  // writes its per-variant status text via `preview.innerHTML = '<spinner...>'`
  // during generation, which replaces ALL of .preview's children — a
  // child overlay (and its "■ Stop batch" button) would be wiped out of
  // the DOM within the first item's generation. As a sibling, the tab's
  // own preview updates can never touch it.
  // Only insert when preview.parentNode exists; a null preview (e.g. a
  // future tab layout without .preview) would otherwise throw outside
  // the try block.
  if (previewEl.parentNode) {
    previewEl.parentNode.insertBefore(overlay, previewEl);
  } else {
    // Fallback: append the overlay to the tab root so the batch
    // progress + Stop button remain visible.
    try { tabRoot.appendChild(overlay); } catch (_) { /* best-effort */ }
  }
  const t0 = Date.now();
  const updateElapsed = () => { const s = Math.round((Date.now() - t0) / 1000); elapsed.textContent = `Elapsed: ${Math.floor(s / 60)}m ${s % 60}s`; };
  const elapsedTimer = setInterval(updateElapsed, 1000);
  updateElapsed();

  function logLine(s, kind) {
    const e = el('div', { class: 'batch-log-line ' + (kind || '') }, s);
    log.appendChild(e);
    log.scrollTop = log.scrollHeight;
  }

  let ok = 0, fail = 0, partial = 0, skipped = 0;
  let batchError = null;
  // Seed the per-tab "batch queue left" counter so the per-tab ETA
  // timer (section10) can include the remaining
  // batch items in its total estimate. Reset on entry; we
  // decrement on every completed / failed item. The "all types"
  // ETA span (in app.js) reads the sum across tabs.
  if (!state.batchQueueLeft) state.batchQueueLeft = { image: 0, speech: 0, music: 0, video: 0 };
  state.batchQueueLeft[tabKey] = items.length;
  // Track which (original-snapshot) indices completed successfully so
  // auto-remove can rebuild the queue from the immutable `items`
  // snapshot. Removing by live index while iterating shifts every
  // later index by one, so only the FIRST successful item would ever
  // be removed.
  const removedIdx = new Set();
  // R6.5: snapshot generation settings at batch start (mid-batch UI changes
  // must not affect subsequent items).
  // T3/T4: the combined all-types confirm can override the base output
  // folder; per-asset-type subfolders (<base>\<tabKey>) are the default
  // and can be opted out via the overlay checkbox.
  const baseOutputDir = (opts.outputDirBase || state.fbDir || (state.config && state.config.output_dir) || '').replace(/[\\/]+$/, '');
  const batchSnapshot = {
    outputDir: baseOutputDir,
    styles: (state.config && state.config.styles) ? state.config.styles.slice() : [],
  };
  // B.1: mint a batch-owned directory-root grant so pure-batch flows
  // (no prior interactive Generate → state._fbGrantId is undefined) still
  // authorise fb:ensureDir + mmx:run:job writes. Same pattern as
  // ensureSubDir (app.js R7.5) but scoped to the batch lifetime.
  // BGR-023 fix: ALWAYS mint a fresh batch grant. The stale state._fbGrantId
  // may not cover the batch outputDir (e.g. user changed output folder
  // between interactive generate and batch run).
  let batchGrantId = null;
  try {
  if (window.api && window.api.mintGrant && window.GrantCache) {
    const grantRoot = (batchSnapshot.outputDir || '').replace(/[\\/]+$/, '');
    if (grantRoot) {
      const g = await window.GrantCache.ensurePathGrant(grantRoot, 'mkdir', {
        kind: 'directory', capabilities: ['mkdir', 'write'], coversRoot: true,
      });
      if (g && g.ok === false) {
        if (typeof toast === 'function') toast('Batch grant failed: ' + (g.error || 'mint failed'), 'err', 6000);
        logLine('✗ Batch aborted — output grant could not be minted: ' + (g.error || 'unknown'), 'err');
        // R7: throw (not a bare return) so the cleanup finally runs and JobRunner records 'err' — a bare return leaked the run lock/timer and marked the job 'ok'.
        throw new Error('Output grant could not be minted: ' + (g.error || 'unknown'));
      }
      batchGrantId = g;
    }
  }
  // T4: route this type's generations into <base>\<tabKey> unless opted
  // out. fb:ensureDir has mkdir-p semantics, so a missing subfolder is
  // created on demand; the grant minted above covers the base root
  // (coversRoot: true), so the subdir write is authorised. Any failure
  // falls back to the base folder — a missing subfolder must not kill an
  // overnight run. Direct mode only: the DOM-fallback path never reads
  // batchSnapshot.outputDir (each tab handler resolves its own output
  // folder), so creating the subfolder there would only leave an empty
  // folder behind while the assets land elsewhere.
  if (!opts.noTypeSubfolders && baseOutputDir && state.batchDirectMode !== false && window.BatchDirectRunner
      && window.api && typeof window.api.fbEnsureDir === 'function') {
    const sep = (baseOutputDir.includes('/') && !baseOutputDir.includes('\\')) ? '/' : '\\';
    const typeDir = baseOutputDir + sep + tabKey;
    try {
      const er = await window.api.fbEnsureDir(typeDir, batchGrantId);
      if (er && er.ok) batchSnapshot.outputDir = er.path || typeDir;
      else logLine(`⚠ Could not create subfolder "${tabKey}" (${(er && er.error) || 'unknown'}) — saving to ${baseOutputDir}`, 'warn');
    } catch (e) {
      logLine(`⚠ Could not create subfolder "${tabKey}" (${e && e.message || e}) — saving to ${baseOutputDir}`, 'warn');
    }
  }
    for (let i = 0; i < items.length && !window._batchAbortByTab[tabKey]; i++) {
      const item = items[i];
      const isObj = typeof item === 'object';
      const itemPrompt = isObj ? (item.prompt || item.text || '') : item;

      counter.textContent = `${i + 1} / ${items.length}`;
      if (_bar) _bar.set(items.length ? ((i) / items.length) * 100 : 0);
      ctx.onProgress(i + 1, items.length);
      currentPrompt.textContent = itemPrompt.slice(0, 200) + (itemPrompt.length > 200 ? '…' : '');

      // Skip entries marked defective (failed the parameter check on
      // import or in the editor). They stay in the queue — never
      // auto-removed — so they can be repaired in the editor (✎) and
      // re-run. Sending them would just burn a request on a guaranteed
      // API rejection.
      if (isObj && Array.isArray(item._defective) && item._defective.length) {
        skipped++;
        logLine(`⚠ ${i + 1}/${items.length} skipped — defective: ${item._defective[0]}`, 'warn');
        continue;
      }

      // Update the "items left" counter for the per-tab ETA.
      // R9: after the defective-skip so skipped (defective) entries don't inflate the ETA.
      if (state.batchQueueLeft) state.batchQueueLeft[tabKey] = Math.max(0, items.length - i - 1);

      let currentVariantsCount = variantsCount;
      if (isObj) {
        const vVal = item.variants || item['--variants'];
        if (vVal !== undefined) {
          currentVariantsCount = Math.max(1, Math.min(5, parseInt(vVal, 10) || 1));
        }
      }

      // Temporarily apply parameters for this item
      const modifiedFields = {};
      if (isObj) {
        const tabFields = getTabInputs(tabKey);
        for (const [key, val] of Object.entries(item)) {
          if (key === 'prompt' || key === 'text') continue;
          const cleanKey = key.replace(/^--/, '').toLowerCase();
          
          if (cleanKey === 'upscale' || cleanKey === 'upscale-enabled') {
            modifiedFields['upscale'] = state.upscaleEnabled;
            const isTrue = String(val).toLowerCase() === 'true' || String(val).toLowerCase() === 'on' || val === true;
            state.upscaleEnabled = isTrue;
            const upscaleCb = tabRoot.querySelector('.upscale-checkbox input');
            if (upscaleCb) upscaleCb.checked = isTrue;
            continue;
          }
          if (cleanKey === 'upscale-multiplier' || cleanKey === 'scale') {
            modifiedFields['upscale-settings'] = state.upscaleSettings ? { ...state.upscaleSettings } : null;
            const num = parseInt(val, 10);
            if (num === 2 || num === 4) {
              state.upscaleSettings = state.upscaleSettings || {};
              state.upscaleSettings.multiplier = num;
              const multSpan = tabRoot.querySelector('.upscale-mult');
              if (multSpan) multSpan.textContent = `(${num}x)`;
            }
            continue;
          }
          if (cleanKey === 'style') {
            if (styleSel) {
              modifiedFields['style'] = styleSel.value;
              styleSel.value = String(val);
              styleSel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            continue;
          }

          const input = tabFields[cleanKey];
          if (input) {
            modifiedFields[cleanKey] = getTabInputValue(input);
            setTabInputValue(input, val);
          }
        }
      }

      const originalAutoPipeline = state.autoPipelineEnabled;
      // BGR-011 fix: accept all common spellings of the send-to-pipeline flag.
      if ([item.sendToPipeline, item.sendtopipeline, item['send-to-pipeline'], item.pipeline].some((v) => v != null && v !== false && v !== '' && v !== 'false' && v !== '0' && v !== 0)) state.autoPipelineEnabled = true; // R10: the string "false"/"0" is truthy to || — treat explicit falsy spellings as off

      // H9-013: per-row output-name prefix. The prefix is a global setting
      // (state.filePrefix); for the batch we save the current value, apply the
      // row's prefix for this item only, and restore it in the per-item finally
      // below — same pattern as the upscale save/restore.
      const originalFilePrefix = state.filePrefix;
      let rowPrefix = null;
      if (isObj) {
        rowPrefix = item['output-name'] || item['--output-name'] || item['output-prefix'] || item['--output-prefix'] || item['file-prefix'] || item['--file-prefix'];
        if (rowPrefix != null) {
          state.filePrefix = String(rowPrefix);
          modifiedFields['file-prefix'] = originalFilePrefix;
        }
      }
      // H9-018 / H9-005: capture deterministic postprocess flags for this row so
      // they run as a post-step after the variant loop (handled below). These
      // don't mutate global state up front — they're applied to each output.
      // X3-01: upscale is routed through rowPostprocess ONLY in direct mode —
      // the DOM-fallback path already upscales via state.upscaleEnabled, so
      // adding it here too would upscale twice.
      const directMode = state.batchDirectMode !== false;
      const rowPostprocess = {
        crop: isObj ? (item.crop || item['--crop']) : null,
        resize: isObj ? (item.resize || item['--resize']) : null,
        optimizeFormat: isObj ? (item['optimize-format'] || item['--optimize-format']) : null,
        optimizeQuality: isObj ? (item['optimize-quality'] != null ? item['optimize-quality'] : item['--optimize-quality']) : null, // R8: != null so an explicit 0 isn't dropped by || (matches the trim/strip-metadata pattern; downstream still defaults a degenerate 0 to 82)
        stripMetadata: isObj ? (item['strip-metadata'] != null ? item['strip-metadata'] : item['--strip-metadata']) : null,
        removeBackground: isObj ? (item['remove-background'] || item['--remove-background']) : null,
        removeBackgroundModel: isObj ? (item['remove-background-model'] || item['--remove-background-model']) : null,
        // gewv2 GEW-011 fix: honor a per-row/imported GPU choice for
        // remove-bg instead of the runner hardcoding useGpu:false.
        removeBackgroundUseGpu: isObj ? (item['remove-background-use-gpu'] != null ? item['remove-background-use-gpu'] : item['--remove-background-use-gpu']) : null,
        // X3-01: upscale (direct-mode only — see directMode note above).
        upscale: (isObj && directMode) ? (item.upscale || item['--upscale'] || item['upscale-enabled'] || item['--upscale-enabled']) : null,
        upscaleMultiplier: (isObj && directMode) ? (item['upscale-multiplier'] || item['--upscale-multiplier'] || item.scale || item['--scale']) : null,
        // gewv2 GEW-009 fix: allow the import file / row to pick the
        // Real-ESRGAN model instead of the runner always using the
        // anime/video-frame model regardless of content type.
        upscaleModel: (isObj && directMode) ? (item['upscale-model'] || item['--upscale-model']) : null,
        trimStart: isObj ? (item['trim-start'] != null ? item['trim-start'] : item['--trim-start']) : null, // R7: != null so a legit 0 isn't dropped by ||
        trimEnd: isObj ? (item['trim-end'] != null ? item['trim-end'] : item['--trim-end']) : null,
      };
      void rowPostprocess; // applied in the success path after the variant loop
      // H9-005/018: expose the per-row postprocess flags to the gen handler
      // (imageTab/speechTab/musicTab read state._batchRowPostprocess after a
      // successful generation and run the deterministic ops on the output files).
      if (!(directMode && window.BatchDirectRunner)) state._batchRowPostprocess = rowPostprocess; // R8: direct mode passes rowPostprocess via overrides — setting the global here would leak this batch's trim/postprocess into a concurrent MANUAL gen on another tab (the gen handlers read it unconditionally)

      // Set the prompt + fire input event so the style preview updates.
      // The global state-save (scheduled by the input event) is
      // suppressed so a batch item doesn't overwrite the saved prompt.
      suppressStateSave(() => {
        promptTa.value = itemPrompt;
        promptTa.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // Run N variants for this batch item.
      // H9-017: wrap the variant loop + per-item field restore in a per-item
      // try/finally so a throw inside the variant loop still restores the
      // modifiedFields + autoPipeline toggle (the previous single try/catch
      // around the whole batch bypassed per-item restore on throw).
      // H9-017: auto-remove only fires when EVERY variant succeeded — the
      // previous code removed after the LAST variant if it alone succeeded,
      // silently dropping earlier failed variants.
      let itemAllVariantsOk = true;
      try {
      for (let vi = 0; vi < currentVariantsCount; vi++) {
        if (window._batchAbortByTab[tabKey]) break;
        // Wait until no other generation is in progress for THIS tab.
        // _isTabRunningNow(tabKey) is used (not the `state.generating`
        // single-slot check) so a parallel job on a different tab
        // doesn't block the batch.
        while (_isTabRunningNow(tabKey)) {
          if (window._batchAbortByTab[tabKey]) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        if (window._batchAbortByTab[tabKey]) break;
        // H11-3: direct (snapshot) mode — build argv from row params, call mmxRunJob
        // directly. No DOM mutation, no genBtn.click(). Eliminates the inheritance
        // bug. Falls back to the DOM path when state.batchDirectMode === false.
        if (state.batchDirectMode !== false && window.BatchDirectRunner) {
          const d = await window.BatchDirectRunner.runVariantDirect(tabKey, item, {
            filePrefix: state.filePrefix, filePrefixForceOnly: state.filePrefixForceOnly,
            outputDir: batchSnapshot.outputDir, styles: batchSnapshot.styles, // R6.5
            grantId: batchGrantId, // B.1: batch-owned grant for pure-batch flows
            // BGR-017 fix: pass per-row postprocess + pipeline flag via overrides
            // instead of relying on mutable globals (concurrent batch safety).
            rowPostprocess: rowPostprocess,
            autoPipelineEnabled: state.autoPipelineEnabled,
          });
          const vt = currentVariantsCount > 1 ? ` v${vi + 1}/${currentVariantsCount}` : '';
          if (d.ok) {
            // H-056: status 'partial' = generated but a row-REQUESTED postprocess
            // op failed. The raw deliverable is kept on disk, but the item must
            // NOT count as a full success: itemAllVariantsOk stays false so the
            // auto-remove below never deletes the queue row, and the history/
            // summary records 'partial' so the failure is visible afterwards.
            const ppFailed = d.status === 'partial' && Array.isArray(d.postprocessErrors) && d.postprocessErrors.length > 0;
            if (ppFailed) {
              itemAllVariantsOk = false; partial++;
              logLine(`⚠ ${i + 1}/${items.length}${vt} partial — generated, but postprocess failed: ${d.postprocessErrors[0]}`, 'warn');
              batchResults.push({ status: 'partial', error: `item ${i + 1}${vt}: postprocess failed: ${d.postprocessErrors.join('; ')}` });
            } else {
              ok++; logLine(`✓ ${i + 1}/${items.length}${vt} OK`, 'ok'); batchResults.push({ status: 'ok' });
            }
            // T5: surface the just-generated asset in the Assets preview
            // pane, exactly like an interactive Generate does. (Also for a
            // partial — a raw/last-successful deliverable exists.)
            try {
              if (d.outFile) {
                if (tabKey === 'image' && typeof window.notifyImageGenerated === 'function') window.notifyImageGenerated(d.outFile);
                else if ((tabKey === 'speech' || tabKey === 'music') && typeof window.notifyAudioGenerated === 'function') window.notifyAudioGenerated(d.outFile);
                else if (tabKey === 'video' && typeof window.previewVideoFromFile === 'function') window.previewVideoFromFile(d.outFile);
              }
            } catch (_) { /* preview is best-effort */ }
          }
          else { itemAllVariantsOk = false; fail++; logLine(`✗ ${i + 1}/${items.length}${vt} ${d.error || 'FAILED'}`, 'err'); batchResults.push({ status: 'err', error: `item ${i + 1}${vt}: ${d.error || 'failed'}` }); }
          if (autoRemove && vi === currentVariantsCount - 1 && itemAllVariantsOk) { removedIdx.add(i); state.batches[tabKey] = items.filter((_, idx) => !removedIdx.has(idx)); const _r = await window.api.batchesSet(state.batches).catch(() => null); if (!_r || !_r.ok) logLine(`⚠ ${i + 1}/${items.length} auto-remove persist failed`, 'warn'); else logLine(`✓ ${i + 1}/${items.length} removed (auto)`, 'ok'); }
          continue;
        }
        // Reset the per-tab run-outcome signal so THIS item's
        // result is read (not a stale 'ok' from the previous item). The gen
        // handlers set state.genLastResult[tabKey] = 'ok' | 'err' at the
        // end of the run; see the looksOk check below for why the preview
        // DOM can't just be scraped.
        state.genLastResult = state.genLastResult || { image: null, speech: null, music: null, video: null };
        state.genLastResult[tabKey] = null;
        // H-056 (DOM-fallback parity): reset the per-tab postprocess-error slot
        // the gen handlers fill (imageTab/speechTab/musicTab) so THIS item's
        // postprocess outcome is read, not a stale one from the previous item.
        state.genLastPostprocessErrors = state.genLastPostprocessErrors || {};
        state.genLastPostprocessErrors[tabKey] = null;
        // Trigger generation. The click handler is async — we poll
        // the per-tab running flag to detect when it has set the busy
        // signal (i.e. the handler started).
        genBtn.click();
        const startDeadline = Date.now() + 8000;
        while (!_isTabRunningNow(tabKey)) {
          if (window._batchAbortByTab[tabKey]) break;
          if (Date.now() > startDeadline) { logLine(`✗ Gen did not start for item ${i + 1}.`, 'err'); fail++; batchResults.push({ status: 'err', error: `item ${i + 1} did not start` }); break; }
          await new Promise((r) => setTimeout(r, 20));
        }
        if (window._batchAbortByTab[tabKey] || !_isTabRunningNow(tabKey)) break;
        // Wait for the generation to finish (armGenBtnWithCancel's cleanup
        // resets state.generating to null when the gen handler returns).
        while (_isTabRunningNow(tabKey)) {
          if (window._batchAbortByTab[tabKey]) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        // Determine success. PRIMARY signal: the per-tab run outcome the
        // gen handler records on state.genLastResult[tabKey]. This is
        // authoritative and decoupled from how each tab renders its
        // preview. FALLBACK (older tabs / unset): scrape the preview for
        // a media element. The image tab does not put an <img> in
        // .preview (it shows "see preview pane on the right" + renders
        // the image in the folder-explorer pane), so a DOM-only check
        // reports EVERY image batch item as failed and auto-remove never
        // fires — hence the authoritative outcome check.
        const outcome = state.genLastResult && state.genLastResult[tabKey];
        // Guard the DOM-scrape fallback for a null preview — it would
        // throw when outcome is null AND preview is null (rare, but
        // possible in a future tab layout without .preview).
        const looksOk = outcome === 'ok'
          || (outcome == null && preview && preview.querySelector('img, video, audio'));
        const variantTag = currentVariantsCount > 1 ? ` v${vi + 1}/${currentVariantsCount}` : '';
        // H-056 (DOM-fallback parity): the gen handler records the postprocess
        // errors for the row's requested ops on state.genLastPostprocessErrors.
        // A generation that succeeded but whose requested postprocess failed is
        // a PARTIAL — keep the row in the queue (no auto-remove) + record it.
        const domPpErrs = (state.genLastPostprocessErrors && state.genLastPostprocessErrors[tabKey]) || null;
        if (looksOk && Array.isArray(domPpErrs) && domPpErrs.length > 0) {
          itemAllVariantsOk = false; partial++;
          logLine(`⚠ ${i + 1}/${items.length}${variantTag} partial — generated, but postprocess failed: ${domPpErrs[0]}`, 'warn');
          batchResults.push({ status: 'partial', error: `item ${i + 1}${variantTag}: postprocess failed: ${domPpErrs.join('; ')}` });
        }
        else if (looksOk) { ok++; logLine(`✓ ${i + 1}/${items.length}${variantTag} OK`, 'ok'); batchResults.push({ status: 'ok' }); }
        else { itemAllVariantsOk = false; fail++; logLine(`✗ ${i + 1}/${items.length}${variantTag} FAILED`, 'err'); batchResults.push({ status: 'err', error: `item ${i + 1}${variantTag} failed` }); }
        // Remove successful items from state.batches[tabKey] immediately
        // (when auto-remove is on). Done after the LAST variant of the
        // current item so a multi-variant run still generates every
        // variant of the prompt before the entry is dropped.
        // H9-017: only remove when EVERY variant succeeded — the previous code
        // removed after the last variant if it alone succeeded, silently
        // dropping earlier failed variants.
        if (autoRemove && vi === currentVariantsCount - 1 && itemAllVariantsOk) {
          // Mark this snapshot index as done and rebuild the live queue
          // from the immutable `items` snapshot, dropping every
          // completed index. Rebuilding (instead of an in-place splice)
          // keeps indices stable across the rest of the loop and works
          // correctly even with duplicate prompts. Persist so a restart
          // doesn't bring the entry back.
          removedIdx.add(i);
          state.batches[tabKey] = items.filter((_, idx) => !removedIdx.has(idx));
          const _r2 = await window.api.batchesSet(state.batches).catch(() => null);
          if (!_r2 || !_r2.ok) logLine(`⚠ ${i + 1}/${items.length} auto-remove persist failed`, 'warn');
          else logLine(`✓ ${i + 1}/${items.length} removed from queue (auto-remove on)`, 'ok');
        }
      }
      } catch (itemErr) {
        // A throw in the variant loop must still restore this item's fields
        // (the per-item finally below does that) and be reported, but must
        // NOT kill the whole batch.
        itemAllVariantsOk = false;
        logLine(`⚠ Item ${i + 1} error: ${itemErr && itemErr.message || itemErr}`, 'err');
        batchResults.push({ status: 'err', error: `item ${i + 1} threw: ${itemErr && itemErr.message || itemErr}` });
        fail++;
      } finally {
      // Restore the Auto-pipeline toggle. A sendToPipeline item forces it on
      // for its own generation only; without this the batch permanently
      // flipped the user's setting (originalAutoPipeline was saved above).
      state.autoPipelineEnabled = originalAutoPipeline;

      // Restore modified fields for this item
      if (isObj) {
        const tabFields = getTabInputs(tabKey);
        for (const [cleanKey, origVal] of Object.entries(modifiedFields)) {
          if (cleanKey === 'upscale') {
            state.upscaleEnabled = origVal;
            const upscaleCb = tabRoot.querySelector('.upscale-checkbox input');
            if (upscaleCb) upscaleCb.checked = !!origVal;
          } else if (cleanKey === 'upscale-settings') {
            state.upscaleSettings = origVal;
            const multSpan = tabRoot.querySelector('.upscale-mult');
            if (multSpan) multSpan.textContent = origVal ? `(${origVal.multiplier}x)` : '';
          } else if (cleanKey === 'file-prefix') {
            // H9-013: restore the global file prefix.
            state.filePrefix = origVal;
          } else if (cleanKey === 'style') {
            if (styleSel) {
              styleSel.value = origVal;
              styleSel.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else {
            const input = tabFields[cleanKey];
            if (input) {
              setTabInputValue(input, origVal);
            }
          }
        }
      }
      // H9-005/018: clear the per-row postprocess slot so the next item (or the
      // next manual generate) doesn't inherit it.
      state._batchRowPostprocess = null;
      } // end per-item finally (H9-017)

      if (window._batchAbortByTab[tabKey]) { logLine(`Aborted at item ${i + 1}.`, 'warn'); break; }
    }
  } catch (e) {
    batchError = e;
    console.error('BatchGen threw:', e);
    logLine(`⚠ Batch error: ${e && e.message || String(e)}`, 'err');
  } finally {
    // Always clear the timer and reset the stop button — even on an
    // uncaught exception in the loop.
    clearInterval(elapsedTimer);
    if (_bar) _bar.set(100);
    // R5 (H1): detach the stop handler before repurposing to "Close" (.onclick= doesn't remove an addEventListener listener).
    stopBtn.removeEventListener('click', onStopClick);
    // T7: a clean run (no failure, no skip, no error, not aborted)
    // removes the overlay automatically — the summary toast below is the
    // success confirmation and the GUI returns to its normal state without
    // the user having to click Close on an already-finished process.
    // Failed / skipped-defective / aborted runs KEEP the overlay (with a
    // Close button) so the per-item log — WHICH item failed or was
    // skipped — can still be inspected (same rule as the toast's 'warn').
    if (!batchError && fail === 0 && partial === 0 && skipped === 0 && !window._batchAbortByTab[tabKey]) {
      overlay.remove();
    } else {
      stopBtn.textContent = 'Close';
      stopBtn.disabled = false;
      stopBtn.onclick = () => overlay.remove();
    }
    // H9-016: release the per-queue run lock.
    window._batchRunningByTab = window._batchRunningByTab || {};
    window._batchRunningByTab[tabKey] = false;
    // Clear the per-tab batch-queue counter so the ETA timer stops
    // showing batch left-over. Done in finally so an aborted / errored
    // batch still resets the counter.
    if (state.batchQueueLeft) state.batchQueueLeft[tabKey] = 0;

    // Restore global upscale state
    state.upscaleEnabled = savedUpscaleEnabled;
    state.upscaleSettings = savedUpscaleSettings;
    const upscaleCb = tabRoot.querySelector('.upscale-checkbox input');
    if (upscaleCb) {
      upscaleCb.checked = !!state.upscaleEnabled;
      const multSpan = tabRoot.querySelector('.upscale-mult');
      if (multSpan) {
        multSpan.textContent = state.upscaleEnabled && state.upscaleSettings ? `(${state.upscaleSettings.multiplier}x)` : '';
      }
    }
  }

  // Restore original state. Suppress the input-event-driven state save for
  // the same reason as the per-item overwrite: the batch should not
  // leave behind any transient state.
  suppressStateSave(() => {
    promptTa.value = savedPrompt;
    promptTa.dispatchEvent(new Event('input', { bubbles: true }));
    if (styleSel) styleSel.value = savedStyle;
    if (variantsSel) variantsSel.value = savedVariants;
  });
  const partialNote = partial > 0 ? `, ${partial} partial (postprocess failed)` : '';
  const skipNote = skipped > 0 ? `, ${skipped} skipped (defective)` : '';
  // H3-B9: the .lastcmd span was removed; the summary is shown via toast
  // (below) and in the job details (returned at the end of runFn).

  toast(`BatchGen done: ${ok} ok, ${fail} failed${partialNote}${skipNote}.`, batchError ? 'err' : ((fail === 0 && partial === 0 && skipped === 0) ? 'ok' : 'warn'), 6000);
  // Refresh the per-tab batch buttons so the "Start BatchGen (N)" count
  // reflects any items auto-removed during this run (otherwise the count
  // stays stale until the next manual refresh / tab rebuild).
  if (typeof _refreshBatchButtons === 'function') _refreshBatchButtons();
  // R5 (L3): best-effort — a throw here must not reject a successful batch.
  try { await refreshBrowser(); } catch (_) {}
  try { await refreshQuota(); } catch (_) {}
      // Mirrors the toast logic 3 lines up so the parent job's logged
      // outcome (ActiveJobsWidget colour, history row) agrees with the
      // toast just shown. When aborted, JobRunner's own
      // ac.signal.aborted check overrides this to 'cancel' regardless
      // of what we return here (see _markJobDone in JobRunner.js).
      if (batchError) return { status: 'err', error: batchError.message || String(batchError), details: [`${ok} ok, ${fail} failed${skipNote}`] };
      if (fail > 0 || skipped > 0) return { status: 'warn', details: [`${ok} ok, ${fail} failed${skipNote}`] };
      return { status: 'ok', details: [`${ok} ok, ${fail} failed${skipNote}. (variants ×${variantsCount})`] };
    },
  });
  if (batchCtrl && typeof batchCtrl.catch === 'function') {
    // Hard-cap rejection (Promise.reject from run() before runFn ran); toast already shown by run().
    batchCtrl.catch(() => {});
    // R5 (M2): runFn never ran so its finally never releases the run lock — release it here or this tab is "already running" forever.
    window._batchRunningByTab[tabKey] = false;
    if (state.batchQueueLeft) state.batchQueueLeft[tabKey] = 0;
  } else {
    await batchCtrl.done;
    // Emit AFTER (not during) runFn so the parent row has already
    // settled out of 'wip' — addLogEvent's fold-into-primary-row
    // routing only applies while a jobId's status is still 'wip', so
    // emitting here creates a genuinely separate "Batch finished: N/M
    // ok" summary row instead of silently merging into the row that's
    // about to disappear.
    if (batchResults.length && window.JobSummary && typeof window.JobSummary.emit === 'function') {
      window.JobSummary.emit(batchCtrl.jobId, batchResults);
    }
  }
}

function buildAddToBatchBtn(tabKey) {
  const btn = el('button', {
    class: 'btn-mini batch-add',
    title: 'Add current prompt/text to BatchGen list',
    onclick: async (e) => {
      e.preventDefault();
      const tabRoot = $(`#tab-${tabKey}`);
      const promptTa = tabRoot ? tabRoot.querySelector('textarea') : null;
      const val = promptTa ? promptTa.value.trim() : '';
      if (!val) {
        toast('Prompt is empty.', 'warn');
        return;
      }
      const current = state.batches[tabKey] || [];
      if (current.includes(val)) {
        toast('Prompt is already in the batch list.', 'warn');
        return;
      }
      if (current.length >= 100) {
        toast('Batch is full (max 100 entries).', 'warn');
        return;
      }
      const next = { ...state.batches, [tabKey]: [...current, val] };
      const r = await window.api.batchesSet(next);
      if (!r.ok) {
        toast('Failed to add to batch: ' + r.error, 'err');
        return;
      }
      state.batches = { ...state.batches, [tabKey]: [...current, val] };
      toast('Added to batch list.', 'ok');
      _refreshBatchButtons();
    }
  }, '+ Batch');
  return btn;
}

// Bind to window
window.BatchManager = window.BatchManager || {};
window.BatchManager.openBatchManager = openBatchManager;
window.BatchManager.startBatchGen = startBatchGen;
window.BatchManager.computeExpectedCalls = computeExpectedCalls;
window.BatchManager.buildAddToBatchBtn = buildAddToBatchBtn;
