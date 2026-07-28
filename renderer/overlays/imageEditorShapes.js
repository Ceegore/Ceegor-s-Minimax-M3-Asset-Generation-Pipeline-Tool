// renderer/overlays/imageEditorShapes.js (pixel editor)
// The "bar" (line) painting tool (H8-002). Two clicks place a thin editable bar:
// click 1 = anchor endpoint, move = live preview, click 2 = finalize. The bar is
// modeled as a fabric.Rect (width = length, height = strength, originX/Y center)
// rather than fabric.Line so endpoint math stays explicit (center + angle +
// length), rotation around center is native, and bake/save/undo/objects-list all
// treat it like any placed object.
//
// After placement, two custom Controls let the user drag either endpoint; the
// opposite endpoint stays fixed and center/width/angle recompute. The standard
// `mtr` rotate control is retained (rotation pivots on the bar's middle).
//
// Pure endpoint math is exported for unit testing.

(function () {
  'use strict';

  // ---- pure endpoint math (unit-testable, no DOM/Fabric) ----
  // Given a bar's center, length, and angle (radians, CCW from +x), return the
  // two endpoint coordinates.
  function endpointsOf(centerX, centerY, length, angle) {
    const hx = (length / 2) * Math.cos(angle);
    const hy = (length / 2) * Math.sin(angle);
    return [
      { x: centerX - hx, y: centerY - hy },
      { x: centerX + hx, y: centerY + hy },
    ];
  }
  // Given two endpoints + a strength, return {centerX, centerY, length, angle}.
  function barFromEndpoints(p1, p2) {
    const centerX = (p1.x + p2.x) / 2;
    const centerY = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    return { centerX, centerY, length, angle };
  }

  // ---- placement state machine ----
  // Each editor controller carries ctrl._barState = { pending: null|{x,y} }.
  // `arm` is called when the user picks the bar tool; `onMouseDown`/`onMouseMove`
  // drive placement; `cancel` aborts (tool switch / queue switch / right-click).
  function arm(ctrl) {
    if (!ctrl._barState) ctrl._barState = { pending: null, preview: null };
  }

  function cancel(ctrl, activeSlotFn) {
    const st = ctrl._barState;
    if (!st) return;
    if (st.preview) {
      try {
        const slot = activeSlotFn ? activeSlotFn() : (ctrl.queue && ctrl.queue[ctrl.activeIndex]);
        if (slot) slot.session.canvas.remove(st.preview);
      } catch (_) {}
      st.preview = null;
    }
    st.pending = null;
  }

  // Active-slot accessor passed in by the overlay (avoids a circular dep).
  function activeSlotOf(ctrl, activeSlotFn) { return activeSlotFn ? activeSlotFn() : null; }

  // mouse:down handler for the bar tool. `p` is the SCENE point.
  // PE-036: only respond to the primary mouse button (button 0).
  // Right-click and middle-click are ignored (right-click cancels
  // via the contextmenu handler in the overlay).
  function onMouseDown(ctrl, p, activeSlotFn, Tools, nativeEvent) {
    if (nativeEvent && nativeEvent.button !== 0) return; // PE-036: primary only
    arm(ctrl);
    const st = ctrl._barState;
    const slot = activeSlotOf(ctrl, activeSlotFn); if (!slot) return;
    const fabric = slot.session.fabric;
    const canvas = slot.session.canvas;
    if (!st.pending) {
      // Click 1: store the anchor; start a live preview rect.
      st.pending = { x: p.x, y: p.y };
      st.preview = new fabric.Rect({
        left: p.x, top: p.y, width: 0, height: slot.session.brushSize,
        originX: 'left', originY: 'center',
        fill: Tools.hexWithAlpha(slot.session.fg, slot.session.brushOpacity),
        stroke: null, strokeWidth: 0,
        selectable: false, evented: false, excludeFromExport: true,
      });
      canvas.add(st.preview);
      return;
    }
    // Click 2: finalize. Replace the preview with the real bar.
    if (st.preview) { try { canvas.remove(st.preview); } catch (_) {} st.preview = null; }
    const a = st.pending; st.pending = null;
    const bar = barFromEndpoints(a, p);
    const rect = new fabric.Rect({
      left: bar.centerX, top: bar.centerY,
      width: Math.max(1, bar.length), height: Math.max(1, slot.session.brushSize),
      originX: 'center', originY: 'center',
      angle: bar.angle * 180 / Math.PI,
      fill: Tools.hexWithAlpha(slot.session.fg, slot.session.brushOpacity),
      stroke: null, strokeWidth: 0,
      selectable: true, evented: true,
    });
    rect.ieKind = 'bar'; // marker used by the Objects list + the Size-slider hook
    attachEndpointControls(rect, fabric);
    // R5.2 Bar: PRE-SNAPSHOT before canvas.add(rect). Pre-fix, the
    // pushUndo was AFTER canvas.add(rect), so the pre-snapshot was
    // the post-add state. Undo would pop the post-add state and
    // restore to it (no visible change). The user had to undo TWICE
    // to get back to before the bar. Post-R5.2: pushUndo BEFORE
    // canvas.add(rect) so a single undo restores the pre-bar state
    // (PE-005-Pixelvertrag). Wrapped in try/catch defensive.
    try { Tools.pushUndo(slot.session); } catch (_) { /* defensive */ }
    canvas.add(rect);
    canvas.setActiveObject(rect);
    slot.modified = true;
    // R5.2.AuditFix P-R52Bar-F1: refreshQueueBar post-action is
    // required to update the queue bar's "modified" badge.
    if (window.ImageEditorSource) {
      window.ImageEditorSource.refreshObjectsList(ctrl);
      window.ImageEditorSource.refreshQueueBar(ctrl);
    }
    try { canvas.fire('object:modified'); } catch (_) {}
  }

  // mouse:move handler — updates the live preview rect while placing.
  function onMouseMove(ctrl, p, activeSlotFn) {
    const st = ctrl._barState;
    if (!st || !st.pending) return;
    const slot = activeSlotOf(ctrl, activeSlotFn); if (!slot) return;
    const a = st.pending;
    const bar = barFromEndpoints(a, p);
    if (!st.preview) return;
    st.preview.set({
      left: bar.centerX, top: bar.centerY,
      width: Math.max(1, bar.length),
      angle: bar.angle * 180 / Math.PI,
      originX: 'center', originY: 'center',
    });
    slot.session.canvas.requestRenderAll();
  }

  // ---- custom Controls: drag either endpoint, keep the other fixed ----
  function attachEndpointControls(rect, fabric) {
    // PE-019 fix: Fabric v6 exposes `fabric.Control` (singular), NOT
    // `fabric.Controls`. The old guard `!fabric.Controls` always returned
    // early, so endpoint handles were never installed.
    if (!fabric || !fabric.Control) return;
    try {
      // positionHandler: where the handle renders, in object coords.
      const endpointPos = (sign) => (dim, finalPosition, fabricObject) => {
        const len = fabricObject.width || 1;
        return { x: sign * (len / 2), y: 0 };
      };
      // actionHandler: on drag, recompute center/width/angle from the new
      // endpoint + the fixed opposite endpoint. Fabric passes `x,y` as the
      // pointer in canvas coords (target relative in v6's transform handler);
      // we compute the fixed opposite endpoint in canvas coords, then derive the
      // new bar geometry. `sign` = which end is being dragged (-1 = left/e1, +1
      // = right/e2); the opposite end keeps its position.
      const endpointAction = (sign) => (eventData, transform, x, y) => {
        const target = transform.target;
        const ang = (target.angle || 0) * Math.PI / 180;
        const len = target.width || 1;
        // Opposite endpoint (fixed) = center + oppositeSign*(len/2) rotated by ang.
        const oppSign = -sign;
        const hx = oppSign * (len / 2) * Math.cos(ang);
        const hy = oppSign * (len / 2) * Math.sin(ang);
        const fixed = { x: target.left + hx, y: target.top + hy };
        const moved = { x: x, y: y };
        const p1 = sign > 0 ? fixed : moved;
        const p2 = sign > 0 ? moved : fixed;
        const bar = barFromEndpoints(p1, p2);
        target.set({
          left: bar.centerX, top: bar.centerY,
          width: Math.max(1, bar.length),
          angle: bar.angle * 180 / Math.PI,
        });
        return true;
      };
      rect.controls = Object.assign({}, rect.controls, {
        e1: new fabric.Control({ positionHandler: endpointPos(-1), actionHandler: endpointAction(-1), x: -0.5, y: 0 }),
        e2: new fabric.Control({ positionHandler: endpointPos(1), actionHandler: endpointAction(1), x: 0.5, y: 0 }),
      });
    } catch (_) { /* best-effort: endpoint controls are a nicety, not required */ }
  }

  // Convert a point in the object's local frame to canvas coords using the
  // object's current transform. (Kept for completeness/tests; the action handler
  // above works in canvas coords directly.)
  function canvasPointFromLocal(target, localPoint, fabric) {
    const m = target.calcTransformMatrix();
    const p = fabric.util.transformPoint(new fabric.Point(localPoint.x, localPoint.y), m);
    return { x: p.x, y: p.y };
  }

  window.ImageEditorShapes = {
    endpointsOf, barFromEndpoints,
    arm, cancel, onMouseDown, onMouseMove, attachEndpointControls,
  };
})();
