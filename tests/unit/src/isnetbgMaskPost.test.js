// tests/unit/src/isnetbgMaskPost.test.js
// H8-008: unit tests for the background-removal matte post-processing.
// Pure typed-array math — no ONNX/sharp/DOM.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanupIslandsHoles, feather, defringe, applyPost } = require('../../../src/isnetbg/maskPost');

test('H8-008 cleanupIslandsHoles drops a tiny foreground island', () => {
  // 5x5, all background except a 1x1 foreground speck in the middle.
  const w = 5, h = 5;
  const alpha = new Float32Array(w * h).fill(0);
  alpha[2 * w + 2] = 1; // a single fg pixel
  const out = cleanupIslandsHoles(alpha, w, h, { minIslandPx: 64, minHolePx: 64 });
  assert.equal(out[2 * w + 2], 0, 'the 1px island must be erased');
});

test('H8-008 cleanupIslandsHoles keeps a large foreground subject', () => {
  // 10x10 fully-foreground subject (100 px) — above the 64-px floor.
  const w = 10, h = 10;
  const alpha = new Float32Array(w * h).fill(1);
  const out = cleanupIslandsHoles(alpha, w, h, { minIslandPx: 64, minHolePx: 64 });
  let surviving = 0;
  for (let i = 0; i < w * h; i++) if (out[i] >= 0.5) surviving++;
  assert.equal(surviving, w * h, 'the whole subject survives');
});

test('H8-008 cleanupIslandsHoles fills a tiny background hole', () => {
  // 10x10 foreground with a single background pinhole.
  const w = 10, h = 10;
  const alpha = new Float32Array(w * h).fill(1);
  alpha[5 * w + 5] = 0; // pinhole
  const out = cleanupIslandsHoles(alpha, w, h, { minIslandPx: 64, minHolePx: 64 });
  assert.equal(out[5 * w + 5], 1, 'the pinhole is filled');
});

test('H8-008 feather is a no-op at radius 0', () => {
  const w = 3, h = 3;
  const alpha = new Float32Array([1, 0, 1, 0, 1, 0, 1, 0, 1]);
  const out = feather(alpha, w, h, 0);
  for (let i = 0; i < w * h; i++) assert.equal(out[i], alpha[i]);
});

test('H8-008 feather smooths a hard edge (center value moves toward neighbours)', () => {
  // A single bright pixel surrounded by zeros should be damped by a 1px blur.
  const w = 3, h = 3;
  const alpha = new Float32Array(w * h).fill(0);
  alpha[1 * w + 1] = 1; // center
  const out = feather(alpha, w, h, 1);
  assert.ok(out[1 * w + 1] < 1, 'the bright pixel is damped');
  assert.ok(out[1 * w + 1] > 0, 'but not fully erased');
});

test('H8-008 defringe copies an opaque neighbour colour into a semi-transparent pixel', () => {
  // 1x2 image: pixel 0 opaque red, pixel 1 semi-transparent with a stale green bg.
  const w = 2, h = 1;
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128]);
  const alpha = new Float32Array([1, 0.5]);
  const out = defringe(rgba, alpha, w, h, { opaqueThresh: 0.9, passes: 4 });
  // pixel 1's RGB must now be the red donor colour, not the stale green.
  assert.equal(out[4], 255);
  assert.equal(out[5], 0);
  assert.equal(out[6], 0);
});

test('H8-008 defringe leaves fully-opaque pixels untouched', () => {
  const w = 1, h = 1;
  const rgba = new Uint8ClampedArray([10, 20, 30, 255]);
  const alpha = new Float32Array([1]);
  const out = defringe(rgba, alpha, w, h);
  assert.deepEqual(Array.from(out), [10, 20, 30, 255]);
});

test('H8-008 applyPost runs the full pipeline and writes alpha into rgba', () => {
  // 4x4: top two rows opaque, bottom two transparent; the matte matches.
  const w = 4, h = 4;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const opaque = i < w * 2;
    alpha[i] = opaque ? 1 : 0;
    rgba[i * 4] = opaque ? 200 : 0;
    rgba[i * 4 + 1] = opaque ? 100 : 0;
    rgba[i * 4 + 2] = opaque ? 50 : 0;
    rgba[i * 4 + 3] = opaque ? 255 : 0;
  }
  // Use a tiny island/hole threshold so the 4x4 synthetic matte isn't reclassified
  // (default 64px would fill the 8px bottom as a "hole").
  const out = applyPost(rgba, alpha, w, h, { minIslandPx: 1, minHolePx: 1 });
  assert.ok(out[0 * 4 + 3] > 240, 'top-left stays opaque');
  assert.equal(out[(w * 3) * 4 + 3], 0, 'bottom-left stays transparent');
});

test('H8-008 maskPost exports the three stages + the convenience wrapper', () => {
  assert.equal(typeof cleanupIslandsHoles, 'function');
  assert.equal(typeof feather, 'function');
  assert.equal(typeof defringe, 'function');
  assert.equal(typeof applyPost, 'function');
});
