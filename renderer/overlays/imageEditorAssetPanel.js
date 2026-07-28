// renderer/overlays/imageEditorAssetPanel.js (H8-F2 — Asset Composer)
// Right-hand panel of the pixel editor, replacing the old "Source image" tray
// (imageEditorOverlay.buildSourceTray) as the PRIMARY right pane: a live
// secondary Fabric canvas instead of a static thumbnail.
//
// F2-P1 (this slice): panel shell + asset canvas + Load + Send to canvas +
// collapse/persist + dispose. The old tray stays in imageEditorOverlay.js as
// a DEFENSIVE FALLBACK (used only if this module failed to load) — this also
// keeps the R4.5/R5.2 gate invariants (buildSourceTray/onAddSource/
// setupSourceThumbDropZone) alive and tested.
//
// Later phases build on this module:
//   F2-P2: active-canvas focus routing (tools/sliders/keyboard → focused session)
//   F2-P3: Generate… popover + history strip (imageEditorAssetGen.js)
//   F2-P4: ✂ Remove BG on the panel + polish (pipeline extracted to
//          imageEditorAssetBg.js to keep this shell under the 500-line cap)
//
// Depends on globals: el (DomHelpers), toast, loadImageFromFile (pureFuncs),
// window.ImageEditorCanvas (session factory), window.ImageEditorTools
// (pushUndo), window.ImageEditorSource (queue-bar / objects-list refresh),
// window.ImageEditorResize (resize section), window.api.pickFile.

(function () {
  'use strict';

  // Empty-panel working size (matches the Generate popover default, F2-P3).
  const DEFAULT_W = 512, DEFAULT_H = 512;

  function baseName(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    return slash >= 0 ? norm.slice(slash + 1) : norm;
  }

  // Panel state lives on the controller so every companion module can reach
  // it (P2 focus routing, P3 generate, P4 remove-bg).
  function panelOf(ctrl) { return (ctrl && ctrl.assetPanel) ? ctrl.assetPanel : null; }

  // ============================================================
  // BUILD — panel DOM (header + asset canvas + actions + resize + objects)
  // ============================================================
  function build(ctrl) {
    const P = {
      ctrl,
      root: null, body: null, wrap: null, canvasHost: null, meta: null,
      collapseBtn: null,
      handle: null,   // session handle from ImageEditorCanvas.createEditorSession
      path: null,     // on-disk path of the loaded asset (null = empty panel)
      collapsed: ctrl.prefs.assetPanelCollapsed === true,
    };
    ctrl.assetPanel = P;

    const panel = el('div', { class: 'ie-asset-panel' });
    P.root = panel;

    // ---- header ("Asset" + collapse toggle) ----
    const header = el('div', { class: 'ie-asset-header' });
    header.appendChild(el('span', { class: 'ie-asset-title' }, 'Asset'));
    // F2-P4 polish: registry-backed hover help (topic editor.asset) — same
    // pattern the cheatsheet references ("hover the ? icons").
    if (typeof window.helpButton === 'function') {
      try { header.appendChild(window.helpButton('editor.asset')); } catch (_) {}
    }
    P.collapseBtn = el('button', {
      class: 'ie-asset-collapse',
      title: 'Collapse / expand the asset panel',
      'aria-label': 'Collapse or expand the asset panel',
    }, P.collapsed ? '«' : '»');
    P.collapseBtn.addEventListener('click', () => toggleCollapse(ctrl));
    header.appendChild(P.collapseBtn);
    panel.appendChild(header);

    // Issue-12 fix: expand strip — a thin vertical tab shown ONLY while the
    // panel is collapsed (CSS: .ie-asset-panel.collapsed .ie-asset-expand).
    // Pre-fix there was NO way to re-expand a collapsed panel (the header's
    // » button overflowed the 34px rail and was unreachable), and the 24px
    // help button spilled outside the overlay bounds. The collapsed state
    // now hides the whole header and shows this strip instead.
    P.expandStrip = el('button', {
      class: 'ie-asset-expand',
      title: 'Expand the asset panel',
      'aria-label': 'Expand the asset panel',
    }, [el('span', { class: 'ie-asset-expand-icon' }, '«'), el('span', { class: 'ie-asset-expand-label' }, 'Asset')]);
    P.expandStrip.addEventListener('click', () => toggleCollapse(ctrl));
    panel.appendChild(P.expandStrip);

    // ---- body ----
    const body = el('div', { class: 'ie-asset-body' });
    P.body = body;

    // 0) Asset tabs (H8-F2 C2): 3 switchable slots, each its own session.
    if (window.ImageEditorAssetExtras && window.ImageEditorAssetExtras.buildTabRow) {
      body.appendChild(window.ImageEditorAssetExtras.buildTabRow(ctrl));
    }

    // 1) Asset canvas — its own Fabric session (checkerboard underlay via CSS,
    //    own undo stack, wheel-zoom, auto-fit on load).
    P.wrap = el('div', { class: 'ie-asset-canvas-wrap' });
    P.canvasHost = el('div', { class: 'ie-asset-canvas-host' });
    // F2-P2: second brush-outline cursor for the asset canvas (the main wrap
    // has its own; installBrushCursor keys its wrap-level listeners per wrap).
    P.brushCursor = el('div', { class: 'ie-brush-cursor' });
    P.wrap.append(P.canvasHost, P.brushCursor);
    body.appendChild(P.wrap);
    // F2-P2: clicking the asset canvas focuses it (accent outline). Attached
    // here (before wireKeyboard's pan listener) so focus resolves first.
    P.wrap.addEventListener('mousedown', () => {
      if (typeof ctrl.setFocus === 'function') ctrl.setFocus('asset');
    });
    // H8-F2 C6: right-click context menu on the asset canvas.
    P.wrap.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (window.ImageEditorAssetExtras && window.ImageEditorAssetExtras.openContextMenu) {
        window.ImageEditorAssetExtras.openContextMenu(ctrl, ev.clientX, ev.clientY);
      }
    });

    P.meta = el('div', { class: 'ie-asset-meta' }, 'No asset loaded · ' + DEFAULT_W + '×' + DEFAULT_H);
    body.appendChild(P.meta);

    // 2) Action row 1: Load + Generate… (F2-P3: the popover lives in
    //    imageEditorAssetGen.js; the button degrades to a toast if that
    //    module failed to load).
    const row1 = el('div', { class: 'ie-asset-actions' });
    const loadBtn = el('button', {
      class: 'ie-btn',
      title: 'Load an image into the asset canvas',
      'aria-label': 'Load an image into the asset canvas',
    }, '📂 Load…');
    loadBtn.addEventListener('click', () => onLoadAsset(ctrl));
    row1.appendChild(loadBtn);
    const genBtn = el('button', {
      class: 'ie-btn',
      title: 'Generate a new asset with the image model (MiniMax image-01)',
      'aria-label': 'Generate a new asset with the image model',
    }, '✨ Generate…');
    genBtn.addEventListener('click', () => {
      if (window.ImageEditorAssetGen && typeof window.ImageEditorAssetGen.openGeneratePopover === 'function') {
        window.ImageEditorAssetGen.openGeneratePopover(ctrl);
      } else {
        toast('Generation module not available.', 'warn');
      }
    });
    row1.appendChild(genBtn);
    body.appendChild(row1);

    // 3) Action row 2: Send to canvas (primary) + ✂ Remove BG (F2-P4).
    const row2 = el('div', { class: 'ie-asset-actions' });
    const sendBtn = el('button', {
      class: 'ie-btn primary',
      title: 'Composite the asset and place it on the main canvas',
      'aria-label': 'Send the asset to the main canvas',
    }, '→ Send to canvas');
    sendBtn.addEventListener('click', () => sendToCanvas(ctrl));
    row2.appendChild(sendBtn);
    P.removeBgBtn = el('button', {
      class: 'ie-btn',
      title: 'Remove the background of the asset (keeps transparency)',
      'aria-label': 'Remove the asset background',
    }, '✂ Remove BG');
    P.removeBgBtn.addEventListener('click', () => removeBgOnAsset(ctrl));
    row2.appendChild(P.removeBgBtn);
    body.appendChild(row2);

    // 3b) History strip (F2-P3): thumbnails of the last 8 generated/loaded
    //     assets; click to reload into the asset canvas. Populated by
    //     ImageEditorAssetGen.pushHistory/renderHistory.
    body.appendChild(el('div', { class: 'ie-section-label', style: 'margin-top:6px;' }, 'History'));
    P.historyStrip = el('div', { class: 'ie-asset-history' });
    P.historyStrip.appendChild(el('span', { class: 'ie-asset-history-empty' }, '—'));
    body.appendChild(P.historyStrip);

    // 3c) Extras (H8-F2 C3/C5/C7/C8): row 3 (⇄ Swap, 💾 Export…, 🩹 Heal) +
    //     placement section (opacity / blend preview for placed objects).
    if (window.ImageEditorAssetExtras && window.ImageEditorAssetExtras.buildExtraSections) {
      body.appendChild(window.ImageEditorAssetExtras.buildExtraSections(ctrl));
    }

    // 4) Resize-canvas section (operates on the MAIN canvas, as before).
    if (window.ImageEditorResize && typeof window.ImageEditorResize.buildSection === 'function') {
      body.appendChild(window.ImageEditorResize.buildSection(ctrl));
    }

    // 5) Objects list (follows the MAIN canvas, as before — refreshObjectsList
    //    reads ctrl.ui.objectsList).
    body.appendChild(el('div', { class: 'ie-section-label', style: 'margin-top:6px;' }, 'Objects'));
    ctrl.ui.objectsList = el('div', { class: 'ie-objects-list' });
    body.appendChild(ctrl.ui.objectsList);

    panel.appendChild(body);

    // Wheel-to-cursor zoom on the asset canvas (own listener — the main
    // wrap's wheel handler only drives the main session).
    P.wrap.addEventListener('wheel', (e) => {
      if (!P.handle) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const rect = P.wrap.getBoundingClientRect();
      P.handle.zoomAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, factor);
    }, { passive: false });

    // Queue-filmstrip "drag thumb → tray" now loads into the ASSET canvas.
    setupAssetDropZone(ctrl, P);

    // Initial empty session so the panel is immediately paint-ready (P2).
    createAssetSession(ctrl, DEFAULT_W, DEFAULT_H);
    applyCollapsed(P);

    // Fit once the panel is in the DOM (build() returns before append).
    requestAnimationFrame(() => {
      if (P.handle && !P.collapsed && P.wrap.clientWidth > 0) P.handle.fitToContainer(P.wrap);
    });

    return panel;
  }

  // ============================================================
  // SESSION LIFECYCLE
  // ============================================================
  // Create (or re-create) the asset Fabric session at w×h. Disposes any
  // previous handle and swaps in a fresh <canvas> element (Fabric mutates its
  // host element, so a new session gets a new element — same pattern as
  // imageEditorOverlay.activateSlot).
  function createAssetSession(ctrl, w, h) {
    const P = panelOf(ctrl); if (!P) return null;
    if (P.handle) { try { P.handle.dispose(); } catch (_) {} P.handle = null; }
    P.canvasHost.textContent = '';
    const canvasEl = el('canvas', {});
    P.canvasHost.appendChild(canvasEl);
    const handle = window.ImageEditorCanvas.createEditorSession(canvasEl, w, h);
    // Sync brush prefs (same defaults activateSlot applies to main slots).
    const s = handle.session;
    s.brushSize = ctrl.prefs.brushSize;
    s.brushOpacity = ctrl.prefs.brushOpacity;
    s.fg = ctrl.prefs.fg; s.bg = ctrl.prefs.bg;
    P.handle = handle;
    // F2-P2: (re-)install the brush-outline cursor for the new session — the
    // per-canvas ie:viewport listener moves with the session (R4.5 disposer
    // pattern). Then make the canvas drawing-ready with the rail's tool.
    if (P._brushCursorDisposer) {
      try { P._brushCursorDisposer(); } catch (_) {}
      P._brushCursorDisposer = null;
    }
    if (P.brushCursor && window.ImageEditorTools && window.ImageEditorTools.installBrushCursor) {
      P._brushCursorDisposer = window.ImageEditorTools.installBrushCursor(s, P.wrap, P.brushCursor);
    }
    if (window.ImageEditorTools && window.ImageEditorTools.setTool) {
      try { window.ImageEditorTools.setTool(s, (ctrl.rail && ctrl.rail.tool) || 'pen'); } catch (_) {}
    }
    return handle;
  }

  // Load an on-disk image into the asset canvas (rebuilds the session at the
  // image's natural size, sets it as base, auto-fits). Returns a Promise.
  function loadAssetFromPath(ctrl, path) {
    const P = panelOf(ctrl); if (!P) return Promise.resolve();
    P.meta.textContent = 'Loading…';
    return loadImageFromFile(path).then((img) => {
      if (ctrl.closed) return;
      const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
      const handle = createAssetSession(ctrl, w, h);
      return handle.setBaseImage(img).then(() => {
        if (ctrl.closed) return;
        P.path = path;
        P.revision = (P.revision || 0) + 1; // PE-010: asset base replaced (stale guard)
        P.meta.textContent = baseName(path) + ' · ' + w + '×' + h;
        // H8-F2 C2: keep the current tab snapshot in sync with the new session.
        if (window.ImageEditorAssetExtras && window.ImageEditorAssetExtras.persistTab) {
          window.ImageEditorAssetExtras.persistTab(ctrl);
        }
        requestAnimationFrame(() => {
          if (P.handle === handle && !P.collapsed && P.wrap.clientWidth > 0) {
            handle.fitToContainer(P.wrap);
          }
        });
      });
    }).catch((e) => {
      P.meta.textContent = 'Load failed';
      toast('Asset load failed: ' + ((e && e.message) || e), 'err', 5000);
    });
  }

  // 📂 Load… — pickFile flow (mirrors ImageEditorSource.onLoadSource).
  function onLoadAsset(ctrl) {
    window.api.pickFile({
      title: 'Select asset image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    }).then((r) => {
      if (r && r.ok && r.path) loadAssetFromPath(ctrl, r.path);
    });
  }

  // ============================================================
  // SEND TO CANVAS
  // ============================================================
  // Composite the asset session at natural size → PNG data URL (alpha
  // preserved) → place on the main canvas exactly like the old onAddSource:
  // centered, scaled to ≤60% of the main canvas, selected, move tool active,
  // one undo step (R5.2 pre-snapshot BEFORE canvas.add).
  function sendToCanvas(ctrl) {
    const P = panelOf(ctrl); if (!P) return;
    const as = P.handle && P.handle.session;
    const hasContent = as && (as.baseObject || as.canvas.getObjects().length > 0);
    if (!hasContent) { toast('Load an asset image first.', 'warn', 2500); return; }
    const slot = ctrl.queue[ctrl.activeIndex];
    const h = slot && slot.handle;
    if (!h) { toast('No main image open — Send needs a canvas to place onto.', 'warn', 3000); return; }

    // Natural-size composite (identity VPT — zoom/pan-independent, alpha kept).
    let temp = null, dataUrl;
    try {
      temp = P.handle.renderSceneAtNaturalSize();
      dataUrl = temp.toDataURL({ format: 'image/png', multiplier: 1 });
    } catch (e) {
      toast('Send failed: ' + ((e && e.message) || e), 'err', 4000);
      return;
    } finally { try { temp && temp.dispose(); } catch (_) {} }

    const fabric = h.session.fabric;
    fabric.Image.fromURL(dataUrl, { crossOrigin: 'anonymous' }).then((fImg) => {
      const s = h.session;
      const maxW = s.imgW * 0.6, maxH = s.imgH * 0.6;
      const scale = Math.min(maxW / (fImg.width || 1), maxH / (fImg.height || 1), 1);
      fImg.set({
        left: s.imgW / 2, top: s.imgH / 2,
        originX: 'center', originY: 'center',
        scaleX: scale, scaleY: scale,
      });
      // H8-F2 C3: apply the placement preview values (opacity / blend).
      if (window.ImageEditorAssetExtras && window.ImageEditorAssetExtras.placementFor) {
        const pl = window.ImageEditorAssetExtras.placementFor(ctrl);
        fImg.set({ opacity: pl.opacity, globalCompositeOperation: pl.gco });
      }
      // R5.2 pattern: PRE-snapshot before canvas.add (single undo restores
      // the pre-send state). Wrapped in try/catch defensive.
      try { window.ImageEditorTools.pushUndo(s); } catch (_) { /* defensive */ }
      s.canvas.add(fImg);
      s.canvas.setActiveObject(fImg);
      // H8-F2 C4: center/edge snap guides while dragging the placed asset.
      if (window.ImageEditorAssetExtras && window.ImageEditorAssetExtras.attachSnapGuides) {
        try { window.ImageEditorAssetExtras.attachSnapGuides(fImg); } catch (_) {}
      }
      if (typeof ctrl.setActiveTool === 'function') ctrl.setActiveTool('move');
      slot.modified = true;
      if (window.ImageEditorSource) {
        window.ImageEditorSource.refreshQueueBar(ctrl);
        window.ImageEditorSource.refreshObjectsList(ctrl);
      }
      toast('Asset placed on canvas.', 'ok', 1800);
    }).catch((e) => toast('Send failed: ' + ((e && e.message) || e), 'err', 4000));
  }

  // ============================================================
  // REMOVE BG ON ASSET (F2-P4)
  // ============================================================
  // The pipeline lives in imageEditorAssetBg.js (extracted to keep this
  // shell under the 500-line cap). The shim keeps the public export + the
  // button/context-menu call sites stable.
  function removeBgOnAsset(ctrl) {
    if (window.ImageEditorAssetBg && typeof window.ImageEditorAssetBg.removeBgOnAsset === 'function') {
      return window.ImageEditorAssetBg.removeBgOnAsset(ctrl);
    }
    toast('Background-removal module not loaded.', 'err', 3000);
    return Promise.resolve();
  }

  // ============================================================
  // COLLAPSE / PERSIST
  // ============================================================
  // Collapsed state persists via ctrl.prefs.assetPanelCollapsed (written to
  // state.imageEditorPrefs by the overlay's savePrefs on close).
  function toggleCollapse(ctrl) {
    const P = panelOf(ctrl); if (!P) return;
    P.collapsed = !P.collapsed;
    ctrl.prefs.assetPanelCollapsed = P.collapsed;
    applyCollapsed(P);
    // Container size changed — refit the asset canvas after expanding.
    if (!P.collapsed && P.handle) {
      requestAnimationFrame(() => {
        if (P.wrap.clientWidth > 0) P.handle.fitToContainer(P.wrap);
      });
    }
  }

  function applyCollapsed(P) {
    P.root.classList.toggle('collapsed', P.collapsed);
    P.collapseBtn.textContent = P.collapsed ? '«' : '»';
  }

  // ============================================================
  // DROP ZONE (queue thumb → asset canvas)
  // ============================================================
  // Attached ONCE at build time (the R4.5 PE-027 discipline: never register
  // drag listeners inside a per-refresh loop).
  function setupAssetDropZone(ctrl, P) {
    P.wrap.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    });
    P.wrap.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const p = ev.dataTransfer.getData('text/ie-queue-path');
      if (p) loadAssetFromPath(ctrl, p);
    });
  }

  // ============================================================
  // DISPOSE (hooked into the overlay's disposeAllListeners close path)
  // ============================================================
  function dispose(ctrl) {
    const P = ctrl && ctrl.assetPanel;
    if (!P) return;
    if (window.ImageEditorAssetExtras && window.ImageEditorAssetExtras.closeContextMenu) {
      try { window.ImageEditorAssetExtras.closeContextMenu(); } catch (_) {}
    }
    if (P._brushCursorDisposer) {
      try { P._brushCursorDisposer(); } catch (_) {}
      P._brushCursorDisposer = null;
    }
    // H8-F2 C2: dispose the handles of ALL tabs (skip P.handle — disposed below).
    if (Array.isArray(P.tabs)) {
      for (const t of P.tabs) {
        if (t && t.handle && t.handle !== P.handle) {
          try { t.handle.dispose(); } catch (_) {}
        }
      }
      P.tabs = null;
    }
    if (P.handle) { try { P.handle.dispose(); } catch (_) {} P.handle = null; }
    ctrl.assetPanel = null;
  }

  window.ImageEditorAssetPanel = {
    build, panelOf,
    createSession: createAssetSession,
    loadAssetFromPath, onLoadAsset, sendToCanvas, removeBgOnAsset,
    dispose,
  };
})();
