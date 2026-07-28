// renderer/pipeline/pipelineBoard.js
// Feature 3 — renders the columns + cards from state.pipeline.image and wires
// the card action row (Back / Skip / Run / Finalize / Replace / Open-in / Delete).
//
// Diff-based repaint: cards are keyed by item id, so a state mutation only
// touches the DOM of the changed card (NOT a full innerHTML rebuild — the file
// browser's full-rebuild-on-resize pattern is the anti-pattern we avoid here;
// dozens of cards would be unusable with that approach).

(function () {
  // Column display config: title + whether it's an active (runs an op) column.
  const COLS = [
    { id: 'original', title: 'Original', active: false },
    { id: 'upscale', title: 'Upscale', active: true },
    { id: 'removebg', title: 'Remove BG', active: true },
    { id: 'crop', title: 'Crop', active: true },
    { id: 'resize', title: 'Resize', active: true },
    { id: 'optimize', title: 'Optimize / Convert', active: true },
    { id: 'final', title: 'Final', active: false, sink: true },
  ];

  let _columnsEl = null;     // .pipeline-columns
  let _summaryEl = null;     // #pipeline-summary
  let _filterEl = null;      // #pipeline-filter
  let _colBody = {};         // column id → the scrollable card-list element
  let _mounted = false;

  function board() { return window.state.pipeline.image; }

  function mount(columnsEl, summaryEl, filterEl) {
    _columnsEl = columnsEl;
    _summaryEl = summaryEl;
    _filterEl = filterEl;
    _mounted = true;
    // EFH2-001 fix: subscribe to Real-ESRGAN progress IPC (idempotent).
    if (window.PipelineCardProgress && typeof window.PipelineCardProgress.wireProgressIpc === 'function') {
      window.PipelineCardProgress.wireProgressIpc();
    }
    buildColumnSkeletons();
    // Ensure workspace is resolved + subfolders exist before the first paint.
    ensureWorkspace().then(() => { selfHeal(); render(); refreshBadge(); });
  }

  function unmount() {
    _mounted = false;
    _columnsEl = null;
    _summaryEl = null;
    _filterEl = null;
    _colBody = {};
  }

  // Build the empty column shells once (header + scrollable body). Cards are
  // rendered into the bodies on each render().
  function buildColumnSkeletons() {
    _columnsEl.innerHTML = '';
    _colBody = {};
    for (const col of COLS) {
      const hidden = board().hiddenColumns && board().hiddenColumns.includes(col.id);
      const headerContents = [
        el('span', { class: 'pipeline-column-title' }, col.title),
        el('span', { class: 'pipeline-column-count', id: 'pl-count-' + col.id }, '0'),
      ];
      // H11-2: the per-column 📁 folder buttons were removed. There is now ONE
      // central folder button in the pipeline overlay header that sets the
      // workspace (the single output folder) for every column.
      const header = el('div', { class: 'pipeline-column-header', style: 'display: flex; align-items: center;' }, headerContents);
      const body = el('div', { class: 'pipeline-column-body', 'data-column': col.id });
      _colBody[col.id] = body;
      const colEl = el('div', {
        class: 'pipeline-column' + (col.sink ? ' pipeline-column-sink' : '') + (hidden ? ' collapsed' : ''),
        'data-col': col.id,
      }, [header, body]);
      _columnsEl.appendChild(colEl);
    }
  }

  // Ensure the workspace path is resolved + cached on the board. The workspace
  // is `<effectiveOutputDir>/pipeline/image`. The renderer can't compute
  // effectiveOutputDir itself (it depends on the packaged-exe/cwd/env fallback
  // chain in src/config.js), so when the user's output_dir is BLANK we ask the
  // main process for defaultOutputDir. Without this, every op's dst built from
  // a blank workspace fails the path-security allow-list → all Runs fail
  // silently with "outside the allowed directories" on a fresh install.
  async function ensureWorkspace() {
    const b = board();
    if (b.workspace) {
      if (typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
      return;
    }
    let out = (window.state.config && window.state.config.output_dir) || '';
    if (!out) {
      // Blank output_dir: fall back to the main process's defaultOutputDir.
      try { out = await window.api.defaultOutputDir(); } catch (_) { out = ''; }
    }
    if (out && typeof out === 'string') {
      const sep = out.includes('\\') ? '\\' : '/';
      b.workspace = out.replace(/[\\/]+$/, '') + sep + 'pipeline' + sep + 'image';
    }
    if (typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
  }

  // Self-heal pass (§4.3): check every card's file exists; flag missing ones.
  async function selfHeal() {
    const b = board();
    let changed = false;
    for (const item of b.items) {
      const f = item.files[item.column];
      if (!f) { if (item.status !== 'missing') { item.status = 'missing'; changed = true; } continue; }
      try {
        // BGR-005 fix: mint a read grant before fbExists (R1.3 gate).
        const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(f) : undefined;
        const r = await window.api.fbExists(f, existsGrant);
        if (!r || !r.ok || !r.exists) {
          if (item.status !== 'missing') { item.status = 'missing'; changed = true; }
        } else if (item.status === 'missing') {
          item.status = 'idle'; changed = true;
        }
      } catch (_) { /* best-effort */ }
    }
    if (changed && typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
  }

  // Full repaint. Cheap because cards are small and content-visibility hides
  // off-screen ones. Called after mutations that change layout (add/delete/
  // move between columns). Per-card updates within a column use updateCard.
  function render() {
    if (!_mounted) return;
    // Clear non-intake bodies.
    for (const col of COLS) {
      _colBody[col.id].innerHTML = '';
    }
    const filter = _filterEl ? _filterEl.value.trim().toLowerCase() : '';
    // Group items by column.
    const byCol = {};
    for (const id of ['original', 'upscale', 'removebg', 'crop', 'resize', 'optimize', 'final']) byCol[id] = [];
    for (const item of board().items) {
      if (byCol[item.column]) byCol[item.column].push(item);
    }
    // Render cards.
    for (const id of Object.keys(byCol)) {
      const body = _colBody[id];
      if (!body) continue;
      const list = byCol[id];
      // Sort by createdAt for stable order.
      list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      for (const item of list) {
        if (filter && !(item.name || '').toLowerCase().includes(filter)) continue;
        body.appendChild(PipelineCard.build(item, id));
      }
      const countEl = document.getElementById('pl-count-' + id);
      if (countEl) countEl.textContent = String(list.length);
    }
    updateSummary();
  }

  function applyFilter() { render(); }

  function updateSummary() {
    if (!_summaryEl) return;
    const items = board().items;
    const running = items.filter((i) => i.status === 'running').length;
    const error = items.filter((i) => i.status === 'error').length;
    let parts = [`${items.length} image${items.length === 1 ? '' : 's'}`];
    for (const col of COLS) {
      if (!col.active) continue;
      const n = items.filter((i) => i.column === col.id).length;
      if (n) parts.push(`${n} in ${col.title}`);
    }
    if (running) parts.push(`${running} running`);
    if (error) parts.push(`${error} error`);
    _summaryEl.textContent = parts.join(' · ');
  }

  // Update a single card in place (after a Run/Replace/settings change) without
  // rebuilding the whole column. Falls back to full render if the card isn't
  // found (e.g. it moved columns).
  function updateCard(item) {
    const existing = document.querySelector(`[data-card-id="${item.id}"]`);
    if (!existing) { render(); return; }
    const newCard = PipelineCard.build(item, item.column);
    existing.replaceWith(newCard);
    updateSummary();
    const countEl = document.getElementById('pl-count-' + item.column);
    if (countEl) {
      const n = board().items.filter((i) => i.column === item.column).length;
      countEl.textContent = String(n);
    }
  }

  function refreshBadge() {
    const badge = document.getElementById('pipeline-badge');
    if (badge) {
      const n = board().items.length;
      badge.textContent = n > 0 ? String(n) : '';
      badge.style.display = n > 0 ? '' : 'none';
    }
  }

  // Persist + repaint helpers used by the card actions.
  function save() {
    if (typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
  }
  function logEvent(opts) {
    try { if (typeof window.addLogEvent === 'function') window.addLogEvent(opts); } catch (_) {}
  }
  function toast(msg, kind, ms) {
    try { if (typeof window.toast === 'function') window.toast(msg, kind, ms); } catch (_) {}
  }

  window.PipelineBoard = {
    mount, unmount, render, applyFilter, updateCard, refreshBadge,
    updateSummary, save, logEvent, toast,
    COLS,
    get columnsEl() { return _columnsEl; },
  };
})();
