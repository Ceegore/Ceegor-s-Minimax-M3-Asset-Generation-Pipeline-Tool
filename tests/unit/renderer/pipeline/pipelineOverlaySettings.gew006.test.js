// tests/unit/renderer/pipeline/pipelineOverlaySettings.gew006.test.js
// gewv2 GEW-006 — enqueueFromPaths() must convert a FLAT per-item postprocess
// settings map (the shape the batch runner's rowPostprocess passes) into the
// COLUMN-KEYED shape PipelineModel.resolveSettings(column, itemSettings)
// reads. Before the fix, a flat map with a truthy `crop`/`upscale`/
// `removeBackground` key was returned VERBATIM (mistaken for "already
// column-keyed"), so resolveSettings read itemSettings.upscale as a STRING
// ('true') and spread it into garbage keys — the column defaults silently
// won and a batch row's e.g. `--upscale-multiplier 4` had no effect.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const OVERLAY_JS = path.join(ROOT, 'renderer', 'pipeline', 'pipelineOverlay.js');
const { resolveSettings } = require(path.join(ROOT, 'src', 'pipeline', 'pipelineModel.js'));

function loadPipelineOverlay(importResults) {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.confirm = () => true;
  sandbox.state = {
    pipeline: { image: { items: [], counter: 0, workspace: 'C:\\out\\pipeline\\image' } },
    config: { output_dir: 'C:\\out' },
  };
  sandbox.api = {
    pipelineImport: async () => ({ results: importResults }),
  };
  sandbox.scheduleStateSave = () => {};
  sandbox.PipelineBoard = { render: () => {}, refreshBadge: () => {} };
  sandbox.PipelineImport = { wireDragDrop: () => {}, loadFromDisc: () => {} };
  vm.createContext(sandbox);
  const code = fs.readFileSync(OVERLAY_JS, 'utf8');
  vm.runInContext(code, sandbox, { filename: OVERLAY_JS });
  return { Pipeline: sandbox.window.Pipeline, state: sandbox.state };
}

test('GEW-006: a flat rowPostprocess-shaped settings map is normalised into column-keyed settings', async () => {
  const { Pipeline, state } = loadPipelineOverlay([
    { ok: true, dst: 'C:\\out\\pipeline\\image\\original\\a.png', src: 'C:\\out\\a.png', imageId: 'img1' },
  ]);
  const flatSettings = {
    upscale: 'true', upscaleMultiplier: '4', upscaleModel: 'realesrgan-x4plus-anime',
    removeBackground: 'true', removeBackgroundModel: 'birefnet-general',
    crop: '200x200',
  };
  const r = await Pipeline.enqueueFromPaths(['C:\\out\\a.png'], { settings: flatSettings });
  assert.equal(r.ok, true);
  assert.equal(state.pipeline.image.items.length, 1);
  const settings = state.pipeline.image.items[0].settings;
  // The stored settings must be column-keyed OBJECTS, not the flat map.
  assert.equal(typeof settings.upscale, 'object', 'GEW-006: settings.upscale must be an object, not a string/flat map');
  assert.equal(settings.upscale.multiplier, 4, 'GEW-006: upscaleMultiplier must reach the column-keyed shape as a number');
  assert.equal(settings.upscale.model, 'realesrgan-x4plus-anime', 'GEW-006: upscaleModel must reach the column-keyed shape');
  assert.equal(typeof settings.removebg, 'object', 'GEW-006: settings.removebg must be an object');
  assert.equal(settings.removebg.model, 'birefnet-general');
  assert.equal(typeof settings.crop, 'object', 'GEW-006: settings.crop must be a parsed {w,h} object');
  assert.equal(settings.crop.w, 200);
  assert.equal(settings.crop.h, 200);

  // The end-to-end contract: resolveSettings must now actually pick up the
  // per-item override instead of silently falling back to the column
  // default (the exact regression this fix closes).
  const resolvedUpscale = resolveSettings('upscale', settings);
  assert.equal(resolvedUpscale.multiplier, 4, 'GEW-006 (end-to-end): resolveSettings must honor the per-row multiplier, not the column default (2)');
});

test('GEW-006: an already column-keyed settings object is passed through verbatim', async () => {
  const { Pipeline, state } = loadPipelineOverlay([
    { ok: true, dst: 'C:\\out\\pipeline\\image\\original\\a.png', src: 'C:\\out\\a.png', imageId: 'img1' },
  ]);
  const columnKeyed = { upscale: { multiplier: 3 }, crop: { w: 100, h: 100 } };
  await Pipeline.enqueueFromPaths(['C:\\out\\a.png'], { settings: columnKeyed });
  const settings = state.pipeline.image.items[0].settings;
  assert.deepEqual(settings, columnKeyed, 'GEW-006: a pre-built column-keyed object must be used as-is');
});

test('GEW-006: no settings at all still enqueues cleanly with empty settings', async () => {
  const { Pipeline, state } = loadPipelineOverlay([
    { ok: true, dst: 'C:\\out\\pipeline\\image\\original\\a.png', src: 'C:\\out\\a.png', imageId: 'img1' },
  ]);
  const r = await Pipeline.enqueueFromPaths(['C:\\out\\a.png']);
  assert.equal(r.ok, true);
  // Cross-vm-realm objects aren't deepStrictEqual to a native {} literal even
  // when structurally identical — assert emptiness directly instead.
  assert.equal(Object.keys(state.pipeline.image.items[0].settings).length, 0);
});
