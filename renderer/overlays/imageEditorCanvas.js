// renderer/overlays/imageEditorCanvas.js (pixel editor)
// Canvas + viewport (zoom/pan) + RGBA working-layer setup for the editor.
//
// Fabric.js v6 is loaded as a vendored UMD bundle (renderer/vendor/fabric.min.js)
// BEFORE this file, exposing the `fabric` global. A bundler is deliberately NOT
// added to the project (see renderer/app.js — "no build step").
//
// This module owns the *per-slot* editor session: a Fabric canvas instance, the
// zoom/pan state, brush settings, and the live brush-outline cursor. It exposes
// a factory `createEditorSession(hostEl, imgW, imgH)` returning an object the
// overlay + tools modules drive. Each queue slot gets its own session so
// switching images preserves edits.

(function () {
  'use strict';
  // `fabric` is a global provided by the UMD bundle. Guard so a load-order bug
  // produces a clear message instead of a silent ReferenceError.
  function requireFabric() {
    if (typeof window.fabric === 'undefined' || !window.fabric.Canvas) {
      throw new Error('Image editor: Fabric.js failed to load (window.fabric missing).');
    }
    return window.fabric;
  }

  // Create a Fabric canvas inside `hostEl`, sized to the source image (imgW×imgH),
  // with an always-RGBA base. Returns a session handle.
  //
  // The source image is rendered as a locked "base" object so freehand drawing
  // and erasing happen ABOVE it on Fabric's free-drawing layer (which is itself a
  // transparent raster). Erasing uses destination-out → writes alpha=0, never a
  // background colour (a common foot-gun in lightweight editors).
  function createEditorSession(hostEl, imgW, imgH) {
    const fabric = requireFabric();
    const canvas = new fabric.Canvas(hostEl, {
      backgroundColor: 'rgba(0,0,0,0)', // transparent so the CSS checkerboard shows through
      selection: true,
      preserveObjectStacking: true,
    });
    canvas.setWidth(imgW);
    canvas.setHeight(imgH);

    const session = {
      fabric,
      canvas,
      imgW,
      imgH,
      zoom: 1,
      // tool state (driven by imageEditorTools.js)
      tool: 'pen',
      brushSize: 12,
      brushOpacity: 1,
      fg: '#000000',
      bg: '#ffffff',
      // base image object (locked, non-selectable)
      baseObject: null,
      // undo/redo snapshot stacks of canvas.toJSON() (imageEditorTools.js pushes)
      _undo: [],
      _redo: [],
    };

    // R4.2-auditfix: helper is also exposed on the inner `session`
    // object (in addition to the handle below). R4.2 callers receive
    // the session via `activeSession(ctrl).session` and call
    // `session.renderSceneAtNaturalSize()`. Without this alias, the
    // PE-001 migration is broken (TypeError on every save / bake /
    // alpha scan / matte composite). See R4.2 Phasenpruefung
    // finding P-R42-01.
    // The alias points at the same closure (assigned below at the
    // factory return). Function declarations are hoisted, so this
    // is safe.
    session.renderSceneAtNaturalSize = renderSceneAtNaturalSize;

    // ---- zoom + pan (viewport) ----
    // Zoom MUST anchor on the cursor so the point under the pointer stays put.
    // Fabric's zoomToPoint does this when given the SCENE point under the
    // cursor (in canvas image coordinates), NOT the display point.
    //
    // R4.6 (PE-012 fix): the pre-R4.6 code divided the display point by
    // session.zoom and passed the result to zoomToPoint. That is wrong on
    // two counts:
    //   (1) It ignored the pan component of the viewport transform. A
    //       canvas that was panned to (10, 20) before the zoom would
    //       drift by (10, 20) on every wheel tick. Per the design contract §PE-012
    //       repro: VPT [0.5, 0, 0, 0.5, 10, 20], cursor (150, 100),
    //       factor 1.1 → ~5 scene-pixel drift.
    //   (2) It read `session.zoom` independently of the canvas's actual
    //       VPT, so any code path that mutated the VPT directly (e.g.
    //       fitToContainer's setViewportTransform) would cause the cached
    //       session.zoom to drift away from the real zoom.
    // The fix:
    //   (a) Convert display point → scene point using the FULL VPT
    //       (zoom + pan), not just zoom.
    //   (b) After zoomToPoint, read session.zoom FROM the canvas
    //       (canvas.getZoom()) so it stays in sync with the VPT.
    function zoomAt(displayPoint, factor) {
      // Read zoom from the canvas (source of truth) — never trust
      // session.zoom alone, it can drift if anything touches the VPT.
      const currentZoom = canvas.getZoom() || 1;
      const newZoom = Math.max(0.1, Math.min(16, currentZoom * factor));
      if (newZoom === currentZoom) return;
      // displayPoint is in wrap-space (relative to the shared wrap
      // element that hosts the canvas). The VPT transforms a scene
      // point to display space as: display = a*x + c*y + e. For a
      // pure scale+pan VPT (a=zoom, c=0, d=zoom, e=panX, f=panY) the
      // inverse is: scene = (display - pan) / zoom. Account for
      // both panX and panY so a panned canvas does not drift.
      const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
      const panX = vpt[4] || 0;
      const panY = vpt[5] || 0;
      const pt = {
        x: (displayPoint.x - panX) / currentZoom,
        y: (displayPoint.y - panY) / currentZoom,
      };
      canvas.zoomToPoint(pt, newZoom);
      // Sync session.zoom from the canvas (source of truth) so any
      // downstream code that reads session.zoom (e.g. the brush
      // cursor's diameter calc) sees the new zoom and not a stale
      // value.
      session.zoom = canvas.getZoom();
      canvas.fire('ie:viewport');
    }
    function setZoom(z) {
      const newZoom = Math.max(0.1, Math.min(16, z));
      canvas.zoomToPoint({ x: canvas.getWidth() / 2, y: canvas.getHeight() / 2 }, newZoom);
      // R4.6 (PE-012 fix): sync session.zoom from the canvas so
      // any direct VPT mutation (e.g. fitToContainer below) does
      // not leave session.zoom stale.
      session.zoom = canvas.getZoom();
      canvas.fire('ie:viewport');
    }
    function fitToContainer(containerEl) {
      const cw = containerEl.clientWidth || 1;
      const ch = containerEl.clientHeight || 1;
      const currentW = session.imgW || imgW;
      const currentH = session.imgH || imgH;
      const z = Math.min(cw / currentW, ch / currentH);
      setZoom(z);
      // center the canvas in the container
      const vpt = canvas.viewportTransform;
      vpt[4] = Math.max(0, (cw - currentW * z) / 2);
      vpt[5] = Math.max(0, (ch - currentH * z) / 2);
      canvas.setViewportTransform(vpt);
      canvas.fire('ie:viewport');
    }

    // ---- pan via viewport drag ----
    let panning = false, panLast = null;
    function startPan(screenX, screenY) { panning = true; panLast = { x: screenX, y: screenY }; }
    function movePan(screenX, screenY) {
      if (!panning) return false;
      const vpt = canvas.viewportTransform;
      vpt[4] += screenX - panLast.x;
      vpt[5] += screenY - panLast.y;
      canvas.setViewportTransform(vpt);
      panLast = { x: screenX, y: screenY };
      canvas.fire('ie:viewport');
      return true;
    }
    function endPan() { panning = false; panLast = null; }
    function isPanning() { return panning; }

    // ---- base image management ----
    // Fabric v6: Image.fromURL returns a Promise (no callback, unlike v5).
    // The base image is locked + non-selectable so drawing/erasing happens
    // above it on the free-drawing layer.
    function setBaseImage(imgElement) {
      return fabric.Image.fromURL(imgElement.src, { crossOrigin: 'anonymous' }).then((fImg) => {
        fImg.set({
          selectable: false,
          evented: false,
          hoverCursor: 'default',
          lockMovementX: true, lockMovementY: true,
        });
        canvas.add(fImg);
        canvas.sendObjectToBack(fImg);
        session.baseObject = fImg;
        return fImg;
      });
    }

    // ---- export helpers ----
    // R4.1 (PE-001): Pure Natural-Scene Renderer. Builds a TEMPORARY
    // fabric.StaticCanvas at the session's natural dimensions, copies
    // the live canvas's objects into it, applies an identity
    // viewport transform, and renders. Returns the temp canvas.
    //
    // Why a temp canvas: Fabric v6's `toCanvasElement(multiplier)` and
    // `toDataURL({multiplier})` BOTH honour the live canvas's
    // current viewport transform (zoom + pan + fit). Exporting a
    // 100×100 red square at zoom 0.5 produced 2.500 opaque red
    // pixels instead of 10.000 (PE-001 repro). The fix: never
    // export the live canvas directly; always go through this
    // helper which uses an identity VPT.
    //
    // The live canvas is NOT modified (no setWidth / setHeight /
    // setViewportTransform / renderAll on the live instance). The
    // helper reads `getObjects()` and clones each object into the
    // temp canvas. The visible viewport is therefore UNCHANGED
    // during export — no flicker.
    //
    // Future cards (R4.2+) may extend this to use toJSON/loadFromJSON
    // for full fidelity (custom properties, events, helper-object
    // exclusion). For R4.1, the simple "copy the live objects" is
    // sufficient because the editor's working set is plain Fabric
    // primitives (Image, Path, Rect) with no custom subclasses.
    function renderSceneAtNaturalSize() {
      const fabric = requireFabric();
      const w = session.imgW || imgW, h = session.imgH || imgH;
      // gewv2 NF-02 fix: the previous implementation called `temp.add(o)`
      // with LIVE fabric objects. Fabric v6's add() REMOVES an object from
      // its current canvas when adding it to another — so after the first
      // Save/Bake/Remove-BG the live canvas was left empty, and every
      // subsequent render (including the bytes actually written to disk)
      // was blank. Fix: snapshot the LIVE canvas to a natural-size
      // HTMLCanvasElement at an identity viewport transform (so the export
      // is not zoom/pan-corrupted), then wrap that snapshot in a
      // fabric.Image on the temp StaticCanvas. No object is ever added to
      // (and therefore never removed from) the live canvas.
      //
      // Helper objects (`_isHelper`, e.g. snap guides — see
      // imageEditorAssetExtras.js) must still be excluded from the export.
      // Since objects are no longer individually copied, exclude them by
      // temporarily hiding (visible=false) for the snapshot only, then
      // restoring — this never touches canvas membership, so it carries
      // none of the add()-removes-from-previous-canvas risk.
      const savedVPT = (canvas.viewportTransform || [1, 0, 0, 1, 0, 0]).slice();
      const liveObjects = canvas.getObjects();
      const hiddenHelpers = [];
      for (let i = 0; i < liveObjects.length; i++) {
        const o = liveObjects[i];
        if (o && (o._isHelper || o.excludeFromExport) && o.visible !== false) {
          hiddenHelpers.push(o);
          o.visible = false;
        }
      }
      let snapEl;
      try {
        canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
        snapEl = canvas.toCanvasElement(1, { left: 0, top: 0, width: w, height: h });
      } finally {
        canvas.setViewportTransform(savedVPT);
        for (let i = 0; i < hiddenHelpers.length; i++) hiddenHelpers[i].visible = true;
        canvas.requestRenderAll();
      }
      const temp = new fabric.StaticCanvas(null, {
        width: w,
        height: h,
        // Match the live canvas's background so the temp scene's
        // empty areas are identical to what the live canvas would
        // produce (typically 'rgba(0,0,0,0)' for the transparent
        // checkerboard pattern).
        backgroundColor: (canvas.backgroundColor || 'rgba(0,0,0,0)'),
      });
      // Identity VPT on the temp canvas too — it holds exactly one
      // already-natural-size snapshot image at (0,0); a non-identity
      // default (a StaticCanvas is not guaranteed to start at identity)
      // would re-scale/pan that image when rendered.
      temp.setViewportTransform([1, 0, 0, 1, 0, 0]);
      temp.add(new fabric.Image(snapEl));
      temp.renderAll();
      return temp;
    }

    // ---- legacy export helpers (DEPRECATED in R4.2+) ----
    // These honour the live canvas's current viewport transform
    // and are therefore UNSAFE for any save path that must match
    // what the user sees (or what the user would see at 1:1 zoom).
    // Callers (imageEditorActions.save, JPEG matte, alpha scan,
    // bake, etc.) MUST switch to `renderSceneAtNaturalSize` in
    // R4.2; the legacy helpers are kept for now to avoid breaking
    // the editor's preview path (where viewport-aware rendering is
    // intentional).
    function toCanvasElement() {
      // Fabric v6: toCanvasElement renders the current scene at natural size.
      return canvas.toCanvasElement(1);
    }
    function toDataURL(format, quality) {
      // format: 'png' | 'jpeg' | 'webp'
      return canvas.toDataURL({ format, quality, multiplier: 1 });
    }

    // ---- teardown ----
    function dispose() {
      try { canvas.dispose(); } catch (_) {}
    }

    return {
      session,
      canvas,
      zoomAt,
      setZoom,
      fitToContainer,
      startPan,
      movePan,
      endPan,
      isPanning,
      setBaseImage,
      // R4.1: the new pure Natural-Scene Renderer (preferred for
      // every save path that must match the natural-resolution
      // pixel content).
      renderSceneAtNaturalSize,
      // Legacy viewport-aware export (used by the editor's preview
      // path; R4.2 will migrate the save path away from this).
      toCanvasElement,
      toDataURL,
      dispose,
    };
  }

  // Export factory + fabric accessor so tests can mock.
  window.ImageEditorCanvas = { createEditorSession, requireFabric };
})();
