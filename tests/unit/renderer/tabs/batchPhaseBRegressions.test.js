// tests/unit/renderer/tabs/batchPhaseBRegressions.test.js
// H9 Phase B source-pattern guards: postprocess wiring, per-row prefix,
// pipeline enqueue settings, CLI version block, label honesty.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// B1 — pipeline enqueue passes settings + honest label
test('H9-006 enqueueFromPaths reads opts.settings instead of hardcoding {}', () => {
  const s = read('renderer/pipeline/pipelineOverlay.js');
  assert.match(s, /opts\.settings/, 'reads opts.settings');
  assert.match(s, /buildSettings\(\)/, 'builds settings from opts');
  // the old hardcoded {} must be gone.
  assert.doesNotMatch(s, /settings:\s*\{\s*\}\s*,\s*\n\s*history/);
});
test('H9-006 the image-tab toggle label says "auto-pipeline" (not "Auto Pipeline" / "Auto-run")', () => {
  const s = read('renderer/tabs/imageTab.js');
  assert.match(s, /auto-pipeline/);
  assert.match(s, /title:\s*'Automatically enqueue/);
});

// B2 — per-row output-name prefix
test('H9-013 output-name is a recognized TOOL_KEY (not flagged unknown)', () => {
  const s = read('renderer/tabs/batchImportHelper.js');
  assert.match(s, /'output-name'/);
});
test('H9-013 batchManager saves + restores state.filePrefix per item', () => {
  const s = read('renderer/tabs/batchManager.js');
  assert.match(s, /originalFilePrefix = state\.filePrefix/);
  assert.match(s, /state\.filePrefix = String\(rowPrefix\)/);
  assert.match(s, /cleanKey === 'file-prefix'/);
});

// B3/B5 — postprocess runner + wiring
test('H9-005/018 batchPostprocess.runRowPostprocess exists', () => {
  const s = read('renderer/services/batchPostprocess.js');
  assert.match(s, /async function runRowPostprocess/);
  // handles image (crop/resize/optimize/remove-bg) and audio (trim)
  assert.match(s, /isnetbgRun/);
  assert.match(s, /audioCut/);
  assert.match(s, /optimizeImage/);
});
test('H9-005 imageTab calls runRowPostprocess after generation', () => {
  const s = read('renderer/tabs/imageTab.js');
  assert.match(s, /window\.BatchPostprocess/);
  assert.match(s, /state\._batchRowPostprocess/);
});
test('H9-018 speechTab + musicTab call runRowPostprocess for audio trim', () => {
  const sp = read('renderer/tabs/speechTab.js');
  const mu = read('renderer/tabs/musicTab.js');
  assert.match(sp, /window\.BatchPostprocess/);
  assert.match(mu, /window\.BatchPostprocess/);
});
test('H9-005/018 batchManager sets + clears _batchRowPostprocess per item', () => {
  const s = read('renderer/tabs/batchManager.js');
  assert.match(s, /state\._batchRowPostprocess = rowPostprocess/);
  assert.match(s, /state\._batchRowPostprocess = null/);
});

// B4 — CLI version block
test('H9-003 mmx:run:job blocks generation subcommands on an incompatible CLI', () => {
  const s = read('main/ipc/registerMmxIpc.js');
  assert.match(s, /\['image',\s*'speech',\s*'music',\s*'video'\]\.includes\(args\[0\]\)/);
  assert.match(s, /compareSemver\(v,\s*min\)\s*<\s*0/);
  assert.match(s, /older than the supported/);
});

// B5 — registry documents the new postprocess/output flags
test('H9-005/013/018 the registry documents crop/resize/optimize/output-name/trim', () => {
  const r = require(path.join(ROOT, 'main', 'services', 'importCapabilityRegistry'));
  r.validate();
  const all = JSON.stringify(r.CAPABILITIES);
  assert.match(all, /--crop/);
  assert.match(all, /--resize/);
  assert.match(all, /--output-name/);
  assert.match(all, /--trim-start/);
  assert.match(all, /--trim-end/);
});
