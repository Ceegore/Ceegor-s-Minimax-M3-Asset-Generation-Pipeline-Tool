// renderer/pipeline/pipelineClear.js
// The Final-column clear/export operations. Adds batch operations on the whole
// Final column, with an optional Markdown report:
//
//   1. 🗑 Clear final column           — remove every finalized asset (no export, no report)
//   2. 📋 Clear with report            — remove every finalized asset + write a report
//   3. 📦 Export all finals…           — export every finalized asset to a folder, then remove (no report)
//   4. 📦📋 Export all + report…        — export every finalized asset + write a report, then remove
//
// All four share the same soft-delete path (pipelineTrash + finalizeRemoval),
// so the per-item undo semantics + the .trash folder layout are identical to
// the existing removeItem flow. The report (when requested) is written by
// window.PipelineReport into the configured report folder (or, for export, the
// chosen destination).

(function () {
  'use strict';

  function board() { return window.state.pipeline.image; }
  function toast(msg, kind, ms) { try { if (typeof window.toast === 'function') window.toast(msg, kind, ms); } catch (_) {} }

  // Soft-delete the given items: move their files to .trash, push to board.trash,
  // splice from board.items. Mirrors pipelineCard.removeItem + finalizeRemoval.
  //
  // Each item has its own .trash/<imageId>/ folder (no cross-item basename clash
  // — the IPC handler de-dups within one imageId), so the moves are independent
  // and run in parallel via Promise.all. The board mutation (trash.push /
  // items.splice) happens once they settle; doing them serially would make N
  // serial IPC round-trips.
  async function removeItems(items) {
    const b = board();
    // QA-011 fix: track per-item trash results; keep failed items on the board.
    const results = await Promise.all(items.map((it) => {
      const files = Object.values(it.files || {}).filter(Boolean);
      if (!files.length) return Promise.resolve({ item: it, ok: true });
      return window.api.pipelineTrash({ imageId: it.id, files, workspaceId: b.workspaceId })
        .then((res) => {
          if (res && res.ok === false) return { item: it, ok: false, error: res.error };
          if (res && Array.isArray(res.failed) && res.failed.length) {
            if (typeof window.logAction === 'function') window.logAction('pipeline-trash', 'partial-fail', { id: it.id, failed: res.failed });
          }
          return { item: it, ok: true };
        })
        .catch((err) => {
          if (typeof window.logAction === 'function') window.logAction('pipeline-trash', 'error', { id: it.id, error: String(err && err.message || err) });
          return { item: it, ok: false, error: String(err && err.message || err) };
        });
    }));
    let removedCount = 0;
    let failedCount = 0;
    for (const r of results) {
      if (!r.ok) { failedCount++; continue; }
      b.trash.push({ item: r.item, ts: Date.now() });
      const idx = b.items.indexOf(r.item);
      if (idx >= 0) b.items.splice(idx, 1);
      if (window.PipelineCardProgress) window.PipelineCardProgress.clearProgressSetter(r.item.id);
      removedCount++;
    }
    if (failedCount > 0) {
      toast(failedCount + ' item(s) could not be removed (files locked?).', 'warn', 5000);
    }
    if (typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
    if (window.PipelineBoard) {
      if (typeof window.PipelineBoard.save === 'function') window.PipelineBoard.save();
      if (typeof window.PipelineBoard.render === 'function') window.PipelineBoard.render();
      if (typeof window.PipelineBoard.refreshBadge === 'function') window.PipelineBoard.refreshBadge();
    }
    // DA-M-019: return actual counts so callers report truthfully.
    return { removed: removedCount, failed: failedCount, failedItems: results.filter((r) => !r.ok).map((r) => r.item) };
  }

  // Export (copy) each final to destDir. Returns { saved, failed, exported: [items] }.
  async function exportItems(items, destDir) {
    let saved = 0, failed = 0;
    const exported = [];
    for (const it of items) {
      try {
        // BGR-009 fix: mint copy grant (R1.3 gate).
        // gewv2 GEW-002 fix: ensureCopy returns { ok, srcGrant, destGrant }.
        const cp = (window.GrantHelper) ? await window.GrantHelper.ensureCopy(it.files.final, destDir) : undefined;
        const c = await window.api.fbCopy(it.files.final, destDir, cp && cp.srcGrant, cp && cp.destGrant);
        if (c && c.ok) { saved++; exported.push(it); }
        else { failed++; }
      } catch (_) { failed++; }
    }
    return { saved, failed, exported };
  }

  // ---- 1. Clear final column (no export, no report) ----
  async function clearFinalColumn() {
    const b = board();
    const finals = b.items.filter((i) => i.column === 'final' && i.files.final);
    if (!finals.length) { toast('No finalized images to clear.', 'warn', 3000); return { removed: 0 }; }
    if (!await asyncConfirm('Clear ' + finals.length + ' finalized image' + (finals.length === 1 ? '' : 's') + ' from the board?\n(The files are moved to the session trash; this removes them from the Final column.)')) {
      return { removed: 0, canceled: true };
    }
    // DA-M-019: report actual removed count, not requested count.
    const res = await removeItems(finals);
    toast('Cleared ' + res.removed + ' finalized image' + (res.removed === 1 ? '' : 's') + (res.failed ? ' (' + res.failed + ' failed)' : '') + '.', res.failed ? 'warn' : 'ok', 3000);
    return { removed: res.removed, failed: res.failed };
  }

  // ---- 2. Clear with report ----
  async function clearFinalColumnWithReport() {
    const b = board();
    const finals = b.items.filter((i) => i.column === 'final' && i.files.final);
    if (!finals.length) { toast('No finalized images to clear.', 'warn', 3000); return { removed: 0 }; }
    if (!await asyncConfirm('Clear ' + finals.length + ' finalized image' + (finals.length === 1 ? '' : 's') + ' AND write a report?\n(A Markdown report of the removed assets is written to your report folder, or next to the assets if none is set.)')) {
      return { removed: 0, canceled: true };
    }
    // Write the report FIRST (while the items + their dims/files are still on
    // the board), then remove. If the report write fails, proceed with the
    // clear anyway (the user asked to clear; the report is a bonus) but warn.
    let reportPath = '';
    if (window.PipelineReport) {
      const r = await window.PipelineReport.writeReport(finals, { mode: 'clear' });
      if (r && r.ok) reportPath = r.path;
      else toast('Report could not be written: ' + ((r && r.error) || 'unknown') + '. Clearing anyway.', 'warn', 5000);
    }
    // DA-M-019: use actual removed count from removeItems.
    const res = await removeItems(finals);
    const msg = 'Cleared ' + res.removed + ' image' + (res.removed === 1 ? '' : 's') + (res.failed ? ' (' + res.failed + ' failed)' : '') + '.';
    toast(reportPath ? msg + ' Report → ' + reportPath : msg, reportPath ? 'ok' : 'warn', 5000);
    return { removed: res.removed, failed: res.failed, reportPath };
  }

  // ---- 3. Export all finals (no report) — the existing behaviour ----
  async function exportFinals() {
    const b = board();
    const finals = b.items.filter((i) => i.column === 'final' && i.files.final);
    if (!finals.length) { toast('No finalized images to export.', 'warn', 3000); return { saved: 0, removed: 0 }; }
    const destDir = await window.api.pickFolder();
    if (!destDir) return { saved: 0, removed: 0, canceled: true };
    const { saved, failed, exported } = await exportItems(finals, destDir);
    await removeItems(exported);
    toast('Exported ' + saved + ' image' + (saved === 1 ? '' : 's') + ' to ' + destDir + (failed ? ' (' + failed + ' failed)' : '') + '.', failed ? 'warn' : 'ok', 5000);
    return { saved, failed, removed: exported.length };
  }

  // ---- 4. Export all finals + report ----
  async function exportFinalsWithReport() {
    const b = board();
    const finals = b.items.filter((i) => i.column === 'final' && i.files.final);
    if (!finals.length) { toast('No finalized images to export.', 'warn', 3000); return { saved: 0, removed: 0 }; }
    const destDir = await window.api.pickFolder();
    if (!destDir) return { saved: 0, removed: 0, canceled: true };
    const { saved, failed, exported } = await exportItems(finals, destDir);
    // Write the report for the successfully-exported items (mode: export, into
    // the report folder if set, else the destination folder).
    let reportPath = '';
    if (window.PipelineReport && exported.length) {
      const r = await window.PipelineReport.writeReport(exported, { mode: 'export', exportDir: destDir });
      if (r && r.ok) reportPath = r.path;
      else toast('Report could not be written: ' + ((r && r.error) || 'unknown') + '.', 'warn', 5000);
    }
    await removeItems(exported);
    const msg = 'Exported ' + saved + ' image' + (saved === 1 ? '' : 's') + (failed ? ' (' + failed + ' failed)' : '') + '.';
    toast(reportPath ? msg + ' Report → ' + reportPath : msg, reportPath ? 'ok' : (failed ? 'warn' : 'ok'), 5000);
    return { saved, failed, removed: exported.length, reportPath };
  }

  // ---- 5. Export all finals (keep on board) — H10-6 ----
  // Same as exportFinals but does NOT remove the images from the final column,
  // so the user can save a snapshot while keeping the board intact for further
  // edits / re-export.
  async function exportFinalsKeep() {
    const b = board();
    const finals = b.items.filter((i) => i.column === 'final' && i.files.final);
    if (!finals.length) { toast('No finalized images to export.', 'warn', 3000); return { saved: 0, removed: 0 }; }
    const destDir = await window.api.pickFolder();
    if (!destDir) return { saved: 0, removed: 0, canceled: true };
    const { saved, failed, exported } = await exportItems(finals, destDir);
    // NOTE: deliberately no removeItems(exported) — the images stay on the board.
    toast('Exported ' + saved + ' image' + (saved === 1 ? '' : 's') + ' to ' + destDir + ' (kept on board)' + (failed ? ' (' + failed + ' failed)' : '') + '.', failed ? 'warn' : 'ok', 5000);
    return { saved, failed, removed: 0 };
  }

  // ---- 6. Export all finals + report (keep on board) — H10-6 ----
  async function exportFinalsKeepWithReport() {
    const b = board();
    const finals = b.items.filter((i) => i.column === 'final' && i.files.final);
    if (!finals.length) { toast('No finalized images to export.', 'warn', 3000); return { saved: 0, removed: 0 }; }
    const destDir = await window.api.pickFolder();
    if (!destDir) return { saved: 0, removed: 0, canceled: true };
    const { saved, failed, exported } = await exportItems(finals, destDir);
    let reportPath = '';
    if (window.PipelineReport && exported.length) {
      const r = await window.PipelineReport.writeReport(exported, { mode: 'export', exportDir: destDir });
      if (r && r.ok) reportPath = r.path;
      else toast('Report could not be written: ' + ((r && r.error) || 'unknown') + '.', 'warn', 5000);
    }
    // NOTE: deliberately no removeItems(exported) — the images stay on the board.
    const msg = 'Exported ' + saved + ' image' + (saved === 1 ? '' : 's') + (failed ? ' (' + failed + ' failed)' : '') + ' (kept on board).';
    toast(reportPath ? msg + ' Report → ' + reportPath : msg, reportPath ? 'ok' : (failed ? 'warn' : 'ok'), 5000);
    return { saved, failed, removed: 0, reportPath };
  }

  // ---- The dropdown menu (replaces the single "Export all finals…" button) ----
  // Built as a small modal so the four options are discoverable + each shows
  // the current final count. Called from pipelineOverlay's header button.
  function openFinalColumnMenu() {
    const b = board();
    const count = b.items.filter((i) => i.column === 'final' && i.files.final).length;
    if (typeof showModal !== 'function') return;
    showModal((m, close) => {
      m.appendChild(el('h3', { style: 'margin-bottom: 6px;' }, 'Final column operations'));
      m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12.5px; margin-bottom: 12px;' },
        count > 0
          ? (count + ' finalized image' + (count === 1 ? '' : 's') + ' on the board. Choose an action:')
          : 'There are no finalized images on the board right now.'));

      const disabled = count === 0;
      function opt(icon, label, desc, fn, primary) {
        const row = el('button', {
          type: 'button',
          class: 'pipeline-final-opt' + (primary ? ' primary' : ''),
          style: 'display:block; width:100%; text-align:left; margin-bottom: 8px; padding: 10px 12px;',
        }, [el('strong', {}, icon + ' ' + label), el('div', { class: 'meta', style: 'color: var(--fg-3); font-size: 11.5px; margin-top: 2px;' }, desc)]);
        row.disabled = disabled;
        row.addEventListener('click', async () => {
          close();
          try { await fn(); } catch (e) { toast('Operation failed: ' + ((e && e.message) || e), 'err', 5000); }
        });
        return row;
      }

      m.appendChild(opt('📦', 'Export all finals…',
        'Copy every finalized image to a folder you choose, then remove them from the board. No report.',
        exportFinals, true));
      m.appendChild(opt('📦📋', 'Export all + report…',
        'Copy every finalized image to a folder AND write a Markdown report of the exported assets, then remove them.',
        exportFinalsWithReport));
      // H10-6: "keep on board" variants — same export, but the images are NOT
      // removed from the final column, so the user can save a snapshot while
      // keeping the board intact for further edits / re-export.
      m.appendChild(opt('📥', 'Export all (keep on board)',
        'Copy every finalized image to a folder you choose. The images stay on the board. No report.',
        exportFinalsKeep));
      m.appendChild(opt('📥📋', 'Export all + report (keep on board)',
        'Copy every finalized image to a folder AND write a Markdown report. The images stay on the board.',
        exportFinalsKeepWithReport));
      m.appendChild(opt('🗑', 'Clear final column',
        'Remove every finalized image from the board (moved to the session trash). No export, no report.',
        clearFinalColumn));
      m.appendChild(opt('📋', 'Clear with report',
        'Remove every finalized image AND write a Markdown report of the cleared assets (to your report folder).',
        clearFinalColumnWithReport));

      const cancelBtn = el('button', { class: 'btn-mini', onclick: close }, 'Close');
      m.appendChild(el('div', { class: 'footer', style: 'margin-top: 8px;' }, [cancelBtn]));
    }, { id: 'pipeline-final-column-menu' });
  }

  window.PipelineClear = {
    clearFinalColumn, clearFinalColumnWithReport,
    exportFinals, exportFinalsWithReport,
    exportFinalsKeep, exportFinalsKeepWithReport,
    openFinalColumnMenu,
  };
})();
