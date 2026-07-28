// renderer/overlays/imageEditorSource.js (Feature 5 — pixel editor)
// Right-hand source tray (2nd image for compositing) + objects list + the
// batch-queue filmstrip bar (GIMP-style, §5b).
//
// Extracted from imageEditorOverlay.js to stay under the 500-line lint cap.
// All functions take the controller (ctrl) produced by the overlay.

(function () {
  'use strict';

  function baseName(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    return slash >= 0 ? norm.slice(slash + 1) : norm;
  }
  function fileUrlOf(p) {
    if (window.FileUrl && window.FileUrl.fileUrl) return window.FileUrl.fileUrl(p);
    const enc = encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
    return 'file:///' + (enc.startsWith('/') ? enc.slice(1) : enc);
  }

  // ---------- SOURCE TRAY (compositing) ----------
  function onLoadSource(ctrl) {
    window.api.pickFile({
      title: 'Select source image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    }).then((r) => {
      if (r && r.ok && r.path) loadSourceFromPath(ctrl, r.path);
    });
  }

  function loadSourceFromPath(ctrl, path) {
    ctrl.sourceTrayPath = path;
    // H8-F2: loads go into the Asset panel's secondary canvas when the panel
    // is present (the primary right pane since F2-P1). The legacy thumbnail
    // update below only runs when the panel module failed to load and the
    // old source tray was built as the fallback.
    if (ctrl.assetPanel && window.ImageEditorAssetPanel
        && typeof window.ImageEditorAssetPanel.loadAssetFromPath === 'function') {
      window.ImageEditorAssetPanel.loadAssetFromPath(ctrl, path);
      return;
    }
    const name = baseName(path);
    ctrl.ui.sourceThumb.textContent = '';
    ctrl.ui.sourceThumb.appendChild(el('img', { src: fileUrlOf(path) }));
    loadImageFromFile(path).then((loaded) => {
      ctrl.ui.sourceMeta.textContent = name + ' · ' + loaded.naturalWidth + '×' + loaded.naturalHeight;
    }).catch(() => { ctrl.ui.sourceMeta.textContent = name; });
  }

  // Add the loaded source image to the canvas as a transformable object,
  // centered + scaled to ≤60% of the canvas, selected so the move/scale/rotate
  // handles appear (Photoshop "Place" behaviour).
  //
  // R5.2 Source Add: PRE-SNAPSHOT before canvas.add. Pre-fix, the
  // pushUndo was AFTER canvas.add(fImg), so the pre-snapshot was
  // the post-add state. Undo would pop the post-add state and
  // restore to it (no visible change). The user had to undo TWICE
  // to get back to before the add. Post-R5.2: pushUndo BEFORE
  // canvas.add so a single undo restores the pre-add state (PE-005).
  //
  // PE-028: slot-revision guard. Capture the slot's {id, revision}
  // BEFORE the async Image.fromURL; on return, DISCARD the result if
  // the slot vanished or its base was replaced (revision bumped)
  // mid-flight — the now-active slot stays byte-identical.
  function onAddSource(ctrl) {
    if (!ctrl.sourceTrayPath) { toast('Load a source image first.', 'warn', 2500); return; }
    const h = activeSession(ctrl); if (!h) return;
    const slot = activeSlot(ctrl); // PE-010/PE-028: capture the target slot
    const fabric = h.session.fabric;
    // PE-028: capture slot revision BEFORE the await.
    const Tools028 = window.ImageEditorTools;
    const revCap = (Tools028 && Tools028.captureSlotRev) ? Tools028.captureSlotRev(slot) : null;
    fabric.Image.fromURL(fileUrlOf(ctrl.sourceTrayPath), { crossOrigin: 'anonymous' }).then((fImg) => {
      if (ctrl.closed) return; // PE-010: editor closed mid-load — abandon
      // PE-028: slot-revision guard — discard if the slot vanished or
      // its base was replaced mid-flight.
      if (slot && Tools028 && Tools028.slotRevValid && !Tools028.slotRevValid(ctrl, revCap)) return;
      const s = h.session;
      const maxW = s.imgW * 0.6, maxH = s.imgH * 0.6;
      const scale = Math.min(maxW / (fImg.width || 1), maxH / (fImg.height || 1), 1);
      fImg.set({
        left: s.imgW / 2, top: s.imgH / 2,
        originX: 'center', originY: 'center',
        scaleX: scale, scaleY: scale,
      });
      // R5.2 Source Add: PRE-SNAPSHOT before canvas.add. Wrapped
      // in try/catch so a malformed session doesn't crash.
      try { window.ImageEditorTools.pushUndo(s); } catch (_) { /* defensive */ }
      s.canvas.add(fImg);
      s.canvas.setActiveObject(fImg);
      // PE-010/PE-028: mark the CAPTURED slot dirty (not whichever slot
      // is active now) and only switch the tool / refresh the objects
      // list if that slot is still the active one.
      if (slot) {
        slot.modified = true;
        if (Tools028 && Tools028.bumpSlotRev) Tools028.bumpSlotRev(slot);
      }
      if (ctrl.queue[ctrl.activeIndex] === slot) {
        setActiveToolSafe(ctrl, 'move'); // show transform handles
        refreshObjectsList(ctrl);
      }
      refreshQueueBar(ctrl);
    }).catch((e) => toast('Add failed: ' + (e && e.message || e), 'err', 4000));
  }

  // ---------- OBJECTS LIST ----------
  function refreshObjectsList(ctrl) {
    const list = ctrl.ui.objectsList;
    if (!list) return;
    list.textContent = '';
    const h = activeSession(ctrl); if (!h) return;
    // H8-005: skip excludeFromExport objects (selection/preview rects) so they
    // don't clutter the Objects list.
    const objs = h.session.canvas.getObjects().filter((o) => o !== h.session.baseObject && !o.excludeFromExport);
    if (!objs.length) { list.appendChild(el('div', { class: 'ie-meta', style: 'font-size:10px;color:var(--fg-2);' }, '—')); return; }
    // H8-002: label by ieKind so bars read "Bar N" instead of "Image N".
    let barIdx = 0, imgIdx = 0;
    objs.forEach((o) => {
      const label = (o.ieKind === 'bar') ? ('Bar ' + (++barIdx)) : ('Image ' + (++imgIdx));
      const row = el('div', { class: 'ie-object-row' }, label);
      if (h.session.canvas.getActiveObject() === o) row.classList.add('active');
      // bring forward / send backward / flip H / flip V / delete
      const fwd = el('button', { class: 'ie-obj-btn', title: 'Bring forward' }, '↑');
      const bwd = el('button', { class: 'ie-obj-btn', title: 'Send backward' }, '↓');
      const flipH = el('button', { class: 'ie-obj-btn', title: 'Flip horizontal' }, '↔');
      const flipV = el('button', { class: 'ie-obj-btn', title: 'Flip vertical' }, '↕');
      const del = el('button', { class: 'ie-obj-btn', title: 'Delete' }, '✖');
      fwd.addEventListener('click', (e) => {
        e.stopPropagation();
        // R5.2 Reorder: PRE-SNAPSHOT before bringObjectForward.
        // Pre-fix, the user could not undo the reorder (no
        // pushUndo at all). Post-R5.2: pushUndo BEFORE
        // bringObjectForward so a single undo restores the
        // pre-reorder state (PE-005). Wrapped in try/catch
        // defensive.
        // R5.2.AuditFix P-R52RF-F1: post-actions (slot.modified
        // + refreshObjectsList + refreshQueueBar) are required
        // to mark the slot as dirty + refresh the UI (so the
        // user sees the reorder change + the save dialog
        // triggers). Pre-fix, the post-actions were missing
        // because the handler was added without the R5.2
        // callsite pattern discipline.
        try { window.ImageEditorTools.pushUndo(h.session); } catch (_) { /* defensive */ }
        h.session.canvas.bringObjectForward(o);
        activeSlot(ctrl).modified = true;
        refreshObjectsList(ctrl); refreshQueueBar(ctrl);
        h.session.canvas.requestRenderAll();
      });
      bwd.addEventListener('click', (e) => {
        e.stopPropagation();
        // R5.2 Reorder: PRE-SNAPSHOT before sendObjectBackwards.
        // Same pattern as fwd + post-actions.
        try { window.ImageEditorTools.pushUndo(h.session); } catch (_) { /* defensive */ }
        h.session.canvas.sendObjectBackwards(o);
        // PE-020: enforce floor at base+1 — overlay objects must never
        // sink below the base image (which would hide them entirely).
        const base = h.session.baseObject;
        if (base) {
          const objs = h.session.canvas.getObjects();
          const baseIdx = objs.indexOf(base);
          const objIdx = objs.indexOf(o);
          if (objIdx <= baseIdx) {
            h.session.canvas.moveObjectTo(o, baseIdx + 1);
          }
        }
        activeSlot(ctrl).modified = true;
        refreshObjectsList(ctrl); refreshQueueBar(ctrl);
        h.session.canvas.requestRenderAll();
      });
      flipH.addEventListener('click', (e) => {
        e.stopPropagation();
        // R5.2 Flip: PRE-SNAPSHOT before flipX toggle.
        // Pre-fix, the user could not undo the flip (no
        // pushUndo at all). Post-R5.2: pushUndo BEFORE
        // o.set('flipX', ...) so a single undo restores the
        // pre-flip state (PE-005). Wrapped in try/catch
        // defensive. + post-actions (slot.modified + refresh).
        try { window.ImageEditorTools.pushUndo(h.session); } catch (_) { /* defensive */ }
        o.set('flipX', !o.flipX);
        activeSlot(ctrl).modified = true;
        refreshObjectsList(ctrl); refreshQueueBar(ctrl);
        h.session.canvas.requestRenderAll();
      });
      flipV.addEventListener('click', (e) => {
        e.stopPropagation();
        // R5.2 Flip: PRE-SNAPSHOT before flipY toggle.
        // Same pattern as flipH + post-actions.
        try { window.ImageEditorTools.pushUndo(h.session); } catch (_) { /* defensive */ }
        o.set('flipY', !o.flipY);
        activeSlot(ctrl).modified = true;
        refreshObjectsList(ctrl); refreshQueueBar(ctrl);
        h.session.canvas.requestRenderAll();
      });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        // R5.2 Source Delete: PRE-SNAPSHOT before canvas.remove.
        // Pre-fix, the pushUndo was AFTER canvas.remove(o), so
        // the pre-snapshot was the post-remove state. Undo would
        // pop the post-remove state and restore to it (no visible
        // change). The user had to undo TWICE to get back to
        // before the delete. Post-R5.2: pushUndo BEFORE
        // canvas.remove so a single undo restores the pre-delete
        // state (PE-005). Wrapped in try/catch defensive.
        try { window.ImageEditorTools.pushUndo(h.session); } catch (_) { /* defensive */ }
        h.session.canvas.remove(o);
        activeSlot(ctrl).modified = true;
        refreshObjectsList(ctrl); refreshQueueBar(ctrl);
      });
      row.append(fwd, bwd, flipH, flipV, del);
      row.addEventListener('click', () => {
        h.session.canvas.setActiveObject(o);
        setActiveToolSafe(ctrl, 'move');
        refreshObjectsList(ctrl);
      });
      list.appendChild(row);
    });
  }

  // ---------- QUEUE BAR (filmstrip, §5b) ----------
  // Render one thumb per queued image; active outlined; modified badge.
  // Click a thumb → activate that slot; drag a thumb onto the source tray →
  // load it as the composite source.
  //
  // R4.5 (PE-027 fix): the sourceThumb dropzone (dragover + drop) is
  // NOT registered here. The pre-fix code attached the same two
  // listeners on every refresh, so after N refreshes sourceThumb had
  // 2N listeners and a single drop would be handled N times. The
  // dropzone is now set up ONCE in imageEditorOverlay.buildSourceTray
  // (via setupSourceThumbDropZone below) and reused across refreshes.
  function refreshQueueBar(ctrl) {
    const bar = ctrl.ui.queueBar;
    if (!bar) return;
    bar.classList.toggle('visible', ctrl.queue.length > 1);
    bar.querySelectorAll('.ie-queue-thumb').forEach((t) => t.remove());
    ctrl.queue.forEach((slot, i) => {
      const thumb = el('div', {
        class: 'ie-queue-thumb' + (i === ctrl.activeIndex ? ' active' : '') + (slot.modified ? ' modified' : ''),
        title: slot.name,
      });
      thumb.appendChild(el('div', { class: 'ie-modified-dot' }));
      const img = el('img', { src: fileUrlOf(slot.path), draggable: 'true' });
      thumb.appendChild(img);
      thumb.addEventListener('click', () => {
        ctrl.activateSlot(ctrl, i).then(() => requestAnimationFrame(() => ctrl.fitActive(ctrl)));
      });
      img.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/ie-queue-path', slot.path);
        ev.dataTransfer.effectAllowed = 'copy';
      });
      bar.appendChild(thumb);
    });
  }

  // ---------- one-time sourceThumb dropzone (R4.5 PE-027 fix) ----------
  // Sets up the dragover + drop listeners on `ctrl.ui.sourceThumb`
  // exactly ONCE. Called from imageEditorOverlay.buildSourceTray after
  // the sourceThumb is created. Re-invoking on the same sourceThumb
  // is a no-op (idempotent guard) so we are safe even if the overlay
  // is rebuilt in a future refactor.
  //
  // R4.5.AuditFix P-R45-13: set the idempotency guard AFTER the
  // addEventListener calls. Pre-fix: guard was set BEFORE the
  // addEventListener, so a failed attach (e.g. detached element,
  // sandboxed env) would lock out retries. Now: failed attach
  // leaves the guard unset and a retry can re-attach.
  function setupSourceThumbDropZone(ctrl) {
    const thumb = ctrl && ctrl.ui && ctrl.ui.sourceThumb;
    if (!thumb || thumb._ieSourceDropZoneInstalled) return;
    thumb.addEventListener('dragover', onSourceDragOver);
    thumb.addEventListener('drop', (ev) => onSourceDrop(ev, ctrl));
    thumb._ieSourceDropZoneInstalled = true;
  }

  function onSourceDragOver(ev) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; }
  function onSourceDrop(ev, ctrl) {
    ev.preventDefault();
    const p = ev.dataTransfer.getData('text/ie-queue-path');
    if (p) loadSourceFromPath(ctrl, p);
  }

  // ---------- small local helpers ----------
  function activeSlot(ctrl) { return ctrl.queue[ctrl.activeIndex]; }
  function activeSession(ctrl) {
    const slot = ctrl.queue[ctrl.activeIndex];
    return slot && slot.handle ? slot.handle : null;
  }
  function setActiveToolSafe(ctrl, tool) {
    // The overlay exposes setActiveTool; if the editor exposes a different
    // surface, fall back to ImageEditorTools directly.
    if (typeof ctrl.setActiveTool === 'function') { ctrl.setActiveTool(tool); return; }
    const h = activeSession(ctrl);
    if (h) window.ImageEditorTools.setTool(h.session, tool);
  }

  window.ImageEditorSource = {
    onLoadSource, loadSourceFromPath, onAddSource,
    refreshObjectsList, refreshQueueBar,
    setupSourceThumbDropZone,
  };
})();
