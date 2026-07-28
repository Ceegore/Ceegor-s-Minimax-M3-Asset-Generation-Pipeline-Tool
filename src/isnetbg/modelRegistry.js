// src/isnetbg/modelRegistry.js
// Single source of truth for every background-removal model the
// tool knows about. Everything model-specific (file name, download
// URL, preprocessing constants, postprocessing steps) lives HERE —
// the worker (isnetbg_node.js), the discovery module, the IPC layer
// and setup.js all read from this table instead of hardcoding.
//
// IMPORTANT (license audit, 2026-07): only MIT / Apache-2.0 models
// get a `url` (auto-downloadable + redistributable). Models with
// restrictive licenses (e.g. BRIA RMBG-2.0, non-commercial) may be
// added by users as hand-placed files but must NEVER get a url here.

const MODELS = {
  'isnet-general-use': {
    file: 'isnet-general-use.onnx',
    url: 'https://huggingface.co/x-Liola-x/isnet-general-use-onnx/resolve/main/isnet-general-use.onnx',
    sha256: '4c56bbc21588459dda11efba5a4a8ee163969da109ae170fb1988c1c2ea4a90a',
    md5: null,
    sizeMB: 176,
    license: 'Apache-2.0',
    label: 'IS-Net (fast, default)',
    inputSize: 1024,
    resizeKernel: 'cubic',
    divideByMax: false,               // legacy: /255
    mean: [0.5, 0.5, 0.5],
    std: [1, 1, 1],
    postSigmoid: false,
    postMinMax: true,                 // H8-008: min-max-normalize the matte (rembg parity) — removes the low-contrast haze / gray halos IS-Net produced with the raw output.
    legacyIO: true,                   // keep hardcoded 'input' feed + output/sigmoid probing
  },
  'birefnet-general-lite': {
    file: 'birefnet-general-lite.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx',
    sha256: '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333',
    md5: '4fab47adc4ff364be1713e97b7e66334',
    sizeMB: 224,
    license: 'MIT',
    label: 'BiRefNet Lite (recommended — much cleaner edges, ~3–8× slower)',
    inputSize: 1024,
    resizeKernel: 'lanczos3',
    divideByMax: true,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    postSigmoid: true,
    postMinMax: true,
    legacyIO: false,
  },
  'birefnet-general': {
    file: 'birefnet-general.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-epoch_244.onnx',
    sha256: '58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c',
    md5: '7a35a0141cbbc80de11d9c9a28f52697',
    sizeMB: 930,
    license: 'MIT',
    label: 'BiRefNet (highest quality, slow on CPU, needs ~4 GB RAM)',
    inputSize: 1024,
    resizeKernel: 'lanczos3',
    divideByMax: true,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    postSigmoid: true,
    postMinMax: true,
    legacyIO: false,
  },
  'birefnet-portrait': {
    file: 'birefnet-portrait.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-portrait-epoch_150.onnx',
    sha256: '1ba1c8ff5a7bbfadc8d8d13fb11d7be793f91f23d9d466549e37a854f6668f99',
    md5: 'c3a64a6abf20250d090cd055f12a3b67',
    sizeMB: 930,
    license: 'MIT',
    label: 'BiRefNet Portrait (best for people/hair, slow on CPU)',
    inputSize: 1024,
    resizeKernel: 'lanczos3',
    divideByMax: true,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    postSigmoid: true,
    postMinMax: true,
    legacyIO: false,
  },
};

const DEFAULT_MODEL = 'isnet-general-use';

function isKnownModel(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(MODELS, key);
}

/** Returns the registry entry; unknown/absent keys fall back to the default. */
function getModel(key) {
  return isKnownModel(key) ? MODELS[key] : MODELS[DEFAULT_MODEL];
}

/**
 * The sanitized key actually used (mirrors getModel's fallback).
 *
 * KGO7-019: this is a pure function again. The previous version wrote the
 * fallback warning to `process.stderr`, which in a packaged Windows GUI
 * app has no attached console — the message went nowhere, and a registry
 * module should not do I/O anyway. Callers that need to tell the user use
 * `resolveModelKeyEx()` and surface `fellBack` through their own UI.
 */
function resolveModelKey(key) {
  if (isKnownModel(key)) return key;
  return DEFAULT_MODEL;
}

/**
 * Same resolution as `resolveModelKey`, but reports whether a genuinely
 * bogus key was silently replaced by the default. `undefined`/`null`/`''`
 * is the normal "no model specified" path and is NOT a fallback.
 * @param {string|null|undefined} key
 * @returns {{ key: string, fellBack: boolean, requested: string|null }}
 */
function resolveModelKeyEx(key) {
  const resolved = resolveModelKey(key);
  const requested = (key == null || key === '') ? null : String(key);
  return { key: resolved, fellBack: requested !== null && requested !== resolved, requested };
}

module.exports = { MODELS, DEFAULT_MODEL, isKnownModel, getModel, resolveModelKey, resolveModelKeyEx };
