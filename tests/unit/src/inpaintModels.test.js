// tests/unit/src/inpaintModels.test.js
// Unit tests for the inpaint model registry + the AI worker's pure helpers
// (Feature 5 §6). These avoid spawning the ONNX process; they verify the
// registry shape, the Auto-model picker, and the tensor builder math.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const reg = require('../../../src/inpaint/modelRegistry');
const worker = require('../../../src/inpaint/inpaint_node');

test('registry ships MI-GAN (MIT) + LaMa (Apache-2.0), both commercial-safe', () => {
  assert.ok(reg.MODELS['migan']);
  assert.ok(reg.MODELS['lama-big']);
  for (const key of Object.keys(reg.MODELS)) {
    const m = reg.MODELS[key];
    assert.ok(['MIT', 'Apache-2.0', 'CC0', 'BSD-3-Clause'].includes(m.license),
      key + ' license must be commercial-safe, got ' + m.license);
    assert.strictEqual(m.channels, 4, key + ' uses a 4-channel RGBM input');
    assert.strictEqual(m.outputChannels, 3, key + ' outputs RGB');
  }
});

test('default AI model is MI-GAN (fast, MIT, small)', () => {
  assert.strictEqual(reg.DEFAULT_MODEL, 'migan');
});

test('resolveModelKey falls back to default for unknown keys', () => {
  assert.strictEqual(reg.resolveModelKey('migan'), 'migan');
  assert.strictEqual(reg.resolveModelKey('lama-big'), 'lama-big');
  assert.strictEqual(reg.resolveModelKey('nonsense'), reg.DEFAULT_MODEL);
  assert.strictEqual(reg.resolveModelKey(undefined), reg.DEFAULT_MODEL);
});

test('pickAutoModel: small→MI-GAN, large→LaMa', () => {
  assert.strictEqual(reg.pickAutoModel(0.05), 'migan');
  assert.strictEqual(reg.pickAutoModel(0.5), 'lama-big');
  assert.strictEqual(reg.pickAutoModel(0.2), 'lama-big'); // >15% → LaMa
  assert.strictEqual(reg.pickAutoModel(undefined), reg.DEFAULT_MODEL);
});

test('worker.clampByte clamps to [0,255] and rounds', () => {
  assert.strictEqual(worker.clampByte(-5), 0);
  assert.strictEqual(worker.clampByte(0), 0);
  assert.strictEqual(worker.clampByte(12.6), 13);
  assert.strictEqual(worker.clampByte(255), 255);
  assert.strictEqual(worker.clampByte(300), 255);
});

test('worker.buildInputTensor produces a [1,4,S,S] float32 tensor', async () => {
  const S = 2;
  const m = { inputSize: S, mean: [0.5, 0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5, 0.5] };
  // 2×2 RGB image + 2×2 grayscale mask
  const imageRGB = Buffer.from([0, 0, 0, 255, 255, 255, 128, 128, 128, 64, 64, 64]);
  const maskGray = Buffer.from([255, 0, 0, 255]);
  const t = await worker.buildInputTensor(m, imageRGB, maskGray);
  assert.strictEqual(t.type, 'float32');
  assert.deepStrictEqual(Array.from(t.dims), [1, 4, S, S]);
  // pixel 0: black image + mask on. After norm: ((0/255 - 0.5)/0.5) = -1, mask ((255/255-0.5)/0.5)=1
  assert.strictEqual(t.data[0].toFixed(3), '-1.000');
  assert.strictEqual(t.data[3 * S * S + 0].toFixed(3), '1.000');
});

// PE-011: LaMa's real ONNX export has two separate float32 inputs.
test('PE-011: registry declares LaMa as split-float with 3-element mean/std', () => {
  const lama = reg.MODELS['lama-big'];
  assert.strictEqual(lama.inputStyle, 'split-float');
  assert.strictEqual(lama.mean.length, 3, 'LaMa mean must be 3-element (RGB only)');
  assert.strictEqual(lama.std.length, 3, 'LaMa std must be 3-element (RGB only)');
  assert.strictEqual(lama.channels, 4, 'total channels still 4 (3 image + 1 mask)');
});

test('PE-011: buildFeeds split-float produces two float32 tensors [1,3,S,S] + [1,1,S,S]', () => {
  const S = 2;
  const m = { inputSize: S, inputStyle: 'split-float', mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] };
  const session = { inputNames: ['image', 'mask'] };
  // 2×2 RGB: pixel0=black, pixel1=white, pixel2=mid, pixel3=dark
  const imageRGB = Buffer.from([0, 0, 0, 255, 255, 255, 128, 128, 128, 64, 64, 64]);
  const maskGray = Buffer.from([255, 0, 128, 255]);
  const feeds = worker.buildFeeds(m, session, imageRGB, maskGray);
  // image tensor
  const imgT = feeds['image'];
  assert.ok(imgT, 'feeds must contain the image input');
  assert.strictEqual(imgT.type, 'float32');
  assert.deepStrictEqual(Array.from(imgT.dims), [1, 3, S, S]);
  // pixel 0 R: (0/255 - 0.5)/0.5 = -1
  assert.strictEqual(imgT.data[0].toFixed(3), '-1.000');
  // pixel 1 R: (255/255 - 0.5)/0.5 = 1
  assert.strictEqual(imgT.data[1].toFixed(3), '1.000');
  // mask tensor
  const maskT = feeds['mask'];
  assert.ok(maskT, 'feeds must contain the mask input');
  assert.strictEqual(maskT.type, 'float32');
  assert.deepStrictEqual(Array.from(maskT.dims), [1, 1, S, S]);
  // mask pixel 0: 255/255 = 1.0 (fill)
  assert.strictEqual(maskT.data[0].toFixed(3), '1.000');
  // mask pixel 1: 0/255 = 0.0 (keep)
  assert.strictEqual(maskT.data[1].toFixed(3), '0.000');
  // mask pixel 2: 128/255 ≈ 0.502
  assert.ok(Math.abs(maskT.data[2] - 128 / 255) < 0.001);
});

test('PE-011: validateSession passes for matching input count', () => {
  const mSplit = { inputStyle: 'split-float', label: 'Test', file: 'x.onnx' };
  const mConcat = { inputStyle: 'concat', label: 'Test', file: 'x.onnx' };
  // 2 inputs for split-float → OK
  assert.strictEqual(worker.validateSession(mSplit, { inputNames: ['image', 'mask'] }), null);
  // 1 input for concat → OK
  assert.strictEqual(worker.validateSession(mConcat, { inputNames: ['input'] }), null);
});

test('PE-011: validateSession returns error string on input-count mismatch', () => {
  const m = { inputStyle: 'split-float', label: 'LaMa Test', file: 'lama.onnx' };
  // Only 1 input exposed but model expects 2 → mismatch
  const err = worker.validateSession(m, { inputNames: ['input'] });
  assert.ok(err, 'must return an error string');
  assert.ok(/expects 2 input/.test(err), 'error must mention expected count');
  assert.ok(/LaMa Test/.test(err), 'error must mention the model label');
});
