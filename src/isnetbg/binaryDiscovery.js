// src/isnetbg/binaryDiscovery.js
// Detection of the isnetbg backend (binary or Node.js wrapper).
// Caches path resolution + backend selection.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { MODELS, DEFAULT_MODEL, getModel } = require('./modelRegistry');

const BINARY_NAME = process.platform === 'win32' ? 'isnetbg.exe' : 'isnetbg';
const MODEL_NAME = 'isnet-general-use.onnx';
const MODELS_DIR_NAME = 'models';

/** @type {string|null} */
let cachedBinaryPath = null;

/** @type {string|null} */
let cachedBackend = null; // 'binary' | 'node' | null

const assetPaths = require('../assetPaths');

function findModelPath(modelKey = DEFAULT_MODEL) {
  const modelFile = getModel(modelKey).file;
  const p = assetPaths.resolveAsset(MODELS_DIR_NAME, modelFile);
  if (p && fs.existsSync(p)) return p;
  
  // App-root layout fallback (rare, no models/ subdir)
  const fallback = assetPaths.resolveAsset('', modelFile);
  if (fallback && fs.existsSync(fallback)) return fallback;
  
  return null;
}

function listModelStatus() {
  const out = {};
  for (const key of Object.keys(MODELS)) {
    const p = findModelPath(key);
    out[key] = {
      present: !!p,
      path: p,
      label: MODELS[key].label,
      sizeMB: MODELS[key].sizeMB,
      license: MODELS[key].license,
      downloadable: !!MODELS[key].url,
    };
  }
  return out;
}

function findBinary() {
  if (cachedBinaryPath) {
    try { if (fs.existsSync(cachedBinaryPath)) return cachedBinaryPath; } catch (_) { /* ignore */ }
    cachedBinaryPath = null;
  }
  // 1) where isnetbg.exe / which isnetbg on PATH
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(whichCmd, [BINARY_NAME], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const found = r.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
      if (found) { cachedBinaryPath = found; return found; }
    }
  } catch (_) { /* ignore */ }
  // 2) ./bin/isnetbg[.exe] next to package root
  try {
    const p = assetPaths.resolveAsset('', BINARY_NAME);
    if (p && fs.existsSync(p)) { cachedBinaryPath = p; return p; }
  } catch (_) { /* ignore */ }
  return null;
}

function checkNodeBackendAvailable() {
  // The Node.js backend lives in src/isnetbg_node.js and needs
  // onnxruntime-node to be installed. We don't actually import
  // the module here (that would be expensive) — we just check
  // whether the file can be resolved.
  try {
    require.resolve('onnxruntime-node', { paths: [path.join(__dirname, '..', '..')] });
    return true;
  } catch (_) { return false; }
}

/**
 * Picks the best available backend. The binary takes precedence
 * (explicitly installed by the user); the Node.js backend is the
 * fallback.
 * @returns {'binary' | 'node' | null}
 */
function pickBackend() {
  if (cachedBackend !== null) return cachedBackend;
  const bin = findBinary();
  const nodeOk = checkNodeBackendAvailable();
  if (bin) {
    cachedBackend = 'binary';
  } else if (nodeOk) {
    cachedBackend = 'node';
  } else {
    cachedBackend = null;
  }
  return cachedBackend;
}

function resetCache() {
  cachedBinaryPath = null;
  cachedBackend = null;
}

// PE-014: central "auto-best-compatible" model policy. All entry points
// (state sanitizer, pipeline column sanitizer, editor) call this to
// determine the default remove-BG model when the user has not made an
// explicit choice. Prefers BiRefNet Lite (much cleaner edges) when its
// model file is present AND the Node backend is available (BiRefNet
// requires onnxruntime-node); falls back to IS-Net (always bundled).
// A visible downgrade note is emitted so the user knows why they got
// IS-Net instead of BiRefNet Lite.
function resolveAutoBestModel() {
  try {
    if (checkNodeBackendAvailable() && findModelPath('birefnet-general-lite')) {
      return 'birefnet-general-lite';
    }
  } catch (_) { /* defensive: any probe failure → safe fallback */ }
  return DEFAULT_MODEL;
}

module.exports = {
  BINARY_NAME,
  MODEL_NAME,
  findModelPath,
  findBinary,
  pickBackend,
  resetCache,
  resolveAutoBestModel,
  // Exported so src/isnetbg.js can build the full "backend not
  // available" diagnostic — the wrapper checks both the binary and
  // onnxruntime-node availability to produce an actionable message.
  checkNodeBackendAvailable,
  listModelStatus,
};
