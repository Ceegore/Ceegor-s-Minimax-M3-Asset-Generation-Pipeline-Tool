// renderer/overlays/imageEditorActions.js (Feature 5 — pixel editor)
// Save / bake / heal-stub / external-handoff / format + alpha helpers.
//
// Extracted from imageEditorOverlay.js to stay under the 500-line lint cap.
// These are pure-ish functions that take the controller (ctrl) and operate on
// the active slot/session. They are attached to window.ImageEditorActions and
// called by the overlay's footer buttons.

(function () {
  'use strict';

  // ---------- format / path helpers ----------
  function mimeForFmt(fmt) {
    return window.ImageUtils.mimeFromPath('x.' + fmt);
  }

  // Derive <stem>_edited.<ext> from the source path, honouring the chosen
  // output format. Mirrors the on-disk sibling-file convention used by
  // _cropped_/_nobg_/_optimized_ (no metadata DB).
  function derivedEditedPath(srcPath, fmt) {
    if (window.PureFuncs && window.PureFuncs.derivedOutputPath) {
      const base = window.PureFuncs.derivedOutputPath(srcPath, '_edited');
      const dot = base.lastIndexOf('.');
      const ext = window.TinyUtils.extFromMime(mimeForFmt(fmt));
      return (dot >= 0 ? base.slice(0, dot) : base) + '.' + ext;
    }
    const dot = srcPath.lastIndexOf('.');
    return (dot >= 0 ? srcPath.slice(0, dot) : srcPath) + '_edited.' + fmt.replace('jpeg', 'jpg');
  }

  // PE-021: full RGBA alpha scan (replaces the coarse step-15 sampling that
  // missed isolated transparent pixels). Scans ONLY the alpha channel at
  // stride 4 — O(n) but with a tiny constant (single byte compare per pixel).
  // Used to (a) default the format to PNG, (b) warn before a JPEG export that
  // would flatten transparency to a matte (pitfall §15).
  //
  // R4.2 (PE-001 migration): use `renderSceneAtNaturalSize(session)` instead
  // of `session.canvas.toCanvasElement(1)` so the alpha scan runs at the
  // NATURAL pixel coordinates — otherwise a user zoomed-in by 2× would
  // scan the LIVE canvas at zoomed coords and miss most of the image.
  function canvasHasAlpha(session) {
    // R4.2-auditfix P-R42-05: dispose temp canvas after use to prevent
    // memory leaks on repeated save operations.
    let temp;
    try {
      temp = session.renderSceneAtNaturalSize();
      const c = temp.toCanvasElement(1);
      const ctx = c.getContext('2d');
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      // Full scan: check every pixel's alpha channel (offset 3 in each
      // 4-byte RGBA group). Early-exit on the first semi-transparent pixel.
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) return true;
      }
      return false;
    } catch (_) { return false; }
    finally { try { temp && temp.dispose(); } catch (_) {} }
  }

  // Composite the scene onto a white matte → dataURL (for JPEG export of a
  // transparent canvas). The matte colour is white by default (best default for
  // web asset delivery); callers can extend this later to pick a custom matte.
  //
  // R4.2 (PE-001 migration): source is `renderSceneAtNaturalSize(session)`
  // (NOT `session.canvas.toCanvasElement(1)`) so the matte composite runs
  // at the natural pixel coordinates — otherwise a user zoomed-in would
  // composite a partial image onto the white matte.
  //
  // R4.2-auditfix P-R42-05: dispose the temp canvas after use to prevent
  // memory leaks on repeated JPEG exports.
  function flattenOntoMatte(session, fmt, matte) {
    const temp = session.renderSceneAtNaturalSize();
    try {
      const src = temp.toCanvasElement(1);
      const tmp = document.createElement('canvas');
      tmp.width = src.width; tmp.height = src.height;
      const ctx = tmp.getContext('2d');
      ctx.fillStyle = matte || '#ffffff';
      ctx.fillRect(0, 0, tmp.width, tmp.height);
      ctx.drawImage(src, 0, 0);
      return tmp.toDataURL(mimeForFmt(fmt), 0.92);
    } finally { try { temp.dispose(); } catch (_) {} }
  }

  function asyncConfirm(msg, title) {
    if (typeof window.asyncConfirm === 'function') return window.asyncConfirm(msg, title);
    return Promise.resolve(false);
  }

  // ---------- SAVE ----------
  // fmt: 'png' | 'jpeg' | 'webp'. PNG default when alpha present. JPEG export
  // of a transparent canvas prompts + composites onto white. Writes via
  // writeImageBase64 (no 25MB cap) when available, else fbWrite.
  async function onSave(ctrl) {
    const slot = activeSlot(ctrl); if (!slot) { toast('Load an image first.', 'warn'); return; }
    const h = activeSession(ctrl); if (!h) { toast('Load an image first.', 'warn'); return; }
    const fmt = ctrl.prefs.outFormat || 'png';
    const hasAlpha = canvasHasAlpha(h.session);
    if (fmt === 'jpeg' && hasAlpha) {
      const ok = await asyncConfirm('JPEG cannot store transparency. Transparent areas will be filled with white. Continue?', 'JPEG Export');
      if (!ok) return;
    }
    ctrl.ui.saveBtn.disabled = true; ctrl.ui.saveBtn.textContent = 'Saving…';
    doSave(ctrl, slot, fmt).then((out) => {
      ctrl.ui.saveBtn.disabled = false; ctrl.ui.saveBtn.textContent = ctrl.saveLabel || '💾 Save';
      if (out && out.ok === false) {
        // R4.2-auditfix: write errors return {ok:false, error:'...'} —
        // surface as an error toast (was previously silently swallowed
        // by the `if (out)` truthy check).
        toast('Save failed: ' + (out.error || 'write returned ok:false'), 'err', 6000);
        if (ctrl.onSaveFailed) ctrl.onSaveFailed(out);
        return;
      }
      if (out && out.ok) {
        // gewv2 GEW-004 fix: doSave now resolves { ok:true, path } on
        // success instead of the raw write envelope, so `out` here is the
        // saved path string's container, not the envelope itself.
        const savedPath = out.path;
        toast('Saved → ' + savedPath, 'ok', 4000);
        slot.modified = false;
        if (ctrl.ui.queueBar) refreshQueueBarSafe(ctrl);
        if (ctrl.onSaved) ctrl.onSaved(savedPath);
        else {
          if (typeof refreshBrowser === 'function') refreshBrowser();
          if (typeof previewImageFromFile === 'function') { try { previewImageFromFile(savedPath); } catch (_) {} }
        }
      }
    }).catch((e) => {
      ctrl.ui.saveBtn.disabled = false; ctrl.ui.saveBtn.textContent = ctrl.saveLabel || '💾 Save';
      toast('Save failed: ' + (e && e.message || e), 'err', 6000);
    });
  }

  async function doSave(ctrl, slot, fmt) {
    const h = activeSession(ctrl);
    const quality = (fmt === 'png') ? undefined : 0.92;
    let dataUrl;
    // R4.2-auditfix P-R42-05: temp is disposed on every path (success,
    // error, alpha-matte branch).
    let temp;
    try {
      // R4.2 (PE-001 migration): use `renderSceneAtNaturalSize` + a
      // local `toDataURL` call on the TEMP canvas (not the legacy
      // `h.toDataURL` which uses the LIVE canvas's VPT). The temp
      // canvas has identity VPT so the saved PNG is at the natural
      // pixel coordinates — NOT zoom/pan/fit-corrupted.
      if (fmt === 'jpeg' && canvasHasAlpha(h.session)) {
        // flattenOntoMatte owns its own temp + dispose.
        dataUrl = flattenOntoMatte(h.session, fmt, '#ffffff');
      } else {
        temp = h.renderSceneAtNaturalSize();
        // gewv2 GEW-005 fix (generalized): Fabric's StaticCanvas.toDataURL
        // `format` option only recognises BARE names ('png'|'jpeg'|'webp'),
        // not full MIME strings — `mimeForFmt(fmt)` returns 'image/jpeg' etc,
        // which Fabric doesn't recognise and silently falls back to PNG
        // bytes (proven live: {format:'image/jpeg'} -> PNG magic bytes,
        // {format:'jpeg'} -> real JPEG). This was masked for 'png' (the
        // fallback IS the correct format) and only visibly broke webp
        // (GEW-005) and jpeg (found while verifying GEW-005's fix). Route
        // through the underlying HTMLCanvasElement's native toDataURL
        // instead, which correctly accepts full MIME strings for every
        // format Chromium supports (png/jpeg/webp).
        dataUrl = temp.toCanvasElement(1).toDataURL(mimeForFmt(fmt), quality);
      }
    } catch (e) { return Promise.reject(e); }
    finally { try { temp && temp.dispose(); } catch (_) {} }
    const b64 = dataUrl.split(',')[1];
    if (ctrl.onSaveOverride) {
      // gewv2 GEW-004 fix: normalize the override's return value (a bare
      // path string, e.g. pipelineCardCorrect.js) into the { ok, path }
      // contract onSave now expects.
      const overridden = await ctrl.onSaveOverride(b64, fmt);
      if (overridden && typeof overridden === 'object') return overridden;
      return { ok: true, path: overridden };
    }
    let outPath = derivedEditedPath(slot.path, fmt);
    // PE-032: save collision policy. If the derived path already exists
    // on disk, ask the user to confirm overwrite. If declined, auto-
    // version the filename (stem (2).ext, stem (3).ext, …) so no data
    // is silently destroyed.
    if (window.api && window.api.fbExists) {
      try {
        // BGR-009 fix: mint read grant for fbExists (R1.3 gate).
        const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(outPath) : undefined;
        const exRes = (existsGrant && existsGrant.ok === false) ? { exists: true } : await window.api.fbExists(outPath, existsGrant);
        if (exRes && exRes.exists) {
          const overwrite = await asyncConfirm('File already exists:\n' + outPath + '\n\nOverwrite?', 'Overwrite File');
          if (!overwrite) {
            outPath = await nextFreeVersion(outPath);
          }
        }
      } catch (_) { /* existence check failed — proceed with original path */ }
    }
    // R1.5a.follow-up Phase 4: mint grant for outPath before write.
    // PRE-1: use window.GrantCache (no require in sandbox).
    let wg = window.api && window.api.mintGrant ? await window.GrantCache.ensurePathGrant(outPath, 'write') : undefined;
    // gewv2 GEW-007 fix: the source image may have been opened from OUTSIDE
    // the allowed roots (editor's load-from-disk / drag-in). The derived
    // sibling path then also fails the mint. Fall back to writing a temp
    // file under the trusted output dir, then route it through the native
    // Save-As dialog (which mints its own single-use write grant for
    // wherever the user picks).
    if (wg && wg.ok === false) {
      const outDir = (window.state && window.state.config && window.state.config.output_dir) || '';
      const ext = mimeForFmt(fmt).split('/')[1] === 'jpeg' ? 'jpg' : mimeForFmt(fmt).split('/')[1];
      const sep = outDir.includes('\\') ? '\\' : '/';
      const tmpOut = outDir + sep + '.ie_saveas_' + Date.now() + '.' + ext;
      const twg = await window.GrantCache.ensurePathGrant(window.api.pathDirname(tmpOut), 'write');
      if (twg && twg.ok === false) throw new Error('save: ' + (twg.error || 'mintGrant failed'));
      const wtmp = await ((window.api.writeImageBase64) ? window.api.writeImageBase64(tmpOut, b64, twg) : window.api.fbWrite(tmpOut, b64, twg));
      if (!wtmp || wtmp.ok === false) throw new Error('save: ' + ((wtmp && wtmp.error) || 'temp write failed'));
      let saveAsResult;
      try {
        saveAsResult = await window.api.fileSaveAs(tmpOut);
      } finally {
        try { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpOut) : undefined; await window.api.fbDelete(tmpOut, dg); } catch (_) {}
      }
      if (!saveAsResult || saveAsResult.canceled) return { ok: false, error: 'canceled' };
      if (!saveAsResult.ok) return { ok: false, error: saveAsResult.error || 'save-as failed' };
      return { ok: true, path: saveAsResult.path };
    }
    const writer = await ((window.api && window.api.writeImageBase64)
      ? window.api.writeImageBase64(outPath, b64, wg)
      : window.api.fbWrite(outPath, b64, wg));
    // gewv2 GEW-004 fix: return { ok, path } instead of the raw write
    // envelope, so onSave's "Saved → " toast and ctrl.onSaved(...) receive a
    // path string instead of "[object Object]". Errors keep the envelope's
    // ok:false + error message.
    if (writer && writer.ok === false) return { ok: false, error: writer.error || 'write returned ok:false' };
    return { ok: true, path: outPath };
  }

  // PE-032: find the next non-colliding versioned path. Tries
  // stem (2).ext, stem (3).ext, … up to 999. Falls back to a
  // timestamp suffix so the save never silently overwrites.
  async function nextFreeVersion(filePath) {
    const dot = filePath.lastIndexOf('.');
    const stem = dot >= 0 ? filePath.slice(0, dot) : filePath;
    const ext = dot >= 0 ? filePath.slice(dot) : '';
    for (let i = 2; i < 1000; i++) {
      const candidate = stem + ' (' + i + ')' + ext;
      try {
        // BGR-009 fix: mint read grant for fbExists (R1.3 gate).
        const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(candidate) : undefined;
        const r = (existsGrant && existsGrant.ok === false) ? { exists: true } : await window.api.fbExists(candidate, existsGrant);
        if (!r || !r.exists) return candidate;
      } catch (_) { return candidate; }
    }
    return stem + '_' + Date.now() + ext;
  }

  // ---------- BAKE / FLATTEN ----------
  // Rasterize placed objects into the base layer so the pen/eraser/heal can
  // operate on the composited pixels. One undo step; warn first (merging is a
  // deliberate, slightly destructive op — pitfall §15).
  async function onBake(ctrl) {
    const h = activeSession(ctrl); if (!h) { toast('Load an image first.', 'warn'); return; }
    const slot = activeSlot(ctrl); // PE-010: capture the target slot
    const objs = h.session.canvas.getObjects().filter((o) => o !== h.session.baseObject);
    if (!objs.length) { toast('Nothing to bake — no placed objects.', 'warn', 2500); return; }
    const ok = await asyncConfirm('Bake (flatten) placed images into the base layer? This merges all objects into the painted image (undoable).', 'Bake Objects');
    if (!ok) return;
    // R4.2 (PE-001 migration): bake must also use the natural-size
    // temp canvas. Otherwise a user zoomed-in would bake a partial
    // image into the base layer — the next pen/eraser would operate
    // on a corrupted base.
    const temp = h.session.renderSceneAtNaturalSize();
    const dataUrl = temp.toDataURL({ format: 'image/png', multiplier: 1 });
    try { temp.dispose(); } catch (_) {}

    // R5.2 Bake: pre-snapshot BEFORE canvas.clear (per R5.2 pattern).
    // Pre-fix, pushUndo was AFTER canvas.add(fImg), leaving the
    // pre-snapshot as the post-bake state. User had to undo TWICE
    // to get back to pre-bake. Post-R5.2: push here, before the
    // mutation, so a single undo restores the pre-bake state
    // (PE-005-Pixelvertrag). Track with flag so the .catch path
    // can pop the pre-snapshot if Image.fromURL throws (cancel-cleanup
    // per R5.2.AuditFix P-R52T-F1 / R5.2 Stroke pattern). Wrapped
    // in try/catch defensive.
    let pushedPreSnapshot = false;
    try {
      if (window.ImageEditorTools && typeof window.ImageEditorTools.pushUndo === 'function') {
        window.ImageEditorTools.pushUndo(h.session);
        pushedPreSnapshot = true;
      }
    } catch (_) { /* defensive: pre-snapshot push failed — proceed without undo */ }

    h.session.canvas.clear();
    return window.ImageEditorCanvas.requireFabric().Image.fromURL(dataUrl, { crossOrigin: 'anonymous' }).then((fImg) => {
      if (ctrl.closed) return; // PE-010: editor closed mid-bake — abandon
      fImg.set({ selectable: false, evented: false, lockMovementX: true, lockMovementY: true });
      h.session.canvas.add(fImg);
      h.session.canvas.sendObjectToBack(fImg);
      h.session.baseObject = fImg;
      h.session.canvas.renderAll();
      // (pushUndo moved above; see R5.2 Bake doc-comment)
      // PE-010: mark the CAPTURED slot dirty (not whichever slot is
      // active now) + bump its revision (the base was replaced), and
      // only refresh the objects list if that slot is still shown.
      if (slot) {
        slot.modified = true;
        if (window.ImageEditorTools && window.ImageEditorTools.bumpSlotRev) window.ImageEditorTools.bumpSlotRev(slot);
      }
      if (ctrl.queue[ctrl.activeIndex] === slot) {
        activeSlot(ctrl).modified = true;
        if (window.ImageEditorSource) window.ImageEditorSource.refreshObjectsList(ctrl);
      }
      refreshQueueBarSafe(ctrl);
      toast('Baked.', 'ok', 1500);
    }).catch((e) => {
      // R5.2 Bake: cancel-cleanup. If we pushed the pre-snapshot
      // but the async Image.fromURL threw, the canvas was cleared
      // but the new base wasn't added. Pop the pre-snapshot so
      // the undo stack stays consistent. Wrapped in try/catch
      // defensive (per R5.2 Transform.AuditFix P-R52T-F1 pattern).
      if (pushedPreSnapshot) {
        try {
          if (h.session && Array.isArray(h.session._undo) && h.session._undo.length) {
            h.session._undo.pop();
          }
        } catch (_) { /* defensive: malformed _undo shouldn't crash the catch */ }
        pushedPreSnapshot = false;
      }
      toast('Bake failed: ' + ((e && e.message) || e), 'err', 5000);
    });
  }

  // ---------- HEAL ----------
  // Presents the three GIMP-equivalent operations (Heal Selection / Heal
  // Transparency / Resynthesize). Implemented in imageEditorHeal.js.
  function onHeal(ctrl) {
    if (window.ImageEditorHeal && window.ImageEditorHeal.openMenu) {
      window.ImageEditorHeal.openMenu(ctrl);
    } else {
      toast('Heal module not loaded.', 'err', 3000);
    }
  }

  // ---------- REMOVE BACKGROUND (H8-001) ----------
  // One click in the editor footer → bake the current scene to a temp PNG, run
  // the bundled IS-Net/BiRefNet background remover, reload the transparent
  // result as the new base. Mirrors runHeal's flow but with no options dialog
  // (model/useGpu come from the same preference chain the pipeline uses).
  // Single-flight (button disabled while running), undo snapshot pushed BEFORE
  // the base swap (H8-001 fix), and the footer format flips to PNG if it was
  // JPEG so Save doesn't flatten the new transparency back to white.
  function onRemoveBg(ctrl) {
    const slot = activeSlot(ctrl); if (!slot) return;
    const h = activeSession(ctrl); if (!h) return;
    if (!window.api || !window.api.isnetbgRun) { toast('Background-removal backend not available.', 'err', 4000); return; }
    if (ctrl._removeBgInFlight) return; // single-flight
    ctrl._removeBgInFlight = true;
    const btn = ctrl.ui && ctrl.ui.removeBgBtn;
    if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
    const prevStatus = ctrl.ui && ctrl.ui.status ? ctrl.ui.status.textContent : '';
    // H11-1C: show a spinner in the status line while bg-removal runs.
    const statusEl = ctrl.ui && ctrl.ui.status;
    if (statusEl) { statusEl.textContent = ''; if (window.Spinner && window.Spinner.busyRow) statusEl.appendChild(window.Spinner.busyRow('Removing background…')); else statusEl.textContent = 'Removing background…'; }
    runRemoveBg(ctrl, slot, h).then((ok) => {
      ctrl._removeBgInFlight = false;
      if (btn) { btn.disabled = false; btn.textContent = '✂ Remove BG'; }
      if (ctrl.ui && ctrl.ui.status) ctrl.ui.status.textContent = prevStatus;
      if (ok) toast('Background removed.', 'ok', 2500);
    }).catch((e) => {
      ctrl._removeBgInFlight = false;
      if (btn) { btn.disabled = false; btn.textContent = '✂ Remove BG'; }
      if (ctrl.ui && ctrl.ui.status) ctrl.ui.status.textContent = prevStatus;
      toast('Remove BG failed: ' + (e && e.message || e), 'err', 6000);
    });
  }

  async function runRemoveBg(ctrl, slot, h) {
    const Heal = window.ImageEditorHeal;
    const Tools = window.ImageEditorTools;
    const s = h.session;
    // PE-010: capture the slot revision BEFORE the await so the result
    // can only commit to the same slot/base it started from (see the
    // guard after the isnetbg run + ctrl._commitHandle routing below).
    const revCap = (Tools && Tools.captureSlotRev) ? Tools.captureSlotRev(slot) : null;
    // Bake current scene → temp source PNG next to the slot's base path.
    // BUG #9 fix (PE-001 migration): the legacy h.toDataURL('png') bake
    // is VPT-aware — with fit-to-container zoom < 1 it bakes the
    // zoom-shrunk/clipped viewport pixels, so bg-removal runs on
    // degraded pixels and the result replaces the base = silent
    // resolution loss. Natural-size temp canvas + dispose-in-finally
    // (mirrors onBake / runHeal).
    const bgTemp = h.session.renderSceneAtNaturalSize();
    let bakedB64;
    try {
      bakedB64 = bgTemp.toDataURL({ format: 'image/png', multiplier: 1 }).split(',')[1];
    } finally {
      try { bgTemp.dispose(); } catch (_) {}
    }
    const sessionKey = slot.id;
    const { path: tmpSrc, grantId: wg } = window.ImageEditorWorkDir
      ? await window.ImageEditorWorkDir.getWorkFilePath(sessionKey, '.ie_bg_src_', '.png')
      : { path: ((window.state && window.state.config && window.state.config.output_dir) ? window.state.config.output_dir : 'image') + '/.ie_bg_src_' + Date.now() + '.png', grantId: undefined };
    const { path: tmpOut } = window.ImageEditorWorkDir
      ? await window.ImageEditorWorkDir.getWorkFilePath(sessionKey, '.ie_bg_out_', '.png')
      : { path: ((window.state && window.state.config && window.state.config.output_dir) ? window.state.config.output_dir : 'image') + '/.ie_bg_out_' + Date.now() + '.png' };
    if (wg && wg.ok === false) throw new Error('removeBg: ' + (wg.error || 'mintGrant failed'));
    const writeTmp = (window.api && window.api.writeImageBase64)
      ? window.api.writeImageBase64(tmpSrc, bakedB64, wg)
      : window.api.fbWrite(tmpSrc, bakedB64, wg);
    await writeTmp;
    // model/useGpu from the same preference chain the pipeline uses.
    const st = (typeof window.state === 'object' && window.state) || {};
    // gewv2 GEW-010 fix: default to the higher-quality bundled model.
    const model = st.removeBackgroundModel || 'birefnet-general-lite';
    const useGpu = st.removeBackgroundUseGpu !== false;
    // PE-015: thread postprocess opts from advanced settings.
    const advBg = (st.pipelineAdvancedSettings && st.pipelineAdvancedSettings.isnetbg) || {};
    const postOpts = {};
    if (advBg.postClean === false) postOpts.postClean = false;
    if (typeof advBg.featherPx === 'number') postOpts.featherPx = advBg.featherPx;
    if (advBg.defringe === false) postOpts.defringe = false;
    if (advBg.refine === false) postOpts.refine = false;
    let r;
    try {
      // R1.5a.follow-up Phase 6: directory-grant on the PARENT of
      // tmpSrc with both 'read' AND 'write' capabilities. The
      // isnetbg handler reads from tmpSrc AND writes to tmpOut
      // (a sibling). A file-grant with 'read' would FAIL the
      // handler's write-check on tmpOut.
      // PRE-1: use window.GrantCache + window.api.pathDirname (no require in sandbox).
      const isnetGrant = window.api && window.api.mintGrant
        ? await window.GrantCache.ensurePathGrant(
            window.api.pathDirname(tmpSrc), 'read',
            { kind: 'directory', capabilities: ['read', 'write'] }
          ) : undefined;
      if (isnetGrant && isnetGrant.ok === false) throw new Error('removeBg: ' + (isnetGrant.error || 'mintGrant failed'));
      r = await window.api.isnetbgRun(tmpSrc, tmpOut, { model, useGpu, ...postOpts }, isnetGrant);
    } finally {
      // BGR-009 fix: mint delete grant (R1.3 gate).
      try { if (window.api && window.api.fbDelete) { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpSrc) : undefined; await window.api.fbDelete(tmpSrc, dg); } } catch (_) {}
    }
    if (!r || !r.ok) {
      // BGR-009 fix: mint delete grant (R1.3 gate).
      try { if (window.api && window.api.fbDelete) { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpOut) : undefined; await window.api.fbDelete(tmpOut, dg); } } catch (_) {}
      // gewv2 GEW-003 fix: isnetbg reports errors via `stderr`, not `error`.
      throw new Error((r && (r.error || r.stderr)) || 'background removal failed');
    }
    // KGO7-010: surface a silent model substitution (one shared impl).
    if (window.Section08Helpers) window.Section08Helpers.warnModelFallback(r);
    // PE-010: slot-revision guard. If the editor closed, the slot
    // vanished, or its base was replaced (revision bumped) while the
    // remover ran, DISCARD the result + temp — the now-active slot must
    // stay byte-identical. The commit below is routed to the captured
    // handle via ctrl._commitHandle.
    if (ctrl.closed || ((Tools && Tools.slotRevValid) ? !Tools.slotRevValid(ctrl, revCap) : ctrl.queue[ctrl.activeIndex] !== slot)) {
      // BGR-009 fix: mint delete grant (R1.3 gate).
      try { if (window.api && window.api.fbDelete) { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpOut) : undefined; await window.api.fbDelete(tmpOut, dg); } } catch (_) {}
      return false;
    }
    // R5.2 Remove BG: H8 fix (pushUndo BEFORE base swap) + R5.2
    // cancel-cleanup. Pre-fix, the pushUndo was unguarded — if
    // reloadBaseFromPath threw, the pre-snapshot was left
    // orphan in the undo stack, and the user had to undo TWICE
    // to get back to the pre-RemoveBG state. Post-R5.2: wrap
    // pushUndo in try/catch (defensive) + add a catch block
    // with cancel-cleanup (pop the pre-snapshot on failure).
    // Same pattern as R5.2 Heal — every H8-fixed callsite-card
    // MUSS auf R5.2 cancel-cleanup upgraded werden
    // (PE-005-Pixelvertrag).
    let pushedPreSnapshot = false;
    try {
      // Undo snapshot BEFORE the base swap (H8-001 fix).
      try {
        if (Tools && typeof Tools.pushUndo === 'function') {
          Tools.pushUndo(s);
          pushedPreSnapshot = true;
        }
      } catch (_) { /* defensive: pre-snapshot push failed — proceed without undo for this remove-bg */ }
      // PE-010: route the reload to the CAPTURED session (not whichever
      // canvas is active now) so the result lands on the right slot.
      ctrl._commitHandle = h;
      // gewv2 GEW-003 fix: isnetbg returns { ok, code, stderr, outputPath },
      // not `path`. r.path was always undefined, so the reload always failed
      // with "Failed to load image: undefined" despite the removal succeeding.
      if (Heal && Heal.reloadBaseFromPath) await Heal.reloadBaseFromPath(ctrl, r.outputPath || tmpOut);
      ctrl._commitHandle = null;
      slot.modified = true;
      if (Tools && Tools.bumpSlotRev) Tools.bumpSlotRev(slot); // PE-010: base replaced
      if (window.ImageEditorSource) window.ImageEditorSource.refreshQueueBar(ctrl);
      // Transparency was clearly intended: flip the format to PNG if it was JPEG.
      if (ctrl.prefs.outFormat === 'jpeg') {
        ctrl.prefs.outFormat = 'png';
        if (ctrl.ui && ctrl.ui.formatSel) ctrl.ui.formatSel.value = 'png';
      }
      // BGR-009 fix: mint delete grant (R1.3 gate).
      try { if (window.api && window.api.fbDelete) { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpOut) : undefined; await window.api.fbDelete(tmpOut, dg); } } catch (_) {}
      return true;
    } catch (e) {
      // R5.2 Remove BG: cancel-cleanup. If we pushed the
      // pre-snapshot but reloadBaseFromPath or any subsequent
      // step threw, pop the pre-snapshot so the undo stack
      // stays consistent. Wrapped in try/catch defensive
      // (per R5.2 Transform.AuditFix P-R52T-F1 pattern).
      if (pushedPreSnapshot) {
        try {
          if (s && Array.isArray(s._undo) && s._undo.length) {
            s._undo.pop();
          }
        } catch (_) { /* defensive: malformed _undo shouldn't crash the catch */ }
        pushedPreSnapshot = false;
      }
      ctrl._commitHandle = null; // PE-010: clear commit routing on failure
      // gewv2 GEW-008 fix: if reloadBaseFromPath (or any step after the
      // successful isnetbg run) throws, tmpOut was never cleaned up by the
      // earlier success-path delete (line ~486, which is skipped when we
      // land here) — delete it now so a genuine post-removal failure
      // doesn't leave `.ie_bg_out_*.png` litter in the output folder.
      try { if (window.api && window.api.fbDelete) { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpOut) : undefined; await window.api.fbDelete(tmpOut, dg); } } catch (_) {}
      throw e;  // re-throw so the caller can handle
    }
  }

  function dirnameOf(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    return slash >= 0 ? norm.slice(0, slash) : '.';
  }

  // ---------- EXTERNAL EDITOR HAND-OFF ----------
  // PE-030: Open-in sends the CURRENT scene (baked to a temp PNG so unsaved
  // paint/composite edits are included), lets the user pick a tool when
  // multiple are configured, and checks {ok:false} results.
  // Falls back to slot.path when there's no session (image not loaded yet).
  async function onExternal(ctrl) {
    const slot = activeSlot(ctrl); if (!slot) return;
    const h = activeSession(ctrl);
    // External tools live under config.external_tools (the same canonical path
    // the file-browser context menu + Pipeline card read). Reading them from
    // the state root (window.state.external_tools) always returned [] and made
    // the editor's hand-off dead even with a configured tool (H7-017).
    const tools = (window.state && window.state.config && window.state.config.external_tools) || [];
    if (!tools || !tools.length) { toast('No external editor configured. Add one in Settings.', 'warn', 4000); return; }
    // Helper: run the tool(s) on a path.
    const doOpen = (path) => {
      const runTool = async (tool) => {
        try {
          // R1.5b.2: mint a read grant for the file before handing off.
          const grantId = (window.GrantHelper) ? await window.GrantHelper.ensureExternalToolRead([path]) : undefined;
          if (grantId && grantId.ok === false) {
            toast('External editor failed: ' + (grantId.error || 'grant error'), 'err', 5000);
            return;
          }
          const r = await window.api.externalToolsRun({ name: tool.name, paths: [path] }, grantId);
          // PE-030: check {ok:false} results (not just thrown errors).
          if (r && r.ok === false) toast('External editor failed: ' + (r.error || 'unknown error'), 'err', 5000);
        } catch (e) { toast('External editor failed: ' + (e && e.message || e), 'err', 5000); }
      };
      if (tools.length === 1) {
        runTool(tools[0]);
      } else {
        // PE-030: show a picker when multiple tools are configured.
        showModal((m, close) => {
          m.style.width = 'min(320px, 92vw)';
          m.appendChild(el('h2', {}, '🔧 Open in…'));
          tools.forEach((tool) => {
            const b = el('button', { class: 'ie-btn', style: 'width:100%;text-align:left;margin-bottom:6px;' }, tool.name);
            b.addEventListener('click', () => { close(); runTool(tool); });
            m.appendChild(b);
          });
          m.appendChild(el('div', { class: 'footer' }, [el('button', { onclick: close }, 'Cancel')]));
        }, { id: 'ie-ext-picker' });
      }
    };
    // PE-030: if there's a session, bake the current scene to a temp PNG so
    // unsaved edits are included. Otherwise fall back to slot.path.
    if (!h || !h.session) {
      doOpen(slot.path);
      return;
    }
    let temp;
    try {
      temp = h.session.renderSceneAtNaturalSize();
      const bakedB64 = temp.toDataURL({ format: 'image/png', multiplier: 1 }).split(',')[1];
      const { path: tmpPath, grantId: wg } = window.ImageEditorWorkDir
        ? await window.ImageEditorWorkDir.getWorkFilePath(slot.id, '.ie_ext_', '.png')
        : { path: ((window.state && window.state.config && window.state.config.output_dir) ? window.state.config.output_dir : 'image') + '/.ie_ext_' + Date.now() + '.png', grantId: undefined };
      if (wg && wg.ok === false) throw new Error('bake: ' + (wg.error || 'mintGrant failed'));
      // R4: writeImageBase64 returns an {ok:false} envelope (does NOT throw) — check it
      // so doOpen never opens a temp file that was never written.
      const wtmp = await window.api.writeImageBase64(tmpPath, bakedB64, wg);
      if (!wtmp || wtmp.ok === false) throw new Error('bake: ' + ((wtmp && wtmp.error) || 'temp write failed'));
      doOpen(tmpPath);
    } catch (e) {
      toast('Open-in failed: ' + (e && e.message || e), 'err', 5000);
    } finally {
      try { temp && temp.dispose(); } catch (_) {}
    }
  }

  function dirnameOf(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    return slash >= 0 ? norm.slice(0, slash) : '.';
  }

  // ---------- small helpers (kept here to avoid a circular dep on the overlay) ----------
  function activeSlot(ctrl) { return ctrl.queue[ctrl.activeIndex]; }
  function activeSession(ctrl) {
    const slot = ctrl.queue[ctrl.activeIndex];
    return slot && slot.handle ? slot.handle : null;
  }
  function refreshQueueBarSafe(ctrl) {
    if (window.ImageEditorSource && window.ImageEditorSource.refreshQueueBar) {
      window.ImageEditorSource.refreshQueueBar(ctrl);
    }
  }

  window.ImageEditorActions = {
    onSave, onBake, onHeal, onRemoveBg, onExternal,
    canvasHasAlpha, flattenOntoMatte, derivedEditedPath, mimeForFmt, nextFreeVersion,
  };
})();
