// renderer/pipeline/pipelineCardDragFrame.js
// Extracted Issue 5: the crop column's "Drag frame" button.
//
// The button opens the shared crop overlay on the card's current file and
// writes the chosen rect back into the item's crop settings (mode:'drag').
// It is rendered BESIDE the ⚙ Settings toggle (in the settings header row,
// on its right) rather than inside the collapsible settings panel, so it is
// reachable without first expanding the panel.
//
// Kept as a standalone module so pipelineCard.js stays within its frozen
// size budget.

(function () {
  'use strict';

  // Returns the "Drag frame" button for a crop-column card. `resolved` is
  // the column's resolved settings (used to seed the overlay's frame rect).
  function buildDragFrameBtn(item, column, resolved) {
    const b = el('button', { type: 'button', class: 'pipeline-btn-card mini' }, '✂ Drag frame…');
    b.addEventListener('click', () => {
      if (typeof window.showCropOverlay === 'function') {
        const hasExplicitRect = resolved && (resolved.w > 0) && (resolved.h > 0);
        window.showCropOverlay(item.files[column], [item.files[column]], {
          w: hasExplicitRect ? resolved.w : undefined,
          h: hasExplicitRect ? resolved.h : undefined,
          x: hasExplicitRect ? resolved.x : undefined,
          y: hasExplicitRect ? resolved.y : undefined,
          modalId: 'pipeline-crop-' + item.id,
          onComplete: (x, y, w, h) => {
            item.settings.crop = item.settings.crop || {};
            item.settings.crop.mode = 'drag';
            item.settings.crop.x = x;
            item.settings.crop.y = y;
            item.settings.crop.w = w;
            item.settings.crop.h = h;
            const PB = window.PipelineBoard;
            if (PB) {
              if (typeof PB.save === 'function') PB.save();
              if (typeof PB.render === 'function') PB.render();
            }
          },
        });
      }
    });
    return b;
  }

  window.PipelineCardDragFrame = { buildDragFrameBtn };
})();
