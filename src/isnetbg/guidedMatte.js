// src/isnetbg/guidedMatte.js
// Issue 6 (bg-removal quality): image-guided matte refinement + foreground
// color estimation. These are the two post-processing stages the reference
// tools (rembg --alpha-matting, withoutbg) apply that our pipeline lacked:
//
//   guidedFilterAlpha — a full-color Guided Filter (He et al., ECCV'10) run
//       at SOURCE resolution with the original RGB as the guide and the
//       bicubic-upsampled model matte as the input. The model only sees a
//       1024×1024 downscale, so its upsampled matte transitions are blurry
//       and content-blind; the guided filter snaps those transitions onto
//       the actual color edges of the full-res image (it is the O(n)
//       linear-time approximation of the closed-form matting Laplacian).
//       Interior-safe by construction: where the matte is constant in a
//       window, cov(I,p)=0 ⇒ a=0, b=mean(p) ⇒ output == input.
//
//   estimateForeground — alpha-weighted multi-scale foreground color
//       estimation (the cheap cousin of pymatting's estimate_foreground_ml):
//       F ≈ blur(α·I, r) / blur(α, r) evaluated at doubling radii, taking
//       for each semi-transparent pixel the smallest radius with enough
//       opaque support. Replaces the RGB under 0<α<thresh pixels so a
//       straight-alpha composite can't resurrect the old background as a
//       halo — smoother and more faithful than the previous nearest-opaque
//       dilation.
//
// All functions are pure (typed arrays + numbers): no ONNX, no sharp, no
// DOM — unit-testable in plain Node. `rgba` is Uint8ClampedArray w*h*4,
// `alpha` is Float32Array w*h in [0,1].

'use strict';

// ---- separable O(n) box mean over a Float32Array plane ----
// Running-sum box filter with clamped edges; window = 2r+1 per axis.
// Same numeric scheme as maskPost.feather's blur, kept local so this
// module stays dependency-free.
function boxMean(src, w, h, r) {
  const win = 2 * r + 1;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.max(0, Math.min(w - 1, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win;
      const outIdx = row + Math.max(0, Math.min(w - 1, x - r));
      const inIdx = row + Math.max(0, Math.min(w - 1, x + r + 1));
      acc += src[inIdx] - src[outIdx];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[x + w * Math.max(0, Math.min(h - 1, k))];
    for (let y = 0; y < h; y++) {
      out[x + y * w] = acc / win;
      const outIdx = x + w * Math.max(0, Math.min(h - 1, y - r));
      const inIdx = x + w * Math.max(0, Math.min(h - 1, y + r + 1));
      acc += tmp[inIdx] - tmp[outIdx];
    }
  }
  return out;
}

// Default guided-filter radius: ~0.4% of the shorter side, min 2 px.
// At the model's native 1024 that is 4 px; on a 4k photo ~16 px — wide
// enough to cover the blur band bicubic upsampling introduces, narrow
// enough not to bleed the matte across unrelated structures.
function autoRadius(w, h) {
  return Math.max(2, Math.round(Math.min(w, h) / 256));
}

// ---- full-color Guided Filter (He et al.) ----
// I = rgb of `rgba` (normalized to [0,1]), p = alpha. Solves the 3×3 system
//   (Σ + εU) a_k = cov(I,p)   per window, then q = mean(a)·I + mean(b).
// Returns a NEW Float32Array clamped to [0,1]. On degenerate input
// (mismatched sizes) returns a copy of `alpha` unchanged.
function guidedFilterAlpha(rgba, alpha, w, h, opts) {
  opts = opts || {};
  const n = w * h;
  if (!rgba || rgba.length < n * 4 || !alpha || alpha.length < n || n === 0) {
    return alpha ? alpha.slice() : new Float32Array(0);
  }
  const r = Math.max(1, Math.round(opts.radius != null ? opts.radius : autoRadius(w, h)));
  const eps = opts.eps != null ? opts.eps : 1e-4;

  // Split guide into [0,1] channel planes.
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    R[i] = rgba[i * 4] / 255;
    G[i] = rgba[i * 4 + 1] / 255;
    B[i] = rgba[i * 4 + 2] / 255;
  }
  const meanR = boxMean(R, w, h, r), meanG = boxMean(G, w, h, r), meanB = boxMean(B, w, h, r);
  const meanP = boxMean(alpha, w, h, r);

  // Cross/auto second moments (E[xy]); covariances follow below.
  const mul = (a, b) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i] * b[i]; return o; };
  const meanRP = boxMean(mul(R, alpha), w, h, r);
  const meanGP = boxMean(mul(G, alpha), w, h, r);
  const meanBP = boxMean(mul(B, alpha), w, h, r);
  const meanRR = boxMean(mul(R, R), w, h, r), meanRG = boxMean(mul(R, G), w, h, r), meanRB = boxMean(mul(R, B), w, h, r);
  const meanGG = boxMean(mul(G, G), w, h, r), meanGB = boxMean(mul(G, B), w, h, r), meanBB = boxMean(mul(B, B), w, h, r);

  const aR = new Float32Array(n), aG = new Float32Array(n), aB = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // cov(I,p) vector and Σ+εU (symmetric 3×3).
    const cRP = meanRP[i] - meanR[i] * meanP[i];
    const cGP = meanGP[i] - meanG[i] * meanP[i];
    const cBP = meanBP[i] - meanB[i] * meanP[i];
    const s00 = meanRR[i] - meanR[i] * meanR[i] + eps;
    const s01 = meanRG[i] - meanR[i] * meanG[i];
    const s02 = meanRB[i] - meanR[i] * meanB[i];
    const s11 = meanGG[i] - meanG[i] * meanG[i] + eps;
    const s12 = meanGB[i] - meanG[i] * meanB[i];
    const s22 = meanBB[i] - meanB[i] * meanB[i] + eps;
    // Cramer's-rule inverse (matrix is SPD thanks to +εU, det > 0).
    const c00 = s11 * s22 - s12 * s12;
    const c01 = s02 * s12 - s01 * s22;
    const c02 = s01 * s12 - s02 * s11;
    const det = s00 * c00 + s01 * c01 + s02 * c02;
    const inv = det !== 0 ? 1 / det : 0;
    const c11 = s00 * s22 - s02 * s02;
    const c12 = s01 * s02 - s00 * s12;
    const c22 = s00 * s11 - s01 * s01;
    aR[i] = (c00 * cRP + c01 * cGP + c02 * cBP) * inv;
    aG[i] = (c01 * cRP + c11 * cGP + c12 * cBP) * inv;
    aB[i] = (c02 * cRP + c12 * cGP + c22 * cBP) * inv;
    b[i] = meanP[i] - aR[i] * meanR[i] - aG[i] * meanG[i] - aB[i] * meanB[i];
  }
  const mAR = boxMean(aR, w, h, r), mAG = boxMean(aG, w, h, r), mAB = boxMean(aB, w, h, r), mB = boxMean(b, w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const q = mAR[i] * R[i] + mAG[i] * G[i] + mAB[i] * B[i] + mB[i];
    out[i] = q < 0 ? 0 : (q > 1 ? 1 : q);
  }
  return out;
}

// ---- alpha-weighted multi-scale foreground color estimation ----
// For every pixel with alpha < opaqueThresh, estimate the true foreground
// color as blur(α·I, r) / blur(α, r), doubling r until the local opaque
// support passes `minSupport`. Pixels resolved at a small radius keep the
// tight local estimate; only isolated ones fall back to the wide blur.
// Returns a NEW rgba buffer; alpha bytes are left untouched (the caller
// writes the final matte separately).
function estimateForeground(rgba, alpha, w, h, opts) {
  opts = opts || {};
  const opaqueThresh = opts.opaqueThresh != null ? opts.opaqueThresh : 0.9;
  const minSupport = opts.minSupport != null ? opts.minSupport : 0.05;
  const n = w * h;
  if (!rgba || rgba.length < n * 4 || !alpha || alpha.length < n || n === 0) return rgba;
  const out = Uint8ClampedArray.from(rgba);

  // Premultiplied planes: α·R, α·G, α·B (in [0,1]) + α itself.
  const pr = new Float32Array(n), pg = new Float32Array(n), pb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    pr[i] = (rgba[i * 4] / 255) * a;
    pg[i] = (rgba[i * 4 + 1] / 255) * a;
    pb[i] = (rgba[i * 4 + 2] / 255) * a;
  }
  // Unresolved set: semi/fully-transparent pixels needing a color donor.
  const pending = new Uint8Array(n);
  let pendingCount = 0;
  for (let i = 0; i < n; i++) {
    if (alpha[i] < opaqueThresh) { pending[i] = 1; pendingCount++; }
  }
  if (pendingCount === 0) return out;

  const maxR = Math.max(w, h);
  for (let r = 2; ; r *= 2) {
    const br = boxMean(pr, w, h, r), bg = boxMean(pg, w, h, r), bb = boxMean(pb, w, h, r);
    const ba = boxMean(alpha, w, h, r);
    const last = r >= maxR;
    for (let i = 0; i < n; i++) {
      if (!pending[i]) continue;
      // Enough opaque mass in this window (or final pass: take anything > 0).
      if (ba[i] > minSupport || (last && ba[i] > 1e-6)) {
        out[i * 4] = Math.round((br[i] / ba[i]) * 255);
        out[i * 4 + 1] = Math.round((bg[i] / ba[i]) * 255);
        out[i * 4 + 2] = Math.round((bb[i] / ba[i]) * 255);
        pending[i] = 0;
        pendingCount--;
      }
    }
    if (pendingCount === 0 || last) break;
  }
  return out;
}

module.exports = { boxMean, autoRadius, guidedFilterAlpha, estimateForeground };
