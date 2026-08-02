// tests/unit/renderer/tabs/batchPostprocessPartial.h056.test.js
// H-056 (audit _5.md): a FAILED row-requested postprocess step (crop/resize/
// optimize/remove-bg/upscale/trim) used to be reduced to a toast while
// runVariantDirect returned an unconditional { ok: true } — batchManager then
// counted the item as a full success and (with auto-remove on, the default)
// DELETED the queue row. The user lost the row AND got an asset without the
// requested processing, with no persistent record of the failure.
//
// The fix:
//   - batchDirectRunner returns { ok:true, status:'partial',
//     postprocessErrors:[...] } when a requested postprocess op failed (the
//     raw / last-successful deliverable is kept — BGR-024/R6.3 outputs
//     contract), including when the postprocess runner itself THREW.
//   - batchManager treats a partial as NOT fully ok: auto-remove is
//     suppressed (row stays in the queue), the history/summary gets a
//     'partial' entry, and the final toast/overlay reflect it.
//   - DOM-fallback parity: the tab gen handlers record the errors on
//     state.genLastPostprocessErrors[tabKey], which batchManager reads.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

global.window = global;
global.toast = () => {};
require(path.join(ROOT, 'renderer', 'tabs', 'argvBuilders.js'));
require(path.join(ROOT, 'renderer', 'tabs', 'batchDirectRunner.js'));
const { runVariantDirect } = global.window.BatchDirectRunner;

function resetState(overrides) {
  global.window.state = Object.assign({
    fbDir: 'C:\\out',
    generating: null,
  }, overrides || {});
}

test('H-056: a failed requested postprocess op yields ok:true + status:partial + postprocessErrors, raw deliverable kept', async () => {
  resetState({ _batchRowPostprocess: { crop: '100x100' } });
  global.window.api = { mmxRunJob: async () => ({ ok: true, code: 0 }) };
  let capturedFiles = null;
  global.window.BatchPostprocess = {
    // BGR-024/R6.3 contract: on failure, outputs mirror the raw inputs.
    runRowPostprocess: async (files) => {
      capturedFiles = files.slice();
      return { applied: [], errors: ['crop failed: sharp exploded'], outputs: files.slice() };
    },
  };
  const r = await runVariantDirect('image', { prompt: 'a cat' }, {});
  assert.equal(r.ok, true, 'ok stays true — a deliverable exists on disk');
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.postprocessErrors, ['crop failed: sharp exploded']);
  assert.ok(capturedFiles && capturedFiles.length > 0);
  assert.equal(r.outFile, capturedFiles[0], 'outFile must be the kept raw deliverable');
  delete global.window.BatchPostprocess;
});

test('H-056: a THROWING postprocess runner also yields status:partial (not silent full success)', async () => {
  resetState({ _batchRowPostprocess: { resize: '800x600' } });
  global.window.api = { mmxRunJob: async () => ({ ok: true, code: 0 }) };
  global.window.BatchPostprocess = {
    runRowPostprocess: async () => { throw new Error('runner blew up'); },
  };
  const r = await runVariantDirect('image', { prompt: 'a dog' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.status, 'partial');
  assert.equal(r.postprocessErrors.length, 1);
  assert.match(r.postprocessErrors[0], /postprocess runner threw: .*runner blew up/);
  delete global.window.BatchPostprocess;
});

test('H-056: an all-successful postprocess returns a plain full success (no partial status)', async () => {
  resetState({ _batchRowPostprocess: { crop: '100x100' } });
  global.window.api = { mmxRunJob: async () => ({ ok: true, code: 0 }) };
  global.window.BatchPostprocess = {
    runRowPostprocess: async () => ({ applied: ['crop C:\\out\\x_crop.png'], errors: [], outputs: ['C:\\out\\x_crop.png'] }),
  };
  const r = await runVariantDirect('image', { prompt: 'a bird' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.status, undefined, 'no status field on full success');
  assert.equal(r.postprocessErrors, undefined);
  assert.equal(r.outFile, 'C:\\out\\x_crop.png');
  delete global.window.BatchPostprocess;
});

test('H-056: no postprocess requested → untouched full-success shape', async () => {
  resetState();
  global.window.api = { mmxRunJob: async () => ({ ok: true, code: 0 }) };
  const r = await runVariantDirect('image', { prompt: 'plain' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.status, undefined);
  assert.equal(r.postprocessErrors, undefined);
});

// ---------------------------------------------------------------------------
// Source-level guards: batchManager's run loop is not directly invokable from
// a unit harness (it needs the full overlay DOM), so pin the load-bearing
// H-056 handling with source scans — same approach as the H-055 guard test.
// ---------------------------------------------------------------------------

test('H-056 guard: batchManager suppresses auto-remove + records a partial for a postprocess-partial direct result', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'batchManager.js'), 'utf8');
  // Direct-mode branch: detects the partial shape…
  assert.match(src, /d\.status === 'partial' && Array\.isArray\(d\.postprocessErrors\)/,
    'direct-mode branch must inspect d.status/d.postprocessErrors');
  // …and a partial must break itemAllVariantsOk (the sole auto-remove gate).
  assert.match(src, /if \(ppFailed\) \{\s*itemAllVariantsOk = false; partial\+\+;/,
    'a postprocess-partial must clear itemAllVariantsOk so auto-remove never fires');
  // History/summary record the partial.
  assert.match(src, /batchResults\.push\(\{ status: 'partial', error: `item \$\{i \+ 1\}\$\{vt\}: postprocess failed:/,
    'batchResults must record status partial with the errors');
  // Auto-remove is still gated on itemAllVariantsOk (H9-017 invariant).
  assert.match(src, /if \(autoRemove && vi === currentVariantsCount - 1 && itemAllVariantsOk\)/,
    'auto-remove must stay gated on itemAllVariantsOk');
  // DOM-fallback parity: reads + resets the per-tab postprocess-error slot.
  assert.match(src, /state\.genLastPostprocessErrors\[tabKey\] = null;/,
    'DOM-fallback path must reset the per-item postprocess-error slot');
  assert.match(src, /looksOk && Array\.isArray\(domPpErrs\) && domPpErrs\.length > 0/,
    'DOM-fallback path must downgrade a looksOk item with postprocess errors to partial');
  // Final toast + overlay keep the failure visible.
  assert.match(src, /partial > 0 \? `, \$\{partial\} partial \(postprocess failed\)` : ''/,
    'summary toast must mention partials');
  assert.match(src, /fail === 0 && partial === 0 && skipped === 0/,
    'a run with partials must keep the overlay open for inspection');
});

test('H-056 guard: DOM-fallback gen handlers record postprocess errors on state.genLastPostprocessErrors', () => {
  for (const [file, tabKey] of [['imageTab.js', 'image'], ['speechTab.js', 'speech'], ['musicTab.js', 'music']]) {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', file), 'utf8');
    const re = new RegExp('state\\.genLastPostprocessErrors\\.' + tabKey + ' = pp\\.errors\\.slice\\(\\);');
    assert.match(src, re, file + ' must record pp.errors on state.genLastPostprocessErrors.' + tabKey);
    const reThrow = new RegExp('state\\.genLastPostprocessErrors\\.' + tabKey + " = \\['postprocess runner threw: '");
    assert.match(src, reThrow, file + ' must also record a THROWN postprocess runner');
  }
});

test('H-056: JobSummary counts status:partial in its own bucket (history shows the partial)', () => {
  // _buildSummary is pure — safe to call without a DOM.
  require(path.join(ROOT, 'renderer', 'jobs', 'JobSummary.js'));
  const s = global.window.JobSummary._buildSummary([
    { status: 'ok' },
    { status: 'partial', error: 'item 2: postprocess failed: crop failed' },
    { status: 'err', error: 'item 3: mmx failed' },
  ]);
  const text = JSON.stringify(s);
  assert.match(text, /partial/i, 'summary must surface the partial bucket: ' + text);
});
