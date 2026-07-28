// src/imageOptimizer/keepOriginal.js
// KGO8-005: refuse to let an "optimisation" grow the file.
//
// A same-format recompress can legitimately come out LARGER than the source
// (a PNG already packed by a better encoder, an already-minimal WebP). The
// optimizer used to write that bigger buffer anyway and then clamp the
// negative saving with `Math.max(0, in - out)`, so the caller was told
// "ok, 0 bytes saved / 0 %" while the file had actually grown — and for an
// in-place optimize (which is what the pipeline's `optimize-format: keep`
// does) the user's original was destroyed and replaced by the larger file.
// Measured: 47 470 → 47 539 B on a plain PNG, reported as 0 % saved.
//
// A real format CONVERSION is deliberately exempt: the user asked for that
// format, so the output size is not the deciding factor there.
//
// Lives in its own module because src/imageOptimizer.js sits at its frozen
// lint SIZE_BUDGET (320 lines) and this guard would have pushed it over.

const fsp = require('fs').promises;
const path = require('path');

/**
 * Should the re-encode be discarded in favour of the untouched source?
 * @param {string} targetFormat resolved output format
 * @param {string} inputFormat  detected source format
 * @param {number} outBytes     size of the freshly encoded buffer
 * @param {number} inBytes      size of the source file
 */
function shouldKeepOriginal(targetFormat, inputFormat, outBytes, inBytes) {
  return targetFormat === inputFormat && outBytes >= inBytes;
}

/**
 * Build the "kept the original" result, copying the source to `outputPath`
 * when that is a different file so the output-path contract still holds.
 * Returns the optimize() result envelope (never throws).
 */
async function keepOriginalResult({ sharp, srcPath, outputPath, inputSize, outBytes, targetFormat }) {
  if (path.resolve(outputPath) !== path.resolve(srcPath)) {
    try {
      await fsp.copyFile(srcPath, outputPath);
    } catch (e) {
      return {
        ok: false,
        error: 'Could not write output file: ' + ((e && e.message) || e),
        outputPath: null, inputSize, outputSize: 0, savedBytes: 0, savedPercent: 0,
        format: targetFormat, width: 0, height: 0,
      };
    }
  }
  // KGO10-001: read the BYTES, never hand sharp a path here.
  //
  // `sharp(srcPath).metadata()` leaves the file open: libvips' webp decoder
  // keeps the handle after a path-based read, so every WebP that took this
  // bail-out became undeletable/unmovable for the rest of the session
  // (`EBUSY: resource busy or locked, unlink …`). That is fatal here because
  // the reachable callers — the pipeline's `optimize-format: keep` and the
  // 🗜 Optimize overlay — optimise IN PLACE and are routinely followed by a
  // delete, move or rename. Isolated with controls: sharp(path).metadata()
  // on a webp → EBUSY; sharp(buffer).metadata() → clean.
  //
  // This is the third time the class has shipped (KGOOO-1, KGOOO-2, this),
  // and src/imageOptimizer.js already warns about it for its own metadata
  // read. Treat any `sharp(<path>)` on a caller-owned file as a defect.
  let width = 0, height = 0;
  try {
    const meta = await sharp(await fsp.readFile(srcPath)).metadata();
    width = meta.width || 0;
    height = meta.height || 0;
  } catch (_) { /* best-effort — size reporting must not fail the op */ }
  return {
    ok: true,
    outputPath,
    inputSize,
    outputSize: inputSize,
    savedBytes: 0,
    savedPercent: 0,
    format: targetFormat,
    width,
    height,
    keptOriginal: true,
    warnings: [
      `Re-encoding would have produced a LARGER file (${inputSize} → ${outBytes} bytes); the original was kept.`,
    ],
  };
}

module.exports = { shouldKeepOriginal, keepOriginalResult };
