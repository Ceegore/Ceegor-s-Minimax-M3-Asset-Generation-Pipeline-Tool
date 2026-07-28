// renderer/overlays/imageEditorKeyboard.js (pixel editor)
// Keyboard shortcuts + close-confirm + empty-state prompt, extracted from
// imageEditorOverlay.js to stay under the 500-line lint cap.
//
// Shortcuts (Photoshop/GIMP/Krita conventions):
//   B pen, A spray, E eraser, I pipette, V move, Z zoom, H heal-select
//   X swap colors, D reset colors, [ ] brush size −/+
//   Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo, Ctrl+S save
//   Ctrl+0 fit, Ctrl+1 100%, Ctrl+ +/- zoom
//   Space (hold) = pan drag
//
// Esc is handled centrally by showModal (closes the top modal); here only the
// editor-specific keys are wired.

(function () {
  'use strict';

  function activeSession(ctrl) {
    // H8-F2-P2: shortcuts act on the FOCUSED canvas (main or asset). The
    // overlay exposes ctrl.focusedSession(); fall back to the main slot for
    // older controllers (test mocks) that don't have it.
    if (typeof ctrl.focusedSession === 'function') return ctrl.focusedSession();
    const slot = ctrl.queue[ctrl.activeIndex];
    return slot && slot.handle ? slot.handle : null;
  }

  // EFH2-007g fix: after undo/redo, recompute slot.modified from the
  // savepoint so the close prompt and queue bar badge are accurate.
  function syncModifiedFlag(ctrl) {
    const slot = ctrl.queue[ctrl.activeIndex];
    if (!slot || !slot.session) return;
    if (window.ImageEditorTools && slot.session._savepoint) {
      slot.modified = window.ImageEditorTools.isModified(slot.session);
    }
    if (window.ImageEditorSource) window.ImageEditorSource.refreshQueueBar(ctrl);
  }

  // Confirm-before-close guard: if any queue slot is modified, ask before
  // discarding. Then dispose every Fabric session and run the modal close.
  async function confirmClose(ctrl) {
    // PE-007: every exit path (✕ / Cancel / Escape / pipeline-save) funnels
    // through the controller's idempotent requestClose — dirty-confirm,
    // dispose-exactly-once, keyboard cleanup, window.__ieCtrl clear, then
    // the modal close. Kept as the public API for the overlay's buttons.
    if (ctrl && typeof ctrl.requestClose === 'function') {
      ctrl.requestClose('ui');
      return;
    }
    // Legacy fallback (sandboxes / older controllers without requestClose):
    const unsaved = ctrl.queue.filter((s) => s.modified).length;
    if (unsaved > 0) {
      const ok = await asyncConfirm('You have ' + unsaved + ' unsaved edited image(s). Discard?');
      if (!ok) return;
    }
    ctrl.queue.forEach((s) => { if (s.handle) { try { s.handle.dispose(); } catch (_) {} } });
    if (ctrl._cleanupKey) ctrl._cleanupKey();
    if (ctrl.close) ctrl.close();
  }

  // Empty state (header button opened with no image): show a Load prompt.
  //
  // R4.3 (PE-003 fix): the original implementation created a `.ie-empty-prompt`
  // overlay but never removed it after a successful image load. With its
  // `position: absolute; inset: 0; pointer-events: auto` styling, the prompt
  // stayed as a full-area overlay on top of the working canvas (the editor
  // looked "still empty" even after a successful load — a documented user
  // report). The fix:
  //
  //  - Idempotent: never more than one prompt. If `ctrl.ui.emptyPrompt`
  //    already exists, no-op.
  //  - State machine (idle | loading | error): the button reflects the
  //    current state and is disabled during the file-pick + base-decode
  //    + session-commit flow.
  //  - `hideEmptyPrompt(ctrl)` removes the DOM element + clears
  //    `ctrl.ui.emptyPrompt`. Called by activateSlot after a successful
  //    setBaseImage.
  //  - `resetEmptyPrompt(ctrl)` re-enables the button so the user can
  //    try again. Called by activateSlot's catch on load failure.
  //  - On pickFile cancel, the button is re-enabled in place (no toast
  //    needed; cancel is a normal user action).
  //  - On pickFile error or load failure, an error toast is shown +
  //    the button is re-enabled.
  function showEmptyPrompt(ctrl) {
    // Idempotent: never more than one prompt.
    if (ctrl.ui.emptyPrompt) return;
    if (!ctrl.ui.wrap) return; // overlay not yet constructed — bail
    // Build the prompt DOM (hand-rolled to avoid a dependency on the
    // editor's `el` helper signature). The element carries three parts:
    //   .ie-empty-prompt  (the container, full-area, click-blocker)
    //     .ie-empty-text   (the "No image loaded" label)
    //     .ie-empty-status (a small status line for loading/error text)
    //     .ie-empty-btn    (the primary "Load image…" button)
    const prompt = document.createElement('div');
    prompt.className = 'ie-empty-prompt';
    prompt.setAttribute('data-state', 'idle');
    const text = document.createElement('div');
    text.className = 'ie-empty-text';
    text.textContent = 'No image loaded';
    const status = document.createElement('div');
    status.className = 'ie-empty-status';
    status.style.fontSize = '12px';
    status.style.minHeight = '1em';
    const btn = document.createElement('button');
    btn.className = 'ie-btn primary ie-empty-btn';
    btn.textContent = '📂 Load image…';
    btn.disabled = false;
    prompt.appendChild(text);
    prompt.appendChild(status);
    prompt.appendChild(btn);
    ctrl.ui.wrap.appendChild(prompt);
    ctrl.ui.emptyPrompt = prompt;
    // Internal state object — closure-captured, not exposed.
    const state = { mode: 'idle', _picking: false };
    function setMode(m, statusText) {
      state.mode = m;
      // Issue-14: any explicit mode change ends the pick phase (re-arms
      // the single-flight guard on cancel / error / success-commit).
      state._picking = false;
      prompt.setAttribute('data-state', m);
      if (m === 'loading') {
        btn.disabled = true;
        btn.textContent = 'Loading…';
        status.textContent = statusText || 'Decoding image…';
      } else if (m === 'error') {
        btn.disabled = false;
        btn.textContent = '📂 Load image…';
        status.textContent = statusText || '';
      } else { // idle
        btn.disabled = false;
        btn.textContent = '📂 Load image…';
        status.textContent = '';
      }
    }
    btn.addEventListener('click', () => {
      // Single-flight: ignore clicks while decoding ('loading') AND while
      // the native file dialog is open ('_picking' — Issue-14: the mode
      // stays 'idle' during the dialog, so the guard must cover both).
      if (state.mode === 'loading' || state._picking) return;
      // Issue-14 fix: do NOT enter the 'loading' state while the native
      // file dialog is open (it blocks the window for 2–3s, during which
      // the prompt showed a defective disabled "Loading… / Decoding
      // image…" non-button). The dialog itself is the feedback now; the
      // decoding state is entered AFTER a file is actually picked (below).
      // `_picking` keeps the single-flight guard while the dialog is up.
      state._picking = true;
      if (!window.api || typeof window.api.pickFile !== 'function') {
        setMode('error', 'pickFile API missing');
        if (typeof toast === 'function') toast('Editor: file-picker API missing.', 'err', 5000);
        return;
      }
      // R4.3-auditfix P-R43-01: wrap the pickFile call in try/catch.
      // The .then(...).catch(...) chain only handles Promise
      // rejections; a synchronous throw from pickFile (e.g. when
      // window.api.pickFile is a non-Promise-returning stub that
      // throws on argument validation, or a preload sync-throw)
      // would propagate out of the click handler and leave the
      // button stuck in 'loading' state.
      let pickPromise;
      try {
        pickPromise = window.api.pickFile({
          title: 'Select image to edit',
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
        });
      } catch (e) {
        setMode('error', (e && e.message) || String(e));
        if (typeof toast === 'function') toast('File pick failed: ' + (e && e.message || e), 'err', 5000);
        return;
      }
      // Defensive: pickFile should return a Promise. If it returns
      // undefined (sync API) or something else, surface as error.
      if (!pickPromise || typeof pickPromise.then !== 'function') {
        setMode('error', 'pickFile did not return a promise');
        if (typeof toast === 'function') toast('Editor: file-picker returned a non-promise.', 'err', 5000);
        return;
      }
      pickPromise.then((r) => {
        if (!r || r.ok === false) {
          // Cancel or backend error — re-enable the button.
          // No toast on cancel (cancel is a normal user action).
          // Backend error gets a toast.
          if (r && r.error) {
            setMode('error', r.error);
            if (typeof toast === 'function') toast('File pick failed: ' + r.error, 'err', 5000);
          } else {
            setMode('idle');
          }
          return;
        }
        // Issue-14 fix: decoding starts now (file picked) — enter the
        // loading state here, not before the dialog.
        state._picking = false;
        setMode('loading', 'Decoding image…');
        // r.ok === true and r.path set: push slot + activate.
        // The empty-prompt stays in 'loading' state during
        // activateSlot. On success, activateSlot calls
        // hideEmptyPrompt. On failure, activateSlot's catch calls
        // resetEmptyPrompt (which re-enables the button).
        // R4.4 (PE-002 fix): use ctrl.mintSlotId() (exposed by the
        // overlay module) so the pushed slot has a stable id
        // matching the persistent-host map.
        try {
          const newId = (ctrl.mintSlotId && typeof ctrl.mintSlotId === 'function') ? ctrl.mintSlotId() : ('s' + Date.now());
          ctrl.queue.push({ id: newId, path: r.path, name: baseName(r.path), session: null, modified: false, revision: 0 });
          if (window.ImageEditorSource && window.ImageEditorSource.refreshQueueBar) {
            window.ImageEditorSource.refreshQueueBar(ctrl);
          }
          const p = ctrl.activateSlot ? ctrl.activateSlot(ctrl, 0) : Promise.resolve();
          if (p && typeof p.then === 'function') {
            p.then(() => requestAnimationFrame(() => { try { ctrl.fitActive && ctrl.fitActive(ctrl); } catch (_) {} }));
          }
        } catch (e) {
          setMode('error', (e && e.message) || String(e));
          if (typeof toast === 'function') toast('Load failed: ' + (e && e.message || e), 'err', 5000);
        }
      }).catch((e) => {
        setMode('error', (e && e.message) || String(e));
        if (typeof toast === 'function') toast('Load failed: ' + (e && e.message || e), 'err', 5000);
      });
    });
  }

  // Remove the empty-prompt (called by activateSlot after a successful
  // setBaseImage). Idempotent: no-op if already removed.
  function hideEmptyPrompt(ctrl) {
    if (!ctrl || !ctrl.ui) return;
    const prompt = ctrl.ui.emptyPrompt;
    if (!prompt) return;
    if (prompt.parentNode) {
      try { prompt.parentNode.removeChild(prompt); } catch (_) {}
    }
    ctrl.ui.emptyPrompt = null;
  }

  // Re-enable the empty-prompt after a load failure (called by
  // activateSlot's catch). The prompt itself stays visible so the
  // user can try again with a different file.
  function resetEmptyPrompt(ctrl) {
    if (!ctrl || !ctrl.ui) return;
    const prompt = ctrl.ui.emptyPrompt;
    if (!prompt) return;
    prompt.setAttribute('data-state', 'idle');
    const btn = prompt.querySelector('.ie-empty-btn');
    const status = prompt.querySelector('.ie-empty-status');
    if (btn) { btn.disabled = false; btn.textContent = '📂 Load image…'; }
    if (status) status.textContent = '';
  }

  function baseName(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    return slash >= 0 ? norm.slice(slash + 1) : norm;
  }

  function wireKeyboard(ctrl) {
    window.__ieCtrl = ctrl;
    // PE-018: push the editor scope so global shortcuts (Ctrl+S/L/B/T)
    // are suppressed while the editor is open. The pop function is
    // idempotent and runs in _cleanupKey (called on dispose/close).
    const popScope = (window.ShortcutScope) ? window.ShortcutScope.push('editor') : null;
    const setActiveTool = (t) => ctrl.setActiveTool(t);
    const fitActive = () => ctrl.fitActive(ctrl);
    const zoomBtn = (factor) => {
      const h = activeSession(ctrl);
      if (!h) return;
      // H8-F2-P2: zoom about the center of the FOCUSED canvas's wrap.
      const wrapEl = (ctrl.activeCanvas === 'asset' && ctrl.assetPanel) ? ctrl.assetPanel.wrap : ctrl.ui.wrap;
      h.zoomAt({ x: wrapEl.clientWidth / 2, y: wrapEl.clientHeight / 2 }, factor);
      ctrl.updateZoomLabel(ctrl);
    };
    const onKey = (e) => {
      if (ctrl.closed) return;
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const h = activeSession(ctrl);
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'z' && h) { e.preventDefault(); Promise.resolve((e.shiftKey ? window.ImageEditorTools.redo : window.ImageEditorTools.undo)(h.session)).then(() => { syncModifiedFlag(ctrl); }).catch(() => {}); return; }
        if (k === 'y' && h) { e.preventDefault(); Promise.resolve(window.ImageEditorTools.redo(h.session)).then(() => { syncModifiedFlag(ctrl); }).catch(() => {}); return; }
        // STD-SEL: Ctrl+A select-all / Ctrl+D deselect (guarded by !typing so
        // they don't hijack text inputs inside the editor).
        if (k === 'a' && !typing) { e.preventDefault(); const slot = ctrl.queue[ctrl.activeIndex]; if (slot && slot.session && window.ImageEditorSelect) window.ImageEditorSelect.selectAll(ctrl, slot, () => ctrl.queue[ctrl.activeIndex]); return; }
        if (k === 'd' && !typing) { e.preventDefault(); const slot = ctrl.queue[ctrl.activeIndex]; if (slot && slot.session && window.ImageEditorSelect) window.ImageEditorSelect.deselect(ctrl, slot, () => ctrl.queue[ctrl.activeIndex]); return; }
        if (k === 's') { e.preventDefault(); window.ImageEditorActions.onSave(ctrl); return; }
        if (k === '0') { e.preventDefault(); fitActive(); return; }
        if (k === '1') { e.preventDefault(); if (h) h.setZoom(1); ctrl.updateZoomLabel(ctrl); return; }
        if (k === '=' || k === '+') { e.preventDefault(); zoomBtn(1.25); return; }
        if (k === '-') { e.preventDefault(); zoomBtn(0.8); return; }
        return;
      }
      if (typing) return;
      // PE-036: Escape cancels a pending bar placement before falling
      // through to the modal's close handler.
      if (e.key === 'Escape' && ctrl._barState && ctrl._barState.pending) {
        window.ImageEditorShapes.cancel(ctrl, () => ctrl.queue && ctrl.queue[ctrl.activeIndex]);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      switch (e.key.toLowerCase()) {
        case 'b': setActiveTool('pen'); break;
        case 'a': setActiveTool('spray'); break;
        case 'e': setActiveTool('eraser'); break;
        case 'i': setActiveTool('pipette'); break;
        case 'v': setActiveTool('move'); break;
        case 'z': setActiveTool('zoom'); break;
        case 'h': setActiveTool('heal'); break;
        case 'm': setActiveTool('select'); break; // H8-005: marquee selection tool
        case 'l': setActiveTool('bar'); break;   // H8-002: bar (line) tool
        case 'x': ctrl.swapColors(ctrl); break;
        case 'd': ctrl.resetColors(ctrl); break;
        case '[': if (h) { const v = Math.max(1, (Number(ctrl.ui.sizeSlider.value) || 1) - 2); ctrl.ui.sizeSlider.value = v; ctrl.ui.sizeSlider.dispatchEvent(new Event('input')); } break;
        case ']': if (h) { const v = Math.min(200, (Number(ctrl.ui.sizeSlider.value) || 1) + 2); ctrl.ui.sizeSlider.value = v; ctrl.ui.sizeSlider.dispatchEvent(new Event('input')); } break;
        // STD-SEL: arrow keys nudge the active selection (Shift = 10px). Only
        // acts while a selection exists; otherwise arrows are left alone.
        case 'arrowup': case 'arrowdown': case 'arrowleft': case 'arrowright': {
          const slot = ctrl.queue[ctrl.activeIndex];
          const selN = (slot && slot.session && window.ImageEditorHeal && window.ImageEditorHeal.getSelection) ? window.ImageEditorHeal.getSelection(slot.session) : null;
          if (slot && selN && window.ImageEditorSelect) {
            const step = e.shiftKey ? 10 : 1;
            const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
            const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
            window.ImageEditorSelect.nudgeSelection(ctrl, slot, dx, dy, () => ctrl.queue[ctrl.activeIndex]);
            e.preventDefault();
          }
          break;
        }
        // STD-SEL: Delete/Backspace cuts the selected region to transparency
        // (the "mark an area, then cut it out" workflow).
        case 'delete': case 'backspace': {
          const slot = ctrl.queue[ctrl.activeIndex];
          const selD = (slot && slot.session && window.ImageEditorHeal && window.ImageEditorHeal.getSelection) ? window.ImageEditorHeal.getSelection(slot.session) : null;
          if (slot && selD && window.ImageEditorSelect) {
            window.ImageEditorSelect.clearSelectionToTransparency(ctrl, slot);
            e.preventDefault();
          }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    // STD-SEL: Escape clears an active selection BEFORE the modal's bubble-phase
    // close handler runs. Registered capture-phase on document so it wins the
    // propagation race against section19_Modal's bubble-phase Escape listener.
    // A second Escape — with no selection left — falls through and closes the
    // editor as usual. Yields to a pending bar placement (PE-036 cancel path).
    const onEscSelection = (e) => {
      if (ctrl.closed || e.key !== 'Escape') return;
      if (ctrl._barState && ctrl._barState.pending) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const slot = ctrl.queue && ctrl.queue[ctrl.activeIndex];
      if (!slot || !slot.session) return;
      const selE = (window.ImageEditorHeal && window.ImageEditorHeal.getSelection) ? window.ImageEditorHeal.getSelection(slot.session) : (slot._healSelVisible || null);
      if (selE && window.ImageEditorSelect && window.ImageEditorSelect.deselect) {
        window.ImageEditorSelect.deselect(ctrl, slot, () => ctrl.queue[ctrl.activeIndex]);
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', onEscSelection, true);
    // Space = hold to pan
    let spaceDown = false;
    const isTyping = () => { const t = (document.activeElement && document.activeElement.tagName) || ''; return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT'; };
    const onDown = (e) => { if (ctrl.closed) return; if (e.code === 'Space' && !isTyping()) { spaceDown = true; ctrl._spacePan = true; const h = activeSession(ctrl); if (h) h.session.canvas.defaultCursor = 'grabbing'; } };
    const onUp = (e) => { if (ctrl.closed) return; if (e.code === 'Space') { spaceDown = false; ctrl._spacePan = false; } };
    // PE-034: also clear pan state on blur/visibilitychange so a
    // stuck Space key (alt-tab while holding) doesn't permanently
    // suppress drawing.
    const clearPan = () => { spaceDown = false; ctrl._spacePan = false; };
    window.addEventListener('blur', clearPan);
    document.addEventListener('visibilitychange', clearPan);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    ctrl.ui.wrap.addEventListener('mousedown', (e) => {
      if (!spaceDown && e.button !== 1) return;
      const h = activeSession(ctrl); if (!h) return;
      h.startPan(e.clientX, e.clientY);
      const mv = (ev) => h.movePan(ev.clientX, ev.clientY);
      const up = () => { h.endPan(); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    });
    // H8-F2-P2: Space/middle-drag pan also works on the asset canvas. The
    // panel's own mousedown listener (attached earlier in buildLayout) runs
    // first and moves focus, so activeSession() resolves to the asset here.
    if (ctrl.assetPanel && ctrl.assetPanel.wrap) {
      ctrl.assetPanel.wrap.addEventListener('mousedown', (e) => {
        if (!spaceDown && e.button !== 1) return;
        const h = activeSession(ctrl); if (!h) return;
        h.startPan(e.clientX, e.clientY);
        const mv = (ev) => h.movePan(ev.clientX, ev.clientY);
        const up = () => { h.endPan(); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      });
    }
    ctrl._cleanupKey = () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onEscSelection, true); // STD-SEL
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', clearPan); // PE-034
      document.removeEventListener('visibilitychange', clearPan); // PE-034
      if (popScope) popScope(); // PE-018: restore global shortcuts
    };
  }

  window.ImageEditorKeyboard = { wireKeyboard, confirmClose, showEmptyPrompt, hideEmptyPrompt, resetEmptyPrompt };
})();
