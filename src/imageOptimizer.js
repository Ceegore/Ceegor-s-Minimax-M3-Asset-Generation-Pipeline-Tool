// src/imageOptimizer.js
// Image optimization / file-size reduction service.
//
// Wraps the `sharp` library (already a runtime dependency — see
// package.json) to compress JPEG, PNG, and (optionally) WebP /
// AVIF images while preserving best-possible visual quality.
//
// Format- and quality-helpers live in `src/imageOptimizer/formatUtils.js`;
// this module re-exports the helper constants so `require('./imageOptimizer')`
// keeps the same API surface.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const {
  sharp,                  // may be null if install missing
  DEFAULT_QUALITY,
  SUPPORTED_INPUT,
  SUPPORTED_OUTPUT,
  EXT_FOR_FORMAT,
  normaliseFormat,
  normaliseQuality,
  inferFormatFromPath,
  detectRealFormat,
  ensureSharp,
  emptyResult,
} = require('./imageOptimizer/formatUtils');
const { shouldKeepOriginal, keepOriginalResult } = require('./imageOptimizer/keepOriginal');

// SYS-007: per-destination lock. Parallel optimize() calls writing to the
// SAME outputPath are serialized so the OS rename cannot race (EPERM on
// Windows when two renames target the same file concurrently).
const _outputLocks = new Map(); // outputPath -> Promise<void>

// Clamp `value` to the integer range [min, max], returning `fallback` ONLY
// when the value is non-finite. `Math.round(x) || fallback` must NOT be used
// here: `Math.round(0)` is 0 (falsy), so a user-selected effort/compression of
// 0 ("fastest") would silently become the slowest default. `Number.isFinite`
// correctly accepts 0 and only rejects NaN / Infinity / non-numeric input, so
// the value the user picked (and state.js already persists) is honoured.
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Optimise / compress an image on disk.
 *
 * @param {string} srcPath Absolute path to the source image.
 * @param {object} [opts]  See the module header for the full shape.
 * @returns {Promise<object>} Result envelope (see module header).
 */
async function optimize(srcPath, opts) {
  opts = opts || {};

  // --- Defensive checks --------------------------------------------------
  if (!srcPath || typeof srcPath !== 'string') {
    return emptyResult('Source path is required.');
  }

  const sharpErr = ensureSharp();
  if (sharpErr) return emptyResult(sharpErr);

  let inputStat;
  try {
    inputStat = await fsp.stat(srcPath);
  } catch (e) {
    return emptyResult('Source file is not readable: ' + (e && e.message || e));
  }
  if (!inputStat.isFile()) {
    return { ...emptyResult(), inputSize: inputStat.size,
             error: 'Source path is not a regular file.' };
  }

  // --- Format / quality normalisation ------------------------------------
  // Sniff the real format from file content first — mmx writes the CDN's
  // actual bytes verbatim regardless of the --out extension (e.g. a JPEG
  // written to "foo.png"), so trusting the extension here would silently
  // re-encode photographic JPEGs as PNG (large size bloat) whenever
  // opts.format asked to "keep" the source format. Fall back to the
  // extension only if content detection is unavailable/inconclusive.
  const sniffedFormat = await detectRealFormat(srcPath);
  const inputFormat = SUPPORTED_INPUT.has(sniffedFormat) ? sniffedFormat : inferFormatFromPath(srcPath);
  if (!inputFormat) {
    // sharp reports AVIF as 'heif' (HEIF container with AV1 codec) and
    // SUPPORTED_INPUT includes 'heif', so a real AVIF file no longer
    // lands here. The error message reflects the full supported set.
    return { ...emptyResult('Unsupported input format. Supported: JPEG, PNG, WebP, AVIF.'),
             inputSize: inputStat.size };
  }
  let targetFormat = normaliseFormat(opts.format);
  if (targetFormat === null) {
    targetFormat = inputFormat === 'webp' ? 'webp' : inputFormat;
  }
  if (!SUPPORTED_OUTPUT.has(targetFormat)) {
    return { ...emptyResult('Unsupported output format: ' + targetFormat),
             inputSize: inputStat.size };
  }
  const quality = normaliseQuality(opts.quality);
  const stripMetadata = opts.stripMetadata !== false;

  // --- Output path -------------------------------------------------------
  let outputPath = (typeof opts.outputPath === 'string' && opts.outputPath) ? opts.outputPath : null;
  if (!outputPath) {
    const dir = path.dirname(srcPath);
    const stem = path.basename(srcPath, path.extname(srcPath));
    const ext = targetFormat === 'jpeg' ? 'jpg' : targetFormat;
    outputPath = path.join(dir, `${stem}_optimized.${ext}`);
  }

  // --- Sharp pipeline ----------------------------------------------------
  let pipeline;
  try {
    const srcBuf = await fsp.readFile(srcPath);
    pipeline = sharp(srcBuf, { failOn: 'error' });
  } catch (e) {
    return { ...emptyResult('Could not read source image: ' + (e && e.message || e)),
             inputSize: inputStat.size, format: targetFormat };
  }

  if (stripMetadata) {
    // The user-facing label is "Strip non-essential EXIF (keeps ICC colour
    // profile)". keepIccProfile() honours that: sharp strips everything by
    // default, and we keep ONLY the ICC profile (letting sharp strip
    // EXIF/XMP/IPTC plus the orientation tag). Do NOT call withMetadata here —
    // withMetadata is the OPPOSITE of stripping in sharp and would preserve
    // everything.
    pipeline = pipeline.keepIccProfile();
  } else {
    // User explicitly asked to keep all metadata. withMetadata({})
    // preserves EXIF/XMP/IPTC and attaches a web-friendly sRGB ICC
    // profile when appropriate.
    pipeline = pipeline.withMetadata({});
  }

  // Format-specific encoders. The advanced settings overlay
  // (renderer/sections/section25_*.js) can pass per-format knobs:
  //   jpeg: chromaSubsampling ('4:2:0' | '4:4:4'), mozjpeg (bool)
  //   png:  compressionLevel (1..9), palette (bool)
  //   webp: mode ('lossy' | 'lossless' | 'nearLossless'), effort (0..6)
  //   avif: effort (0..9), chromaSubsampling ('4:4:4' | '4:2:0')
  // When the caller doesn't pass any of these, the defaults below
  // match the previous hard-coded behaviour so existing flows
  // (post-generation chain, right-click Optimise overlay) keep
  // producing identical bytes.
  const enc = opts.encoders || {};
  switch (targetFormat) {
    case 'jpeg':
      pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({
        quality,
        mozjpeg: enc.jpegMozjpeg !== false,
        progressive: true,
        chromaSubsampling: enc.jpegChromaSubsampling === '4:4:4' ? '4:4:4' : '4:2:0',
      });
      break;
    case 'png': {
      // sharp silently ignores `quality` for PNG (PNG is lossless).
      // EFH2-004: palette OFF by default (full-colour PNG).
      const pngOpts = {
        compressionLevel: clampInt(enc.pngCompressionLevel, 0, 9, 9),
        palette: enc.pngPalette === true,
        effort: 10,
      };
      pipeline = pipeline.png(pngOpts);
      break;
    }
    case 'webp': {
      // webpMode: 'lossy' (default, smallest) | 'lossless' (for
      // screenshots / line art) | 'nearLossless' (middle ground).
      const mode = enc.webpMode || 'lossy';
      if (mode === 'lossless') {
        pipeline = pipeline.webp({ quality, effort: clampInt(enc.webpEffort, 0, 6, 6), lossless: true });
      } else if (mode === 'nearLossless') {
        pipeline = pipeline.webp({ quality, effort: clampInt(enc.webpEffort, 0, 6, 6), nearLossless: true });
      } else {
        pipeline = pipeline.webp({ quality, effort: clampInt(enc.webpEffort, 0, 6, 6), lossless: false });
      }
      break;
    }
    case 'avif':
      pipeline = pipeline.avif({
        quality,
        effort: clampInt(enc.avifEffort, 0, 9, 9),
        lossless: false,
        chromaSubsampling: enc.avifChromaSubsampling === '4:2:0' ? '4:2:0' : '4:4:4',
      });
      break;
  }

  // --- Run the pipeline --------------------------------------------------
  let outBuf;
  try {
    outBuf = await pipeline.toBuffer();
  } catch (e) {
    return { ...emptyResult('Compression failed: ' + (e && e.message || e)),
             inputSize: inputStat.size, format: targetFormat };
  }

  // KGO8-005: a same-format re-encode that came out BIGGER is discarded, keeping the source (imageOptimizer/keepOriginal.js).
  if (shouldKeepOriginal(targetFormat, inputFormat, outBuf.length, inputStat.size)) {
    return keepOriginalResult({ sharp, srcPath, outputPath, inputSize: inputStat.size, outBytes: outBuf.length, targetFormat });
  }
  // --- Write the output --------------------------------------------------
  // Atomic write: tmp + rename. R0.1-006.Audit-Fix: both writeFile and
  // rename failures unlink the .tmp best-effort (otherwise disk-full
  // / EACCES leaves partial .opt-*.tmp accumulating).
  // SYS-007: per-destination mutex serializes parallel renames into the
  // same final path (prevents EPERM on Windows).
  let outputSize = 0;
  const prevLock = _outputLocks.get(outputPath);
  let releaseLock;
  const myLock = new Promise((resolve) => { releaseLock = resolve; });
  _outputLocks.set(outputPath, myLock);
  let tmp;
  try {
    if (prevLock) {
      try { await prevLock; } catch (_) { /* previous failure — proceed */ }
    }
    // Use a cryptographically-unique temp name so parallel optimize() calls
    // writing to the SAME output path can't collide.
    tmp = outputPath + '.opt-' + crypto.randomUUID() + '.tmp';
    try { await fsp.writeFile(tmp, outBuf); }
    catch (writeErr) { try { await fsp.unlink(tmp); } catch (_) {} throw writeErr; }
    try { await fsp.rename(tmp, outputPath); }
    catch (renameErr) { try { await fsp.unlink(tmp); } catch (_) {} throw renameErr; }
    const st = await fsp.stat(outputPath);
    outputSize = st.size;
  } catch (e) {
    return { ...emptyResult('Could not write output file: ' + (e && e.message || e)),
             inputSize: inputStat.size, format: targetFormat };
  } finally {
    if (_outputLocks.get(outputPath) === myLock) _outputLocks.delete(outputPath);
    releaseLock();
  }

  // --- Metadata for the UI ----------------------------------------------
  // Read from the in-memory outBuf (the exact bytes just written) rather
  // than re-opening outputPath from disk: sharp/libvips can hold a file
  // handle open briefly after a path-based read (observed with the webp
  // decoder), which then races a caller that immediately tries to
  // rename/delete the file on Windows.
  let width = 0, height = 0;
  try { const meta = await sharp(outBuf).metadata(); width = meta.width || 0; height = meta.height || 0; }
  catch (_) { /* best-effort */ }

  const savedBytes = Math.max(0, inputStat.size - outputSize);
  const savedPercent = inputStat.size > 0 ? Math.round((savedBytes / inputStat.size) * 100) : 0;

  return {
    ok: true,
    outputPath,
    inputSize: inputStat.size,
    outputSize,
    savedBytes,
    savedPercent,
    format: targetFormat,
    width,
    height,
  };
}

/**
 * mmx downloads the CDN's actual image bytes and writes them verbatim to
 * --out, but the renderer hardcodes the file's extension (always .png for the
 * image tab) because the mmx image API has no output-format parameter. The CDN
 * sometimes returns JPEG bytes, producing a "name.png" file that is actually a
 * JPEG. Sniff the real format from content and rename the file to match when
 * they disagree, so the on-disk name always reflects the real bytes
 * (force-prefix's "exact name" promise, and imageOptimizer's own format
 * inference, both depend on this).
 *
 * @param {string} filePath Absolute path to a just-written image file.
 * @returns {Promise<{ ok: boolean, path: string, renamed: boolean, error?: string }>}
 */
async function fixExtensionToMatchContent(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, path: filePath, renamed: false, error: 'Path is required.' };
  }
  const sharpErr = ensureSharp();
  if (sharpErr) return { ok: false, path: filePath, renamed: false, error: sharpErr };

  const realFormat = await detectRealFormat(filePath);
  const realExt = realFormat && EXT_FOR_FORMAT[realFormat];
  if (!realExt) {
    // Undetectable / not a format we know how to name — leave the
    // file alone rather than guess.
    return { ok: true, path: filePath, renamed: false };
  }
  const currentExtRaw = (path.extname(filePath) || '').replace(/^\./, '').toLowerCase();
  const currentFormat = currentExtRaw === 'jpg' ? 'jpeg' : currentExtRaw;
  if (currentFormat === realFormat) {
    return { ok: true, path: filePath, renamed: false };
  }

  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  let newPath = path.join(dir, `${stem}.${realExt}`);
  try {
    let n = 1;
    while (await fsp.access(newPath).then(() => true, () => false)) {
      newPath = path.join(dir, `${stem}_${n}.${realExt}`);
      n += 1;
    }
    await fsp.rename(filePath, newPath);
    return { ok: true, path: newPath, renamed: true, fromExt: currentExtRaw, toExt: realExt };
  } catch (e) {
    return { ok: false, path: filePath, renamed: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  optimize,
  fixExtensionToMatchContent,
  DEFAULT_QUALITY,
  SUPPORTED_INPUT: Array.from(SUPPORTED_INPUT),
  SUPPORTED_OUTPUT: Array.from(SUPPORTED_OUTPUT),
};
