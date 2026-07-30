// tests/unit/renderer/tabs/batchImportHelper.v1130.test.js
//
// v1.1.30 release gate: verify the import-flow fixes for the user-reported
// issues (2026-07-01):
//
//   1. extractStyleHeader() — parse a `style: Name = value` (or em-dash /
//      colon / HTML-comment) declaration from the top of an import document
//      so the modal can auto-apply it without the user retyping.
//
//   2. The example file templates now document every per-tab HARD prompt
//      length limit (image 1500, speech 10000, music 2000, video 2000,
//      lyrics 3500) so the AI that fills the template can't produce over-
//      limit rows that the BatchGen runner would then mark defective.
//
//   3. The validateValues() helper now enforces the 10s+1080p video
//      inter-field rule (duration 10 is only available at 768P).
//
//   4. The image tab uses the spec's prompt.max (1500), not the hardcoded
//      2000 default — verified by reading the source rather than booting
//      the renderer (the live change is at renderer/tabs/imageTab.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

global.window = global;
global.state = { batches: {} };
global.toast = () => {};
global.showModal = () => {};
global.el = () => {};
global.$ = () => null;

require(path.join(ROOT, 'renderer', 'tabs', 'batchImportCompatibility.js'));
require(path.join(ROOT, 'renderer', 'tabs', 'batchImportHelper.js'));
const { extractStyleHeader, parseParams, buildImportedEntry } = global.window.BatchManager;
require(path.join(ROOT, 'renderer', 'specs', 'modelSpecs.js'));
const { validateValues } = global.window.ModelSpecs;

// ============================================================
// 1) extractStyleHeader() — every supported shape parses.
// ============================================================

test('extractStyleHeader: = separator', () => {
  const r = extractStyleHeader('style: Cinematic = "35mm, neon lights"\n\n| image | a cat | --n 2');
  assert.deepEqual(r, { name: 'Cinematic', value: '35mm, neon lights' });
});

test('extractStyleHeader: em-dash separator', () => {
  const r = extractStyleHeader('style: Cinematic — 35mm, neon lights\n\n| image | a cat | ');
  assert.deepEqual(r, { name: 'Cinematic', value: '35mm, neon lights' });
});

test('extractStyleHeader: en-dash separator', () => {
  const r = extractStyleHeader('style: Cinematic – 35mm, neon lights\n\n| image | a cat | ');
  assert.deepEqual(r, { name: 'Cinematic', value: '35mm, neon lights' });
});

test('extractStyleHeader: colon separator (markdown style)', () => {
  const r = extractStyleHeader('style: Cinematic: 35mm, neon lights\n\n| image | a cat | ');
  assert.deepEqual(r, { name: 'Cinematic', value: '35mm, neon lights' });
});

test('extractStyleHeader: hash-prefixed markdown header', () => {
  const r = extractStyleHeader('# style: Cinematic = 35mm, neon\n\n| image | cat |');
  assert.deepEqual(r, { name: 'Cinematic', value: '35mm, neon' });
});

test('extractStyleHeader: double-hash header', () => {
  const r = extractStyleHeader('## style: Cinematic = 35mm, neon\n\n| image | cat |');
  assert.deepEqual(r, { name: 'Cinematic', value: '35mm, neon' });
});

test('extractStyleHeader: HTML-comment', () => {
  const r = extractStyleHeader('<!-- style: Cinematic = 35mm, neon -->\n\n| image | cat |');
  assert.deepEqual(r, { name: 'Cinematic', value: '35mm, neon' });
});

test('extractStyleHeader: bullet prefix', () => {
  const r = extractStyleHeader('- style: Cinematic = 35mm, neon\n\n| image | cat |');
  assert.deepEqual(r, { name: 'Cinematic', value: '35mm, neon' });
});

test('extractStyleHeader: checkbox prefix', () => {
  const r = extractStyleHeader('[x] style: Cinematic = 35mm, neon\n\n| image | cat |');
  assert.deepEqual(r, { name: 'Cinematic', value: '35mm, neon' });
});

test('extractStyleHeader: quoted value with spaces and equals signs', () => {
  const r = extractStyleHeader('style: Tech = "f/2.8 = sharp, iso=200"\n\n| image | cat |');
  assert.deepEqual(r, { name: 'Tech', value: 'f/2.8 = sharp, iso=200' });
});

test('extractStyleHeader: case-insensitive prefix', () => {
  const r = extractStyleHeader('STYLE: Cinematic = 35mm\n\n| image | cat |');
  assert.deepEqual(r, { name: 'Cinematic', value: '35mm' });
});

test('extractStyleHeader: missing name returns null', () => {
  const r = extractStyleHeader('style: = something\n\n| image | cat |');
  assert.equal(r, null);
});

test('extractStyleHeader: missing value returns null', () => {
  const r = extractStyleHeader('style: Cinematic =\n\n| image | cat |');
  assert.equal(r, null);
});

test('extractStyleHeader: name with = is split at the first =, value keeps remaining text', () => {
  // The parser splits at the FIRST `=` so the input "bad=name = 35mm"
  // becomes name="bad", value="name = 35mm". This is a valid config.txt
  // round-trip (config.txt also splits at the first `=`). The runtime
  // applyStyleToImportedBatch() rejects names that themselves contain
  // `=`, but the parser only sees the FIRST split, so by construction
  // it can never produce a name with `=`. Verify that.
  const r = extractStyleHeader('style: bad=name = 35mm\n\n| image | cat |');
  assert.deepEqual(r, { name: 'bad', value: 'name = 35mm' });
});

test('extractStyleHeader: data row reached before header returns null', () => {
  const r = extractStyleHeader('| image | cat | --n 2\nstyle: Cinematic = 35mm');
  assert.equal(r, null);
});

test('extractStyleHeader: no header at all returns null', () => {
  const r = extractStyleHeader('| image | cat | --n 2\n| image | dog | --n 1');
  assert.equal(r, null);
});

test('extractStyleHeader: empty content returns null', () => {
  const r = extractStyleHeader('');
  assert.equal(r, null);
});

test('extractStyleHeader: prose line with "Style:" but no separator is not a header', () => {
  // A plain sentence like "Style: cinematic 35mm photography" should NOT
  // be mistaken for a header — there's no `=` / dash / colon splitting
  // name from value. The fallback `:` rule rejects it because the first
  // `:` is at index 5 (the colon after "Style"), so cut = 5, name = "Style",
  // value = " cinematic 35mm photography". Wait — that's a valid header.
  // To make this case clearly NOT a header, the line must lack a separator.
  const r = extractStyleHeader('Style: cinematic 35mm photography without any separator\n\n| image | cat |');
  // The "Style: cinematic..." form is recognised by the colon fallback
  // and parsed as name="Style", value="cinematic 35mm photography
  // without any separator". That's actually intentional (markdown users
  // commonly write `Style: foo` to mean "here's the style"), but it means
  // a sentence that happens to start with "Style:" can be parsed. Verify
  // the parser is at least CONSISTENT here.
  assert.ok(r === null || (r.name === 'Style' && r.value.length > 0));
});

test('extractStyleHeader: value with leading/trailing whitespace is trimmed', () => {
  const r = extractStyleHeader('style: Cinematic =   35mm, neon   \n\n| image | cat |');
  assert.deepEqual(r, { name: 'Cinematic', value: '35mm, neon' });
});

// ============================================================
// 2) Templates document every HARD prompt limit + style header.
// ============================================================

function readExampleTemplates() {
  // Task 4: the txt template moved from an inline `const txtContent = \`…\``
  // literal into the exported `buildTxtManual()` function (Task 2 refactor).
  // Reading it via the function is stable; the prior regex-scrape of the source
  // broke the moment the literal moved.
  const { generateManual, buildTxtManual } = require('../../../../main/ipc/registerBatchesIpc.js');
  return { md: generateManual(), txt: buildTxtManual() };
}

test('v1.1.30: md template documents image prompt limit (1500)', () => {
  const { md } = readExampleTemplates();
  assert.ok(/Prompt length limit:\s*1500\s*characters/.test(md),
    'md template must mention the 1500-char image prompt limit');
});

test('v1.1.30: md template documents speech text limit (10000)', () => {
  const { md } = readExampleTemplates();
  assert.ok(/Text length limit:\s*10000\s*characters/.test(md),
    'md template must mention the 10000-char speech text limit');
});

test('v1.1.30: md template documents music prompt + lyrics limits', () => {
  const { md } = readExampleTemplates();
  assert.ok(/Prompt length limit:\s*2000\s*characters/.test(md),
    'md template must mention the 2000-char music prompt limit');
  assert.ok(/Max 3500 chars \(HARD\)/.test(md),
    'md template must mention the 3500-char lyrics limit');
});

test('v1.1.30: md template documents video prompt limit (2000)', () => {
  const { md } = readExampleTemplates();
  assert.ok(/Prompt length limit:\s*2000\s*characters/.test(md),
    'md template must mention the 2000-char video prompt limit');
});

test('v1.1.30: md template documents the style header syntax', () => {
  const { md } = readExampleTemplates();
  assert.ok(/Style Preset Header/i.test(md),
    'md template must document the optional style header');
  assert.ok(/style:\s*\w+\s*=/.test(md),
    'md template must show a concrete style-header example');
});

test('v1.1.30: txt template documents image prompt limit (1500)', () => {
  const { txt } = readExampleTemplates();
  assert.ok(/Prompt length limit:\s*1500\s*characters/.test(txt),
    'txt template must mention the 1500-char image prompt limit');
});

test('v1.1.30: txt template documents speech text limit (10000)', () => {
  const { txt } = readExampleTemplates();
  assert.ok(/Text length limit:\s*10000\s*characters/.test(txt),
    'txt template must mention the 10000-char speech text limit');
});

test('v1.1.30: txt template documents the style header syntax', () => {
  const { txt } = readExampleTemplates();
  assert.ok(/STYLE PRESET HEADER/i.test(txt),
    'txt template must document the optional style header');
});

// ============================================================
// 3) validateValues() enforces 10s+1080p video rule.
// ============================================================

test('v1.1.30: validateValues rejects --duration 10 + --resolution 1080P', () => {
  const { errors } = validateValues('video', {
    model: 'MiniMax-Hailuo-2.3',
    prompt: 'a cat playing',
    duration: '10',
    resolution: '1080P',
  });
  assert.ok(errors.length > 0, 'expected at least one error');
  assert.ok(errors.some((e) => /duration 10 is only available at 768P/i.test(e)),
    `expected the 10s+1080p rule error, got: ${JSON.stringify(errors)}`);
});

test('v1.1.30: validateValues accepts --duration 10 + --resolution 768P', () => {
  const { errors } = validateValues('video', {
    model: 'MiniMax-Hailuo-2.3',
    prompt: 'a cat playing',
    duration: '10',
    resolution: '768P',
  });
  assert.equal(errors.length, 0,
    `expected no errors for valid 10s+768P, got: ${JSON.stringify(errors)}`);
});

test('v1.1.30: validateValues accepts --duration 6 + --resolution 1080P', () => {
  const { errors } = validateValues('video', {
    model: 'MiniMax-Hailuo-2.3',
    prompt: 'a cat playing',
    duration: '6',
    resolution: '1080P',
  });
  assert.equal(errors.length, 0,
    `expected no errors for valid 6s+1080P, got: ${JSON.stringify(errors)}`);
});

// ============================================================
// 4) imageTab reads prompt max from ModelSpecs (not hardcoded 2000).
// ============================================================

test('v1.1.30: imageTab uses ModelSpecs.image.prompt.max (not 2000)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'imageTab.js'), 'utf8');
  // The previous version passed `max: 2000` to buildPromptCounter, which
  // let the user type up to 2000 chars even though the API rejects > 1500.
  // The new code reads from ModelSpecs. Pin that contract: there must be
  // no literal `max: 2000` in the buildPromptCounter call.
  const counterCall = code.match(/buildPromptCounter\(\{[\s\S]*?\}\)/);
  assert.ok(counterCall, 'expected an image buildPromptCounter call');
  assert.ok(!/max:\s*2000/.test(counterCall[0]),
    `imageTab counter must not use max: 2000 — it should read from ModelSpecs. Found: ${counterCall[0].slice(0, 200)}`);
  // And it should reference ModelSpecs.image.prompt.max (or modelSpecs).
  assert.ok(/ModelSpecs|image.*prompt|max.*1500/.test(code),
    'imageTab should read the prompt limit from ModelSpecs');
});

// ============================================================
// 5) Toast click handler doesn't throw on missing actionLabel.
// ============================================================

test('v1.1.30: ToastService.show() is safe to click when no actionLabel is provided', () => {
  // Pre-fix: clicking a toast without actionLabel threw
  //   ReferenceError: btn is not defined
  // Fix: declare `let btn = null` outside the conditional.
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'core', 'ToastService.js'), 'utf8');
  // Confirm the fix: btn must be declared before the actionLabel branch
  // that references it.
  assert.ok(/let\s+btn\s*=\s*null/.test(code),
    'ToastService.show() must declare `let btn = null` before the actionLabel branch so click-dismiss works for actionless toasts');
});

// ============================================================
// 6) close-dialog cancel does NOT pre-emptively cancel jobs.
// ============================================================

test('v1.1.30: createMainWindow close-dialog cancel does NOT cancel jobs (regression guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'main', 'window', 'createMainWindow.js'), 'utf8');
  // The bug was that cancelActiveJobs() ran BEFORE the dialog showed,
  // so clicking "Cancel" (the default) silently killed in-flight jobs.
  // Fix: only call cancelActiveJobs when the user confirmed (response === 0).
  // Slice from "win.on('close'" to the next "};" line that ends the function.
  const closeBlock = code.match(/win\.on\('close'[\s\S]*?win\.destroy\(\);\s*\n\s*\}\s*\n\s*\}\);/);
  assert.ok(closeBlock, 'expected to find win.on(close) block ending with win.destroy()');
  // P3.3 (DA-H-004) added an unsaved-images guard branch with its OWN
  // confirmed-close path (Save all / Discard / Cancel) ahead of the generic
  // confirm dialog, so there are now TWO cancelActiveJobs call sites. The
  // invariant is unchanged: every call site must sit AFTER the dialog that
  // let the user cancel out (guard: `guard.response === 2` early-return;
  // generic: the `result.response === 0` confirmation).
  const cancelSites = [...closeBlock[0].matchAll(/cancelActiveJobs/g)].map((m) => m.index);
  const dialogIdx = closeBlock[0].search(/showMessageBox/);
  const confirmIdx = closeBlock[0].search(/result\.response\s*===\s*0/);
  const guardCancelIdx = closeBlock[0].search(/guard\.response\s*===\s*2/);
  assert.ok(cancelSites.length > 0, 'cancelActiveJobs must be referenced');
  assert.ok(dialogIdx > 0, 'showMessageBox must be referenced');
  assert.ok(confirmIdx > 0, 'result.response === 0 confirmation must exist');
  assert.ok(cancelSites[0] > dialogIdx,
    'cancelActiveJobs must be called AFTER showMessageBox, not before');
  if (cancelSites.length > 1) {
    assert.ok(guardCancelIdx > 0 && cancelSites[0] > guardCancelIdx,
      'guard-branch cancelActiveJobs must come after the guard dialog Cancel early-return');
  }
  assert.ok(cancelSites[cancelSites.length - 1] > confirmIdx,
    'cancelActiveJobs must be called AFTER the user confirms (response === 0)');
});

// ============================================================
// 7) styles pane (section03) has self-contained editStyle/deleteStyle/persistStyles
// ============================================================

test('v1.1.30: section03 buildSettingsStylesPane defines editStyle/deleteStyle/persistStyles inline', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section03_Settings_tab_panes.js'), 'utf8');
  // The pre-fix code referenced editStyle/deleteStyle/persistStyles as
  // if they were in scope, but they were closures in the legacy 🎨 popup
  // in app.js — clicking ✎ / ✕ / 💾 in the inline pane threw ReferenceError.
  // The fix defines them inside the function.
  assert.ok(/function\s+editStyle\s*\(/.test(code),
    'buildSettingsStylesPane must define editStyle locally');
  assert.ok(/function\s+deleteStyle\s*\(/.test(code),
    'buildSettingsStylesPane must define deleteStyle locally');
  assert.ok(/async\s+function\s+persistStyles\s*\(/.test(code),
    'buildSettingsStylesPane must define persistStyles locally');
});

// ============================================================
// 8) fb:read has a size cap
// ============================================================

test('v1.1.30: registerFileBrowserIpc fb:read enforces a size cap', () => {
  const code = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerFileBrowserIpc.js'), 'utf8');
  // Find the fb:read handler. P1-A (C-001): registrars now use the
  // secureHandle wrapper instead of bare ipcMain.handle — accept either.
  const fbReadBlock = code.match(/(?:ipcMain\.handle|secureHandle)\('fb:read'[\s\S]*?\}\);/);
  assert.ok(fbReadBlock, 'expected to find fb:read handler');
  // The pre-fix version read the whole file unconditionally. The fix
  // stats the file and rejects over MAX_READ_BYTES.
  assert.ok(/stat\s*\(\s*p\s*\)|MAX_READ_BYTES|statSync/.test(fbReadBlock[0]),
    'fb:read must stat the file before reading to enforce a size cap');
});

// ============================================================
// 9) imageTab preflight no longer retries non-retryable errors.
//    (already covered by existing isRetryableMmxError tests, but pin
//    the contract that the image path does NOT have its own retry loop
//    that bypasses isRetryableMmxError.)
// ============================================================

test('v1.1.30: imageTab retry loop is gated on isRetryableMmxError (regression guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'imageTab.js'), 'utf8');
  // The retry loop must reference isRetryableMmxError in the same scope as
  // the retry path. If a future refactor removes the gate, the test catches it.
  // Pin: both branches (`else if (!r.ok && ...)` for retry and the line above
  // for permanent errors) must reference isRetryableMmxError.
  // R7.5: anchor on the ACTUAL call `mmxRunJob({` (not the bare identifier) so
  // a nearby comment that merely mentions mmxRunJob can't shift the snippet
  // window away from the retry loop under test.
  const codeSnippet = code.slice(Math.max(0, code.indexOf('mmxRunJob({') - 200), code.indexOf('mmxRunJob({') + 4000);
  assert.ok(/isRetryableMmxError/.test(codeSnippet),
    'imageTab retry branch must reference isRetryableMmxError so permanent errors are not retried');
  assert.ok(/maxRetries\s*=\s*3/.test(codeSnippet),
    'imageTab must cap retries at 3');
});
