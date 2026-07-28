// renderer/components/CropFrameDrag.js
// Drag handler for the crop frame in the image-pipeline dialog.
// Pure function, no app-state coupling.

/**
 * Makes the crop frame draggable, constrained to the image bounds.
 * `displayScale` is the image-pixel to display-pixel ratio
 * (1.0 = no scaling). When the image is rendered smaller than its
 * natural size, CSS values are in display pixels, but the bounds
 * checks and the returned position value are in image pixels.
 * Conversion happens at the boundary.
 *
 * @param {HTMLElement} frame            The frame element to drag
 * @param {HTMLElement} stage            Stage container (for bounds)
 * @param {() => number} getImageW      Image width in pixels
 * @param {() => number} getImageH      Image height in pixels
 * @param {(x: number, y: number) => void} [onMove]
 *   Optional callback with the new position in image pixels
 * @param {number} [displayScale=1]
 */
function setupCropFrameDrag(frame, stage, getImageW, getImageH, onMove, displayScale = 1) {
  let dragging = false;
  let startX, startY, frameStartImgX, frameStartImgY;
  function onDown(e) {
    e.preventDefault();
    dragging = true;
    const pt = e.touches ? e.touches[0] : e;
    startX = pt.clientX; startY = pt.clientY;
    // The frame's CSS left/top is in display pixels. Convert to
    // image pixels so the move deltas below are in the right space.
    frameStartImgX = Math.round((parseInt(frame.style.left, 10) || 0) / displayScale);
    frameStartImgY = Math.round((parseInt(frame.style.top, 10) || 0) / displayScale);
    document.addEventListener('mousemove', onMv);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMv, { passive: false });
    document.addEventListener('touchend', onUp);
    // If the user presses Esc while holding the mouse, mouseup never
    // fires and the four document listeners (plus their captured
    // closures) leak for the lifetime of the page. A one-time keydown
    // listener calls onUp() so the listeners are cleaned up before the
    // modal's Esc handler removes the modal from the DOM.
    document.addEventListener('keydown', onEscDuringDrag);
  }
  function onEscDuringDrag(e) {
    if (e.key === 'Escape' && dragging) {
      onUp();
      // onUp removes us via the cleanup below.
    }
  }
  function onMv(e) {
    if (!dragging) return;
    e.preventDefault && e.preventDefault();
    const pt = e.touches ? e.touches[0] : e;
    const dx = pt.clientX - startX;
    const dy = pt.clientY - startY;
    // Frame size in image pixels = CSS size / displayScale.
    const w = Math.round((parseInt(frame.style.width, 10) || 1) / displayScale);
    const h = Math.round((parseInt(frame.style.height, 10) || 1) / displayScale);
    const iw = getImageW() || 1;
    const ih = getImageH() || 1;
    // Convert display-pixel mouse deltas to image pixels.
    const dImgX = Math.round(dx / displayScale);
    const dImgY = Math.round(dy / displayScale);
    let nx = Math.max(0, Math.min(frameStartImgX + dImgX, iw - w));
    let ny = Math.max(0, Math.min(frameStartImgY + dImgY, ih - h));
    // Write back as display pixels.
    frame.style.left = (nx * displayScale) + 'px';
    frame.style.top = (ny * displayScale) + 'px';
    if (onMove) onMove(nx, ny);
  }
  function onUp() {
    dragging = false;
    document.removeEventListener('mousemove', onMv);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMv);
    document.removeEventListener('touchend', onUp);
    // Also remove the Esc-during-drag listener.
    document.removeEventListener('keydown', onEscDuringDrag);
  }
  frame.addEventListener('mousedown', onDown);
  frame.addEventListener('touchstart', onDown, { passive: false });
}

window.CropFrameDrag = { setupCropFrameDrag };
