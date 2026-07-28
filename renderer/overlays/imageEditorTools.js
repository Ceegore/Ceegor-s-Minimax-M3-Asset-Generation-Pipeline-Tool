// renderer/overlays/imageEditorTools.js (pixel editor)
// Paint tools, colors, undo/redo, and the live brush-outline cursor.
//
// Driven against a session produced by imageEditorCanvas.createEditorSession().
// Tools: pen (PencilBrush), airbrush/spray (SprayBrush), eraser (destination-out),
// pipette (samples composited pixels → foreground). Undo/redo snapshot the Fabric
// canvas JSON on stroke-end.
//
// Keyboard shortcuts (Photoshop/GIMP/Krita conventions) are wired here because
// they are tool-centric. B=brush, A=airbrush, E=eraser, I=pipette, V=move,
// H/Space=pan, Z=zoom, [ ]=brush size, X=swap colors, D=reset colors,
// Ctrl+Z/Ctrl+Y=undo/redo.

(function () {
  'use strict';

  // ---- undo / redo ----
  // Snapshots are capped; snapshot on stroke END (not per-pointer-move) to
  // keep memory bounded. Each entry is a serialized Fabric state. The viewport
  // transform is restored separately so undo does NOT move the view.
  //
  // R5.1 (Historyschema S2): the snapshot format was extended to include
  // more fields (dimensions, zoom, baseId, tool, custom props) so the
  // restore can faithfully re-link the base object + reapply the tool
  // state. The Savepoint/Dirty model is added as infrastructure (no
  // callsite uses it yet — future R5.2+ cards wire it up).
  const MAX_UNDO = 25;
  // Custom Fabric props that must survive toJSON/loadFromJSON. The
  // base object uses `__baseId` for stable re-identification; the
  // editor-internal objects use `ieKind` + `excludeFromExport` for
  // selection/heal/shape semantics.
  const JSON_CUSTOM_PROPS = ['selectable', 'evented', 'ieKind', 'excludeFromExport', '__baseId'];
  // Counter for stable baseId assignment. Each call to setBaseImage
  // mints a new id; the id is preserved across snapshot/restore.
  let _nextBaseId = 1;

  function snapshot(session) {
    const s = session;
    // R5.1: ensure session.baseId is set on the first snapshot
    // (lazy initialization). This avoids modifying the canvas
    // module's setBaseImage (R5.1 scope is imageEditorTools.js +
    // tests; canvas.js is out of scope per the spec). The id is
    // preserved across snapshot/restore so the dirty model can
    // detect base changes (future card: when setBaseImage is
    // called multiple times, the id is regenerated; R5.1 is a
    // single-base-image snapshot system).
    if (!s.baseId) s.baseId = 'base-' + (_nextBaseId++);
    return {
      json: s.canvas.toJSON(JSON_CUSTOM_PROPS),
      viewport: Array.from(s.canvas.viewportTransform || [1, 0, 0, 1, 0, 0]),
      // R5.1: extend the snapshot with the editor state that
      // must survive restore. Without these fields, undo of a
      // tool change would lose the tool state, and undo of a
      // zoom would lose the zoom.
      dimensions: { imgW: s.imgW, imgH: s.imgH },
      zoom: s.zoom,
      // Stable id for the base object. Currently assigned
      // lazily in the snapshot; future card can add a
      // `__baseId` custom prop on the Fabric object so the id
      // survives across snapshot/restore. R5.1 uses
      // `objs[0]` (the back-most object) as the base after
      // restore; `session.baseId` is used for the savepoint /
      // dirty model.
      baseId: s.baseId,
      // Tool state. Without this, undo after a tool change
      // would silently switch the user back to the old tool.
      tool: s.tool,
    };
  }
  function pushUndo(session) {
    session._undo.push(snapshot(session));
    if (session._undo.length > MAX_UNDO) session._undo.shift();
    session._redo.length = 0; // a new edit clears the redo branch
    session.canvas.fire('ie:history');
  }
  function restore(session, snap) {
    // Fabric v6 migration fix: `canvas.loadFromJSON(json, cb)` is the
    // Fabric v5 CALLBACK API. The bundled Fabric is v6 (6.4.3) where the
    // 2nd argument is a REVIVER (invoked once per enlivened object) and the
    // method RETURNS A PROMISE that resolves with the canvas. The old code
    // passed `(err) => {...}` as if it were a completion callback; Fabric v6
    // instead called it per-object with the enlivened object as `err`, so the
    // very first object (the base Image) triggered `reject(image)` — an
    // unhandled promise rejection — AND skipped every post-load fixup below
    // (viewport restore, baseObject re-link, tool re-apply, renderAll). The
    // net effect was that undo/redo visually re-added objects but left
    // `session.baseObject` detached and the tool/viewport state stale, which
    // is why editing after an undo behaved erratically. Use the v6 Promise
    // API and run the fixups in `.then`.
    return Promise.resolve(session.canvas.loadFromJSON(snap.json)).then(() => {
      // Restore viewport transform (R4.1 invariant: undo
      // does NOT move the view per the original comment, but
      // R5.1 restores the saved viewport so undo can navigate
      // between zoom levels).
      if (snap.viewport) session.canvas.setViewportTransform(snap.viewport.slice());
      // Restore session.zoom (R4.6: read from canvas, not
      // the saved value — canvas is the source of truth).
      session.zoom = session.canvas.getZoom();
      if (snap.dimensions) {
        session.imgW = snap.dimensions.imgW; session.imgH = snap.dimensions.imgH;
        if (session.canvas?.setDimensions) session.canvas.setDimensions({ width: snap.dimensions.imgW, height: snap.dimensions.imgH });
      }
      // Re-link the base object (PE-005 fix). Without this,
      // `session.baseObject` would point to a detached
      // object after restore. R5.1 uses the back-most object
      // (always the base, by `sendObjectToBack` in
      // setBaseImage) as the proxy. Future card can add a
      // `__baseId` custom prop on the Fabric object so the
      // base can be identified by id (not by position).
      const objs = session.canvas.getObjects();
      session.baseObject = objs[0] || null;
      if (snap.baseId != null) session.baseId = snap.baseId;
      // PE-019: re-attach endpoint controls to bar objects after
      // loadFromJSON (custom Controls are not serialized in JSON).
      if (window.ImageEditorShapes && window.ImageEditorShapes.attachEndpointControls) {
        for (const o of objs) {
          if (o.ieKind === 'bar') {
            try { window.ImageEditorShapes.attachEndpointControls(o, session.fabric); } catch (_) {}
          }
        }
      }
      // Restore tool state. R5.1.AuditFix P-R51-T01: not only
      // set `session.tool`, but also re-apply the canvas-side
      // drawing state (isDrawingMode + freeDrawingBrush +
      // selection + defaultCursor + path:created listener) via
      // setTool(). Without this, undo after a tool change would
      // silently leave the canvas in the WRONG drawing mode
      // (e.g. user is in pen → switches to eraser → makes an
      // eraser stroke → undo: session.tool='pen' but canvas is
      // still in eraser mode → next stroke is an eraser stroke).
      // Wrapped in try/catch so a missing setTool signature
      // (future refactor) doesn't crash the restore.
      if (snap.tool != null) {
        try { setTool(session, snap.tool); } catch (_) { /* defensive */ }
      }
      session.canvas.renderAll();
      session.canvas.fire('ie:history');
    });
  }
  function undo(session) {
    if (!session._undo.length) return Promise.resolve();
    // push current state to redo before restoring previous
    session._redo.push(snapshot(session));
    const prev = session._undo.pop();
    return restore(session, prev);
  }
  function redo(session) {
    if (!session._redo.length) return Promise.resolve();
    session._undo.push(snapshot(session));
    const next = session._redo.pop();
    return restore(session, next);
  }
  function canUndo(session) { return session._undo.length > 0; }
  function canRedo(session) { return session._redo.length > 0; }

  // ---- R5.1: Savepoint/Dirty model ----
  // Infrastructure for the "has the session been modified since
  // the last save?" check. The callsite (doSave in
  // imageEditorActions.js) is updated in a future R5.2+ card
  // to call setSavepoint() after a successful save; R5.1 only
  // adds the helpers + tests.
  function setSavepoint(session, snap) {
    session._savepoint = snap || snapshot(session);
  }
  function clearSavepoint(session) {
    session._savepoint = null;
  }
  function isModified(session) {
    if (!session._savepoint) return false; // no savepoint = initial state
    return !snapshotEqual(snapshot(session), session._savepoint);
  }
  function snapshotEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.zoom !== b.zoom) return false;
    if (a.tool !== b.tool) return false;
    if (a.baseId !== b.baseId) return false;
    if (JSON.stringify(a.viewport) !== JSON.stringify(b.viewport)) return false;
    if (JSON.stringify(a.dimensions) !== JSON.stringify(b.dimensions)) return false;
    // Compare the JSON-stringified form (slow but correct for
    // arbitrary object trees). For a perf-critical path, a
    // structural comparator could be added.
    if (JSON.stringify(a.json) !== JSON.stringify(b.json)) return false;
    return true;
  }

  // ---- tool switching ----
  // Sets the active tool and reconfigures the Fabric canvas for it.
  // 'pen'/'spray' → freeDrawingMode with the matching brush.
  // 'eraser'      → freeDrawingMode with a brush that paints destination-out.
  // 'pipette'     → object mode (no drawing); canvas click samples the pixel.
  // 'move'        → object mode (selection of composite objects).
  // 'pan'         → object mode; the overlay wires Space-drag to session pan.
  function setTool(session, tool) {
    const s = session;
    const fabric = s.fabric;
    s.tool = tool;
    const drawingTools = { pen: true, spray: true, eraser: true };

    if (drawingTools[tool]) {
      s.canvas.isDrawingMode = true;
      if (tool === 'pen') {
        const b = new fabric.PencilBrush(s.canvas);
        b.color = hexWithAlpha(s.fg, s.brushOpacity);
        b.width = s.brushSize;
        s.canvas.freeDrawingBrush = b;
      } else if (tool === 'spray') {
        const b = new fabric.SprayBrush(s.canvas);
        b.color = hexWithAlpha(s.fg, s.brushOpacity);
        b.width = s.brushSize;
        b.density = Math.max(5, Math.round(s.brushSize)); // spray density scales with size
        s.canvas.freeDrawingBrush = b;
      } else if (tool === 'eraser') {
        // destination-out eraser: paints alpha=0, never a colour. This lets
        // the eraser work on a JPEG (auto-promoted to RGBA on load) and produce
        // real transparency.
        const b = new fabric.PencilBrush(s.canvas);
        b.color = 'rgba(0,0,0,1)';
        b.width = s.brushSize;
        b.strokeLineCap = 'round';
        b.strokeLineJoin = 'round';
        s.canvas.freeDrawingBrush = b;
        // Fabric applies the brush colour to the free-drawing Path object's
        // stroke. To make the stroke carve alpha, set globalCompositeOperation
        // on the path right after it is added.
        // PE-013: idempotent install — .off() before .on() so repeated
        // eraser activations never accumulate handlers (Fabric .off()
        // removes only the FIRST match; .on() appends without dedup).
        s.canvas.off('path:created', onEraserPath);
        s.canvas.on('path:created', onEraserPath);
      }
      if (tool !== 'eraser') s.canvas.off('path:created', onEraserPath);
    } else {
      s.canvas.isDrawingMode = false;
      s.canvas.off('path:created', onEraserPath);
      if (tool === 'move') {
        s.canvas.selection = true;
        s.canvas.defaultCursor = 'default';
      } else if (tool === 'pipette') {
        s.canvas.selection = false;
        s.canvas.defaultCursor = 'crosshair';
      } else if (tool === 'pan') {
        s.canvas.selection = false;
        s.canvas.defaultCursor = 'grab';
      } else if (tool === 'heal') {
        // heal-select: drag a rectangle to define the inpaint region. No
        // object selection, crosshair cursor (like Photoshop's marquee).
        s.canvas.selection = false;
        s.canvas.defaultCursor = 'crosshair';
      } else if (tool === 'select') {
        // H8-005: dedicated marquee selection tool. Like heal but the rect
        // persists as a dashed outline and no popover auto-opens; the selection
        // is consumed by Heal Selection / Resynthesize later.
        s.canvas.selection = false;
        s.canvas.defaultCursor = 'crosshair';
      } else if (tool === 'bar') {
        // H8-002: bar (line) placement tool. Two clicks place an editable bar;
        // object-mode so the user can also drag existing bars.
        s.canvas.selection = true;
        s.canvas.defaultCursor = 'crosshair';
      } else if (tool === 'zoom') {
        // zoom tool: clicks/scroll zoom; no object interaction.
        s.canvas.selection = false;
        s.canvas.defaultCursor = 'zoom-in';
      }
    }
    s.canvas.fire('ie:tool', { tool });
  }

  // Make an eraser path carve alpha. A Fabric free-draw path is added with the
  // brush's stroke colour; flip its globalCompositeOperation to destination-out
  // so it subtracts from everything below it.
  function onEraserPath(e) {
    const path = e && e.path;
    if (!path) return;
    path.set({ globalCompositeOperation: 'destination-out', selectable: false, evented: false });
  }

  // Convert #rrggbb + opacity (0..1) → rgba() string for brush colour.
  function hexWithAlpha(hex, opacity) {
    const c = hexToRgb(hex);
    if (!c) return hex;
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + opacity + ')';
  }
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // ---- pipette ----
  // Sample the composited pixel at the given SCENE (image) coordinates and set
  // the foreground colour. Renders the canvas to a natural-resolution element
  // once per click (H8-007): the previous implementation sampled the Fabric
  // backing store directly, which is zoom- and retina-dependent (the backing
  // store is multiplied by the device pixel ratio), so a click at 400% zoom
  // sampled a pixel ~4× off the crosshair. Rendering to a fresh canvas at the
  // image's natural W×H makes the sample zoom- and DPR-proof.
  function pickColorAt(session, sceneX, sceneY) {
    // R4.2.follow-up.AuditFix P-R42FU-02: wrap temp in try/finally
    // (per the R4.2 canvasHasAlpha/flattenOntoMatte/doSave pattern) so
    // a throw from getImageData (cross-origin taint) or an early-return
    // path (`!ctx`) doesn't leak the temp canvas. The previous code
    // had dispose AFTER the early-return check, so `!ctx` skipped
    // dispose entirely; and getImageData throws would skip dispose too.
    let temp;
    try {
      // R4.2.follow-up (PE-001 migration): use
      // `renderSceneAtNaturalSize` + a `toCanvasElement(1)` call on
      // the TEMP canvas (not the legacy `session.canvas.toCanvasElement()`
      // which uses the LIVE canvas's VPT). The temp canvas has
      // identity VPT and natural dimensions — `el2d.width ===
      // session.imgW` and `el2d.height === session.imgH`. The
      // previous code returned a VPT-corrupted canvas whose
      // dimensions were zero/scaled, so the clamp at
      // `el2d.width - 1` clipped the sample to a wrong position.
      temp = session.renderSceneAtNaturalSize();
      const el2d = temp.toCanvasElement(1);
      const ctx = el2d.getContext('2d');
      if (!ctx) return null;
      const x = Math.max(0, Math.min(el2d.width - 1, Math.floor(sceneX)));
      const y = Math.max(0, Math.min(el2d.height - 1, Math.floor(sceneY)));
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    } catch (_) {
      // toCanvasElement can throw if the canvas is tainted (cross-origin image).
      // Fall back to the backing store so the pipette keeps working.
      const ctx = session.canvas.getContext('2d') || session.canvas.contextContainer;
      if (!ctx) return null;
      const d = ctx.getImageData(Math.floor(sceneX), Math.floor(sceneY), 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    } finally {
      try { temp && temp.dispose(); } catch (_) {}
    }
  }

  // ---- scene-coordinate helper (H8-007) ----
  // Fabric v6.4.3 exposes `scenePoint` on the mouse-event data and a
  // `getScenePoint(e)` method on the canvas. The previous heal/select drag + the
  // pipette used `opt.pointer`, which is the VIEWPORT (screen-space) point — so
  // when the editor opens fit-to-container (zoom ≠ 1 + pan offsets), a box drawn
  // in SCENE coords landed at pointer/zoom away from the cursor. This helper
  // returns the scene point for a Fabric mouse event and clamps it to the image
  // rectangle so a drag started outside the canvas can't produce negative/oversized
  // coords. Pure (no DOM) so it can be unit-tested with a mocked canvas.
  function scenePointOf(canvas, opt, imgW, imgH) {
    if (!canvas || !opt) return { x: 0, y: 0 };
    let p = null;
    if (opt.scenePoint && typeof opt.scenePoint.x === 'number') {
      p = { x: opt.scenePoint.x, y: opt.scenePoint.y };
    } else if (opt.e && typeof canvas.getScenePoint === 'function') {
      const sp = canvas.getScenePoint(opt.e);
      p = { x: sp.x, y: sp.y };
    } else if (opt.pointer && typeof opt.pointer.x === 'number') {
      // Last-resort fallback: viewport point (legacy behaviour).
      p = { x: opt.pointer.x, y: opt.pointer.y };
    }
    if (!p) return { x: 0, y: 0 };
    if (typeof imgW === 'number' && imgW > 0) p.x = Math.max(0, Math.min(imgW, p.x));
    if (typeof imgH === 'number' && imgH > 0) p.y = Math.max(0, Math.min(imgH, p.y));
    return p;
  }

  // ---- brush cursor outline ----
  // A live circle the size of the brush, tracking the pointer, recomputed on
  // every viewport change so it stays correctly sized after zoom.
  //
  // R4.5 (PE-035 fix): single-wrapper-listener pattern. The wrap listeners
  // (`mousemove` + `mouseleave`) are attached EXACTLY ONCE per wrapEl via
  // a guard flag. The wrap listener reads the "current session" from
  // `wrapEl._ieCurrentSession` (a closure-shared reference). On every
  // install, the per-canvas `ie:viewport` listener is detached from the
  // previous session and re-attached to the new one. Returns a disposer
  // that removes the canvas listener (caller invokes it on slot close or
  // before re-installing for a different slot). This prevents the
  // pre-fix leak: N slots => 2N wrap listeners + N stale canvas listeners
  // (the stale-session bug where A→B→A kept A's listener updating the
  // cursor for an inactive slot).
  function installBrushCursor(session, wrapEl, cursorEl) {
    // R4.5.AuditFix P-R45-02: defensive null guards. A failed-to-load
    // slot (slot.session === null) must not crash the editor. The
    // call site in activateSlot only enters this path when
    // `slot.handle` is truthy (which means slot.session is also set
    // in normal flow), but a defensive guard makes the function
    // safe for any future caller. P-R45-09: same for cursorEl —
    // the wrap listener captures cursorEl in a closure and would
    // crash on the first mousemove if it were undefined.
    if (!session || !session.canvas || !wrapEl || !cursorEl) {
      // Return a no-op disposer so the caller can still call it
      // without a TypeError on a "dispose previous slot" call.
      return function disposeNoop() { /* no-op */ };
    }
    // Wrap-level listeners: idempotent one-time install.
    if (!wrapEl._ieBrushCursorInstalled) {
      // R4.5.AuditFix P-R45-13b: set the guard AFTER the
      // addEventListener calls. If addEventListener throws (e.g.
      // detached element, sandboxed env), the guard stays unset so
      // a retry can re-attach. Pre-fix: guard was set BEFORE the
      // addEventListener, so a failed install would lock out retries.
      function refresh(e) {
        const s = wrapEl._ieCurrentSession;
        if (!s) return;
        const drawing = (s.tool === 'pen' || s.tool === 'spray' || s.tool === 'eraser');
        if (!drawing) { cursorEl.style.display = 'none'; return; }
        const rect = wrapEl.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        cursorEl.style.display = 'block';
        cursorEl.style.left = px + 'px';
        cursorEl.style.top = py + 'px';
        // diameter in screen px = brushSize * zoom
        const diam = Math.max(2, s.brushSize * (s.zoom || 1));
        cursorEl.style.width = diam + 'px';
        cursorEl.style.height = diam + 'px';
      }
      wrapEl.addEventListener('mousemove', refresh);
      wrapEl.addEventListener('mouseleave', () => { cursorEl.style.display = 'none'; });
      // Set guard AFTER the listeners are attached.
      wrapEl._ieBrushCursorInstalled = true;
      wrapEl._ieCurrentSession = null;
    }

    // Detach the previous session's canvas listener (if any) so the
    // cursor is not updated by a stale session.
    const prev = wrapEl._ieCurrentSession;
    if (prev && prev !== session && prev._ieViewportHandler) {
      try { prev.canvas.off('ie:viewport', prev._ieViewportHandler); } catch (_) {}
      prev._ieViewportHandler = null;
    }
    // If we're reinstalling for the SAME session, remove the old
    // handler so we don't double-attach.
    if (prev === session && session._ieViewportHandler) {
      try { session.canvas.off('ie:viewport', session._ieViewportHandler); } catch (_) {}
      session._ieViewportHandler = null;
    }

    // Attach the canvas listener for the new session.
    function viewportHandler() {
      // keep the cursor sized correctly after zoom; position updates on next mousemove
      const diam = Math.max(2, session.brushSize * (session.zoom || 1));
      cursorEl.style.width = diam + 'px';
      cursorEl.style.height = diam + 'px';
    }
    try { session.canvas.on('ie:viewport', viewportHandler); } catch (_) {}
    session._ieViewportHandler = viewportHandler;
    wrapEl._ieCurrentSession = session;

    // Return a disposer the caller can use to remove the canvas listener
    // when the slot is closed or the cursor is uninstalled.
    return function disposeBrushCursor() {
      try {
        if (session._ieViewportHandler) {
          session.canvas.off('ie:viewport', session._ieViewportHandler);
          session._ieViewportHandler = null;
        }
      } catch (_) {}
      if (wrapEl._ieCurrentSession === session) {
        wrapEl._ieCurrentSession = null;
      }
    };
  }

  // PE-010: slot-revision guard for async results (heal / remove-bg /
  // bake / source-add). A job captures { id, rev } of its slot BEFORE
  // the await; on completion it may only commit if the SAME slot still
  // exists at the SAME revision — i.e. the user didn't switch slots and
  // no other job replaced the base meanwhile. Every base replacement
  // bumps the slot's revision (bumpSlotRev). The commit itself goes to
  // the CAPTURED session handle (ctrl._commitHandle) so a result can
  // never land on a different slot the user switched to mid-flight.
  function captureSlotRev(slot) {
    return slot ? { id: slot.id, rev: slot.revision || 0 } : null;
  }
  function slotRevValid(ctrl, cap) {
    if (!ctrl || !cap || !Array.isArray(ctrl.queue)) return false;
    const s = ctrl.queue.find((x) => x && x.id === cap.id);
    return !!s && (s.revision || 0) === cap.rev;
  }
  function bumpSlotRev(slot) {
    if (slot) slot.revision = (slot.revision || 0) + 1;
  }

  window.ImageEditorTools = {
    setTool,
    pushUndo,
    undo,
    redo,
    canUndo,
    canRedo,
    // R5.1: Savepoint/Dirty model infrastructure.
    setSavepoint,
    clearSavepoint,
    isModified,
    snapshotEqual,
    pickColorAt,
    scenePointOf,
    installBrushCursor,
    hexToRgb,
    hexWithAlpha,
    // PE-010: slot-revision guard for async results.
    captureSlotRev,
    slotRevValid,
    bumpSlotRev,
    snapshot, restore, // EFH2-005: crop rollback
  };
})();
