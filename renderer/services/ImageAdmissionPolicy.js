// renderer/services/ImageAdmissionPolicy.js
// ============================================================================
// P3-A (360° Audit DA-H-001, DA-H-005): Single admission policy for images.
//
// Every image entry point (main canvas, asset panel, pipeline preview,
// drag-drop, clipboard) must check admission BEFORE loading the image
// into memory. This prevents OOM crashes from oversized images.
//
// Policy:
//   - Default limit: 32 MP (megapixels) — not 80MP
//   - Peak memory estimation: pixels * 4 bytes * concurrent_buffers
//   - MED-016: limits are STATIC (not dynamically adjusted by RAM).
//     The previous comment claimed "dynamic adjustment based on available
//     RAM" but no such logic existed. The constants below are the policy.
//   - Hard ceiling: 64 MP regardless of source
//
// Usage:
//   const { checkAdmission, ADMISSION_LIMITS } = require('./ImageAdmissionPolicy');
//   const result = checkAdmission({ width: 9000, height: 9000 });
//   if (!result.ok) showError(result.error);
// ============================================================================

/** Default maximum megapixels for a single image. */
const DEFAULT_MAX_MP = 32;

/** Hard ceiling regardless of available RAM. */
const HARD_CEILING_MP = 64;

/** Bytes per pixel (RGBA). */
const BYTES_PER_PIXEL = 4;

/** Estimated concurrent buffers (canvas + undo + thumbnail + decode). */
const CONCURRENT_BUFFERS = 4;

/** Maximum memory budget for image buffers (2 GB). */
const MAX_MEMORY_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Admission limits configuration.
 */
const ADMISSION_LIMITS = Object.freeze({
  maxMegapixels: DEFAULT_MAX_MP,
  hardCeilingMP: HARD_CEILING_MP,
  bytesPerPixel: BYTES_PER_PIXEL,
  concurrentBuffers: CONCURRENT_BUFFERS,
  maxMemoryBudgetBytes: MAX_MEMORY_BUDGET_BYTES,
});

/**
 * Check if an image with the given dimensions can be admitted.
 *
 * @param {{ width: number, height: number, source?: string }} opts
 * @returns {{ok: true, megapixels: number, estimatedMemoryMB: number} | {ok: false, error: string, megapixels: number}}
 */
function checkAdmission(opts) {
  const { width, height, source } = opts || {};

  if (!width || !height || typeof width !== 'number' || typeof height !== 'number') {
    return { ok: false, error: 'Image dimensions are required for admission check', megapixels: 0 };
  }

  if (width <= 0 || height <= 0) {
    return { ok: false, error: 'Image dimensions must be positive', megapixels: 0 };
  }

  const pixels = width * height;
  const megapixels = pixels / 1_000_000;
  const estimatedMemoryBytes = pixels * BYTES_PER_PIXEL * CONCURRENT_BUFFERS;
  const estimatedMemoryMB = Math.round(estimatedMemoryBytes / (1024 * 1024));

  // Check hard ceiling first
  if (megapixels > HARD_CEILING_MP) {
    return {
      ok: false,
      error: `Image is ${megapixels.toFixed(1)} MP — exceeds the hard ceiling of ${HARD_CEILING_MP} MP. ` +
        `Dimensions: ${width}×${height}. Estimated memory: ~${estimatedMemoryMB} MB. ` +
        `Please resize the image before importing.`,
      megapixels,
    };
  }

  // Check default limit
  if (megapixels > DEFAULT_MAX_MP) {
    return {
      ok: false,
      error: `Image is ${megapixels.toFixed(1)} MP — exceeds the ${DEFAULT_MAX_MP} MP admission limit. ` +
        `Dimensions: ${width}×${height}. Estimated memory: ~${estimatedMemoryMB} MB. ` +
        `Please resize the image before importing.`,
      megapixels,
    };
  }

  // Check memory budget
  if (estimatedMemoryBytes > MAX_MEMORY_BUDGET_BYTES) {
    return {
      ok: false,
      error: `Image would require ~${estimatedMemoryMB} MB of memory — exceeds the ${Math.round(MAX_MEMORY_BUDGET_BYTES / (1024 * 1024))} MB budget. ` +
        `Dimensions: ${width}×${height}.`,
      megapixels,
    };
  }

  return { ok: true, megapixels, estimatedMemoryMB };
}

/**
 * Check admission from a file size estimate (when dimensions aren't known yet).
 * Uses a conservative 10:1 compression ratio estimate.
 *
 * @param {{ fileSizeBytes: number, source?: string }} opts
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function checkAdmissionByFileSize(opts) {
  const { fileSizeBytes, source } = opts || {};

  if (!fileSizeBytes || typeof fileSizeBytes !== 'number') {
    return { ok: false, error: 'File size is required' };
  }

  // Conservative: assume 10:1 compression (PNG is ~2:1, JPEG ~10:1, WebP ~15:1)
  // Uncompressed size = fileSize * 10
  const estimatedUncompressed = fileSizeBytes * 10;
  const estimatedPixels = estimatedUncompressed / BYTES_PER_PIXEL;
  const estimatedMP = estimatedPixels / 1_000_000;

  if (estimatedMP > HARD_CEILING_MP) {
    return {
      ok: false,
      error: `File is ${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB — estimated ${estimatedMP.toFixed(0)} MP uncompressed, ` +
        `exceeds the ${HARD_CEILING_MP} MP ceiling${source ? ` (${source})` : ''}.`,
    };
  }

  return { ok: true };
}

const _api = {
  checkAdmission,
  checkAdmissionByFileSize,
  ADMISSION_LIMITS,
  DEFAULT_MAX_MP,
  HARD_CEILING_MP,
};

// Dual export: the renderer loads this via a <script> tag (window global,
// like every other renderer/services module), while unit tests require()
// it directly as CommonJS.
if (typeof window !== 'undefined') window.ImageAdmissionPolicy = _api;
if (typeof module !== 'undefined' && module.exports) module.exports = _api;
