// src/imageResize.js
// Resize an image to a freely-chosen target resolution with best-practice,
// commercially-safe quality.
//
// Engine: Sharp / libvips (MIT licence — already a runtime dependency, see
// package.json). Resampling kernel is Lanczos3, libvips' best general-purpose
// resampler and the same family GIMP's NoHalo / Photoshop's "Bicubic Sharper"
// draw from. Lanczos preserves edges and fine detail far better than the
// default bilinear/cubic kernels on both up- and downscale.
//
// Aspect-ratio handling follows the GIMP/Photoshop "chain-link" model:
//   - The RENDERER computes the final (width, height) pair. When the link
//     is on, the pair already preserves the source aspect ratio, so there is
//     nothing to pad or letterbox — every output pixel is image content.
//   - fit:'fill' is used so that, when the link is OFF and W×H disagree with
//     the source AR, the image is stretched to exactly W×H (the documented
//     "force exact, distort if needed" behaviour), exactly like GIMP/Photoshop
//     with the chain unlocked.
//
// Quality refinement: a SUBTLE sharpen is applied only when DOWNSCALING
// (target area < source area). Photoshop's "Bicubic Sharper" does the same —
// downsampling softens, a light re-sharpen recovers perceived crispness. We
// deliberately do NOT sharpen on upscale (that would amplify artefacts; the
// dedicated Upscale feature / Real-ESRGAN is the right tool for enlargements).

const fsp = require('fs').promises;
const path = require('path');
const { randomUUID } = require('crypto');
const {
  sharp,
  SUPPORTED_INPUT,
  SUPPORTED_OUTPUT,
  normaliseFormat,
  normaliseQuality,
  inferFormatFromPath,
  detectRealFormat,
  ensureSharp,
} = require('./imageOptimizer/formatUtils');

// R0.1-006.B — Per-outputPath lock map. Two parallel resize() calls
// writing the same final outputPath must not race on the OS-rename.
// The first call wins; the second waits for the first to finish
// (and then proceeds — its own write overwrites the final file).
// Lock is released in a `finally` so a thrown resize() does not
// strand subsequent callers.
const _outputLocks = new Map(); // outputPath -> Promise<void>

function emptyResult(error) {
  return {
    ok: false, error: error || '',
    outputPath: null, inputSize: 0, outputSize: 0,
    width: 0, height: 0, srcWidth: 0, srcHeight: 0,
    format: '', downscaled: false,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Resize an image on disk to a target width × height (in pixels).
 *
 * @param {string} srcPath Absolute path to the source image.
 * @param {object} opts
 * @param {number} opts.width      Target width (px). Required (>0).
 * @param {number} opts.height     Target height (px). Required (>0).
 * @param {string} [opts.format]   Output format ('jpeg'|'png'|'webp'|'avif').
 *                                 null / 'keep' / omitted → keep source format.
 * @param {number} [opts.quality]  1..100 for lossy formats (default 82).
 * @param {boolean} [opts.stripMetadata] Default true (keeps ICC profile).
 * @param {boolean} [opts.sharpenOnDownscale] Default true — subtle sharpen when
 *                                 the target is smaller than the source.
 * @param {string} [opts.outputPath] Absolute output path. Default: sibling with
 *                                 `<stem>_resized_<W>x<H>.<ext>`.
 * @returns {Promise<object>} Result envelope (see emptyResult for the shape).
 */
async function resize(srcPath, opts) {
  opts = opts || {};

  if (!srcPath || typeof srcPath !== 'string') {
    return emptyResult('Source path is required.');
  }
  const sharpErr = ensureSharp();
  if (sharpErr) return emptyResult(sharpErr);

  // Dimensions: the renderer always sends the computed final pair. A raw 0 or
  // negative is a genuine error (it means "no resize" or a typo) — reject it so
  // the user gets a clear message instead of a 1px image. A value over the
  // libvips axis cap (65500) is clamped rather than rejected — gentler for a
  // fat-fingered input that's clearly meant to be "big".
  const MAX_DIM = 65500;
  // KGO8-004: libvips' per-axis cap is not enough — 65500×65500 is 4.3
  // GIGApixels. Clamping to it "succeeded" after 212 s and produced a 32 MB
  // PNG that sharp itself then refused to reopen ("Input image exceeds pixel
  // limit"), i.e. the app reported success for a file its own metadata,
  // preview and pipeline paths cannot read. Cap the PRODUCT at sharp's own
  // default pixel limit and REJECT rather than clamp, so the user is told
  // before a multi-minute wait instead of after it.
  const MAX_PIXELS = 268402689; // sharp's default limit (0x3FFF * 0x3FFF)
  const rawW = Number(opts.width);
  const rawH = Number(opts.height);
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) {
    return emptyResult('width and height must be positive numbers (1..' + MAX_DIM + ').');
  }
  // KGO9-005: check the REQUESTED size, and name it in the message. Running
  // this after the per-axis clamp made the error quote a number the user never
  // typed — asking for 66000×5000 (330 MP) reported "Target 65500×5000 is 328
  // megapixels", which is impossible to act on.
  const reqW = Math.round(rawW);
  const reqH = Math.round(rawH);
  if (reqW * reqH > MAX_PIXELS) {
    return emptyResult(
      `Target ${reqW}×${reqH} is ${Math.round((reqW * reqH) / 1e6)} megapixels — over the `
      + `${Math.round(MAX_PIXELS / 1e6)} MP limit. The result could not be reopened by this app. `
      + 'Choose a smaller size.');
  }
  const width = clampInt(rawW, 1, MAX_DIM, 0);
  const height = clampInt(rawH, 1, MAX_DIM, 0);

  let inputStat;
  try {
    inputStat = await fsp.stat(srcPath);
  } catch (e) {
    return emptyResult('Source file is not readable: ' + (e && e.message || e));
  }
  if (!inputStat.isFile()) {
    return emptyResult('Source path is not a regular file.');
  }
  // R8: cap the source read BEFORE any full-file read — detectRealFormat
  // below buffers the whole file, so a multi-GB "image" would OOM the
  // process before the old (later, post-sniff) cap could ever fire.
  // 256 MB matches the other image-source caps in the app.
  const MAX_RESIZE_SOURCE = 256 * 1024 * 1024; // 256 MB
  if (inputStat.size > MAX_RESIZE_SOURCE) {
    return emptyResult('Source image too large to resize (' + Math.round(inputStat.size / 1048576) + ' MB, cap 256 MB).');
  }

  // Format resolution: sniff real bytes, fall back to the path extension.
  const sniffedFormat = await detectRealFormat(srcPath);
  const inputFormat = SUPPORTED_INPUT.has(sniffedFormat) ? sniffedFormat : inferFormatFromPath(srcPath);
  if (!inputFormat) {
    return emptyResult('Unsupported input format. Supported: JPEG, PNG, WebP, AVIF.');
  }
  let targetFormat = normaliseFormat(opts.format);
  if (targetFormat === null) targetFormat = inputFormat; // 'keep'
  if (!SUPPORTED_OUTPUT.has(targetFormat)) {
    return emptyResult('Unsupported output format: ' + targetFormat);
  }
  const quality = normaliseQuality(opts.quality);
  const stripMetadata = opts.stripMetadata !== false;
  const sharpenOnDownscale = opts.sharpenOnDownscale !== false;

  // Output path: sibling `<stem>_resized_<W>x<H>.<ext>` unless an explicit
  // outputPath is given (the Pipeline + overlay pass one).
  let outputPath = (typeof opts.outputPath === 'string' && opts.outputPath) ? opts.outputPath : null;
  if (!outputPath) {
    const dir = path.dirname(srcPath);
    const stem = path.basename(srcPath, path.extname(srcPath));
    const ext = targetFormat === 'jpeg' ? 'jpg' : targetFormat;
    outputPath = path.join(dir, `${stem}_resized_${width}x${height}.${ext}`);
  }

  // Read the source dimensions to decide sharpen (downscale only).
  let srcWidth = 0, srcHeight = 0;
  let srcBuf = null;
  try {
    srcBuf = await fsp.readFile(srcPath);
    const meta = await sharp(srcBuf).metadata();
    srcWidth = meta.width || 0;
    srcHeight = meta.height || 0;
  } catch (_) { /* best-effort; if we can't read dims we can't safely sharpen */ }
  // Sharpen ONLY on a genuine downscale (both axes smaller). The prior
  // area-based check ((w*h) < (sw*sh)) spuriously sharpened a mixed resize
  // like 1000x1000 -> 1100x500 (one axis upscaled), sharpening the upscaled
  // axis — which the module header explicitly says we must avoid (it amplifies
  // interpolation artefacts). Requiring both axes to shrink is the safe rule.
  const downscaling = srcWidth > 0 && srcHeight > 0
    && width < srcWidth && height < srcHeight;

  // Build the pipeline. resize() with fit:'fill' forces exact W×H — when the
  // aspect-ratio link is on (the default) the renderer's computed pair already
  // matches the source AR, so fill never distorts; when the link is off, fill
  // honours the (possibly mismatched) target exactly.
  let pipeline;
  try {
    if (!srcBuf) srcBuf = await fsp.readFile(srcPath);
    pipeline = sharp(srcBuf, { failOn: 'error' });
  } catch (e) {
    return emptyResult('Could not read source image: ' + (e && e.message || e));
  }

  pipeline = pipeline.resize({
    width,
    height,
    fit: 'fill',
    kernel: 'lanczos3',
    withoutEnlargement: false, // upscaling is a valid explicit choice
  });

  // Subtle sharpen ONLY on downscale (Photoshop "Bicubic Sharper" equivalent).
  // Sharp's .sharpen() takes (options); a light sigma≈0.6 recovers downsampling
  // softness without ringing. On upscale we skip it — sharpening an enlarged
  // image amplifies interpolation artefacts.
  if (sharpenOnDownscale && downscaling) {
    pipeline = pipeline.sharpen({ sigma: 0.6 });
  }

  if (stripMetadata) {
    pipeline = pipeline.keepIccProfile();
  } else {
    pipeline = pipeline.withMetadata({});
  }

  // Format encoder (mirrors imageOptimizer so a keep→jpeg re-encode matches the
  // Optimze column's output byte-for-byte for the same settings).
  switch (targetFormat) {
    case 'jpeg':
      pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true, progressive: true, chromaSubsampling: '4:2:0' });
      break;
    case 'png': {
      // EFH2-007h fix: wrap in braces to avoid const-in-switch lexical issues.
      const usePalette = !!(opts && opts.palette === true);
      pipeline = pipeline.png(usePalette ? { compressionLevel: 9, palette: true, effort: 10 } : { compressionLevel: 9, palette: false, effort: 10 });
      break;
    }
    case 'webp':
      pipeline = pipeline.webp({ quality, effort: 6, lossless: false });
      break;
    case 'avif':
      pipeline = pipeline.avif({ quality, effort: 9, lossless: false, chromaSubsampling: '4:4:4' });
      break;
  }

  let outBuf;
  try {
    outBuf = await pipeline.toBuffer();
  } catch (e) {
    return emptyResult('Resize failed: ' + (e && e.message || e));
  }

  // Atomic write (tmp + rename) — a partial file must never appear at outputPath.
  // Mirror fb:write / image:writeBase64: clean up the .tmp on rename failure
  // (e.g. EXDEV cross-device, or the target open in another process on Windows),
  // otherwise a leaked .resize-<uuid>.tmp accumulates on every failed rename.
  //
  // R0.1-006.A — Temp name is UUID-based (was `pid + Date.now()`). Two
  // parallel jobs in the same millisecond used to collide on the same
  // temp path, and the OS rename would silently overwrite the other
  // job's intermediate. UUIDs make the .tmp names collision-free.
  //
  // R0.1-006.B — Per-outputPath lock (Map above) serializes parallel
  // calls to the SAME final outputPath. UUIDs alone are not enough:
  // even with distinct temps, two concurrent renames into the same
  // final path can race on Windows (the second rename can fail with
  // EPERM because the first rename is still in flight). The lock
  // guarantees that one resize completes (tmp write + rename + cleanup)
  // BEFORE the next resize starts its rename.
  //
  // R0.1-006.Audit-Fix — writeFile-failure cleanup: if the writeFile
  // itself throws (disk full, EACCES, ENOSPC, etc.) the .tmp must
  // also be unlinked. Otherwise a partial .tmp leaks on every failed
  // write. The cleanup is best-effort; the original error is what
  // the caller sees.
  let outputSize = 0;
  const prevLock = _outputLocks.get(outputPath);
  let releaseLock;
  const myLock = new Promise((resolve) => { releaseLock = resolve; });
  _outputLocks.set(outputPath, myLock);
  let tmp = null;
  try {
    if (prevLock) {
      // Wait for the in-flight resize to finish. If the previous call
      // threw, `await` still resolves (the lock is released in the
      // finally), so we proceed cleanly.
      try { await prevLock; } catch (_) { /* previous failure — proceed with our own write */ }
    }
    tmp = outputPath + '.resize-' + randomUUID() + '.tmp';
    try {
      await fsp.writeFile(tmp, outBuf);
    } catch (writeErr) {
      // The .tmp may exist in a partial state; clean it up best-effort.
      try { await fsp.unlink(tmp); } catch (_) { /* best-effort cleanup */ }
      throw writeErr;
    }
    try {
      await fsp.rename(tmp, outputPath);
    } catch (renameErr) {
      try { await fsp.unlink(tmp); } catch (_) { /* best-effort cleanup */ }
      throw renameErr;
    }
    const st = await fsp.stat(outputPath);
    outputSize = st.size;
  } catch (e) {
    return emptyResult('Could not write output file: ' + (e && e.message || e));
  } finally {
    // Release the lock. We only clear the map entry if it's still ours
    // (defensive: a re-entrant call from a hook could have replaced it).
    if (_outputLocks.get(outputPath) === myLock) {
      _outputLocks.delete(outputPath);
    }
    releaseLock();
  }

  return {
    ok: true,
    outputPath,
    inputSize: inputStat.size,
    outputSize,
    width,
    height,
    srcWidth,
    srcHeight,
    format: targetFormat,
    downscaled: downscaling,
    // KGO6-008: report when dimensions were clamped to the libvips cap
    // so the renderer can warn the user instead of silently producing
    // a different size than requested.
    clamped: (rawW > MAX_DIM || rawH > MAX_DIM),
    requestedWidth: rawW,
    requestedHeight: rawH,
  };
}

module.exports = { resize, SUPPORTED_INPUT, SUPPORTED_OUTPUT };
