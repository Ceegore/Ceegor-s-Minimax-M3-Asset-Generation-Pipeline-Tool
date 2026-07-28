// renderer/pipeline/pipelineCardLastCrop.js
// Extracted H10-1: the "reuse last crop" label shown under a crop-column card.
//
// After the first crop of a session, a small clickable label is shown under
// each image element in the crop column. It displays the exact W×H used in
// the previous cropping task. Clicking it copies those dimensions into the
// card's crop settings and re-renders, so the user can crop many images to
// the same resolution quickly.
//
// The session memory lives on window._pipelineLastCrop (set by pipelineOps'
// doCrop on a successful crop) and is deliberately NOT persisted to
// state.json (per the "each session" requirement).
//
// Kept as a standalone module so pipelineCard.js stays within its frozen
// size budget.

(function () {
  'use strict';

  // Returns a DOM element for the label, or null when it should not be shown
  // (i.e. not the crop column, or no crop has run yet this session).
  function buildLastCropLabel(item, column) {
    if (column !== 'crop' || !window._pipelineLastCrop) return null;
    const lc = window._pipelineLastCrop;
    const label = el('div', {
      class: 'pipeline-card-lastcrop',
      title: 'Click to apply the previous crop dimensions to this image',
    }, `↩ Last crop: ${lc.w}×${lc.h}`);
    label.addEventListener('click', () => {
      item.settings = item.settings || {};
      item.settings.crop = item.settings.crop || {};
      item.settings.crop.w = lc.w;
      item.settings.crop.h = lc.h;
      // Anchor mode keeps the existing anchor selection; only the dims are
      // reused. Drop any stale drag-frame offset so the anchor applies.
      if (item.settings.crop.mode === 'drag') item.settings.crop.mode = 'anchor';
      const PB = window.PipelineBoard;
      if (PB) {
        if (typeof PB.save === 'function') PB.save();
        if (typeof PB.render === 'function') PB.render();
      }
    });
    return label;
  }

  window.PipelineCardLastCrop = { buildLastCropLabel };
})();
