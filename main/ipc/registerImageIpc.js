// main/ipc/registerImageIpc.js
// IPC handler: `image:optimize` and related image IPCs.
// Wraps src/imageOptimizer.js (Sharp + libvips). Validates paths against
// PathGrantService.
//
// R1.5a (S1 §6 R1.5a): every mutating handler (image:optimize,
// image:resize, image:fixExtension, image:writeBase64) requires a
// `grantId` minted by Main (e.g. via file:pick / file:saveAs). The
// grant is authorised through PathGrantService before the handler
// touches the filesystem. image:refExists stays ungated (read-only
// existence probe, already protected by the sensitive-dir denylist).
//
// Phasenpruefung-of-Phasenpruefung (F-PP-R1.5a.1-A, LOW): the
// `pathSecurity` import was removed in R1.5a.1 because the mutating
// handlers no longer use the legacy isPathUnderAny / isParentUnderAny
// gate (replaced by the grant authorisation). image:refExists does
// its own sensitive-dir denylist inline. Keeping the dead import
// would mislead a future maintainer into thinking the gate is still
// active.
//
// R3.2.5: `image:optimize` result passes through the
// ImageOperationResult legacy adapter (validates the 9 contract
// fields; the legacy envelope already has `outputPath` so no
// path-Mapping is needed). Backend is 'sharp'. The inner
// `try { ... } catch (e) { ... }` is removed; `wrapInpaintHandler`
// now provides equivalent throw-catching. The 3-arg signature
// `(event, srcPath, opts, grantId)` is preserved via `...args` in
// the wrapper (same pattern as isnetbg:run, R3.2.3). The other
// handlers in this file (image:resize, image:fixExtension,
// image:writeBase64, image:refExists) are out of R3.2.5 scope —
// they have their own envelope shapes and get their own R3.2.x
// cards in follow-up phases.

const { ipcMain } = require('electron');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const pathUtils = require('../../src/pathUtils');
const imageOptimizer = require('../../src/imageOptimizer');
const imageResizer = require('../../src/imageResize');
const { authorizePath: _authorizePath } = require('./grantAuthorizer');
const { wrapInpaintHandler } = require('./legacyAdapter');
// P1-A (360° Audit H-001): secure IPC wrapper.
const { secureHandle } = require('./secureHandle');

/**
 * @param {{ appRoot: string }} deps
 */
function register(deps) {
  const getMainWindow = (deps && typeof deps.getMainWindow === 'function') ? deps.getMainWindow : () => null;
  // R3.2.5: result passes through `adaptInpaintResult` (validates
  // the 9 contract fields; the legacy envelope already has
  // `outputPath` and `error` so no path-Mapping or stderr-fallback
  // is needed). Backend is 'sharp'.
  secureHandle('image:optimize', { getMainWindow }, wrapInpaintHandler(async (_e, srcPath, opts, grantId) => {
    const empty = {
      ok: false, error: '', outputPath: null,
      inputSize: 0, outputSize: 0, savedBytes: 0, savedPercent: 0,
      format: '', width: 0, height: 0,
    };
    if (!srcPath || typeof srcPath !== 'string') {
      return { ...empty, error: 'Source path is required.' };
    }
    // R1.5a: read on source — the grant must authorise reading the
    // image at srcPath. The previous isPathUnderAny gate is replaced
    // by the grant authorisation; the grant is Main-minted, so a
    // compromised renderer cannot steer a read at a file outside the
    // user's picked folder.
    const readAuthz = _authorizePath(grantId, 'read', srcPath);
    if (!readAuthz.ok) return { ...empty, error: readAuthz.error };
    // R1.5a: write on output (when provided) — separate grant check
    // so a renderer that can read one file can't write to an
    // arbitrary destination.
    if (opts && opts.outputPath && typeof opts.outputPath === 'string') {
      const writeAuthz = _authorizePath(grantId, 'write', opts.outputPath);
      if (!writeAuthz.ok) return { ...empty, error: writeAuthz.error };
    } else {
      // No explicit outputPath: the optimiser may write in place
      // (the parent of srcPath is the write target). Authorise a
      // write on the source path itself.
      const writeAuthz = _authorizePath(grantId, 'write', srcPath);
      if (!writeAuthz.ok) return { ...empty, error: writeAuthz.error };
    }
    // R8: cap the source read — optimize() buffers the whole file into the
    // main process TWICE (detectRealFormat sniff + the sharp read), so a
    // multi-GB "image" would OOM it. 256 MB matches the other image caps.
    // (imageOptimizer.js is at its size budget, so the gate lives here.)
    try {
      const st = await fsp.stat(srcPath);
      if (st.isFile() && st.size > 256 * 1024 * 1024) {
        return { ...empty, error: 'Source image too large to optimize (' + Math.round(st.size / 1048576) + ' MB, cap 256 MB).' };
      }
    } catch (_) { /* fall through — optimize() reports access errors */ }
    return await imageOptimizer.optimize(srcPath, opts || {});
  }, 'sharp'));

  // Resize an image to a freely-chosen target resolution. Best-practice
  // Lanczos3 resampling (Sharp/libvips, MIT), subtle sharpen on downscale
  // only. Same path-security gate as image:optimize. The renderer computes
  // the final (width, height) pair — when the aspect-ratio link is on the
  // pair already preserves the source AR, so fit:'fill' never distorts; when
  // off, fill honours the exact (possibly mismatched) target.
  secureHandle('image:resize', { getMainWindow }, async (_e, srcPath, opts, grantId) => {
    const empty = {
      ok: false, error: '', outputPath: null,
      inputSize: 0, outputSize: 0,
      width: 0, height: 0, srcWidth: 0, srcHeight: 0,
      format: '', downscaled: false,
    };
    if (!srcPath || typeof srcPath !== 'string') {
      return { ...empty, error: 'Source path is required.' };
    }
    // R1.5a: read on source — grant must authorise the read.
    const readAuthz = _authorizePath(grantId, 'read', srcPath);
    if (!readAuthz.ok) return { ...empty, error: readAuthz.error };
    // R1.5a: write on output (when provided) or in-place write on source.
    if (opts && opts.outputPath && typeof opts.outputPath === 'string') {
      const writeAuthz = _authorizePath(grantId, 'write', opts.outputPath);
      if (!writeAuthz.ok) return { ...empty, error: writeAuthz.error };
    } else {
      const writeAuthz = _authorizePath(grantId, 'write', srcPath);
      if (!writeAuthz.ok) return { ...empty, error: writeAuthz.error };
    }
    try {
      const r = await imageResizer.resize(srcPath, opts || {});
      // KGO7-020: attach the clamp notice HERE, behind the IPC boundary,
      // so it reaches every caller. `clamped` alone was only read by
      // section08Helpers.resizeImageFile — the other five call sites
      // (pipelineOps ×2, section08 pipeline, batchPostprocess ×2) invoke
      // window.api.resizeImage directly and silently produced a different
      // size than requested.
      if (r && r.ok && r.clamped) {
        const note = `Dimensions clamped to ${r.width}×${r.height} (requested ${r.requestedWidth}×${r.requestedHeight}). Maximum is 65500 per axis.`;
        r.warnings = Array.isArray(r.warnings) ? r.warnings.concat([note]) : [note];
      }
      return r;
    } catch (e) {
      return { ...empty, error: String((e && e.message) || e) };
    }
  });

  secureHandle('image:metadata', { getMainWindow }, async (_e, srcPath, grantId) => {
    const empty = { ok: false, width: 0, height: 0, format: '' };
    if (!srcPath || typeof srcPath !== 'string') return { ...empty, error: 'Source path is required.' };
    const readAuthz = _authorizePath(grantId, 'read', srcPath);
    if (!readAuthz.ok) return { ...empty, error: readAuthz.error };
    try {
      const fs = require('fs');
      const sharp = require('sharp');
      require('../../src/cpuGuard').applySharpThreadCap(sharp);
      // R9: cap the source before the full-file read — a multi-GB file would
      // otherwise be buffered whole into memory (OOM/DoS). Mirrors the cap in
      // image:optimize / imageResize.
      const st = await fs.promises.stat(srcPath);
      if (st.isFile() && st.size > 256 * 1024 * 1024) {
        return { ...empty, error: 'Source image too large to read metadata (' + Math.round(st.size / 1048576) + ' MB, cap 256 MB).' };
      }
      const buf = await fs.promises.readFile(srcPath);
      const meta = await sharp(buf).metadata();
      return { ok: true, width: meta.width || 0, height: meta.height || 0, format: meta.format || '' };
    } catch (e) {
      return { ...empty, error: String((e && e.message) || e) };
    }
  });

  // mmx hardcodes the image tab's output extension to .png, but the CDN bytes
  // it downloads are sometimes JPEG. Called right after a successful
  // generation so the on-disk name always matches the real content.
  secureHandle('image:fixExtension', { getMainWindow }, async (_e, filePath, grantId) => {
    const empty = { ok: false, path: filePath, renamed: false, error: '' };
    if (!filePath || typeof filePath !== 'string') {
      return { ...empty, error: 'Path is required.' };
    }
    // R1.5a: rename is a write-class mutation — the grant must
    // authorise writing the file (i.e., the same path).
    const writeAuthz = _authorizePath(grantId, 'write', filePath);
    if (!writeAuthz.ok) return { ...empty, error: writeAuthz.error };
    try {
      // R9: fixExtensionToMatchContent sniffs the real format via a full-file
      // read (detectRealFormat) — cap the source first so a huge file cannot
      // be buffered whole into memory (OOM/DoS). A stat failure (e.g. a
      // missing file) falls through: fixExtensionToMatchContent reports it
      // gracefully (mirrors the image:optimize cap pattern).
      try {
        const st = await require('fs').promises.stat(filePath);
        if (st.isFile() && st.size > 256 * 1024 * 1024) {
          return { ...empty, error: 'Source image too large to inspect (' + Math.round(st.size / 1048576) + ' MB, cap 256 MB).' };
        }
      } catch (_) { /* fall through — fixExtensionToMatchContent reports access errors */ }
      return await imageOptimizer.fixExtensionToMatchContent(filePath);
    } catch (e) {
      return { ...empty, error: String((e && e.message) || e) };
    }
  });

  // Pre-flight a --subject-ref reference image: a missing path used to make
  // the image tab spawn mmx (which failed with a cryptic "File system error:
  // ENOENT ... reference.jpeg") and then retry 4x. The renderer pre-flights
  // the reference path through this handler so it can show a clear
  // "Reference image not found" message and never spawn a doomed run.
  //
  // This handler is intentionally NOT an unrestricted filesystem existence
  // oracle — a compromised renderer must not be able to probe arbitrary
  // files (C:\Windows\System32\..., ~/.ssh/id_rsa, etc.). It is restricted to
  // paths that look like a real local image file:
  //   1. Must be an absolute path (no relative paths — the user provides the
  //      full path when picking a reference image).
  //   2. Must have an image-like extension (the renderer only ever asks
  //      about image references for --subject-ref).
  //   3. The normalised path must NOT be under a system-only directory
  //      (Windows, Program Files, /etc, ~/.ssh, etc.) — a reference image is
  //      a USER file.
  // http(s) URLs are still accepted as "exists" (the API server validates
  // them, not the filesystem).
  // image:writeBase64 — uncapped atomic base64 write for the in-app pixel
  // editor. The general fb:write channel caps writes at 25 MB
  // (MAX_WRITE_BYTES), but a large 4x-upscaled PNG exported from the editor
  // can exceed that. This handler mirrors fb:write's path validation + atomic
  // tmp-rename but skips the size cap. Absurd payloads are still rejected
  // beyond a generous IMAGE_MAX_BASE64_CHARS (~256 MB decoded) — enough for
  // any realistic raster, small enough that a compromised renderer can't
  // trivially OOM the main process.
  const IMAGE_MAX_BASE64_CHARS = Math.ceil(256 * 1024 * 1024 * 4 / 3);
  secureHandle('image:writeBase64', { getMainWindow, maxPayloadBytes: 64 * 1024 * 1024 }, async (_e, outPath, base64Data, grantId) => {
    try {
      if (!outPath || typeof outPath !== 'string') {
        return { ok: false, error: 'Output path is required.' };
      }
      if (!base64Data || typeof base64Data !== 'string') {
        return { ok: false, error: 'Base64 data is required.' };
      }
      const outAbs = pathUtils.normalize(outPath);
      if (!outAbs) return { ok: false, error: 'Output path is invalid.' };
      // R1.5a: write grant required (the previous isParentUnderAny
      // gate is replaced by the grant authorisation; the grant is
      // Main-minted, so a compromised renderer cannot steer a write
      // to an arbitrary destination).
      const writeAuthz = _authorizePath(grantId, 'write', outAbs);
      if (!writeAuthz.ok) return { ok: false, error: writeAuthz.error };
      if (base64Data.length > IMAGE_MAX_BASE64_CHARS) {
        return { ok: false, error: 'Image payload too large (max ~256 MB).' };
      }
      const buf = Buffer.from(base64Data, 'base64');
      // Atomic write: tmp + rename (same convention as fb:write / state.js).
      const tmp = outAbs + '.tmp-' + randomUUID();
      await fsp.writeFile(tmp, buf);
      try {
        await fsp.rename(tmp, outAbs);
      } catch (renameErr) {
        try { await fsp.unlink(tmp); } catch {}
        throw renameErr;
      }
      return { ok: true, path: outAbs };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  secureHandle('image:refExists', { getMainWindow }, async (_e, p) => {    if (!p || typeof p !== 'string') return { ok: true, exists: false };
    const trimmed = p.trim();
    // http(s) references are validated by the API server, not the
    // filesystem — report them as "exists" so the renderer doesn't block
    // a valid URL.
    if (/^https?:\/\//i.test(trimmed)) return { ok: true, exists: true, url: true };
    // The path must look like an absolute local path with an image
    // extension. This filter is intentionally lenient on extension
    // (so a JPEG saved with a .jpg / .jpeg / .JPG all work) and
    // strict on shape (must be absolute, must have an image ext).
    const imgExtRe = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/i;
    if (!path.isAbsolute(trimmed) || !imgExtRe.test(trimmed)) {
      return { ok: true, exists: false, reason: 'not an absolute image path' };
    }
    const abs = pathUtils.normalize(trimmed);
    if (!abs) return { ok: true, exists: false };
    // Explicitly block well-known sensitive directories. The check is by
    // segment, not by full-string match, so a nested path like
    //   "C:\Users\me\Documents\Windows\photo.jpg"
    // is still allowed (the "Windows" segment there is just a folder name,
    // not the system directory). Only paths whose FIRST non-drive component
    // is one of the sensitive names are blocked.
    //
    // The denylist matches by PREFIX (no `$` anchor). A `$`-anchored regex
    // would only match the directory ITSELF (e.g. `C:\Users\bob\.ssh`), never
    // a FILE inside it (`C:\Users\bob\.ssh\id_rsa`), and would therefore be a
    // no-op for the actual threat (probing credential files). This is
    // defense-in-depth — the real gate is on writes, not this read.
    const sensitiveRootRe = /^(?:[A-Za-z]:[\\\/])?(Windows|Program Files(?: \(x86\))?|ProgramData|System32|SysWOW64|etc|private|var[\\\/]lib|root|home[\\\/][^\\/]+[\\\/]\.(?:ssh|aws|gnupg)[\\\/]?|Users[\\\\/][^\\/]+[\\\/]\.(?:ssh|aws|gnupg)[\\\/]?|Users[\\\\/][^\\/]+[\\\/]AppData)/i;
    // Strip the leading drive letter (if any) and the first separator
    // so sensitiveRootRe can match against the path's first
    // "directory" component.
    const pathBody = abs.replace(/^[A-Za-z]:[\\\/]/, '');
    if (sensitiveRootRe.test(pathBody) || sensitiveRootRe.test(abs)) {
      return { ok: true, exists: false, reason: 'sensitive directory' };
    }
    try { await fsp.access(abs, fs.constants.F_OK); return { ok: true, exists: true }; }
    catch { return { ok: true, exists: false }; }
  });
}

module.exports = { register };
