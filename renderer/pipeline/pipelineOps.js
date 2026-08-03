// renderer/pipeline/pipelineOps.js
// Image operations wrappers for pipeline board items.

(function () {
  // P3.5 (DA-H-010): file-placement helpers in pipelineFileOps.js (loaded first).
  const { same, ensureDirFor, copyFileIntoPlace, moveFileIntoPlace, removeExistingOutput, path } = window.PipelineFileOps;
  // Per-resource queues (key = 'spawn:realesrgan' / 'spawn:isnetbg').
  const _queues = {};
  function queue(key) {
    if (!_queues[key]) _queues[key] = { head: Promise.resolve() };
    return _queues[key];
  }
  function runSerial(key, fn) {
    const q = queue(key);
    const next = q.head.then(fn, fn); // run regardless of previous success/fail
    q.head = next.catch(() => {});
    return next;
  }

  const _cancel = {}; // item id → cancel flag
  let _opCounter = 0; // H-011: per-run op ID so cleanup only touches its own output.
  function mintOpId(id) { return id + '_op' + (++_opCounter) + '_' + Date.now().toString(36); }

  async function run(item) {
    if (item.status === 'running') return;
    const column = item.column;
    if (!['upscale', 'removebg', 'crop', 'resize', 'optimize'].includes(column)) return;
    const opId = mintOpId(item.id); item._activeOpId = opId; // H-011: scoped cleanup
    _cancel[item.id] = false;
    item._runGen = (item._runGen || 0) + 1; // R6.6.6: stale-progress filter generation.
    item.status = 'running';
    item.error = null;
    // KGO-006 fix: clear stale progress from a previous run so the bar starts fresh.
    delete item._progress;
    // QA-019 fix: also clear the stale setter so the new run rebuilds its own.
    if (window.PipelineCardProgress && typeof window.PipelineCardProgress.clearProgressSetter === 'function') {
      window.PipelineCardProgress.clearProgressSetter(item.id);
    }
    PipelineBoard.updateCard(item);
    const src = item.files[column];
    const settings = PipelineModel.resolveSettings(column, item.settings);
    const next = PipelineModel.nextColumn(column);
    const board = window.state.pipeline.image;
    let dst = null;
    // DA-M-014: crop pass-through only when BOTH axes unset; resize when EITHER.
    const passedThrough = (column === 'crop' && !Number(settings.w) && !Number(settings.h)) ||
      (column === 'resize' && (!Number(settings.width) || !Number(settings.height)));
    try {
      if (column === 'upscale') {
        // P3.5 (DA-H-011): re-check cancel when the queued job STARTS.
        dst = await runSerial('spawn:realesrgan', () => {
          if (_cancel[item.id]) return null;
          return doUpscale(item, src, settings, board);
        });
      } else if (column === 'removebg') {
        dst = await runSerial('spawn:isnetbg', () => {
          if (_cancel[item.id]) return null;
          return doRemoveBg(item, src, settings, board);
        });
      } else if (column === 'crop') {
        dst = await doCrop(item, src, settings, board);
      } else if (column === 'resize') {
        dst = await doResize(item, src, settings, board);
      } else if (column === 'optimize') {
        dst = await doOptimize(item, src, settings, board);
      }
      if (_cancel[item.id]) {
        // H-011: delete partial output only if this op still owns it (cancel+restart race guard).
        if (dst && item._activeOpId === opId) { try { const dg = window.GrantHelper ? await window.GrantHelper.ensureDelete(dst) : undefined; if (!dg || dg.ok !== false) await window.FbIntent.del(dst, dg); } catch (_) {} }
        item.status = 'idle'; PipelineBoard.updateCard(item); return;
      }
      if (!dst) throw new Error('Operation produced no output file.');
      // Record the output + advance.
      let nameTransition = null;
      if (column === 'optimize') {
        nameTransition = syncItemNameExtension(item, dst);
        if (nameTransition) {
          item.name = nameTransition.newName;
        }
      }
      item.files[next] = dst;
      item.column = next;
      item.status = 'idle';
      const histEntry = { action: 'run', column, next, file: dst, ts: Date.now() };
      if (nameTransition) {
        histEntry.nameBefore = nameTransition.oldName;
        histEntry.nameAfter = nameTransition.newName;
      }
      item.history.push(histEntry);
      PipelineBoard.save();
      PipelineBoard.render();
      PipelineBoard.logEvent({
        category: 'pipeline', result: 'ok',
        headline: passedThrough
          ? `Pipeline ${column}: no dimensions set — passed through`
          : `Pipeline ${column}: ${item.name} → ${path.basename(dst)}`,
        details: [`Item: ${item.id}`, `Column: ${column}`, `Output: ${dst}`, ...(passedThrough ? ['Result: passed through'] : [])],
      });
      if (typeof window.toast === 'function') {
        if (passedThrough) {
          window.toast(`Pipeline ${column}: no settings set — passed through unchanged`, 'info', 3500);
        } else {
          window.toast(`Pipeline ${column} completed → ${path.basename(dst)}`, 'ok', 3500);
        }
      }
    } catch (e) {
      if (_cancel[item.id]) { item.status = 'idle'; PipelineBoard.updateCard(item); return; }
      item.status = 'error';
      item.error = String((e && e.message) || e);
      PipelineBoard.save();
      PipelineBoard.updateCard(item);
      PipelineBoard.logEvent({
        category: 'pipeline', result: 'err',
        headline: `Pipeline ${column} failed: ${item.name}`,
        details: [String((e && e.message) || e)],
      });
      PipelineBoard.toast(`Pipeline ${column} failed: ${item.error}`, 'err');
    } finally {
      delete _cancel[item.id];
    }
  }

  function cancel(itemId) {
    _cancel[itemId] = true;
    // R6.6.2: kill the backend spawn mid-flight via the shared jobRegistry.
    if (window.api && window.api.jobCancel) window.api.jobCancel({ jobId: itemId }).catch(() => {});
  }

  // ---- Per-operation implementations (delegate to existing window.api.*) ----

  async function doUpscale(item, src, settings, board) {
    const name = item.name || 'image';
    // Try Real-ESRGAN first (unless Canvas fallback is forced).
    if (!settings.useCanvasFallback) {
      try {
        const avail = await window.api.realesrganAvailable();
        if (avail && avail.available) {
          const adv = (window.state.pipelineAdvancedSettings && window.state.pipelineAdvancedSettings.realesrgan) || {};
          const modelNativeScale = (settings.model === 'realesr-animevideov3')
            ? Math.max(2, Math.min(4, Math.floor(settings.multiplier)))
            : 4;
          const dstPng = outPath(board, item.id, name, 'upscale', { mult: settings.multiplier, ext: 'png' });
          await ensureDirFor(dstPng);
          // BGR: mint on common ancestor of src + dst (covers read + write).
          const resrGrant = (window.GrantHelper) ? await window.GrantHelper.ensureTransform(src, dstPng) : undefined;
          if (resrGrant && resrGrant.ok === false) throw new Error('Grant failure: ' + (resrGrant.error || 'authorization denied'));
          if (settings.multiplier === modelNativeScale) {
            const r = await window.api.realesrganRun(src, dstPng, {
              model: settings.model, scale: modelNativeScale,
              tileSize: adv.tileSize, ttaMode: adv.ttaMode, gpuId: adv.gpuId, progressKey: item.id, jobId: item.id, runGen: item._runGen,
            }, resrGrant);
            if (!r || !r.ok) throw new Error((r && (r.stderr || r.error)) || 'Real-ESRGAN failed');
            return dstPng;
          } else {
            const tempOut = dstPng + '.tmp.png';
            const r = await window.api.realesrganRun(src, tempOut, {
              model: settings.model, scale: modelNativeScale,
              tileSize: adv.tileSize, ttaMode: adv.ttaMode, gpuId: adv.gpuId, progressKey: item.id, jobId: item.id, runGen: item._runGen,
            }, resrGrant);
            if (!r || !r.ok) {
              // BGR-009 fix: mint delete grant for temp cleanup.
              const delGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tempOut) : undefined;
              if (!delGrant || delGrant.ok !== false) window.FbIntent.del(tempOut, delGrant).catch(() => {}); // R8: don't forward a {ok:false} grant object to the IPC (it can never authorise)
              throw new Error((r && (r.stderr || r.error)) || 'Real-ESRGAN failed');
            }
            try {
              let naturalW = 0, naturalH = 0;
              if (window.api && typeof window.api.imageMetadata === 'function') {
                // EFH2-003 fix: mint a read grant (the IPC requires one).
                const metaGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(src) : undefined;
                const meta = await window.api.imageMetadata(src, metaGrant);
                if (meta && meta.ok) { naturalW = meta.width; naturalH = meta.height; }
                else if (typeof window.logAction === 'function') { window.logAction('image-metadata', 'fallback', { error: (meta && meta.error) || 'unknown' }); }
              }
              if (!naturalW || !naturalH) {
                const img = await loadImageFromFile(src);
                naturalW = img.naturalWidth;
                naturalH = img.naturalHeight;
              }
              const targetW = Math.max(1, Math.floor(naturalW * settings.multiplier));
              const targetH = Math.max(1, Math.floor(naturalH * settings.multiplier));

              const resizeGrant = (window.GrantHelper) ? await window.GrantHelper.ensureTransform(tempOut, dstPng) : undefined;
              if (resizeGrant && resizeGrant.ok === false) throw new Error('Grant failure: ' + (resizeGrant.error || 'authorization denied'));
              const resizeRes = await window.api.resizeImage(tempOut, {
                width: targetW,
                height: targetH,
                format: 'png',
                quality: 100,
                outputPath: dstPng,
                sharpenOnDownscale: true,
              }, resizeGrant);
              if (window.reportIpcWarnings) window.reportIpcWarnings(resizeRes); // KGO7-020

              if (!resizeRes || !resizeRes.ok) {
                throw new Error((resizeRes && resizeRes.error) || 'Sharp upscale downscale failed');
              }
            } finally {
              const delGrant2 = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tempOut) : undefined;
              if (window.api && typeof window.api.fbDelete === 'function' && (!delGrant2 || delGrant2.ok !== false)) {
                window.FbIntent.del(tempOut, delGrant2).catch(() => {}); // R8: don't forward a {ok:false} grant object
              }
            }
            return dstPng;
          }
        }
      } catch (e) {
        // Real-ESRGAN missing/failed → fall through to canvas path unless
        // it was a hard run failure (re-throw those).
        if (settings.useCanvasFallback === false) {
          if (e && /failed/i.test(e.message)) throw e;
        }
      }
    }
    // Canvas fallback: upscaleImageFile writes the file and returns the path.
    if (typeof window.upscaleImageFile !== 'function') {
      throw new Error('No upscaler available (install Real-ESRGAN or enable Canvas fallback).');
    }
    const writtenPath = await window.upscaleImageFile(src, settings.multiplier, { forceCanvas: true });
    if (!writtenPath || typeof writtenPath !== 'string') {
      throw new Error('Canvas upscale produced no output file.');
    }
    const ext = (writtenPath.split('.').pop() || 'png').toLowerCase();
    const dst = outPath(board, item.id, name, 'upscale', { mult: settings.multiplier, ext });
    await moveFileIntoPlace(writtenPath, dst);
    return dst;
  }

  async function doRemoveBg(item, src, settings, board) {
    const name = item.name || 'image';
    const dst = outPath(board, item.id, name, 'removebg', { ext: 'png' });
    if (same(src, dst)) { // R8: same() = separator/case-insensitive (NTFS) — the raw toLowerCase() missed a '/'-vs-'\' difference
      throw new Error('Source and destination paths are identical.');
    }
    await ensureDirFor(dst);
    // DA-M-015: skipIfTransparent — copy through if source already has alpha.
    if (settings.skipIfTransparent) {
      try {
        const img = await loadImageFromFile(src);
        const c = document.createElement('canvas');
        c.width = Math.min(img.naturalWidth, 64);
        c.height = Math.min(img.naturalHeight, 64);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let hasTransparent = false;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] < 250) { hasTransparent = true; break; }
        }
        if (hasTransparent) {
          await copyFileIntoPlace(src, dst);
          return dst;
        }
      } catch (_) { /* probe failed — fall through to backend */ }
    }
    // BGR: mint on common ancestor of src + dst.
    const isnetGrant = (window.GrantHelper) ? await window.GrantHelper.ensureTransform(src, dst) : undefined;
    if (isnetGrant && isnetGrant.ok === false) throw new Error('Grant failure: ' + (isnetGrant.error || 'authorization denied'));
    const r = await window.api.isnetbgRun(src, dst, { model: settings.model, useGpu: settings.useGpu, jobId: item.id, postClean: settings.postClean, featherPx: settings.featherPx, defringe: settings.defringe, refine: settings.refine }, isnetGrant);
    if (!r || !r.ok) throw new Error((r && (r.stderr || r.error)) || 'background removal failed');
    // KGO-020: warn if result is 100% transparent (no subject detected).
    try {
      const img = await loadImageFromFile(dst);
      const c = document.createElement('canvas');
      c.width = Math.min(img.naturalWidth, 64);
      c.height = Math.min(img.naturalHeight, 64);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let hasOpaque = false;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 10) { hasOpaque = true; break; }
      }
      if (!hasOpaque) {
        PipelineBoard.toast('⚠ Remove BG produced a fully transparent image (no subject detected).', 'warn');
        if (typeof window.logAction === 'function') window.logAction('pipeline-removebg', 'empty-result', { item: item.id, src });
      }
    } catch (_) { /* best-effort check */ }
    return dst;
  }

  async function doCrop(item, src, settings, board) {
    if (typeof window.cropImageFile !== 'function') throw new Error('cropImageFile unavailable.');
    // Crop rect from anchor + W×H. W/H of 0 = use source dims (no-op).
    const img = await loadImageFromFile(src);
    const uW = img.naturalWidth, uH = img.naturalHeight;
    const wantW = settings.w || uW;
    const wantH = settings.h || uH;
    const w = Math.min(wantW, uW);
    const h = Math.min(wantH, uH);
    if (w === uW && h === uH && settings.mode !== 'drag') {
      // No-op crop: copy source into crop folder (per-column-folder invariant).
      const ext = (src.split('.').pop() || 'png').toLowerCase();
      const dst = outPath(board, item.id, item.name || 'image', 'crop', { ext });
      await copyFileIntoPlace(src, dst);
      return dst;
    }
    let x = 0, y = 0;
    if (settings.mode === 'drag') {
      x = Math.max(0, Math.min(uW - w, Math.floor(settings.x || 0)));
      y = Math.max(0, Math.min(uH - h, Math.floor(settings.y || 0)));
    } else {
      const maxX = uW - w, maxY = uH - h;
      if (settings.anchorX === 'left') x = 0;
      else if (settings.anchorX === 'right') x = maxX;
      else x = Math.floor(maxX / 2);
      if (settings.anchorY === 'top') y = 0;
      else if (settings.anchorY === 'bottom') y = maxY;
      else y = Math.floor(maxY / 2);
    }
    // cropImageFile (section08) writes the file ITSELF and returns the on-disk PATH (not a dataURL).
    const writtenPath = await window.cropImageFile(src, x, y, w, h);
    if (!writtenPath || typeof writtenPath !== 'string') {
      throw new Error('Crop produced no output file.');
    }
    const ext = (src.split('.').pop() || 'png').toLowerCase();
    const dst = outPath(board, item.id, item.name || 'image', 'crop', { ext });
    await moveFileIntoPlace(writtenPath, dst);
    window._pipelineLastCrop = { w, h, ts: Date.now() }; // H10-1: session crop memory for "reuse last crop".
    return dst;
  }

  // Resize to target W×H (Lanczos3 + sharpen on downscale). W=H=0 → no-op copy.
  async function doResize(item, src, settings, board) {
    const w = Math.max(0, Math.floor(Number(settings.width) || 0));
    const h = Math.max(0, Math.floor(Number(settings.height) || 0));
    if (!w || !h) {
      const ext = (src.split('.').pop() || 'png').toLowerCase();
      const dst = outPath(board, item.id, item.name || 'image', 'resize', { ext });
      await copyFileIntoPlace(src, dst);
      return dst;
    }
    const ext = (src.split('.').pop() || 'png').toLowerCase();
    const dst = outPath(board, item.id, item.name || 'image', 'resize', { ext });
    if (same(src, dst)) throw new Error('Source and destination paths are identical.'); // R8: same() = separator/case-insensitive (NTFS)
    await ensureDirFor(dst);
    // BGR pipeline-grant fix: dst lives in THIS column's folder (a sibling of the
    // src's folder) — a grant minted on pathDirname(src) fails the handler's
    // 'write' check on dst. Mint on the common ancestor of src + dst.
    const rg = (window.GrantHelper) ? await window.GrantHelper.ensureTransform(src, dst) : undefined;
    if (rg && rg.ok === false) throw new Error('Grant failure: ' + (rg.error || 'authorization denied'));
    const r = await window.api.resizeImage(src, {
      width: w, height: h,
      sharpenOnDownscale: settings.sharpen !== false,
      outputPath: dst,
    }, rg);
    if (window.reportIpcWarnings) window.reportIpcWarnings(r); // KGO7-020
    if (!r || !r.ok) throw new Error((r && r.error) || 'resize failed');
    return r.outputPath || dst;
  }

  async function doOptimize(item, src, settings, board) {
    const ext = settings.format === 'keep' ? ((src.split('.').pop() || 'png').toLowerCase()) : settings.format;
    const dst = outPath(board, item.id, item.name || 'image', 'optimize', { ext });
    if (same(src, dst)) { // R8: same() = separator/case-insensitive (NTFS) — the raw toLowerCase() missed a '/'-vs-'\' difference
      throw new Error('Source and destination paths are identical.');
    }
    await ensureDirFor(dst);
    // BGR pipeline-grant fix: dst lives in THIS column's folder (a sibling of the
    // src's folder) — a grant minted on pathDirname(src) fails the handler's
    // 'write' check on dst. Mint on the common ancestor of src + dst.
    const og = (window.GrantHelper) ? await window.GrantHelper.ensureTransform(src, dst) : undefined;
    if (og && og.ok === false) throw new Error('Grant failure: ' + (og.error || 'authorization denied'));
    const r = await window.api.optimizeImage(src, {
      quality: settings.quality,
      format: settings.format === 'keep' ? null : settings.format,
      stripMetadata: settings.stripMetadata,
      outputPath: dst,
    }, og);
    if (window.reportIpcWarnings) window.reportIpcWarnings(r); // KGO8-011: optimize warnings were dropped here too
    if (!r || !r.ok) throw new Error((r && r.error) || 'optimize failed');
    return r.outputPath || dst;
  }

  // Copy an item's current file into the final column (used by Finalize). The
  // file lands at the documented img_<id>_<name>.<ext> name via copy-then-rename.
  async function copyToFinal(item) {
    const board = window.state.pipeline.image;
    const src = item.files[item.column];
    if (!src) throw new Error('No current file.');
    const name = item.name || 'image';
    const ext = (src.split('.').pop() || 'png').toLowerCase();
    const dst = outPath(board, item.id, name, 'final', { ext });
    await copyFileIntoPlace(src, dst);
    item.files.final = dst;
  }

  // ---- helpers ----

  // Delegate to the bridged PipelineModel.outPath (pipelineModelBridge.js) so
  // the file name the renderer computes is identical to the name the
  // main-process IPC handlers compute.
  // EFH2-006 fix: the old fallback silently produced wrong names (<id>_image.<ext>).
  // A hard failure at startup beats silently mis-naming every asset.
  function outPath(board, id, displayName, column, opts) {
    if (window.PipelineModel && typeof window.PipelineModel.outPath === 'function') {
      return window.PipelineModel.outPath(board.workspace, id, displayName, column, Object.assign({}, opts, { columnFolders: board.columnFolders }));
    }
    throw new Error('PipelineModel.outPath unavailable \u2014 cannot compute output path for ' + column + '/' + id);
  }

  function syncItemNameExtension(item, dstPath) {
    if (!item || !dstPath) return null;
    const dstExt = (String(dstPath).split('.').pop() || '').toLowerCase();
    if (!dstExt) return null;
    const oldName = item.name || '';
    const knownExts = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'gif', 'tiff'];
    let stem = oldName;
    const dotIdx = oldName.lastIndexOf('.');
    if (dotIdx > 0) {
      const extCandidate = oldName.slice(dotIdx + 1).toLowerCase();
      if (knownExts.includes(extCandidate)) {
        stem = oldName.slice(0, dotIdx);
      }
    }
    const newName = `${stem}.${dstExt}`;
    if (newName !== oldName) {
      return { oldName, newName };
    }
    return null;
  }

  window.PipelineOps = { run, cancel, copyToFinal, syncItemNameExtension };
})();
