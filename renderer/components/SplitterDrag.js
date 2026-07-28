// renderer/components/SplitterDrag.js
// Drag-to-resize the three splitters declared in index.html (sidebar, logbar,
// log/preview split).
//
// The CSS + state plumbing already existed — styles.css reads
// --sidebar-w / --logbar-h / --preview-w / --log-w from :root, and
// state.layoutSettings.* is the persisted source of truth. This file wires the
// actual mousedown handler.
//
// This file:
//   1. Wires mousedown on every [data-splitter].
//   2. On drag, tracks pointer delta and writes the CSS variable that the
//      corresponding pane reads.
//   3. On mouseup, clamps the final value into [min, max] (the same bounds
//      the CSS uses), writes to state.layoutSettings, and schedules a state
//      save so the choice survives a restart.
//   4. Exposes `applyLayoutSettings()` which seeds the CSS variables from
//      state.layoutSettings — call it once at startup after the saved state is
//      loaded.
//
// No new dependencies — drag uses plain pointer events on `document` so the
// cursor keeps tracking even when the pointer leaves the 8-px handle.
//
// Splitter orientation comes from the `splitter-v` / `splitter-h` class
// already on the element (kept for the cursor styling styles.css relies on).

(function initSplitterDrag() {
  // Resolve DOM + state at click time so a renderer that loads
  // this file BEFORE section24_State.js / app.js still works.
  function getState() {
    return (typeof window !== 'undefined' && window.state) ? window.state : null;
  }

  // Map splitter id → (cssVar, stateKey, axis).
  // axis = 'x' means horizontal movement changes the width
  // (sidebar / preview / log columns).
  // axis = 'y' means vertical movement changes the height
  // (logbar row).
  const SPLITTERS = [
    { id: 'splitter-sidebar',    axis: 'x', cssVar: '--sidebar-w', stateKey: 'sidebarW' },
    { id: 'splitter-logbar',     axis: 'y', cssVar: '--logbar-h',  stateKey: 'logbarH'  },
    { id: 'splitter-log-preview',axis: 'x', cssVar: '--preview-w', stateKey: 'previewW' },
  ];

  // Bounds (must mirror the :root defaults in styles.css). MAX is finite for
  // every splitter (no pane should exceed 4K) so a dragged splitter can't
  // persist an out-of-range value that breaks the layout on the next launch.
  const MIN = { '--sidebar-w': 200, '--logbar-h': 80,  '--preview-w': 200 };
  const MAX = { '--sidebar-w': 3840, '--logbar-h': 2160, '--preview-w': 3840 };

  function getRoot() { return document.documentElement; }

  function readVar(name) {
    const v = getRoot().style.getPropertyValue(name);
    if (!v) return null;
    const m = v.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }
  function writeVar(name, px) {
    getRoot().style.setProperty(name, `${Math.round(px)}px`);
  }
  function clamp(name, px) {
    // MAX is finite for every registered splitter. Unknown variable names pass
    // through unchanged.
    if (MIN[name] == null && MAX[name] == null) return px;
    const lo = MIN[name] != null ? MIN[name] : 0;
    const hi = MAX[name] != null ? MAX[name] : Number.POSITIVE_INFINITY;
    return Math.max(lo, Math.min(hi, px));
  }

  // Pure helper exposed for tests + reuse.
  function clampLayout(name, px) { return clamp(name, px); }

  function applyLayoutSettings() {
    const s = getState();
    if (!s || !s.layoutSettings) return;
    const ls = s.layoutSettings;
    if (typeof ls.sidebarW === 'number') writeVar('--sidebar-w', clamp('--sidebar-w', ls.sidebarW));
    if (typeof ls.logbarH  === 'number') writeVar('--logbar-h',  clamp('--logbar-h',  ls.logbarH));
    if (typeof ls.previewW === 'number') writeVar('--preview-w', clamp('--preview-w', ls.previewW));
    // --log-w is the *remaining* width inside #logbar; leave it
    // at 1fr so flex handles it.
  }

  function attach(splitter) {
    const el = document.getElementById(splitter.id);
    if (!el) return;
    let startCoord = 0;
    let startVal = 0;
    let dragging = false;

    el.addEventListener('mousedown', (e) => {
      // Only the primary mouse button (left) should start a drag. Right-click
      // would also enter drag mode (in addition to firing the browser's
      // contextmenu), leaving a phantom drag active when the user dismisses the
      // context menu — the next left-click would then jump the splitter to
      // wherever the cursor was.
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startCoord = splitter.axis === 'x' ? e.clientX : e.clientY;
      startVal = readVar(splitter.cssVar) || 0;
      // Use a body class rather than setting document.body.style.cursor, which
      // the browser can silently drop (e.g. when the cursor leaves the body and
      // re-enters a child element). The class keeps the resize cursor stuck to
      // the entire body for the duration of the drag.
      document.body.classList.add(splitter.axis === 'x' ? 'resizing-width' : 'resizing-height');
      document.body.style.userSelect = 'none';
      // Add the .dragging class to the splitter itself so the visual hover
      // state stays on while the user drags (otherwise the hover fades the
      // moment the cursor leaves the 4-px handle).
      el.classList.add('dragging');
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const now = splitter.axis === 'x' ? e.clientX : e.clientY;
      const delta = now - startCoord;
      // Standard Windows convention: dragging the divider to the right makes the
      // divider follow the cursor (the LEFT pane grows, the RIGHT pane shrinks),
      // matching Windows Explorer. The subtraction (rather than addition) keeps
      // the divider tracking the cursor with the pane you're dragging towards
      // shrinking to make room.
      const next = clamp(splitter.cssVar, startVal - delta);
      writeVar(splitter.cssVar, next);
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing-width');
      document.body.classList.remove('resizing-height');
      document.body.style.userSelect = '';
      // Clear the per-splitter dragging class so the
      // hover state returns to its pre-drag visual.
      el.classList.remove('dragging');
      const final = readVar(splitter.cssVar);
      if (final == null) return;
      const s = getState();
      if (!s) return;
      s.layoutSettings = s.layoutSettings || {};
      s.layoutSettings[splitter.stateKey] = Math.round(final);
      // Persist — scheduleStateSave() is defined in app.js.
      if (typeof window.scheduleStateSave === 'function') {
        window.scheduleStateSave();
      }
    });
  }

  function init() {
    for (const sp of SPLITTERS) attach(sp);
    applyLayoutSettings();
  }

  // Expose for app.js to call after state load + for tests.
  window.SplitterDrag = {
    init,
    applyLayoutSettings,
    SPLITTERS,
    clampLayout,
  };

  // Run on DOMContentLoaded; safe even if the script loads
  // before the elements exist (we just no-op until they do).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();