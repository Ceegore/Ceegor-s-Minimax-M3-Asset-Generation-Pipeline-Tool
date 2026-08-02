// tests/unit/renderer/audioCutterSingleFile.h048.test.js
// ============================================================================
// H-048 (_5 audit) regression: the file-browser "Trim" bulk action used to
// open the interactive audio cutter on the FIRST selected audio file only,
// yet fbBulkAction counted EVERY selected path as a success ("N items ok").
// That is a misleading bulk-trim: files 2..N were silently skipped while the
// toast reported them as trimmed.
//
// Fix (short-term, per the report): the action is gated to EXACTLY ONE audio
// file and renamed "Audio cutter". Multi-selection is clearly blocked with a
// hint; the success count can no longer exceed the number of files actually
// processed. A real batch trim (shared settings dialog + sequential audioCut
// with a per-file result) is deferred.
//
// This test (1) source-guards the wiring in renderer/app.js + index.html and
// (2) functionally executes the real click-handler body against a stubbed
// environment to prove the gating behaviour.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const APP = path.join(ROOT, 'renderer', 'app.js');
const HTML = path.join(ROOT, 'renderer', 'index.html');

function read(p) { return fs.readFileSync(p, 'utf8'); }

// Extract the `$('#fb-bulk-trim').addEventListener('click', () => { ... });`
// handler body from app.js so we can execute the REAL logic in isolation.
function extractTrimHandler() {
  const src = read(APP);
  const start = src.indexOf("$('#fb-bulk-trim').addEventListener('click'");
  assert.ok(start !== -1, 'fb-bulk-trim click handler must exist in app.js');
  // Walk braces from the first '{' after the arrow to find the matching close.
  const arrow = src.indexOf('=>', start);
  const open = src.indexOf('{', arrow);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end !== -1, 'handler body must be brace-balanced');
  return src.slice(open + 1, end);
}

// Run the real handler body with a stubbed selection + captured side effects.
// Uses a vm sandbox (the project's standard pattern for executing extracted
// renderer snippets — see grantHelper.b002.test.js), NOT new Function.
function runHandler(selectedPaths, { cutterLoaded = true } = {}) {
  const body = extractTrimHandler();
  const toasts = [];
  const cutterCalls = [];
  const sandbox = {
    state: { fbSelected: new Set(selectedPaths) },
    toast: (msg, tone, ms) => toasts.push({ msg, tone, ms }),
    window: {
      showAudioCutter: cutterLoaded ? (p) => cutterCalls.push(p) : undefined,
      fbBulkAction: () => { throw new Error('H-048: fbBulkAction must NOT be used for the single-file cutter'); },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`(function () { ${body} })();`, sandbox, { filename: 'app.js#fb-bulk-trim', timeout: 3000 });
  return { toasts, cutterCalls };
}

// ---------------------------------------------------------------------------
// Functional behaviour of the real handler.
// ---------------------------------------------------------------------------
test('H-048: exactly one audio file opens the cutter, no misleading bulk toast', () => {
  const { toasts, cutterCalls } = runHandler(['/tmp/song.mp3']);
  assert.deepEqual(cutterCalls, ['/tmp/song.mp3'], 'cutter opens on the single audio file');
  assert.equal(toasts.length, 0, 'no warning/error toast for the happy path');
});

test('H-048: multiple audio files are blocked — cutter NOT opened, clear hint shown', () => {
  const { toasts, cutterCalls } = runHandler(['/tmp/a.mp3', '/tmp/b.wav', '/tmp/c.flac']);
  assert.equal(cutterCalls.length, 0, 'cutter must NOT open on a multi-selection');
  assert.equal(toasts.length, 1, 'exactly one blocking hint');
  assert.match(toasts[0].msg, /one file at a time/i);
  assert.match(toasts[0].msg, /you have 3/i, 'hint reports the real count');
  assert.equal(toasts[0].tone, 'warn');
});

test('H-048: audio + non-audio mix still blocked (2 audio present)', () => {
  const { toasts, cutterCalls } = runHandler(['/tmp/a.mp3', '/tmp/b.wav', '/tmp/pic.png']);
  assert.equal(cutterCalls.length, 0, 'multi audio selection blocked even with non-audio present');
  assert.match(toasts[0].msg, /you have 2/i, 'counts audio files only');
});

test('H-048: no audio in selection → rejected with audio-only hint', () => {
  const { toasts, cutterCalls } = runHandler(['/tmp/pic.png', '/tmp/notes.txt']);
  assert.equal(cutterCalls.length, 0);
  assert.match(toasts[0].msg, /None of the selected files are audio/i);
});

test('H-048: single audio among non-audio opens the cutter (exactly one audio)', () => {
  const { toasts, cutterCalls } = runHandler(['/tmp/a.mp3', '/tmp/pic.png']);
  assert.deepEqual(cutterCalls, ['/tmp/a.mp3'], 'one audio + non-audio = exactly one audio → opens');
  assert.equal(toasts.length, 0);
});

test('H-048: cutter module missing → error toast, no crash', () => {
  const { toasts, cutterCalls } = runHandler(['/tmp/a.mp3'], { cutterLoaded: false });
  assert.equal(cutterCalls.length, 0);
  assert.match(toasts[0].msg, /not loaded/i);
  assert.equal(toasts[0].tone, 'err');
});

// ---------------------------------------------------------------------------
// Source guards: pin the wiring so the misleading bulk path can't return.
// ---------------------------------------------------------------------------
test('H-048: source guards — single-file gate + no fbBulkAction for trim', () => {
  const src = read(APP);
  const start = src.indexOf("$('#fb-bulk-trim').addEventListener('click'");
  // Isolate the trim handler region (up to the next bulk handler).
  const region = src.slice(start, src.indexOf("$('#fb-bulk-delete')", start));
  // Strip comment lines so the explanatory comment (which names the OLD
  // fbBulkAction behaviour) doesn't false-fire the negative guards — we
  // assert on CODE only.
  const code = region.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  assert.match(code, /audioPaths\.length !== 1/, 'handler must gate on exactly one audio file');
  assert.match(code, /showAudioCutter\(audioPaths\[0\]\)/, 'opens the cutter on the single audio file directly');
  assert.doesNotMatch(code, /fbBulkAction/, 'H-048: trim must NOT route through fbBulkAction (its ok-count misled users)');
  assert.doesNotMatch(code, /indexOf\(path\) !== 0/, 'H-048: the "only first file" skip hack must be gone');
});

test('H-048: button renamed to the single-file audio cutter (index.html)', () => {
  const html = read(HTML);
  const btn = html.match(/<button id="fb-bulk-trim"[^>]*>.*?<\/button>/);
  assert.ok(btn, 'fb-bulk-trim button must exist');
  assert.match(btn[0], /Audio cutter/i, 'label renamed to "Audio cutter"');
  assert.match(btn[0], /single selected audio file/i, 'title clarifies the single-file scope');
  assert.doesNotMatch(btn[0], />\s*✂\s*Trim\s*</, 'old misleading "Trim" label must be gone');
});
