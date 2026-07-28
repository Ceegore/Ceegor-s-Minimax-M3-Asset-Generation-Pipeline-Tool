// src/cpuGuard.js
// Centralized CPU Core Reservation & Concurrency Management.
// Ensures that heavy background operations (Real-ESRGAN, Sharp/libvips,
// ONNX Runtime, FFmpeg) reserve at least 2 CPU cores for the operating
// system, Electron main process, and user interface event loop.

const os = require('os');

/**
 * Calculates a safe maximum thread count that leaves at least 2 CPU cores free.
 * @returns {number} Thread count (>= 1).
 */
function getSafeThreadCount() {
  const cores = (typeof os.availableParallelism === 'function')
    ? os.availableParallelism()
    : ((os.cpus() || []).length || 4);
  return Math.max(1, cores - 2);
}

/**
 * Applies the safe concurrency limit to a loaded Sharp library instance.
 * @param {object} sharpInstance - The sharp module object.
 */
function applySharpThreadCap(sharpInstance) {
  if (sharpInstance && typeof sharpInstance.concurrency === 'function') {
    try {
      sharpInstance.concurrency(getSafeThreadCount());
    } catch (_) {}
  }
}

/**
 * Generates process environment variables configured with safe thread limits.
 * @param {object} [baseEnv] - Optional existing environment object.
 * @returns {object} Merged environment object with thread cap variables.
 */
function getSafeProcessEnv(baseEnv) {
  const threads = String(getSafeThreadCount());
  return Object.assign({}, baseEnv || process.env, {
    OMP_NUM_THREADS: threads,
    OPENBLAS_NUM_THREADS: threads,
    MKL_NUM_THREADS: threads,
    VECLIB_MAXIMUM_THREADS: threads,
    NUMEXPR_NUM_THREADS: threads,
    VIPS_CONCURRENCY: threads,
    UV_THREADPOOL_SIZE: threads,
  });
}

module.exports = {
  getSafeThreadCount,
  applySharpThreadCap,
  getSafeProcessEnv,
};
