// renderer/pipeline/pipelineCardResizeCheck.js
// Extracted H10-5: the resize-column "too big → offer upscale" gate.
//
// When the user clicks ▶ Run in the RESIZE column and the requested target is
// a large enlargement (>120% on either axis), this shows the upscale-warning
// popup instead of running the plain resize immediately. The three choices:
//   'proceed'  → run the plain Lanczos resize (PipelineOps.run)
//   'upscale'  → the popup opened the dedicated Real-ESRGAN upscale dialog;
//                on completion, onUpscaleDone writes the produced file back
//                into the pipeline item and advances it (mirrors a successful
//                resize) so the new image actually appears in the pipeline.
//   'cancel'   → abort (no-op).
//
// Previously the 'upscale' branch opened a standalone dialog that wrote a
// sibling file but never updated item.files / item.column or repainted the
// board — so the new image was silently lost. The broad `.catch(() => run)`
// also re-ran the resize on a user cancel. Both are fixed here.
//
// Kept as a standalone module so pipelineCard.js stays within its frozen
// size budget.

(function () {
  'use strict';

  function runWithResizeCheck(item) {
    const PipelineOps = window.PipelineOps;
    if (!PipelineOps || typeof PipelineOps.run !== 'function') return;
    if (item.column !== 'resize') { PipelineOps.run(item); return; }
    const s = (item.settings && item.settings.resize) || {};
    const tw = Math.max(0, Math.floor(Number(s.width) || 0));
    const th = Math.max(0, Math.floor(Number(s.height) || 0));
    if (!tw || !th) { PipelineOps.run(item); return; } // no target → op no-ops anyway
    const src = item._dims || { w: 0, h: 0 };
    if (!window.ResizeUpscaleDialog || !window.ResizeUpscaleDialog.maybeWarnUpscale) {
      PipelineOps.run(item);
      return;
    }
    // When the user picks "Upscale instead", the standalone upscale dialog
    // runs against item.files.resize. On completion this callback writes the
    // produced (upscaled) file back into the pipeline item and advances it to
    // the next column (optimize) — mirroring what a successful resize would
    // do — so the new image actually shows up in the pipeline.
    const onUpscaleDone = (finalPath) => {
      if (!finalPath) return;
      try {
        const PM = window.PipelineModel;
        const next = (PM && typeof PM.nextColumn === 'function')
          ? PM.nextColumn(item.column) : 'optimize';
        item.files[next] = finalPath;
        item.column = next;
        item.status = 'idle';
        item.history.push({ action: 'upscale-instead', column: 'resize', next, file: finalPath, ts: Date.now() });
        const PB = window.PipelineBoard;
        if (PB) {
          if (typeof PB.save === 'function') PB.save();
          if (typeof PB.render === 'function') PB.render();
          if (typeof PB.logEvent === 'function') {
            PB.logEvent({
              category: 'pipeline', result: 'ok',
              headline: `Pipeline resize→upscale: ${item.name} → ${finalPath.split(/[\\/]/).pop()}`,
              details: [`Item: ${item.id}`, `Output: ${finalPath}`],
            });
          }
        }
      } catch (_) { /* best-effort; the file is already on disk */ }
    };
    window.ResizeUpscaleDialog.maybeWarnUpscale({
      srcW: src.w, srcH: src.h, targetW: tw, targetH: th,
      srcPath: item.files.resize,
      onUpscaleDone,
      modalId: 'pipeline-resize-warning-' + item.id,
    }).then((choice) => {
      if (choice === 'proceed') PipelineOps.run(item);
      // 'upscale' → onUpscaleDone handles the write-back when the upscale
      //   dialog finishes. 'cancel' → abort (do nothing).
    }).catch(() => {
      // A genuine rejection (dialog infra failure), NOT a user cancel. Re-run
      // the plain resize so the user isn't left stuck. The 'cancel' choice is
      // a normal resolve (not a rejection), so it won't reach here.
      PipelineOps.run(item);
    });
  }

  window.PipelineCardResizeCheck = { runWithResizeCheck };
})();
