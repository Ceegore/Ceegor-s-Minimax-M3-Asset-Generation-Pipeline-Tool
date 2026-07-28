// src/inpaint/index.js
// High-level wrapper for AI inpainting (LaMa / MI-GAN). Spawns
// src/inpaint/inpaint_node.js as a child node process (ELECTRON_RUN_AS_NODE),
// mirroring src/isnetbg.js's runNode: the ~28–208 MB model lives in a separate
// process the OS can kill without affecting the renderer.
//
// Used by main/ipc/registerInpaintOnnxIpc.js. The pure-JS Telea tier
// (src/inpaint.js + registerInpaintIpc.js) handles small fixes without a model.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveModelKey, pickAutoModel, getModel } = require('./modelRegistry');
const { getSafeProcessEnv } = require('../cpuGuard');
const assetPaths = require('../assetPaths');
const jobRegistry = require('../jobRegistry');

function findModelPath(modelFile) {
  const p = assetPaths.resolveAsset('models', modelFile);
  if (p && fs.existsSync(p)) return p;
  const fallback = assetPaths.resolveAsset('', modelFile);
  if (fallback && fs.existsSync(fallback)) return fallback;
  return null;
}

// Run AI inpaint. `maskPath` is a grayscale PNG (white = fill).
// Returns { ok, code, stderr, outputPath }.
function runOnnx(srcPath, maskPath, dstPath, opts) {
  opts = opts || {};
  // "auto" model: choose by masked-area share if provided, else default.
  // R6.6.4.AuditFix: check for 'auto' BEFORE resolveModelKey — the registry
  // doesn't list 'auto' as a known key, so resolveModelKey('auto') would
  // collapse it to 'migan' and the pickAutoModel branch was dead code.
  let modelKey = (opts.model === 'auto') ? pickAutoModel(opts.areaShare) : resolveModelKey(opts.model);
  // KGO8-008: an unknown model key used to be swapped for the default in
  // silence — asking for 'lama-big' typo'd, or for a key that no longer
  // exists, ran MI-GAN and still reported ok:true, so the caller could not
  // tell which model actually produced the image. The fallback itself is
  // deliberate (a stale key from state.json must not hard-fail), but it is
  // now announced: this line lands in `stderr`, which the IPC legacy adapter
  // promotes into the result's `warnings[]` on success.
  const modelFellBack = typeof opts.model === 'string' && opts.model
    && opts.model !== 'auto' && opts.model !== modelKey;
  const fallbackNotice = modelFellBack
    ? `Unknown inpaint model "${opts.model}" — using "${modelKey}" instead.\n` : '';
  const useGpu = (opts.useGpu === false) ? '0' : '1';
  const scriptPath = path.join(__dirname, 'inpaint_node.js');
  const args = [scriptPath, '--input', srcPath, '--mask', maskPath, '--output', dstPath,
    '--use-gpu', useGpu, '--model', modelKey];
  if (Number(opts.intraOpNumThreads) > 0) args.push('--intra-op', String(Math.max(1, Math.min(64, Math.round(Number(opts.intraOpNumThreads))))));
  if (Number(opts.interOpNumThreads) > 0) args.push('--inter-op', String(Math.max(1, Math.min(64, Math.round(Number(opts.interOpNumThreads))))));
  if (opts.executionMode === 'parallel') args.push('--execution-mode', 'parallel');

  const modelFile = getModel(modelKey).file;
  const modelPathFound = findModelPath(modelFile);
  if (!modelPathFound) {
    return Promise.resolve({ ok: false, code: -1, stderr: 'Model file missing: bin/models/' + modelFile + ' (place it there or via Settings)', outputPath: null });
  }
  const modelDir = path.dirname(modelPathFound);
  return new Promise((resolveP) => {
    let stderr = fallbackNotice; // KGO8-008: surfaced as a warning, not swallowed
    let killed = false;
    let proc;
    try {
      proc = spawn(process.execPath, args, {
        env: {
          ...getSafeProcessEnv(),
          ELECTRON_RUN_AS_NODE: '1',
          MINIMAX_BIN_DIR: path.dirname(modelDir),
          MINIMAX_MODEL_DIR: modelDir,
          MINIMAX_APP_ROOT: assetPaths.getConfig().appRoot,
          MINIMAX_RESOURCES_PATH: assetPaths.getConfig().resourcesPath,
          MINIMAX_USER_DATA_PATH: assetPaths.getConfig().userDataPath,
        },
        windowsHide: true,
      });
    } catch (err) {
      resolveP({ ok: false, code: -1, stderr: String(err.message || err), outputPath: null });
      return;
    }
    // KGO5-023: lower priority so the OS stays responsive during heavy inference.
    // KGO6-005: use the proper BELOW_NORMAL constant (numeric 1 fell in the NORMAL band).
    try { if (process.platform === 'win32') { const _os = require('os'); _os.setPriority(proc.pid, _os.constants.priority.PRIORITY_BELOW_NORMAL); } } catch (_) {}
    if (opts.jobId) jobRegistry.register(opts.jobId, proc, { backend: 'inpaint-onnx', srcPath, dstPath });
    // 10-minute ceiling (same as bg-removal); AI inpaint on CPU is typically
    // a few seconds for a 512² tile, longer for large tiled regions.
    const timeoutMs = 10 * 60 * 1000;
    const killTimer = setTimeout(() => {
      killed = true;
      if (opts.jobId) jobRegistry.unregister(opts.jobId, proc);
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolveP({ ok: false, code: -1, stderr: 'inpaint_node timed out after ' + Math.round(timeoutMs / 1000) + 's and was killed.', outputPath: null });
    }, timeoutMs);
    proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    proc.on('error', (err) => {
      if (killed) return;
      clearTimeout(killTimer);
      if (opts.jobId) jobRegistry.unregister(opts.jobId, proc);
      resolveP({ ok: false, code: -1, stderr: String(err.message || err), outputPath: null });
    });
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (opts.jobId) jobRegistry.unregister(opts.jobId, proc);
      if (killed) return;
      if (code === 0 && fs.existsSync(dstPath)) {
        resolveP({ ok: true, code, stderr, outputPath: dstPath });
      } else {
        resolveP({ ok: false, code, stderr: stderr || ('inpaint_node exited with code ' + code), outputPath: null });
      }
    });
  });
}

module.exports = { runOnnx, findModelPath };
