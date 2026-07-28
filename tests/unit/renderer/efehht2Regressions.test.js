// tests/unit/renderer/efehht2Regressions.test.js
//
// Regression tests for the EFEHHT-2 fix batch (2026-07-25).
// Covers:
//   EFH2-001: pipelineCardProgress wireProgressIpc + applyProgress
//   EFH2-004: imageOptimizer PNG palette default
//   EFH2-005: imageEditorTools snapshot/restore export
//   EFH2-007d: toPersistable returns undefined (not null) on failure
//   EFH2-007h: imageResize switch-case block scoping (syntax check)

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ============================================================
// EFH2-001: pipelineCardProgress wireProgressIpc + applyProgress
// ============================================================
test('EFH2-001: PipelineCardProgress exports wireProgressIpc and applyProgress updates item._progress', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineCardProgress.js'), 'utf8');
  const sandbox = { window: {}, document: { querySelector: () => null } };
  sandbox.window.Spinner = {
    determinateBar: () => ({ bar: {}, set: () => {} }),
    indeterminateBar: () => ({}),
  };
  sandbox.window.state = { pipeline: { image: { items: [] } } };
  sandbox.window.PipelineBoard = { updateCard: () => {} };
  let subscribedCb = null;
  sandbox.window.api = {
    onRealesrganProgress: (cb) => { subscribedCb = cb; return () => {}; },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  const P = sandbox.window.PipelineCardProgress;
  assert.ok(P, 'PipelineCardProgress exported');
  assert.strictEqual(typeof P.wireProgressIpc, 'function', 'wireProgressIpc is a function');
  assert.strictEqual(typeof P.applyProgress, 'function', 'applyProgress is a function');
  assert.strictEqual(typeof P.clearProgressSetter, 'function', 'clearProgressSetter is a function');

  // Wire the IPC
  P.wireProgressIpc();
  assert.ok(subscribedCb, 'onRealesrganProgress was subscribed');

  // Simulate a progress event
  const item = { id: 'test-item', status: 'running', _progress: null };
  sandbox.window.state.pipeline.image.items = [item];
  subscribedCb({ key: 'test-item', pct: 42, runGen: 1 });
  assert.ok(item._progress, 'item._progress was set');
  assert.strictEqual(item._progress.pct, 42, 'pct is 42');
});

// ============================================================
// EFH2-004: imageOptimizer PNG palette default
// ============================================================
test('EFH2-004: imageOptimizer PNG palette defaults to false (full-colour)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'imageOptimizer.js'), 'utf8');
  // The fix changed `palette: enc.pngPalette !== false` to `palette: enc.pngPalette === true`
  assert.ok(src.includes('palette: enc.pngPalette === true'), 'palette defaults to false (opt-in via === true)');
  assert.ok(!src.includes('palette: enc.pngPalette !== false'), 'old always-on palette default is gone');
});

// ============================================================
// EFH2-005: imageEditorTools exports snapshot and restore
// ============================================================
test('EFH2-005: ImageEditorTools exports snapshot and restore for crop rollback', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'overlays', 'imageEditorTools.js'), 'utf8');
  // Check the export object includes snapshot and restore
  const exportMatch = src.match(/window\.ImageEditorTools\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(exportMatch, 'export object found');
  const exportBody = exportMatch[1];
  assert.ok(exportBody.includes('snapshot'), 'snapshot is exported');
  assert.ok(exportBody.includes('restore'), 'restore is exported');
});

// ============================================================
// EFH2-005b: imageEditorCropSelection uses restore (not popUndo)
// ============================================================
test('EFH2-005b: imageEditorCropSelection catch block uses restore, not popUndo', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'overlays', 'imageEditorCropSelection.js'), 'utf8');
  // popUndo must not be CALLED (comments mentioning it are fine)
  assert.ok(!/\.?popUndo\s*\(/.test(src), 'popUndo is not called as a function');
  assert.ok(src.includes('ImageEditorTools.restore'), 'restore is called in catch block');
  assert.ok(src.includes('slot.session._undo.pop()'), 'undo entry is popped before restore');
});

// ============================================================
// EFH2-007d: toPersistable returns undefined (not null) on failure
// ============================================================
test('EFH2-007d: toPersistable returns undefined on circular input', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  // Extract the toPersistable function
  const fnMatch = appSrc.match(/function toPersistable\(obj\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'toPersistable function found');
  const fnSrc = fnMatch[0];
  // Verify it returns undefined (not null) in the catch block
  assert.ok(fnSrc.includes('return undefined'), 'returns undefined in catch');
  assert.ok(!fnSrc.includes('return null'), 'does not return null');
});

// ============================================================
// EFH2-007h: imageResize switch-case block scoping
// ============================================================
test('EFH2-007h: imageResize case png is wrapped in braces', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'imageResize.js'), 'utf8');
  // The fix wraps `case 'png':` body in `{ }`
  assert.ok(src.includes("case 'png': {"), 'case png has opening brace');
  // Verify the const is inside the block
  const pngCase = src.match(/case 'png': \{[\s\S]*?break;\s*\}/);
  assert.ok(pngCase, 'png case block with break and closing brace found');
  assert.ok(pngCase[0].includes('const usePalette'), 'const is inside the block');
});

// ============================================================
// EFH2-006: pipelineOps outPath throws when PipelineModel unavailable
// ============================================================
test('EFH2-006: pipelineOps outPath throws when PipelineModel.outPath unavailable', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineOps.js'), 'utf8');
  // The old fallback produced `<id>_image.<ext>` — verify it's gone
  assert.ok(!src.includes('_image.${ext}'), 'old silent fallback pattern removed');
  // Verify the throw is present
  assert.ok(src.includes('PipelineModel.outPath unavailable'), 'hard throw message present');
});

// ============================================================
// EFH2-003: imageMetadata call sites pass a grant
// ============================================================
test('EFH2-003: pipelineOps imageMetadata call passes a grant', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineOps.js'), 'utf8');
  // Find the imageMetadata call and verify it passes a grant
  const metaCall = src.match(/imageMetadata\(src,\s*metaGrant\)/);
  assert.ok(metaCall, 'imageMetadata called with metaGrant');
  assert.ok(src.includes('GrantHelper.ensureRead(src)'), 'ensureRead minted before call');
});

test('EFH2-003: section08 imageMetadata call passes a grant', () => {
  const files = fs.readdirSync(path.join(ROOT, 'renderer', 'sections'));
  const s08 = files.find((f) => f.startsWith('section08_Image_pipeline'));
  assert.ok(s08, 'section08 file found');
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', s08), 'utf8');
  const metaCall = src.match(/imageMetadata\(srcPath,\s*metaGrant\)/);
  assert.ok(metaCall, 'imageMetadata called with metaGrant');
});

test('EFH2-003: batchPostprocess no longer uses || 1024 fallback', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'services', 'batchPostprocess.js'), 'utf8');
  assert.ok(!src.includes('|| 1024'), '|| 1024 magic default removed');
  assert.ok(src.includes('Could not determine source dimensions'), 'hard failure message present');
});

// ============================================================
// EFH2-001b: pipelineBoard.mount calls wireProgressIpc
// ============================================================
test('EFH2-001b: pipelineBoard.mount calls wireProgressIpc', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineBoard.js'), 'utf8');
  assert.ok(src.includes('wireProgressIpc'), 'wireProgressIpc called in mount');
});

// ============================================================
// EFH2-001c: clearProgressSetter called on item removal
// ============================================================
test('EFH2-001c: pipelineCard.removeItem calls clearProgressSetter', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineCard.js'), 'utf8');
  assert.ok(src.includes('clearProgressSetter'), 'clearProgressSetter called in removeItem');
});

test('EFH2-001c: pipelineClear.removeItems calls clearProgressSetter', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineClear.js'), 'utf8');
  assert.ok(src.includes('clearProgressSetter'), 'clearProgressSetter called in removeItems');
});
