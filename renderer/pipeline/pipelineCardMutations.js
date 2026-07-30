// renderer/pipeline/pipelineCardMutations.js
// P3.5 (DA-H-008/012): structural card mutations (Back, Finalize) + per-item
// operationId lock. Extracted from pipelineCard.js (frozen size budget).
(function () {
  function beginOp(item, kind) {
    if (item._opId) {
      PipelineBoard.toast('Another operation is still running for this card.', 'warn', 2500);
      return null;
    }
    const id = kind + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    item._opId = id; // transient; not persisted (no sanitiser field)
    return id;
  }

  function endOp(item, id) {
    if (item._opId === id) item._opId = null;
  }

  async function moveBack(item) {
    const prev = PipelineModel.prevColumn(item.column);
    if (!prev) return;
    const op = beginOp(item, 'back');
    if (!op) return;
    try {
      if (item.column === 'final') {
        // Keep Back reversible without leaving copies accumulated in final/.
        // P3.5 (DA-H-008): AWAIT the trash before committing any state — the
        // pre-fix fire-and-forget dropped files.final while the move could
        // still fail, stranding an untracked copy in final/. A failed trash
        // now ABORTS the Back so state and disk stay consistent.
        const finalFile = item.files.final;
        if (finalFile) {
          let res;
          try {
            res = await window.api.pipelineTrash({ imageId: item.id, files: [finalFile], workspaceId: window.state.pipeline.image.workspaceId });
          } catch (err) {
            if (typeof window.logAction === 'function') window.logAction('pipeline-trash', 'error', { error: String(err && err.message || err) });
            PipelineBoard.toast('Back failed: the finalized file could not be moved to trash.', 'err', 5000);
            return;
          }
          if (!res || res.ok === false) {
            if (typeof window.logAction === 'function') window.logAction('pipeline-trash', 'partial-fail', { failed: (res && res.failed) || [] });
            PipelineBoard.toast('Back failed: the finalized file could not be moved to trash (locked?).', 'err', 5000);
            return;
          }
        }
        if (item._opId !== op) return; // a concurrent mutation won — discard
        delete item.files.final;
        if (Array.isArray(item.history)) {
          for (let i = item.history.length - 1; i >= 0; i--) {
            const h = item.history[i];
            if (h.column === 'optimize' && h.next === 'final' && h.nameBefore) {
              if (!h.consumed) { item.name = h.nameBefore; h.consumed = true; }
              break;
            }
          }
        }
      }
      item.column = prev;
      item.history.push({ action: 'back', column: prev, ts: Date.now() });
      PipelineBoard.save();
      PipelineBoard.render();
    } finally { endOp(item, op); }
  }

  function finalize(item) {
    const src = item.files[item.column];
    if (!src) { PipelineBoard.toast('No file to finalize.', 'warn'); return; }
    // P3.5 (DA-H-012): mutation lock — a double-click mints ONE operationId;
    // the second click is refused, and the commit checks the id so exactly
    // one final file + one history entry is produced.
    const op = beginOp(item, 'finalize');
    if (!op) return;
    PipelineOps.copyToFinal(item).then(() => {
      if (item._opId !== op) return; // superseded by a concurrent mutation
      item.column = 'final';
      item.history.push({ action: 'finalize', column: 'final', ts: Date.now() });
      PipelineBoard.save();
      PipelineBoard.render();
    }).catch((e) => PipelineBoard.toast('Finalize failed: ' + ((e && e.message) || e), 'err'))
      .finally(() => endOp(item, op));
  }

  window.PipelineCardMutations = { moveBack, finalize };
})();
