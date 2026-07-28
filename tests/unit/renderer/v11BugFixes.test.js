// tests/unit/renderer/v11BugFixes.test.js
// ============================================================================
// v1.1 bug-fix regression tests. Each test pins a specific defect
// found during the final bug-hunting pass so a future regression
// is caught immediately. Source-level pins + behavioural checks
// where the surrounding code can be loaded safely.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ============================================================================
// H1 + H2 (imageTab.js): partial-variant-success runs must NOT skip
// the post-process chain OR report failure to BatchGen.
//
// Pre-v1.1: a single failed variant out of 5 caused the WHOLE
// success branch to be skipped (gated on `allOk`), so 4 successful
// images lost their upscale / background-removal / optimisation
// pass. BatchGen also saw the run as a failure and re-ran all 5
// variants on Retry — wasting API quota.
//
// v1.1.27 (SEV-1 from _temp10.md): the post-v1.1 gate used
// `outFiles.length > 0`, which is structurally empty for `--n > 1`
// runs (outFiles is only pushed to in the non-(--out-dir) branch of
// the variant loop). Every successful --n > 1 run was routed to the
// pure-failure UI and reported "mmx exited with code -1" (fabricated
// from a hardcoded fallback because lastFailedR was null). The fix
// is to gate the success branch on `succeededCount > 0` (number of
// variant calls that returned ok) — structurally correct regardless
// of mode.
// ============================================================================
test('H1+H2 + SEV-1 FIX: imageTab gates success on succeededCount, not allOk or outFiles.length', () => {
  const s = src('renderer/tabs/imageTab.js');
  // The success branch must check `succeededCount > 0`, not `allOk`
  // (pre-v1.1) and not `outFiles.length > 0` (post-v1.1, broken for
  // --n > 1 per SEV-1).
  assert.ok(s.includes('if (succeededCount > 0 && !cancel.wasCancelled())'),
    'the post-process + success branch must be gated on succeededCount > 0 (was allOk pre-v1.1, then outFiles.length — also broken for --n > 1 per SEV-1)');
  // The pure-failure branch must require zero successful variants.
  assert.ok(s.includes("} else if (succeededCount === 0 && !cancel.wasCancelled())"),
    'the pure-failure UI branch must require succeededCount === 0 (no successful variants)');
  // genLastResult (read by BatchGen) must mirror the same gate so a
  // 4/5-success run is NOT flagged as retryable. The gate does NOT
  // include cancel.wasCancelled() — a cancel after partial success
  // still leaves real files on disk, so we mark 'ok' (v1.1 L1 fix).
  assert.ok(s.includes("(succeededCount > 0 && !threw) ? 'ok' : 'err'"),
    'genLastResult.image must be "ok" when ANY variant succeeded (BatchGen retry contract, v1.1 L1: cancel after partial success still counts as ok)');
  // The post-run return value must NOT use `if (allOk)` — that
  // would route partial-success through the 'err' return.
  assert.ok(!/\bif \(allOk\) \{[\s\S]*?return \{ status: 'ok'/.test(s),
    'the return-value branch must NOT be gated on `allOk` (gating on succeededCount is the v1.1.27 fix)');
  // The post-run return value must NOT use `if (outFiles.length > 0)` —
  // that was the v1.1 partial-success fix but it broke --n > 1
  // (SEV-1). The new gate is succeededCount > 0.
  assert.ok(!/\bif \(outFiles\.length > 0\) \{[\s\S]*?return \{ status: 'ok'/.test(s),
    'the post-run return-value branch must NOT be gated on outFiles.length > 0 (broken for --n > 1 per SEV-1)');
  // The success toast must mention partial-success so the user
  // knows not every variant landed.
  assert.ok(s.includes('variants saved') && s.includes('failed — see log'),
    'the success toast must surface partial-success (count + "see log")');
});

// ============================================================================
// M2 (videoTab.js): the elapsed-timer setInterval must be cleared
// in a finally block so an mmxRunJob rejection does not leak the
// timer forever.
// ============================================================================
test('M2 FIX: videoTab clears the elapsed interval in a finally block', () => {
  const s = src('renderer/tabs/videoTab.js');
  assert.ok(s.includes('try {') && s.includes('const r = await window.api.mmxRunJob('),
    'the mmxRunJob await must be wrapped in a try block');
  assert.ok(/} finally \{\s*clearInterval\(elapsedTimer\);/.test(s),
    'clearInterval(elapsedTimer) must run in a finally block (was on happy path only pre-v1.1; R5 #2 may add ETA bookkeeping after it)');
});

// ============================================================================
// M3 (videoTab.js): Phase 5 removed the per-tab .preview element (results now
// route to the status bar + Assets pane). The footer is now [actions] only.
// ============================================================================
test('M3 FIX: videoTab footer is [actions] (preview removed in Phase 5)', () => {
  const s = src('renderer/tabs/videoTab.js');
  // Phase 5 removed the preview element; footer is actions-only.
  assert.ok(s.includes("el('div', { class: 'tab-footer' }, [actions])"),
    'videoTab footer must be [actions] (preview removed — results route to status bar)');
  assert.ok(!s.includes("el('div', { class: 'tab-footer' }, [actions, preview])"),
    'the pre-v1.1 [actions, preview] order must NOT be present');
});

// ============================================================================
// M4 (speechTab.js): --bitrate must be suppressed for lossless
// formats by GATING the appendFlag call, not by mutating the
// bitrate select's value (which leaked state across click handlers
// and permanently dropped the user's chosen bitrate).
// ============================================================================
test('M4 FIX: speechTab gates appendFlag for bitrate instead of mutating value', () => {
  const s = src('renderer/tabs/speechTab.js');
  // The mutating line must be gone from the executable code. We
  // strip //-comments before the search so the fix's own explanation
  // (which references the old buggy line) doesn't trip the check.
  const noComments = s.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!noComments.includes("bitrate.el.value = ''"),
    'speechTab must NOT mutate bitrate.el.value in executable code (the leak was the bug)');
  // The gate must be at the appendFlag call site.
  assert.ok(/if \(lossyFormat\) appendFlag\(args, bitrate\.input\)/.test(s),
    'speechTab must gate appendFlag(bitrate) on the lossyFormat flag');
  // The lossyFormat flag must be derived from the format select.
  assert.ok(s.includes("const lossyFormat = ['mp3', 'opus'].includes(speechFormat);"),
    'speechTab must derive lossyFormat from the current format selection');
});

// ============================================================================
// isnetbg.js v1.1 bug fix (checkNodeBackendAvailable was called but
// never imported). Already covered by ADV 3 in advancedPipelineHarness;
// adding a second pin here keeps the bug-fix tests grouped.
// ============================================================================
test('ISNETBG FIX: checkNodeBackendAvailable is imported + exported', () => {
  const wrapper = src('src/isnetbg.js');
  const disc = src('src/isnetbg/binaryDiscovery.js');
  assert.ok(wrapper.includes('checkNodeBackendAvailable,'),
    'isnetbg.js must import checkNodeBackendAvailable (was missing pre-v1.1)');
  assert.ok(disc.includes('checkNodeBackendAvailable'),
    'binaryDiscovery.js must export checkNodeBackendAvailable (was internal-only pre-v1.1)');
});

// ============================================================================
// imageOptimizer.js v1.1 bug fix (stripMetadata=true used withMetadata
// in BOTH branches, so it never actually stripped). Behavioural
// coverage is in ADV 5; this test pins the source-level contract.
// ============================================================================
test('IMGOPT FIX: stripMetadata=true uses keepIccProfile alone, not withMetadata', () => {
  const s = src('src/imageOptimizer.js');
  // Strip comments so the fix's explanatory comment (which mentions
  // the old withMetadata call) doesn't trip the check.
  const noComments = s.replace(/^\s*\/\/.*$/gm, '');
  // The stripMetadata=true branch must call keepIccProfile() alone.
  assert.ok(/if \(stripMetadata\) \{[\s\S]*?pipeline\.keepIccProfile\(\);/.test(noComments),
    'stripMetadata=true must call keepIccProfile() alone (preserves ICC, strips everything else)');
  // The stripMetadata=true branch must NOT call withMetadata in
  // executable code. The pre-v1.1 bug: withMetadata is the OPPOSITE
  // of stripping in sharp, so the previous code preserved ALL
  // metadata in both branches.
  const stripBranch = noComments.match(/if \(stripMetadata\) \{[\s\S]*?\} else \{/);
  assert.ok(stripBranch, 'must be able to isolate the stripMetadata=true branch');
  assert.ok(!stripBranch[0].includes('withMetadata'),
    'stripMetadata=true branch must NOT call withMetadata (was the bug pre-v1.1)');
});
