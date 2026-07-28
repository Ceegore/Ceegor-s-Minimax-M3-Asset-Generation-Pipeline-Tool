// renderer/overlays/imageEditorCheatsheet.js (pixel editor)
// The shortcut cheatsheet + help popover (the editor's "?" button). Extracted
// from imageEditorOverlay.js to keep that module under the 500-line lint cap.
// Uses showModal so it stacks on top of the editor and inherits Esc-close.

(function () {
  'use strict';

  // Render a registry-backed help "?" button (uses section23's helpButton if present).
  function helpButtonFor(topic) {
    if (typeof window.helpButton === 'function') return window.helpButton(topic);
    return el('span', { style: 'color:var(--accent);' }, '?');
  }

  function openCheatsheet() {
    const rows = [
      ['B', 'Brush'], ['A', 'Spray / airbrush'], ['E', 'Eraser (to transparency)'],
      ['I', 'Pipette (color picker)'], ['V', 'Move / select'], ['H', 'Heal (select region)'],
      ['M', 'Marquee selection (persistent — used by Heal)'],
      ['L', 'Bar / line (click start, click end; drag endpoints to edit)'],
      ['Space (hold)', 'Pan'], ['Wheel', 'Zoom (to cursor)'], ['[ / ]', 'Brush size − / +'],
      ['X', 'Swap FG/BG colors'], ['D', 'Reset colors (black/white)'],
      ['Ctrl+Z', 'Undo'], ['Ctrl+Y / Ctrl+Shift+Z', 'Redo'], ['Ctrl+S', 'Save'],
      ['Ctrl+0', 'Fit on screen'], ['Ctrl+1', 'Actual pixels (100%)'],
      ['Enter', 'Apply transform'], ['Esc', 'Cancel transform / close'],
    ];
    showModal((m, close) => {
      m.style.width = 'min(520px, 92vw)';
      m.appendChild(el('h2', {}, '⌨ Image editor — shortcuts'));
      const grid = el('div', { class: 'shortcut-list', style: 'display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;margin:8px 0 14px;' });
      for (const [k, lbl] of rows) {
        grid.appendChild(el('span', { style: 'font-family:monospace;color:var(--accent);' }, k));
        grid.appendChild(el('span', { style: 'color:var(--fg-2);' }, lbl));
      }
      m.appendChild(grid);
      m.appendChild(el('div', { style: 'font-size:12px;color:var(--fg-2);margin-top:10px;' }, [
        'More: hover the ', helpButtonFor('editor.intro'), ' icons next to each feature for detailed help.',
      ]));
      m.appendChild(el('div', { class: 'footer' }, [el('button', { class: 'primary', onclick: close }, 'Close')]));
    }, { id: 'ie-cheatsheet' });
  }

  window.ImageEditorCheatsheet = { openCheatsheet, helpButtonFor };
})();
