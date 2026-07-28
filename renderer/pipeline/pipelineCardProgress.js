// renderer/pipeline/pipelineCardProgress.js
// Extracted H11-1B: progress-bar element for a running pipeline card.
//
// A running card shows a progress bar in place of (or beside) the static
// "⟳ working…" badge:
//   - Determinate (0..100%) when item._progress.pct is set (upscale streams
//     Real-ESRGAN stdout progress → IPC → this field).
//   - Indeterminate shimmer otherwise (IS-Net has no per-step callback).
//
// Kept as a standalone module so pipelineCard.js stays within its frozen size
// budget.

(function () {
  'use strict';

  // Module-level map to store progress bar setters out of persistent state
  // to avoid serialisation / structuredClone failures (EFH-001).
  const _progressSetters = new Map();

  // Returns a DOM element (a progress bar) for the card, or null when the card
  // isn't running.
  function buildProgressBar(item) {
    if (!item || item.status !== 'running') return null;
    const S = window.Spinner;
    if (!S) return null;
    delete item._progressSetter; // Clean up any legacy property
    const prog = item._progress;
    if (prog && typeof prog.pct === 'number' && prog.pct >= 0) {
      const det = S.determinateBar(prog.pct);
      const wrap = el('div', { class: 'pipeline-card-progress' }, [
        det.bar,
        el('div', { class: 'pipeline-card-progress-label' },
          (prog.label ? prog.label + ' · ' : '') + Math.max(0, Math.min(100, prog.pct)).toFixed(0) + '%'),
      ]);
      // Stash setter in module map instead of mutating persistent item state
      _progressSetters.set(item.id, det.set);
      return wrap;
    }
    // Indeterminate (no streaming source).
    const bar = S.indeterminateBar();
    return el('div', { class: 'pipeline-card-progress' }, [
      bar,
      el('div', { class: 'pipeline-card-progress-label' }, prog && prog.label ? prog.label : 'Working…'),
    ]);
  }

  // Update (or install) a determinate bar on an existing running card. Called
  // by the upscale-progress IPC handler. `pct` is 0..100.
  function applyProgress(item, pct, label, data) {
    if (!item || item.status !== 'running') return;
    if (data && typeof data.runGen === 'number' && typeof item._runGen === 'number' && data.runGen !== item._runGen) return;
    delete item._progressSetter; // Clean up legacy property
    item._progress = { pct: Math.max(0, Math.min(100, Number(pct) || 0)), label: label || item._progress?.label };
    const setter = _progressSetters.get(item.id);
    if (typeof setter === 'function') {
      setter(item._progress.pct);
      // Also update the label if the bar's wrapper is in the DOM.
      const card = document.querySelector(`.pipeline-card[data-card-id="${item.id}"] .pipeline-card-progress-label`);
      if (card) {
        card.textContent = (item._progress.label ? item._progress.label + ' · ' : '') + item._progress.pct.toFixed(0) + '%';
      }
    }
  }

  function clearProgressSetter(itemId) {
    _progressSetters.delete(itemId);
  }

  // EFH2-001 fix: reinstate the IPC subscriber that was deleted in the EFH-001
  // rewrite. Without this, Real-ESRGAN progress events are emitted by main but
  // never consumed — progress bars stay permanently indeterminate.
  let _wired = false;
  function wireProgressIpc() {
    if (_wired || !window.api || typeof window.api.onRealesrganProgress !== 'function') return;
    _wired = true;
    window.api.onRealesrganProgress((data) => {
      if (!data || !data.key) return;
      const board = window.state && window.state.pipeline && window.state.pipeline.image;
      if (!board || !Array.isArray(board.items)) return;
      const item = board.items.find((it) => it && it.id === data.key);
      if (!item) return;
      const hasSetter = _progressSetters.has(item.id);
      applyProgress(item, data.pct, item._progress && item._progress.label, data);
      // If no live setter exists yet (first determinate event before card
      // re-render), force a card rebuild so the indeterminate bar is replaced.
      if (!hasSetter && window.PipelineBoard && typeof window.PipelineBoard.updateCard === 'function') {
        window.PipelineBoard.updateCard(item);
      }
    });
  }

  window.PipelineCardProgress = {
    buildProgressBar,
    applyProgress,
    clearProgressSetter,
    wireProgressIpc,
  };
})();
