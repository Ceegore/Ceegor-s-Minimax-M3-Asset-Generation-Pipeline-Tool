// renderer/overlays/imageEditorSelect.js (pixel editor)
// Selection-drag + the persistent "marching ants" selection (H8-005), plus the
// footer "Selection: W×H (Clear)" chip. Extracted from imageEditorOverlay.js so
// the overlay stays under the 500-line lint cap.
//
// Two consumers start a drag:
//   - the heal tool (autoPopover:true → opens the Heal popover on commit)
//   - the dedicated select tool (autoPopover:false → selection persists)
// Both run through the same scene-coordinate code path (H8-007 fix).
//
// Depends on globals: el/$ (DomHelpers), window.ImageEditorTools.scenePointOf,
// window.ImageEditorHeal (selection store + popover).

(function () {
  'use strict';

  // activeSlotOf: ctrl → the currently-active queue slot. Kept as a parameter so
  // this module doesn't reach into the overlay's internals; the overlay passes a
  // tiny accessor when wiring events.
  // startMarqueeDrag(ctrl, slot, startScene, opts, activeSlotOf)
  //   - ctrl:    the editor controller (has .ui, .queue, .activeIndex)
  //   - slot:    the queue slot whose canvas we drag on
  //   - startScene: {x,y} in SCENE (image-pixel) coordinates
  //   - opts:    { autoPopover: bool }
  //   - activeSlotOf: () => active slot (for the chip's Clear handler)
  function startMarqueeDrag(ctrl, slot, startScene, opts, activeSlotOf) {
    opts = opts || {};
    const fabric = slot.session.fabric;
    const canvas = slot.session.canvas;
    const Tools = window.ImageEditorTools;
    const sceneOf = (opt) => Tools.scenePointOf(canvas, opt, slot.session.imgW, slot.session.imgH);
    if (slot._healRect) canvas.remove(slot._healRect);
    const persistent = !opts.autoPopover;
    const rect = new fabric.Rect({
      left: startScene.x, top: startScene.y,
      width: 0, height: 0,
      fill: persistent ? 'rgba(77,154,255,0.10)' : 'rgba(77,154,255,0.15)',
      stroke: '#4d9aff', strokeWidth: 1,
      strokeDashArray: persistent ? [4, 4] : null,
      strokeUniform: true, selectable: false, evented: false,
      excludeFromExport: true, // H8-005: never bake/export the selection outline
    });
    canvas.add(rect);
    slot._healRect = rect;
    const startX = startScene.x, startY = startScene.y;
    // STD-SEL-01: Shift constrains the marquee to a square (Photoshop/GIMP/
    // Krita convention). Alt draws from the center out. Both read the live
    // modifier state off the original DOM event Fabric forwards as opt.e.
    const onMove = (opt) => {
      const p = sceneOf(opt);
      let w = p.x - startX, h = p.y - startY;
      const ev = opt && opt.e;
      if (ev && ev.shiftKey) {
        const m = Math.max(Math.abs(w), Math.abs(h));
        w = m * (w < 0 ? -1 : 1);
        h = m * (h < 0 ? -1 : 1);
      }
      if (ev && ev.altKey) { w *= 2; h *= 2; }
      rect.set({ left: w < 0 ? startX + w : startX, top: h < 0 ? startY + h : startY,
        width: Math.abs(w), height: Math.abs(h) });
      canvas.requestRenderAll();
    };
    const onUp = (opt) => {
      canvas.off('mouse:move', onMove);
      canvas.off('mouse:up', onUp);
      const p = opt ? sceneOf(opt) : { x: startX, y: startY };
      let w = p.x - startX, h = p.y - startY;
      const ev = opt && opt.e;
      if (ev && ev.shiftKey) {
        const m = Math.max(Math.abs(w), Math.abs(h));
        w = m * (w < 0 ? -1 : 1);
        h = m * (h < 0 ? -1 : 1);
      }
      if (ev && ev.altKey) { w *= 2; h *= 2; }
      w = Math.abs(w); h = Math.abs(h);
      // Min-drag threshold (H8-007): < 3px scene-distance is a click, not a drag.
      if (w < 3 && h < 3) {
        canvas.remove(rect);
        slot._healRect = null;
        slot._healSelVisible = null; // PE-033: clear all three atomically
        if (window.ImageEditorHeal) window.ImageEditorHeal.setSelection(slot.session, null);
        updateSelectionChip(ctrl, null);
        return;
      }
      const sel = {
        x: Math.round(Math.min(rect.left, rect.left + rect.width)),
        y: Math.round(Math.min(rect.top, rect.top + rect.height)),
        w: Math.max(1, Math.round(rect.width)),
        h: Math.max(1, Math.round(rect.height)),
      };
      if (window.ImageEditorHeal) window.ImageEditorHeal.setSelection(slot.session, sel);
      slot._healSelVisible = sel;
      updateSelectionChip(ctrl, sel, activeSlotOf);
      if (opts.autoPopover && window.ImageEditorHeal) {
        window.ImageEditorHeal.openPopover(ctrl, 'selection');
      }
    };
    canvas.on('mouse:move', onMove);
    canvas.on('mouse:up', onUp);
  }

  // Footer "Selection: W×H (Clear)" chip (H8-005). Visible only when a
  // persistent selection exists; clicking Clear drops it.
  function updateSelectionChip(ctrl, sel, activeSlotOf) {
    if (window.ImageEditorCropSelection) window.ImageEditorCropSelection.syncButton(ctrl);
    const ui = ctrl && ctrl.ui;
    if (!ui || !ui.status) return;
    if (!sel) {
      if (ui._selClear) { try { ui._selClear.remove(); } catch (_) {} ui._selClear = null; }
      return;
    }
    if (!ui._selClear) {
      const chip = el('button', { class: 'ie-btn ie-sel-chip', title: 'Clear the current selection' }, '');
      chip.addEventListener('click', () => {
        const slot = activeSlotOf ? activeSlotOf() : null;
        if (slot && slot._healRect) { try { slot.session.canvas.remove(slot._healRect); } catch (_) {} slot._healRect = null; }
        if (slot && window.ImageEditorHeal) window.ImageEditorHeal.setSelection(slot.session, null);
        if (slot) slot._healSelVisible = null;
        updateSelectionChip(ctrl, null, activeSlotOf);
      });
      try { ui.status.parentNode.insertBefore(chip, ui.status); } catch (_) {}
      ui._selClear = chip;
    }
    ui._selClear.textContent = '▭ ' + sel.w + '×' + sel.h + ' ✕';
  }

  // Clear selection rects on every slot except the one about to become active
  // (H8-005 §5: a selection belongs to one image).
  function clearSelectionExcept(ctrl, keepSlot) {
    for (const s of ctrl.queue) {
      if (s === keepSlot) continue;
      if (s._healRect) {
        try { s.session.canvas.remove(s._healRect); } catch (_) {}
        s._healRect = null;
      }
      if (window.ImageEditorHeal) window.ImageEditorHeal.setSelection(s.session, null);
    }
  }

  // ---- STD-SEL: standard selection commands (Photoshop/GIMP/Krita parity) ----
  // Draw (or clear) the persistent "marching-ants" rectangle for a slot from a
  // {x,y,w,h} sel object. Mirrors the rectangle styling startMarqueeDrag uses
  // for the dedicated select tool so Select All / nudge look identical to a
  // hand-dragged box.
  function drawSelectionRect(slot, sel) {
    if (!slot || !slot.session) return null;
    const fabric = slot.session.fabric;
    const canvas = slot.session.canvas;
    if (slot._healRect) { try { canvas.remove(slot._healRect); } catch (_) {} slot._healRect = null; }
    if (!sel) return null;
    const rect = new fabric.Rect({
      left: sel.x, top: sel.y, width: sel.w, height: sel.h,
      fill: 'rgba(77,154,255,0.10)', stroke: '#4d9aff', strokeWidth: 1,
      strokeDashArray: [4, 4], strokeUniform: true,
      selectable: false, evented: false, excludeFromExport: true,
    });
    canvas.add(rect);
    slot._healRect = rect;
    return rect;
  }

  function commitSelection(ctrl, slot, sel, activeSlotOf) {
    drawSelectionRect(slot, sel);
    if (window.ImageEditorHeal) window.ImageEditorHeal.setSelection(slot.session, sel);
    slot._healSelVisible = sel;
    updateSelectionChip(ctrl, sel, activeSlotOf || (() => slot));
    try { slot.session.canvas.requestRenderAll(); } catch (_) {}
  }

  // Ctrl+A — select the whole image.
  function selectAll(ctrl, slot, activeSlotOf) {
    if (!slot || !slot.session) return false;
    const s = slot.session;
    const sel = { x: 0, y: 0, w: Math.max(1, Math.round(s.imgW)), h: Math.max(1, Math.round(s.imgH)) };
    commitSelection(ctrl, slot, sel, activeSlotOf);
    return true;
  }

  // Ctrl+D / Escape — drop the current selection.
  function deselect(ctrl, slot, activeSlotOf) {
    if (!slot || !slot.session) return false;
    commitSelection(ctrl, slot, null, activeSlotOf);
    return true;
  }

  // Arrow keys — nudge the selection by (dx,dy) scene pixels, clamped to the
  // image bounds so the box can never be pushed off-canvas.
  function nudgeSelection(ctrl, slot, dx, dy, activeSlotOf) {
    if (!slot || !slot.session) return false;
    const s = slot.session;
    const cur = (window.ImageEditorHeal && window.ImageEditorHeal.getSelection)
      ? window.ImageEditorHeal.getSelection(s)
      : (slot._healSelVisible || null);
    if (!cur) return false;
    const maxX = Math.max(0, Math.round(s.imgW) - cur.w);
    const maxY = Math.max(0, Math.round(s.imgH) - cur.h);
    const sel = {
      x: Math.round(Math.max(0, Math.min(maxX, cur.x + dx))),
      y: Math.round(Math.max(0, Math.min(maxY, cur.y + dy))),
      w: cur.w, h: cur.h,
    };
    commitSelection(ctrl, slot, sel, activeSlotOf);
    return true;
  }

  // Delete/Backspace — the "cut out" command. Erases the selected rectangle to
  // transparency using a destination-out rect (the same composite operation the
  // eraser brush uses), so it carves through both painted strokes and the base
  // image. Pushes an undo snapshot first so the cut is reversible. The marching
  // ants stay visible afterwards (standard behaviour — the region is still
  // selected, just emptied).
  function clearSelectionToTransparency(ctrl, slot) {
    if (!slot || !slot.session) return false;
    const s = slot.session;
    const sel = (window.ImageEditorHeal && window.ImageEditorHeal.getSelection)
      ? window.ImageEditorHeal.getSelection(s)
      : (slot._healSelVisible || null);
    if (!sel || sel.w < 1 || sel.h < 1) return false;
    const Tools = window.ImageEditorTools;
    if (Tools && typeof Tools.pushUndo === 'function') {
      try { Tools.pushUndo(s); } catch (_) { /* proceed without undo rather than fail the cut */ }
    }
    const fabric = s.fabric;
    const cut = new fabric.Rect({
      left: sel.x, top: sel.y, width: sel.w, height: sel.h,
      fill: 'rgba(0,0,0,1)',
      globalCompositeOperation: 'destination-out',
      selectable: false, evented: false,
    });
    s.canvas.add(cut);
    s.canvas.requestRenderAll();
    slot.modified = true;
    if (window.ImageEditorSource && window.ImageEditorSource.refreshQueueBar) {
      try { window.ImageEditorSource.refreshQueueBar(ctrl); } catch (_) {}
    }
    return true;
  }

  window.ImageEditorSelect = {
    startMarqueeDrag, updateSelectionChip, clearSelectionExcept,
    drawSelectionRect, selectAll, deselect, nudgeSelection, clearSelectionToTransparency,
  };
})();
