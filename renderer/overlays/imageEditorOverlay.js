// renderer/overlays/imageEditorOverlay.js (pixel editor)
// Main entry: showImageEditOverlay(srcPath, targets).
//
// Opens a near-fullscreen modal containing a 3-pane editor:
//   left  = tool rail (pen/spray/eraser/pipette/move/zoom + FG/BG + size/opacity/format)
//   center = canvas (Fabric, over CSS checkerboard) + optional batch queue filmstrip
//   right = Asset panel (H8-F2: secondary canvas + Load/Send) + objects list
//
// Split companions (to stay under the 500-line lint cap):
//   imageEditorCanvas.js — Fabric session + zoom/pan + RGBA + base image
//   imageEditorTools.js  — pen/spray/eraser/pipette, colors, undo/redo, brush cursor
//   imageEditorActions.js— save / bake / heal / external / format + alpha helpers
//   imageEditorSource.js — source tray (legacy fallback) + objects list + queue filmstrip
//   imageEditorAssetPanel.js — H8-F2 Asset Composer panel (primary right pane)
//
// Depends on globals: showModal (section19_Modal.js), el/$ (DomHelpers),
// fabric (vendor), loadImageFromFile (pureFuncs), mimeFromPath/extFromMime,
// toast/refreshBrowser/previewImageFromFile.

(function () {
  'use strict';
  // One open editor instance. The controller is shared with the companion
  // modules via window.__ieCtrl (drag/drop handlers) + passed as an arg.
  function newController() {
    return {
      queue: [], activeIndex: -1, modal: null, close: null, closed: false,
      ui: null, sourceTrayPath: null, prefs: null,
      // H8-F2-P2: which canvas the rail/keyboard/zoom bar act on ('main' | 'asset').
      activeCanvas: 'main',
      // the companion modules call these (set in showImageEditOverlay below):
      setActiveTool: null, fitActive: null, activateSlot: null,
      swapColors: null, resetColors: null, updateZoomLabel: null,
      focusedSession: null, setFocus: null, rail: null,
    };
  }

  // ============================================================
  // R4.4 (PE-002 fix): module-level counter for stable slot ids.
  // Queue indices are NOT stable (push/splice/filter can renumber),
  // but each slot needs a unique id for the persistent-host map
  // (ctrl.ui.hosts) so A's host survives B's activation. IDs are
  // never recycled, so external references (undo-stack, persisted
  // prefs) survive queue mutations.
  // ============================================================
  let _nextSlotId = 1;
  function mintSlotId() { return 'slot-' + (_nextSlotId++); }

  // ============================================================
  // Issue-13 fix: PERSISTED EDITOR SESSION (module-level singleton).
  // Closing the overlay no longer destroys the Fabric sessions — the
  // whole controller (queue + canvases + undo stacks + asset panel)
  // is stashed here and re-attached when the editor reopens with the
  // same image set. The state survives until the user opens the
  // editor for a DIFFERENT image (fresh start disposes it) or the
  // app quits.
  // ============================================================
  let _persisted = null;
  // Memory guard: never persist more than ~50 MP of canvas pixels.
  const MAX_PERSISTED_PIXELS = 50e6;

  function getPrefs() {
    const st = (typeof window.state === 'object' && window.state) || {};
    const p = st.imageEditorPrefs || {};
    return {
      tool: p.tool || 'pen',
      brushSize: p.brushSize || 12,
      brushOpacity: p.brushOpacity != null ? p.brushOpacity : 1,
      fg: p.fg || '#000000', bg: p.bg || '#ffffff',
      outFormat: p.outFormat || 'png',
      // H8-F2: Asset panel collapsed state persists across editor sessions.
      assetPanelCollapsed: p.assetPanelCollapsed === true,
    };
  }
  function savePrefs(ctrl) {
    if (typeof window.state !== 'object' || !window.state) return;
    const s = ctrl.queue[ctrl.activeIndex] && ctrl.queue[ctrl.activeIndex].session;
    window.state.imageEditorPrefs = {
      tool: s ? s.tool : ctrl.prefs.tool,
      brushSize: s ? s.brushSize : ctrl.prefs.brushSize,
      brushOpacity: s ? s.brushOpacity : ctrl.prefs.brushOpacity,
      fg: s ? s.fg : ctrl.prefs.fg, bg: s ? s.bg : ctrl.prefs.bg,
      outFormat: ctrl.prefs.outFormat,
      assetPanelCollapsed: ctrl.prefs.assetPanelCollapsed === true,
    };
    // BUG #11 fix: imageEditorPrefs is a whitelisted persisted key
    // (section24), but the mutation was never followed by
    // scheduleStateSave() — prefs (brush/color/format/collapsed)
    // were lost on edit-then-quit.
    if (typeof window.scheduleStateSave === 'function') {
      try { window.scheduleStateSave(); } catch (_) { /* best-effort */ }
    }
  }

  // ============================================================
  // ENTRY POINT
  // ============================================================
  function showImageEditOverlay(srcPath, targets, opts) {
    opts = opts || {};
    const ctrl = newController();
    ctrl.saveLabel = opts.saveLabel || '💾 Save'; ctrl.hideExternal = opts.hideExternal === true;
    ctrl.onSaveOverride = typeof opts.onSaveOverride === 'function' ? opts.onSaveOverride : null; ctrl.onSaved = typeof opts.onSaved === 'function' ? opts.onSaved : null;
    ctrl.prefs = getPrefs();
    // Issue-13 fix: restore a persisted session when the editor reopens
    // for the SAME image set (or with no explicit path — e.g. the header
    // button). Opening a DIFFERENT image disposes the persisted state
    // and starts fresh ("explicitly starts a NEW image").
    let paths = (Array.isArray(targets) && targets.length > 0) ? targets.slice()
      : (srcPath ? [srcPath] : []);
    // QA-013 fix: when multi-select opens the editor, ensure the clicked file
    // (srcPath) is the primary/current image by moving it to the front.
    if (srcPath && paths.length > 1) {
      const idx = paths.indexOf(srcPath);
      if (idx > 0) { paths = [srcPath, ...paths.slice(0, idx), ...paths.slice(idx + 1)]; }
    }
    const restoring = canRestorePersisted(paths);
    if (_persisted && !restoring) disposePersisted();
    // expose helper methods now so activateSlot can recurse safely
    ctrl.setActiveTool = (tool) => setActiveTool(ctrl, tool);
    ctrl.fitActive = () => fitActive(ctrl);
    ctrl.activateSlot = (c, i) => activateSlot(ctrl, i);
    ctrl.swapColors = (c) => doSwapColors(c);
    ctrl.resetColors = (c) => doResetColors(c);
    ctrl.updateZoomLabel = (c) => updateZoomLabel(c);
    // H8-F2-P2: focus routing — the rail/keyboard/zoom bar act on the focused
    // canvas (main or asset). `rail` mirrors the left rail's live values so a
    // focus switch can push them onto the newly focused session (shared tools).
    ctrl.focusedSession = () => focusedSession(ctrl);
    ctrl.setFocus = (which) => setFocus(ctrl, which);
    // PE-007: the one-and-only close request entry point (see requestClose).
    ctrl.requestClose = (reason, copts) => requestClose(ctrl, reason, copts || {});
    ctrl.rail = {
      tool: ctrl.prefs.tool, brushSize: ctrl.prefs.brushSize,
      brushOpacity: ctrl.prefs.brushOpacity, fg: ctrl.prefs.fg, bg: ctrl.prefs.bg,
    };

    // R4.4 (PE-002 fix): expose ctrl.mintSlotId() so other modules
    // (imageEditorKeyboard.js's empty-prompt, etc.) can push slots
    // with stable ids that match the persistent-host map.
    ctrl.mintSlotId = mintSlotId;
    if (!restoring) {
      for (const p of paths) {
        // R4.4 (PE-002 fix): each slot gets a stable id so its host
        // element can be tracked across queue re-orders and re-activations.
        ctrl.queue.push({ id: ctrl.mintSlotId(), path: p, name: baseName(p), session: null, modified: false, revision: 0 });
      }
    }

    showModal((m, close) => {
      ctrl.modal = m;
      m.classList.add('image-editor-modal');
      const origClose = close;
      // PE-007: idempotent single-exit close — disposes EXACTLY once (guard
      // on ctrl.closed), saves prefs, detaches keyboard listeners, clears
      // the global window.__ieCtrl reference, then closes the modal. Every
      // exit path (✕ / Cancel / Escape / pipeline-save / programmatic)
      // funnels through requestClose → this function.
      ctrl.close = () => {
        if (ctrl.closed) return;
        ctrl.closed = true;
        savePrefs(ctrl);
        // Issue-13 fix: persist instead of destroy. The Fabric sessions,
        // queue and undo stacks survive in the module-level _persisted
        // singleton; only the DOM + listeners are detached. If the
        // memory guard trips (> 50 MP), persistEditorSession falls back
        // to a full dispose.
        try { persistEditorSession(ctrl); } catch (_) { disposeAllListeners(ctrl); }
        if (ctrl._cleanupKey) { try { ctrl._cleanupKey(); } catch (_) {} ctrl._cleanupKey = null; }
        if (window.__ieCtrl === ctrl) window.__ieCtrl = null;
        origClose();
      };

      if (restoring && reopenPersisted(ctrl, opts)) {
        // Restored successfully
      } else {
        if (_persisted) disposePersisted();
        if (ctrl.queue.length === 0 && paths.length > 0) {
          for (const p of paths) {
            ctrl.queue.push({ id: ctrl.mintSlotId(), path: p, name: baseName(p), session: null, modified: false, revision: 0 });
          }
        }
        buildLayout(ctrl);
        wireKeyboard(ctrl);
        if (ctrl.queue.length === 0) {
          showEmptyPrompt(ctrl);
        } else {
          activateSlot(ctrl, 0).then(() => requestAnimationFrame(() => fitActive(ctrl)));
        }
      }
    }, { id: opts.modalId || 'image-editor', onRequestClose: () => ctrl.requestClose('escape') });
  }

  // PE-007: single idempotent exit for ✕ / Cancel / Escape / backdrop /
  // pipeline-save / programmatic close. Dirty-confirm first (skipped when
  // the caller passes { saved: true }), then ctrl.close(). Re-entrant
  // calls (double-Escape, ✕ mashed during confirm) are no-ops via _closing.
  async function requestClose(ctrl, reason, opts) {
    if (!ctrl || ctrl.closed || ctrl._closing) return;
    ctrl._closing = true;
    const unsaved = ctrl.queue.filter((s) => s && s.modified).length;
    // Issue-13 fix: with session persistence, closing NEVER discards work
    // (everything survives in _persisted until a different image is opened
    // or the app quits) — so the dirty-confirm is skipped. The confirm
    // would be a false alarm: "Discard?" although nothing is discarded.
    if (!(opts && opts.saved) && unsaved > 0 && _persisted) {
      // A different editor instance is already persisted — closing this
      // one WOULD destroy it, so keep the confirm for that rare case.
      const ok = await asyncConfirm('You have ' + unsaved + ' unsaved edited image(s). Discard?');
      if (!ok) { ctrl._closing = false; return; }
    }
    if (typeof ctrl.close === 'function') ctrl.close();
  }

  function baseName(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    return slash >= 0 ? norm.slice(slash + 1) : norm;
  }

  // ============================================================
  // LAYOUT BUILD
  // ============================================================
  function buildLayout(ctrl) {
    const ui = {}; ctrl.ui = ui;
    const A = window.ImageEditorActions;
    const S = window.ImageEditorSource;

    // ---- header ----
    const header = el('div', { class: 'ie-header' });
    header.appendChild(el('h2', { class: 'ie-title' }, '✏ Image Editor')); // PE-041: real heading for aria-labelledby
    ui.meta = el('span', { class: 'ie-meta' }, '');
    header.appendChild(ui.meta);
    header.appendChild(el('span', { class: 'ie-spacer' }));
    const zbar = el('div', { class: 'ie-zoombar' });
    ui.fitBtn = el('button', { class: 'ie-btn', title: 'Fit on screen (Ctrl+0)' }, 'Fit');
    ui.zoom100Btn = el('button', { class: 'ie-btn', title: 'Actual pixels 100% (Ctrl+1)' }, '100%');
    ui.zoomOutBtn = el('button', { class: 'ie-btn', title: 'Zoom out' }, '−');
    ui.zoomInBtn = el('button', { class: 'ie-btn', title: 'Zoom in' }, '+');
    ui.zoomLabel = el('span', { class: 'ie-meta', style: 'min-width:42px;text-align:center;' }, '100%');
    zbar.append(ui.fitBtn, ui.zoomOutBtn, ui.zoomLabel, ui.zoomInBtn, ui.zoom100Btn);
    header.appendChild(zbar);
    ui.helpBtn = el('button', { class: 'ie-btn', title: 'Keyboard shortcuts + help', 'data-help': 'Open the shortcut cheatsheet + help for each tool.' }, '?');
    ui.helpBtn.addEventListener('click', () => openCheatsheet());
    header.appendChild(ui.helpBtn);
    const closeBtn = el('button', { class: 'ie-close', title: 'Close (Esc)' }, '✕');
    closeBtn.addEventListener('click', () => confirmClose(ctrl));
    header.appendChild(closeBtn);
    ctrl.modal.appendChild(header);

    // ---- body ----
    const body = el('div', { class: 'ie-body' });
    body.appendChild(buildToolRail(ctrl));
    body.appendChild(buildCenter(ctrl));
    // H8-F2: the Asset Composer panel is the primary right pane (secondary
    // canvas + Load/Send). The legacy source tray (buildSourceTray below)
    // remains as a defensive fallback if the panel module failed to load,
    // keeping the editor usable no matter what.
    const rightPane = (window.ImageEditorAssetPanel && typeof window.ImageEditorAssetPanel.build === 'function')
      ? window.ImageEditorAssetPanel.build(ctrl)
      : buildSourceTray(ctrl);
    body.appendChild(rightPane);
    ctrl.modal.appendChild(body);

    // H8-F2-P2: initial focus = main canvas (accent outline). Clicking the
    // main wrap (re-)focuses it; the asset panel wires its own wrap to
    // setFocus('asset') in imageEditorAssetPanel.build.
    ui.wrap.classList.add('ie-canvas-focus');
    ui.wrap.addEventListener('mousedown', () => setFocus(ctrl, 'main'));

    // ---- footer ----
    const footer = el('div', { class: 'ie-footer' });
    ui.saveBtn = el('button', { class: 'ie-btn primary', title: 'Save (Ctrl+S)' }, '💾 Save');
    ui.formatSel = el('select', { class: 'ie-format-sel', title: 'Output format' });
    for (const [v, lbl] of [['png', 'PNG (transparency)'], ['jpeg', 'JPEG'], ['webp', 'WebP']]) {
      ui.formatSel.appendChild(el('option', { value: v }, lbl));
    }
    ui.formatSel.value = ctrl.prefs.outFormat;
    ui.bakeBtn = el('button', { class: 'ie-btn', title: 'Bake/flatten placed images into the base layer' }, '↻ Bake');
    ui.healBtn = el('button', { class: 'ie-btn', title: 'Heal / inpaint selection' }, '🩹 Heal ▾');
    ui.cropSelectionBtn = el('button', { class: 'ie-btn', disabled: true, title: 'Crop base image to selection' }, '✂ Crop selection');
    ui.removeBgBtn = el('button', { class: 'ie-btn', title: 'Remove the background to transparency (local IS-Net/BiRefNet)' }, '✂ Remove BG');
    ui.extBtn = el('button', { class: 'ie-btn', title: 'Open in external editor' }, '🔧 Open in…');
    if (ctrl.hideExternal) ui.extBtn.style.display = 'none';
    ui.status = el('span', { class: 'ie-status' }, '');
    footer.append(ui.saveBtn, ui.formatSel, ui.bakeBtn, ui.healBtn, ui.cropSelectionBtn, ui.removeBgBtn, ui.extBtn,
      el('span', { class: 'ie-spacer' }), ui.status,
      el('button', { class: 'ie-btn', onclick: () => confirmClose(ctrl) }, 'Cancel'));
    ui.cropSelectionBtn.addEventListener('click', () => window.ImageEditorCropSelection?.confirmCrop(ctrl));
    ctrl.modal.appendChild(footer);
    if (ctrl.saveLabel) ui.saveBtn.textContent = ctrl.saveLabel;

    ui.saveBtn.addEventListener('click', () => A.onSave(ctrl));
    ui.formatSel.addEventListener('change', () => { ctrl.prefs.outFormat = ui.formatSel.value; });
    ui.bakeBtn.addEventListener('click', () => A.onBake(ctrl));
    ui.healBtn.addEventListener('click', () => A.onHeal(ctrl));
    ui.removeBgBtn.addEventListener('click', () => A.onRemoveBg(ctrl));
    ui.extBtn.addEventListener('click', () => A.onExternal(ctrl));
    ui.fitBtn.addEventListener('click', () => fitActive(ctrl));
    ui.zoom100Btn.addEventListener('click', () => { const h = focusedSession(ctrl); if (h) h.setZoom(1); updateZoomLabel(ctrl); });
    ui.zoomInBtn.addEventListener('click', () => zoomBtn(ctrl, 1.25));
    ui.zoomOutBtn.addEventListener('click', () => zoomBtn(ctrl, 0.8));

    // Wheel-to-cursor zoom: attached ONCE on the wrap (not per-slot) so a
    // single wheel tick doesn't zoom N times after N queue switches.
    ui.wrap.addEventListener('wheel', (e) => {
      const h = activeSession(ctrl);
      if (!h) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const rect = ui.wrap.getBoundingClientRect();
      h.zoomAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, factor);
      updateZoomLabel(ctrl);
    }, { passive: false });
  }

  // R4.6.AuditFix P-R46-D01: zoomBtn uses clientWidth/clientHeight
  // (CSS-pixel layout dimensions) while the wheel handler above
  // uses getBoundingClientRect (post-CSS-transform dimensions).
  // The values are equal as long as the wrap has no CSS transform;
  // the current CSS for .ie-canvas-wrap has no transform, so this
  // is safe. If a future CSS change adds `transform: scale(...)` to
  // the wrap, switch this to getBoundingClientRect for consistency
  // with the wheel handler.
  function zoomBtn(ctrl, factor) {
    const h = focusedSession(ctrl);
    if (!h) return;
    // H8-F2-P2: zoom about the center of the FOCUSED canvas's wrap.
    const wrapEl = (ctrl.activeCanvas === 'asset' && ctrl.assetPanel) ? ctrl.assetPanel.wrap : ctrl.ui.wrap;
    h.zoomAt({ x: wrapEl.clientWidth / 2, y: wrapEl.clientHeight / 2 }, factor);
    updateZoomLabel(ctrl);
  }

  // ---- tool rail ----
  function buildToolRail(ctrl) {
    const ui = ctrl.ui;
    const rail = el('div', { class: 'ie-tools' });
    const grid = el('div', { class: 'ie-tool-grid' });
    ui.tools = {};
    const toolBtn = (letter, glyph, name) => {
      const b = el('button', { class: 'ie-tool', 'data-help': name + ' (' + letter + ')', title: name + ' (' + letter + ')' },
        [glyph, el('span', { class: 'ie-tool-letter' }, letter)]);
      b.addEventListener('click', () => setActiveTool(ctrl, name));
      ui.tools[name] = b; grid.appendChild(b);
    };
    toolBtn('B', '🖊', 'pen'); toolBtn('A', '🌫', 'spray'); toolBtn('E', '🧽', 'eraser');
    toolBtn('I', '💧', 'pipette'); toolBtn('V', '✥', 'move'); toolBtn('Z', '🔍', 'zoom');
    toolBtn('H', '🩹', 'heal'); // drag a rectangle to define the heal region
    toolBtn('M', '▭', 'select'); // H8-005: marquee selection (persistent; consumed by Heal)
    toolBtn('L', '─', 'bar'); // H8-002: bar/line tool (click endpoint, click endpoint)
    rail.appendChild(grid);

    rail.appendChild(el('div', { class: 'ie-section-label' }, 'Colors'));
    const colors = el('div', { class: 'ie-colors' });
    ui.fgSwatch = el('div', { class: 'ie-color-fg', title: 'Foreground color' });
    ui.bgSwatch = el('div', { class: 'ie-color-bg', title: 'Background color' });
    const swap = el('span', { class: 'ie-color-swap', title: 'Swap FG/BG (X)' }, '⇄');
    const reset = el('span', { class: 'ie-color-reset', title: 'Reset to black/white (D)' }, '⇅');
    colors.append(ui.fgSwatch, ui.bgSwatch, swap, reset);
    rail.appendChild(colors);
    const fgInput = el('input', { type: 'color', style: 'display:none;' });
    const bgInput = el('input', { type: 'color', style: 'display:none;' });
    rail.append(fgInput, bgInput);

    rail.appendChild(el('div', { class: 'ie-section-label' }, 'Size'));
    // H8-006: slider on its own full-width row + numeric input beneath.
    ui.sizeSlider = el('input', { class: 'ie-slider', type: 'range', min: '1', max: '200', value: String(ctrl.prefs.brushSize) });
    ui.sizeNum = el('input', { class: 'ie-slider-num', type: 'number', min: '1', max: '200', step: '1', value: String(ctrl.prefs.brushSize) });
    const sizeSuffix = el('span', { class: 'ie-slider-num-suffix' }, 'px');
    const applySize = (val) => {
      const n = Math.max(1, Math.min(200, Math.round(Number(val) || 1)));
      ui.sizeSlider.value = String(n);
      ui.sizeNum.value = String(n);
      if (ctrl.rail) ctrl.rail.brushSize = n; // H8-F2-P2: rail mirror
      const h = focusedSession(ctrl);
      if (h) {
        // H8-002: if a bar is the active object, Size drives its strength.
        const ao = h.session.canvas.getActiveObject && h.session.canvas.getActiveObject();
        if (ao && ao.ieKind === 'bar') {
          // PE-037: push undo once per slider gesture (first input event).
          if (!ctrl._barSizeUndoPushed) {
            try { Tools.pushUndo(h.session); } catch (_) {}
            ctrl._barSizeUndoPushed = true;
          }
          ao.set({ height: n }); h.session.canvas.requestRenderAll();
        }
        else { h.session.brushSize = n; reapplyBrush(h.session); }
      }
    };
    ui.sizeSlider.addEventListener('input', () => applySize(ui.sizeSlider.value));
    ui.sizeNum.addEventListener('input', () => applySize(ui.sizeNum.value));
    // PE-037: on 'change' (slider released / number committed), mark the
    // slot dirty + fire object:modified so the queue bar updates. Reset
    // the undo-push flag for the next gesture.
    const barSizeCommit = () => {
      if (ctrl._barSizeUndoPushed) {
        ctrl._barSizeUndoPushed = false;
        const slot = activeSlotFn(ctrl);
        if (slot) { slot.modified = true; if (window.ImageEditorSource) window.ImageEditorSource.refreshQueueBar(ctrl); }
        const h = focusedSession(ctrl);
        if (h) { try { h.session.canvas.fire('object:modified'); } catch (_) {} }
      }
    };
    ui.sizeSlider.addEventListener('change', barSizeCommit);
    ui.sizeNum.addEventListener('change', () => { applySize(ui.sizeNum.value); barSizeCommit(); });
    rail.appendChild(el('div', { class: 'ie-slider-block' }, [
      ui.sizeSlider,
      el('div', { class: 'ie-slider-num-row' }, [ui.sizeNum, sizeSuffix]),
    ]));

    rail.appendChild(el('div', { class: 'ie-section-label' }, 'Opacity'));
    ui.opacitySlider = el('input', { class: 'ie-slider', type: 'range', min: '0', max: '100', value: String(Math.round(ctrl.prefs.brushOpacity * 100)) });
    ui.opacityNum = el('input', { class: 'ie-slider-num', type: 'number', min: '0', max: '100', step: '1', value: String(Math.round(ctrl.prefs.brushOpacity * 100)) });
    const opaSuffix = el('span', { class: 'ie-slider-num-suffix' }, '%');
    const applyOpa = (val) => {
      const n = Math.max(0, Math.min(100, Math.round(Number(val) || 0)));
      ui.opacitySlider.value = String(n);
      ui.opacityNum.value = String(n);
      if (ctrl.rail) ctrl.rail.brushOpacity = n / 100; // H8-F2-P2: rail mirror
      const h = focusedSession(ctrl); if (h) { h.session.brushOpacity = n / 100; reapplyBrush(h.session); }
    };
    ui.opacitySlider.addEventListener('input', () => applyOpa(ui.opacitySlider.value));
    ui.opacityNum.addEventListener('input', () => applyOpa(ui.opacityNum.value));
    ui.opacityNum.addEventListener('change', () => applyOpa(ui.opacityNum.value));
    rail.appendChild(el('div', { class: 'ie-slider-block' }, [
      ui.opacitySlider,
      el('div', { class: 'ie-slider-num-row' }, [ui.opacityNum, opaSuffix]),
    ]));

    ui.fgSwatch.style.background = ctrl.prefs.fg; ui.bgSwatch.style.background = ctrl.prefs.bg;
    fgInput.value = ctrl.prefs.fg; bgInput.value = ctrl.prefs.bg;
    ui.fgSwatch.addEventListener('click', () => fgInput.click());
    ui.bgSwatch.addEventListener('click', () => bgInput.click());
    fgInput.addEventListener('input', () => {
      ui.fgSwatch.style.background = fgInput.value;
      if (ctrl.rail) ctrl.rail.fg = fgInput.value; // H8-F2-P2: rail mirror
      const h = focusedSession(ctrl); if (h) { h.session.fg = fgInput.value; reapplyBrush(h.session); }
    });
    bgInput.addEventListener('input', () => {
      ui.bgSwatch.style.background = bgInput.value;
      if (ctrl.rail) ctrl.rail.bg = bgInput.value; // H8-F2-P2: rail mirror
      const h = focusedSession(ctrl); if (h) { h.session.bg = bgInput.value;
        if (h.session.tool === 'fill') reapplyBrush(h.session); }
    });
    swap.addEventListener('click', () => doSwapColors(ctrl));
    reset.addEventListener('click', () => doResetColors(ctrl));
    return rail;
  }

  // ---- center pane ----
  function buildCenter(ctrl) {
    const ui = ctrl.ui;
    const center = el('div', { class: 'ie-center' });
    ui.queueBar = el('div', { class: 'ie-queue-bar' });
    ui.queueBar.appendChild(el('span', { class: 'ie-queue-label' }, 'Queue:'));
    center.appendChild(ui.queueBar);
    const wrap = el('div', { class: 'ie-canvas-wrap' });
    ui.wrap = wrap;
    ui.canvasHost = el('div', { class: 'ie-canvas-host' });
    ui.brushCursor = el('div', { class: 'ie-brush-cursor' });
    wrap.append(ui.canvasHost, ui.brushCursor);
    center.appendChild(wrap);
    return center;
  }

  // ---- source tray (LEGACY FALLBACK since H8-F2) ----
  // The Asset Composer panel (imageEditorAssetPanel.js) is the primary right
  // pane; this tray is only built if that module failed to load. Kept fully
  // functional (load/add/dropzone/resize/objects) for graceful degradation.
  function buildSourceTray(ctrl) {
    const ui = ctrl.ui;
    const tray = el('div', { class: 'ie-source' });
    tray.appendChild(el('div', { class: 'ie-source-title' }, 'Source image'));
    ui.sourceThumb = el('div', { class: 'ie-source-thumb-wrap' }, 'No image loaded');
    tray.appendChild(ui.sourceThumb);
    ui.sourceMeta = el('div', { class: 'ie-source-meta' }, '');
    tray.appendChild(ui.sourceMeta);
    const loadBtn = el('button', { class: 'ie-btn', title: 'Load a 2nd image from disc' }, 'Load…');
    const addBtn = el('button', { class: 'ie-btn', title: 'Add the loaded image to the canvas' }, '+ Add →');
    tray.append(loadBtn, addBtn);
    // R4.5 (PE-027 fix): set up the sourceThumb dropzone (dragover +
    // drop listeners for queue-thumb → source-image drag) EXACTLY
    // ONCE here. The pre-fix code re-attached the same listeners
    // on every refreshQueueBar call, accumulating 2N listeners
    // after N refreshes (and triggering the load N times per drop).
    if (window.ImageEditorSource && typeof window.ImageEditorSource.setupSourceThumbDropZone === 'function') {
      window.ImageEditorSource.setupSourceThumbDropZone(ctrl);
    }
    // Resize-canvas section (right panel) — built by imageEditorResize.js.
    if (window.ImageEditorResize && typeof window.ImageEditorResize.buildSection === 'function') {
      tray.appendChild(window.ImageEditorResize.buildSection(ctrl));
    }
    tray.appendChild(el('div', { class: 'ie-section-label', style: 'margin-top:6px;' }, 'Objects'));
    ui.objectsList = el('div', { class: 'ie-objects-list' });
    tray.appendChild(ui.objectsList);
    loadBtn.addEventListener('click', () => window.ImageEditorSource.onLoadSource(ctrl));
    addBtn.addEventListener('click', () => window.ImageEditorSource.onAddSource(ctrl));
    return tray;
  }

  // ============================================================
  // SESSION / SLOT MANAGEMENT
  // ============================================================
  // R4.4 (PE-002): show only the host for `slotId`, hide all
  // others. Idempotent. Null-safe (missing hosts map = no-op).
  function showOnlyHost(ctrl, slotId) {
    if (!ctrl || !ctrl.ui || !ctrl.ui.hosts) return;
    for (const id of Object.keys(ctrl.ui.hosts)) {
      const h = ctrl.ui.hosts[id];
      if (!h) continue;
      h.style.display = (id === slotId) ? '' : 'none';
    }
  }
  function activeSession(ctrl) {
    const slot = ctrl.queue[ctrl.activeIndex];
    return slot && slot.handle ? slot.handle : null;
  }
  function activeSlot(ctrl) { return ctrl.queue[ctrl.activeIndex]; }

  // ============================================================
  // H8-F2-P2 — ACTIVE-CANVAS FOCUS ROUTING
  // ============================================================
  // The rail (tool/size/opacity/colors), keyboard shortcuts, undo/redo and
  // the zoom bar act on the FOCUSED session. Focus follows the last canvas
  // clicked (accent outline via .ie-canvas-focus); switching queue slots
  // refocuses the main canvas. Footer Save/Bake/Heal/Remove-BG stay
  // main-canvas-only (explicit spec decision — the asset's export path is
  // "Send to canvas").
  function focusedSession(ctrl) {
    if (ctrl.activeCanvas === 'asset') {
      const P = ctrl.assetPanel;
      if (P && P.handle) return P.handle;
    }
    const slot = ctrl.queue[ctrl.activeIndex];
    return (slot && slot.handle) ? slot.handle : null;
  }
  function setFocus(ctrl, which) {
    if (ctrl.activeCanvas === which) return;
    ctrl.activeCanvas = which;
    const P = ctrl.assetPanel;
    if (ctrl.ui && ctrl.ui.wrap) ctrl.ui.wrap.classList.toggle('ie-canvas-focus', which === 'main');
    if (P && P.wrap) P.wrap.classList.toggle('ie-canvas-focus', which === 'asset');
    // Shared tools: push the rail's current tool + brush settings onto the
    // newly focused session so painting continues without a mode switch.
    const h = focusedSession(ctrl);
    if (h && ctrl.rail) {
      const s = h.session;
      s.brushSize = ctrl.rail.brushSize;
      s.brushOpacity = ctrl.rail.brushOpacity;
      s.fg = ctrl.rail.fg; s.bg = ctrl.rail.bg;
      try { window.ImageEditorTools.setTool(s, ctrl.rail.tool || 'pen'); } catch (_) {}
    }
    updateZoomLabel(ctrl);
  }

  // R4.5 (PE-035 fix): dispose all per-slot brush-cursor disposers
  // when the editor closes. Each slot stored a disposer on
  // `slot._brushCursorDisposer` (returned by installBrushCursor);
  // we call all of them + null out the wrap's current-session
  // reference. The wrap-level `mousemove` + `mouseleave` listeners
  // are GC'd when the wrap element is detached from the DOM
  // (the modal close removes it), so we don't need to manually
  // remove them here.
  function disposeAllListeners(ctrl) {
    if (!ctrl || !Array.isArray(ctrl.queue)) return;
    // PE-007: dispose every queue slot's Fabric session HERE (exactly once
    // — the handle is nulled so a second pass is a no-op). Pre-fix only the
    // confirmClose path disposed handles; the raw close path leaked them.
    for (const slot of ctrl.queue) {
      if (slot && slot.handle) {
        try { slot.handle.dispose(); } catch (_) {}
        slot.handle = null;
      }
      if (slot && slot._brushCursorDisposer) {
        try { slot._brushCursorDisposer(); } catch (_) {}
        slot._brushCursorDisposer = null;
      }
    }
    if (ctrl.ui && ctrl.ui.wrap) {
      ctrl.ui.wrap._ieCurrentSession = null;
    }
    // H8-F2: dispose the Asset panel's secondary Fabric session.
    if (window.ImageEditorAssetPanel && typeof window.ImageEditorAssetPanel.dispose === 'function') {
      try { window.ImageEditorAssetPanel.dispose(ctrl); } catch (_) {}
    }
  }

  // ============================================================
  // Issue-13 fix: PERSIST / RESTORE helpers
  // ============================================================
  // True when `_persisted` can serve this open request: no paths asked
  // (header button) or the asked paths exactly match the persisted queue
  // (same set, order-insensitive).
  function canRestorePersisted(paths) {
    if (!_persisted) return false;
    if (!paths || paths.length === 0) return true;
    const q = _persisted.ctrl.queue;
    if (q.length !== paths.length) return false;
    const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
    const have = q.map((s) => norm(s.path)).sort();
    const want = paths.map(norm).sort();
    for (let i = 0; i < have.length; i++) { if (have[i] !== want[i]) return false; }
    return true;
  }

  // Full teardown of the persisted session (memory guard / different image).
  function disposePersisted() {
    if (!_persisted) return;
    const p = _persisted; _persisted = null;
    try { disposeAllListeners(p.ctrl); } catch (_) {}
  }

  // Stash the live controller in `_persisted`: detach DOM + listeners but
  // KEEP every Fabric session (queue slots + asset panel + asset tabs).
  function persistEditorSession(ctrl) {
    // Memory guard: total persisted pixels capped at ~50 MP.
    let px = 0;
    for (const slot of ctrl.queue) {
      if (slot && slot.session) px += (slot.session.imgW || 0) * (slot.session.imgH || 0);
    }
    const P = ctrl.assetPanel;
    if (P && P.handle && P.handle.session) {
      px += (P.handle.session.imgW || 0) * (P.handle.session.imgH || 0);
      if (Array.isArray(P.tabs)) {
        for (const t of P.tabs) {
          if (t && t.handle && t.handle !== P.handle && t.handle.session) {
            px += (t.handle.session.imgW || 0) * (t.handle.session.imgH || 0);
          }
        }
      }
    }
    if (px > MAX_PERSISTED_PIXELS) {
      // QA-005 fix: inform the user instead of silently discarding their work.
      if (typeof toast === 'function') toast('Image too large to keep in memory (' + Math.round(px / 1e6) + ' MP). Session will not survive close.', 'warn', 8000);
      disposeAllListeners(ctrl); return;
    }
    // Brush-cursor disposers reference the dying wrap elements — dispose
    // them now (reinstalled on reopen). The Fabric sessions themselves
    // survive: their canvas-level listeners live on the canvas object,
    // which moves with its host element.
    for (const slot of ctrl.queue) {
      if (slot && slot._brushCursorDisposer) {
        try { slot._brushCursorDisposer(); } catch (_) {}
        slot._brushCursorDisposer = null;
      }
      // EFH2-002: remove stale canvas handlers (re-wired on reopen).
      if (slot && slot.session && Array.isArray(slot._canvasHandlers)) {
        slot._canvasHandlers.forEach((h) => { try { slot.session.canvas.off(h.event, h.fn); } catch (_) {} });
        slot._canvasHandlers = [];
        // QA-004 fix: mark as unwired so activateSlot re-wires on switch.
        slot._wired = false;
      }
    }
    if (P && P._brushCursorDisposer) {
      try { P._brushCursorDisposer(); } catch (_) {}
      P._brushCursorDisposer = null;
    }
    // Stash the live host divs (each wraps a Fabric canvas-container) and
    // the asset panel BEFORE the layout DOM is torn down by the modal close.
    ctrl._persistedHosts = (ctrl.ui && ctrl.ui.hosts) ? ctrl.ui.hosts : {};
    ctrl._persistedPanel = ctrl.assetPanel || null;
    if (ctrl.ui && ctrl.ui.wrap) ctrl.ui.wrap._ieCurrentSession = null;
    _persisted = { ctrl };
  }

  function reopenPersisted(newCtrl, opts) {
    if (!_persisted || !_persisted.ctrl) return false;
    const oldCtrl = _persisted.ctrl;
    _persisted = null;

    newCtrl.queue = oldCtrl.queue || [];
    newCtrl.activeIndex = Math.max(0, Math.min(newCtrl.queue.length - 1, oldCtrl.activeIndex || 0));
    newCtrl._persistedHosts = oldCtrl._persistedHosts || {};
    const oldPanel = oldCtrl._persistedPanel || null;
    oldCtrl._persistedPanel = null;
    if (oldCtrl.rail) newCtrl.rail = oldCtrl.rail;
    newCtrl.activeCanvas = oldCtrl.activeCanvas || 'main';

    if (!newCtrl.queue || newCtrl.queue.length === 0) {
      // QA-005 fix: an asset-only session (no main slots) is still valid.
      // Restore the asset panel if present instead of discarding the session.
      if (oldPanel && oldPanel.handle) {
        newCtrl.assetPanel = oldPanel;
        newCtrl.closed = false; newCtrl._closing = false;
        buildLayout(newCtrl);
        return true;
      }
      return false;
    }

    newCtrl.closed = false; newCtrl._closing = false;
    buildLayout(newCtrl);
    transplantAssetPanel(newCtrl, oldPanel);
    reattachPersistedHosts(newCtrl);
    wireKeyboard(newCtrl);
    restoreRailUI(newCtrl);
    reactivateSlotUI(newCtrl);
    return true;
  }

  // Move the persisted asset session (live handle + tabs) from the old
  // panel shell into the fresh one that buildLayout just created (build()
  // always creates a throwaway empty session — dispose it, then swap the
  // surviving canvas-container over; same detach/reattach pattern the
  // asset tabs already use in switchTab).
  function transplantAssetPanel(ctrl, oldP) {
    const P = ctrl.assetPanel;
    if (!P) return;
    if (!oldP || !oldP.handle) { if (oldP) { try { window.ImageEditorAssetPanel.dispose({ assetPanel: oldP }); } catch (_) {} } return; }
    // Dispose the throwaway fresh session from build().
    if (P.handle) { try { P.handle.dispose(); } catch (_) {} P.handle = null; }
    // Clear the ASSET shell's host (replaceChildren — NOT the PE-002 bug
    // pattern on the main canvasHost; this only drops the throwaway empty
    // session's canvas-container before the persisted one moves in).
    if (typeof P.canvasHost.replaceChildren === 'function') P.canvasHost.replaceChildren();
    const containerEl = oldP.canvasHost.firstElementChild; // fabric canvas-container
    if (containerEl) P.canvasHost.appendChild(containerEl);
    P.handle = oldP.handle;
    P.path = oldP.path;
    P.revision = oldP.revision || 0;
    if (oldP.meta && P.meta) P.meta.textContent = oldP.meta.textContent;
    if (P.brushCursor && window.ImageEditorTools && window.ImageEditorTools.installBrushCursor) {
      P._brushCursorDisposer = window.ImageEditorTools.installBrushCursor(P.handle.session, P.wrap, P.brushCursor);
    }
    try { P.handle.session.canvas.requestRenderAll(); } catch (_) {}
    // Transplant the tab sessions (each { handle, canvasEl, path, metaText }).
    if (Array.isArray(oldP.tabs)) {
      P.tabs = oldP.tabs;
      P.tabIndex = oldP.tabIndex || 0;
      for (const t of P.tabs) {
        if (t && t.canvasEl && t.handle) {
          try { t.handle.session.canvas.requestRenderAll(); } catch (_) {}
        }
      }
      if (P.tabButtons) {
        for (let i = 0; i < P.tabButtons.length; i++) {
          P.tabButtons[i].classList.toggle('active', i === P.tabIndex);
        }
      }
    }
    // The old shell's DOM dies with the old layout; null its live refs so
    // nothing can double-dispose the transplanted handle.
    oldP.handle = null; oldP.tabs = null;
  }

  // Move the persisted queue-slot host divs into the new canvasHost and
  // rebuild the hosts map.
  function reattachPersistedHosts(ctrl) {
    const hosts = ctrl._persistedHosts || {};
    ctrl._persistedHosts = null;
    ctrl.ui.hosts = {};
    for (const id of Object.keys(hosts)) {
      const hostEl = hosts[id];
      if (!hostEl) continue;
      ctrl.ui.canvasHost.appendChild(hostEl);
      ctrl.ui.hosts[id] = hostEl;
    }
  }

  // Push the persisted rail values (tool/colors/size/opacity/format) back
  // onto the freshly built rail widgets.
  function restoreRailUI(ctrl) {
    const ui = ctrl.ui;
    const rail = ctrl.rail || {};
    for (const k in ui.tools) ui.tools[k].classList.toggle('active', k === rail.tool);
    ui.fgSwatch.style.background = rail.fg || '#000000';
    ui.bgSwatch.style.background = rail.bg || '#ffffff';
    ui.sizeSlider.value = String(rail.brushSize || 12);
    ui.sizeNum.value = String(rail.brushSize || 12);
    ui.opacitySlider.value = String(Math.round((rail.brushOpacity != null ? rail.brushOpacity : 1) * 100));
    ui.opacityNum.value = String(Math.round((rail.brushOpacity != null ? rail.brushOpacity : 1) * 100));
    if (ui.formatSel) ui.formatSel.value = ctrl.prefs.outFormat || 'png';
  }

  // Re-sync the slot UI (focus outline, brush cursor, meta, queue bar,
  // objects list, zoom label) after re-attach.
  function reactivateSlotUI(ctrl) {
    if (ctrl.queue.length === 0) {
      showEmptyPrompt(ctrl);
      return;
    }
    if (ctrl.activeIndex < 0 || ctrl.activeIndex >= ctrl.queue.length) ctrl.activeIndex = 0;
    const slot = ctrl.queue[ctrl.activeIndex];
    const which = ctrl.activeCanvas || 'main';
    ctrl.activeCanvas = null; // force resync (new DOM has no focus classes)
    setFocus(ctrl, which);
    if (slot && slot.handle) {
      showOnlyHost(ctrl, slot.id);
      if (slot._brushCursorDisposer) {
        try { slot._brushCursorDisposer(); } catch (_) {}
        slot._brushCursorDisposer = null;
      }
      slot._brushCursorDisposer = window.ImageEditorTools.installBrushCursor(
        slot.session, ctrl.ui.wrap, ctrl.ui.brushCursor
      );
      // EFH2-002: re-wire canvas events with the fresh controller.
      wireCanvasEvents(ctrl, slot);
      // QA-004 reconciliation: reactivateSlotUI has just wired this slot,
      // so mark it wired. Without this, `_wired` stays false (set false
      // during persist) and the next activateSlot() switch away-and-back
      // re-wires AGAIN, double-attaching every canvas handler -> mouse:down
      // fires twice -> pushUndo runs twice per stroke (undo depth doubles),
      // pipette toasts twice, and marquee/select logic runs twice.
      slot._wired = true;
      if (window.ImageEditorCropSelection) window.ImageEditorCropSelection.syncButton(ctrl);
      if (window.ImageEditorSelect) window.ImageEditorSelect.updateSelectionChip(ctrl, slot._healSelVisible || null, activeSlotFn(ctrl));
      refreshMeta(ctrl);
      window.ImageEditorSource.refreshQueueBar(ctrl);
      window.ImageEditorSource.refreshObjectsList(ctrl);
      updateZoomLabel(ctrl);
    }
    requestAnimationFrame(() => fitActive(ctrl));
  }

  function activateSlot(ctrl, index) {
    const slot = ctrl.queue[index];
    if (!slot) return Promise.resolve();
    // R4.5 (PE-035 fix): remember the previously active slot so
    // we can dispose its brush-cursor canvas listener when we
    // install the new one. The wrap-level listeners are
    // idempotent (one-time install), so we don't need to
    // re-attach them — only the per-canvas `ie:viewport`
    // listener must move from the old slot's canvas to the new.
    ctrl._prevActiveSlot = ctrl.queue[ctrl.activeIndex] || null;
    ctrl.activeIndex = index;
    // H8-F2-P2: switching queue slots refocuses the main canvas (the rail
    // syncs to the new slot's tool via setActiveTool below).
    setFocus(ctrl, 'main');
    // R4.4 (PE-002 fix): persistent host per slot. Each slot has
    // its own host div (containing its canvas) that lives in
    // canvasHost forever — only one host is visible at a time.
    // This fixes the A→B→A bug: when re-activating A, A's host is
    // still attached to canvasHost (just hidden), so its canvas
    // is still visible. The previous code called
    // `canvasHost.textContent = ''` which detached A's canvas.
    if (slot.handle) { // re-activating an already-live slot
      // QA-004 fix: re-wire canvas handlers if they were removed during persist.
      if (slot._wired === false && slot.session) {
        wireCanvasEvents(ctrl, slot);
        slot._wired = true;
      }
      // Show the existing host, hide all others.
      showOnlyHost(ctrl, slot.id);
      refreshMeta(ctrl); window.ImageEditorSource.refreshQueueBar(ctrl);
      // PE-029: refresh objects list on slot switch.
      window.ImageEditorSource.refreshObjectsList(ctrl);
      try { const _m = ctrl.modal || document.querySelector('.image-editor-modal'); if (_m) _m.querySelectorAll('.ie-resize-section').forEach(sec => sec.refreshDims && sec.refreshDims()); } catch (_) {} // KGO6-007
      // H8-005: clear any persistent selection from the previously-active slot
      // when switching queue slots (a selection belongs to one image).
      // R4.4.AuditFix-P-R44-05: defensive check — ImageEditorSelect.js
      // is a separate module that may not be loaded yet in early
      // boot paths. Without this guard, a TypeError "Cannot read
      // properties of undefined (reading 'clearSelectionExcept')"
      // would crash the slot switch.
      if (window.ImageEditorSelect) {
        window.ImageEditorSelect.clearSelectionExcept(ctrl, slot);
        window.ImageEditorSelect.updateSelectionChip(ctrl, slot._healSelVisible || null, activeSlotFn(ctrl));
      }
      // R4.5 (PE-035 fix): dispose the previous slot's brush-cursor
      // canvas listener before installing the new one. The wrap
      // listeners are idempotent (one-time install inside
      // installBrushCursor).
      const prevSlot = ctrl._prevActiveSlot;
      if (prevSlot && prevSlot !== slot && prevSlot._brushCursorDisposer) {
        try { prevSlot._brushCursorDisposer(); } catch (_) {}
        prevSlot._brushCursorDisposer = null;
      }
      slot._brushCursorDisposer = window.ImageEditorTools.installBrushCursor(
        slot.session, ctrl.ui.wrap, ctrl.ui.brushCursor
      );
      setActiveTool(ctrl, slot.session.tool || ctrl.prefs.tool);
      return Promise.resolve();
    }
    // Create a new host for this slot, append to canvasHost, and
    // hide all other hosts.
    const host = document.createElement('div');
    host.className = 'ie-slot-host';
    host.style.cssText = 'position: absolute; inset: 0; display: none;';
    host.setAttribute('data-slot-id', slot.id);
    const canvasEl = el('canvas', {});
    host.appendChild(canvasEl);
    ctrl.ui.canvasHost.appendChild(host);
    if (!ctrl.ui.hosts) ctrl.ui.hosts = {};
    ctrl.ui.hosts[slot.id] = host;
    showOnlyHost(ctrl, slot.id);
    let handle = null; // PE-039: hoisted so the catch can dispose it
    return loadImageFromFile(slot.path).then((img) => {
      if (ctrl.closed) return;
      // PE-043: pixel/memory guard. Fabric + Canvas + DataURL + Base64
      // materialise the image multiple times (RGBA buffer × ~4). Reject
      // images above 80 MP so the renderer shows a controlled error
      // instead of an OOM crash.
      const mp = (img.naturalWidth || 1) * (img.naturalHeight || 1);
      if (mp > 80e6) {
        throw new Error('Image too large (' + Math.round(mp / 1e6) + ' MP). The editor supports up to ~80 MP (e.g. 8944×8944). Resize the image first.');
      }
      handle = window.ImageEditorCanvas.createEditorSession(canvasEl, img.naturalWidth || 1, img.naturalHeight || 1);
      // PE-039: configure the session but do NOT commit the handle to
      // the slot yet. If setBaseImage fails, the handle is disposed
      // without ever being visible to the rest of the editor.
      handle.session.brushSize = ctrl.prefs.brushSize;
      handle.session.brushOpacity = ctrl.prefs.brushOpacity;
      handle.session.fg = ctrl.prefs.fg; handle.session.bg = ctrl.prefs.bg;
      return handle.setBaseImage(img).then(() => {
        // PE-039: commit handle ONLY after successful base-load.
        slot.handle = handle; slot.session = handle.session;
        setActiveTool(ctrl, ctrl.prefs.tool);
        // R4.5 (PE-035 fix): dispose the previous slot's brush
        // cursor (canvas listener) before installing the new one.
        // The wrap-level listeners are attached once via the
        // idempotent guard inside installBrushCursor.
        if (ctrl._prevActiveSlot && ctrl._prevActiveSlot !== slot
            && ctrl._prevActiveSlot._brushCursorDisposer) {
          try { ctrl._prevActiveSlot._brushCursorDisposer(); } catch (_) {}
          ctrl._prevActiveSlot._brushCursorDisposer = null;
        }
        slot._brushCursorDisposer = window.ImageEditorTools.installBrushCursor(
          slot.session, ctrl.ui.wrap, ctrl.ui.brushCursor
        );
        wireCanvasEvents(ctrl, slot);
        refreshMeta(ctrl);
        // KGO4-011: pre-fill Resize panel dims. KGO6-007: use ctrl.modal.
        try { const _m2 = ctrl.modal || document.querySelector('.image-editor-modal'); if (_m2) _m2.querySelectorAll('.ie-resize-section').forEach(sec => sec.refreshDims && sec.refreshDims()); } catch (_) {}
        window.ImageEditorSource.refreshQueueBar(ctrl);
        // R4.3 (PE-003): hide the empty-prompt only AFTER a
        // successful base-decode and session-commit. Calling this
        // INSIDE the .then() (not the .catch()) ensures a load
        // failure leaves the prompt visible + re-bedienbar.
        if (window.ImageEditorKeyboard && window.ImageEditorKeyboard.hideEmptyPrompt) {
          window.ImageEditorKeyboard.hideEmptyPrompt(ctrl);
        }
      });
    }).catch((e) => {
      // R4.4: on load failure, remove the host we just created
      // (the slot is in a "failed-to-load" state — no point keeping
      // an empty host around). The slot itself stays in the queue
      // (so the user can re-try by clicking the queue thumbnail,
      // which would call activateSlot again and re-create the host).
      try { if (host.parentNode) host.parentNode.removeChild(host); } catch (_) {}
      delete ctrl.ui.hosts[slot.id];
      // PE-039: dispose the uncommitted handle (Fabric canvas + listeners)
      // so it doesn't leak. The handle was never assigned to slot.handle.
      try { if (handle && handle.dispose) handle.dispose(); } catch (_) {}
      slot.handle = null; slot.session = null;
      toast('Failed to load image: ' + (e && e.message || e), 'err', 6000);
      // R4.3 (PE-003): reset the empty-prompt so the user can try
      // again. Without this, the prompt stays in 'loading' state
      // forever after a load failure (button disabled).
      if (window.ImageEditorKeyboard && window.ImageEditorKeyboard.resetEmptyPrompt) {
        window.ImageEditorKeyboard.resetEmptyPrompt(ctrl);
      }
    });
  }

  function wireCanvasEvents(ctrl, slot) {
    const handle = slot.handle, session = slot.session;
    const Tools = window.ImageEditorTools;
    const sceneOf = (opt) => Tools.scenePointOf(session.canvas, opt, session.imgW, session.imgH);
    // EFH2-002: track handlers for removal on persist.
    if (!Array.isArray(slot._canvasHandlers)) slot._canvasHandlers = [];
    const trackOn = (event, fn) => { session.canvas.on(event, fn); slot._canvasHandlers.push({ event, fn }); };
    trackOn('mouse:up', () => {
      if (session.canvas.isDrawingMode) {
        // R5.2 Stroke: pushUndo moved to mouse:down (PRE-SNAPSHOT).
        // Pre-fix, the post-stroke state was pushed here so undo
        // restored to the same state (no visible change).
        //
        // R5.2.AuditFix P-R52-T02/T03: cancel-cleanup. If no path
        // was created (click-without-drag), pop the pre-snapshot
        // by comparing object count to _preStrokeObjectCount.
        if (session._preStrokeObjectCount != null
            && session.canvas.getObjects().length === session._preStrokeObjectCount) {
          try { session._undo.pop(); } catch (_) { /* defensive */ }
        } else {
          // BUG #12: only mark modified when a stroke was actually created
          // (click-without-drag pops the pre-snapshot above, no dirty flag).
          slot.modified = true;
          window.ImageEditorSource.refreshQueueBar(ctrl);
        }
        delete session._preStrokeObjectCount;
      }
    });
    trackOn('mouse:down', (opt) => { // pipette sample (scene coords — H8-007)
      // PE-034: suppress all drawing/tool actions while Space-pan is
      // active. Without this, holding Space and clicking would start a
      // paint stroke AND pan simultaneously.
      if (ctrl._spacePan) return;
      // R5.2 Stroke: PRE-SNAPSHOT for drawing tools. Capture
      // the canvas state BEFORE the stroke starts. This way,
      // the user can undo a single time to restore the
      // pixel-exact pre-stroke state (PE-005-Pixelvertrag).
      // The pushUndo is wrapped in a try/catch so a malformed
      // session doesn't crash the editor.
      //
      // R5.2.AuditFix P-R52-T02/T03: also record the
      // _preStrokeObjectCount so the mouse:up handler can
      // detect a click-without-drag (no path created) and
      // pop the pre-snapshot.
      if (session.canvas.isDrawingMode) {
        session._preStrokeObjectCount = session.canvas.getObjects().length;
        try { Tools.pushUndo(session); } catch (_) { /* defensive */ }
      }
      if (session.tool === 'pipette' && opt) {
        const p = sceneOf(opt);
        const c = Tools.pickColorAt(session, p.x, p.y);
        if (c) {
          const hex = '#' + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('');
          session.fg = hex; ctrl.ui.fgSwatch.style.background = hex;
          toast('Picked color ' + hex.toUpperCase(), 'ok', 1500);
        }
      }
      // heal-select: start dragging a rectangle in SCENE coordinates (H8-007).
      // The previous code passed opt.pointer (viewport coords) so the rect —
      // placed in scene coords — landed at pointer/zoom away from the cursor.
      if (session.tool === 'heal' && opt) {
        window.ImageEditorSelect.startMarqueeDrag(ctrl, slot, sceneOf(opt), { autoPopover: true }, activeSlotFn(ctrl));
      }
      // H8-005: dedicated select tool — drag keeps a persistent selection.
      if (session.tool === 'select' && opt) {
        window.ImageEditorSelect.startMarqueeDrag(ctrl, slot, sceneOf(opt), { autoPopover: false }, activeSlotFn(ctrl));
      }
      // H8-002: bar tool — two-click placement in scene coords.
      if (session.tool === 'bar' && opt) {
        window.ImageEditorShapes.onMouseDown(ctrl, sceneOf(opt), activeSlotFn(ctrl), Tools, opt.e); // PE-036: pass native event for button check
      }
    });
    // H8-002: live preview while placing a bar.
    trackOn('mouse:move', (opt) => {
      if (session.tool === 'bar' && opt) {
        window.ImageEditorShapes.onMouseMove(ctrl, sceneOf(opt), activeSlotFn(ctrl));
      }
    });
    // PE-036: right-click cancels a pending bar placement (real cancel
    // path instead of the previous no-op). Also suppresses the browser
    // context menu while the editor is open.
    trackOn('mouse:down', (opt) => {
      if (opt && opt.e && opt.e.button === 2 && session.tool === 'bar') {
        window.ImageEditorShapes.cancel(ctrl, activeSlotFn(ctrl));
      }
    });
    // The wheel (zoom) listener is attached ONCE in buildLayout, not here —
    // attaching it per-slot would stack a new listener on every queue switch,
    // so a single wheel tick would zoom N times after N switches.
    //
    // R5.2 Transform: PRE-SNAPSHOT for move/scale/rotate. Pre-fix, the
    // object:modified handler did NOT push undo. The user could move,
    // scale, or rotate an object but could not undo the transform
    // (the undo stack was empty for transforms). Post-R5.2: push
    // undo on mousedown (when an object is selected) + cancel on
    // mouseup if the object was not actually transformed (click-
    // without-drag or click-elsewhere cleanup). Same pattern as
    // R5.2 Stroke (pre-snapshot on action-start, cancel on
    // action-end if no actual action).
    trackOn('mouse:down', (opt) => {
      const active = session.canvas.getActiveObject();
      if (active) {
        // R5.2 Transform: PRE-SNAPSHOT before the user drags
        // the object. Wrapped in try/catch defensive.
        try { Tools.pushUndo(session); } catch (_) { /* defensive */ }
        session._preTransformObject = active;
      }
    });
    trackOn('mouse:up', () => {
      // R5.2 Transform: cancel-cleanup. If no object:modified
      // fired between mousedown and mouseup, the click was a
      // select/deselect (not a transform). Pop the pre-snapshot
      // to avoid polluting the undo stack with useless entries.
      if (session._preTransformObject) {
        try { session._undo.pop(); } catch (_) { /* defensive */ }
        session._preTransformObject = null;
      }
    });
    trackOn('object:modified', () => {
      // R5.2 Transform: the pre-snapshot is committed. Just
      // clear the flag + update UI.
      session._preTransformObject = null;
      slot.modified = true;
      window.ImageEditorSource.refreshObjectsList(ctrl);
      window.ImageEditorSource.refreshQueueBar(ctrl);
    });
    trackOn('selection:created', () => window.ImageEditorSource.refreshObjectsList(ctrl));
    trackOn('selection:updated', () => window.ImageEditorSource.refreshObjectsList(ctrl));
  }

  const activeSlotFn = (ctrl) => () => activeSlot(ctrl);

  function fitActive(ctrl) {
    if (ctrl.activeCanvas === 'asset' && ctrl.assetPanel?.handle) {
      ctrl.assetPanel.handle.fitToContainer(ctrl.assetPanel.wrap); updateZoomLabel(ctrl); return;
    }
    const h = activeSession(ctrl);
    if (h) { h.fitToContainer(ctrl.ui.wrap); updateZoomLabel(ctrl); }
  }
  function updateZoomLabel(ctrl) {
    const h = focusedSession(ctrl);
    if (h) ctrl.ui.zoomLabel.textContent = Math.round(h.session.zoom * 100) + '%';
  }
  function refreshMeta(ctrl) {
    const slot = activeSlot(ctrl);
    ctrl.ui.meta.textContent = slot ? (slot.name + ' · ' + slot.session.imgW + '×' + slot.session.imgH) : '';
  }

  function setActiveTool(ctrl, tool) {
    if (ctrl.rail) ctrl.rail.tool = tool;
    const h = focusedSession(ctrl);
    if (h) window.ImageEditorTools.setTool(h.session, tool);
    for (const k in ctrl.ui.tools) ctrl.ui.tools[k].classList.toggle('active', k === tool);
    if (window.ImageEditorShapes && tool !== 'bar') window.ImageEditorShapes.cancel(ctrl, activeSlotFn(ctrl));
  }
  function reapplyBrush(session) { window.ImageEditorTools.setTool(session, session.tool || 'pen'); }
  function doSwapColors(ctrl) {
    const h = focusedSession(ctrl); if (!h) return;
    const s = h.session, t = s.fg; s.fg = s.bg; s.bg = t;
    if (ctrl.rail) { ctrl.rail.fg = s.fg; ctrl.rail.bg = s.bg; }
    ctrl.ui.fgSwatch.style.background = s.fg; ctrl.ui.bgSwatch.style.background = s.bg;
    reapplyBrush(s);
  }
  function doResetColors(ctrl) {
    const h = focusedSession(ctrl); if (!h) return;
    h.session.fg = '#000000'; h.session.bg = '#ffffff';
    if (ctrl.rail) { ctrl.rail.fg = '#000000'; ctrl.rail.bg = '#ffffff'; }
    ctrl.ui.fgSwatch.style.background = '#000000'; ctrl.ui.bgSwatch.style.background = '#ffffff';
    reapplyBrush(h.session);
  }

  function confirmClose(ctrl) { window.ImageEditorKeyboard.confirmClose(ctrl); }
  function showEmptyPrompt(ctrl) { window.ImageEditorKeyboard.showEmptyPrompt(ctrl); }
  function wireKeyboard(ctrl) { window.ImageEditorKeyboard.wireKeyboard(ctrl); }
  function openCheatsheet() { window.ImageEditorCheatsheet?.openCheatsheet(); }

  // ============================================================
  // EXPORT
  // ============================================================
  window.ImageOverlays = window.ImageOverlays || {};
  window.ImageOverlays.showImageEditOverlay = showImageEditOverlay;
  window.showImageEditOverlay = showImageEditOverlay;
  // Exposed so the resize module can refresh the header meta after a canvas
  // resize (imgW/imgH changed).
  window.ImageEditorOverlay = { refreshMeta };
})();
