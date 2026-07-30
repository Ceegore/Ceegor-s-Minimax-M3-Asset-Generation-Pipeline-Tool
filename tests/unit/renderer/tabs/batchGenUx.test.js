// tests/unit/renderer/tabs/batchGenUx.test.js
// T2-T7 (batchgen-ux) regression guards + review fixes:
//   T2: dashboard row actions (↑↓✎✕) sit LEFT of the text (the 1s
//       auto-refresh resets horizontal scroll to 0, so right-side actions
//       vanished off-screen).
//   T3: combined all-types confirm shows the output folder + picker.
//   T4: per-type subfolders are DIRECT-MODE-ONLY (review fix A — the
//       DOM-fallback path never reads batchSnapshot.outputDir, so creating
//       the folder there left an empty dir while assets landed elsewhere).
//   T5: live preview hooks are typeof-guarded (missing fileBrowser2b
//       globals must never crash an overnight run).
//   T6: ONE combined confirmation → every startBatchGen call gets
//       skipConfirm so the run is never interrupted again.
//   T7: overlay auto-close ONLY on a truly clean run (review fix B —
//       skipped-defective runs must KEEP the log so the user can see
//       WHICH items were skipped, same rule as the toast's 'warn').
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const MANAGER = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'batchManager.js'), 'utf8');
const HELPER = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'batchImportHelper.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');

// ---- T2: dashboard actions LEFT of the item text ----
test('T2: dashboard row appends the actions span BEFORE the item text span', () => {
  const actionsAt = APP.indexOf("class: 'batch-dashboard-item-actions'");
  const textAt = APP.indexOf("class: 'batch-dashboard-item-text'");
  assert.ok(actionsAt > -1, 'actions span must exist');
  assert.ok(textAt > -1, 'text span must exist');
  assert.ok(actionsAt < textAt,
    'the ↑↓✎✕ actions must be appended LEFT of (before) the text — the 1s auto-refresh resets horizontal scroll, so right-side actions are unreachable');
  // All four actions are attached to the actions span in one append.
  assert.match(APP, /actions\.append\(upBtn, downBtn, editBtn, removeBtn\)/);
});

// ---- T3: combined confirm folder row + native picker ----
test('T3: combined confirm has a folder row and pickFolderFull uses the config-output purpose', () => {
  assert.match(HELPER, /pickFolderFull\(\{ purpose: 'config-output' \}\)/);
  assert.match(HELPER, /💾 Save to:/);
  // The picked path must flow into startBatchGen as outputDirBase.
  assert.match(HELPER, /done\(\{ outputDirBase: outDirBase, noTypeSubfolders: !!subCb\.checked \}\)/);
});

test('T3: dismissing the combined confirm (Esc/outside-click) resolves null and starts nothing', () => {
  assert.match(HELPER, /\{ onClose: \(\) => done\(null\) \}/);
  assert.match(HELPER, /if \(!choice\) return;/);
});

// ---- T4: per-type subfolder routing (review fix A: direct mode only) ----
test('T4: subfolder creation is gated on direct mode + BatchDirectRunner (review fix A)', () => {
  assert.match(MANAGER,
    /if \(!opts\.noTypeSubfolders && baseOutputDir && state\.batchDirectMode !== false && window\.BatchDirectRunner/,
    'the DOM-fallback path never consumes batchSnapshot.outputDir — creating the subfolder there leaves an empty dir behind');
});

test('T4: a failed fbEnsureDir falls back to the base folder instead of killing the run', () => {
  // Both the {ok:false} envelope and a thrown error log a warning; neither
  // path re-throws, so an overnight run survives a missing subfolder.
  const matches = MANAGER.match(/Could not create subfolder/g) || [];
  assert.equal(matches.length, 2, 'both the ok:false and the catch branch must warn-and-continue');
  assert.match(MANAGER, /if \(er && er\.ok\) batchSnapshot\.outputDir = er\.path \|\| typeDir;/);
});

test('T4: the subfolder is created with the batch-owned grant (covers the base root)', () => {
  assert.match(MANAGER, /window\.api\.fbEnsureDir\(typeDir, batchGrantId\)/);
  // …and that grant is minted coversRoot:true on the base folder.
  assert.match(MANAGER, /kind: 'directory', capabilities: \['mkdir', 'write'\], coversRoot: true/);
});

// ---- T5: live preview hooks ----
test('T5: preview hooks are typeof-guarded per type and wrapped best-effort', () => {
  assert.match(MANAGER, /tabKey === 'image' && typeof window\.notifyImageGenerated === 'function'/);
  assert.match(MANAGER, /\(tabKey === 'speech' \|\| tabKey === 'music'\) && typeof window\.notifyAudioGenerated === 'function'/);
  assert.match(MANAGER, /tabKey === 'video' && typeof window\.previewVideoFromFile === 'function'/);
  assert.match(MANAGER, /catch \(_\) \{ \/\* preview is best-effort \*\//);
});

// ---- T6: one combined confirmation, skipConfirm threading ----
test('T6: both per-tab confirms honour opts.skipConfirm', () => {
  assert.match(MANAGER, /if \(!opts\.skipConfirm && tabKey === 'video' && items\.length > 3\)/);
  assert.match(MANAGER, /if \(!opts\.skipConfirm && expectedCalls > 1/);
});

test('T6: startAllBatchGen runs every type with skipConfirm + the chosen folder options', () => {
  assert.match(HELPER, /await startBatchGen\(type, \{\s*skipConfirm: true,\s*outputDirBase: choice\.outputDirBase,\s*noTypeSubfolders: choice\.noTypeSubfolders,\s*\}\)/);
});

test('T6: the combined confirm derives per-type paid-call counts from computeExpectedCalls', () => {
  assert.match(HELPER, /window\.BatchManager && window\.BatchManager\.computeExpectedCalls/);
  assert.match(MANAGER, /window\.BatchManager\.computeExpectedCalls = computeExpectedCalls/);
});

// ---- T7: auto-close only on a truly clean run (review fix B) ----
test('T7: overlay auto-close requires no error, no fail, NO SKIPPED, not aborted', () => {
  assert.match(MANAGER,
    /if \(!batchError && fail === 0 && skipped === 0 && !window\._batchAbortByTab\[tabKey\]\) \{\s*overlay\.remove\(\);/,
    'skipped-defective runs must keep the overlay so the per-item log stays inspectable (review fix B)');
});

test('T7: the non-clean branch turns Stop into a working Close button', () => {
  const at = MANAGER.indexOf('&& skipped === 0 && !window._batchAbortByTab[tabKey]');
  const block = MANAGER.slice(at, at + 400);
  assert.match(block, /stopBtn\.textContent = 'Close'/);
  assert.match(block, /stopBtn\.disabled = false/);
  assert.match(block, /stopBtn\.onclick = \(\) => overlay\.remove\(\)/);
});

test('T7: the summary toast uses the same clean-run rule as the auto-close', () => {
  assert.match(MANAGER, /batchError \? 'err' : \(\(fail === 0 && skipped === 0\) \? 'ok' : 'warn'\)/);
});

// ---- computeExpectedCalls: functional check of the shared reduce ----
// Extract the function from the real source and run it in a vm sandbox with
// a stubbed `$` (no tab DOM → default variants = 1) so the maths the
// combined confirm displays is actually executed, not just pattern-matched.
test('computeExpectedCalls counts variants per item and skips defective entries', () => {
  const vm = require('vm');
  const start = MANAGER.indexOf('function computeExpectedCalls');
  assert.ok(start > -1, 'computeExpectedCalls must exist');
  const end = MANAGER.indexOf('\n}', start);
  const src = MANAGER.slice(start, end + 2);
  const sandbox = vm.createContext({ $: () => null });
  vm.runInContext(`${src}; globalThis.__cec = computeExpectedCalls;`, sandbox, { filename: 'batchManager.js#computeExpectedCalls', timeout: 3000 });
  const fn = sandbox.__cec;
  assert.equal(fn('image', []), 0);
  assert.equal(fn('image', ['a', 'b']), 2, 'plain string items count 1 call each (default variants)');
  assert.equal(fn('image', [{ prompt: 'x', variants: 3 }]), 3);
  assert.equal(fn('image', [{ prompt: 'x', '--variants': '2' }, 'y']), 3);
  assert.equal(fn('image', [{ prompt: 'x', variants: 99 }]), 5, 'variants clamp to 5');
  assert.equal(fn('image', [{ prompt: 'bad', _defective: ['missing prompt'] }, 'ok']), 1,
    'defective entries are skipped exactly like the run loop skips them');
});

// P4.3 (DB-H-003): image --n multiplies billable outputs (units) but not API
// calls; { callsOnly: true } must return the raw call count, and non-image
// tabs must ignore n entirely.
test('computeExpectedCalls multiplies image --n into units and honours callsOnly', () => {
  const vm = require('vm');
  const start = MANAGER.indexOf('function computeExpectedCalls');
  const end = MANAGER.indexOf('\n}', start);
  const src = MANAGER.slice(start, end + 2);
  const sandbox = vm.createContext({ $: () => null });
  vm.runInContext(`${src}; globalThis.__cec = computeExpectedCalls;`, sandbox, { filename: 'batchManager.js#computeExpectedCalls', timeout: 3000 });
  const fn = sandbox.__cec;
  assert.equal(fn('image', [{ prompt: 'x', n: 4 }]), 4, 'n multiplies units');
  assert.equal(fn('image', [{ prompt: 'x', variants: 2, n: 3 }]), 6, 'variants × n');
  assert.equal(fn('image', [{ prompt: 'x', '--n': '2' }]), 2, '--n alias works');
  assert.equal(fn('image', [{ prompt: 'x', params: { n: 3 } }]), 3, 'params.n works');
  assert.equal(fn('image', [{ prompt: 'x', n: 99 }]), 9, 'n clamps to 9');
  assert.equal(fn('image', [{ prompt: 'x', n: 4 }], { callsOnly: true }), 1,
    'callsOnly must return raw API calls (n ignored)');
  assert.equal(fn('music', [{ prompt: 'x', n: 4 }]), 1, 'non-image tabs ignore n');
  assert.equal(fn('image', [{ prompt: 'x' }]), 1, 'absent n → ×1 (legacy behaviour)');
});
