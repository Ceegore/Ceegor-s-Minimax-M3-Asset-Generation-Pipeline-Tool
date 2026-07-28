// renderer/overlays/cropPreviewGeometry.js
// Extracted H10-3.1: pure geometry helper for the upscale dialog's
// "Anchor / crop preview" stage.
//
// The preview stage used to be a fixed 200×150 landscape box, which forced a
// square or portrait source into a landscape frame and made picking the best
// crop area misleading. This helper picks stage dimensions from a max box
// (default 220×165) keeping the source's real aspect ratio, so a square
// source → square stage, a portrait source → portrait stage, etc.
//
// Kept as a standalone pure module so section07 stays within its frozen size
// budget.

(function () {
  'use strict';

  /**
   * Compute the on-screen stage size for the crop preview.
   * @param {number} srcW  source image width (px)
   * @param {number} srcH  source image height (px)
   * @param {{maxW?:number, maxH?:number}} [maxBox]  the bounding box (defaults to 220×165)
   * @returns {{stageW:number, stageH:number}} integer pixel stage dimensions
   *         that match the source aspect ratio and fit inside the max box.
   */
  function computeStageSize(srcW, srcH, maxBox) {
    const MAX_W = (maxBox && maxBox.maxW) || 220;
    const MAX_H = (maxBox && maxBox.maxH) || 165;
    const aspect = srcW / Math.max(1, srcH);
    let stageW, stageH;
    if (aspect >= MAX_W / MAX_H) {
      // Source is wider than the max box → fill width.
      stageW = MAX_W;
      stageH = Math.round(MAX_W / aspect);
    } else {
      stageH = MAX_H;
      stageW = Math.round(MAX_H * aspect);
    }
    return { stageW, stageH };
  }

  window.CropPreviewGeometry = { computeStageSize };
})();
