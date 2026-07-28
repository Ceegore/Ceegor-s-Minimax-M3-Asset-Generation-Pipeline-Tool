// src/inpaint/inpaint_node.js
// AI inpainting worker (LaMa / MI-GAN ONNX) for the editor's Heal
// "Resynthesize" operation (Feature 5 §6.4). Mirrors src/isnetbg_node.js:
// spawned as a child node process (ELECTRON_RUN_AS_NODE), reads the source
// image + a mask, runs ONNX inference, writes the result atomically.
//
// Input contract (argv):
//   --input <path>     source image (RGBA)
//   --mask  <path>     grayscale PNG mask (white = fill this region)
//   --output <path>    destination
//   --model <key>      migan | lama-big   (default migan)
//   --use-gpu <0|1>    enable GPU EPs (default 1)
//   --intra-op <n>     CPU EP intra-op threads
//   --inter-op <n>     CPU EP inter-op threads
//   --execution-mode <sequential|parallel>
//
// Pre-process: resize image + mask to model.inputSize (512), normalize per
// the registry's mean/std, stack into a 4-channel NCHW float32 tensor
// ([1, 4, H, W]): channels 0-2 = image RGB, channel 3 = mask.
// Post-process: the model outputs filled RGB; we resize it back to the source
// resolution and paste ONLY into the masked region (with a 2px feather so the
// seam is invisible). Unmasked pixels are left byte-for-byte identical.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randomUUID } = require('crypto');
const ort = require('onnxruntime-node');
const sharp = require('sharp');
require('../cpuGuard').applySharpThreadCap(sharp);
const { getModel, resolveModelKey } = require('./modelRegistry');
const assetPaths = require('../assetPaths');

function findModelPath(modelFile) {
  const p = assetPaths.resolveAsset('models', modelFile);
  if (p && fs.existsSync(p)) return p;
  const fallback = assetPaths.resolveAsset('', modelFile);
  if (fallback && fs.existsSync(fallback)) return fallback;
  return null;
}

function parseArgs(argv) {
  let input = null, mask = null, output = null;
  let useGpu = true;
  let intraOpNumThreads = 0, interOpNumThreads = 0, executionMode = 'sequential';
  let model = 'migan';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') input = argv[++i];
    else if (a === '--mask' || a === '-m') mask = argv[++i];
    else if (a === '--output' || a === '-o') output = argv[++i];
    else if (a === '--model') model = argv[++i];
    else if (a === '--use-gpu') useGpu = (argv[++i] || '1') !== '0';
    else if (a === '--intra-op') intraOpNumThreads = Math.max(0, Math.min(64, Math.round(Number(argv[++i]) || 0)));
    else if (a === '--inter-op') interOpNumThreads = Math.max(0, Math.min(64, Math.round(Number(argv[++i]) || 0)));
    else if (a === '--execution-mode') { const v = argv[++i]; executionMode = (v === 'parallel') ? 'parallel' : 'sequential'; }
  }
  return { input, mask, output, useGpu, intraOpNumThreads, interOpNumThreads, executionMode, model };
}

// Build the 4-channel NCHW float32 input tensor from image + mask (LaMa style:
// single RGBM tensor, mask channel 1.0 = fill). Used when m.inputStyle==='concat'.
function buildInputTensor(m, imageRGB, maskGray) {
  const S = m.inputSize;
  const plane = S * S;
  const data = new Float32Array(4 * plane);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x);
      const rgbOff = i * 3;
      data[0 * plane + i] = (imageRGB[rgbOff] / 255 - m.mean[0]) / m.std[0];
      data[1 * plane + i] = (imageRGB[rgbOff + 1] / 255 - m.mean[1]) / m.std[1];
      data[2 * plane + i] = (imageRGB[rgbOff + 2] / 255 - m.mean[2]) / m.std[2];
      // mask channel: 1.0 where we want filled, 0.0 elsewhere.
      data[3 * plane + i] = (maskGray[i] / 255 - m.mean[3]) / m.std[3];
    }
  }
  return new ort.Tensor('float32', data, [1, 4, S, S]);
}

// Build the per-input feeds for a given model style.
//   'concat'      (legacy): one 4-channel RGBM float32 tensor under session.inputNames[0].
//   'split'       (MI-GAN official export): two uint8 named inputs — image [1,3,S,S]
//                 + mask [1,1,S,S] (255 = KNOWN pixels, so we invert our white=fill mask).
//   'split-float' (LaMa real export, PE-011): two float32 named inputs —
//                 image [1,3,S,S] normalised with mean/std + mask [1,1,S,S] (1.0=fill).
// Returns { [inputName]: Tensor }.
function buildFeeds(m, session, imageRGB, maskGray) {
  const S = m.inputSize;
  const plane = S * S;
  if (m.inputStyle === 'split-float') {
    // PE-011: LaMa real export — two separate float32 inputs.
    // image: normalised RGB NCHW [1,3,S,S].
    // KGO9-001: honour the model's declared input scale. `0..1` is a plain
    // v/255 (what the Carve LaMa export wants); anything else keeps the legacy
    // ImageNet normalisation so other split-float exports are unaffected.
    const imgData = new Float32Array(3 * plane);
    const plainScale = m.inputScale === '0..1';
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const rgbOff = i * 3;
        for (let ch = 0; ch < 3; ch++) {
          const v = imageRGB[rgbOff + ch] / 255;
          imgData[ch * plane + i] = plainScale ? v : (v - m.mean[ch]) / m.std[ch];
        }
      }
    }
    // mask: raw 0..1 float32 [1,1,S,S] (1.0 = fill this pixel).
    const maskData = new Float32Array(plane);
    for (let i = 0; i < plane; i++) maskData[i] = maskGray[i] / 255;
    const feeds = {};
    feeds[session.inputNames[0]] = new ort.Tensor('float32', imgData, [1, 3, S, S]);
    if (session.inputNames[1]) feeds[session.inputNames[1]] = new ort.Tensor('float32', maskData, [1, 1, S, S]);
    return feeds;
  }
  if (m.inputStyle === 'split') {
    // MI-GAN official export: image = uint8 RGB NCHW, mask = uint8 grayscale
    // where 255 = known. Our maskGray is white(255)=fill, so invert.
    const img = new Uint8Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      img[0 * plane + i] = imageRGB[i * 3];
      img[1 * plane + i] = imageRGB[i * 3 + 1];
      img[2 * plane + i] = imageRGB[i * 3 + 2];
    }
    const maskKnown = new Uint8Array(plane);
    for (let i = 0; i < plane; i++) maskKnown[i] = 255 - maskGray[i]; // invert: 255=known
    const feeds = {};
    feeds[session.inputNames[0]] = new ort.Tensor('uint8', img, [1, 3, S, S]);
    if (session.inputNames[1]) feeds[session.inputNames[1]] = new ort.Tensor('uint8', maskKnown, [1, 1, S, S]);
    return feeds;
  }
  // 'concat' (default, legacy single-tensor)
  const feeds = {};
  feeds[session.inputNames[0]] = buildInputTensor(m, imageRGB, maskGray);
  return feeds;
}

// PE-011: validate that the ONNX session's input metadata matches what the
// registry declares for the model. Called BEFORE session.run so a mismatch
// produces a clear diagnostic instead of a cryptic ORT error 54 s later.
// Returns null on success, or an error string describing the mismatch.
function validateSession(m, session) {
  const names = session.inputNames || [];
  const style = m.inputStyle || 'concat';
  const expectedInputs = (style === 'concat') ? 1 : 2;
  if (names.length < expectedInputs) {
    return 'model "' + (m.label || m.file) + '" expects ' + expectedInputs +
      ' input(s) (' + style + ') but the ONNX session exposes ' + names.length +
      ' (' + JSON.stringify(names) + '). The model file may be a different export.';
  }
  return null;
}

// PE-025: find the bounding box of non-zero pixels in a greyscale mask buffer.
// Returns { minX, minY, maxX, maxY } or null if the mask is entirely black.
function maskBBox(buf, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (buf[y * w + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

// PE-025: compute a square crop region centred on the mask bounding box,
// clamped to image bounds. If the mask is null (empty), use the full image
// (centred square). The crop size is the larger of the bbox dimensions +
// 20% context padding, clamped to [1, max(srcW, srcH)].
function computeSquareCrop(bbox, srcW, srcH) {
  if (!bbox) {
    // No mask content — use the largest centred square.
    const size = Math.min(srcW, srcH);
    return { x: Math.round((srcW - size) / 2), y: Math.round((srcH - size) / 2), size };
  }
  const bw = bbox.maxX - bbox.minX + 1;
  const bh = bbox.maxY - bbox.minY + 1;
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  // Square side = larger dimension + 20% context, at least 16px.
  let side = Math.max(bw, bh);
  side = Math.max(16, Math.ceil(side * 1.2));
  // Clamp to image dimensions (can't crop larger than the image).
  side = Math.min(side, Math.max(srcW, srcH));
  // Centre on mask, clamp to bounds.
  let x = Math.round(cx - side / 2);
  let y = Math.round(cy - side / 2);
  x = Math.max(0, Math.min(x, srcW - side));
  y = Math.max(0, Math.min(y, srcH - side));
  // If side > one dimension, clamp size to fit.
  const size = Math.min(side, srcW - x, srcH - y);
  return { x, y, size };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const { input, mask, output, useGpu, intraOpNumThreads, interOpNumThreads, executionMode } = args;
  if (!input || !mask || !output) {
    process.stderr.write('Usage: node inpaint_node.js --input <p> --mask <p> --output <p> [--model migan|lama-big]\n');
    process.exit(2);
  }
  if (!fs.existsSync(input)) { process.stderr.write('Input not found: ' + input + '\n'); process.exit(3); }
  if (!fs.existsSync(mask)) { process.stderr.write('Mask not found: ' + mask + '\n'); process.exit(3); }

  const modelKey = resolveModelKey(args.model);
  const m = getModel(modelKey);
  const modelPath = findModelPath(m.file);
  if (!modelPath) {
    process.stderr.write('Model file missing: bin/models/' + m.file + ' (place it there or via Settings)\n');
    process.exit(4);
  }

  // Read source dims + raw RGBA.
  const meta = await sharp(input).metadata();
  const srcW = meta.width, srcH = meta.height;
  if (!srcW || !srcH) { process.stderr.write('Could not read source dimensions\n'); process.exit(5); }
  const srcRGBA = await sharp(input).ensureAlpha().raw().toBuffer();

  // PE-025: aspect-ratio-preserving crop/pad instead of fit:'fill' stretch.
  // 1. Find the mask bounding box.
  // 2. Compute a square crop centred on the mask (clamped to image bounds).
  // 3. Resize the crop to S×S (or pad if the crop is smaller than S).
  // 4. After inference, composite ONLY the crop region back.
  const S = m.inputSize;
  const maskMeta = await sharp(mask).greyscale().raw().toBuffer({ resolveWithObject: true });
  const maskRawBuf = maskMeta.data;
  const maskW = maskMeta.info.width, maskH = maskMeta.info.height;
  const bbox = maskBBox(maskRawBuf, maskW, maskH);
  const crop = computeSquareCrop(bbox, srcW, srcH);

  // Extract the square crop from source + mask, then resize to S×S.
  const imageRGB = await sharp(input)
    .extract({ left: crop.x, top: crop.y, width: crop.size, height: crop.size })
    .resize(S, S, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha().raw().toBuffer();
  const maskGray = await sharp(mask)
    .extract({ left: crop.x, top: crop.y, width: crop.size, height: crop.size })
    .resize(S, S, { fit: 'fill', kernel: 'lanczos3' })
    .greyscale().raw().toBuffer();

  // Session options (GPU-first, CPU fallback) — same as isnetbg_node.
  const sessionOpts = {
    graphOptimizationLevel: 'all',
    executionProviders: [{ name: 'dml' }, { name: 'coreml' }, { name: 'cuda' }, { name: 'cpu' }],
  };
  if (!useGpu) sessionOpts.executionProviders = [{ name: 'cpu' }];
  // KGO5-023: always cap ORT threads (default = all cores is unsafe).
  const _osMod = require('os');
  const _cores = (typeof _osMod.availableParallelism === 'function') ? _osMod.availableParallelism() : ((_osMod.cpus() || []).length || 4);
  const _defThreads = Math.max(1, _cores - 2);
  sessionOpts.intraOpNumThreads = (intraOpNumThreads > 0) ? intraOpNumThreads : _defThreads;
  sessionOpts.interOpNumThreads = (interOpNumThreads > 0) ? interOpNumThreads : 1;
  if (executionMode === 'parallel') sessionOpts.executionMode = 'parallel';

  // KGO8-002: run with a CPU RETRY.
  //
  // LaMa (`lama-big`) crashes inside the DirectML execution provider on this
  // model's FFC MatMul nodes:
  //   "Non-zero status code returned while running MatMul node.
  //    Name:'/generator/model/model.5/conv1/ffc/convg2g/fu/rttn/MatMul_5'
  //    … DmlExecutionProvider … 80070057 Falscher Parameter."
  // The identical call with executionProviders:[{name:'cpu'}] succeeds, and
  // MI-GAN is unaffected. Because the failure surfaces only when session.run()
  // executes the graph (not at create() time), the GPU provider list cannot be
  // validated up front — so any create/run failure is retried once on CPU
  // before giving up. Without this the renderer's Heal fell back to non-AI
  // Telea after ~35 s of wasted GPU work, silently losing the AI tier for
  // every selection larger than 15 % of the image.
  async function runWithCpuRetry() {
    let session = await ort.InferenceSession.create(modelPath, sessionOpts);
    // PE-011: validate session metadata BEFORE building feeds + running
    // inference — a mismatch (wrong export, wrong file) is caught here with
    // a clear message instead of a cryptic ORT error after 54 s of CPU work.
    const validationErr = validateSession(m, session);
    if (validationErr) {
      process.stderr.write('Model validation failed: ' + validationErr + '\n');
      process.exit(6);
    }
    try {
      return { session, results: await session.run(buildFeeds(m, session, imageRGB, maskGray)) };
    } catch (err) {
      const onCpuAlready = sessionOpts.executionProviders.length === 1
        && sessionOpts.executionProviders[0].name === 'cpu';
      if (onCpuAlready) throw err;
      process.stderr.write('[inpaint] GPU inference failed (' + String((err && err.message) || err).split('\n')[0]
        + ') — retrying on CPU.\n');
      try { if (session && typeof session.release === 'function') await session.release(); } catch (_) { /* best-effort */ }
      sessionOpts.executionProviders = [{ name: 'cpu' }];
      session = await ort.InferenceSession.create(modelPath, sessionOpts);
      return { session, results: await session.run(buildFeeds(m, session, imageRGB, maskGray)) };
    }
  }

  // Run + read the first output (RGB filled image).
  const { session, results } = await runWithCpuRetry();
  const out = results[session.outputNames[0]];
  const outData = out.data; // Float32 (LaMa) or uint8 (MI-GAN), NCHW [1, 3, S, S]

  // De-normalize + pack into an HWC uint8 RGB buffer at model size.
  // LaMa output is float32 in normalized space (undo mean/std); MI-GAN's
  // official export emits uint8 [0..255] directly (no de-norm needed).
  const filledRGB = Buffer.alloc(S * S * 3);
  const plane = S * S;
  // KGO9-001: a float32 output is NOT automatically in normalised space. The
  // Carve LaMa export emits float32 that is already 0..255 (measured raw range
  // 0.000..255.000), so de-normalising it saturated every channel to white.
  // `outputScale: '0..255'` means "take the values as they are"; only a model
  // that actually declares normalised output gets the (v*std+mean)*255 pass.
  const isUint8 = (out.type === 'uint8');
  const rawScale = isUint8 || m.outputScale === '0..255';
  for (let i = 0; i < plane; i++) {
    let r, g, b;
    if (rawScale) {
      r = outData[0 * plane + i]; g = outData[1 * plane + i]; b = outData[2 * plane + i];
    } else {
      r = (outData[0 * plane + i] * m.std[0] + m.mean[0]) * 255;
      g = (outData[1 * plane + i] * m.std[1] + m.mean[1]) * 255;
      b = (outData[2 * plane + i] * m.std[2] + m.mean[2]) * 255;
    }
    filledRGB[i * 3] = clampByte(r);
    filledRGB[i * 3 + 1] = clampByte(g);
    filledRGB[i * 3 + 2] = clampByte(b);
  }

  // Resize the filled RGB back to the crop region size (not full source).
  const filledCropBuf = await sharp(filledRGB, { raw: { width: S, height: S, channels: 3 } })
    .resize(crop.size, crop.size, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();

  // Build the crop-resized mask + feathered blend weight.
  const maskCropBuf = await sharp(mask)
    .extract({ left: crop.x, top: crop.y, width: crop.size, height: crop.size })
    .resize(crop.size, crop.size, { fit: 'fill', kernel: 'lanczos3' })
    .greyscale().raw().toBuffer();
  let featherBuf;
  try {
    featherBuf = await sharp(mask)
      .extract({ left: crop.x, top: crop.y, width: crop.size, height: crop.size })
      .resize(crop.size, crop.size, { fit: 'fill' })
      .greyscale()
      .blur(2)
      .raw()
      .toBuffer();
  } catch (_) {
    featherBuf = maskCropBuf;
  }

  // Composite: blend filled into the source RGBA ONLY within the crop region.
  // Pixels outside the crop are byte-for-byte untouched (PE-025 guarantee).
  for (let cy = 0; cy < crop.size; cy++) {
    for (let cx = 0; cx < crop.size; cx++) {
      const ci = cy * crop.size + cx;
      const w = clampByte(featherBuf[ci]) / 255;
      if (w <= 0) continue; // unmasked — keep original byte-for-byte
      const sx = crop.x + cx, sy = crop.y + cy;
      const o = (sy * srcW + sx) * 4, f = ci * 3;
      srcRGBA[o] = Math.round(srcRGBA[o] * (1 - w) + filledCropBuf[f] * w);
      srcRGBA[o + 1] = Math.round(srcRGBA[o + 1] * (1 - w) + filledCropBuf[f + 1] * w);
      srcRGBA[o + 2] = Math.round(srcRGBA[o + 2] * (1 - w) + filledCropBuf[f + 2] * w);
      if (srcRGBA[o + 3] < 255) srcRGBA[o + 3] = Math.round(Math.max(srcRGBA[o + 3], 255 * w));
    }
  }

  // Atomic write (PNG; preserves alpha for Heal Transparency flows).
  const tmp = output + '.tmp-' + randomUUID();
  await sharp(srcRGBA, { raw: { width: srcW, height: srcH, channels: 4 } }).png().toFile(tmp);
  await fsp.rename(tmp, output);
  process.exit(0);
}

function clampByte(v) { v = Math.round(v); return v < 0 ? 0 : (v > 255 ? 255 : v); }

module.exports = { buildInputTensor, buildFeeds, validateSession, parseArgs, clampByte, maskBBox, computeSquareCrop };

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write('inpaint_node failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
  });
}
