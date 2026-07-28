// src/inpaint/modelRegistry.js
// Registry of commercially-safe AI inpainting models for the editor's Heal
// "Resynthesize" operation. All entries are bundled in bin/models/ and work
// out of the box — no download prompt for the defaults.
//
// Only models under a permissive license (MIT / Apache-2.0 / CC0) are
// bundled. Non-commercial models are excluded entirely (MAT=CC-BY-NC,
// Resynthesizer=GPL).
//
// Each entry mirrors the isnetbg registry shape, with inpaint-specific fields:
//   file       — onnx filename under bin/models/
//   url        — download URL for re-fetch (null if hand-placed only)
//   sha256     — checksum of the bundled file (verified at runtime; null to skip)
//   sizeMB     — UI display
//   license    — MIT/Apache-2.0 required to bundle
//   label      — UI label
//   inputSize  — square input dim the model was exported for
//   channels   — input channel count (4 = RGB + mask; LaMa/MI-GAN use 4)
//   mean/std   — per-channel normalization (ImageNet defaults for LaMa)
//   outputChannels — 3 (RGB) for inpaint models
//   bestFor    — short string used by the "Auto" picker

'use strict';

const MODELS = {
  // MI-GAN (Sargsyan / Picsart AI Research, ICCV 2023) — lightweight mobile
  // inpainter. ~28 MB ONNX, MIT. Best for mid-size regions; fast on CPU.
  // Canonical ONNX export by the paper author:
  //   https://huggingface.co/andraniksargsyan/migan  (migan_pipeline_v2.onnx)
  // I/O: the official export takes TWO separate named inputs (image + mask),
  // with the mask convention 255 = KNOWN pixels (inverted vs LaMa).
  // `inpaint_node.js` currently builds a single 4-channel tensor (LaMa style);
  // when wiring the real MI-GAN export, branch on m.inputStyle ('split' vs
  // 'concat') and feed the two inputs + invert the mask. The registry field
  // below records the verified source so provisioning downloads the right file.
  'migan': {
    file: 'migan.onnx',
    url: 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx',
    sha256: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b',
    sizeMB: 28,
    license: 'MIT',
    label: 'MI-GAN (AI, fast, 28 MB)',
    inputSize: 512,
    channels: 4,
    inputStyle: 'split', // official export: separate image + mask inputs (mask: 255=known)
    // KGO9-001: declared explicitly so the two models' conventions are visible
    // side by side. MI-GAN feeds raw uint8 and emits uint8 0..255, which is why
    // it was always correct while LaMa was not.
    inputScale: 'uint8',
    outputScale: '0..255',
    mean: [0.5, 0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5, 0.5],
    outputChannels: 3,
    bestFor: 'mid',
    legacyIO: false,
  },
  // LaMa (Samsung SAIC-Vul, Resolution-robust Large Mask Inpainting) — the
  // de-facto commercial-safe SOTA for large-mask inpainting. ~208 MB ONNX,
  // Apache-2.0. Best for large object removal / big fills.
  // PE-011: the REAL Carve/LaMa-ONNX export has TWO separate named inputs
  // (session metadata: `image` float32 [batch,3,512,512] + `mask` float32
  // [batch,1,512,512], output float32 [batch,3,512,512]). The previous
  // 'concat' declaration fed a single 4-channel tensor, causing
  // "input 'mask' is missing in 'feeds'" at runtime. Now declared as
  // 'split-float' so buildFeeds emits two normalised float32 tensors.
  'lama-big': {
    file: 'lama-big.onnx',
    url: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
    sizeMB: 208,
    license: 'Apache-2.0',
    label: 'LaMa (AI, highest quality, 208 MB)',
    inputSize: 512,
    channels: 4, // 3 (image) + 1 (mask) — fed as two separate tensors
    inputStyle: 'split-float', // real export: image float32 [1,3,S,S] + mask float32 [1,1,S,S]
    // KGO9-001: this export is NOT ImageNet-normalised. Measured directly
    // against bin/models/lama-big.onnx: it wants plain 0..1 input and its
    // output is ALREADY in 0..255 (raw tensor range min 0.000 / max 255.000 /
    // mean 139.6). Feeding ImageNet-normalised input and then de-normalising
    // with (v*std+mean)*255 saturated every channel, so every AI heal larger
    // than 15 % of the image came back as a pure-WHITE patch.
    //
    // Scored by mean-absolute-error OUTSIDE the mask (an inpainting model must
    // reconstruct the untouched region exactly, so MAE -> 0 identifies the
    // right convention):
    //   imagenet in + (v*std+mean)*255 out -> MAE 84.1, hole [255,255,255]
    //   0..1     in + as-is 0..255     out -> MAE  0.0, hole [78,127,128]
    // The mean/std below are kept ONLY so legacy callers that read them still
    // work; inputScale/outputScale are what buildFeeds and the de-norm use.
    inputScale: '0..1',
    outputScale: '0..255',
    mean: [0.485, 0.456, 0.406], // unused for this model (see inputScale)
    std: [0.229, 0.224, 0.225],
    outputChannels: 3,
    bestFor: 'large',
    legacyIO: false,
  },
};

// Default AI model: MI-GAN (fast, MIT, small). "Auto" (renderer side) may
// upgrade to LaMa for large regions.
const DEFAULT_MODEL = 'migan';

function isKnownModel(key) { return Object.prototype.hasOwnProperty.call(MODELS, key); }

function getModel(key) {
  if (key && isKnownModel(key)) return MODELS[key];
  return MODELS[DEFAULT_MODEL];
}

function resolveModelKey(key) {
  if (typeof key === 'string' && isKnownModel(key)) return key;
  return DEFAULT_MODEL;
}

// Choose the best model for a given masked-area share (0..1) per the Auto
// policy: small → Telea (no AI), mid → MI-GAN, large → LaMa.
function pickAutoModel(areaShare) {
  if (typeof areaShare !== 'number' || !isFinite(areaShare)) return DEFAULT_MODEL;
  if (areaShare > 0.15) return 'lama-big';
  return 'migan'; // mid (and anything the Telea tier defers upward)
}

module.exports = { MODELS, DEFAULT_MODEL, isKnownModel, getModel, resolveModelKey, pickAutoModel };
