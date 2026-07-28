// src/isnetbg/maskPost.js
// Pure post-processing for the background-removal alpha matte (H8-008).
// The upsampled matte used to be written 1:1 as alpha, so single stray blobs,
// pinholes, and background-colored fringes survived on every image. This module
// applies, all default-ON:
//   - cleanup:  binarize at 0.5 → connected components → drop alpha islands
//               < min(max(64, 0.02% of pixels), cap), and fill equally tiny holes.
//   - feather:  1px separable box blur on the matte (anti-jaggies; keeps BiRefNet's
//               soft edges intact).
//   - defringe: for pixels with 0 < α < 0.9, replace RGB with the nearest-opaque-
//               neighbor color (iterative dilate of opaque colors) so composites
//               can't resurrect the old background — the big win for the editor.
//
// All functions are pure (typed arrays + plain numbers) so they are unit-testable
// without ONNX/sharp/DOM. `rgba` is a Uint8ClampedArray of length w*h*4 (R,G,B,A).
// `alpha` is a Float32Array of length w*h with values in [0,1].

'use strict';

// Issue 6: image-guided refinement + foreground estimation live in their own
// module (pure, dependency-free) — see guidedMatte.js for the rationale.
const guidedMatte = require('./guidedMatte');

// ---- connected-components island / hole cleanup ----
// Returns a NEW Float32Array (length w*h). Binarizes at 0.5, drops fg islands
// smaller than minIslandPx, fills bg holes smaller than minHolePx.
function cleanupIslandsHoles(alpha, w, h, opts) {
  opts = opts || {};
  const minIslandPx = Math.max(1, Math.round(opts.minIslandPx != null ? opts.minIslandPx : 64));
  const minHolePx = Math.max(1, Math.round(opts.minHolePx != null ? opts.minHolePx : 64));
  const n = w * h;
  if (!alpha || alpha.length < n) return alpha ? alpha.slice() : new Float32Array(n);
  const fg = new Uint8Array(n); // 1 = foreground (opaque subject)
  for (let i = 0; i < n; i++) fg[i] = alpha[i] >= 0.5 ? 1 : 0;

  const visited = new Uint8Array(n);
  const stack = [];
  // 4-neighbor flood fill from (startIdx), collecting the component's indices.
  function flood(startIdx, label /* 'fg' | 'bg' */) {
    const want = label === 'fg' ? 1 : 0;
    const comp = [];
    stack.length = 0;
    stack.push(startIdx);
    visited[startIdx] = 1;
    while (stack.length) {
      const idx = stack.pop();
      comp.push(idx);
      const x = idx % w, y = (idx / w) | 0;
      // 4-neighbors
      if (x > 0) { const ni = idx - 1; if (!visited[ni] && fg[ni] === want) { visited[ni] = 1; stack.push(ni); } }
      if (x < w - 1) { const ni = idx + 1; if (!visited[ni] && fg[ni] === want) { visited[ni] = 1; stack.push(ni); } }
      if (y > 0) { const ni = idx - w; if (!visited[ni] && fg[ni] === want) { visited[ni] = 1; stack.push(ni); } }
      if (y < h - 1) { const ni = idx + w; if (!visited[ni] && fg[ni] === want) { visited[ni] = 1; stack.push(ni); } }
    }
    return comp;
  }

  const out = alpha.slice();
  // Drop small foreground islands.
  visited.fill(0);
  for (let i = 0; i < n; i++) {
    if (fg[i] === 1 && !visited[i]) {
      const comp = flood(i, 'fg');
      if (comp.length < minIslandPx) {
        for (const idx of comp) out[idx] = 0; // erase the stray island
      }
    }
  }
  // Fill small background holes (re-mark visited for bg sweep).
  visited.fill(0);
  for (let i = 0; i < n; i++) {
    if (fg[i] === 0 && !visited[i]) {
      const comp = flood(i, 'bg');
      if (comp.length < minHolePx) {
        for (const idx of comp) out[idx] = 1; // fill the tiny hole
      }
    }
  }
  return out;
}

// ---- 1px separable box blur (feather) ----
// Anti-jaggies without destroying BiRefNet's soft edges. In-place over a copy.
function feather(alpha, w, h, radius) {
  const r = Math.max(0, Math.round(radius != null ? radius : 1));
  if (r <= 0 || !alpha || alpha.length < w * h) return alpha ? alpha.slice() : new Float32Array(0);
  const tmp = alpha.slice();
  const out = alpha.slice();
  // Horizontal pass.
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    // prime with clamped left edge
    for (let k = -r; k <= r; k++) acc += alpha[row + Math.max(0, Math.min(w - 1, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win;
      const xOut = x - r, xIn = x + r + 1;
      const outIdx = row + Math.max(0, Math.min(w - 1, xOut));
      const inIdx = row + Math.max(0, Math.min(w - 1, xIn));
      acc += alpha[inIdx] - alpha[outIdx];
    }
  }
  // Vertical pass over tmp → out.
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[x + w * Math.max(0, Math.min(h - 1, k))];
    for (let y = 0; y < h; y++) {
      out[x + y * w] = acc / win;
      const yOut = y - r, yIn = y + r + 1;
      const outIdx = x + w * Math.max(0, Math.min(h - 1, yOut));
      const inIdx = x + w * Math.max(0, Math.min(h - 1, yIn));
      acc += tmp[inIdx] - tmp[outIdx];
    }
  }
  return out;
}

// ---- color de-fringe ----
// For every pixel with 0 < a < 0.9, replace its RGB with the nearest opaque
// neighbor's RGB (iterative morphological dilation of opaque colors). This stops
// straight-alpha composites from leaking the original background colour back in
// as a halo. Operates on the rgba byte buffer + the cleaned alpha. In-place on a
// copy.
function defringe(rgba, alpha, w, h, opts) {
  opts = opts || {};
  const opaqueThresh = opts.opaqueThresh != null ? opts.opaqueThresh : 0.9;
  const maxPasses = Math.max(1, Math.round(opts.passes || 8));
  const n = w * h;
  if (!rgba || rgba.length < n * 4 || !alpha || alpha.length < n) return rgba;

  // Work on a copy so the source is untouched.
  const out = Uint8ClampedArray.from(rgba);
  // opaqueMask: 1 where alpha >= opaqueThresh (a "source" colour donor).
  const opaqueMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) opaqueMask[i] = alpha[i] >= opaqueThresh ? 1 : 0;

  // Iteratively push opaque colours outwards into semi-transparent pixels. Each
  // pass advances the donor frontier by one pixel; a pixel receiving a colour
  // becomes a donor for the next pass.
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    // Snapshot donors at the start of the pass so each pass is a clean dilation.
    const donors = Uint8ClampedArray.from(out);
    const donorMask = Uint8Array.from(opaqueMask);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (donorMask[i]) continue; // already a donor
        // Find the nearest donor among 4-neighbours (donorMask snapshot).
        let di = -1;
        if (x > 0 && donorMask[i - 1]) di = i - 1;
        else if (x < w - 1 && donorMask[i + 1]) di = i + 1;
        else if (y > 0 && donorMask[i - w]) di = i - w;
        else if (y < h - 1 && donorMask[i + w]) di = i + w;
        if (di >= 0) {
          out[i * 4] = donors[di * 4];
          out[i * 4 + 1] = donors[di * 4 + 1];
          out[i * 4 + 2] = donors[di * 4 + 2];
          opaqueMask[i] = 1;
          changed = true;
        }
      }
    }
    if (!changed) break; // frontier stopped — no more semi-transparent pixels reachable
  }
  return out;
}

// Convenience: run the full default pipeline. `rgba` is modified in place (alpha
// channel overwritten from the post-processed matte); RGB is de-fringed.
// Returns the (same) rgba buffer.
function applyPost(rgba, alphaIn, w, h, opts) {
  opts = opts || {};
  const clean = opts.clean === false ? alphaIn : cleanupIslandsHoles(alphaIn, w, h, opts);
  // Issue 6: when `refine` is on, the content-blind 1px feather is replaced by
  // the full-color guided filter — it re-aligns the upsampled matte's blurry
  // transition band with the actual color edges of the source image (feather
  // is skipped: the filter output is already smooth).
  let matte;
  if (opts.refine) {
    matte = guidedMatte.guidedFilterAlpha(rgba, clean, w, h, { radius: opts.refineRadius, eps: opts.refineEps });
  } else {
    matte = opts.feather === 0 || opts.feather === false ? clean : feather(clean, w, h, opts.featherPx);
  }
  // Issue 6: with refine on, defringe via alpha-weighted foreground color
  // estimation (smooth, halo-free); classic dilation defringe otherwise.
  let rgb;
  if (opts.defringe === false) rgb = rgba;
  else if (opts.refine) rgb = guidedMatte.estimateForeground(rgba, matte, w, h, opts);
  else rgb = defringe(rgba, matte, w, h, opts);
  for (let i = 0; i < w * h; i++) {
    let a = matte[i];
    if (a < 0) a = 0; else if (a > 1) a = 1;
    rgb[i * 4 + 3] = Math.round(a * 255);
  }
  return rgb;
}

// Unique temp-file suffix (H7-023 parity): keeps parallel writes from colliding on
// the same pid+ms temp name. crypto.randomUUID isn't available in every Node the
// worker targets; randomBytes always is. The fallback uses another randomBytes
// call (we never want to fall back to a deterministic pid+Date.now() suffix
// — that is exactly the bug we are trying to avoid).
function tempSuffix(pid) {
  try {
    return require('crypto').randomBytes(6).toString('hex');
  } catch (_) {
    try {
      return require('crypto').randomBytes(6).toString('hex');
    } catch (__) {
      // Last-resort fallback: just use a process-scoped random seed + time.
      // Should never be reached in practice; the two randomBytes calls above
      // are deterministic and built into Node.
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
  }
}

module.exports = { cleanupIslandsHoles, feather, defringe, applyPost, tempSuffix };
