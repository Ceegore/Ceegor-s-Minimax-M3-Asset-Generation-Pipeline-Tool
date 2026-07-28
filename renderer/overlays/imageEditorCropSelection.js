// renderer/overlays/imageEditorCropSelection.js (pixel editor)
// 1:1 image selection cropping helper module.

(function () {
  'use strict';

  function canCrop(ctrl) {
    if (!ctrl || !Array.isArray(ctrl.queue) || ctrl.activeIndex < 0) return false;
    const slot = ctrl.queue[ctrl.activeIndex];
    if (!slot || !slot.session || !slot.session.imgW || !slot.session.imgH) return false;
    const sel = slot._healSelVisible || (window.ImageEditorHeal && window.ImageEditorHeal.getSelection(slot.session));
    if (!sel || !sel.w || !sel.h) return false;
    // Reject full-canvas rectangle as no-op
    if (sel.x <= 0 && sel.y <= 0 && sel.w >= slot.session.imgW && sel.h >= slot.session.imgH) return false;
    return true;
  }

  function syncButton(ctrl) {
    if (!ctrl || !ctrl.ui || !ctrl.ui.cropSelectionBtn) return;
    const active = canCrop(ctrl);
    ctrl.ui.cropSelectionBtn.disabled = !active;
  }

  function confirmCrop(ctrl) {
    if (!canCrop(ctrl)) {
      if (typeof toast === 'function') toast('Make a selection first.', 'info', 3000);
      return;
    }
    const slot = ctrl.queue[ctrl.activeIndex];
    const sel = slot._healSelVisible || (window.ImageEditorHeal && window.ImageEditorHeal.getSelection(slot.session));
    if (!sel) return;

    const imgW = slot.session.imgW;
    const imgH = slot.session.imgH;

    const x = Math.max(0, Math.min(imgW - 1, Math.round(sel.x)));
    const y = Math.max(0, Math.min(imgH - 1, Math.round(sel.y)));
    const w = Math.min(imgW - x, Math.max(1, Math.round(sel.w)));
    const h = Math.min(imgH - y, Math.max(1, Math.round(sel.h)));

    const capturedSlotId = slot.id;
    const capturedRev = slot.revision || 0;

    if (typeof showModal === 'function') {
      showModal((m, close) => {
        m.appendChild(el('h2', {}, '✂ Crop selection'));
        m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 13px; margin: 12px 0; white-space: pre-line;' },
          `Crop base image to ${w}×${h} pixels?\nVisible edits and placed objects will be flattened into the cropped base.`));
        m.appendChild(el('div', { class: 'footer', style: 'display: flex; justify-content: flex-end; gap: 8px;' }, [
          el('button', { onclick: close }, 'Cancel'),
          el('button', {
            class: 'primary',
            onclick: () => {
              close();
              executeCrop(ctrl, slot, capturedSlotId, capturedRev, x, y, w, h);
            }
          }, 'Crop')
        ]));
      });
    } else {
      executeCrop(ctrl, slot, capturedSlotId, capturedRev, x, y, w, h);
    }
  }

  async function executeCrop(ctrl, slot, capturedSlotId, capturedRev, x, y, w, h) {
    if (ctrl.queue[ctrl.activeIndex] !== slot || slot.id !== capturedSlotId || (slot.revision || 0) !== capturedRev) {
      return;
    }

    let tempScene = null;
    let undoPushed = false;
    // KGO-005 fix: hoist snap out of try so it's in scope in the catch block.
    let snap = null;
    try {
      // 1. Render complete current scene at natural size without helper/selection overlays (EFH-003)
      tempScene = (slot.session && typeof slot.session.renderSceneAtNaturalSize === 'function')
        ? slot.session.renderSceneAtNaturalSize()
        : null;

      const sourceCanvasEl = tempScene
        ? (tempScene.lowerCanvasEl || tempScene.getElement())
        : (slot.session.canvas.toCanvasElement ? slot.session.canvas.toCanvasElement(1) : slot.session.canvas.getElement());

      if (!sourceCanvasEl) throw new Error('Could not render natural scene.');

      // 2. Crop 1:1 into new canvas
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = w;
      cropCanvas.height = h;
      const ctx = cropCanvas.getContext('2d');
      ctx.drawImage(sourceCanvasEl, x, y, w, h, 0, 0, w, h);
      const dataUrl = cropCanvas.toDataURL('image/png');

      if (tempScene && typeof tempScene.dispose === 'function') {
        try { tempScene.dispose(); tempScene = null; } catch (_) {}
      }

      // 3. Push undo snapshot BEFORE mutating state
      // EFH2-005 fix: capture our own snapshot for rollback (popUndo doesn't exist).
      snap = (window.ImageEditorTools && typeof window.ImageEditorTools.snapshot === 'function')
        ? window.ImageEditorTools.snapshot(slot.session) : null;
      if (window.ImageEditorTools && typeof window.ImageEditorTools.pushUndo === 'function') {
        window.ImageEditorTools.pushUndo(slot.session);
        undoPushed = true;
      }

      // 4. Install cropped image as base via Fabric v6 Promise API
      const fabric = slot.session.fabric;
      const img = await fabric.Image.fromURL(dataUrl, { crossOrigin: 'anonymous' });
      // QA-003 fix: also check the slot revision after the await so a stale
      // crop result cannot overwrite a newer edit that advanced the revision.
      if (ctrl.queue[ctrl.activeIndex] !== slot || slot.id !== capturedSlotId || (slot.revision || 0) !== capturedRev) return;

      slot.session.canvas.clear();
      slot.session.imgW = w;
      slot.session.imgH = h;
      if (slot.session.canvas.setDimensions) {
        slot.session.canvas.setDimensions({ width: w, height: h });
      }

      img.set({
        left: 0,
        top: 0,
        selectable: false,
        evented: false,
        __baseId: 'base-' + Date.now(),
      });
      slot.session.canvas.add(img);
      // EFH-002: Fabric v6 uses canvas.sendObjectToBack(img) (img.sendToBack was removed in Fabric v6)
      if (typeof slot.session.canvas.sendObjectToBack === 'function') {
        slot.session.canvas.sendObjectToBack(img);
      }
      slot.session.baseObject = img;

      // Clear selection rect & store
      if (slot._healRect) {
        try { slot.session.canvas.remove(slot._healRect); } catch (_) {}
        slot._healRect = null;
      }
      if (window.ImageEditorHeal) window.ImageEditorHeal.setSelection(slot.session, null);
      slot._healSelVisible = null;
      if (window.ImageEditorSelect && typeof window.ImageEditorSelect.updateSelectionChip === 'function') {
        window.ImageEditorSelect.updateSelectionChip(ctrl, null);
      }

      // KGO-001 fix: reset the viewport transform to identity BEFORE fitActive()
      // so the cropped image is visible (the old pan/zoom would draw it off-canvas).
      if (slot.session.canvas.setViewportTransform) {
        slot.session.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
      }
      if (slot.handle && typeof slot.handle.setZoom === 'function') slot.handle.setZoom(1);
      if (typeof ctrl.fitActive === 'function') {
        ctrl.fitActive();
      }
      slot.modified = true;
      slot.revision = (slot.revision || 0) + 1;
      if (typeof ctrl.updateFooterStatus === 'function') ctrl.updateFooterStatus();
      // KGO-011 fix: refresh the editor header so it shows the new dimensions.
      if (window.ImageEditorOverlay && typeof window.ImageEditorOverlay.refreshMeta === 'function') {
        window.ImageEditorOverlay.refreshMeta(ctrl);
      }
      syncButton(ctrl);
    } catch (err) {
      if (tempScene && typeof tempScene.dispose === 'function') {
        try { tempScene.dispose(); } catch (_) {}
      }
      // EFH2-005 fix: restore the captured snapshot instead of calling the
      // non-existent popUndo. Pop the entry pushUndo added, then restore.
      if (undoPushed && snap && window.ImageEditorTools && typeof window.ImageEditorTools.restore === 'function') {
        try {
          slot.session._undo.pop();
          await window.ImageEditorTools.restore(slot.session, snap);
        } catch (_) {}
      }
      if (typeof toast === 'function') toast('Crop failed: ' + ((err && err.message) || err), 'err');
    }
  }

  window.ImageEditorCropSelection = {
    canCrop,
    syncButton,
    confirmCrop,
  };
})();
