// main/ipc/registerInpaintIpc.js
// IPC handlers for the editor's Heal feature (Feature 5).
//
//   inpaint:runTelea  — pure-JS Telea-style inpaint (small fixes), uses sharp
//                       to decode/encode and src/inpaint.js for the synthesis.
//                       Runs in the main process (renderer CSP stays 'self'-only).
//
// R1.5a.5 (S1 §6 R1.5a): `inpaint:runTelea` requires a `grantId`
// (Main-minted). The grant is authorised through PathGrantService
// before the handler touches the filesystem. The handler reads from
// srcPath and writes to outPath (either user-supplied via args.outPath
// or a derived sibling via deriveOutPath).

const { ipcMain } = require('electron');
const sharp = require('sharp');
require('../../src/cpuGuard').applySharpThreadCap(sharp);
const { SHARP_PIXEL_LIMIT } = require('../services/ArtifactFinalizer');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { inpaint, maskFromAlpha, maskFromAlphaHoles } = require('../../src/inpaint');
const { authorizePath: _authorizePath } = require('./grantAuthorizer');
const { wrapInpaintHandler } = require('./legacyAdapter');
// P1-A (360° Audit H-001): secure IPC wrapper.
const { secureHandle } = require('./secureHandle');

// PE-022: pixel ceiling — images above this are rejected (the AI tier
// handles large regions; Telea at >16 Mpx is >30 s even off-main-thread).
const MAX_PIXELS = 4096 * 4096; // 16 Mpx

function bad(msg) { return { ok: false, error: msg }; }

/**
 * @param {{ appRoot: string }} deps
 */
function register(deps) {
  const getMainWindow = (deps && typeof deps.getMainWindow === 'function') ? deps.getMainWindow : () => null;
  // inpaint:runTelea
  // args: { srcPath, outPath?, maskB64?, mode?, radius?, grantId?,
  //         alphaThreshold?, maxHolePx?, growPx? }
  //   maskB64: base64 of a PNG (same dims as source) where non-zero alpha OR
  //            luma => pixel to fill. Omit + mode:'transparency' to derive the
  //            mask from the source's own alpha channel (Heal Transparency).
  //   mode:    'selection' (use maskB64) | 'transparency' (enclosed-hole mask)
  //   radius:  neighbourhood radius (default 4)
  //   grantId: Main-minted grant covering srcPath + outPath.
  //   PE-009 (transparency mode only):
  //   alphaThreshold: 0-255, alpha <= this counts as transparent (default 0)
  //   maxHolePx:      enclosed holes larger than this stay open (0 = fill all)
  //   growPx:         dilate the hole mask by N px to heal the rim too
  // R3.2.2.AuditFix: result passes through the ImageOperationResult
  // legacy adapter (validates the 9 contract fields, maps `path` →
  // `outputPath`, preserves `path` as legacy alias). The inner
  // `try { ... } catch (e) { ... }` is removed; `wrapInpaintHandler`
  // provides equivalent throw-catching. Backend is 'telea' (not
  // 'inpaint' — the operation is Telea-style, not ONNX model-based).
  // HIGH-025: wire the 32 MB payload limit so a compromised renderer
  // cannot send an unbounded base64 mask/image to the inpaint handler.
  secureHandle('inpaint:runTelea', { getMainWindow, maxPayloadBytes: 32 * 1024 * 1024 }, wrapInpaintHandler(async (_e, args) => {
    if (!args || typeof args !== 'object') return bad('Arguments required.');
    const srcPath = args.srcPath;
    if (!srcPath || typeof srcPath !== 'string') return bad('Source path required.');
    // P5 (DA-M-008): Telea ALWAYS encodes PNG (alpha-preserving), so the
    // output extension must be .png regardless of the source container —
    // a .jpg source previously produced PNG bytes mislabelled .jpg, which
    // downstream tools (and this app's own magic-byte checks) reject.
    const outPath = forcePngExt(args.outPath || deriveOutPath(srcPath, '_healed'));
    // R1.5a.5: read on srcPath + write on outPath (replaces the
    // legacy isPathUnderAny + isParentUnderAny gates).
    const readAuthz = _authorizePath(args.grantId, 'read', srcPath);
    if (!readAuthz.ok) return bad(readAuthz.error);
    const writeAuthz = _authorizePath(args.grantId, 'write', outPath);
    if (!writeAuthz.ok) return bad(writeAuthz.error);
    const radius = clampRadius(args.radius);
    const mode = args.mode === 'transparency' ? 'transparency' : 'selection';

    // Decode source → raw RGBA + dims.
    const fs = require('fs');
    // R10: cap the source read — a multi-GB "image" would OOM the main process
    // (same class as inpaint:runOnnx / pipeline:thumb). The pixel ceiling below
    // only fires AFTER the whole-file read, too late to prevent the OOM.
    const MAX_TELEA_SOURCE = 256 * 1024 * 1024; // 256 MB
    const srcStat = await fs.promises.stat(srcPath);
    if (srcStat.size > MAX_TELEA_SOURCE) {
      return bad('Source image too large for Telea heal (' + Math.round(srcStat.size / 1048576) + ' MB, cap 256 MB).');
    }
    const srcBuf = await fs.promises.readFile(srcPath);
    const meta = await sharp(srcBuf, { limitInputPixels: SHARP_PIXEL_LIMIT }).metadata();
    const w = meta.width, h = meta.height;
    // PE-022: pixel ceiling guard.
    if (w * h > MAX_PIXELS) {
      return bad('Image too large for Telea heal (' + w + '×' + h + ' = ' + (w * h) + ' px; max ' + MAX_PIXELS + '). Use the AI Resynthesize tier for large images.');
    }
    const raw = await sharp(srcBuf, { limitInputPixels: SHARP_PIXEL_LIMIT }).ensureAlpha().raw().toBuffer();
    const rgba = new Uint8ClampedArray(raw); // raw is RGBA uint8

    // Build the mask.
    let mask;
    let holeStats = null;
    if (mode === 'transparency') {
      // PE-009: only fill ENCLOSED holes — transparency connected to
      // the image border is intentional background and must never be
      // synthesised (the legacy maskFromAlpha flagged every alpha-0
      // pixel, destroying cut-out subjects). Falls back to the legacy
      // full-alpha mask when the holes variant is unavailable (older
      // test stubs replace the module via require.cache).
      if (typeof maskFromAlphaHoles === 'function') {
        holeStats = maskFromAlphaHoles(rgba, w, h, {
          alphaThreshold: args.alphaThreshold,
          maxHolePx: args.maxHolePx,
          growPx: args.growPx,
        });
        mask = holeStats.mask;
      } else {
        mask = maskFromAlpha(rgba, w, h);
      }
    } else {
      if (!args.maskB64 || typeof args.maskB64 !== 'string') {
        return bad('A mask (base64 PNG) is required for selection mode.');
      }
      // KGO8-009: the mask MUST match the source. maskFromPngB64 resizes
      // whatever it is given to w×h, so a mask at a different resolution was
      // accepted silently and healed the wrong pixels — measured with a 64×48
      // mask on a 128×96 image: ok:true, no warning, and the region that
      // should have been filled came back as a blend. The editor always
      // generates the mask at natural size, so a mismatch is a caller bug and
      // deserves an error rather than a plausible-looking wrong image.
      let maskMeta;
      try { maskMeta = await sharp(Buffer.from(args.maskB64, 'base64')).metadata(); }
      catch (e) { return bad('Mask is not a readable PNG: ' + ((e && e.message) || e)); }
      if (maskMeta.width !== w || maskMeta.height !== h) {
        return bad(`Mask is ${maskMeta.width}×${maskMeta.height} but the image is ${w}×${h} — they must match.`);
      }
      mask = await maskFromPngB64(args.maskB64, w, h);
    }

    // PE-022: run the synthesizer in a Worker Thread so the main
    // process event loop stays responsive (7.4 s at 1024² pre-fix).
    await runTeleaInWorker(rgba, mask, w, h, radius);

    // P5 (DA-M-007): encode to a uuid temp in the SAME folder (same volume
    // ⇒ the rename is atomic), validate the bytes decode with the expected
    // dims, then rename onto outPath. A crash/OOM/kill mid-encode can never
    // leave a truncated file at the destination, and a corrupt encode is
    // caught before it replaces anything.
    const tmpOut = path.join(path.dirname(outPath), `.telea-${crypto.randomUUID()}.tmp.png`);
    try {
      await sharp(Buffer.from(rgba), { raw: { width: w, height: h, channels: 4 } })
        .png()
        .toFile(tmpOut);
      const check = await sharp(tmpOut).metadata();
      if (!check || check.width !== w || check.height !== h) {
        throw new Error('encoded output failed validation (' + (check ? check.width + '×' + check.height : 'unreadable') + ', expected ' + w + '×' + h + ')');
      }
      await fs.promises.rename(tmpOut, outPath);
    } catch (e) {
      try { await fs.promises.unlink(tmpOut); } catch (_) { /* best-effort temp cleanup */ }
      return bad('Heal failed: ' + ((e && e.message) || e));
    }

    // PE-009: hole stats pass through the legacy adapter (it preserves
    // extra fields) so the renderer can detect a no-op heal
    // (holesFilled === 0) and warn on a near-full mask (maskShare).
    return Object.assign({ ok: true, path: outPath, width: w, height: h },
      holeStats ? {
        holesFilled: holeStats.holes,
        largestHolePx: holeStats.largestHole,
        maskShare: holeStats.maskShare,
      } : {});
  }, 'telea'));
}

// P5 (DA-M-008): force the .png extension — the encoder is always PNG.
function forcePngExt(p) {
  const dot = p.lastIndexOf('.');
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const ext = dot > slash ? p.slice(dot).toLowerCase() : '';
  return ext === '.png' ? p : (dot > slash ? p.slice(0, dot) : p) + '.png';
}

// Derive a sibling output path: C:/x/y.png → C:/x/y_healed.png
function deriveOutPath(srcPath, suffix) {
  const dot = srcPath.lastIndexOf('.');
  const ext = dot >= 0 ? srcPath.slice(dot) : '.png';
  const base = dot >= 0 ? srcPath.slice(0, dot) : srcPath;
  return base + suffix + ext;
}

function clampRadius(r) {
  const n = parseInt(r, 10);
  if (!isFinite(n) || n <= 0) return 4;
  return Math.min(32, Math.max(1, n));
}

// Decode a base64 PNG mask → Uint8Array (1 = fill). Resizes to w×h if needed
// so a renderer-drawn selection box of any size maps onto the source dims.
async function maskFromPngB64(b64, w, h) {
  const buf = Buffer.from(b64, 'base64');
  // Flatten to grayscale, force exact w×h, single channel.
  const { data } = await sharp(buf)
    .resize(w, h, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = data[i] > 8 ? 1 : 0; // luma threshold
  return mask;
}

// PE-022: run inpaint() in a Worker Thread. The rgba/mask buffers are
// COPIED to the worker (not transferred) so the originals stay valid.
// The worker transfers the result back (zero-copy from its side).
// Falls back to synchronous execution if the worker cannot be created
// (e.g. in test stubs that replace the module via require.cache).
function runTeleaInWorker(rgba, mask, w, h, radius) {
  const workerPath = path.join(__dirname, 'inpaintTeleaWorker.js');
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(workerPath, {
        workerData: {
          rgba: Buffer.from(rgba.buffer),
          mask: Buffer.from(mask.buffer),
          w, h, radius,
        },
      });
    } catch (_) {
      // Fallback: run synchronously (test stubs / environments
      // without worker_threads support).
      inpaint(rgba, mask, w, h, { radius });
      resolve();
      return;
    }
    worker.on('message', (msg) => {
      // Copy the result back into the original rgba buffer.
      rgba.set(new Uint8ClampedArray(msg.rgba));
      resolve();
    });
    worker.on('error', (err) => reject(err));
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error('inpaint worker exited with code ' + code));
    });
  });
}

module.exports = { register };
