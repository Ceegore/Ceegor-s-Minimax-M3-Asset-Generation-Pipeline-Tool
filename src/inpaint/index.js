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
const jobRegistry = require('../services/jobRegistryCompat');

function findModelPath(modelFile) {
  const p = assetPaths.resolveAsset('models', modelFile);
  if (p && fs.existsSync(p)) return p;
  const fallback = assetPaths.resolveAsset('', modelFile);
  if (fallback && fs.existsSync(fallback)) return fallback;
  return null;
}

// H-021 (_5 audit): validate that the ONNX output is a real, non-truncated
// PNG with non-zero dimensions. Exit 0 + file-exists alone is insufficient
// because the child can crash after creating an empty/partial file, or the
// model can produce garbage that sharp still writes as a 0×0 image.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const MIN_OUTPUT_BYTES = 64; // smallest valid PNG is ~67 bytes

function validatePngOutput(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MIN_OUTPUT_BYTES) {
      return { ok: false, error: 'output file is too small (' + stat.size + ' bytes) — likely truncated' };
    }
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(24); // 8 magic + 4 len + 4 type + 4 IHDR dims (partial)
    const bytesRead = fs.readSync(fd, header, 0, 24, 0);
    fs.closeSync(fd);
    if (bytesRead < 24) return { ok: false, error: 'output file too short to contain PNG header' };
    if (!header.slice(0, 8).equals(PNG_MAGIC)) {
      return { ok: false, error: 'output file does not have a valid PNG signature' };
    }
    // IHDR starts at offset 16 (after 8 magic + 4 chunk-length + 4 'IHDR').
    // Width and height are big-endian uint32 at offsets 16 and 20.
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (width === 0 || height === 0) {
      return { ok: false, error: 'output PNG has zero dimensions (' + width + 'x' + height + ')' };
    }
    // Sanity: reject absurdly large outputs (> 32768 per axis).
    if (width > 32768 || height > 32768) {
      return { ok: false, error: 'output PNG dimensions exceed pixel budget (' + width + 'x' + height + ')' };
    }
    return { ok: true, width, height };
  } catch (e) {
    return { ok: false, error: 'output validation failed: ' + (e && e.message || e) };
  }
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
    // H-021 (_5 audit): cap stderr at 1 MB to prevent memory exhaustion
    // from a chatty or broken child process.
    const STDERR_CAP = 1024 * 1024;
    proc.stderr.on('data', (b) => {
      if (stderr.length < STDERR_CAP) stderr += b.toString('utf8');
      else if (stderr.length === STDERR_CAP) stderr += '\n[stderr truncated at 1 MB]';
    });
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
        // H-021 (_5 audit): validate the output is a real, decodable PNG
        // with non-zero dimensions before reporting success.
        const check = validatePngOutput(dstPath);
        if (!check.ok) {
          resolveP({ ok: false, code, stderr: stderr + '\nOutput validation: ' + check.error, outputPath: null });
        } else {
          resolveP({ ok: true, code, stderr, outputPath: dstPath });
        }
      } else {
        resolveP({ ok: false, code, stderr: stderr || ('inpaint_node exited with code ' + code), outputPath: null });
      }
    });
  });
}

module.exports = { runOnnx, findModelPath };
