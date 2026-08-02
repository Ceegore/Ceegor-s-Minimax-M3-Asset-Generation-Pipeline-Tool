// src/isnetbg.js
// Wrapper around the optional `isnetbg` background-removal tool.
// Two backends are supported, in priority order:
//
//   1. External binary (`./bin/isnetbg.exe` or anywhere on PATH) —
//      the C# / .NET 6+ reference implementation, or any
//      compatible CLI following the documented flag contract.
//   2. Pure-Node.js implementation (`./src/isnetbg_node.js`)
//      using onnxruntime-node + sharp. This is the **default**
//      backend for the in-app pipeline because it removes the
//      C# / .NET SDK requirement — `npm install` is the only
//      build step. The C# binary remains a supported fast-path
//      for users who want to ship one.
//
// Binary discovery (findModelPath/findBinary/pickBackend) lives in
// `./isnetbg/binaryDiscovery.js`; this module re-exports the same API.

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getSafeProcessEnv } = require('./cpuGuard');
const jobRegistry = require('./services/jobRegistryCompat');

// H-021 (_5 audit): validate ONNX/background-removal output is a real PNG.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const MIN_OUTPUT_BYTES = 64;
const STDERR_CAP = 1024 * 1024; // 1 MB

function validatePngOutput(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MIN_OUTPUT_BYTES) {
      return { ok: false, error: 'output file is too small (' + stat.size + ' bytes) — likely truncated' };
    }
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(24);
    const bytesRead = fs.readSync(fd, header, 0, 24, 0);
    fs.closeSync(fd);
    if (bytesRead < 24) return { ok: false, error: 'output file too short to contain PNG header' };
    if (!header.slice(0, 8).equals(PNG_MAGIC)) {
      return { ok: false, error: 'output file does not have a valid PNG signature' };
    }
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (width === 0 || height === 0) {
      return { ok: false, error: 'output PNG has zero dimensions (' + width + 'x' + height + ')' };
    }
    if (width > 32768 || height > 32768) {
      return { ok: false, error: 'output PNG dimensions exceed pixel budget (' + width + 'x' + height + ')' };
    }
    return { ok: true, width, height };
  } catch (e) {
    return { ok: false, error: 'output validation failed: ' + (e && e.message || e) };
  }
}

const {
  findModelPath,
  findBinary,
  pickBackend,
  resetCache,
  // Imported so the "backend not available" diagnostic below can call it.
  checkNodeBackendAvailable,
  listModelStatus,
} = require('./isnetbg/binaryDiscovery');

const { getModel, resolveModelKey, DEFAULT_MODEL } = require('./isnetbg/modelRegistry');

/** @type {string|null} */
let cachedBinaryVersion = null;

function isAvailable() {
  return pickBackend() !== null && !!findModelPath();
}

function getBinaryPath() {
  if (pickBackend() !== 'binary') return null;
  return findBinary();
}

function getModelPath() {
  return findModelPath();
}

/**
 * Run on a single image. `opts.useGpu` is forwarded to both
 * backends (the binary's --use-gpu flag and the Node.js wrapper's
 * session EP selection).
 *
 * @param {string} srcPath
 * @param {string} dstPath
 * @param {{ useGpu?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, code: number, stderr: string, outputPath: string|null }>}
 */
function run(srcPath, dstPath, opts = {}) {
  const modelKey = resolveModelKey(opts.model);
  const m = getModel(modelKey);
  if (!findModelPath(modelKey)) {
    return Promise.resolve({
      ok: false, code: -1,
      stderr: `Model file missing: ${m.file}. Download it in Settings → Image handling → Background removal model, or run \`npm run setup -- --${modelKey}\`.`,
      outputPath: null,
    });
  }
  const backend = (modelKey === DEFAULT_MODEL) ? pickBackend() : (checkNodeBackendAvailable() ? 'node' : null);
  if (!backend) {
    if (modelKey !== DEFAULT_MODEL) {
      return Promise.resolve({
        ok: false, code: -1,
        stderr: 'BiRefNet models require the bundled Node.js backend (onnxruntime-node); it was not found in the packaged app. Rebuild or reinstall the current release.',
        outputPath: null,
      });
    }
    const reasons = [];
    try { if (!findBinary()) reasons.push('no isnetbg.exe found'); } catch (_) {}
    try { if (!checkNodeBackendAvailable()) reasons.push('onnxruntime-node not bundled in the app'); } catch (_) {}
    const why = reasons.length ? ' (' + reasons.join('; ') + ')' : '';
    return Promise.resolve({
      ok: false, code: -1,
      stderr: 'isnetbg backend not available' + why + '. Run `npm run setup` in a source checkout, or reinstall a complete release package.',
      outputPath: null,
    });
  }
  // KGO8-008: announce a model substitution instead of hiding it. An unknown
  // key (typo, or one removed from the registry) silently ran the default and
  // still reported ok:true, so the caller could not tell which model produced
  // the cut-out. The fallback stays — a stale key from state.json must not
  // hard-fail — but the notice rides out in `stderr`, which the IPC legacy
  // adapter promotes into the result's `warnings[]` on success.
  const fellBack = typeof opts.model === 'string' && opts.model && opts.model !== modelKey;
  const notice = fellBack ? `Unknown background-removal model "${opts.model}" — using "${modelKey}" instead.\n` : '';
  const p = backend === 'binary'
    ? runBinary(srcPath, dstPath, opts)
    : runNode(srcPath, dstPath, Object.assign({}, opts, { model: modelKey }));
  return notice ? p.then((r) => Object.assign({}, r, { stderr: notice + (r.stderr || '') })) : p;
}

function runBinary(srcPath, dstPath, opts) {
  const binary = findBinary();
  const useGpu = (opts.useGpu === false) ? '0' : '1';
  return new Promise((resolveP) => {
    const args = ['--input', srcPath, '--output', dstPath, '--use-gpu', useGpu];
    // PE-015: forward postprocess opts to the external binary.
    if (opts.postClean === false) args.push('--post-clean', '0');
    if (opts.featherPx != null && Number.isFinite(Number(opts.featherPx))) {
      args.push('--feather', String(Math.max(0, Math.min(8, Math.round(Number(opts.featherPx))))));
    }
    if (opts.defringe === false) args.push('--defringe', '0');
    // Issue 6: guided-filter matte refinement (default ON in the worker).
    if (opts.refine === false) args.push('--refine', '0');
    let stderr = '';
    let proc;
    try {
      proc = spawn(binary, args, { windowsHide: true, env: getSafeProcessEnv() });
    } catch (err) {
      resolveP({ ok: false, code: -1, stderr: String(err.message || err), outputPath: null });
      return;
    }
    // KGO5-023: lower priority so the OS stays responsive during heavy inference.
    // KGO6-005: use the proper BELOW_NORMAL constant (numeric 1 fell in the NORMAL band).
    try { if (process.platform === 'win32') { const _os = require('os'); _os.setPriority(proc.pid, _os.constants.priority.PRIORITY_BELOW_NORMAL); } } catch (_) {}
    if (opts.jobId) jobRegistry.register(opts.jobId, proc, { backend: 'isnetbg', srcPath, dstPath });
    proc.stderr.on('data', (b) => {
      if (stderr.length < STDERR_CAP) stderr += b.toString('utf8');
      else if (stderr.length === STDERR_CAP) stderr += '\n[stderr truncated at 1 MB]';
    });
    proc.on('error', (err) => {
      resetCache();
      if (opts.jobId) jobRegistry.unregister(opts.jobId, proc);
      resolveP({ ok: false, code: -1, stderr: String(err.message || err), outputPath: null });
    });
    proc.on('close', (code) => {
      if (opts.jobId) jobRegistry.unregister(opts.jobId, proc);
      if (code === 0 && fs.existsSync(dstPath)) {
        const check = validatePngOutput(dstPath);
        if (!check.ok) {
          resolveP({ ok: false, code, stderr: stderr + '\nOutput validation: ' + check.error, outputPath: null });
        } else {
          resolveP({ ok: true, code, stderr, outputPath: dstPath });
        }
      } else {
        resolveP({ ok: false, code, stderr: stderr || `isnetbg exited with code ${code}`, outputPath: null });
      }
    });
  });
}

function runNode(srcPath, dstPath, opts) {
  // Spawn src/isnetbg_node.js as a child Node process. The
  // ~170 MB model lives in a separate process that can be killed
  // by the OS without affecting the renderer.
  const modelKey = resolveModelKey(opts.model);
  const useGpu = (opts.useGpu === false) ? '0' : '1';
  const scriptPath = path.join(__dirname, 'isnetbg_node.js');
  const args = [scriptPath, '--input', srcPath, '--output', dstPath, '--use-gpu', useGpu];
  if (modelKey !== DEFAULT_MODEL) {
    args.push('--model', modelKey);
  }
  // Advanced session opts: forwarded as extra CLI flags so the child
  // can apply them to the onnxruntime InferenceSession.
  // intra/interOpNumThreads 0 means "let onnxruntime pick" (the
  // default); we only forward the flag when the user set a positive
  // value so the default spawn argv stays unchanged. executionMode
  // defaults to 'sequential'.
  if (Number(opts.intraOpNumThreads) > 0) {
    args.push('--intra-op', String(Math.max(1, Math.min(64, Math.round(Number(opts.intraOpNumThreads))))));
  }
  if (Number(opts.interOpNumThreads) > 0) {
    args.push('--inter-op', String(Math.max(1, Math.min(64, Math.round(Number(opts.interOpNumThreads))))));
  }
  if (opts.executionMode === 'parallel') {
    args.push('--execution-mode', 'parallel');
  }
  // PE-015: postprocess opts forwarded to the worker so callers can
  // control edge cleanup (defaults: postClean=1, featherPx=1, defringe=1).
  if (opts.postClean === false) args.push('--post-clean', '0');
  if (opts.featherPx != null && Number.isFinite(Number(opts.featherPx))) {
    args.push('--feather', String(Math.max(0, Math.min(8, Math.round(Number(opts.featherPx))))));
  }
  if (opts.defringe === false) args.push('--defringe', '0');
  // Issue 6: guided-filter matte refinement (default ON in the worker).
  if (opts.refine === false) args.push('--refine', '0');
  const modelDir = path.dirname(findModelPath(modelKey) || '');
  const binDir = path.dirname(modelDir);
  return new Promise((resolveP) => {
    let stderr = '';
    let proc;
    let killed = false;
    try {
      proc = spawn(process.execPath, args, {
        env: {
          ...getSafeProcessEnv(),
          ELECTRON_RUN_AS_NODE: '1',
          MINIMAX_BIN_DIR: binDir,
          MINIMAX_MODEL_DIR: modelDir,
          MINIMAX_APP_ROOT: require('./assetPaths').getConfig().appRoot,
          MINIMAX_RESOURCES_PATH: require('./assetPaths').getConfig().resourcesPath,
          MINIMAX_USER_DATA_PATH: require('./assetPaths').getConfig().userDataPath,
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
    if (opts.jobId) jobRegistry.register(opts.jobId, proc, { backend: 'isnetbg-node', srcPath, dstPath });
    // Hard cap on the inference time (10 min). CPU inference of a
    // 1024×1024 IS-Net mask on a typical laptop takes 1–4 s; GPU
    // is sub-second. 10 min is a generous ceiling for very large
    // images on slow hardware, but still short enough that a stuck
    // child doesn't freeze the renderer indefinitely.
    const timeoutMs = 10 * 60 * 1000;
    const killTimer = setTimeout(() => {
      killed = true;
      if (opts.jobId) jobRegistry.unregister(opts.jobId, proc);
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolveP({
        ok: false, code: -1,
        stderr: `isnetbg_node timed out after ${Math.round(timeoutMs / 1000)}s and was killed. The model file may be corrupt, or the image may be unusually large.`,
        outputPath: null,
      });
    }, timeoutMs);
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
        const check = validatePngOutput(dstPath);
        if (!check.ok) {
          resolveP({ ok: false, code, stderr: stderr + '\nOutput validation: ' + check.error, outputPath: null });
        } else {
          resolveP({ ok: true, code, stderr, outputPath: dstPath });
        }
      } else {
        resolveP({ ok: false, code, stderr: stderr || `isnetbg_node exited with code ${code}`, outputPath: null });
      }
    });
  });
}

function probeVersion() {
  const backend = pickBackend();
  if (backend === 'node') return 'node-onnxruntime';
  if (backend === 'binary') {
    if (cachedBinaryVersion !== null) return cachedBinaryVersion;
    const binary = findBinary();
    if (!binary) { cachedBinaryVersion = ''; return ''; }
    for (const flag of ['--version', '-v', '--help']) {
      try {
        const r = spawnSync(binary, [flag], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        const out = (r.stdout || '') + '\n' + (r.stderr || '');
        if (!out) continue;
        const m = out.match(/isnet(?:-?bg)?[- ]?v?(\d+\.\d+\.\d+(?:\.\d+)?)/i);
        if (m) { cachedBinaryVersion = m[1]; return cachedBinaryVersion; }
        const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        if (first) { cachedBinaryVersion = first.slice(0, 64); return cachedBinaryVersion; }
      } catch { /* try next flag */ }
    }
    cachedBinaryVersion = '';
    return '';
  }
  return '';
}

function isModelAvailable(modelKey) {
  return !!findModelPath(modelKey);
}

module.exports = {
  isAvailable,
  getBinaryPath,
  getModelPath,
  run,
  probeVersion,
  resetCache,
  isModelAvailable,
  listModelStatus,
};
