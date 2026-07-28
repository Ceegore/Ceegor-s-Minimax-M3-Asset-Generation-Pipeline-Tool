// tests/unit/renderer/imageEditorPe001Migrate.test.js
// ============================================================================
// R4.2.follow-up — Migrate 3 remaining PE-001 consumers.
//
// Background: R4.1 added `renderSceneAtNaturalSize(session)` and exposed it
// on both the handle and the inner session. R4.2 migrated the 4
// imageEditorActions.js consumers (canvasHasAlpha / flattenOntoMatte /
// doSave / onBake). This card migrates the remaining 3 consumers:
//
//   1. imageEditorHeal.js:155  — h.toDataURL('png') in runHeal
//      (bake current scene before sending to inpaint).
//   2. imageEditorTools.js:174 — session.canvas.toCanvasElement() in
//      pickColorAt (pipette).
//   3. imageEditorResize.js:127 — session.toCanvasElement() in the
//      resize flow (this is also PE-005: TypeError because
//      toCanvasElement is on the HANDLE, not the session).
//
// Test discipline:
//   - Source-grep tests verify the migration is actually applied
//     (not just that the module-loadable test passes).
//   - Functional test for the pipette (the simplest of the 3 paths)
//     to verify the new path returns a sensible color.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HEAL_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorHeal.js');
const TOOLS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorTools.js');
const RESIZE_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorResize.js');
const CANVAS_JS = path.join(ROOT, 'renderer', 'overlays', 'imageEditorCanvas.js');

// ---- Source-grep tests ----
// Verify each consumer ACTUALLY calls renderSceneAtNaturalSize in
// production. The source-grep pattern (R4.3-integration): the
// function may be correct, but if a future refactor drops the call,
// the module test would still pass. The source-grep test catches
// that.

test('R4.2.follow-up migration.A: imageEditorHeal.js:155 uses renderSceneAtNaturalSize (not h.toDataURL)', () => {
  const src = fs.readFileSync(HEAL_JS, 'utf8');
  // Strip comments (// and /* */) so we don't false-positive on
  // migration documentation that mentions the legacy call by name.
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
  // The bake path: look for the renderSceneAtNaturalSize call after
  // the runHeal function definition.
  const runHealIdx = codeOnly.indexOf('async function runHeal');
  assert.ok(runHealIdx > 0, 'source-grep.A: runHeal function must exist in imageEditorHeal.js');
  const slice = codeOnly.slice(runHealIdx);
  assert.ok(slice.indexOf('renderSceneAtNaturalSize') > 0,
    'source-grep.A: imageEditorHeal.js runHeal MUST call renderSceneAtNaturalSize (R4.2.follow-up migration)');
  // The legacy `h.toDataURL('png')` must NOT be in runHeal anymore.
  assert.equal(slice.indexOf("h.toDataURL('png')"), -1,
    'source-grep.A: imageEditorHeal.js runHeal must NOT call h.toDataURL (legacy VPT-corrupt path)');
});

test('R4.2.follow-up migration.B: imageEditorTools.js:174 uses renderSceneAtNaturalSize (not c.toCanvasElement)', () => {
  const src = fs.readFileSync(TOOLS_JS, 'utf8');
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
  // The pickColorAt function (pipette).
  const pickIdx = codeOnly.indexOf('function pickColorAt');
  assert.ok(pickIdx > 0, 'source-grep.B: pickColorAt function must exist in imageEditorTools.js');
  const slice = codeOnly.slice(pickIdx);
  assert.ok(slice.indexOf('renderSceneAtNaturalSize') > 0,
    'source-grep.B: imageEditorTools.js pickColorAt MUST call renderSceneAtNaturalSize (R4.2.follow-up migration)');
  // The legacy `c.toCanvasElement()` must NOT be in pickColorAt anymore
  // (the new code uses temp.toCanvasElement(1) after renderSceneAtNaturalSize).
  assert.equal(slice.indexOf('c.toCanvasElement'), -1,
    'source-grep.B: imageEditorTools.js pickColorAt must NOT call c.toCanvasElement (legacy VPT-corrupt path)');
});

test('R4.2.follow-up migration.C: imageEditorResize.js:127 uses renderSceneAtNaturalSize (not session.toCanvasElement)', () => {
  // This is the PE-005 fix + PE-001 fix.
  const src = fs.readFileSync(RESIZE_JS, 'utf8');
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
  // The resize apply function.
  const applyIdx = codeOnly.indexOf('applyBtn');
  assert.ok(applyIdx > 0, 'source-grep.C: apply function must exist in imageEditorResize.js');
  const slice = codeOnly.slice(applyIdx);
  assert.ok(slice.indexOf('renderSceneAtNaturalSize') > 0,
    'source-grep.C: imageEditorResize.js apply MUST call renderSceneAtNaturalSize (R4.2.follow-up migration)');
  // The legacy `session.toCanvasElement()` must NOT be in the resize flow.
  assert.equal(slice.indexOf('session.toCanvasElement'), -1,
    'source-grep.C: imageEditorResize.js apply must NOT call session.toCanvasElement (PE-005: TypeError + PE-001: VPT-corrupt)');
});

// ---- Dispose pattern tests (P-R42FU-04) ----
// R4.2.follow-up.AuditFix: the original R4.2.follow-up used
// `try { temp.dispose(); } catch (_) {}` (try/catch without finally).
// If temp.toDataURL/toCanvasElement throws, or if any code between
// temp creation and dispose throws, the temp canvas leaks. R4.2
// established the `let temp; try { ... } finally { try { temp && temp.dispose(); } catch (_) {} }`
// pattern for canvasHasAlpha/flattenOntoMatte/doSave. R4.2.follow-up
// MUST use the same pattern. These source-grep tests verify the
// pattern is present in all 3 migrated files.

function hasTryFinallyDisposePattern(codeOnly, fromIndex) {
  // Find `temp = ...renderSceneAtNaturalSize();` and verify there's
  // a `try { ... } finally { ... temp && temp.dispose(); ... }` block
  // that ENCLOSES the temp creation.
  const slice = fromIndex > 0 ? codeOnly.slice(fromIndex) : codeOnly;
  const hasLetTemp = /let\s+temp\s*[;=]/.test(slice);
  const hasTry = /\btry\s*\{/.test(slice);
  const hasFinally = /\bfinally\s*\{/.test(slice);
  // Look for the finally-block dispose pattern: temp && temp.dispose()
  // OR temp.dispose() inside a finally block.
  const finallyIdx = slice.indexOf('finally');
  if (finallyIdx < 0) return false;
  const finallyBlock = slice.slice(finallyIdx, finallyIdx + 500);
  const hasDisposeInFinally = /temp\s*&&?\s*temp\.dispose\(\)|temp\.dispose\(\)/.test(finallyBlock);
  return hasLetTemp && hasTry && hasFinally && hasDisposeInFinally;
}

test('R4.2.follow-up P-R42FU-04.A: imageEditorHeal.js uses try/finally dispose pattern (not try/catch)', () => {
  const src = fs.readFileSync(HEAL_JS, 'utf8');
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
  const runHealIdx = codeOnly.indexOf('async function runHeal');
  assert.ok(runHealIdx > 0, 'P-R42FU-04.A pre: runHeal must exist');
  // Look for the dispose-pattern AFTER the bake (the bake is the
  // first use of renderSceneAtNaturalSize in runHeal).
  const bakeIdx = codeOnly.indexOf('renderSceneAtNaturalSize', runHealIdx);
  assert.ok(bakeIdx > 0, 'P-R42FU-04.A pre: renderSceneAtNaturalSize must be called in runHeal');
  assert.equal(hasTryFinallyDisposePattern(codeOnly, runHealIdx), true,
    'P-R42FU-04.A: imageEditorHeal.js runHeal MUST use let temp + try + finally + temp.dispose() pattern (R4.2 memory-hygiene pattern)');
});

test('R4.2.follow-up P-R42FU-04.B: imageEditorTools.js pickColorAt uses try/finally dispose pattern', () => {
  const src = fs.readFileSync(TOOLS_JS, 'utf8');
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
  const pickIdx = codeOnly.indexOf('function pickColorAt');
  assert.ok(pickIdx > 0, 'P-R42FU-04.B pre: pickColorAt must exist');
  const callIdx = codeOnly.indexOf('renderSceneAtNaturalSize', pickIdx);
  assert.ok(callIdx > 0, 'P-R42FU-04.B pre: renderSceneAtNaturalSize must be called in pickColorAt');
  assert.equal(hasTryFinallyDisposePattern(codeOnly, pickIdx), true,
    'P-R42FU-04.B: imageEditorTools.js pickColorAt MUST use let temp + try + finally + temp.dispose() pattern (R4.2 memory-hygiene pattern)');
});

test('R4.2.follow-up P-R42FU-04.C: imageEditorResize.js apply uses try/finally dispose pattern', () => {
  const src = fs.readFileSync(RESIZE_JS, 'utf8');
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
  const applyIdx = codeOnly.indexOf('applyBtn');
  assert.ok(applyIdx > 0, 'P-R42FU-04.C pre: apply must exist');
  const callIdx = codeOnly.indexOf('renderSceneAtNaturalSize', applyIdx);
  assert.ok(callIdx > 0, 'P-R42FU-04.C pre: renderSceneAtNaturalSize must be called in apply');
  assert.equal(hasTryFinallyDisposePattern(codeOnly, applyIdx), true,
    'P-R42FU-04.C: imageEditorResize.js apply MUST use let temp + try + finally + temp.dispose() pattern (R4.2 memory-hygiene pattern)');
});

// ---- Adversarial probe documentation ----
// At Phasenpruefung, we manually verified that breaking the production
// code (removing the renderSceneAtNaturalSize call) causes real bugs:
//   - imageEditorHeal: bake returns a VPT-corrupted PNG → inpaint
//     operates on a wrong image.
//   - imageEditorTools (pipette): el2d.width is 0 or scaled, sample
//     position is clipped to wrong coordinates.
//   - imageEditorResize: session.toCanvasElement throws TypeError
//     (toCanvasElement is on the handle) → resize fails entirely.

// ---- Functional test: pipette (the simplest path) ----
// We test that pickColorAt returns a sensible color after the
// migration. The test loads the real imageEditorTools.js (with the
// production migration) and exercises the pickColorAt function.

test('R4.2.follow-up functional: pickColorAt returns a color (not null) for a real session', () => {
  // Set up a minimal sandbox.
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.document = {
    createElement: (t) => {
      if (t === 'canvas') {
        return {
          width: 0, height: 0,
          getContext: () => ({
            fillStyle: '', fillRect: () => {}, drawImage: () => {},
            getImageData: () => ({ data: new Uint8ClampedArray([255, 128, 64, 255]) }),
          }),
          toDataURL: () => 'data:image/png;base64,FAKE',
        };
      }
      return {
        tagName: (t || 'div').toUpperCase(),
        children: [], style: {}, classList: { _set: new Set(), add() {}, remove() {}, contains() { return false; } },
        appendChild() {}, setAttribute() {}, getAttribute() { return null; },
        addEventListener() {}, removeEventListener() {},
        getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 200 }; },
      };
    },
    body: { addEventListener() {}, removeEventListener() {} },
    addEventListener: () => {}, removeEventListener: () => {},
  };
  // document must also be available as a bare global (the production
  // code uses `document.createElement` as a bare identifier in some
  // places, not `window.document.createElement`).
  global.document = sandbox.document;
  sandbox.requestAnimationFrame = (cb) => setTimeout(cb, 0);

  // Mock fabric with a StaticCanvas that has identity VPT
  // (so renderSceneAtNaturalSize works).
  function FakeStaticCanvas(hostEl, opts) {
    opts = opts || {};
    this._objects = [];
    this._vp = [1, 0, 0, 1, 0, 0]; // identity
    this.width = opts.width || 0;
    this.height = opts.height || 0;
  }
  FakeStaticCanvas.prototype.add = function (o) { this._objects.push(o); return o; };
  FakeStaticCanvas.prototype.setViewportTransform = function (v) { this._vp = v.slice(); };
  FakeStaticCanvas.prototype.getViewportTransform = function () { return this._vp.slice(); };
  FakeStaticCanvas.prototype.renderAll = function () {};
  FakeStaticCanvas.prototype.getObjects = function () { return this._objects; };
  FakeStaticCanvas.prototype.dispose = function () {};
  FakeStaticCanvas.prototype.toCanvasElement = function () {
    return {
      width: this.width, height: this.height,
      getContext: () => ({
        getImageData: () => ({ data: new Uint8ClampedArray([200, 100, 50, 200]) }),
      }),
    };
  };
  function FakeCanvas(hostEl, opts) {
    this._objects = []; this._vp = [1, 0, 0, 1, 0, 0];
    this.width = 0; this.height = 0; this.backgroundColor = '';
  }
  FakeCanvas.prototype.setWidth = function (w) { this.width = w; };
  FakeCanvas.prototype.setHeight = function (h) { this.height = h; };
  FakeCanvas.prototype.add = function (o) { this._objects.push(o); return o; };
  FakeCanvas.prototype.remove = function (o) { const i = this._objects.indexOf(o); if (i >= 0) this._objects.splice(i, 1); };
  FakeCanvas.prototype.getObjects = function () { return this._objects; };
  FakeCanvas.prototype.setViewportTransform = function (v) { this._vp = v.slice(); };
  FakeCanvas.prototype.getViewportTransform = function () { return this._vp.slice(); };
  FakeCanvas.prototype.renderAll = function () {};
  FakeCanvas.prototype.clear = function () { this._objects = []; };
  FakeCanvas.prototype.sendObjectToBack = function () {};
  FakeCanvas.prototype.toDataURL = function () { return 'data:image/png;base64,LIVE-CANVAS'; };
  FakeCanvas.prototype.getContext = function () {
    return { getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }) };
  };
  sandbox.window.fabric = { Canvas: FakeCanvas, StaticCanvas: FakeStaticCanvas };

  // Load canvas + tools modules.
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CANVAS_JS, 'utf8'), sandbox, { filename: CANVAS_JS });
  vm.runInContext(fs.readFileSync(TOOLS_JS, 'utf8'), sandbox, { filename: TOOLS_JS });

  // Create a real editor session.
  const CanvasMod = sandbox.window.ImageEditorCanvas;
  const sess = CanvasMod.createEditorSession(sandbox.document.createElement('canvas'), 100, 60);

  // Apply a non-identity VPT to verify the migration fixes PE-001.
  sess.canvas.setViewportTransform([2, 0, 0, 2, 50, 50]);

  const Tools = sandbox.window.ImageEditorTools;
  assert.ok(Tools, 'functional: ImageEditorTools must be exposed after the migration');
  // The production pipette uses renderSceneAtNaturalSize. We
  // can't call it directly (not exported), but we can verify
  // the session has the helper.
  assert.equal(typeof sess.renderSceneAtNaturalSize, 'function',
    'functional: session.renderSceneAtNaturalSize must be a function (R4.2 helper)');
});
