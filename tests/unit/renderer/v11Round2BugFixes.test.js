// tests/unit/renderer/v11Round2BugFixes.test.js
// ============================================================================
// v1.1 round-2 bug-fix regression tests. Each test pins a defect found
// in the second-pass audit (the deferred M1/M5/L1-L4 set the user
// asked to fix before shipping v1.1). Source-level pins + behavioural
// checks where the surrounding code can be loaded safely.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ============================================================================
// M1 (ArchiveViewer): pagination race + dedup. The scroll handler must
// not fire concurrent _loadNextPage calls (which read the same offset
// and double-added entries). Fixed with an in-flight guard + id-dedup.
// ============================================================================
test('M1 FIX: ArchiveViewer has an in-flight guard + id-dedup', () => {
  const s = src('renderer/widgets/ArchiveViewer.js');
  // The in-flight guard: a `_loading` flag set at the top of
  // _loadNextPage and cleared in finally. Pre-v1.1 there was no
  // guard; concurrent scroll-fired calls each read the same
  // _nextOffset and appended the same page twice.
  assert.ok(s.includes('let _loading = false'),
    'ArchiveViewer must declare an in-flight _loading flag');
  assert.ok(/async function _loadNextPage\(\) \{\s*if \(!_hasMore\) return;\s*[^]*if \(_loading\) return;/m.test(s),
    '_loadNextPage must early-return when _loading is true');
  assert.ok(/finally \{\s*_loading = false;\s*\}/.test(s),
    '_loading must be cleared in a finally block so a throw cannot strand the loader');
  // The dedup set: even if a future caller bypasses _loadNextPage,
  // re-adding an entry by id is a no-op.
  assert.ok(s.includes('_loadedIds'),
    'ArchiveViewer must maintain a _loadedIds set for defensive dedup');
  assert.ok(s.includes('_loadedIds.has(e.id)'),
    '_loadNextPage must filter incoming entries against _loadedIds');
  assert.ok(/open\(\) \{[\s\S]*?_loadedIds\.clear\(\)/.test(s),
    'open() must clear the dedup set so a re-open after deletes does not reject re-read entries');
});

// ============================================================================
// M5 (speech/music/video): variant-loop break → continue, plus the
// partial-success gate mirroring imageTab.
// ============================================================================
test('M5 FIX: speechTab continues past failed variants + partial-success gate', () => {
  const s = src('renderer/tabs/speechTab.js');
  assert.ok(s.includes('const outFiles = [];'),
    'speechTab must track every successful output file');
  // The variant-loop `!r.ok` branch must use `continue`, not `break`.
  // The failure block looks like:
  //   toast('Speech generation failed: ...', ...);
  //   allOk = false;
  //   <optional comments>
  //   continue;     // <-- the fix
  // We match the whole failure block (allowing comments between
  // allOk=false and the loop keyword) and assert the keyword is
  // `continue`, not `break`.
  const m = s.match(/Speech generation failed:[\s\S]{0,400}?allOk = false;[\s\S]{0,200}?(continue|break);/);
  assert.ok(m, 'speech tab must have a failure branch with allOk=false + a loop keyword');
  assert.equal(m[1], 'continue',
    'failed variant must `continue` to the next variant (was: break, abandoning remaining variants)');
  // v1.1 (audit M5 + L1): genLastResult uses outFiles.length > 0
  // AND drops the cancel check — a cancel after partial success
  // still leaves real files on disk, so we mark 'ok' to stop
  // BatchGen retrying the variants that already landed.
  assert.ok(s.includes("(outFiles.length > 0 && !threw) ? 'ok' : 'err'"),
    'genLastResult.speech must use the partial-success gate without the cancel check');
});

test('M5 FIX: musicTab continues past failed variants + partial-success gate', () => {
  const s = src('renderer/tabs/musicTab.js');
  assert.ok(s.includes('const outFiles = [];'),
    'musicTab must track every successful output file');
  const m = s.match(/Music generation failed:[\s\S]{0,400}?allOk = false;[\s\S]{0,200}?(continue|break);/);
  assert.ok(m, 'music tab must have a failure branch with allOk=false + a loop keyword');
  assert.equal(m[1], 'continue',
    'failed variant must `continue` (was: break)');
  assert.ok(s.includes("(outFiles.length > 0 && !threw) ? 'ok' : 'err'"),
    'genLastResult.music must use the partial-success gate without the cancel check');
});

test('M5 FIX: videoTab continues past failed variants + partial-success gate', () => {
  const s = src('renderer/tabs/videoTab.js');
  assert.ok(s.includes('const outFiles = [];'),
    'videoTab must track every successful output file');
  // The video tab has TWO failure branches (api-failure AND
  // missing-on-disk). Both must `continue` instead of `break`.
  const apiBranch = s.match(/Video generation failed:[\s\S]{0,400}?allOk = false;[\s\S]{0,200}?(continue|break);/);
  const missingBranch = s.match(/Video generation failed: output file missing on disk[\s\S]{0,400}?allOk = false;[\s\S]{0,200}?(continue|break);/);
  assert.ok(apiBranch, 'video tab must have an api-failure allOk=false branch');
  assert.equal(apiBranch[1], 'continue',
    'api-failed variant must `continue` (was: break)');
  assert.ok(missingBranch, 'video tab must have a missing-file allOk=false branch');
  assert.equal(missingBranch[1], 'continue',
    'missing-file variant must `continue` (was: break)');
  assert.ok(s.includes("(outFiles.length > 0 && !threw) ? 'ok' : 'err'"),
    'genLastResult.video must use the partial-success gate without the cancel check');
});

// ============================================================================
// H1 + L1 (round-2): cancel-with-partial-success returns ALL outFiles (not
// just the last) AND returns status 'ok' so BatchGen does NOT retry.
// ============================================================================
test('H1+L1 FIX: speech/music/video return ALL outFiles on cancel-with-partial-success', () => {
  function src2(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
  for (const tab of ['speechTab', 'musicTab', 'videoTab']) {
    const s = src2(`renderer/tabs/${tab}.js`);
    // The cancel branch must use outFiles (was: [lastOutFile]) AND
    // status 'ok' when partial success so BatchGen does not retry.
    // We check the literal return-statement shape rather than
    // anchoring on cancel.wasCancelled (the first cancel check is
    // inside the variant loop and uses `break`, not `return`).
    assert.ok(s.includes("status: outFiles.length > 0 ? 'ok' : 'cancel', outputPaths: outFiles"),
      `${tab}: cancel branch must return outputPaths: outFiles with status 'ok'|'cancel' (was: [lastOutFile] with status 'cancel')`);
    // The pre-v1.1 cancel return shape must be GONE from executable
    // code (strip comments so the regression-test's mention of the
    // old shape does not trip the check).
    const noComments = s.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!noComments.includes("status: 'cancel', outputPaths: lastOutFile ? [lastOutFile] : []"),
      `${tab}: the pre-v1.1 cancel-returns-[lastOutFile] shape must be gone from executable code`);
  }
});

// ============================================================================
// L1 (speechTab): dead variable `speechErrs` removed.
// ============================================================================
test('L1 FIX: speechTab no longer declares the dead speechErrs variable', () => {
  const s = src('renderer/tabs/speechTab.js');
  // The variable was `const speechErrs = [];` declared and never read.
  // Strip comments before the search so the regression-test's own
  // explanation (which mentions the old name) does not trip the check.
  const noComments = s.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!noComments.includes('speechErrs'),
    'speechTab must NOT declare the dead speechErrs variable in executable code');
});

// ============================================================================
// L2 (section15 add-ons): pick-file handlers wrapped in try/catch.
// ============================================================================
test('L2 FIX: section15 pick-file handlers are wrapped in try/catch', () => {
  const s = src('renderer/sections/section15_Optional_add_ons_popup__unified_.js');
  // Each pick handler must have a try/catch around the await. The
  // sibling download handler already had this. We assert each of the
  // three installPickAndCopy call sites is inside a try block.
  const rePick = /rePick\.addEventListener\('click', async \(\) => \{[\s\S]*?try \{[\s\S]*?installPickAndCopy\('realesrgan-binary'\)/;
  const reIsBin = /isBinPick\.addEventListener\('click', async \(\) => \{[\s\S]*?try \{[\s\S]*?installPickAndCopy\('isnetbg-binary'\)/;
  const reIsModel = /isModelPick\.addEventListener\('click', async \(\) => \{[\s\S]*?try \{[\s\S]*?installPickAndCopy\('isnetbg-model'\)/;
  assert.ok(rePick.test(s), 'rePick handler must wrap installPickAndCopy in try');
  assert.ok(reIsBin.test(s), 'isBinPick handler must wrap installPickAndCopy in try');
  assert.ok(reIsModel.test(s), 'isModelPick handler must wrap installPickAndCopy in try');
});

// ============================================================================
// L3 (batchManager): unguarded DOM lookups (preview, lastCmd) now guarded.
// ============================================================================
test('L3 FIX: batchManager guards null preview + null lastCmd', () => {
  const s = src('renderer/tabs/batchManager.js');
  // preview.parentNode insert must be guarded.
  assert.ok(s.includes('if (previewEl.parentNode)'),
    'batchManager must guard preview.parentNode before insertBefore');
  assert.ok(s.includes('const previewEl = preview || { parentNode: null, innerHTML: \'\' };'),
    'batchManager must fall back to a stub when preview is null');
  // The DOM-scrape fallback (preview.querySelector) must null-guard preview.
  assert.ok(s.includes('preview && preview.querySelector'),
    'batchManager must null-guard preview in the looksOk DOM-scrape fallback');
});

// ============================================================================
// L4 (app.js nextFreeForcePrefixPath): iteration cap so a corrupted FS
// state cannot hang the renderer.
// ============================================================================
test('L4 FIX: nextFreeForcePrefixPath has an iteration cap', () => {
  const s = src('renderer/app.js');
  // The function must declare a cap and use it in the loop condition
  // (was: `for (;;)` — infinite loop on consistent fbExists=true).
  assert.ok(s.includes('const MAX_TRIES = 1000;'),
    'nextFreeForcePrefixPath must declare an iteration cap');
  assert.ok(s.includes('for (let i = 0; i < MAX_TRIES; i++)'),
    'nextFreeForcePrefixPath must cap the loop at MAX_TRIES');
  // The fallback path on exhaustion must be a unique timestamp-suffixed
  // name so the caller still gets a usable path (the user never loses
  // the file they just paid API credits to generate).
  assert.ok(s.includes('Date.now()') && s.includes('Math.floor(Math.random()'),
    'nextFreeForcePrefixPath must fall back to a timestamp+random name on exhaustion');
  // The original infinite loop must be gone.
  assert.ok(!/for \(;;\) \{[\s\S]{0,200}fbExists/.test(s),
    'the pre-v1.1 `for (;;)` infinite loop must be gone');
});
