// renderer/widgets/spinner.js
// H11-1: tiny shared helpers for the "action is running" loading UI, so the
// pattern (a spinner glyph + an indeterminate shimmer bar, optional status
// text) isn't copy-pasted across the pipeline, the batch overlay, and the
// single-file ops.
//
// All markup is styled by the existing `.spinner` rule + the new
// `.progress-bar` / `.progress-bar-indeterminate` rules in styles.css.

(function () {
  'use strict';

  // A small spinning glyph (uses the existing .spinner CSS animation).
  function spinnerSvg() {
    return el('span', { class: 'spinner', 'aria-hidden': 'true' });
  }

  // Build an indeterminate shimmer progress bar (unknown ETA, e.g. IS-Net
  // which has no per-step callback). Returns the bar element.
  function indeterminateBar() {
    return el('div', { class: 'progress-bar progress-bar-indeterminate' },
      el('div', { class: 'progress-bar-shimmer' }));
  }

  // Build a determinate progress bar with a known fraction. `pct` is 0..100.
  // Returns { bar, fill, set(pct) } so the caller can update it live.
  function determinateBar(pct) {
    const fill = el('div', { class: 'progress-bar-fill' });
    const bar = el('div', { class: 'progress-bar progress-bar-determinate' }, fill);
    function set(v) {
      const p = Math.max(0, Math.min(100, Number(v) || 0));
      fill.style.width = p.toFixed(1) + '%';
    }
    set(pct == null ? 0 : pct);
    return { bar, fill, set };
  }

  // Convenience: a labeled busy row — `<spinner> <label>` — for inline use
  // (e.g. a button's "Working…" state, the editor's status line).
  function busyRow(label) {
    return el('span', { class: 'busy-row' }, [spinnerSvg(), ' ', el('span', { class: 'busy-row-label' }, label || 'Working…')]);
  }

  window.Spinner = { spinnerSvg, indeterminateBar, determinateBar, busyRow };
})();
