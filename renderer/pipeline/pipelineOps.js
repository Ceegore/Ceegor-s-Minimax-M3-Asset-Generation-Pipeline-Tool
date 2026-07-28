// renderer/pipeline/pipelineOps.js
// Image operations wrappers for pipeline board items.

(function () {
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

  // Map of item id → cancel flag (set by cancel(); checked after the await).
  const _cancel = {};

  async function run(item) {
    if (item.status === 'running') return;
    const column = item.column;
    if (!['upscale', 'removebg', 'crop', 'resize', 'optimize'].includes(column)) return;
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
    const passedThrough = (column === 'crop' && (!Number(settings.w) || !Number(settings.h))) ||
      (column === 'resize' && (!Number(settings.width) || !Number(settings.height)));
    try {
      if (column === 'upscale') {
        dst = await runSerial('spawn:realesrgan', () => doUpscale(item, src, settings, board));
      } else if (column === 'removebg') {
        dst = await runSerial('spawn:isnetbg', () => doRemoveBg(item, src, settings, board));
      } else if (column === 'crop') {
        dst = await doCrop(item, src, settings, board);
      } else if (column === 'resize') {
        dst = await doResize(item, src, settings, board);
      } else if (column === 'optimize') {
        dst = await doOptimize(item, src, settings, board);
      }
      if (_cancel[item.id]) { item.status = 'idle'; PipelineBoard.updateCard(item); return; }
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
          // BGR pipeline-grant fix: dstPng (and its .tmp.png sibling) lives in THIS
          // column's folder, a sibling of the src's folder — a grant minted on
          // pathDirname(src) fails the handler's 'write' check on dstPng. Mint on
          // the common ancestor of src + dstPng (covers src read + dst/tempOut write).
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
              if (!delGrant || delGrant.ok !== false) window.api.fbDelete(tempOut, delGrant).catch(() => {}); // R8: don't forward a {ok:false} grant object to the IPC (it can never authorise)
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
                window.api.fbDelete(tempOut, delGrant2).catch(() => {}); // R8: don't forward a {ok:false} grant object
              }
            }
            return dstPng;
          }
        }
      } catch (e) {
        // If the caller forced Canvas fallback off but Real-ESRGAN is missing
        // or failed, fall through to the canvas path (best-effort) — UNLESS the
        // user explicitly wants Real-ESRGAN only (useCanvasFallback
        // is honoured as a hard toggle below).
        if (settings.useCanvasFallback === false) {
          // Only fall through when Real-ESRGAN was unavailable (not a hard
          // failure of an actual run). Re-throw real run failures.
          if (e && /failed/i.test(e.message)) throw e;
        }
      }
    }
    // Canvas fallback: upscaleImageFile (section08) writes the file ITSELF and
    // returns the on-disk PATH (not a dataURL). Use that path directly.
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
    // BGR pipeline-grant fix: dst lives in THIS column's folder (a sibling of the
    // src's folder) — a grant minted on pathDirname(src) fails the handler's
    // 'write' check on dst. Mint on the common ancestor of src + dst.
    const isnetGrant = (window.GrantHelper) ? await window.GrantHelper.ensureTransform(src, dst) : undefined;
    if (isnetGrant && isnetGrant.ok === false) throw new Error('Grant failure: ' + (isnetGrant.error || 'authorization denied'));
    const r = await window.api.isnetbgRun(src, dst, { model: settings.model, useGpu: settings.useGpu, jobId: item.id, postClean: settings.postClean, featherPx: settings.featherPx, defringe: settings.defringe, refine: settings.refine }, isnetGrant);
    if (!r || !r.ok) throw new Error((r && (r.stderr || r.error)) || 'background removal failed');
    // KGO-020 fix: warn if the result appears to be 100% transparent (no salient subject).
    // Load the output and sample a few pixels to detect an all-empty mask.
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
    // Compute the crop rectangle from anchor + W×H (mirror runPostProcessChain's
    // auto-crop). W/H of 0 = use source dims (no-op crop).
    const img = await loadImageFromFile(src);
    const uW = img.naturalWidth, uH = img.naturalHeight;
    const wantW = settings.w || uW;
    const wantH = settings.h || uH;
    const w = Math.min(wantW, uW);
    const h = Math.min(wantH, uH);
    if (w === uW && h === uH && settings.mode !== 'drag') {
      // No-op crop: copy the source into the crop folder under the documented
      // name so the per-column-folder invariant holds (selfHeal + recoverBoard
      // + finalize all assume files live in their column's folder).
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

  // Resize to a free target resolution. The renderer computes the final
  // (width,height) pair (aspect-link handled in the card settings); the engine
  // does fit:'fill' Lanczos3 + subtle sharpen on downscale. W=H=0 means "no
  // target set" → no-op copy-through (mirrors crop with W=H=0) so the
  // per-column-folder invariant holds.
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

  // Ensure dst's parent folder exists before handing the path to a writer
  // that does NOT create directories (the sharp resize/optimize IPCs, the
  // Real-ESRGAN and IS-Net binaries). Without this, the first real op into a
  // fresh column folder failed with ENOENT — the no-op copy paths go through
  // copyFileIntoPlace (which ensures the folder), masking the gap.
  async function ensureDirFor(dst) {
    // BGR-009 fix: mint mkdir grant for fbEnsureDir (R1.3 gate).
    const dirGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDir(path.dirname(dst)) : undefined;
    const r = await window.api.fbEnsureDir(path.dirname(dst), dirGrant);
    if (!r || !r.ok) throw new Error('Could not create destination folder: ' + ((r && r.error) || 'unknown'));
  }

  // Copy src to dst (which may be in a different folder), creating the dst
  // folder if needed. fbCopy copies into a DIRECTORY and auto-renames on
  // collision (returning the actual destination in c.path), so use that path
  // as the rename source rather than assuming the source basename.
  const same = (a, b) => String(a || '').replace(/[\\/]+/g, '\\').toLowerCase() === String(b || '').replace(/[\\/]+/g, '\\').toLowerCase(); // R7: NTFS is case-insensitive — treat a case-only difference as the SAME file (else a case-only rename deletes the source / renames a file onto itself).
  async function copyFileIntoPlace(src, dst) {
    if (same(src, dst)) return;
    const dstDir = path.dirname(dst);
    // BGR-009 fix: mint grants for fbEnsureDir/fbCopy/fbRename (R1.3 gate).
    const dirGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDir(dstDir) : undefined;
    const r = await window.api.fbEnsureDir(dstDir, dirGrant);
    if (!r || !r.ok) throw new Error('Could not create destination folder: ' + (r && r.error));
    await removeExistingOutput(dst, src);
    // gewv2 GEW-002 fix: ensureCopy returns { ok, srcGrant, destGrant }.
    const cp = (window.GrantHelper) ? await window.GrantHelper.ensureCopy(src, dstDir) : undefined;
    const c = await window.api.fbCopy(src, dstDir, cp && cp.srcGrant, cp && cp.destGrant);
    if (!c || !c.ok) throw new Error('Copy failed: ' + ((c && c.error) || 'unknown'));
    const copiedAs = (c.path && typeof c.path === 'string') ? c.path : path.join(dstDir, path.basename(src));
    if (!same(copiedAs, dst)) {
      const renameGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRename(copiedAs) : undefined;
      const rn = await window.api.fbRename(copiedAs, path.basename(dst), renameGrant);
      if (!rn || !rn.ok) throw new Error('Rename failed: ' + ((rn && rn.error) || 'unknown'));
    }
  }

  async function moveFileIntoPlace(src, dst) {
    const dstDir = path.dirname(dst);
    const dstName = path.basename(dst);
    await ensureDirFor(dst);
    // Replace a previous deterministic result so Back → Run is repeatable.
    // fb:move auto-renames on collision, while fb:rename correctly rejects a
    // collision; remove the old canonical output before placing the new one.
    await removeExistingOutput(dst, src);
    // BGR-009 fix: mint move grant (R1.3 gate).
    // gewv2 GEW-002 fix: ensureMove returns { ok, srcGrant, destGrant }.
    const mv = (window.GrantHelper) ? await window.GrantHelper.ensureMove(src, dstDir) : undefined;
    const r = await window.api.fbMove(src, dstDir, mv && mv.srcGrant, mv && mv.destGrant);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Failed to move file');
    const movedAs = r.path || path.join(dstDir, path.basename(src));
    if (!same(movedAs, dst)) {
      const renameGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRename(movedAs) : undefined;
      const rn = await window.api.fbRename(movedAs, dstName, renameGrant);
      if (!rn || !rn.ok) throw new Error((rn && rn.error) || 'Rename failed');
    }
  }

  async function removeExistingOutput(dst, src) {
    if (!window.api.fbExists) return;
    // BGR-009 fix: mint read+delete grants (R1.3 gate).
    const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(dst) : undefined;
    const exists = await window.api.fbExists(dst, existsGrant).catch(() => null);
    if (!exists || !exists.exists || same(src, dst)) return;
    const deleteGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(dst) : undefined;
    const deleted = await window.api.fbDelete(dst, deleteGrant);
    if (!deleted || !deleted.ok) throw new Error((deleted && deleted.error) || 'Failed to replace existing output');
  }

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

  const path = {
    sep(p) { return (String(p).includes('\\')) ? '\\' : '/'; },
    // KGO-021 fix: return '' (not '.') for a separator-less input so callers
    // like ensureDirFor/fbEnsureDir fail loudly instead of resolving to CWD.
    dirname(p) { const s = path.sep(p); return String(p).split(s).slice(0, -1).join(s); },
    basename(p) { const s = path.sep(p); return String(p).split(s).pop() || ''; },
    join(...parts) { const s = path.sep(parts[0] || ''); return parts.map((x, i) => i > 0 ? String(x).replace(/^[\\/]+/, '') : String(x).replace(/[\\/]+$/, '')).filter(Boolean).join(s); },
  };

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
