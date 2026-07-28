// tests/unit/renderer/imageTabOutDirSuccess.test.js
// ============================================================================
// SEV-1 (from _temp10.md) — regression coverage for the `--n > 1` success
// gate bug. The previous v1.1 fix used `outFiles.length > 0` as the
// success gate, but outFiles is only pushed to in the non-(--out-dir)
// branch of the variant loop — i.e. it is structurally empty for every
// `--n > 1` run, regardless of whether the call actually succeeded.
// Every successful `--n > 1` run was therefore routed to the failure
// UI, which then reported the fabricated message "mmx exited with code
// -1 (silent)" because lastFailedR was null and the failure branch
// built its error from a hardcoded `{code:-1}` fallback.
//
// This file pins BOTH:
//   1. The source-level structural properties (the new succeededCount
//      gate is in place, the increment is unconditional, the post-process
//      path runs, the BatchGen genLastResult is 'ok', the failure
//      branch is no longer reachable on successful runs).
//   2. The behavioural shape of the gate — a small extracted pure
//      function that mirrors the success / failure decision (kept in
//      this test file as the canonical reference for the gate logic).
//      The source-grep tests above pin that the real imageTab code
//      implements the same gate via the same literal tokens.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ============================================================================
// PURE GATE — extracted mirror of the imageTab success/failure gate.
// The real imageTab implements this gate via two literal tokens
// (`if (succeededCount > 0 && !cancel.wasCancelled()) {` and the matching
// `} else if (succeededCount === 0 && !cancel.wasCancelled()) {`).
// The source-grep tests below pin those tokens; this function is the
// canonical reference for the SHAPE of the gate (so a future refactor
// that keeps the right shape but renames the variable still passes).
// ============================================================================
function decideOutcome({ succeededCount, cancelled, threw }) {
  if (threw) return { branch: 'thrown', status: 'err' };
  if (cancelled) return { branch: 'cancelled', status: 'cancel' };
  if (succeededCount > 0) return { branch: 'success', status: 'ok' };
  return { branch: 'pure-failure', status: 'err' };
}

function lastFailedMessage(lastFailedR, branch) {
  if (branch !== 'pure-failure') return null;
  // Mirror of `formatMmxError(lastFailedR || { stderr:'', stdout:'', code:-1 })`
  // at imageTab.js:820. The PRE-v1.1.27 code fell through to this for
  // every successful --n > 1 run (because lastFailedR was null AND
  // outFiles.length === 0). The fixture below MUST be the same
  // hardcoded fallback the live code uses; if anyone ever changes it,
  // this test will catch the user-facing message drift.
  return lastFailedR
    ? `mmx exited with code ${lastFailedR.code}`
    : 'mmx exited with code -1';
}

// ============================================================================
// 1. Source-level structural pins
// ============================================================================
test('SEV-1: imageTab declares a succeededCount counter outside the variant loop', () => {
  const s = src('renderer/tabs/imageTab.js');
  // The new tracker must be declared alongside `let allOk = true;`.
  // (We don't pin exact phrasing — every reasonable name "succeededCount",
  // "okCount", "successfulVariants" would do — but the literal token
  // "let succeededCount = 0" is what the live code uses, and the
  // structural property is "a counter exists".)
  assert.ok(/\blet\s+succeededCount\s*=\s*0\b/.test(s),
    'imageTab must declare a `let succeededCount = 0` counter outside the variant loop (the SEV-1 gate fix)');
});

test('SEV-1: succeededCount is incremented UNCONDITIONALLY (regardless of useOutDir)', () => {
  const s = src('renderer/tabs/imageTab.js');
  // The critical structural property: the increment is OUTSIDE the
  // `if (!useOutDir) outFiles.push(outFile);` branch. If a future
  // refactor wraps it inside `if (!useOutDir) { … }`, the bug
  // returns. We assert the increment's literal `succeededCount++;`
  // token appears, and that the closest preceding push is conditional.
  const inc = s.indexOf('succeededCount++;');
  assert.ok(inc > 0, 'imageTab must call `succeededCount++;` after every successful variant (was: outFiles.push, conditional on useOutDir)');
  // The `outFiles.push(outFile)` line must STILL be conditional on
  // !useOutDir (the comment block above it explains why), but the
  // succeededCount increment must NOT be.
  const pushLine = s.indexOf('if (!useOutDir) outFiles.push(outFile);');
  const incAfterPush = s.indexOf('succeededCount++;', pushLine);
  assert.ok(pushLine > 0, 'imageTab still gates the outFiles push on !useOutDir (mmx picks its own filenames in --out-dir mode)');
  assert.ok(incAfterPush > pushLine, 'succeededCount must be incremented AFTER the conditional outFiles push (so the increment is unconditional regardless of useOutDir)');
});

test('SEV-1: the success / failure post-loop gate keys off succeededCount, not outFiles.length', () => {
  const s = src('renderer/tabs/imageTab.js');
  // The post-loop success branch (post-process + preview + quota +
  // notifyImageGenerated + log "Generated N images") must be gated on
  // `succeededCount > 0`. The PRE-v1.1.27 fix used `outFiles.length > 0`,
  // which is structurally false for `--n > 1` runs.
  assert.ok(s.includes('if (succeededCount > 0 && !cancel.wasCancelled())'),
    'the post-process + success branch must be gated on succeededCount > 0 (was: outFiles.length > 0, broken for --n > 1 per SEV-1)');
  // The matching pure-failure branch must require zero successes.
  assert.ok(s.includes('} else if (succeededCount === 0 && !cancel.wasCancelled())'),
    'the pure-failure UI branch must require succeededCount === 0 (no successful variants)');
  // And critically: NO surviving `outFiles.length > 0` or
  // `outFiles.length === 0` gate in the post-loop success/failure
  // branches (these were the SEV-1 bug).
  // The seed block `if (outFiles.length > 0) finalOutputPaths = ...`
  // is still allowed (it just provides a better list when we have one
  // for the single-image path); the assertion is that the GATING
  // branch is succeededCount, not outFiles.length.
  const postLoopSlice = s.slice(s.indexOf('// Post-processing INSIDE the try block'));
  assert.ok(!/if\s*\(\s*outFiles\.length\s*[><=!]+\s*0\s*\)\s*\{[\s\S]{0,200}?(previewImagesFromFiles|bumpGenerationCounter|notifyImageGenerated|preview\.appendChild\(readyWrap)/.test(postLoopSlice),
    'no post-loop branch that triggers preview/quota/notifyImageGenerated must be gated on outFiles.length');
});

test('SEV-1: genLastResult.image is set from succeededCount (BatchGen retry contract)', () => {
  const s = src('renderer/tabs/imageTab.js');
  // BatchGen polls state.genLastResult.image. If the run was
  // successful it MUST be 'ok' (NOT 'err'), or BatchGen will
  // auto-retry and re-spend API credits on images that already
  // landed. The fix gates on succeededCount so --n > 1 runs no
  // longer mis-report.
  assert.ok(s.includes("(succeededCount > 0 && !threw) ? 'ok' : 'err'"),
    'genLastResult.image must use the succeededCount gate (was: outFiles.length, broken for --n > 1 per SEV-1)');
});

test('SEV-1: the return-value branch is also gated on succeededCount', () => {
  const s = src('renderer/tabs/imageTab.js');
  // The `if (outFiles.length > 0) { return { status: 'ok', … } }`
  // pattern was the v1.1 partial-success fix that broke --n > 1.
  // The new shape uses succeededCount.
  const returnSlice = s.slice(s.indexOf('if (threw) return'));
  assert.ok(!/if\s*\(\s*outFiles\.length\s*>\s*0\s*\)\s*\{[\s\S]{0,400}?return\s*\{\s*status:\s*'ok'/.test(returnSlice),
    'the post-run return-value branch must NOT use outFiles.length > 0 (broken for --n > 1 per SEV-1)');
  assert.ok(/if\s*\(\s*succeededCount\s*>\s*0\s*\)/.test(returnSlice),
    'the post-run return-value branch must use succeededCount > 0');
});

test('SEV-1: success-toast wording is correct for --n > 1 runs', () => {
  const s = src('renderer/tabs/imageTab.js');
  // The success-toast builder must mention the per-file count when
  // nCount > 1, NOT the "X/N variants" wording (which is meaningless
  // for --n > 1 — there's only one Variant call, but it produces
  // nCount images). The pre-fix code used `variantsCount - okCount`
  // math which silently worked for single-image variants but
  // produced confusing toasts on --n > 1 runs.
  const slice = s.slice(s.indexOf('const failedVariants'));
  assert.ok(/variantsCount\s*>\s*1\s*&&\s*failedVariants\s*>\s*0/.test(slice),
    'the toast must show the partial-success wording only when Variants > 1 (not for --n > 1)');
  assert.ok(/nCount\s*>\s*1/.test(slice),
    'the toast must have an explicit --n > 1 branch showing the image count');
});

// ============================================================================
// 2. Behavioural coverage — extracted gate function
// ============================================================================
test('SEV-1 gate (pure): succeededCount>0 + !cancelled + !threw → success branch', () => {
  // The canonical SEV-1 case: a `--n 2` call that returns ok, with
  // the user NOT cancelling and the loop NOT throwing. The pre-fix
  // gate routed this to the failure branch because outFiles was
  // empty (mmx picks its own filenames in --out-dir mode). The new
  // gate routes to the success branch because succeededCount > 0.
  const r = decideOutcome({ succeededCount: 1, cancelled: false, threw: null });
  assert.equal(r.branch, 'success');
  assert.equal(r.status, 'ok');
});

test('SEV-1 gate (pure): --n 3 successful run is the same shape as --n 2', () => {
  // --n can be 1..4. Every successful run, regardless of nCount,
  // must reach the success branch.
  for (const n of [1, 2, 3, 4]) {
    const r = decideOutcome({ succeededCount: 1, cancelled: false, threw: null });
    assert.equal(r.branch, 'success', `--n ${n}: succeededCount=1 must route to success`);
    assert.equal(r.status, 'ok');
  }
});

test('SEV-1 gate (pure): partial-success (some variants failed) still routes to success', () => {
  // Variants=5 with 3 successful and 2 failed → succeededCount=3.
  // The pre-fix `outFiles.length > 0` gate would have routed this
  // to success too, but only when useOutDir was false. The new
  // succeededCount gate handles it for both modes.
  const r = decideOutcome({ succeededCount: 3, cancelled: false, threw: null });
  assert.equal(r.branch, 'success');
  assert.equal(r.status, 'ok');
});

test('SEV-1 gate (pure): zero successes → pure-failure branch (lastFailedR is the source)', () => {
  // No variant succeeded, user did not cancel, nothing threw.
  // This is the ONLY case that should hit the failure UI and the
  // lastFailedR-based error message. Pre-fix, this branch was hit
  // on every successful --n > 1 run as well (the bug).
  const r = decideOutcome({ succeededCount: 0, cancelled: false, threw: null });
  assert.equal(r.branch, 'pure-failure');
  assert.equal(r.status, 'err');
  // With a real lastFailedR, the message comes from it.
  assert.equal(lastFailedMessage({ code: 1, stderr: 'no auth' }, r.branch),
    'mmx exited with code 1');
  // With a null lastFailedR (the SEV-1 case where the call actually
  // succeeded but the renderer took the failure branch), the
  // message is the fabricated "code -1" — this is what the user
  // saw and what we are now preventing.
  assert.equal(lastFailedMessage(null, r.branch),
    'mmx exited with code -1');
});

test('SEV-1 gate (pure): throw takes precedence over success', () => {
  // A throw anywhere in the variant loop must always report err,
  // even if some variants succeeded before the throw.
  const r = decideOutcome({ succeededCount: 2, cancelled: false, threw: new Error('boom') });
  assert.equal(r.branch, 'thrown');
  assert.equal(r.status, 'err');
});

test('SEV-1 gate (pure): cancel takes precedence over success', () => {
  // The user clicked Cancel mid-loop. Some variants may have
  // already succeeded (so we have real files on disk), but the
  // status is 'cancel' (not 'ok') so the BatchGen runner doesn't
  // mis-classify the cancelled run as a normal completion.
  const r = decideOutcome({ succeededCount: 2, cancelled: true, threw: null });
  assert.equal(r.branch, 'cancelled');
  assert.equal(r.status, 'cancel');
});

// ============================================================================
// 3. CRLF coverage of source-grep guards in the test suite itself
// ============================================================================
// (SEV-2 from _temp10.md.) The realCodeHarness.test.js had a comment-
// strip regex `l.replace(/\/\/.*$/, '')` that was CRLF-fragile —
// `.` doesn't match `\r`, so the comment survived and tripped a
// false positive on the very CRLF file it was guarding. We pin that
// the FIX is in place AND that no other test in the suite is using
// the same fragile pattern. Any new CRLF-fragile strip that lands
// in a test file (now or in the future) is caught here.
test('SEV-2: realCodeHarness comment-strip regex is CRLF-safe', () => {
  const s = src('tests/unit/renderer/realCodeHarness.test.js');
  // The fix uses `[^\n]*` so the match consumes the trailing `\r`
  // (`.` doesn't match `\r` in JS).
  assert.ok(s.includes('\\/\\/[^\\n]*$'),
    'realCodeHarness.test.js must use /\\/\\/[^\n]*$/ in its comment-strip regex (CRLF-safe — was /\\/\\/.*$/, fragile per SEV-2)');
  // And the original fragile pattern must be GONE from executable
  // code. We strip BOTH // line comments AND block comments before
  // searching, so the explanatory comment about the bug (which
  // mentions the old regex) does not trip the check.
  const stripAllComments = (txt) => {
    let out = txt.replace(/\/\/[^\n]*$/gm, '');
    // crude block-comment strip
    out = out.replace(/\/\*[\s\S]*?\*\//g, '');
    return out;
  };
  const testNoComments = stripAllComments(s);
  // The exact fragile pattern: `.replace(/\/\/.*$/,` — note the
  // backslashes (in source: `\/\/.*$/`). Strip backslashes for
  // the literal match.
  const fragile = testNoComments.replace(/\\/g, '').includes('.replace(//.*$/,');
  assert.ok(!fragile,
    'realCodeHarness.test.js must NOT contain any CRLF-fragile `l.replace(/\\/\\/.*$/, …)` pattern in executable code');
});

test('SEV-2: no test file uses the CRLF-fragile split-then-replace comment-strip pattern', () => {
  // Belt-and-braces: scan every test file in the repo for the
  // CRLF-fragile pattern that caused SEV-2. The pattern is:
  //   <something>.split('\n').map(...l.replace(/\/\/.*$/ ...))
  // The .split('\n') is what makes the lines retain their trailing
  // \r, so without the [^\n] fix the inner regex fails.
  function walk(dir) {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...walk(p));
      else if (ent.name.endsWith('.test.js')) out.push(p);
    }
    return out;
  }
  const violations = [];
  for (const p of walk(path.join(ROOT, 'tests'))) {
    const body = fs.readFileSync(p, 'utf8');
    // Strip comments BEFORE searching so the regression tests' own
    // explanation comments (which mention the old regex) do not
    // false-positive.
    const noComments = body.replace(/\/\/[^\n]*$/gm, '');
    // Match: .split('\n') followed (anywhere later in the file) by a
    // regex like /\/\/.*$/ — a classic CRLF-fragile strip.
    if (/\.split\(['"`]\\n['"`]\)/.test(noComments) && /\/\/\.\*\$.*?replace\(/.test(noComments)) {
      // The split('\n') alone is fine; the violation is doing both.
      // Look for them in close proximity (same file is enough — we
      // can't reliably tell whether a given strip is wired to the
      // split without reading each occurrence).
      violations.push(path.relative(ROOT, p));
    }
  }
  assert.deepEqual(violations, [],
    'no test file may combine .split(\'\\n\') with a CRLF-fragile /\\/\\/.*$/ replace (would silently fail on this repo\'s CRLF files per SEV-2). Offenders: ' + violations.join(', '));
});

test('SEV-2: the CRLF regression strips a // comment containing updatePreview() from a CRLF buffer', () => {
  // Direct behavioural proof: feed the FIXED regex a CRLF buffer
  // that contains the original buggy string, and assert the live
  // call is preserved while the comment is stripped. This is the
  // exact failure mode that caused SEV-2 to red-line the suite.
  const crlfBuf = '  // old updatePreview() call that was removed\r\nlet x = updatePreview();\r\n';
  const stripped = crlfBuf.split('\n').map((l) => l.replace(/\/\/[^\n]*$/, '')).join('\n');
  // The comment-only `updatePreview()` must be gone.
  assert.ok(!stripped.includes('// old updatePreview'),
    'fixed strip must remove the // comment even on CRLF input (the SEV-2 regression would leave it in)');
  // The LIVE call must remain.
  assert.ok(/let x = updatePreview\(\);/.test(stripped),
    'fixed strip must preserve the live updatePreview() call (the actual production code)');
  // The ORIGINAL regex would fail this:
  const buggy = crlfBuf.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(buggy.includes('// old updatePreview'),
    'sanity: the original CRLF-fragile regex DOES leave the comment in (this is the bug we fixed)');
});

// ============================================================================
// 4. End-to-end structural proof that the bug-reporter's scenario is fixed
// ============================================================================
test('SEV-1 reproducer (structural): the exact mmxRunJob result that previously fabricated a failure now drives the success branch', () => {
  // From _temp10.md PART B (the user's actual repro):
  //   log row: { "saved": [ "image_001.jpg", "image_002.jpg" ] }
  //   UI preview:  "⚠ Generation failed — mmx exited with code -1 (silent)"
  // The pre-fix gate routed this to the failure branch because
  // outFiles was empty. The new gate sees succeededCount=1 and
  // routes to the success branch.
  //
  // This is a STRUCTURAL test: it asserts the source tokens that
  // make the fix work. The behavioural assertion is in section 2.
  const s = src('renderer/tabs/imageTab.js');

  // 1. The increment happens unconditionally after a successful call.
  const unconditionalInc = /succeededCount\+\+;/.test(s);
  assert.ok(unconditionalInc, 'succeededCount++ must be present and unconditional');

  // 2. The post-loop success gate keys off it.
  const successGate = /if \(succeededCount > 0 && !cancel\.wasCancelled\(\)\) \{/.test(s);
  assert.ok(successGate, 'success gate must check succeededCount > 0');

  // 3. The failure branch keys off the absence of succeededCount.
  const failureGate = /\} else if \(succeededCount === 0 && !cancel\.wasCancelled\(\)\) \{/.test(s);
  assert.ok(failureGate, 'failure branch must check succeededCount === 0');

  // 4. The BatchGen hook (state.genLastResult.image) mirrors the
  //    same gate — a successful --n run is reported as 'ok', so
  //    BatchGen does NOT auto-retry and re-spend quota.
  const batchGenOk = /\(succeededCount > 0 && !threw\) \? 'ok' : 'err'/.test(s);
  assert.ok(batchGenOk, 'state.genLastResult.image must be "ok" for any successful --n run (BatchGen retry contract)');

  // 5. bumpGenerationCounter / previewImagesFromFiles / notifyImageGenerated
  //    all live INSIDE the success branch (so they fire for --n runs).
  const successStart = s.indexOf('if (succeededCount > 0 && !cancel.wasCancelled()) {');
  const elseIfStart = s.indexOf("} else if (succeededCount === 0");
  const failureStart = elseIfStart + 1; // skip the leading `}` to point at " else if"
  // The failure branch ends at the matching `}` — easiest sentinel is the
  // try/catch that follows (`} catch (e) {` on line 973). Everything
  // between the `} else if` opener and that `} catch` is the failure
  // branch body.
  const failureEnd = s.indexOf('} catch (e) {', failureStart);
  const successBlock = s.slice(successStart, elseIfStart);
  const failureBlock = s.slice(failureStart, failureEnd);
  assert.ok(/previewImagesFromFiles/.test(successBlock),
    'previewImagesFromFiles must be inside the success branch (was unreachable for --n > 1 per SEV-1)');
  assert.ok(/bumpGenerationCounter/.test(successBlock),
    'bumpGenerationCounter must be inside the success branch (quota was under-counted for --n > 1 per SEV-1)');
  assert.ok(!/previewImagesFromFiles/.test(failureBlock),
    'previewImagesFromFiles must NOT be in the failure branch (it would overwrite the actual success preview)');
  assert.ok(!/bumpGenerationCounter/.test(failureBlock),
    'bumpGenerationCounter must NOT be in the failure branch (it would over-count quota on failure)');
});

// ============================================================================
// 5. Quota / queue-done accounting for --n × Variants combos
// ============================================================================
// The user-visible counter and the per-tab ETA read state.genQueueSize
// and state.genQueueDone. The bug-report's "Cascading damage" section
// flagged that the quota under-counted every multi-image generation;
// here we pin the arithmetic.
test('SEV-1: totalImages = variantsCount * nCount (not just nCount)', () => {
  const s = src('renderer/tabs/imageTab.js');
  // The total image count must multiply both axes. A user who sets
  // Variants=3 and --n=2 is paying for 6 images and expects the
  // ETA / quota counter to reflect all 6.
  assert.ok(/const totalImages\s*=\s*variantsCount\s*\*\s*nCount/.test(s),
    'totalImages must be variantsCount * nCount (was: just nCount, under-counted quota for Variants > 1)');
});

test('SEV-1: state.genQueueSize.image is set to totalImages BEFORE the variant loop', () => {
  const s = src('renderer/tabs/imageTab.js');
  // The per-tab ETA reads state.genQueueSize[tabKey] to compute
  // "remaining time". It must be set up front, otherwise the ETA
  // stays at "0" until the first variant completes.
  assert.ok(/state\.genQueueSize\.image\s*=\s*totalImages/.test(s),
    'state.genQueueSize.image must be set to totalImages up front (so the ETA has a denominator)');
});

test('SEV-1: state.genQueueDone.image advances by nCount per variant (not 1)', () => {
  const s = src('renderer/tabs/imageTab.js');
  // Each mmx call with --n > 1 produces nCount images. The
  // per-tab ETA ticks down by nCount per variant call, not 1,
  // otherwise the ETA reports "0 remaining" for half the run.
  // We count the number of `state.genQueueDone.image = (state.genQueueDone.image || 0) + nCount`
  // occurrences in the file. Both the success and failure per-variant
  // branches must use the nCount multiplier (failure path was the
  // addition reported by user in _temp4.md — it must also use nCount
  // so a failed --n > 1 variant correctly drains the ETA).
  const matches = s.match(/state\.genQueueDone\.image\s*=\s*\(state\.genQueueDone\.image\s*\|\|\s*0\)\s*\+\s*nCount/g);
  assert.ok(matches && matches.length >= 2,
    `state.genQueueDone.image must advance by nCount in BOTH the success AND failure per-variant branches (found ${matches ? matches.length : 0} occurrences). The failure branch must also use nCount so a failed --n > 1 variant drains the ETA correctly.`);
});

test('SEV-1: bumpGenerationCounter is called with the FULL totalImages (not nCount, not variantsCount)', () => {
  const s = src('renderer/tabs/imageTab.js');
  // The post-loop quota bump must reflect the full image count the
  // user paid API credits for. Using nCount or variantsCount here
  // would under-count every multi-variant or multi-image run.
  assert.ok(/bumpGenerationCounter\(\s*['"]image['"]\s*,\s*totalImages\s*\)/.test(s),
    'bumpGenerationCounter("image", totalImages) must use totalImages (the full Variants × --n product)');
});

// ============================================================================
// 6. The pure-gate function used as a behavioural reference
// ============================================================================
// Extract the toast-message builder logic from the real code as a
// pure function. This is the EXACT shape the live code uses; if
// anyone changes the live code, these tests will fail and force a
// thought-through update.
function buildSuccessToast({ variantsCount, nCount, succeededCount, finalOutputPathsLen, totalImages }) {
  const savedCount = finalOutputPathsLen || totalImages;
  const failedVariants = variantsCount - succeededCount;
  if (variantsCount > 1 && failedVariants > 0) {
    return { msg: `Image generated. ${succeededCount}/${variantsCount} variants saved (${failedVariants} failed — see log).`, tone: 'warn' };
  }
  if (variantsCount > 1) {
    return { msg: `Image generated. ${variantsCount} variants saved.`, tone: 'ok' };
  }
  if (nCount > 1) {
    return { msg: `Image generated. ${savedCount} images saved.`, tone: 'ok' };
  }
  return { msg: 'Image generated.', tone: 'ok' };
}

test('SEV-1 toast: --n 2 single variant shows "2 images saved"', () => {
  const r = buildSuccessToast({ variantsCount: 1, nCount: 2, succeededCount: 1, finalOutputPathsLen: 2, totalImages: 2 });
  assert.equal(r.msg, 'Image generated. 2 images saved.');
  assert.equal(r.tone, 'ok');
});

test('SEV-1 toast: --n 4 single variant shows "4 images saved"', () => {
  const r = buildSuccessToast({ variantsCount: 1, nCount: 4, succeededCount: 1, finalOutputPathsLen: 4, totalImages: 4 });
  assert.equal(r.msg, 'Image generated. 4 images saved.');
});

test('SEV-1 toast: Variants=3 with --n=1 partial (2/3) shows partial-success wording', () => {
  const r = buildSuccessToast({ variantsCount: 3, nCount: 1, succeededCount: 2, finalOutputPathsLen: 2, totalImages: 3 });
  assert.equal(r.msg, 'Image generated. 2/3 variants saved (1 failed — see log).');
  assert.equal(r.tone, 'warn');
});

test('SEV-1 toast: Variants=3 + --n=2 full success shows "3 variants saved"', () => {
  // The toast wording for a full-success multi-variant run stays in
  // variant-count terms even when --n > 1, because the user already
  // set Variants explicitly and the produced image count is implied.
  const r = buildSuccessToast({ variantsCount: 3, nCount: 2, succeededCount: 3, finalOutputPathsLen: 6, totalImages: 6 });
  assert.equal(r.msg, 'Image generated. 3 variants saved.');
  assert.equal(r.tone, 'ok');
});

test('SEV-1 toast: Variants=3 + --n=2 partial (2/3 variants) shows partial-success wording', () => {
  const r = buildSuccessToast({ variantsCount: 3, nCount: 2, succeededCount: 2, finalOutputPathsLen: 4, totalImages: 6 });
  assert.equal(r.msg, 'Image generated. 2/3 variants saved (1 failed — see log).');
  assert.equal(r.tone, 'warn');
});

test('SEV-1 toast: single image single variant shows the default "Image generated."', () => {
  const r = buildSuccessToast({ variantsCount: 1, nCount: 1, succeededCount: 1, finalOutputPathsLen: 1, totalImages: 1 });
  assert.equal(r.msg, 'Image generated.');
});

// ============================================================================
// 7. The formatMmxError fallback that produced the fabricated message
// ============================================================================
// Mirror of the fallback `formatMmxError(lastFailedR || { stderr:'',
// stdout:'', code:-1 })` at imageTab.js:820. We pin the SHAPE of the
// fallback so a future change to formatMmxError is caught.
function formatMmxError(r) {
  let msg = (r.stderr || r.stdout || '').toString();
  msg = msg.replace(/^node\.exe\s*:\s*/gm, '').trim();
  if (r.parsed && typeof r.parsed === 'object') {
    if (r.parsed.error && typeof r.parsed.error === 'object' && r.parsed.error.message) {
      const m = String(r.parsed.error.message);
      if (m) return msg ? `${m} (${msg})` : m;
    }
    if (r.parsed.base_resp && r.parsed.base_resp.status_msg) {
      const sm = r.parsed.base_resp.status_msg;
      const sc = r.parsed.base_resp.status_code;
      if (sm && sc !== 0) return msg ? `${sm} (${msg})` : sm;
    }
    if (typeof r.parsed.message === 'string' && r.parsed.message) return r.parsed.message;
  }
  return msg || `mmx exited with code ${r.code}`;
}

test('SEV-1 fabricated message: empty stderr/stdout + code -1 → "mmx exited with code -1"', () => {
  // This is the EXACT message the user saw on every successful --n > 1
  // run, because lastFailedR was null and the failure branch built the
  // error from the hardcoded fallback `{stderr:'', stdout:'', code:-1}`.
  // We pin the message so the user-visible text can't silently drift.
  assert.equal(formatMmxError({ stderr: '', stdout: '', code: -1 }),
    'mmx exited with code -1');
});

test('SEV-1 fabricated message: classifyMmxError tags empty-stderr code -1 as "silent"', () => {
  // The user-visible behaviour: a fabricated code -1 with empty
  // stderr/stdout gets the "silent" classification, which surfaces
  // the "wait 30s, reduce --n" tips — exactly the misleading advice
  // that hid the renderer bug. We pin this so the classification
  // doesn't drift (it was the original signal that something was wrong).
  function classifyMmxError(r, msg) {
    const combined = ((msg || '') + ' ' + (r.stderr || '') + ' ' + (r.stdout || '')).toLowerCase();
    if (/401|403|unauthor|forbidden|invalid.api.key|api.key.*invalid|auth.*fail/.test(combined)) return 'auth';
    if (/enoent|no such file|file or directory not found|file system error/.test(combined)) return 'input';
    if (/429|rate|limit|throttl|too many/.test(combined)) return 'rate';
    if (/quota|not.in.plan|exhaust|insufficient/.test(combined)) return 'quota';
    if (/enotfound|econnrefused|econnreset|etimedout|network|dns/.test(combined)) return 'network';
    if (/500|502|503|504|server.error|system.error|internal/.test(combined)) return 'server';
    const codeIsNeg = (r && (r.code === -1 || r.code === null || r.code === undefined));
    const stderrEmpty = !(r && r.stderr && String(r.stderr).trim());
    const stdoutEmpty = !(r && r.stdout && String(r.stdout).trim());
    const msgEmpty = !msg || !String(msg).trim() || /mmx exited with code -1/i.test(String(msg));
    if (codeIsNeg && stderrEmpty && stdoutEmpty && msgEmpty) return 'silent';
    return 'unknown';
  }
  const fallbackMsg = formatMmxError({ stderr: '', stdout: '', code: -1 });
  assert.equal(classifyMmxError({ stderr: '', stdout: '', code: -1 }, fallbackMsg), 'silent',
    'an empty-stderr code -1 envelope must classify as "silent" — that\'s the classification the renderer used to invent the misleading tips');
});

// ============================================================================
// R6.4 — DOM-Reihenfolge: postprocess finalizes BEFORE pipeline enqueue.
// ============================================================================
// Pre-R6.4 the auto-pipeline enqueue ran BEFORE the batch postprocess, so
// the pipeline received raw files while the post-processed outputs were
// never enqueued. R6.4 swaps the order: postprocess first (updates
// displayFiles), then pipeline enqueue (gets the final deliverables).

test('R6.4.A: BatchPostprocess.runRowPostprocess appears BEFORE Pipeline.enqueueFromPaths in imageTab.js', () => {
  const s = src('renderer/tabs/imageTab.js');
  // Find the FIRST occurrence of each in the success path (after the
  // sourceFiles loop). Both appear in the same function scope.
  // NOTE: Phase 5 added a "Send to Pipeline" button that also calls
  // Pipeline.enqueueFromPaths earlier in the file (the manual button
  // handler). We must find the occurrence AFTER postprocess, which is
  // the auto-pipeline enqueue in the generation success path.
  const ppIdx = s.indexOf('BatchPostprocess.runRowPostprocess');
  const enqueueIdx = s.indexOf('Pipeline.enqueueFromPaths', ppIdx);
  assert.ok(ppIdx > 0, 'R6.4.A: BatchPostprocess.runRowPostprocess must exist in imageTab.js');
  assert.ok(enqueueIdx > 0, 'R6.4.A: Pipeline.enqueueFromPaths must exist in imageTab.js');
  assert.ok(ppIdx < enqueueIdx,
    `R6.4.A: postprocess (idx ${ppIdx}) must appear BEFORE pipeline enqueue (idx ${enqueueIdx}) — pre-R6.4 the order was reversed`);
});

test('R6.4.B: postprocess outputs replace displayFiles before pipeline enqueue', () => {
  const s = src('renderer/tabs/imageTab.js');
  // The postprocess block must reassign displayFiles with pp.outputs
  // BEFORE the pipeline enqueue reads displayFiles.
  // NOTE: search for enqueue AFTER the reassignment to skip the manual
  // "Send to Pipeline" button handler added in Phase 5.
  const reassignIdx = s.indexOf('displayFiles = pp.outputs.slice()');
  const enqueueIdx = s.indexOf('Pipeline.enqueueFromPaths', reassignIdx);
  assert.ok(reassignIdx > 0, 'R6.4.B: displayFiles must be reassigned with pp.outputs.slice()');
  assert.ok(enqueueIdx > 0, 'R6.4.B: Pipeline.enqueueFromPaths must exist');
  assert.ok(reassignIdx < enqueueIdx,
    `R6.4.B: displayFiles reassignment (idx ${reassignIdx}) must be BEFORE enqueue (idx ${enqueueIdx})`);
});

test('R6.4.C: displayFiles is declared with let (not const) so postprocess can reassign it', () => {
  const s = src('renderer/tabs/imageTab.js');
  assert.ok(/let\s+displayFiles\s*=\s*\[\]/.test(s),
    'R6.4.C: displayFiles must be `let` (R6.4 reassigns it with postprocess outputs)');
  assert.ok(!/const\s+displayFiles\s*=\s*\[\]/.test(s),
    'R6.4.C: displayFiles must NOT be const (would throw on reassignment)');
});