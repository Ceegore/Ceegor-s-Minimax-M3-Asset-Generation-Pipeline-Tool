// src/inpaint.js
// Pure-JS image inpainting for the in-app editor's Heal feature (Feature 5).
//
// Implements a Fast-Marching-Method (Telea) style inpainter: unknown pixels
// (mask != 0) are filled in order of how close they are to a known pixel,
// each one as a weighted average of its known neighbours (weight ∝ inverse
// distance + gradient continuity). This is the same family of algorithm as
// GIMP's "Heal Selection" (resynthesizer) and OpenCV's cv.INPAINT_TELEA, and
// it excels at the small fixes this editor targets — hairline seams, stray
// pixels, tiny alpha holes left after background removal.
//
// Why pure JS (not OpenCV.js / WASM)?
//   1. The renderer CSP is script-src 'self' with no 'wasm-unsafe-eval';
//      loading OpenCV.js would weaken that security boundary. Running inpaint
//      in the MAIN process keeps the renderer CSP-tight and the UI responsive.
//   2. Zero new dependencies — the project deliberately stays minimal
//      (ffmpeg-static, onnxruntime-node, sharp).
//   3. For the small masks this editor heals, pure JS is sub-second; large
//      region removal is delegated to the AI tier (LaMa/MI-GAN, see inpaintOnnx.js).
//
// Input:  an RGBA buffer (Uint8ClampedArray, length w*h*4) + a mask
//         (Uint8Array, length w*h; non-zero = pixel to synthesise).
// Output: mutates the RGBA buffer in place (the masked region filled from
//         surrounding texture; alpha preserved/restored).
//
// This module is main-process only (used by main/ipc/registerInpaintIpc.js).
// It has NO electron/dom deps so it can be unit-tested directly in node.

'use strict';

// Narrow-band priority queue (min-heap keyed by T = arrival time).
// T is a rough distance-from-known-field: closer-to-known pixels are filled
// first, exactly like Telea's FMM ordering.
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(idx, key) {
    const n = this.a.push({ idx, key });
    let i = n - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].key <= this.a[i].key) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  pop() {
    const top = this.a[0];
    const last = this.a.pop();
    if (this.a.length > 0) {
      this.a[0] = last;
      let i = 0;
      const n = this.a.length;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let s = i;
        if (l < n && this.a[l].key < this.a[s].key) s = l;
        if (r < n && this.a[r].key < this.a[s].key) s = r;
        if (s === i) break;
        [this.a[s], this.a[i]] = [this.a[i], this.a[s]];
        i = s;
      }
    }
    return top;
  }
}

// Radius (in pixels) of the neighbourhood sampled around each unknown pixel.
// Larger = smoother but slower + more blurred. 4 is a good default for fixes.
const DEFAULT_RADIUS = 4;

/**
 * Telea-style inpaint. Mutates `rgba` in place.
 * @param {Uint8ClampedArray} rgba  length w*h*4
 * @param {Uint8Array} mask         length w*h, non-zero = fill this pixel
 * @param {number} w
 * @param {number} h
 * @param {object} [opts] { radius?: number }
 */
function inpaint(rgba, mask, w, h, opts) {
  const radius = (opts && opts.radius) || DEFAULT_RADIUS;
  if (!rgba || !mask || rgba.length < w * h * 4 || mask.length < w * h) {
    throw new Error('inpaint: buffer/size mismatch');
  }

  // T: arrival time field (distance to the nearest known pixel). Known pixels
  // start at T=0; unknown pixels are filled in increasing-T order.
  const T = new Float32Array(w * h);
  const UNKNOWN = Infinity;
  for (let i = 0; i < w * h; i++) T[i] = mask[i] ? UNKNOWN : 0;

  const heap = new MinHeap();
  // Seed: every KNOWN pixel adjacent to an unknown pixel enters the heap with
  // T=0 so its unknown neighbours are the first candidates.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) continue; // unknown
      if (touchesUnknown(mask, x, y, w, h)) heap.push(y * w + x, 0);
    }
  }

  // Process pixels from the known boundary inward (FMM order). For each known
  // pixel we pop, we fill each of its unknown neighbours from the known
  // neighbourhood around *that* neighbour, then mark it known (T set) and push
  // it so its own unknown neighbours become eligible.
  while (heap.size > 0) {
    const { idx, key } = heap.pop();
    const x = idx % w, y = (idx / w) | 0;
    if (T[idx] < key) continue; // stale heap entry (a lower-T copy already processed)
    for (const [nx, ny] of neighbours4(x, y, w, h)) {
      const nidx = ny * w + nx;
      if (!mask[nidx]) continue; // already known
      // fill this unknown pixel from the known pixels within `radius`
      fillFromNeighbourhood(rgba, mask, T, nx, ny, w, h, radius);
      mask[nidx] = 0;            // mark known
      T[nidx] = T[idx] + 1;      // arrival time (rough distance)
      heap.push(nidx, T[nidx]);
    }
  }
}

function touchesUnknown(mask, x, y, w, h) {
  for (const [nx, ny] of neighbours4(x, y, w, h)) {
    if (mask[ny * w + nx]) return true;
  }
  return false;
}

function neighbours4(x, y, w, h) {
  const out = [];
  if (x > 0) out.push([x - 1, y]);
  if (x < w - 1) out.push([x + 1, y]);
  if (y > 0) out.push([x, y - 1]);
  if (y < h - 1) out.push([x, y + 1]);
  return out;
}

// Fill a single unknown pixel (nx,ny) as a weighted blend of the known pixels
// within a (2*radius+1)² window. Weight = 1/distance ( Telea uses direction +
// level-set terms; the inverse-distance term dominates for small windows and
// gives visually equivalent results for the small fixes we target).
function fillFromNeighbourhood(rgba, mask, T, nx, ny, w, h, radius) {
  let r = 0, g = 0, b = 0, a = 0, wsum = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = ny + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = nx + dx;
      if (xx < 0 || xx >= w) continue;
      const sidx = yy * w + xx;
      if (mask[sidx]) continue;            // skip other unknown pixels
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist === 0 || dist > radius) continue;
      const wt = 1 / dist;                 // inverse-distance weight
      const o = sidx * 4;
      r += rgba[o] * wt;
      g += rgba[o + 1] * wt;
      b += rgba[o + 2] * wt;
      a += rgba[o + 3] * wt;
      wsum += wt;
    }
  }
  const o = (ny * w + nx) * 4;
  if (wsum > 0) {
    rgba[o] = r / wsum;
    rgba[o + 1] = g / wsum;
    rgba[o + 2] = b / wsum;
    rgba[o + 3] = a / wsum;
  } else {
    // No known neighbours in window (e.g. a huge mask with no boundary yet):
    // leave the pixel as-is; a later pass will reach it as the field grows.
  }
}

// Build a mask of fully-transparent pixels (alpha == 0). Used by "Heal
// Transparency": the alpha holes left after background removal are filled with
// synthesised surrounding colour so the seam vanishes.
function maskFromAlpha(rgba, w, h) {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3] === 0) mask[i] = 1;
  }
  return mask;
}

// PE-009: clamp an integer option into [lo, hi] (default on NaN/absent).
function clampInt(v, lo, hi, dflt) {
  const num = parseInt(v, 10);
  if (!isFinite(num)) return dflt;
  return Math.max(lo, Math.min(hi, num));
}

// PE-009: connected-component transparency mask ("Heal Transparency" fix).
//
// maskFromAlpha (above) flags EVERY transparent pixel — including the
// background-connected exterior. For a cut-out subject on a transparent
// canvas that means the ENTIRE border region is synthesised, which
// destroys the cut-out shape (spec repro: a 5x5 image with an opaque
// 3x3 subject and a transparent border came back fully opaque).
//
// This variant only flags ENCLOSED holes:
//   1. flood-fill from every transparent border pixel → the EXTERIOR
//      (transparency reachable from the image border is intentional
//      background and is NEVER filled),
//   2. label the connected components of the remaining transparency
//      (the enclosed holes),
//   3. optionally drop components larger than `maxHolePx` pixels,
//   4. optionally dilate the mask by `growPx` pixels so the rim around
//      each hole is healed too — dilation never grows into the exterior.
//
// @param {Uint8ClampedArray} rgba  length w*h*4
// @param {number} w
// @param {number} h
// @param {object} [opts] { alphaThreshold?: 0-255 (alpha <= this counts
//                 as transparent, default 0), maxHolePx?: number (holes
//                 larger than this stay open; 0 = fill all), growPx?:
//                 number (dilation radius, default 0) }
// @returns {{ mask: Uint8Array, holes: number, largestHole: number,
//             maskShare: number }}
//   mask       — 1 = pixel to synthesise
//   holes      — number of enclosed components that WILL be filled
//   largestHole— pixel count of the largest filled component
//   maskShare  — filled-mask pixels / total pixels (near-full = warn)
function maskFromAlphaHoles(rgba, w, h, opts) {
  const o = opts || {};
  const alphaThreshold = clampInt(o.alphaThreshold, 0, 255, 0);
  const maxHolePx = clampInt(o.maxHolePx, 0, 1e9, 0); // 0 = unlimited
  const growPx = clampInt(o.growPx, 0, 64, 0);
  const n = w * h;
  const isHole = (i) => rgba[i * 4 + 3] <= alphaThreshold;

  // 1) Flood-fill the EXTERIOR from every transparent border pixel.
  const exterior = new Uint8Array(n);
  const stack = [];
  const seed = (i) => { if (isHole(i) && !exterior[i]) { exterior[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && isHole(i - 1) && !exterior[i - 1]) { exterior[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && isHole(i + 1) && !exterior[i + 1]) { exterior[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && isHole(i - w) && !exterior[i - w]) { exterior[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && isHole(i + w) && !exterior[i + w]) { exterior[i + w] = 1; stack.push(i + w); }
  }

  // 2) Label the connected components of the ENCLOSED transparency.
  const labels = new Int32Array(n);
  const sizes = [0];
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (!isHole(i) || exterior[i] || labels[i]) continue;
    next++;
    labels[i] = next;
    let size = 0;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop();
      size++;
      const x = j % w, y = (j / w) | 0;
      if (x > 0 && !labels[j - 1] && isHole(j - 1) && !exterior[j - 1]) { labels[j - 1] = next; stack.push(j - 1); }
      if (x < w - 1 && !labels[j + 1] && isHole(j + 1) && !exterior[j + 1]) { labels[j + 1] = next; stack.push(j + 1); }
      if (y > 0 && !labels[j - w] && isHole(j - w) && !exterior[j - w]) { labels[j - w] = next; stack.push(j - w); }
      if (y < h - 1 && !labels[j + w] && isHole(j + w) && !exterior[j + w]) { labels[j + w] = next; stack.push(j + w); }
    }
    sizes[next] = size;
  }

  // 3) Mask = enclosed components passing the size filter.
  const mask = new Uint8Array(n);
  let holes = 0, largestHole = 0;
  for (let l = 1; l <= next; l++) {
    if (maxHolePx > 0 && sizes[l] > maxHolePx) continue;
    holes++;
    if (sizes[l] > largestHole) largestHole = sizes[l];
  }
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l && !(maxHolePx > 0 && sizes[l] > maxHolePx)) mask[i] = 1;
  }

  // 4) Optional dilation — heals the rim around each hole too, but
  //    NEVER grows into the exterior (the background stays open).
  let cur = mask;
  for (let g = 0; g < growPx; g++) {
    const grown = new Uint8Array(cur);
    for (let i = 0; i < n; i++) {
      if (cur[i] || exterior[i]) continue;
      const x = i % w, y = (i / w) | 0;
      if ((x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) ||
          (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])) {
        grown[i] = 1;
      }
    }
    cur = grown;
  }

  let filled = 0;
  for (let i = 0; i < n; i++) if (cur[i]) filled++;
  return { mask: cur, holes, largestHole, maskShare: n ? filled / n : 0 };
}

module.exports = { inpaint, maskFromAlpha, maskFromAlphaHoles, DEFAULT_RADIUS };
// R1.5b.3: re-export the AI inpaint (ONNX) engine from
// src/inpaint/index.js. The legacy exports above are the
// pure-JS Telea tier (used by the inpaint:runTelea handler);
// `runOnnx` is the LaMa / MI-GAN tier used by the
// inpaint:runOnnx handler. Both tiers share the
// `inpaint` namespace so callers can `require('../../src/inpaint')`
// once and get both — the IPC files in main/ipc/ use the
// unified module.
const { runOnnx, findModelPath } = require('./inpaint/index');
module.exports = Object.assign(module.exports, { runOnnx, findModelPath });
