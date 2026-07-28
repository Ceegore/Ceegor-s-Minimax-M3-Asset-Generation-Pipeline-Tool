// renderer/overlays/imageEditorAssetExtras.js
// H8-F2 Section-3 extensions for the Asset Composer panel. The panel module
// (imageEditorAssetPanel.js) stays lean (< 500-line cap) and delegates here:
//
//   C2  Asset tabs        — 3 switchable asset slots (own session each)
//   C3  Placement section — opacity + blend-mode preview for placed objects
//   C4  Snap guides       — center/edge snapping while dragging a placed asset
//   C5  Swap main ↔ asset — one button exchanges both composites
//   C6  Context menu      — right-click on the asset canvas
//   C7  Export asset      — save the asset canvas alone as PNG
//   C8  Heal entry        — 🩹 button opening ImageEditorHeal.openMenu (the
//                           heal flow itself is focus-routed in imageEditorHeal.js)
//
// Depends on globals: el, toast, loadImageFromFile, ensureSubDir, uniquePath,
// timestamp, refreshBrowser, window.fabric, window.ImageEditorAssetPanel,
// window.ImageEditorTools, window.ImageEditorSource, window.ImageEditorHeal,
// window.ImageEditorAssetGen (history), window.api + window.GrantCache.
(function () {
  'use strict';

  const TAB_COUNT = 3;

  function panelOf(ctrl) { return (ctrl && ctrl.assetPanel) ? ctrl.assetPanel : null; }

  function fileUrlOf(p) {
    if (window.FileUrl && window.FileUrl.fileUrl) return window.FileUrl.fileUrl(p);
    const enc = encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
    return 'file:///' + (enc.startsWith('/') ? enc.slice(1) : enc);
  }

  // ============================================================
  // C2 — ASSET TABS (3 switchable slots, each its own session)
  // ============================================================
  // Tab state lives on the panel object (P.tabs / P.tabIndex) so the panel's
  // dispose() can tear every session down. A tab entry is a snapshot
  // { handle, canvasEl, path, metaText }; the fabric canvas survives detached
  // from the DOM and is re-attached (pixels + undo intact) on switch.

  function ensureTabs(P) {
    if (!Array.isArray(P.tabs)) { P.tabs = [null, null, null]; P.tabIndex = 0; }
  }

  // Snapshot the CURRENT tab before switching / replacing its session.
  // Called by the panel after loadAssetFromPath / removeBgOnAsset (which
  // rebuild P.handle) and by switchTab before activating another slot.
  function persistTab(ctrl) {
    const P = panelOf(ctrl); if (!P) return;
    ensureTabs(P);
    P.tabs[P.tabIndex] = P.handle
      ? { handle: P.handle, canvasEl: P.canvasHost.firstElementChild, path: P.path, metaText: P.meta.textContent }
      : null;
  }

  function updateTabButtons(P) {
    if (!P.tabButtons) return;
    for (let i = 0; i < P.tabButtons.length; i++) {
      P.tabButtons[i].classList.toggle('active', i === P.tabIndex);
    }
  }

  function switchTab(ctrl, i) {
    const P = panelOf(ctrl); if (!P || i === P.tabIndex) return;
    ensureTabs(P);
    persistTab(ctrl);
    P.tabIndex = i;
    P.canvasHost.textContent = '';
    const t = P.tabs[i];
    if (t && t.handle) {
      P.canvasHost.appendChild(t.canvasEl);
      P.handle = t.handle;
      P.path = t.path;
      P.meta.textContent = t.metaText;
      try { t.handle.session.canvas.requestRenderAll(); } catch (_) {}
    } else {
      // Fresh empty session for an untouched slot. Null P.handle first so
      // createSession's dispose-current step can't touch the saved tab.
      P.handle = null;
      P.path = null;
      window.ImageEditorAssetPanel.createSession(ctrl, 512, 512);
      P.meta.textContent = 'No asset loaded · 512×512';
    }
    updateTabButtons(P);
    requestAnimationFrame(() => {
      if (P.handle && !P.collapsed && P.wrap.clientWidth > 0) P.handle.fitToContainer(P.wrap);
    });
  }

  function buildTabRow(ctrl) {
    const P = panelOf(ctrl);
    const row = el('div', { class: 'ie-asset-tabs' });
    ensureTabs(P);
    P.tabButtons = [];
    for (let i = 0; i < TAB_COUNT; i++) {
      const b = el('button', {
        class: 'ie-asset-tab',
        title: 'Asset slot ' + (i + 1),
        'aria-label': 'Switch to asset slot ' + (i + 1),
      }, String(i + 1));
      b.addEventListener('click', () => switchTab(ctrl, i));
      P.tabButtons.push(b);
      row.appendChild(b);
    }
    updateTabButtons(P);
    return row;
  }

  // ============================================================
  // C3 — PLACEMENT (opacity + blend preview for placed objects)
  // ============================================================
  // The controls act on the ACTIVE object of the MAIN canvas (a placed asset
  // after Send) and their values are also applied to the NEXT sent asset.

  function placementState(ctrl) {
    if (typeof ctrl.assetPlacement !== 'object' || !ctrl.assetPlacement) {
      ctrl.assetPlacement = { opacity: 100, blend: 'source-over' };
    }
    return ctrl.assetPlacement;
  }

  // { opacity: 0..1, gco } for sendToCanvas to stamp onto the placed object.
  function placementFor(ctrl) {
    const p = placementState(ctrl);
    return { opacity: Math.max(0, Math.min(100, p.opacity)) / 100, gco: p.blend };
  }

  function applyPlacement(ctrl) {
    const slot = ctrl.queue[ctrl.activeIndex];
    const h = slot && slot.handle; if (!h) return;
    const obj = h.session.canvas.getActiveObject();
    if (!obj || obj === h.session.baseObject) return;
    const pl = placementFor(ctrl);
    obj.set({ opacity: pl.opacity, globalCompositeOperation: pl.gco });
    h.session.canvas.requestRenderAll();
  }

  const BLEND_MODES = ['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten'];

  function buildPlacementSection(ctrl) {
    const pl = placementState(ctrl);
    const sec = el('div', { class: 'ie-asset-placement' });
    sec.appendChild(el('div', { class: 'ie-section-label' }, 'Placement'));
    const opaRow = el('div', { class: 'ie-asset-placement-row' });
    const opaIn = el('input', {
      type: 'range', min: 5, max: 100, step: 1, value: pl.opacity,
      'aria-label': 'Placed-object opacity',
    });
    const opaVal = el('span', { class: 'ie-asset-placement-val' }, pl.opacity + '%');
    opaIn.addEventListener('input', () => {
      pl.opacity = parseInt(opaIn.value, 10) || 100;
      opaVal.textContent = pl.opacity + '%';
      applyPlacement(ctrl);
    });
    opaRow.append(el('span', { class: 'ie-asset-placement-label' }, 'Opacity'), opaIn, opaVal);
    sec.appendChild(opaRow);
    const blendRow = el('div', { class: 'ie-asset-placement-row' });
    const blendSel = el('select', { 'aria-label': 'Placed-object blend mode' });
    for (const m of BLEND_MODES) {
      blendSel.appendChild(el('option', { value: m }, m === 'source-over' ? 'normal' : m));
    }
    blendSel.value = pl.blend;
    blendSel.addEventListener('change', () => { pl.blend = blendSel.value; applyPlacement(ctrl); });
    blendRow.append(el('span', { class: 'ie-asset-placement-label' }, 'Blend'), blendSel);
    sec.appendChild(blendRow);
    return sec;
  }

  // ============================================================
  // C4 — SNAP GUIDES (center/edge alignment while dragging a placed asset)
  // ============================================================
  // Object-level listeners: they live and die with the placed object, so no
  // per-session wiring is needed across queue-slot switches. Guide lines are
  // flagged `_isHelper` — skipped by renderSceneAtNaturalSize (and therefore
  // by every save/bake/export path).

  function attachSnapGuides(obj) {
    const TH = 6; // scene-pixel snap threshold
    let guides = [];
    const clearGuides = () => {
      for (const g of guides) { try { obj.canvas.remove(g); } catch (_) {} }
      guides = [];
    };
    const mkLine = (x1, y1, x2, y2) => {
      const L = new window.fabric.Line([x1, y1, x2, y2], {
        stroke: '#ff4081', strokeWidth: 1, selectable: false, evented: false,
        excludeFromExport: true,
      });
      L._isHelper = true;
      return L;
    };
    obj.on('moving', () => {
      const c = obj.canvas; if (!c) return;
      clearGuides();
      const W = c.getWidth(), H = c.getHeight();
      const hw = (obj.getScaledWidth ? obj.getScaledWidth() : obj.width) / 2;
      const hh = (obj.getScaledHeight ? obj.getScaledHeight() : obj.height) / 2;
      // Center snap first, then edges (center wins on ties).
      if (Math.abs(obj.left - W / 2) < TH) {
        obj.left = W / 2;
        guides.push(mkLine(W / 2, 0, W / 2, H));
      } else if (Math.abs(obj.left - hw) < TH) { obj.left = hw; guides.push(mkLine(0, 0, 0, H)); }
      else if (Math.abs(obj.left + hw - W) < TH) { obj.left = W - hw; guides.push(mkLine(W, 0, W, H)); }
      if (Math.abs(obj.top - H / 2) < TH) {
        obj.top = H / 2;
        guides.push(mkLine(0, H / 2, W, H / 2));
      } else if (Math.abs(obj.top - hh) < TH) { obj.top = hh; guides.push(mkLine(0, 0, W, 0)); }
      else if (Math.abs(obj.top + hh - H) < TH) { obj.top = H - hh; guides.push(mkLine(0, H, W, H)); }
      if (guides.length) c.requestRenderAll();
    });
    obj.on('modified', clearGuides);
    obj.on('deselected', clearGuides);
  }

  // ============================================================
  // C5 — SWAP MAIN ↔ ASSET
  // ============================================================
  // Both composites are rendered at natural size, then exchanged: the asset
  // session is rebuilt at the main scene's dimensions with the main composite
  // as base; the main canvas gets the asset composite as its new base (one
  // R5.2 pre-snapshot undo step).
  async function swapMainAsset(ctrl) {
    const P = panelOf(ctrl); if (!P || !P.handle) return;
    const slot = ctrl.queue[ctrl.activeIndex];
    const h = slot && slot.handle;
    if (!h) { toast('No main image open — nothing to swap with.', 'warn', 3000); return; }
    const as = P.handle.session;
    if (!(as.baseObject || as.canvas.getObjects().length > 0)) {
      toast('Asset canvas is empty — nothing to swap.', 'warn', 2500); return;
    }
    let t1 = null, t2 = null, mainUrl, assetUrl;
    try {
      t1 = h.renderSceneAtNaturalSize();
      mainUrl = t1.toDataURL({ format: 'image/png', multiplier: 1 });
      t2 = P.handle.renderSceneAtNaturalSize();
      assetUrl = t2.toDataURL({ format: 'image/png', multiplier: 1 });
    } finally {
      try { t1 && t1.dispose(); } catch (_) {}
      try { t2 && t2.dispose(); } catch (_) {}
    }
    const fabric = h.session.fabric;
    try {
      // Asset ← main composite.
      const fMain = await fabric.Image.fromURL(mainUrl, { crossOrigin: 'anonymous' });
      const aw = fMain.width || 512, ah = fMain.height || 512;
      // createSession disposes the old asset handle and swaps in a fresh one.
      const newHandle = window.ImageEditorAssetPanel.createSession(ctrl, aw, ah);
      fMain.set({ selectable: false, evented: false, hoverCursor: 'default', lockMovementX: true, lockMovementY: true });
      newHandle.session.canvas.add(fMain);
      newHandle.session.canvas.sendObjectToBack(fMain);
      newHandle.session.baseObject = fMain;
      newHandle.session.canvas.renderAll();
      P.path = null;
      P.meta.textContent = 'Swapped from main · ' + aw + '×' + ah;
      persistTab(ctrl);
      // Main ← asset composite (R5.2 pre-snapshot BEFORE the clear).
      const s = h.session;
      const fAsset = await fabric.Image.fromURL(assetUrl, { crossOrigin: 'anonymous' });
      fAsset.set({ selectable: false, evented: false, hoverCursor: 'default', lockMovementX: true, lockMovementY: true });
      try { window.ImageEditorTools.pushUndo(s); } catch (_) { /* defensive */ }
      s.canvas.clear();
      s.canvas.add(fAsset);
      s.canvas.sendObjectToBack(fAsset);
      s.baseObject = fAsset;
      s.canvas.renderAll();
      slot.modified = true;
      if (window.ImageEditorSource) {
        window.ImageEditorSource.refreshQueueBar(ctrl);
        window.ImageEditorSource.refreshObjectsList(ctrl);
      }
      requestAnimationFrame(() => {
        if (!P.collapsed && P.wrap.clientWidth > 0) P.handle.fitToContainer(P.wrap);
      });
      toast('Main ↔ asset swapped.', 'ok', 2000);
    } catch (e) {
      toast('Swap failed: ' + ((e && e.message) || e), 'err', 5000);
    }
  }

  // ============================================================
  // C7 — EXPORT ASSET AS PNG
  // ============================================================
  async function exportAssetPng(ctrl) {
    const P = panelOf(ctrl); if (!P || !P.handle) return;
    const s = P.handle.session;
    if (!(s.baseObject || s.canvas.getObjects().length > 0)) {
      toast('Nothing to export — the asset canvas is empty.', 'warn', 2500); return;
    }
    let temp = null, b64;
    try {
      temp = P.handle.renderSceneAtNaturalSize();
      b64 = temp.toDataURL({ format: 'image/png', multiplier: 1 }).split(',')[1];
    } finally { try { temp && temp.dispose(); } catch (_) {} }
    try {
      const dir = await ensureSubDir('image');
      const outPath = uniquePath(dir, `${timestamp()}_asset_export.png`);
      const g = window.api.mintGrant ? await window.GrantCache.ensurePathGrant(outPath, 'write') : undefined;
      if (g && g.ok === false) throw new Error(g.error || 'mintGrant failed');
      await (window.api.writeImageBase64
        ? window.api.writeImageBase64(outPath, b64, g)
        : window.api.fbWrite(outPath, b64, g));
      if (window.ImageEditorAssetGen && window.ImageEditorAssetGen.pushHistory) {
        window.ImageEditorAssetGen.pushHistory(ctrl, outPath);
      }
      if (typeof refreshBrowser === 'function') { try { refreshBrowser(); } catch (_) {} }
      toast('Asset exported: ' + outPath.split(/[\\/]/).pop(), 'ok', 3500);
    } catch (e) {
      toast('Export failed: ' + ((e && e.message) || e), 'err', 5000);
    }
  }

  // 🧹 Clear asset (context menu) — rebuild an empty session (destructive;
  // the asset canvas has no file binding of its own, so no confirm dialog).
  function clearAsset(ctrl) {
    const P = panelOf(ctrl); if (!P) return;
    window.ImageEditorAssetPanel.createSession(ctrl, 512, 512);
    P.path = null;
    P.meta.textContent = 'No asset loaded · 512×512';
    persistTab(ctrl);
    requestAnimationFrame(() => {
      if (!P.collapsed && P.wrap.clientWidth > 0) P.handle.fitToContainer(P.wrap);
    });
  }

  // ============================================================
  // C6 — RIGHT-CLICK CONTEXT MENU ON THE ASSET CANVAS
  // ============================================================
  function closeContextMenu() {
    const m = document.getElementById('ie-asset-ctxmenu');
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }

  function openContextMenu(ctrl, x, y) {
    closeContextMenu();
    const menu = el('div', { class: 'ie-asset-ctxmenu', id: 'ie-asset-ctxmenu' });
    const item = (label, fn) => {
      const b = el('button', { class: 'ie-asset-ctxitem' }, label);
      b.addEventListener('click', () => { closeContextMenu(); fn(); });
      menu.appendChild(b);
    };
    item('📂 Load…', () => window.ImageEditorAssetPanel.onLoadAsset(ctrl));
    item('✨ Generate…', () => {
      if (window.ImageEditorAssetGen) window.ImageEditorAssetGen.openGeneratePopover(ctrl);
    });
    item('✂ Remove BG', () => window.ImageEditorAssetPanel.removeBgOnAsset(ctrl));
    item('→ Send to canvas', () => window.ImageEditorAssetPanel.sendToCanvas(ctrl));
    item('💾 Export as PNG', () => exportAssetPng(ctrl));
    item('🧹 Clear asset', () => clearAsset(ctrl));
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    document.body.appendChild(menu);
    // Close on the next outside interaction (deferred so the opening
    // right-click itself doesn't immediately dismiss the menu).
    setTimeout(() => {
      document.addEventListener('mousedown', function once() {
        closeContextMenu();
        document.removeEventListener('mousedown', once);
      });
    }, 0);
  }

  // ============================================================
  // PANEL SECTIONS (row 3 + placement) — appended by the panel's build()
  // ============================================================
  function buildExtraSections(ctrl) {
    const frag = el('div', { class: 'ie-asset-extras' });
    const row3 = el('div', { class: 'ie-asset-actions' });
    const swapBtn = el('button', {
      class: 'ie-btn',
      title: 'Swap the main canvas and the asset canvas contents',
      'aria-label': 'Swap main and asset canvases',
    }, '⇄ Swap');
    swapBtn.addEventListener('click', () => swapMainAsset(ctrl));
    row3.appendChild(swapBtn);
    const exportBtn = el('button', {
      class: 'ie-btn',
      title: 'Save the asset canvas alone as a PNG file',
      'aria-label': 'Export the asset as PNG',
    }, '💾 Export…');
    exportBtn.addEventListener('click', () => exportAssetPng(ctrl));
    row3.appendChild(exportBtn);
    const healBtn = el('button', {
      class: 'ie-btn',
      title: 'Heal / inpaint the focused canvas (click the asset canvas first)',
      'aria-label': 'Heal the focused canvas',
    }, '🩹 Heal');
    healBtn.addEventListener('click', () => {
      if (window.ImageEditorHeal && window.ImageEditorHeal.openMenu) {
        window.ImageEditorHeal.openMenu(ctrl);
      } else {
        toast('Heal module not loaded.', 'err', 3000);
      }
    });
    row3.appendChild(healBtn);
    frag.appendChild(row3);
    frag.appendChild(buildPlacementSection(ctrl));
    return frag;
  }

  window.ImageEditorAssetExtras = {
    buildTabRow, buildExtraSections,
    persistTab, switchTab,
    placementFor, applyPlacement,
    attachSnapGuides,
    swapMainAsset, exportAssetPng, clearAsset,
    openContextMenu, closeContextMenu,
  };
})();
