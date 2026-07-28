// tests/unit/src/audio/AudioMath.test.js
// Pure Tests — kein ffmpeg nötig.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findZeroCrossing } = require('../../../../src/audio/AudioMath');

test('returns targetSample for empty pcm', () => {
  const empty = new Float32Array(0);
  assert.equal(findZeroCrossing(empty, 100, 50), 100);
});

test('returns targetSample for null pcm', () => {
  assert.equal(findZeroCrossing(null, 100, 50), 100);
});

test('snaps to the sign-flip sample within window', () => {
  // pcm: [1, 0.9, 0.5, -0.1, -0.5, -0.8]
  //        0    1    2    3     4     5
  // Sign flips at index 3 (positive → negative). Target = 0, window = 4.
  // The algorithm walks BOTH sides of `t` outward in lockstep, checking
  // the LEFT side (`a = t - i`) BEFORE the right side (`b = t + i`).
  // Walking outward from t=0:
  //   i=0: a=0 (sign=+), b=0 (same), no flip
  //   i=1: a=-1 (out of range), b=1 (sign=+, no flip)
  //   i=2: a=-2 (out), b=2 (sign=+, no flip)
  //   i=3: a=-3 (out), b=3 (sign=-, FLIP) → best=3
  const pcm = new Float32Array([1, 0.9, 0.5, -0.1, -0.5, -0.8]);
  assert.equal(findZeroCrossing(pcm, 0, 4), 3);
});

test('snaps to the sign-flip on the left side first when closer', () => {
  // pcm: [-1, -0.5, 0.2, 0.8, 0.9]
  //        0    1    2    3    4
  // Target = 4, window = 4. The walk checks a (left) before b (right).
  //   i=0: a=4 (sign=+), no flip
  //   i=1: a=3 (sign=+, same), b=5 (out) → no flip
  //   i=2: a=2 (sign=+, same), b=6 (out) → no flip
  //   i=3: a=1 (sign=-, FLIP) → best=1
  // The left side is reached at i=3 because the right side (b=5,6,…)
  // is out of range. 1 IS the closest sign-flip in the window.
  const pcm = new Float32Array([-1, -0.5, 0.2, 0.8, 0.9]);
  assert.equal(findZeroCrossing(pcm, 4, 4), 1);
});

test('returns targetSample when no zero crossing in window', () => {
  // pcm: all positive
  const pcm = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  assert.equal(findZeroCrossing(pcm, 3, 4), 3);
});

test('clamps targetSample into pcm range', () => {
  const pcm = new Float32Array([0.5, 0.5, -0.5, 0.5]);
  // Target out of range: clamp to pcm.length-1=3, window=1 → flip at a=2
  assert.equal(findZeroCrossing(pcm, 9999, 1), 2);
  // Target negative: clamp to 0, no sign-flip in window → return t=0
  assert.equal(findZeroCrossing(pcm, -50, 1), 0);
});
