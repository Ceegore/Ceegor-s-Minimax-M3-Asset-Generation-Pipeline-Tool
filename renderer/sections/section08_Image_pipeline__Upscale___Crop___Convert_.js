// renderer/sections/section08_Image_pipeline__Upscale___Crop___Convert_.js
// Image pipeline (Upscale / Crop / Convert)

// ----------------- Image pipeline (Upscale / Crop / Convert) -----------------
// All three operations are pure browser/Electron — no external libraries,
// no network calls, fully open source. They all use the HTML5 Canvas
// API to read the source image into a canvas, then export it to the
// target format via canvas.toDataURL. The main process only handles
// persisting the resulting base64 blob to disk via the fb:write IPC.

// Load a local file:// image as a usable Image object (resolves once
// it's fully decoded). Used by upscale / crop / convert.

// Pick a non-clashing output path for the upscale / crop pipeline.
// Tries `basePath`, `basePath (2)`, `basePath (3)`, ... via
// window.api.fbExists. Caps at 1000 attempts (which would only
// realistically happen if a script is bulk-renaming to the same
// stem — the user can still rename / move existing files). On
// exhaustion, falls back to a timestamp suffix so the operation
// never silently overwrites a file.
async function uniqueOutputPath(basePath) {
  const dot = basePath.lastIndexOf('.');
  const stem = dot > 0 ? basePath.slice(0, dot) : basePath;
  const ext = dot > 0 ? basePath.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? basePath : `${stem} (${i})${ext}`;
    // fbExists returns { ok, exists } — pull the boolean out of
    // .exists so the truthy check below actually means "does not
    // exist".
    // BGR-009 fix: mint read grant for fbExists (R1.3 gate).
    const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(candidate) : undefined;
    const exRes = (existsGrant && existsGrant.ok === false) ? { exists: true } : await window.api.fbExists(candidate, existsGrant);
    if (!exRes || !exRes.exists) return candidate;
  }
  return `${stem}_${Date.now()}${ext}`;
}

// Canvas exports GIF first frames as PNG; use the uncapped, atomic image writer.
function canvasOutputSourcePath(p) { return /\.gif$/i.test(p || '') ? p.replace(/\.gif$/i, '.png') : p; }
// BGR-013 fix: writeImageData now mints a write grant before calling the IPC.
async function writeImageData(p, b64) {
  const writeGrant = (window.GrantHelper) ? await window.GrantHelper.ensureWrite(p) : undefined;
  return (window.api.writeImageBase64 || window.api.fbWrite)(p, b64, writeGrant);
}

// Module-level re-render of the "🔍 Upscale 2×" label in the image
// tab. The label is created (and its refreshUpscaleCheckboxUI
// closure is defined) inside the image tab's build(), so by the
// time the user opens the ⚙ Settings → Upscale popup, that
// closure is long gone. This module-level helper re-queries the
// DOM by class and updates the label + .active class on save
// and on every render-pass. (For "one-off" upscale/crop flows
// via the right-click menu, the in-tab function still runs
// because the build() closure is still in scope at that point.)
function refreshUpscaleLabel() {
  const label = document.querySelector('.upscale-checkbox');
  if (!label) return;
  const mult = label.querySelector('.upscale-mult');
  const m = (state.upscaleSettings && state.upscaleSettings.multiplier) || 2;
  if (mult) mult.textContent = state.upscaleEnabled ? ` (${m}×)` : '';
  label.classList.toggle('active', !!state.upscaleEnabled);
}

// Derive the output MIME from a file extension. Used to export the
// canvas in the same format as the input. WebP is detected too (since
// the Canvas API supports exporting to image/webp in modern Chromium).

// Pick a non-clobbering output path next to the source. Inserts a
// `_2x`, `_cropped_WxH`, or `_converted` infix between the stem and
// the extension. If the result already exists, a numeric suffix is
// appended to keep the original safe.

// One resize step. Issue 1 fix: we deliberately avoid
// createImageBitmap's resize options here. On very large sources (a
// Real-ESRGAN 4× intermediate is routinely 8k+ px on a side) Chromium's
// GPU-backed createImageBitmap resize has a known corruption bug that
// leaves the lower half of the result blank/white. A canvas drawImage
// with high-quality smoothing is reliable, and forcing a software-backed
// canvas (willReadFrequently) keeps even very large steps off the GPU
// texture path entirely — which is what otherwise paints the overflow
// region white when the canvas exceeds the GPU's max texture size. We
// read the final result back with toDataURL anyway, so a CPU canvas is
// also the faster choice (no GPU→CPU readback).
async function upscaleStep(src, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(w));
  canvas.height = Math.max(1, Math.floor(h));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Toast-once latch: don't re-spam the user with the "Real-ESRGAN
// missing" message on every upscale. Resetting it requires a restart
// of the app, which is what we want — a single reminder per session
// is enough.
let _reEsrganNotified = false;

// isnetbg availability probe + cache live in section26_IsnetbgProbe.js
// (extracted to keep this file under the lint size cap).

// Run the optional isnetbg binary on a local image and return the
// path to the transparent PNG it wrote. Refuses to do anything when
// the binary / model is missing — the caller is expected to probe
// via `probeIsnetbgStatus()` first and show a precise error.
//
// We never overwrite the source: the output is written to
// `<stem>_nobg.png` next to the input (with a numeric suffix on
// collision). The caller can then delete / rename the source or
// hand the new path to the preview pane.
async function removeBackgroundFile(srcPath, opts = {}) {
  const st = await probeIsnetbgStatus();
  if (!st.checked) throw new Error('Could not contact background-removal backend.');
  if (!st.available) {
    throw new Error('Background removal is not installed. Open Settings → Image & Add-ons and use the in-app installer, then try again.');
  }
  if (!st.modelPresent) throw new Error('Background-removal model file missing. Open Settings → Image & Add-ons to install a model.');

  const selectedKey = window.Section08Helpers.resolveBgModelKey(opts, state);
  if (selectedKey !== 'isnet-general-use') {
    if (!st.models || !st.models[selectedKey] || !st.models[selectedKey].present) {
      throw new Error(`Model "${selectedKey}" is not downloaded. Settings → Image optimisation → Background removal model → Download.`);
    }
  }

  const useGpu = (opts.useGpu !== undefined) ? !!opts.useGpu : (state.removeBackgroundUseGpu !== false);
  // Forward the IS-Net session knobs (intra/inter-op threads,
  // execution mode) when present. The wrapper passes them to the
  // Node.js backend; the external binary backend silently ignores
  // them.
  const adv = (state.pipelineAdvancedSettings && state.pipelineAdvancedSettings.isnetbg) || {};
  const sep = srcPath.includes('\\') ? '\\' : '/';
  const lastSep = srcPath.lastIndexOf(sep);
  const dir = lastSep >= 0 ? srcPath.slice(0, lastSep) : '';
  const lastDot = srcPath.lastIndexOf('.');
  // Same infix pattern as upscale (`_2x` → `_nobg`). PNG is the
  // only sensible output for a transparent image; we keep the
  // input extension only for human-readability (the actual file is
  // always PNG inside, since the isnetbg binary writes a PNG).
  const baseName = lastDot > lastSep ? srcPath.slice(lastSep + 1, lastDot) : srcPath.slice(lastSep + 1);
  const target = await uniqueOutputPath(`${dir}${sep}${baseName}_nobg.png`);
  // R1.5a.follow-up Phase 6: directory-grant (read+write on parent so source + target both covered).
  const isnetGrant = window.api && window.api.mintGrant ? await window.GrantCache.ensurePathGrant(window.api.pathDirname(srcPath), 'read', { kind: 'directory', capabilities: ['read', 'write'] }) : undefined;
  const r = window.Section08Helpers.warnModelFallback(await window.api.isnetbgRun(srcPath, target, {
    useGpu,
    model: selectedKey,
    intraOpNumThreads: adv.intraOpNumThreads,
    interOpNumThreads: adv.interOpNumThreads,
    executionMode: adv.executionMode,
    // PE-015: postprocess opts from the same advanced settings pane.
    postClean: adv.postClean,
    featherPx: adv.featherPx,
    defringe: adv.defringe,
    refine: adv.refine,
  }, isnetGrant)); // KGO7-010: warnModelFallback surfaces a silent model substitution
  if (!r || !r.ok) {
    const msg = (r && r.stderr) || (r && ('isnetbg exited with code ' + r.code)) || 'isnetbg failed';
    // Log the failure to the structured log pane so the user can
    // see what went wrong (and copy the error from the log for
    // support).
    if (typeof window.addLogEvent === 'function') {
      try {
        window.addLogEvent({
          category: 'error',
          result: 'err',
          headline: `Background removal failed: ${msg.split('\n')[0]}`,
          details: [`Source: ${srcPath}`, `Stderr: ${(r && r.stderr) || '(empty)'}`],
        });
      } catch (_) { /* best-effort */ }
    }
    throw new Error(msg);
  }
  const outPath = r.outputPath || target;
  // Log the success. (The post-process chain also logs it with
  // extra context, so a duplicate entry may appear in the
  // post-process path — that's intentional; the chain should log
  // the result regardless of which entry point ran the operation.)
  if (typeof window.addLogEvent === 'function') {
    try {
      window.addLogEvent({
        category: 'bg',
        result: 'ok',
        headline: `Background removed → ${(outPath || '').split(/[\\/]/).pop()}`,
        details: [`Source: ${srcPath}`, `Output: ${outPath}`],
      });
    } catch (_) { /* best-effort */ }
  }
  return outPath;
}

// Upscale an image to multiplier× its original size. If the
// realesrgan-ncnn-vulkan binary is installed (PATH or ./bin/), we
// run it to get a high-quality 4× intermediate, then resize the
// result down to the requested multiplier (or do an extra 2× step
// for 8×). Real-ESRGAN's x4plus model is BSD-3-Clause licensed and
// produces noticeably more detail than the built-in
// multi-step createImageBitmap pipeline. If the binary is missing,
// we fall back to the multi-step pipeline so the tool is never
// blocked.
//
// Returns the output path on disk.
async function upscaleImageFile(srcPath, multiplier, opts = {}) {
  multiplier = Math.max(1, Math.min(8, Math.floor(Number(multiplier) || 2)));

  // Log every pipeline step to the structured log pane so the user
  // can see at a glance what ran. Log the start here and the
  // success/failure at the end of the function (with a groupId so
  // the start + end cluster visually).
  const upGroup = 'up-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  // See makeResilientAddLog in section08Helpers. The full fallback
  // chain (window.addLogEvent → LogService → console.log) lives in
  // the helper so this section stays under the 500-line lint cap.
  const addLog = window.Section08Helpers.makeResilientAddLog();
  addLog({
    category: 'upscale',
    groupId: upGroup,
    headline: `Upscale started: ${multiplier}× → ${(srcPath || '').split(/[\\/]/).pop() || 'image'}`,
    details: [`Source: ${srcPath}`, `Multiplier: ${multiplier}×`],
  });

  // Probe Real-ESRGAN availability. Cheap IPC (just a `which` /
  // bundled-file stat); the result is cached in the main process.
  let reStatus = null;
  try { reStatus = await window.api.realesrganAvailable(); } catch (_) {}

  if (!opts.forceCanvas && reStatus && reStatus.available) {
    try {
      const outPath = await upscaleImageFileRealesrgan(srcPath, multiplier, reStatus);
      addLog({
        category: 'upscale',
        groupId: upGroup,
        result: 'ok',
        headline: `Upscale complete (Real-ESRGAN ${multiplier}×)`,
        details: [`Output: ${outPath}`],
      });
      return outPath;
    } catch (e) {
      // Real-ESRGAN is available but failed (corrupt model, GPU OOM,
      // etc.). Log the error and fall back to the built-in pipeline
      // so the user still gets a result.
      console.error('Real-ESRGAN upscale failed, falling back to built-in:', e);
      toast('Real-ESRGAN upscale failed (' + (e.message || e) + '). Using built-in upscale.', 'warn', 4000);
      addLog({
        category: 'upscale',
        groupId: upGroup,
        headline: `Real-ESRGAN failed, falling back to built-in: ${e.message || e}`,
      });
      // fall through to built-in
    }
  } else if (!_reEsrganNotified) {
    _reEsrganNotified = true;
    toast(
      'Real-ESRGAN not installed — using the built-in upscale. ' +
      'Drop the binary into ./bin/ (or add it to PATH) for noticeably higher-quality output. ' +
      'See README for the download link.',
      'info', 6000,
    );
  }

  // Built-in multi-step path.
  const srcImg = await loadImageFromFile(srcPath);
  const targetW = Math.max(1, Math.floor(srcImg.naturalWidth * multiplier));
  const targetH = Math.max(1, Math.floor(srcImg.naturalHeight * multiplier));
  let curW = srcImg.naturalWidth;
  let curH = srcImg.naturalHeight;
  let cur = srcImg;
  while (curW < targetW || curH < targetH) {
    const stepW = Math.min(targetW, curW * 2);
    const stepH = Math.min(targetH, curH * 2);
    cur = await upscaleStep(cur, stepW, stepH);
    curW = stepW;
    curH = stepH;
  }
  const mime = mimeFromPath(srcPath);
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  // Issue 1: software-backed canvas (see upscaleStep) so a very large
  // output never hits the GPU max-texture-size corruption (white lower half).
  const octx = out.getContext('2d', { willReadFrequently: true });
  if (mime === 'image/jpeg') {
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, targetW, targetH);
  }
  octx.drawImage(cur, 0, 0);
  const dataUrl = out.toDataURL(mime, 0.95);
  const b64 = dataUrl.split(',')[1];
  // uniqueOutputPath appends " (2)", " (3)", ... to a clashing
  // name so re-running the same upscale twice doesn't silently
  // overwrite the previous output.
  const outPath = await uniqueOutputPath(derivedOutputPath(canvasOutputSourcePath(srcPath), `_${multiplier}x`));
  const r = await writeImageData(outPath, b64);
  if (!r.ok) {
    addLog({
      category: 'upscale',
      groupId: upGroup,
      result: 'err',
      headline: `Upscale failed: ${r.error || 'fbWrite failed'}`,
    });
    throw new Error(r.error || 'fbWrite failed');
  }
  // Log the success of the built-in upscale path so the structured
  // log pane shows every pipeline step the user ran. (The
  // Real-ESRGAN path logs its own success above.)
  addLog({
    category: 'upscale',
    groupId: upGroup,
    result: 'ok',
    headline: `Upscale complete (built-in ${multiplier}×, ${targetW}×${targetH})`,
    details: [`Output: ${r.path}`],
  });
  return r.path;
}

// Whitelist of Real-ESRGAN model names we know about. The model
// becomes the `-n` flag value of the spawn, so this is also a
// defence against a corrupted state.json / compromised renderer
// injecting an arbitrary flag into the binary's argv. Update
// when a new model is added to ./bin/models/.
const REAL_ESRGAN_MODELS = new Set((window.PipelineModel && window.PipelineModel.REALESRGAN_MODELS) || [
  'realesrgan-x4plus', 'realesrgan-x4plus-anime', 'realesr-animevideov3',
]);

// Real-ESRGAN path. The ncnn-vulkan binary always outputs at the
// model's native scale (4× for x4plus). For multipliers other than
// the native scale, we resize the intermediate using the same createImageBitmap
// pipeline to get a clean result, preventing tiling artifacts.
// Supported scales:
//   - 2×: 4× → 2×  (downscale)
//   - 3×: 4× → 3×  (downscale)
//   - 4×: native
//   - 8×: 4× → 8×  (extra 2× step)
async function upscaleImageFileRealesrgan(srcPath, multiplier, reStatus) {
  // Pick a model: prefer the user's saved choice, but only if it's on
  // the whitelist. Anything else (default, typo, exploit attempt)
  // falls back to the general-purpose 4× BSD-3 model.
  const wanted = (state.realesrganModel || '').trim();
  const model = REAL_ESRGAN_MODELS.has(wanted) ? wanted : 'realesrgan-x4plus';

  const modelNativeScale = (model === 'realesr-animevideov3')
    ? Math.max(2, Math.min(4, Math.floor(multiplier)))
    : 4;

  // The Real-ESRGAN binary needs a writable output path. Write its
  // intermediate to a UUID-suffixed temp next to the source
  // (in output_dir, so it's already in the allowed roots) and
  // clean it up in `finally`.
  // SYS-007: UUID-based temp name prevents collision when parallel
  // upscale jobs process the same source file concurrently.
  const sep = srcPath.includes('\\') ? '\\' : '/';
  const dot = srcPath.lastIndexOf('.');
  const stem = dot > 0 ? srcPath.slice(0, dot) : srcPath;
  const _uid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : String(Date.now()) + Math.random().toString(36).slice(2, 8);
  const tempOut = stem + '.realesrgan_' + _uid + '.png';

  let r;
  // QA-018 fix: wrap the Real-ESRGAN spawn in try/finally so a failed
  // run still deletes the partial output file (previously cleanup only
  // ran after success in the second try/finally below).
  let reSuccess = false;
  try {
    // Forward the user-tuned Real-ESRGAN CLI knobs. tileSize 0 /
    // ttaMode false / gpuId 'auto' are no-ops — the wrapper only
    // emits the corresponding CLI flag when the value differs from
    // the binary's default, so unchanged defaults produce the same
    // argv as before.
    const adv = (state.pipelineAdvancedSettings && state.pipelineAdvancedSettings.realesrgan) || {};
    // R1.5a.follow-up Phase 6: directory-grant (read+write on parent so source + tempOut both covered).
    const resrGrant = window.api && window.api.mintGrant ? await window.GrantCache.ensurePathGrant(window.api.pathDirname(srcPath), 'read', { kind: 'directory', capabilities: ['read', 'write'] }) : undefined;
    r = await window.api.realesrganRun(srcPath, tempOut, {
      model,
      scale: modelNativeScale,
      tileSize: adv.tileSize,
      ttaMode: adv.ttaMode,
      gpuId: adv.gpuId,
    }, resrGrant);
    if (!r || !r.ok) {
      const msg = (r && r.stderr) || 'Real-ESRGAN returned a non-zero exit';
      throw new Error(msg);
    }
    reSuccess = true;
  } catch (e) {
    throw new Error('Real-ESRGAN run threw: ' + (e.message || e));
  } finally {
    // QA-018: delete partial output on failure.
    if (!reSuccess) {
      const _dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tempOut) : undefined;
      // B-007 (hhhhu3 audit): delete via native confirmation (window.FbIntent).
      if (window.FbIntent) window.FbIntent.del(tempOut, _dg).catch(() => {});
    }
  }

  try {
    // Read natural dimensions of source image to compute requested target dimensions
    let naturalW = 0, naturalH = 0;
    if (window.api && typeof window.api.imageMetadata === 'function') {
      // EFH2-003 fix: mint a read grant (the IPC requires one).
      const metaGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(srcPath) : undefined;
      const meta = await window.api.imageMetadata(srcPath, metaGrant);
      if (meta && meta.ok) { naturalW = meta.width; naturalH = meta.height; }
      else if (typeof window.logAction === 'function') { window.logAction('image-metadata', 'fallback', { error: (meta && meta.error) || 'unknown' }); }
    }
    if (!naturalW || !naturalH) {
      const img = await loadImageFromFile(srcPath);
      naturalW = img.naturalWidth;
      naturalH = img.naturalHeight;
    }

    const targetW = Math.max(1, Math.floor(naturalW * multiplier));
    const targetH = Math.max(1, Math.floor(naturalH * multiplier));
    const mime = mimeFromPath(srcPath);
    const targetFormat = mime === 'image/jpeg' ? 'jpeg' : (mime === 'image/webp' ? 'webp' : 'png');

    const outPath = await uniqueOutputPath(derivedOutputPath(canvasOutputSourcePath(srcPath), `_${multiplier}x`));

    // Offload downscaling and format conversion to Sharp in main process (bypasses Chromium canvas limits)
    const resizeGrant = (window.GrantHelper) ? await window.GrantHelper.ensureTransform(tempOut, outPath) : undefined;
    if (resizeGrant && resizeGrant.ok === false) throw new Error('Grant failure: ' + (resizeGrant.error || 'authorization denied'));
    const resizeRes = await window.api.resizeImage(tempOut, {
      width: targetW, height: targetH, format: targetFormat, quality: 95, palette: false, outputPath: outPath, sharpenOnDownscale: true,
    }, resizeGrant); if (window.reportIpcWarnings) window.reportIpcWarnings(resizeRes); // KGO7-020

    if (!resizeRes || !resizeRes.ok) {
      throw new Error((resizeRes && resizeRes.error) || 'Sharp downscale/convert failed');
    }

    return resizeRes.outputPath || outPath;
  } finally {
    // Best-effort cleanup of intermediate temp file
    const delGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tempOut) : undefined;
    // B-007 (hhhhu3 audit): delete via native confirmation (window.FbIntent).
    if (window.FbIntent) window.FbIntent.del(tempOut, delGrant).catch(() => {});
  }
}

// Crop an image to the given pixel rectangle (in image coordinates).
// Output file uses the same extension as the source.
async function cropImageFile(srcPath, x, y, w, h) {
  x = Math.max(0, Math.floor(Number(x) || 0));
  y = Math.max(0, Math.floor(Number(y) || 0));
  w = Math.max(1, Math.floor(Number(w) || 1));
  h = Math.max(1, Math.floor(Number(h) || 1));
  const img = await loadImageFromFile(srcPath);
  // Clamp to image bounds
  if (x + w > img.naturalWidth) w = img.naturalWidth - x;
  if (y + h > img.naturalHeight) h = img.naturalHeight - y;
  if (w <= 0 || h <= 0) throw new Error('Crop region is outside the image.');
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  const mime = mimeFromPath(srcPath);
  const dataUrl = canvas.toDataURL(mime);
  const b64 = dataUrl.split(',')[1];
  // Same collision-avoidance as upscale: re-cropping the same file
  // to the same W × H now produces " (2)" / " (3)" instead of
  // silently overwriting the previous output.
  const out = await uniqueOutputPath(derivedOutputPath(canvasOutputSourcePath(srcPath), `_cropped_${w}x${h}`));
  const r = await writeImageData(out, b64);
  // Log the crop action to the structured log pane so the user
  // can see every pipeline step at a glance. (Same pattern as
  // upscale / background-removal / optimize.)
  if (typeof window.addLogEvent === 'function') {
    try {
      window.addLogEvent({
        category: r.ok ? 'upscale' : 'error',
        result: r.ok ? 'ok' : 'err',
        headline: r.ok
          ? `Cropped to ${w}×${h} → ${(out || '').split(/[\\/]/).pop()}`
          : `Crop failed: ${r.error || 'fbWrite failed'}`,
        details: r.ok
          ? [`Source: ${srcPath}`, `Region: ${x},${y} ${w}×${h}`, `Output: ${out}`]
          : [`Source: ${srcPath}`, `Region: ${x},${y} ${w}×${h}`],
      });
    } catch (_) { /* best-effort */ }
  }
  if (!r.ok) throw new Error(r.error || 'fbWrite failed');
  return r.path;
}

// Convert an image to a different format (png / jpeg / webp). Returns
// the output path. The new file has the target extension.
async function convertImageFile(srcPath, targetFormat, quality = 0.95) {
  const targetMime = `image/${targetFormat}`;
  const img = await loadImageFromFile(srcPath);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  // JPEG: no alpha; flatten onto white background.
  if (targetMime === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0);
  const dataUrl = canvas.toDataURL(targetMime, quality);
  const b64 = dataUrl.split(',')[1];
  const ext = extFromMime(targetMime);
  // Build the output path: same stem, new extension.
  const sep = srcPath.includes('\\') ? '\\' : '/';
  const lastSep = srcPath.lastIndexOf(sep);
  const dir = lastSep >= 0 ? srcPath.slice(0, lastSep) : '';
  const lastDot = srcPath.lastIndexOf('.');
  const stem = lastDot > lastSep ? srcPath.slice(0, lastDot) : srcPath;
  // BUG #6 fix: route through uniqueOutputPath like the upscale
  // (:293) and crop (:448) steps do — the fixed '_converted' name
  // silently overwrote the previous output when the same source was
  // converted twice.
  const out = await uniqueOutputPath(`${dir}${sep}${stem.split(sep).pop()}_converted.${ext}`);
  const r = await writeImageData(out, b64);
  // Log the convert action to the structured log pane. Every
  // pipeline step should be visible at a glance.
  if (typeof window.addLogEvent === 'function') {
    try {
      window.addLogEvent({
        category: r.ok ? 'upscale' : 'error',
        result: r.ok ? 'ok' : 'err',
        headline: r.ok
          ? `Converted to ${targetFormat} → ${(out || '').split(/[\\/]/).pop()}`
          : `Convert failed: ${r.error || 'fbWrite failed'}`,
        details: r.ok
          ? [`Source: ${srcPath}`, `Format: ${targetFormat}`, `Output: ${out}`]
          : [`Source: ${srcPath}`, `Format: ${targetFormat}`],
      });
    } catch (_) { /* best-effort */ }
  }
  if (!r.ok) throw new Error(r.error || 'fbWrite failed');
  return r.path;
}
