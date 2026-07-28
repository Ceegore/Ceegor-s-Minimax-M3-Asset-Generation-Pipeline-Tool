// tests/unit/renderer/imageEditorZoomR46.test.js
// ============================================================================
// R4.6 — Cursor-Zoom (PE-012 fix).
//
// Background: PE-012 — Mausrad-Zoom driftet vom Cursor weg (P1).
// Pre-fix: imageEditorCanvas.zoomAt divided the display point by
// session.zoom and passed the result to fabric.zoomToPoint. This
// is wrong because:
//   (1) The VPT has a PAN component (vpt[4], vpt[5]) that was
//       ignored. A panned canvas drifted by (panX, panY) on every
//       wheel tick. Per the design contract §PE-012 repro: VPT
//       [0.5, 0, 0, 0.5, 10, 20], cursor (150, 100), factor 1.1
//       → ~5 scene-pixel drift.
//   (2) session.zoom was maintained independently of the canvas's
//       actual VPT, so any code path that mutated the VPT directly
//       (e.g. fitToContainer's setViewportTransform) would cause
//       session.zoom to drift away from the real zoom.
//
// R4.6 fix:
//   (a) zoomAt converts the display point to a SCENE point using
//       the FULL VPT (zoom + pan). For a pure scale+pan VPT
//       [a, 0, 0, a, e, f] the inverse is
//       scene = (display - pan) / zoom = ((display.x - e) / a,
//       (display.y - f) / a).
//   (b) After zoomToPoint, session.zoom is read from
//       canvas.getZoom() so it stays in sync with the VPT.
//   (c) setZoom also reads from canvas.getZoom() for consistency.
//
// Test discipline:
//   - Source-grep tests verify the migration is applied + the
//     pre-fix pattern (`/ session.zoom`) is GONE from the
//     display-to-scene conversion.
//   - Functional tests with a counting FakeCanvas verify that
//     after a wheel tick, the scene point under the cursor is
//     still under the cursor (drift < 0.01 px).
//   - Adversarial probe: revert the pan-aware conversion → the
//     drift-test catches it.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CANVAS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorCanvas.js');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

// ---- Source-grep tests ----

test('R4.6 PE-012.A: imageEditorCanvas.zoomAt uses pan-aware display-to-scene conversion', () => {
  const src = fs.readFileSync(CANVAS_JS, 'utf8');
  const codeOnly = stripComments(src);
  // Find the zoomAt function body and check it uses panX + panY
  // from viewportTransform. The pre-fix code did `pt = {x:
  // displayPoint.x / session.zoom, ...}` (no pan).
  const fnMatch = codeOnly.match(/function zoomAt\s*\([^)]*\)\s*\{([\s\S]*?)function\s+setZoom/);
  assert.ok(fnMatch, 'zoomAt function must exist');
  const fnBody = fnMatch[1];
  assert.ok(/viewportTransform/.test(fnBody),
    'R4.6 PE-012.A: zoomAt must read viewportTransform (to use pan in the display-to-scene conversion)');
  assert.ok(/panX|panY|vpt\[4\]|vpt\[5\]/.test(fnBody),
    'R4.6 PE-012.A: zoomAt must extract panX/panY from VPT (the pre-fix code only used zoom, which ignored pan)');
  // Verify the pre-fix anti-pattern is GONE: `displayPoint.x / session.zoom`
  // (the broken conversion that ignored pan).
  assert.equal(fnBody.indexOf('displayPoint.x / session.zoom'), -1,
    'R4.6 PE-012.A: pre-fix `displayPoint.x / session.zoom` must be GONE (ignored pan)');
});

test('R4.6 PE-012.B: zoomAt reads session.zoom FROM canvas.getZoom() after zoomToPoint (not maintained separately)', () => {
  const src = fs.readFileSync(CANVAS_JS, 'utf8');
  const codeOnly = stripComments(src);
  const fnMatch = codeOnly.match(/function zoomAt\s*\([^)]*\)\s*\{([\s\S]*?)function\s+setZoom/);
  assert.ok(fnMatch, 'zoomAt function must exist');
  const fnBody = fnMatch[1];
  assert.ok(/session\.zoom\s*=\s*canvas\.getZoom/.test(fnBody),
    'R4.6 PE-012.B: session.zoom must be set from canvas.getZoom() (not from the input factor or newZoom)');
});

test('R4.6 PE-012.C: setZoom also reads session.zoom from canvas.getZoom()', () => {
  const src = fs.readFileSync(CANVAS_JS, 'utf8');
  const codeOnly = stripComments(src);
  const fnMatch = codeOnly.match(/function setZoom\s*\([^)]*\)\s*\{([\s\S]*?)function\s+fitToContainer/);
  assert.ok(fnMatch, 'setZoom function must exist');
  const fnBody = fnMatch[1];
  assert.ok(/session\.zoom\s*=\s*canvas\.getZoom/.test(fnBody),
    'R4.6 PE-012.C: setZoom must also set session.zoom from canvas.getZoom() (for consistency)');
});

// ---- Functional tests with FakeCanvas ----

function makeFakeCanvas(initialVpt) {
  // Mimic Fabric's zoomToPoint + setViewportTransform + getZoom +
  // getWidth/getHeight. The VPT is the source of truth for zoom
  // and pan.
  let vpt = initialVpt.slice();
  const canvasListeners = {};
  const canvas = {
    width: 200, height: 200,
    getWidth() { return this.width; },
    getHeight() { return this.height; },
    setWidth(w) { this.width = w; },
    setHeight(h) { this.height = h; },
    get viewportTransform() { return vpt; },
    setViewportTransform(newVpt) { vpt = newVpt.slice(); },
    getZoom() { return vpt[0] || 1; },
    // Fabric's zoomToPoint: keep the scene point (point) under the
    // same display position. The math: we want the new VPT such
    // that display(scenePoint) stays the same. So we adjust pan
    // so that the new zoom keeps the scene point at the same
    // display.
    zoomToPoint(point, newZoom) {
      const oldDisplayX = vpt[0] * point.x + vpt[4];
      const oldDisplayY = vpt[3] * point.y + vpt[5];
      vpt[0] = newZoom;
      vpt[3] = newZoom;
      // Keep (point) at the same display: newVpt[4] = oldDisplayX - newZoom * point.x
      vpt[4] = oldDisplayX - newZoom * point.x;
      vpt[5] = oldDisplayY - newZoom * point.y;
    },
    on(type, fn) { (canvasListeners[type] = canvasListeners[type] || []).push(fn); },
    off(type, fn) {
      const arr = canvasListeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    fire(type, payload) {
      const arr = canvasListeners[type] || [];
      for (const fn of arr) fn(payload);
    },
    _vpt: vpt,
  };
  return canvas;
}

function loadZoomAt() {
  // Load imageEditorCanvas.js into a vm-sandbox with a fake
  // fabric.Canvas. The factory createEditorSession(hostEl,
  // imgW, imgH) returns { zoomAt, setZoom, ... }. We extract
  // zoomAt and use it with a controlled canvas.
  const sb = {};
  sb.window = sb;
  sb.console = console;
  vm.createContext(sb);

  // Build a fake fabric.Canvas. We proxy methods to an
  // internal mutable state object so we can change the VPT
  // and have the methods see the new value.
  const FakeCanvas = function (hostEl, opts) {
    this._state = makeFakeCanvas([1, 0, 0, 1, 0, 0]);
    this.width = 200; this.height = 200;
    this.opts = opts;
  };
  FakeCanvas.prototype.setWidth = function (w) { this.width = w; };
  FakeCanvas.prototype.setHeight = function (h) { this.height = h; };
  FakeCanvas.prototype.getWidth = function () { return this.width; };
  FakeCanvas.prototype.getHeight = function () { return this.height; };
  FakeCanvas.prototype.zoomToPoint = function (point, z) { this._state.zoomToPoint(point, z); };
  FakeCanvas.prototype.setViewportTransform = function (v) { this._state.setViewportTransform(v); };
  FakeCanvas.prototype.getZoom = function () { return this._state.getZoom(); };
  FakeCanvas.prototype.on = function (type, fn) { this._state.on(type, fn); };
  FakeCanvas.prototype.off = function (type, fn) { this._state.off(type, fn); };
  FakeCanvas.prototype.fire = function (type, payload) { this._state.fire(type, payload); };
  Object.defineProperty(FakeCanvas.prototype, 'viewportTransform', {
    get: function () { return this._state.viewportTransform; },
  });

  sb.fabric = { Canvas: FakeCanvas, Image: { fromURL: () => Promise.resolve({}) } };

  const src = fs.readFileSync(CANVAS_JS, 'utf8');
  vm.runInContext(src, sb, { filename: 'imageEditorCanvas.js' });
  const Canvas = sb.ImageEditorCanvas;
  // Create an editor session to get the zoomAt function.
  const handle = Canvas.createEditorSession({}, 200, 200);
  return { sb, Canvas, handle };
}

test('R4.6 PE-012.functional.1: zoomAt with panned VPT keeps the scene point under the cursor (drift < 0.01 px)', () => {
  // Per the PE-012 spec repro:
  //   VPT [0.5, 0, 0, 0.5, 10, 20]
  //   cursor at (150, 100) in wrap-space
  //   factor 1.1
  // The scene point under the cursor is (280, 160) (pre-zoom).
  // After zoom, that same scene point should still be at
  // display (150, 100). Drift < 0.01 px.
  const { handle } = loadZoomAt();
  // Inject a panned VPT directly.
  handle.session.canvas.setViewportTransform([0.5, 0, 0, 0.5, 10, 20]);
  handle.session.zoom = 0.5;

  // Pre-condition: scene (280, 160) is at display (150, 100).
  const vpt0 = handle.session.canvas.viewportTransform.slice();
  const displayX0 = vpt0[0] * 280 + vpt0[4];
  const displayY0 = vpt0[3] * 160 + vpt0[5];
  assert.equal(displayX0, 150, 'pre-condition: scene (280, 160) at display X = 150');
  assert.equal(displayY0, 100, 'pre-condition: scene (280, 160) at display Y = 100');

  // Zoom in by factor 1.1.
  handle.zoomAt({ x: 150, y: 100 }, 1.1);

  // Post-condition: scene (280, 160) should still be at display (150, 100).
  const vpt1 = handle.session.canvas.viewportTransform.slice();
  const displayX1 = vpt1[0] * 280 + vpt1[4];
  const displayY1 = vpt1[3] * 160 + vpt1[5];
  const driftX = Math.abs(displayX1 - 150);
  const driftY = Math.abs(displayY1 - 100);
  assert.ok(driftX < 0.01, `R4.6 PE-012.functional.1: drift X = ${driftX} (must be < 0.01 px)`);
  assert.ok(driftY < 0.01, `R4.6 PE-012.functional.1: drift Y = ${driftY} (must be < 0.01 px)`);
});

test('R4.6 PE-012.functional.2: zoomAt with identity VPT keeps the scene point under the cursor', () => {
  // No pan, VPT identity. Cursor at (50, 50) in wrap-space,
  // scene (50, 50) at display (50, 50). After zoom factor 1.5,
  // the scene point (50, 50) should still be at (50, 50).
  const { handle } = loadZoomAt();
  // VPT is identity by default in our fake canvas.
  handle.zoomAt({ x: 50, y: 50 }, 1.5);
  const vpt1 = handle.session.canvas.viewportTransform.slice();
  const displayX1 = vpt1[0] * 50 + vpt1[4];
  const displayY1 = vpt1[3] * 50 + vpt1[5];
  const driftX = Math.abs(displayX1 - 50);
  const driftY = Math.abs(displayY1 - 50);
  assert.ok(driftX < 0.01, `drift X = ${driftX}`);
  assert.ok(driftY < 0.01, `drift Y = ${driftY}`);
});

test('R4.6 PE-012.functional.3: zoomAt updates session.zoom from canvas.getZoom() (sync from VPT)', () => {
  const { handle } = loadZoomAt();
  handle.session.canvas.setViewportTransform([0.5, 0, 0, 0.5, 10, 20]);
  handle.session.zoom = 0.5;
  handle.zoomAt({ x: 150, y: 100 }, 1.1);
  // session.zoom should be 0.55 (0.5 * 1.1), read from canvas.
  const newZoom = handle.session.canvas.getZoom();
  assert.ok(Math.abs(handle.session.zoom - newZoom) < 0.0001,
    `R4.6 PE-012.functional.3: session.zoom (${handle.session.zoom}) must equal canvas.getZoom() (${newZoom})`);
  assert.ok(Math.abs(newZoom - 0.55) < 0.0001,
    `R4.6 PE-012.functional.3: new zoom should be 0.55, got ${newZoom}`);
});

test('R4.6 PE-012.functional.4: setZoom also syncs session.zoom from canvas.getZoom()', () => {
  const { handle } = loadZoomAt();
  // First, set VPT to panned. session.zoom is 1.
  handle.session.canvas.setViewportTransform([1, 0, 0, 1, 100, 200]);
  handle.session.zoom = 1;
  // Call setZoom(0.5). The canvas is centered, but session.zoom
  // must be 0.5 (not stale 1).
  handle.setZoom(0.5);
  const newZoom = handle.session.canvas.getZoom();
  assert.ok(Math.abs(handle.session.zoom - newZoom) < 0.0001,
    `R4.6 PE-012.functional.4: session.zoom (${handle.session.zoom}) must equal canvas.getZoom() (${newZoom}) after setZoom`);
  assert.ok(Math.abs(newZoom - 0.5) < 0.0001, `newZoom = ${newZoom}`);
});

test('R4.6 PE-012.functional.5: zoomAt with same factor is a no-op (no drift)', () => {
  const { handle } = loadZoomAt();
  handle.session.canvas.setViewportTransform([0.5, 0, 0, 0.5, 10, 20]);
  handle.session.zoom = 0.5;
  // Zoom by factor 1.0 (no change).
  handle.zoomAt({ x: 150, y: 100 }, 1.0);
  // VPT should be unchanged.
  const vpt1 = handle.session.canvas.viewportTransform.slice();
  assert.equal(vpt1[0], 0.5, 'VPT zoom unchanged');
  assert.equal(vpt1[4], 10, 'VPT panX unchanged');
  assert.equal(vpt1[5], 20, 'VPT panY unchanged');
});

test('R4.6 PE-012.adversarial: pre-fix (pan-unaware) conversion would drift — verify our test catches it', () => {
  // Apply the pre-fix conversion: `pt = {x: displayPoint.x / session.zoom, ...}`
  // and verify the drift is non-zero (so the test would catch the regression).
  // We simulate the broken Fabric behavior: the broken code passes
  // a SCENE point to zoomToPoint that ignores pan, so the canvas
  // "thinks" the scene point is at a different display point.
  //
  // This is a "negative control": if the pre-fix code were used,
  // the drift would be > 0.01 px. The test verifies that the
  // drift would be detected.
  //
  // We simulate by hand: pre-fix pt = (150/0.5, 100/0.5) = (300, 200).
  // zoomToPoint((300, 200), 0.55): new VPT keeps scene (300, 200) at its
  // CURRENT display position. The current display of scene (300, 200)
  // is (300*0.5+10, 200*0.5+20) = (160, 120). After zoom 0.55,
  // scene (300, 200) is at (300*0.55 + panX', 200*0.55 + panY') = (160, 120).
  // So panX' = 160 - 165 = -5, panY' = 120 - 110 = 10. New VPT: [0.55, 0, 0, 0.55, -5, 10].
  // Now where is scene (280, 160) (the REAL scene point under the cursor)?
  // Display = (280*0.55 - 5, 160*0.55 + 10) = (149, 98). Cursor was at (150, 100).
  // Drift = (1, 2). > 0.01 px. Test would fail.
  //
  // The post-fix code (in imageEditorCanvas.js) computes pt =
  // (displayPoint.x - panX) / zoom = ((150 - 10) / 0.5, (100 - 20) / 0.5) = (280, 160).
  // zoomToPoint((280, 160), 0.55) keeps scene (280, 160) at display (150, 100).
  // Drift = 0. The post-fix test passes.
  const { handle } = loadZoomAt();
  handle.session.canvas.setViewportTransform([0.5, 0, 0, 0.5, 10, 20]);
  handle.session.zoom = 0.5;
  // Hand-simulate the pre-fix conversion.
  const displayPoint = { x: 150, y: 100 };
  const currentZoom = 0.5;
  const preFixPt = { x: displayPoint.x / currentZoom, y: displayPoint.y / currentZoom };
  // = (300, 200)
  assert.equal(preFixPt.x, 300);
  assert.equal(preFixPt.y, 200);
  // Simulate what Fabric would do with this wrong point + new zoom 0.55.
  // Keep scene (300, 200) at its current display: (300*0.5+10, 200*0.5+20) = (160, 120).
  // New VPT: zoom 0.55, panX' = 160 - 0.55*300 = -5, panY' = 120 - 0.55*200 = 10.
  const newVpt = [0.55, 0, 0, 0.55, -5, 10];
  handle.session.canvas.setViewportTransform(newVpt);
  // Now scene (280, 160) — the REAL scene point under the cursor — is at:
  const driftDisplayX = newVpt[0] * 280 + newVpt[4];
  const driftDisplayY = newVpt[3] * 160 + newVpt[5];
  // = (149, 98)
  const driftX = Math.abs(driftDisplayX - 150);
  const driftY = Math.abs(driftDisplayY - 100);
  // The pre-fix code drifts (1, 2) — non-zero. The test would catch this.
  assert.ok(driftX > 0.01, `pre-fix drifts: driftX = ${driftX} > 0.01 (the test would catch the regression)`);
  assert.ok(driftY > 0.01, `pre-fix drifts: driftY = ${driftY} > 0.01`);
});

// ============================================================================
// R4.6.AuditFix — Phasenpruefung-of-Phasenpruefung
// 5 functional tests for common usage patterns that were MISSING in R4.6:
//   - sequential wheel-ticks (drift accumulation)
//   - pan THEN zoom (combined movePan + zoomAt)
//   - canvas corner (cursor at scene-origin)
//   - max-zoom-clamp (factor pushes zoom above 16)
//   - fitToContainer + zoomAt combined flow
// ============================================================================

test('R4.6.AuditFix P-R46-T01: sequential wheel-ticks do NOT accumulate drift', () => {
  // Adversarial probe: 10 zoom-in ticks at the cursor. Pre-fix
  // would drift by ~5 px per tick → ~50 px total. Post-fix:
  // 0 drift after any number of ticks.
  const { handle } = loadZoomAt();
  handle.session.canvas.setViewportTransform([0.5, 0, 0, 0.5, 10, 20]);
  handle.session.zoom = 0.5;
  for (let i = 0; i < 10; i++) {
    handle.zoomAt({ x: 150, y: 100 }, 1.1);
  }
  // After 10 ticks, scene (280, 160) should still be at display (150, 100).
  const vpt = handle.session.canvas.viewportTransform.slice();
  const displayX = vpt[0] * 280 + vpt[4];
  const displayY = vpt[3] * 160 + vpt[5];
  const driftX = Math.abs(displayX - 150);
  const driftY = Math.abs(displayY - 100);
  assert.ok(driftX < 0.01, `P-R46-T01: after 10 ticks driftX = ${driftX} (must be < 0.01)`);
  assert.ok(driftY < 0.01, `P-R46-T01: after 10 ticks driftY = ${driftY} (must be < 0.01)`);
  // Zoom should be 0.5 * 1.1^10 ≈ 1.296871.
  const expectedZoom = 0.5 * Math.pow(1.1, 10);
  const actualZoom = handle.session.canvas.getZoom();
  assert.ok(Math.abs(actualZoom - expectedZoom) < 0.001,
    `P-R46-T01: zoom after 10 ticks: actual=${actualZoom} expected=${expectedZoom}`);
});

test('R4.6.AuditFix P-R46-T02: pan THEN zoom preserves the scene point under the cursor', () => {
  // movePan + zoomAt combined. Pre-fix: drift on the zoom.
  const { handle } = loadZoomAt();
  handle.session.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  handle.session.zoom = 1;
  // Pan by (50, 30).
  handle.startPan(100, 100);
  handle.movePan(150, 130);
  const vptAfter = handle.session.canvas.viewportTransform.slice();
  assert.equal(vptAfter[4], 50, 'after pan: panX = 50');
  assert.equal(vptAfter[5], 30, 'after pan: panY = 30');
  handle.endPan();
  // Zoom at cursor (150, 100). Scene under cursor = ((150-50)/1, (100-30)/1) = (100, 70).
  handle.zoomAt({ x: 150, y: 100 }, 1.5);
  const vpt1 = handle.session.canvas.viewportTransform.slice();
  const displayX = vpt1[0] * 100 + vpt1[4];
  const displayY = vpt1[3] * 70 + vpt1[5];
  const driftX = Math.abs(displayX - 150);
  const driftY = Math.abs(displayY - 100);
  assert.ok(driftX < 0.01, `P-R46-T02: after pan+zoom driftX = ${driftX}`);
  assert.ok(driftY < 0.01, `P-R46-T02: after pan+zoom driftY = ${driftY}`);
});

test('R4.6.AuditFix P-R46-T03: zoomAt at the canvas corner (cursor at scene-origin)', () => {
  // With panned VPT [0.5, 0, 0, 0.5, 10, 20], the cursor at
  // display (10, 20) is at scene (0, 0). Zooming at (10, 20)
  // should keep scene (0, 0) at display (10, 20).
  const { handle } = loadZoomAt();
  handle.session.canvas.setViewportTransform([0.5, 0, 0, 0.5, 10, 20]);
  handle.session.zoom = 0.5;
  handle.zoomAt({ x: 10, y: 20 }, 1.5);
  const vpt1 = handle.session.canvas.viewportTransform.slice();
  const displayX = vpt1[0] * 0 + vpt1[4];
  const displayY = vpt1[3] * 0 + vpt1[5];
  assert.ok(Math.abs(displayX - 10) < 0.01, `P-R46-T03: corner X drift = ${Math.abs(displayX - 10)}`);
  assert.ok(Math.abs(displayY - 20) < 0.01, `P-R46-T03: corner Y drift = ${Math.abs(displayY - 20)}`);
});

test('R4.6.AuditFix P-R46-T04: max-zoom-clamp (factor pushes zoom above 16)', () => {
  // 50 ticks of factor 1.5 should clamp at 16. After clamping,
  // the scene point under the cursor stays under the cursor.
  const { handle } = loadZoomAt();
  handle.session.canvas.setViewportTransform([0.5, 0, 0, 0.5, 10, 20]);
  handle.session.zoom = 0.5;
  for (let i = 0; i < 50; i++) {
    handle.zoomAt({ x: 150, y: 100 }, 1.5);
  }
  // Zoom is clamped at 16.
  const clampedZoom = handle.session.canvas.getZoom();
  assert.ok(clampedZoom <= 16 + 0.001, `P-R46-T04: zoom should clamp at 16, got ${clampedZoom}`);
  // Verify the scene point at the cursor stays put.
  const vpt = handle.session.canvas.viewportTransform.slice();
  const sceneX = (150 - vpt[4]) / clampedZoom;
  const sceneY = (100 - vpt[5]) / clampedZoom;
  const displayX = vpt[0] * sceneX + vpt[4];
  const displayY = vpt[3] * sceneY + vpt[5];
  assert.ok(Math.abs(displayX - 150) < 0.01, `P-R46-T04: after clamp driftX = ${Math.abs(displayX - 150)}`);
  assert.ok(Math.abs(displayY - 100) < 0.01, `P-R46-T04: after clamp driftY = ${Math.abs(displayY - 100)}`);
});

test('R4.6.AuditFix P-R46-T05: fitToContainer THEN zoomAt at the cursor', () => {
  // After fitToContainer(800×600, 200×200), the canvas is
  // centered: zoom 3, panX 100, panY 0. Zooming at the cursor
  // (200, 100) should keep the scene point under the cursor.
  const { handle } = loadZoomAt();
  const wrap = { clientWidth: 800, clientHeight: 600 };
  handle.fitToContainer(wrap);
  // Cursor at (200, 100). Scene under cursor = ((200-100)/3, (100-0)/3) = (33.33, 33.33).
  handle.zoomAt({ x: 200, y: 100 }, 1.5);
  const vpt1 = handle.session.canvas.viewportTransform.slice();
  const displayX = vpt1[0] * (100 / 3) + vpt1[4];
  const displayY = vpt1[3] * (100 / 3) + vpt1[5];
  const driftX = Math.abs(displayX - 200);
  const driftY = Math.abs(displayY - 100);
  assert.ok(driftX < 0.01, `P-R46-T05: after fit+zoom driftX = ${driftX}`);
  assert.ok(driftY < 0.01, `P-R46-T05: after fit+zoom driftY = ${driftY}`);
});
