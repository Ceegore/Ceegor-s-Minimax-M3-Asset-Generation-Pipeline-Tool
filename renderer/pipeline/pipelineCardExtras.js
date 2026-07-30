// renderer/pipeline/pipelineCardExtras.js
// Add-ons for the Pipeline cards, extracted from pipelineCard.js to keep that
// file under the 500-line lint cap:
//   - buildInfoPanel(item, column, file): resolution + key info + a warning line
//   - duplicateItem(item): copy the current file into the same column under a
//     fresh id and insert a new board item directly below the original
//   - saveAndRemove(item, column): export the final file to a chosen folder,
//     then remove the item (one-step "done with this asset")
//
// Depends on globals: el, window.PipelineModel, window.PipelineBoard,
// window.state, window.api, window.PureFuncs.loadImageFromFile, window.FileUrl.

(function () {
  'use strict';
  const M = () => window.PipelineModel || null;

  // minimal path shim (mirrors the one in pipelineOps.js — renderer has no `path`)
  const path = {
    sep(p) { return (String(p).includes('\\')) ? '\\' : '/'; },
    dirname(p) { const s = path.sep(p); return String(p).split(s).slice(0, -1).join(s); },
    basename(p) { const s = path.sep(p); return String(p).split(s).pop(); },
    join(...parts) {
      if (!parts.length) return '';
      const s = path.sep(String(parts[0]));
      // Preserve the leading separator(s) of the FIRST part so UNC roots
      // (\\server\share) and absolute paths survive the join; only strip
      // separators at the boundaries of subsequent parts to avoid doubles.
      return parts.map((x, i) => {
        let p = String(x).replace(/[\\/]+$/, '');
        if (i > 0) p = p.replace(/^[\\/]+/, '');
        return p;
      }).filter(Boolean).join(s);
    },
  };

  // ============================================================
  // INFO PANEL — resolution + key info + warning line
  // ============================================================
  // Renders a compact panel between meta/settings and actions. Loads the image
  // asynchronously to read naturalWidth/Height (no dims IPC exists; this is the
  // established pattern — see pipelineOps.doCrop / imageEditorSource). A warning
  // line is always reserved (kept empty when there's nothing to warn about) so
  // the card layout doesn't jump when a warning appears.
  function buildInfoPanel(item, column, file) {
    const panel = el('div', { class: 'pipeline-card-info' });
    const dimsRow = el('div', { class: 'pipeline-card-info-dims' }, file ? '…' : '—');
    const infoRow = el('div', { class: 'pipeline-card-info-meta' }, infoSummary(item, column, file));
    const warnRow = el('div', { class: 'pipeline-card-info-warn' }, '');
    panel.append(dimsRow, infoRow, warnRow);

    if (file && item.status !== 'missing') {
      // cache the dims on the item so duplicate + warnings can reuse them
      if (window.PureFuncs && window.PureFuncs.loadImageFromFile) {
        window.PureFuncs.loadImageFromFile(file).then((img) => {
          if (!img) return;
          const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
          item._dims = { w, h }; // transient; not persisted (no sanitiser field)
          dimsRow.textContent = w && h ? (w + ' × ' + h) : '—';
          let warning = computeWarning(item, column, { w, h });
          // P3-A (DA-H-001): flag oversized images via the single admission
          // policy — the editor/asset-panel will refuse them, so warn the
          // user here in the pipeline preview already.
          if (!warning && window.ImageAdmissionPolicy) {
            const adm = window.ImageAdmissionPolicy.checkAdmission({ width: w, height: h, source: 'pipeline-preview' });
            if (!adm.ok) warning = '⚠ too large for the editor (' + adm.megapixels.toFixed(1) + ' MP > ' + window.ImageAdmissionPolicy.DEFAULT_MAX_MP + ' MP limit)';
          }
          if (warning) { warnRow.textContent = warning; warnRow.classList.add('has-warn'); }
        }).catch(() => { dimsRow.textContent = 'dims unavailable'; });
      }
    } else if (item.status === 'missing') {
      warnRow.textContent = '⚠ source file missing'; warnRow.classList.add('has-warn');
    } else if (item.status === 'error') {
      warnRow.textContent = '⚠ ' + (item.error || 'error'); warnRow.classList.add('has-warn');
    }
    return panel;
  }

  // A short, column-appropriate summary line for the panel.
  function infoSummary(item, column, file) {
    const parts = [];
    parts.push(columnLabel(column));
    if (file) {
      const ext = (path.basename(file).split('.').pop() || '').toLowerCase();
      if (ext) parts.push(ext.toUpperCase());
    }
    // show the active op's key setting when relevant
    const s = (item.settings && item.settings[column]) || {};
    if (column === 'upscale' && s.multiplier) parts.push(s.multiplier + '×');
    if (column === 'removebg' && s.model) parts.push(s.model);
    if (column === 'crop' && (s.w || s.h)) parts.push('→ ' + (s.w || '?') + '×' + (s.h || '?'));
    if (column === 'resize' && (s.width || s.height)) parts.push('→ ' + (s.width || '?') + '×' + (s.height || '?'));
    if (column === 'optimize' && s.format) parts.push(s.format);
    return parts.join(' · ');
  }
  function columnLabel(column) {
    return ({ original: 'Original', upscale: 'Upscaled', removebg: 'BG removed',
      crop: 'Cropped', resize: 'Resized', optimize: 'Optimized', final: 'Final' })[column] || column;
  }

  // Decide whether a warning should be shown. Returns the warning text or ''.
  // Covers: crop target exceeds source, very large upscaled output, low-res source.
  function computeWarning(item, column, dims) {
    if (!dims || !dims.w || !dims.h) return '';
    const s = (item.settings && item.settings[column]) || {};
    if (column === 'crop' && (s.w || s.h)) {
      if (Number(s.w) > dims.w || Number(s.h) > dims.h) {
        return '⚠ crop ' + s.w + '×' + s.h + ' larger than ' + dims.w + '×' + dims.h;
      }
    }
    if (column === 'upscale') {
      const mult = Number(s.multiplier) || 2;
      const outW = dims.w * mult, outH = dims.h * mult;
      // warn on truly huge outputs (> 8K on either side) — perf/memory risk
      if (outW > 8192 || outH > 8192) return '⚠ ' + mult + '× output ≈ ' + outW + '×' + outH + ' (very large)';
    }
    if (column === 'original' && dims.w < 256) return '⚠ low-res source (' + dims.w + '×' + dims.h + ')';
    return '';
  }

  // ============================================================
  // DUPLICATE — copy current file, insert new item below the original
  // ============================================================
  // Uses the existing pipeline:import IPC (it copies a source file into a column
  // folder under a fresh img_<id>_<name> name and returns the new id). The new
  // item is inserted directly BELOW the original (createdAt = original + 1ms),
  // not at the end of the column, so the copy sorts right after its source. A
  // confirmation prompt guards the action.
  async function duplicateItem(item) {
    const board = window.state.pipeline.image;
    const file = item.files[item.column];
    if (!file) { toast('Nothing to duplicate — this item has no file in its current step.', 'warn', 3000); return; }
    if (item.status === 'running') { toast('Wait for the current operation to finish before duplicating.', 'warn', 3000); return; }
    if (!await asyncConfirm('Duplicate this image at its current step (' + columnLabel(item.column) + ')?\nA copy is created directly below the original so you can process it independently (e.g. keep a low-res version while upscaling another).')) return;
    // Delegated import: omit imageId so the main process mints a fresh one.
    // QA-001 follow-up: pass the object form with workspaceId so main resolves
    // the correct workspace (the bare-array preload wrapper drops top-level
    // fields, and the per-item `workspace` string is ignored by main).
    const payload = [{
      srcAbsPath: file,
      destColumn: item.column,
      displayName: item.name || 'image',
    }];
    window.api.pipelineImport({ items: payload, workspaceId: board.workspaceId }).then((r) => {
      const res = r && r.results && r.results[0];
      if (!res || !res.ok || !res.dst) {
        toast('Duplicate failed: ' + ((res && res.error) || 'unknown'), 'err', 5000);
        return;
      }
      // Build the new item from the original (preserve settings + history so
      // the user can keep iterating from the same point), at the SAME column.
      const newItem = {
        id: res.imageId,
        column: item.column,
        name: item.name || 'image',
        // insert directly below the original: createdAt + 1ms keeps sort order
        createdAt: (item.createdAt || Date.now()) + 1,
        files: Object.assign({}, item.files, { [item.column]: res.dst }),
        settings: JSON.parse(JSON.stringify(item.settings || {})),
        // Start a FRESH history (the duplicate didn't run the original's ops on
        // its own file); record only the duplicate provenance so the audit trail
        // is accurate rather than inheriting misleading run/import events.
        history: [{ action: 'duplicate', column: item.column, file: res.dst, from: item.id, ts: Date.now() }],
        status: 'idle',
        error: null,
      };
      const idx = board.items.indexOf(item);
      if (idx >= 0) board.items.splice(idx + 1, 0, newItem);
      else board.items.push(newItem);
      board.counter = (board.counter || 0) + 1;
      if (typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
      window.PipelineBoard.render();
      window.PipelineBoard.refreshBadge();
      toast('Duplicated.', 'ok', 2000);
    }).catch((e) => toast('Duplicate failed: ' + (e && e.message || e), 'err', 5000));
  }
  function toast(msg, kind, ms) {
    if (typeof window.toast === 'function') window.toast(msg, kind, ms);
  }

  // ============================================================
  // SAVE & REMOVE — export the final file to a chosen folder, then remove
  // ============================================================
  // One-step "I'm done with this asset". Picks a folder, copies the final file
  // there, then soft-deletes the item from the board (same flow as removeItem).
  function saveAndRemove(item, column) {
    const board = window.state.pipeline.image;
    const file = item.files[column || item.column];
    if (!file) { toast('No file to save.', 'warn', 3000); return; }
    window.api.pickFolder().then(async (destDir) => {
      if (!destDir) return; // user canceled
      // BGR-009 fix: mint copy grant (R1.3 gate).
      // gewv2 GEW-002 fix: ensureCopy returns { ok, srcGrant, destGrant }.
      const cp = (window.GrantHelper) ? await window.GrantHelper.ensureCopy(file, destDir) : undefined;
      window.api.fbCopy(file, destDir, cp && cp.srcGrant, cp && cp.destGrant).then((c) => {
        if (!c || !c.ok) { toast('Save failed: ' + ((c && c.error) || 'unknown'), 'err', 5000); return; }
        toast('Saved to ' + destDir + '. Removing from board\u2026', 'ok', 2500);
        // now remove (mirror removeItem)
        const files = Object.values(item.files).filter(Boolean);
        if (files.length) {
          // QA-011 fix: only finalize removal if trash succeeds.
          window.api.pipelineTrash({ imageId: item.id, files, workspaceId: board.workspaceId }).then((res) => {
            if (res && res.ok === false) {
              toast('File exported but could not be trashed from board.', 'warn', 5000);
              return;
            }
            finalizeRemoval(item);
          }).catch(() => {
            toast('File exported but trash failed; item kept on board.', 'warn', 5000);
          });
        } else {
          finalizeRemoval(item);
        }
      }).catch((e) => toast('Save failed: ' + (e && e.message || e), 'err', 5000));
    });
  }
  function finalizeRemoval(item) {
    const board = window.state.pipeline.image;
    board.trash.push({ item, ts: Date.now() });
    const idx = board.items.indexOf(item);
    if (idx >= 0) board.items.splice(idx, 1);
    window.PipelineBoard.save();
    window.PipelineBoard.render();
    window.PipelineBoard.refreshBadge();
  }

  // ============================================================
  // BATCH EXPORT + REMOVE (final column) — called from the overlay header
  // ============================================================
  // Exports every finalized image to a chosen folder and removes them from the
  // board in one action. Returns a summary {saved, failed, removed}.
  function batchExportAndRemoveFinal() {
    const board = window.state.pipeline.image;
    const finals = board.items.filter((i) => i.column === 'final' && i.files.final);
    if (!finals.length) { toast('No finalized images to export.', 'warn', 3000); return Promise.resolve({ saved: 0, failed: 0, removed: 0 }); }
    return window.api.pickFolder().then((destDir) => {
      if (!destDir) return { saved: 0, failed: 0, removed: 0, canceled: true };
      let saved = 0, failed = 0;
      const removed = [];
      // sequential copy to keep error attribution clear + avoid hammering the disk
      return (async () => {
        for (const it of finals) {
          try {
            // BGR-009 fix: mint copy grant (R1.3 gate).
            // gewv2 GEW-002 fix: ensureCopy returns { ok, srcGrant, destGrant }.
            const cp = (window.GrantHelper) ? await window.GrantHelper.ensureCopy(it.files.final, destDir) : undefined;
            const c = await window.api.fbCopy(it.files.final, destDir, cp && cp.srcGrant, cp && cp.destGrant);
            if (c && c.ok) { saved++; removed.push(it); }
            else { failed++; }
          } catch (_) { failed++; }
        }
        // soft-delete the successfully-exported items
        for (const it of removed) {
          const files = Object.values(it.files).filter(Boolean);
          if (files.length) { try { await window.api.pipelineTrash({ imageId: it.id, files, workspaceId: board.workspaceId }); } catch (_) {} }
          board.trash.push({ item: it, ts: Date.now() });
          const idx = board.items.indexOf(it);
          if (idx >= 0) board.items.splice(idx, 1);
        }
        window.PipelineBoard.save();
        window.PipelineBoard.render();
        window.PipelineBoard.refreshBadge();
        toast('Exported ' + saved + ' image(s) to ' + destDir + (failed ? ' (' + failed + ' failed)' : '') + '.', failed ? 'warn' : 'ok', 5000);
        return { saved, failed, removed: removed.length };
      })();
    });
  }

  window.PipelineCardExtras = {
    buildInfoPanel, duplicateItem, saveAndRemove, batchExportAndRemoveFinal,
  };
})();
