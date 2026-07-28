// renderer/utils/aspectLink.js
// Shared helpers for the GIMP/Photoshop "chain-link" aspect-ratio
// model used by the three resize surfaces (Pipeline Resize column, right-click
// Optimize overlay, image editor). All three build the same W×H + 🔗 UI, so the
// math + DOM-wiring lives here once.
//
// Behaviour (matches GIMP Image→Scale Image / Photoshop Image Size with the
// chain locked):
//   - LINKED (default): editing one field recomputes the other from the source
//     aspect ratio so the output pair always preserves AR (no distortion, no
//     padding — every output pixel is image content).
//   - UNLINKED: W and H are independent (force exact W×H; the engine uses
//     fit:'fill' so a mismatched AR distorts — the documented behaviour).
//
// The source dims are read from `getSrcDims()` so each surface can supply its
// own (pipeline card uses item._dims; the editor uses session.imgW/imgH).

(function () {
  'use strict';

  // Recompute the "other" axis to preserve AR, given the just-edited value.
  // srcDims = {w,h}; editedKey = 'w'|'h'; value = the new number.
  // Returns {width,height} with both filled (0 where undefined). Rounds to int.
  function linkedPair(srcDims, editedKey, value) {
    // Normalise the key so 'W'/'H'/'' behave like 'w'/'h'. A case-sensitive
    // check would make an uppercase 'W' silently take the height branch.
    const key = String(editedKey || '').toLowerCase() === 'h' ? 'h' : 'w';
    const out = { width: 0, height: 0 };
    if (!srcDims || !srcDims.w || !srcDims.h) {
      // No source dims yet → can't compute AR; keep what the user typed.
      out[key === 'w' ? 'width' : 'height'] = Math.max(0, Math.floor(Number(value) || 0));
      return out;
    }
    const ar = srcDims.w / srcDims.h;
    const v = Math.max(0, Math.floor(Number(value) || 0));
    if (key === 'w') {
      out.width = v;
      out.height = v > 0 ? Math.max(1, Math.round(v / ar)) : 0;
    } else {
      out.height = v;
      out.width = v > 0 ? Math.max(1, Math.round(v * ar)) : 0;
    }
    return out;
  }

  // Is this resize a large enlargement? Used by the upscale-warning popup
  // (fires at >120% on either axis). Pure helper so it's testable without DOM.
  function isLargeUpscale(srcDims, target) {
    if (!srcDims || !srcDims.w || !srcDims.h) return false;
    if (!target || !target.width || !target.height) return false;
    const pctW = target.width / srcDims.w;
    const pctH = target.height / srcDims.h;
    return pctW > 1.2 || pctH > 1.2;
  }

  // Increase percentage (for the popup copy). Returns the larger of the two
  // axis increases, rounded to a whole percent, or 0 when not an enlargement.
  function upscalePercent(srcDims, target) {
    if (!isLargeUpscale(srcDims, target)) return 0;
    const pctW = Math.round((target.width / srcDims.w) * 100);
    const pctH = Math.round((target.height / srcDims.h) * 100);
    return Math.max(pctW, pctH);
  }

  // Build a 🔗 chain toggle button. onClick(linked) is called with the new
  // state. Returns the button element; its `linked` property tracks state.
  function buildChainToggle(initialLinked, onChange) {
    const btn = el('button', {
      type: 'button',
      class: 'ar-chain-toggle',
      title: initialLinked
        ? 'Aspect ratio locked (default). Click to unlock W and H independently.'
        : 'Aspect ratio unlocked — W and H are independent (may distort). Click to lock.',
      style: 'padding: 2px 6px; font-size: 14px; line-height: 1; cursor: pointer;',
    }, initialLinked ? '🔗' : '🔓');
    btn.linked = !!initialLinked;
    btn.addEventListener('click', () => {
      btn.linked = !btn.linked;
      btn.textContent = btn.linked ? '🔗' : '🔓';
      btn.title = btn.linked
        ? 'Aspect ratio locked (default). Click to unlock W and H independently.'
        : 'Aspect ratio unlocked — W and H are independent (may distort). Click to lock.';
      if (typeof onChange === 'function') onChange(btn.linked);
    });
    return btn;
  }

  window.AspectLink = { linkedPair, isLargeUpscale, upscalePercent, buildChainToggle };
})();
