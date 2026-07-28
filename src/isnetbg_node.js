// src/isnetbg_node.js
// Pure-Node.js IS-Net background-removal. The runtime contract is
// identical to the C# isnetbg.exe the README originally asked for
// (`--input <path> --output <path> [--use-gpu <0|1>]`), so the
// high-level wrapper in src/isnetbg.js can call either
// implementation transparently.
//
// Why this exists: shipping an isnetbg.exe built from the C#
// reference requires every developer (and the end user running
// the build) to have the .NET 6+ SDK installed, and the C# source
// isn't part of this Electron repo. onnxruntime-node gives us
// the same ONNX inference pipeline with no extra toolchain —
// `npm install` is the only build step. The same model file
// (isnet-general-use.onnx, MIT/Apache-2.0, ~170 MB) is loaded
// and run in-process.
//
// Architecture (matches the C# reference exactly):
//   1. Pre-process — load the source image, Bicubic-resize to
//      1024×1024, normalize to [0,1] then (x - 0.5) / 1.0, lay
//      out as NCHW float32 (1×3×1024×1024).
//   2. Inference — run the ONNX model, capture the single
//      output tensor (shape [1,1,1024,1024]).
//   3. Post-process — Bicubic-upsample the mask to the source
//      resolution, apply it as the alpha channel, write PNG.
//   4. Export — atomic write to <output>.
//
// GPU: this implementation uses the onnxruntime-node default
// CPU EP. The package exposes a separate DirectML EP that can
// be installed with `npm install onnxruntime-node --onnxruntime-node-install=directml`
// — when the user has that build, we auto-pick the GPU EP via
// the standard SessionOptions API. CPU is the universal default
// because it works on every machine without a separate install.
//
// Limitations vs the C# binary: slightly higher process memory
// (the model is held by the Electron main process while running)
// and CPU-only inference by default. The same model file is
// loaded, so output quality is byte-for-byte equivalent to
// the C# reference once both are on the same backend.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const ort = require('onnxruntime-node');
const sharp = require('sharp'); require('./cpuGuard').applySharpThreadCap(sharp);
const { getModel, resolveModelKey, DEFAULT_MODEL } = require('./isnetbg/modelRegistry');
const maskPost = require('./isnetbg/maskPost'); // H8-008: cleanup + feather + defringe

const MODEL_SIZE = 1024;
const NORM_MEAN = 0.5;
const NORM_STD = 1.0;

const assetPaths = require('./assetPaths');

function findModelPath(modelFile) {
  const p = assetPaths.resolveAsset('models', modelFile);
  if (p && fs.existsSync(p)) return p;
  
  const fallback = assetPaths.resolveAsset('', modelFile);
  if (fallback && fs.existsSync(fallback)) return fallback;
  
  return null;
}

// Read CLI args in the order the user originally specified for
// the C# binary, with positional fallbacks so the same args work
// for either backend. Mirrors src/isnetbg.js' argv parsing (the
// wrapper calls us with the exact same flags).
//
// Also accepts advanced session options:
//   --intra-op <n>      intra-op thread count (CPU EP only)
//   --inter-op <n>      inter-op thread count (CPU EP only)
//   --execution-mode <sequential|parallel>
// These map directly to onnxruntime-node SessionOptions fields
// (see src/isnetbg.js runNode for the spawn side).
function parseArgs(argv) {
  let input = null, output = null, useGpu = false;
  let intraOpNumThreads = 0, interOpNumThreads = 0, executionMode = 'sequential';
  let model = 'isnet-general-use';
  // H8-008: mask post-processing opts (all default ON).
  // Issue 6: refine = image-guided matte refinement (guided filter +
  // foreground-estimation defringe), default ON; --refine 0 restores the
  // legacy feather/dilation chain.
  let postClean = 1, featherPx = 1, defringe = 1, refine = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') input = argv[++i];
    else if (a === '--output' || a === '-o') output = argv[++i];
    else if (a === '--use-gpu') useGpu = (argv[++i] || '1') !== '0';
    else if (a === '--intra-op') intraOpNumThreads = Math.max(0, Math.min(64, Math.round(Number(argv[++i]) || 0)));
    else if (a === '--inter-op') interOpNumThreads = Math.max(0, Math.min(64, Math.round(Number(argv[++i]) || 0)));
    else if (a === '--execution-mode') {
      const v = argv[++i];
      executionMode = (v === 'parallel') ? 'parallel' : 'sequential';
    }
    else if (a === '--model') model = argv[++i];
    else if (a === '--post-clean') postClean = (argv[++i] === '0') ? 0 : 1;
    else if (a === '--feather') featherPx = Math.max(0, Math.min(8, Math.round(Number(argv[++i]) || 0)));
    else if (a === '--defringe') defringe = (argv[++i] === '0') ? 0 : 1;
    else if (a === '--refine') refine = (argv[++i] === '0') ? 0 : 1;
    else if (!input && /\.(png|jpg|jpeg|webp)$/i.test(a)) input = a;
    else if (!output && /\.(png|jpg|jpeg|webp)$/i.test(a)) output = a;
  }
  return { input, output, useGpu, intraOpNumThreads, interOpNumThreads, executionMode, model, postClean, featherPx, defringe, refine };
}

// Bicubic interpolation kernel (Catmull-Rom variant) used for
// both the pre-resize and the post-upsample. Sharp uses a
// high-quality resampler internally for the pre-resize; for the
// upsample we implement the same kernel so the alpha mask
// doesn't introduce extra softness. Standard 1D kernel applied
// separably.
function catmullRom1D(t) {
  const at = Math.abs(t);
  if (at <= 1) return (1.5 * at * at * at) - (2.5 * at * at) + 1;
  if (at <= 2) return (-0.5 * at * at * at) + (2.5 * at * at) - (4 * at) + 2;
  return 0;
}

// Build a separable 4-tap resampling lookup for a target
// coordinate in a source of length srcLen. Returns the integer
// source indices and the 4 float weights to use at each.
function resampleKernel(srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const kernel = [];
  for (let x = 0; x < dstLen; x++) {
    // Center of the output pixel in source space.
    const srcCenter = (x + 0.5) * scale - 0.5;
    const srcFloor = Math.floor(srcCenter);
    const frac = srcCenter - srcFloor;
    const offsets = [-1, 0, 1, 2];
    const weights = offsets.map((o) => catmullRom1D(frac - o));
    // Normalise so the weights sum to 1 (Catmull-Rom doesn't
    // strictly preserve DC for fractional offsets, so this
    // rescale keeps the mean intensity).
    const wsum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < 4; i++) weights[i] /= wsum;
    kernel.push(weights.map((w, i) => ({ idx: srcFloor + offsets[i], w })));
  }
  return kernel;
}

// Bicubic upsample of a single-channel Float32Array (length
// srcW * srcH) to (dstW * dstH). Edges are clamped.
function bicubicUpsample(src, srcW, srcH, dstW, dstH) {
  const dst = new Float32Array(dstW * dstH);
  const kx = resampleKernel(srcW, dstW);
  const ky = resampleKernel(srcH, dstH);
  // Horizontal pass: src[h, x] → tmp[w, x]
  const tmp = new Float32Array(dstW * srcH);
  for (let y = 0; y < srcH; y++) {
    const row = src.subarray(y * srcW, (y + 1) * srcW);
    for (let x = 0; x < dstW; x++) {
      let acc = 0;
      for (const { idx, w } of kx[x]) {
        const i = idx < 0 ? 0 : (idx >= srcW ? srcW - 1 : idx);
        acc += row[i] * w;
      }
      tmp[y * dstW + x] = acc;
    }
  }
  // Vertical pass: tmp[y, x] → dst[y, x]
  for (let x = 0; x < dstW; x++) {
    for (let y = 0; y < dstH; y++) {
      let acc = 0;
      for (const { idx, w } of ky[y]) {
        const i = idx < 0 ? 0 : (idx >= srcH ? srcH - 1 : idx);
        acc += tmp[i * dstW + x] * w;
      }
      dst[y * dstW + x] = acc;
    }
  }
  return dst;
}

// Run the model on a 1024×1024 input and return the mask as a
// Float32Array of length 1024*1024 with values in [0, 1].
async function infer(session, inputNchw, m) {
  let out;
  if (m.legacyIO) {
    const feeds = { input: inputNchw };
    const results = await session.run(feeds);
    // The IS-Net model exposes a single output tensor named
    // "output" or "sigmoid" depending on export. Try both, then
    // fall back to the first output if neither matches.
    out = results.output || results.sigmoid || null;
    if (!out) {
      const first = Object.keys(results)[0];
      out = results[first];
    }
  } else {
    const feeds = {};
    feeds[session.inputNames[0]] = inputNchw;
    const results = await session.run(feeds);
    out = results[session.outputNames[0]];
  }
  // Tensor shape is [1, 1, inputSize, inputSize].
  const data = out.data;
  const mask = new Float32Array(m.inputSize * m.inputSize);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i];
  }

  if (m.postSigmoid) {
    for (let i = 0; i < mask.length; i++) {
      mask[i] = 1 / (1 + Math.exp(-mask[i]));
    }
  }

  if (m.postMinMax) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] < mn) mn = mask[i];
      if (mask[i] > mx) mx = mask[i];
    }
    const range = mx - mn;
    if (range > 1e-6) {
      for (let i = 0; i < mask.length; i++) {
        const norm = (mask[i] - mn) / range;
        mask[i] = norm > 0.95 ? 1.0 : (norm < 0.05 ? 0.0 : norm);
      }
    } else {
      // A uniform model output is ambiguous. Preserve the source rather than
      // turning the whole result transparent; an all-transparent PNG looks
      // like a successful but empty thumbnail and is not recoverable by users.
      mask.fill(1);
    }
  }

  // Squeeze + clamp to [0, 1].
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i];
    mask[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
  }
  return mask;
}

async function main() {
  const argv = process.argv.slice(2);
  const { input, output, useGpu, intraOpNumThreads, interOpNumThreads, executionMode, model, postClean, featherPx, defringe, refine } = parseArgs(argv);
  const modelKey = resolveModelKey(model);
  const m = getModel(modelKey);
  if (!input || !output) {
    process.stderr.write('Usage: node isnetbg_node.js --input <path> --output <path> [--use-gpu <0|1>]\n');
    process.exit(2);
  }
  if (!fs.existsSync(input)) {
    process.stderr.write(`Input file not found: ${input}\n`);
    process.exit(3);
  }
  const modelPath = findModelPath(m.file);
  if (!modelPath) {
    process.stderr.write(`Model file missing: ./bin/models/${m.file} (run \`npm run setup\` to download)\n`);
    process.exit(4);
  }

  // Configure session options. Try to enable a GPU EP if the
  // user has the matching onnxruntime-node build installed
  // (DirectML on Windows, CoreML on macOS, CUDA on Linux). We
  // wrap the EP registration in try/catch so a missing EP
  // gracefully falls back to CPU instead of crashing the
  // whole feature.
  const gpuProvider = process.platform === 'win32' ? 'dml'
    : (process.platform === 'darwin' ? 'coreml' : 'cuda');
  const sessionOpts = {
    graphOptimizationLevel: 'all',
    // Request only the native platform provider. Asking for CoreML/CUDA on
    // Windows produces misleading warnings in every operation log.
    executionProviders: [{ name: gpuProvider }, { name: 'cpu' }],
  };
  if (!useGpu) {
    // User explicitly asked for CPU. Pin to CPU so we don't
    // accidentally pull a GPU EP that happens to be installed.
    sessionOpts.executionProviders = [{ name: 'cpu' }];
  }
  // H11-1A: cap CPU EP threads so bg-removal doesn't pin every core + freeze the host.
  // Default max(1, cores−2) when the user hasn't set --intra-op/--inter-op (0 = all cores).
  const osMod = require('os');
  const cores = (typeof osMod.availableParallelism === 'function') ? osMod.availableParallelism() : ((osMod.cpus() || []).length || 4);
  const defThreads = Math.max(1, cores - 2);
  sessionOpts.intraOpNumThreads = (intraOpNumThreads > 0) ? intraOpNumThreads : defThreads;
  sessionOpts.interOpNumThreads = (interOpNumThreads > 0) ? interOpNumThreads : (executionMode === 'parallel' ? Math.max(1, Math.floor(defThreads / 2)) : 1);
  if (executionMode === 'parallel') sessionOpts.executionMode = 'parallel';

  async function createSessionWithCpuFallback() {
    try {
      return await ort.InferenceSession.create(modelPath, sessionOpts);
    } catch (err) {
      if (!useGpu) throw err;
      process.stderr.write(`GPU session creation failed: ${err.message || err}. Falling back to CPU...\n`);
      sessionOpts.executionProviders = [{ name: 'cpu' }];
      return ort.InferenceSession.create(modelPath, sessionOpts);
    }
  }
  let session = await createSessionWithCpuFallback();

  // Read source image. We use sharp to get raw RGB at any size
  // + we remember the source size for the upsample step.
  const src = sharp(input);
  const meta = await src.metadata();
  const srcW = meta.width;
  const srcH = meta.height;
  if (!srcW || !srcH) {
    process.stderr.write(`Could not read source dimensions: ${input}\n`);
    process.exit(5);
  }
  // 3-channel raw RGB at target input size.
  const rgb = await sharp(input)
    .resize(m.inputSize, m.inputSize, { fit: 'fill', kernel: m.resizeKernel })
    .removeAlpha()
    .raw()
    .toBuffer();

  let scale = 255;
  if (m.divideByMax) {
    let maxV = 0;
    for (let i = 0; i < rgb.length; i++) {
      if (rgb[i] > maxV) maxV = rgb[i];
    }
    scale = Math.max(maxV, 1);
  }

  // HWC uint8 → NCHW float32, normalized.
  const tensor = new ort.Tensor('float32', new Float32Array(m.inputSize * m.inputSize * 3), [1, 3, m.inputSize, m.inputSize]);
  const dataArr = tensor.data;
  for (let y = 0; y < m.inputSize; y++) {
    for (let x = 0; x < m.inputSize; x++) {
      const srcOff = (y * m.inputSize + x) * 3;
      const r = rgb[srcOff] / scale;
      const g = rgb[srcOff + 1] / scale;
      const b = rgb[srcOff + 2] / scale;
      const plane = m.inputSize * m.inputSize;
      dataArr[y * m.inputSize + x] = (r - m.mean[0]) / m.std[0];
      dataArr[plane + y * m.inputSize + x] = (g - m.mean[1]) / m.std[1];
      dataArr[2 * plane + y * m.inputSize + x] = (b - m.mean[2]) / m.std[2];
    }
  }

  let mask;
  try {
    mask = await infer(session, tensor, m);
  } catch (err) {
    if (useGpu) {
      process.stderr.write(`GPU inference failed: ${err.message || err}. Falling back to CPU...\n`);
      sessionOpts.executionProviders = [{ name: 'cpu' }];
      const cpuSession = await ort.InferenceSession.create(modelPath, sessionOpts);
      mask = await infer(cpuSession, tensor, m);
    } else {
      throw err;
    }
  }
  // Upsample the mask back to the source resolution.
  const fullMask = bicubicUpsample(mask, m.inputSize, m.inputSize, srcW, srcH);

  // Build the output PNG: same RGB as the source, alpha = the
  // mask. We re-read the source as raw RGBA and overwrite the
  // alpha channel (preserving any existing alpha where the
  // mask is near-opaque — for files that already have a partial
  // alpha like a PNG screenshot, the mask is dominant, so we
  // just multiply).
  // H8-008: before writing, run the matte through maskPost (cleanup → feather →
  // defringe). Cleanup drops stray islands + fills pinholes; feather (1px) takes
  // the jaggies off; defringe replaces the RGB under semi-transparent pixels
  // with the nearest opaque colour so a later composite can't resurrect the
  // original background as a halo. All stages are default-ON and controllable
  // via --post-clean / --feather / --defringe.
  const rgba = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer();
  const postOpts = {
    clean: postClean !== 0,
    feather: featherPx > 0 ? true : false,
    featherPx: featherPx,
    defringe: defringe !== 0,
    refine: refine !== 0, // Issue 6: guided-filter refinement (see maskPost/guidedMatte)
    minIslandPx: Math.max(64, Math.round(srcW * srcH * 0.0002)),
    minHolePx: Math.max(64, Math.round(srcW * srcH * 0.0002)),
  };
  const rgbaOut = maskPost.applyPost(rgba, fullMask, srcW, srcH, postOpts);
  // Atomic write — same pattern as the main process fb:write.
  const tmp = output + '.tmp-' + maskPost.tempSuffix(process.pid);
  await sharp(rgbaOut, { raw: { width: srcW, height: srcH, channels: 4 } })
    .png()
    .toFile(tmp);
  await fsp.rename(tmp, output);
  process.exit(0);
}

// (tempSuffix moved to src/isnetbg/maskPost.js so the worker stays under its
// frozen line budget.)

main().catch((e) => {
  process.stderr.write('isnetbg_node failed: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
