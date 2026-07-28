// renderer/overlays/imageEditorResize.js
// The "📐 Resize canvas" section in the image editor's right-side (source) tray.
// This is where resize is most relevant: the user is actively editing and wants
// to change the working resolution.
//
// Behaviour mirrors the other resize surfaces (Pipeline Resize column, right-
// click overlay): GIMP/Photoshop 🔗 chain-link aspect ratio, Lanczos3 resampling
// via createImageBitmap({resizeQuality:'high'}) (Chromium's Lanczos). The
// resize applies to the ACTUAL editable canvas (not just the export) so
// subsequent edits are at the new resolution — implemented by re-rendering the
// scene, rebuilding the fabric canvas at the target dims, and pushing one undo
// step so the user can revert.
//
// On a large enlargement (>120% on either axis) the shared warning popup offers
// the dedicated Upscale (Real-ESRGAN) instead, via the active slot's on-disk
// path.

(function () {
  'use strict';
  const AL = () => window.AspectLink;

  // Build the resize section DOM + wire it. Returns the container element.
  // `ctrl` is the editor controller (imageEditorOverlay.newController()).
  function buildSection(ctrl) {
    const box = el('div', { class: 'ie-resize-section', style: 'margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-2);' });
    box.appendChild(el('div', { class: 'ie-section-label' }, '📐 Resize canvas'));

    // KGO8-004: bounded — see src/imageResize.js for the total-pixel ceiling.
    const wInput = el('input', { type: 'number', min: '1', max: '65500', step: '1', placeholder: 'W' });
    const hInput = el('input', { type: 'number', min: '1', max: '65500', step: '1', placeholder: 'H' });
    wInput.style.width = hInput.style.width = '64px';

    // Seed the inputs from the active session dims (updated by refreshDims).
    const chain = AL().buildChainToggle(true, (linked) => {
      if (linked && Number(wInput.value) > 0) {
        const d = currentDims(ctrl);
        const p = AL().linkedPair(d, 'w', Number(wInput.value));
        hInput.value = p.height || '';
      }
    });
    wInput.addEventListener('input', () => {
      if (chain.linked) {
        const d = currentDims(ctrl);
        const p = AL().linkedPair(d, 'w', Number(wInput.value));
        hInput.value = p.height || '';
      }
    });
    hInput.addEventListener('input', () => {
      if (chain.linked) {
        const d = currentDims(ctrl);
        const p = AL().linkedPair(d, 'h', Number(hInput.value));
        wInput.value = p.width || '';
      }
    });

    const applyBtn = el('button', { class: 'ie-btn', title: 'Resize the canvas to the target resolution' }, 'Apply');
    const dimsRow = el('div', { style: 'display:flex; align-items:center; gap:4px; margin-top:4px;' },
      [wInput, chain, hInput, el('span', { class: 'meta', style: 'font-size:10px; color:var(--fg-3);' }, 'px')]);
    box.appendChild(dimsRow);
    box.appendChild(el('div', { style: 'margin-top:4px;' }, [applyBtn]));

    // Pre-fill from the active session when it becomes available / changes.
    function refreshDims() {
      const d = currentDims(ctrl);
      if (d.w && d.h) {
        wInput.value = String(d.w);
        hInput.value = String(d.h);
        wInput.placeholder = String(d.w);
        hInput.placeholder = String(d.h);
      }
    }
    box.refreshDims = refreshDims;
    refreshDims();

    applyBtn.addEventListener('click', () => onApply(ctrl, wInput, hInput, chain, applyBtn, refreshDims));
    return box;
  }

  function activeSlot(ctrl) {
    if (typeof window.ImageEditorActions === 'object' && window.ImageEditorActions && typeof window.ImageEditorActions.activeSlot === 'function') {
      return window.ImageEditorActions.activeSlot(ctrl);
    }
    if (!ctrl || !Array.isArray(ctrl.queue) || ctrl.activeIndex < 0) return null;
    return ctrl.queue[ctrl.activeIndex] || null;
  }

  function currentDims(ctrl) {
    const slot = activeSlot(ctrl);
    if (slot && slot.session) return { w: slot.session.imgW || 0, h: slot.session.imgH || 0 };
    return { w: 0, h: 0 };
  }

  // The core resize: render the current scene at natural resolution, resample
  // to the target via the high-quality createImageBitmap path, then rebuild the
  // fabric canvas at the new size with the resampled image as the (locked)
  // base layer. Pushes one undo step so Edit→Undo reverts the whole resize.
  async function onApply(ctrl, wInput, hInput, chain, applyBtn, refreshDims) {
    const slot = activeSlot(ctrl);
    if (!slot || !slot.handle || !slot.session) {
      toast('Open an image first.', 'warn', 2500);
      return;
    }
    const tw = Math.max(0, Math.floor(Number(wInput.value) || 0));
    const th = Math.max(0, Math.floor(Number(hInput.value) || 0));
    if (!tw || !th) { toast('Enter a target width and height.', 'warn', 2500); return; }

    const src = currentDims(ctrl);
    // Large-enlargement warning (offer the dedicated Upscale instead).
    if (window.ResizeUpscaleDialog) {
      const choice = await window.ResizeUpscaleDialog.maybeWarnUpscale({
        srcW: src.w, srcH: src.h, targetW: tw, targetH: th, srcPath: slot.path,
      });
      if (choice !== 'proceed') return;
    }

    applyBtn.disabled = true;
    applyBtn.textContent = 'Resizing…';
    let pushedPreSnapshot = false;
    let session;
    try {
      session = slot.session;
      // R5.2 Resize: pre-snapshot is pushed ONLY when we are about to mutate
      // the canvas (right before `canvas.clear()`). Pushing at the start of
      // the try block — as the Pre-fix code did — would leave a useless
      // pre-snapshot in the undo stack if `renderSceneAtNaturalSize`,
      // `createImageBitmap`, or `loadBaseImage` threw before the swap
      // completed. The user would have to undo twice to get back to the
      // pre-resize state. Track the push with a flag so the catch path can
      // pop the pre-snapshot if the mutation itself throws (defensive
      // cancel-cleanup per R5.2.AuditFix P-R52T-F1 / R5.2 Stroke pattern).
      // Post-R5.2: pre-snapshot right before the mutation + cancel-cleanup
      // in catch (PE-005-Pixelvertrag).

      // 2. Render the full scene (base + edits + placed objects) at natural
      //    resolution to a canvas element.
      // R4.2.follow-up (PE-001 + PE-005 migration): the original code
      // called `session.toCanvasElement()` which (a) was on the
      // wrong object — `toCanvasElement` lives on the HANDLE, not
      // on the inner `session` (PE-005: TypeError); and (b) even
      // if it were defined, it would honour the live canvas's VPT
      // and produce a zoom/pan-corrupted canvas (PE-001). Use
      // `renderSceneAtNaturalSize` + `temp.toCanvasElement(1)` to
      // render at natural dimensions with identity VPT.
      // R4.2.follow-up.AuditFix P-R42FU-03: wrap temp in try/finally
      // so a throw from `temp.toCanvasElement(1)` (corrupt/empty
      // temp) doesn't leak the temp canvas. The previous code had
      // `try { temp.dispose(); }` AFTER toCanvasElement(1), so a
      // throw from toCanvasElement skipped the dispose.
      // NOTE: dispose is intentionally AFTER srcCanvas is captured
      // and BEFORE createImageBitmap runs — the returned srcCanvas
      // is an independent HTMLCanvasElement (Fabric's toCanvasElement
      // creates a new canvas, draws the scene, and returns it), so
      // disposing the source temp doesn't affect the returned canvas.
      let temp;
      let srcCanvas = null;
      try {
        temp = session.renderSceneAtNaturalSize();
        srcCanvas = temp.toCanvasElement(1);
        temp && temp.dispose();
        temp = null; // mark as disposed so the finally block is a no-op
      } finally { try { temp && temp.dispose(); } catch (_) {} }

      // 3. High-quality resample. createImageBitmap with resizeQuality:'high'
      //    uses Chromium's Lanczos resampler — the same family the main-process
      //    Sharp path uses. Fall back to a manual canvas draw at high smoothing
      //    quality if the runtime lacks createImageBitmap.
      let targetCanvas;
      if (typeof createImageBitmap === 'function') {
        try {
          const bmp = await createImageBitmap(srcCanvas, {
            resizeWidth: tw, resizeHeight: th, resizeQuality: 'high',
          });
          targetCanvas = document.createElement('canvas');
          targetCanvas.width = tw; targetCanvas.height = th;
          targetCanvas.getContext('2d').drawImage(bmp, 0, 0);
          if (bmp.close) try { bmp.close(); } catch (_) {}
        } catch (_) { targetCanvas = null; }
      }
      if (!targetCanvas) {
        targetCanvas = document.createElement('canvas');
        targetCanvas.width = tw; targetCanvas.height = th;
        const ctx = targetCanvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(srcCanvas, 0, 0, tw, th);
      }

      // 4. Build the NEW base image FIRST (before clearing). Constructing it
      //    before the swap means a throw leaves the canvas untouched; clearing
      //    + resizing first would leave the session corrupted if construction
      //    failed (new dims, destroyed base, no undo).
      const fabric = window.ImageEditorCanvas.requireFabric();
      const newBase = await loadBaseImage(fabric, targetCanvas);
      newBase.set({ selectable: false, evented: false, hoverCursor: 'default' });

      // 4b. R5.2 Resize: pre-snapshot right before the mutation. Pre-R5.2
      //    pushed at the start of the try block which left an orphan
      //    pre-snapshot if async work (renderScene / createImageBitmap /
      //    loadBaseImage) threw. Post-R5.2: push here, after all async
      //    work has succeeded, so the pre-snapshot is consumed atomically
      //    with the swap. If the swap itself throws, the catch path
      //    pops the pre-snapshot (cancel-cleanup) so the undo stack stays
      //    consistent. Wrapped in try/catch defensive (per R5.2 pattern).
      try {
        if (window.ImageEditorTools && typeof window.ImageEditorTools.pushUndo === 'function') {
          window.ImageEditorTools.pushUndo(session);
          pushedPreSnapshot = true;
        }
      } catch (_) { /* defensive: pre-snapshot push failed — proceed without undo for this resize */ }

      // 5. Now swap: clear the old canvas, resize the surface, add the new base.
      session.canvas.clear();
      session.canvas.setDimensions({ width: tw, height: th });
      session.imgW = tw; session.imgH = th;
      session.canvas.add(newBase);
      session.canvas.sendObjectToBack(newBase);
      session.baseObject = newBase;
      if (slot) slot.modified = true;

      // 6. Fit the new canvas into the viewport + refresh the header meta.
      if (typeof ctrl.fitActive === 'function') ctrl.fitActive();
      try {
        if (window.ImageEditorOverlay && typeof window.ImageEditorOverlay.refreshMeta === 'function') {
          window.ImageEditorOverlay.refreshMeta(ctrl);
        }
      } catch (_) {}
      refreshDims();
      toast('Canvas resized to ' + tw + '×' + th + '.', 'ok', 2500);
    } catch (e) {
      // R5.2 Resize: cancel-cleanup. If we pushed the pre-snapshot but the
      // mutation (canvas.clear / setDimensions / add / sendObjectToBack /
      // baseObject / slot.modified) threw, the undo stack has an entry
      // that doesn't correspond to an actual resize — pop it so the user
      // doesn't have to undo twice. Wrapped in try/catch defensive (per
      // R5.2 Transform.AuditFix P-R52T-F1 pattern).
      if (pushedPreSnapshot) {
        try {
          if (session && Array.isArray(session._undo) && session._undo.length) {
            session._undo.pop();
          }
        } catch (_) { /* defensive: malformed _undo shouldn't crash the catch */ }
        pushedPreSnapshot = false;
      }
      toast('Resize failed: ' + ((e && e.message) || e), 'err', 5000);
    } finally {
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply';
    }
  }

  // Load a pre-rendered canvas into a locked fabric.Image. The established
  // pattern in this editor (imageEditorCanvas.setBaseImage, imageEditorActions
  // .onBake, imageEditorHeal) is fabric.Image.fromURL(dataURL) — fabric v6
  // returns a Promise from fromURL. Reuse that exact path (canvas → dataURL
  // → fromURL) rather than `new fabric.Image(canvasEl, {})` so the construction
  // matches every other base-image load and can't drift on a fabric API change.
  function loadBaseImage(fabric, canvasEl) {
    const dataUrl = canvasEl.toDataURL('image/png');
    return fabric.Image.fromURL(dataUrl, { crossOrigin: 'anonymous' });
  }

  function toast(msg, kind, ms) {
    if (typeof window.toast === 'function') window.toast(msg, kind, ms);
  }

  window.ImageEditorResize = { buildSection };
})();
