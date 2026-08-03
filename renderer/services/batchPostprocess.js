// renderer/services/batchPostprocess.js
// H9-005 / H9-018: standalone deterministic postprocess runner for batch rows.
// The Pipeline board's ops (doCrop/doRemoveBg/...) are coupled to the board's
// item model; this runner calls the low-level IPCs directly on a file path so
// the batch flow can apply per-row postprocess (crop / resize / optimize /
// remove-background / audio trim) to the just-generated output without going
// through the interactive Pipeline board.
//
// All ops are best-effort: a failure logs + toasts but does NOT abort the batch
// (a postprocess failure on one variant shouldn't sink the whole row).
(function () {
  'use strict';

  function parseDims(s) {
    // R9: tolerate surrounding whitespace, spaces around the separator and an
    // optional "px" suffix ("800 x 600", "800x600px") — users paste dims in
    // many shapes; the old strict regex silently rejected them (resize skipped).
    const m = String(s || '').match(/^\s*(\d+)\s*[x×]\s*(\d+)\s*(?:px)?\s*$/i);
    if (!m) return null;
    return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
  }

  function isTruthyFlag(v) {
    return v === true || v === 'true' || v === 'on' || v === '1';
  }

  // Run the postprocess flags in `opts` against the generated `files` array.
  // Returns { applied: string[], errors: string[], outputs: string[] }.
  //
  // R6.3 (Per-input Resultliste): outputs is ALWAYS a 1:1 mirror of the valid
  // entries in `files` — one output per input file. This guarantees the
  // caller (batchDirectRunner, imageTab) can blindly replace its outFiles
  // with `outputs` without losing any file:
  //   - All ops succeed  → outputs[i] = final processed path (cur)
  //   - Any op fails     → outputs[i] = raw input path (f) — the caller's
  //     deliverable is preserved ("Partial failure behält raw finalPath")
  //   - No ops match     → outputs[i] = raw input path (f) — the file passes
  //     through unchanged ("Ein Input bleibt genau ein Result")
  //
  // X3-06: the image ops now CHAIN — each op consumes the previous op's output
  // (in the same order as the interactive Pipeline board:
  //   upscale → remove-background → crop → resize → optimize)
  // — instead of each independently reading the raw file and fanning out into
  // several partial siblings. A row that asks for resize + optimize now yields
  // ONE resized-and-converted file, not a resized PNG plus a full-size WebP.
  // X3-01: upscale (Real-ESRGAN) is applied here too; the batch direct runner
  // used to drop --upscale entirely.
  //
  // For image files: upscale / remove-background / crop / resize / optimize.
  // For audio files: trim-start / trim-end.
  async function runRowPostprocess(files, opts) {
    const applied = [];
    const errors = [];
    const outputs = [];
    if (!Array.isArray(files) || !files.length || !opts) return { applied, errors, outputs };
    for (const f of files) {
      if (!f || typeof f !== 'string') continue;
      const lower = f.toLowerCase();
      const isAudio = /\.(mp3|wav|flac|opus|pcm|aac|m4a)$/.test(lower);
      const isImage = /\.(png|jpe?g|webp|avif|bmp|tiff?)$/.test(lower);
      // `cur` is the working file, reassigned after every successful op so the
      // next op consumes the previous result (the chaining fix).
      let cur = f;
      // R6.3: track whether ANY op failed for this file. If so, the output
      // falls back to the raw input path ("Partial failure behält raw finalPath").
      const errCountBefore = errors.length;
      try {
        // ---- audio trim (H9-018) ----
        if (isAudio && opts.trimStart != null && opts.trimEnd != null) {
          const start = parseFloat(opts.trimStart), end = parseFloat(opts.trimEnd);
          if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
            const dst = cur.replace(/(\.[^.]+)$/, '_trim$1');
            // BGR-014 fix: mint directory grant for audioCut (R1.3 gate).
            const audioGrant = (window.GrantHelper) ? await window.GrantHelper.ensureWrite(cur) : undefined;
            const r = await window.api.audioCut(cur, dst, { startSec: start, endSec: end, fade: true, fadeMs: 10 }, audioGrant);
            if (r && r.ok) { applied.push('trim ' + dst); cur = dst; }
            else errors.push('trim failed: ' + ((r && r.error) || 'unknown'));
          } else {
            // R5 (L2): an invalid trim range used to be silently ignored — the
            // row completed with untrimmed audio and no hint why. Surface it
            // (the output stays `cur`, per BGR-024; only the error is added).
            errors.push('trim skipped: invalid range (start=' + opts.trimStart + ', end=' + opts.trimEnd + '); need finite numbers with end > start');
          }
        } else if (isAudio && (opts.trimStart != null || opts.trimEnd != null)) {
          // R8: a one-sided trim (only start OR only end) used to fall through
          // the two-sided guard above and be silently skipped — surface it so
          // the user knows the row was NOT trimmed.
          errors.push('trim skipped: both trim-start and trim-end are required (got start=' + opts.trimStart + ', end=' + opts.trimEnd + ')');
        }
        // ---- image upscale (X3-01) ----
        // Real-ESRGAN at the requested native multiplier. realesr-animevideov3
        // ships native x2/x3/x4 param files, so `-s <mult>` produces exactly
        // <mult>× with no canvas downscale step (verified) — the simplest
        // correct path for a batch post-step. Skipped when the binary isn't
        // installed (falls through untouched rather than failing the row).
        if (isImage && isTruthyFlag(opts.upscale)) {
          const mult = Math.max(2, Math.min(4, parseInt(opts.upscaleMultiplier, 10) || 2));
          try {
            const avail = window.api.realesrganAvailable ? await window.api.realesrganAvailable() : null;
            if (avail && avail.available && window.api.realesrganRun) {
              const dst = cur.replace(/(\.[^.]+)$/, `_up${mult}x.png`);
              // R1.5a.follow-up Phase 6: directory-grant on the PARENT of cur.
              // PRE-1: use window.GrantCache + window.api.pathDirname (no require in sandbox).
              const resrGrant = (window.api && window.api.mintGrant)
                ? await window.GrantCache.ensurePathGrant(
                    window.api.pathDirname(cur), 'read',
                    { kind: 'directory', capabilities: ['read', 'write'] }
                  ) : undefined;
              if (resrGrant && resrGrant.ok === false) errors.push('upscale grant: ' + (resrGrant.error || 'mintGrant failed'));
              // H-058: canonical Real-ESRGAN model names only. The executor
              // (src/realesrgan.js) silently falls back to x4plus for unknown
              // names, so an unnormalized legacy spelling would run the WRONG
              // network without any hint. Accept documented legacy aliases,
              // reject everything else loudly (throw → 'upscale failed: …').
              const RESR_MODELS = ['realesrgan-x4plus', 'realesrgan-x4plus-anime', 'realesr-animevideov3'];
              const RESR_ALIASES = { 'real-esrgan-x4plus': 'realesrgan-x4plus', 'real-esrgan-anime-v3': 'realesr-animevideov3' };
              const rawModel = String(opts.upscaleModel || (window.state && window.state.realesrganModel) || 'realesrgan-x4plus').trim();
              const upModel = RESR_ALIASES[rawModel] || rawModel;
              if (!RESR_MODELS.includes(upModel)) {
                throw new Error('unknown upscale-model "' + rawModel + '" — use one of: ' + RESR_MODELS.join(', '));
              }
              const modelNativeScale = (upModel === 'realesr-animevideov3')
                ? Math.max(2, Math.min(4, mult))
                : 4;

              if (mult === modelNativeScale) {
                const r = await window.api.realesrganRun(cur, dst, { model: upModel, scale: modelNativeScale }, resrGrant);
                if (r && r.ok) { applied.push(`upscale ${mult}x ` + (r.outputPath || dst)); cur = r.outputPath || dst; }
                else {
                  errors.push('upscale failed: ' + ((r && (r.stderr || r.error)) || 'unknown'));
                  // QA-018 fix: delete partial output on failure.
                  const _dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(dst) : undefined;
                  // B-007 (hhhhu3 audit): delete via native confirmation (window.FbIntent).
                  if (window.FbIntent) window.FbIntent.del(dst, _dg).catch(() => {});
                }
              } else {
                const tempOut = dst + '.tmp.png';
                const tempGrant = (window.GrantHelper) ? await window.GrantHelper.ensureTransform(cur, tempOut) : resrGrant;
                const r = await window.api.realesrganRun(cur, tempOut, { model: upModel, scale: modelNativeScale }, tempGrant);
                if (r && r.ok) {
                  try {
                    let naturalW = 0, naturalH = 0;
                    if (window.api && typeof window.api.imageMetadata === 'function') {
                      const readGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(cur) : undefined;
                      const meta = await window.api.imageMetadata(cur, readGrant);
                      if (meta && meta.ok) { naturalW = meta.width; naturalH = meta.height; }
                    }
                    if ((!naturalW || !naturalH) && typeof loadImageFromFile === 'function') {
                      const img = await loadImageFromFile(cur);
                      naturalW = img.naturalWidth;
                      naturalH = img.naturalHeight;
                    }
                    // EFH2-003 fix: hard failure instead of silent 1024 default.
                    if (!naturalW || !naturalH) throw new Error('Could not determine source dimensions for upscale target.');
                    const targetW = Math.max(1, Math.floor(naturalW * mult));
                    const targetH = Math.max(1, Math.floor(naturalH * mult));

                    if (window.api && typeof window.api.resizeImage === 'function') {
                      const resizeGrant = (window.GrantHelper) ? await window.GrantHelper.ensureTransform(tempOut, dst) : undefined;
                      if (resizeGrant && resizeGrant.ok === false) {
                        errors.push('upscale resize grant failed: ' + (resizeGrant.error || 'authorization denied'));
                      } else {
                        const resizeRes = await window.api.resizeImage(tempOut, {
                          width: targetW,
                          height: targetH,
                          format: 'png',
                          quality: 100,
                          palette: false,
                          outputPath: dst,
                          sharpenOnDownscale: true,
                        }, resizeGrant);
                        if (window.reportIpcWarnings) window.reportIpcWarnings(resizeRes); // KGO7-020

                        if (resizeRes && resizeRes.ok) {
                          applied.push(`upscale ${mult}x ` + (resizeRes.outputPath || dst));
                          cur = resizeRes.outputPath || dst;
                        } else {
                          errors.push('upscale resize failed: ' + ((resizeRes && resizeRes.error) || 'unknown'));
                        }
                      }
                    } else {
                      applied.push(`upscale ${mult}x ` + (r.outputPath || tempOut || dst));
                      cur = r.outputPath || tempOut || dst;
                    }
                  } finally {
                    const delGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tempOut) : undefined;
                    // B-007 (hhhhu3 audit): delete via native confirmation (window.FbIntent).
                    if (window.FbIntent) {
                      window.FbIntent.del(tempOut, delGrant).catch(() => {});
                    }
                  }
                } else {
                  errors.push('upscale failed: ' + ((r && (r.stderr || r.error)) || 'unknown'));
                  // QA-018 fix: delete partial tempOut on failure.
                  const _dg2 = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tempOut) : undefined;
                  // B-007 (hhhhu3 audit): delete via native confirmation (window.FbIntent).
                  if (window.FbIntent) window.FbIntent.del(tempOut, _dg2).catch(() => {});
                }
              }
            } else {
              errors.push('upscale skipped: Real-ESRGAN not installed');
            }
          } catch (e) { errors.push('upscale failed: ' + ((e && e.message) || e)); }
        }
        // ---- image remove-background (H9-005) ----
        if (isImage && isTruthyFlag(opts.removeBackground)) {
          // gewv2 GEW-010 fix: default to the higher-quality bundled model.
          const model = opts.removeBackgroundModel || 'birefnet-general-lite';
          const dst = cur.replace(/(\.[^.]+)$/, '_nobg.png');
          // R1.5a.follow-up Phase 6: directory-grant on the PARENT of cur.
          // PRE-1: use window.GrantCache + window.api.pathDirname (no require in sandbox).
          const isnetGrant = (window.api && window.api.mintGrant)
            ? await window.GrantCache.ensurePathGrant(
                window.api.pathDirname(cur), 'read',
                { kind: 'directory', capabilities: ['read', 'write'] }
              ) : undefined;
          if (isnetGrant && isnetGrant.ok === false) errors.push('remove-bg grant: ' + (isnetGrant.error || 'mintGrant failed'));
          // gewv2 GEW-011 fix: honor a per-row / state GPU choice instead of
          // hardcoding false. The backend applies its cleanup post-chain
          // (postClean/feather/defringe) ON by default regardless of this
          // flag, so this restores only the GPU acceleration knob.
          const rbGpu = (opts.removeBackgroundUseGpu != null)
            ? (opts.removeBackgroundUseGpu !== false && opts.removeBackgroundUseGpu !== 'false')
            : !!(window.state && window.state.removeBackgroundUseGpu !== false);
          const r = await window.api.isnetbgRun(cur, dst, { model, useGpu: rbGpu }, isnetGrant);
          if (r && r.ok) { applied.push('remove-bg ' + dst); cur = dst; }
          else errors.push('remove-bg failed: ' + ((r && r.error) || r && r.stderr || 'unknown'));
        }
        // ---- image crop (H9-005) ----
        if (isImage && opts.crop) {
          const dims = parseDims(opts.crop);
          if (dims && typeof window.cropImageFile === 'function') {
            // BGR-022 fix: center-anchor the crop instead of top-left (0,0).
            // Load the image to get its dimensions, then compute x/y so the
            // crop region is centered. Clamp to image bounds.
            let cropX = 0, cropY = 0, cropW = dims.w, cropH = dims.h;
            try {
              if (typeof window.loadImageFromFile === 'function') {
                const img = await window.loadImageFromFile(cur);
                if (img && img.naturalWidth && img.naturalHeight) {
                  cropW = Math.min(dims.w, img.naturalWidth);
                  cropH = Math.min(dims.h, img.naturalHeight);
                  cropX = Math.max(0, Math.floor((img.naturalWidth - cropW) / 2));
                  cropY = Math.max(0, Math.floor((img.naturalHeight - cropH) / 2));
                }
              }
            } catch (_) { /* fall back to 0,0 if image load fails */ }
            const r = await window.cropImageFile(cur, cropX, cropY, cropW, cropH);
            if (r) { const out = (typeof r === 'string') ? r : cur.replace(/(\.[^.]+)$/, '_crop.png'); applied.push('crop ' + out); cur = out; }
            else errors.push('crop failed');
          }
        }
        // ---- image resize (H9-005) ----
        if (isImage && opts.resize) {
          const dims = parseDims(opts.resize);
          if (dims && window.api && window.api.resizeImage) {
            // The image:resize IPC's destination key is `outputPath` (NOT `dst`,
            // which it silently ignores → it would write to its own default
            // sibling and the path recorded here wouldn't exist). Read the real
            // path back from r.outputPath. Resize keeps the source format, so the
            // dst must keep the source extension (a hardcoded .png would mislabel
            // a JPEG). Mirrors pipelineOps.doResize.
            const srcExt = (cur.split('.').pop() || 'png').toLowerCase();
            const dst = cur.replace(/(\.[^.]+)$/, '_resize.' + srcExt);
            // R1.5a.follow-up Phase 6: directory-grant on the PARENT of cur
            // with both 'read' AND 'write' capabilities (was Phase 3's
            // file-grant with 'read' — which the handler's write-check
            // rejected with 'operation "write" not permitted').
            // PRE-1: use window.GrantCache + window.api.pathDirname (no require in sandbox).
            const resizeGrant = (window.api && window.api.mintGrant)
              ? await window.GrantCache.ensurePathGrant(
                  window.api.pathDirname(cur), 'read',
                  { kind: 'directory', capabilities: ['read', 'write'] }
                ) : undefined;
            if (resizeGrant && resizeGrant.ok === false) errors.push('resize grant: ' + (resizeGrant.error || 'mintGrant failed'));
            const r = await window.api.resizeImage(cur, { width: dims.w, height: dims.h, outputPath: dst }, resizeGrant);
            if (window.reportIpcWarnings) window.reportIpcWarnings(r); // KGO7-020
            if (r && r.ok) { const out = r.outputPath || dst; applied.push('resize ' + out); cur = out; }
            else errors.push('resize failed: ' + ((r && r.error) || 'unknown'));
          }
        }
        // ---- image optimize/convert (H9-005) ----
        // 'keep' mirrors the interactive Pipeline board's doOptimize: the
        // optimizer STILL runs (quality re-encode + metadata strip) but the
        // source format is preserved (format: null → in-place rewrite of
        // `cur`). Previously 'keep' skipped the whole step, so a row asking
        // for optimize-format:keep + optimize-quality got nothing.
        if (isImage && opts.optimizeFormat) {
          const keepFmt = String(opts.optimizeFormat).toLowerCase() === 'keep';
          const fmt = keepFmt ? null : String(opts.optimizeFormat).toLowerCase();
          const q = parseInt(opts.optimizeQuality, 10) || 82;
          // X3-09: honour an explicit strip-metadata:false; default is strip.
          const strip = !(opts.stripMetadata === false || opts.stripMetadata === 'false');
          if (window.api && window.api.optimizeImage) {
            // 'keep' optimizes in place (same path, source format); a real
            // conversion swaps the extension. The parent-directory grant
            // below authorises both the in-place rewrite and a sibling write.
            const dst = keepFmt ? cur : cur.replace(/(\.[^.]+)$/, '.' + fmt);
            // `outputPath` is the image:optimize IPC's destination key (NOT `dst`);
            // read the real path back from r.outputPath. Mirrors pipelineOps.doOptimize.
            // R1.5a.follow-up Phase 6: directory-grant on the PARENT of cur.
            // PRE-1: use window.GrantCache + window.api.pathDirname (no require in sandbox).
            const optGrant = (window.api && window.api.mintGrant)
              ? await window.GrantCache.ensurePathGrant(
                  window.api.pathDirname(cur), 'read',
                  { kind: 'directory', capabilities: ['read', 'write'] }
                ) : undefined;
            if (optGrant && optGrant.ok === false) errors.push('optimize grant: ' + (optGrant.error || 'mintGrant failed'));
            const r = await window.api.optimizeImage(cur, { format: fmt, quality: q, stripMetadata: strip, outputPath: dst }, optGrant);
            if (window.reportIpcWarnings) window.reportIpcWarnings(r); // KGO8-011: the resize step reported warnings, this one silently dropped them
            if (r && r.ok) { const out = r.outputPath || dst; applied.push('optimize ' + out); cur = out; }
            else errors.push('optimize failed: ' + ((r && r.error) || 'unknown'));
          }
        }
        // R9: optimize-quality / strip-metadata only take effect inside the
        // optimize step above, which is gated on optimize-format. Without it
        // they are silently inert — surface that so the user knows to add
        // optimize-format (e.g. `keep` to re-encode in place).
        else if (isImage && (opts.optimizeQuality != null || opts.stripMetadata != null)) {
          errors.push('optimize-quality/strip-metadata have no effect without optimize-format (add optimize-format:keep to apply them in place).');
        }
      } catch (e) {
        errors.push(String((e && e.message) || e));
      }
      // R6.3 (Per-input Resultliste): ALWAYS produce exactly one output per
      // input file so the caller's outFiles array stays 1:1 with its inputs.
      // BGR-024 fix: push the LAST SUCCESSFUL intermediate (cur) rather than
      // falling back to the raw input on any error. If upscale+removeBg
      // succeed but crop fails, the deliverable is the removeBg output (not
      // the raw). Errors are reported separately in the errors array.
      outputs.push(cur);
    }
    return { applied, errors, outputs };
  }

  window.BatchPostprocess = { runRowPostprocess, parseDims };
})();
