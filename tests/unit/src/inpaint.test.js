// tests/unit/src/inpaint.test.js
// Unit tests for src/inpaint.js (editor Heal, Telea-style synthesis).
//
// These test the pure synthesizer directly (no electron/sharp), so they run in
// plain node. We build tiny synthetic RGBA buffers + masks and assert the
// masked region is filled from the surrounding known pixels.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { inpaint, maskFromAlpha, maskFromAlphaHoles } = require('../../../src/inpaint');

// helper: solid-colour RGBA buffer
function solid(w, h, r, g, b, a) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = a;
  }
  return buf;
}

test('inpaint fills a single unknown pixel from its neighbours', () => {
  // 3x3 all-white opaque, with the centre pixel marked unknown.
  const w = 3, h = 3;
  const rgba = solid(w, h, 255, 255, 255, 255);
  const mask = new Uint8Array(w * h);
  mask[4] = 1; // centre
  inpaint(rgba, mask, w, h, { radius: 1 });
  const o = 4 * 4;
  // The centre should now be white-ish (averaged from white neighbours).
  assert.ok(rgba[o] > 240, 'R filled ~255, got ' + rgba[o]);
  assert.ok(rgba[o + 1] > 240, 'G filled ~255');
  assert.ok(rgba[o + 2] > 240, 'B filled ~255');
});

test('inpaint removes a black scratch on a white field', () => {
  // 9x1 white row with a black scratch pixel in the middle.
  const w = 9, h = 1;
  const rgba = solid(w, h, 255, 255, 255, 255);
  rgba[4 * 4] = 0; rgba[4 * 4 + 1] = 0; rgba[4 * 4 + 2] = 0; // black scratch
  const mask = new Uint8Array(w * h);
  mask[4] = 1;
  inpaint(rgba, mask, w, h, { radius: 2 });
  const o = 4 * 4;
  // The scratch should be healed to near-white from its white neighbours.
  assert.ok(rgba[o] > 240, 'scratch healed to ~white, got ' + rgba[o]);
});

test('inpaint fills a 2x2 hole from a surrounding ring', () => {
  // 4x4: outer ring white opaque, inner 2x2 unknown.
  const w = 4, h = 4;
  const rgba = solid(w, h, 255, 255, 255, 255);
  const mask = new Uint8Array(w * h);
  // inner 2x2 = indices 5,6,9,10
  mask[5] = 1; mask[6] = 1; mask[9] = 1; mask[10] = 1;
  // make the hole black so we can tell it changed
  [5, 6, 9, 10].forEach((i) => { rgba[i * 4] = 0; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 0; });
  inpaint(rgba, mask, w, h, { radius: 2 });
  for (const i of [5, 6, 9, 10]) {
    assert.ok(rgba[i * 4] > 200, 'hole pixel ' + i + ' filled ~white, got ' + rgba[i * 4]);
  }
});

test('maskFromAlpha flags fully-transparent pixels', () => {
  const w = 2, h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  // pixel 0 opaque, pixel 1/2/3 transparent
  rgba[3] = 255;
  const mask = maskFromAlpha(rgba, w, h);
  assert.strictEqual(mask[0], 0);
  assert.strictEqual(mask[1], 1);
  assert.strictEqual(mask[2], 1);
  assert.strictEqual(mask[3], 1);
});

test('inpaint heals transparency holes (Heal Transparency mode)', () => {
  // 3x3 white-opaque with a transparent centre.
  const w = 3, h = 3;
  const rgba = solid(w, h, 255, 255, 255, 255);
  // poke a transparent hole in the centre
  rgba[4 * 4 + 3] = 0;
  const mask = maskFromAlpha(rgba, w, h);
  assert.strictEqual(mask[4], 1); // centre flagged
  inpaint(rgba, mask, w, h, { radius: 1 });
  // centre now filled from neighbours (colour ~white) and alpha restored
  const o = 4 * 4;
  assert.ok(rgba[o] > 240, 'colour healed, got ' + rgba[o]);
  assert.ok(rgba[o + 3] > 240, 'alpha restored, got ' + rgba[o + 3]);
});

test('inpaint throws on buffer/size mismatch', () => {
  assert.throws(() => inpaint(new Uint8ClampedArray(10), new Uint8Array(2), 4, 4), /mismatch/);
});

// ---- PE-009: maskFromAlphaHoles (enclosed-holes mask) ----

// helper: transparent RGBA buffer with an opaque rectangle painted on top.
function withOpaqueRect(w, h, x0, y0, rw, rh) {
  const buf = new Uint8ClampedArray(w * h * 4); // all alpha 0
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const i = (y * w + x) * 4;
      buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255;
    }
  }
  return buf;
}

test('PE-009: border-connected transparency is NEVER masked (spec repro)', () => {
  // 5x5: opaque 3x3 subject in the middle, transparent border ring.
  // Pre-PE-009 maskFromAlpha flagged ALL 16 border pixels → the heal
  // synthesised the whole background and the cut-out came back fully
  // opaque. The holes mask must leave the border untouched.
  const w = 5, h = 5;
  const rgba = withOpaqueRect(w, h, 1, 1, 3, 3);
  const { mask, holes } = maskFromAlphaHoles(rgba, w, h);
  // every border pixel stays unmasked
  for (let x = 0; x < w; x++) {
    assert.strictEqual(mask[x], 0, 'top border pixel ' + x + ' unmasked');
    assert.strictEqual(mask[(h - 1) * w + x], 0, 'bottom border pixel ' + x + ' unmasked');
  }
  for (let y = 0; y < h; y++) {
    assert.strictEqual(mask[y * w], 0, 'left border pixel ' + y + ' unmasked');
    assert.strictEqual(mask[y * w + w - 1], 0, 'right border pixel ' + y + ' unmasked');
  }
  assert.strictEqual(holes, 0, 'no enclosed holes in a clean cut-out');
  // and a heal run must keep the border transparent
  inpaint(rgba, mask, w, h, { radius: 2 });
  assert.strictEqual(rgba[3], 0, 'corner alpha still 0 after heal');
  assert.strictEqual(rgba[(12 * 4) + 3], 255, 'subject centre still opaque');
});

test('PE-009: an enclosed hole inside the subject IS masked + filled', () => {
  // 5x5: opaque field with a transparent centre pixel (enclosed).
  const w = 5, h = 5;
  const rgba = solid(w, h, 255, 255, 255, 255);
  rgba[12 * 4 + 3] = 0; // centre (2,2) transparent
  const { mask, holes, largestHole } = maskFromAlphaHoles(rgba, w, h);
  assert.strictEqual(mask[12], 1, 'enclosed centre hole masked');
  assert.strictEqual(holes, 1);
  assert.strictEqual(largestHole, 1);
  inpaint(rgba, mask, w, h, { radius: 2 });
  assert.ok(rgba[12 * 4 + 3] > 240, 'hole alpha restored, got ' + rgba[12 * 4 + 3]);
});

test('PE-009: fully transparent image yields an empty mask (all exterior)', () => {
  const w = 4, h = 4;
  const rgba = new Uint8ClampedArray(w * h * 4); // all alpha 0
  const { mask, holes, maskShare } = maskFromAlphaHoles(rgba, w, h);
  for (let i = 0; i < w * h; i++) assert.strictEqual(mask[i], 0);
  assert.strictEqual(holes, 0);
  assert.strictEqual(maskShare, 0);
});

test('PE-009: maxHolePx drops components larger than the limit', () => {
  // 7x5: opaque field with a 1-px hole at (1,1) and a 2x2 hole at (4..5,1..2).
  const w = 7, h = 5;
  const rgba = solid(w, h, 255, 255, 255, 255);
  rgba[(1 * w + 1) * 4 + 3] = 0;                       // size-1 hole
  for (const i of [1 * w + 4, 1 * w + 5, 2 * w + 4, 2 * w + 5]) {
    rgba[i * 4 + 3] = 0;                                 // size-4 hole
  }
  const unlimited = maskFromAlphaHoles(rgba, w, h);
  assert.strictEqual(unlimited.holes, 2, 'both holes filled without a limit');
  const limited = maskFromAlphaHoles(rgba, w, h, { maxHolePx: 2 });
  assert.strictEqual(limited.holes, 1, 'only the size-1 hole passes the filter');
  assert.strictEqual(limited.largestHole, 1);
  assert.strictEqual(limited.mask[1 * w + 1], 1, 'small hole still masked');
  assert.strictEqual(limited.mask[1 * w + 4], 0, 'large hole NOT masked');
});

test('PE-009: growPx dilates the mask into the rim but never into the exterior', () => {
  // 5x5: opaque subject with transparent border ring + enclosed centre hole.
  const w = 5, h = 5;
  const rgba = withOpaqueRect(w, h, 1, 1, 3, 3);
  rgba[12 * 4 + 3] = 0; // enclosed centre hole
  const { mask, maskShare } = maskFromAlphaHoles(rgba, w, h, { growPx: 1 });
  assert.strictEqual(mask[12], 1, 'hole itself masked');
  // the 4 opaque rim neighbours of the hole are dilated in
  for (const i of [12 - 1, 12 + 1, 12 - w, 12 + w]) {
    assert.strictEqual(mask[i], 1, 'rim pixel ' + i + ' dilated in');
  }
  // the border ring (exterior) is NEVER grown into
  for (let x = 0; x < w; x++) {
    assert.strictEqual(mask[x], 0); assert.strictEqual(mask[(h - 1) * w + x], 0);
  }
  for (let y = 0; y < h; y++) {
    assert.strictEqual(mask[y * w], 0); assert.strictEqual(mask[y * w + w - 1], 0);
  }
  assert.strictEqual(maskShare, 5 / 25, 'mask = hole + 4 rim pixels');
});

test('PE-009: alphaThreshold controls what counts as transparent', () => {
  // 3x3 opaque white with a semi-transparent centre (alpha 10).
  const w = 3, h = 3;
  const rgba = solid(w, h, 255, 255, 255, 255);
  rgba[4 * 4 + 3] = 10;
  const strict = maskFromAlphaHoles(rgba, w, h); // threshold 0
  assert.strictEqual(strict.holes, 0, 'alpha 10 is NOT a hole at threshold 0');
  const lax = maskFromAlphaHoles(rgba, w, h, { alphaThreshold: 10 });
  assert.strictEqual(lax.holes, 1, 'alpha 10 IS a hole at threshold 10');
  assert.strictEqual(lax.mask[4], 1);
});
