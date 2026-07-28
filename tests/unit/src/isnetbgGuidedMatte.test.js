// tests/unit/src/isnetbgGuidedMatte.test.js
// Issue 6: unit tests for the guided-filter matte refinement + foreground
// color estimation (src/isnetbg/guidedMatte.js) and its wiring through
// maskPost.applyPost and the state sanitisers.
// Pure typed-array math — no ONNX/sharp/DOM.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boxMean, autoRadius, guidedFilterAlpha, estimateForeground } = require('../../../src/isnetbg/guidedMatte');
const { applyPost } = require('../../../src/isnetbg/maskPost');
const { sanitisePipelineAdvancedSettings, sanitisePipelineBoard } = require('../../../src/stateSanitizers');

// ---- boxMean ----

test('I6 boxMean preserves a constant plane exactly', () => {
  const w = 7, h = 5;
  const src = new Float32Array(w * h).fill(0.42);
  const out = boxMean(src, w, h, 2);
  for (let i = 0; i < w * h; i++) {
    assert.ok(Math.abs(out[i] - 0.42) < 1e-5, `pixel ${i} stays 0.42`);
  }
});

test('I6 boxMean spreads an impulse to its window mean', () => {
  // 5x5, impulse at the center, r=1 → the 3x3 window around it sees 1/9.
  const w = 5, h = 5;
  const src = new Float32Array(w * h).fill(0);
  src[2 * w + 2] = 1;
  const out = boxMean(src, w, h, 1);
  assert.ok(Math.abs(out[2 * w + 2] - 1 / 9) < 1e-5, 'center = 1/9');
  assert.ok(Math.abs(out[0]) < 1e-5, 'far corner untouched');
});

// ---- autoRadius ----

test('I6 autoRadius scales with resolution and floors at 2', () => {
  assert.equal(autoRadius(1024, 1024), 4, '1024² → 4 px');
  assert.equal(autoRadius(4096, 4096), 16, '4k → 16 px');
  assert.equal(autoRadius(64, 64), 2, 'tiny image floors at 2');
});

// ---- guidedFilterAlpha ----

test('I6 guidedFilterAlpha is interior-safe: constant matte stays constant', () => {
  // Noisy guide, constant alpha — cov(I,p)=0 so the output must equal input.
  const w = 8, h = 8, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = (i * 37) % 256;
    rgba[i * 4 + 1] = (i * 101) % 256;
    rgba[i * 4 + 2] = (i * 197) % 256;
    rgba[i * 4 + 3] = 255;
  }
  const alpha = new Float32Array(n).fill(1);
  const out = guidedFilterAlpha(rgba, alpha, w, h, { radius: 2 });
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(out[i] - 1) < 1e-3, `pixel ${i} stays 1`);
  }
});

test('I6 guidedFilterAlpha snaps a blurry matte ramp onto the guide color edge', () => {
  // Guide: hard vertical edge (left black / right white at x=8).
  // Matte: blurry linear ramp across x=4..11 (what bicubic upsampling makes).
  // After filtering, the dark side must get MORE transparent and the bright
  // side MORE opaque — the transition re-aligns with the color edge.
  const w = 16, h = 16, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  const alpha = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = x < 8 ? 0 : 255;
      rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
      alpha[i] = x < 4 ? 0 : (x > 11 ? 1 : (x - 4) / 7);
    }
  }
  const out = guidedFilterAlpha(rgba, alpha, w, h, { radius: 2 });
  const mid = 8 * w; // row 8 (away from top/bottom clamping)
  assert.ok(out[mid + 6] < alpha[mid + 6], 'dark-side ramp pixel pulled toward 0');
  assert.ok(out[mid + 9] > alpha[mid + 9], 'bright-side ramp pixel pushed toward 1');
  for (let i = 0; i < n; i++) {
    assert.ok(out[i] >= 0 && out[i] <= 1, 'output clamped to [0,1]');
  }
});

test('I6 guidedFilterAlpha returns an alpha copy on degenerate input', () => {
  const alpha = new Float32Array([0.25, 0.5, 0.75, 1]);
  const short = new Uint8ClampedArray(4); // too short for 2x2 rgba
  const out = guidedFilterAlpha(short, alpha, 2, 2, {});
  assert.notEqual(out, alpha, 'a copy, not the same buffer');
  assert.deepEqual(Array.from(out), Array.from(alpha));
});

// ---- estimateForeground ----

test('I6 estimateForeground pulls opaque foreground color under semi pixels', () => {
  // Left half opaque red subject; right half α=0.3 with a stale green bg.
  // The alpha-weighted estimate must be dominated by red near the boundary.
  const w = 8, h = 8, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  const alpha = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const fg = x < 4;
      alpha[i] = fg ? 1 : 0.3;
      rgba[i * 4] = fg ? 255 : 0;
      rgba[i * 4 + 1] = fg ? 0 : 255;
      rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = fg ? 255 : 77;
    }
  }
  const out = estimateForeground(rgba, alpha, w, h, {});
  const i = 4 * w + 4; // first semi pixel right of the edge, mid row
  assert.ok(out[i * 4] > out[i * 4 + 1], 'red (subject) outweighs stale green');
  assert.equal(out[i * 4 + 3], 77, 'alpha bytes are left untouched');
  // Opaque pixels keep their exact color.
  const j = 4 * w + 1;
  assert.equal(out[j * 4], 255);
  assert.equal(out[j * 4 + 1], 0);
});

test('I6 estimateForeground is a no-op copy when everything is opaque', () => {
  const w = 4, h = 4, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4).fill(200);
  const alpha = new Float32Array(n).fill(1);
  const out = estimateForeground(rgba, alpha, w, h, {});
  assert.deepEqual(Array.from(out), Array.from(rgba));
});

// ---- applyPost wiring ----

test('I6 applyPost refine path produces a valid matte and keeps extremes', () => {
  // Same synthetic layout as the H8-008 applyPost test, but with refine on.
  const w = 8, h = 8, n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const opaque = i < w * 4;
    alpha[i] = opaque ? 1 : 0;
    rgba[i * 4] = opaque ? 200 : 0;
    rgba[i * 4 + 1] = opaque ? 100 : 0;
    rgba[i * 4 + 2] = opaque ? 50 : 0;
    rgba[i * 4 + 3] = opaque ? 255 : 0;
  }
  const out = applyPost(rgba, alpha, w, h, { minIslandPx: 1, minHolePx: 1, refine: true, refineRadius: 2 });
  assert.ok(out[0 * 4 + 3] > 200, 'top-left stays (near) opaque');
  assert.ok(out[(n - 1) * 4 + 3] < 40, 'bottom-right stays (near) transparent');
});

test('I6 applyPost refine:false is byte-identical to the legacy path', () => {
  const w = 8, h = 8, n = w * h;
  const mk = () => {
    const rgba = new Uint8ClampedArray(n * 4);
    const alpha = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const opaque = i % w < 4;
      alpha[i] = opaque ? 1 : 0.4;
      rgba[i * 4] = (i * 31) % 256;
      rgba[i * 4 + 1] = (i * 57) % 256;
      rgba[i * 4 + 2] = (i * 83) % 256;
      rgba[i * 4 + 3] = 255;
    }
    return { rgba, alpha };
  };
  const a = mk(), b = mk();
  const legacy = applyPost(a.rgba, a.alpha, w, h, { minIslandPx: 1, minHolePx: 1 });
  const off = applyPost(b.rgba, b.alpha, w, h, { minIslandPx: 1, minHolePx: 1, refine: false });
  assert.deepEqual(Array.from(off), Array.from(legacy));
});

// ---- sanitiser wiring ----

test('I6 sanitisePipelineAdvancedSettings defaults refine ON, honors explicit false', () => {
  const def = sanitisePipelineAdvancedSettings({});
  assert.equal(def.isnetbg.refine, true, 'missing → default ON');
  const off = sanitisePipelineAdvancedSettings({ isnetbg: { refine: false } });
  assert.equal(off.isnetbg.refine, false, 'explicit false survives');
  const junk = sanitisePipelineAdvancedSettings({ isnetbg: { refine: 'banana' } });
  assert.equal(junk.isnetbg.refine, true, 'junk coerces to the ON default');
});

test('I6 sanitisePipelineBoard removebg column carries refine with ON default', () => {
  const b = sanitisePipelineBoard({
    columns: { removebg: { model: 'isnet-general-use', refine: false } },
    hiddenColumns: [], items: [],
  });
  assert.equal(b.columns.removebg.refine, false, 'explicit false survives');
  const b2 = sanitisePipelineBoard({
    columns: { removebg: { model: 'isnet-general-use' } },
    hiddenColumns: [], items: [],
  });
  assert.equal(b2.columns.removebg.refine, true, 'missing → default ON');
});
