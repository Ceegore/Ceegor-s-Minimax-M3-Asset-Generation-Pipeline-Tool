// tests/unit/renderer/v11Round3BugFixes.test.js
// ============================================================================
// v1.1 round-3 regression tests. Pins every defect fixed in the second-pass
// audit so a future regression is caught immediately.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ============================================================================
// H2 + H3 — mmx.js has a timeout + bounded stdout/stderr buffers
// ============================================================================
test('H2 FIX: mmx.js runMmx has a 30-min timeout that SIGKILLs the child', () => {
  const s = src('src/mmx.js');
  assert.ok(s.includes('TIMEOUT_MS'),
    'mmx.js runMmx must declare a TIMEOUT_MS');
  assert.ok(/setTimeout\([\s\S]{0,200}?proc\.kill/.test(s),
    'runMmx must arm a setTimeout that kills the proc on timeout');
  assert.ok(/SIGKILL/.test(s),
    'the timeout must escalate to SIGKILL (a child that catches SIGTERM is still reaped)');
  // clearTimeout on every settle path so a normal completion does
  // NOT leave the timer armed.
  assert.ok(/proc\.on\('close'[\s\S]{0,200}clearTimeout\(killTimer\)/.test(s),
    "the 'close' handler must clearTimeout");
  assert.ok(/proc\.on\('error'[\s\S]{0,200}clearTimeout\(killTimer\)/.test(s),
    "the 'error' handler must clearTimeout");
});

test('H3 FIX: mmx.js caps accumulated stdout/stderr', () => {
  // v1.1 (lint-size split): the cap helpers were extracted to
  // src/mmxStreamCaps.js so the main mmx.js file stays under
  // the 500-line HARD limit. The H3 fix itself is still in
  // place — mmx.js still routes every append through the
  // helper, and the helper still emits the truncation marker.
  const s = src('src/mmx.js');
  const caps = src('src/mmxStreamCaps.js');
  assert.ok(caps.includes('MAX_STDOUT_BYTES') && caps.includes('MAX_STDERR_BYTES'),
    'mmxStreamCaps.js must declare MAX_STDOUT_BYTES + MAX_STDERR_BYTES caps');
  assert.ok(caps.includes('[output truncated at'),
    'mmxStreamCaps.js must leave a visible truncation marker so the user knows data was dropped');
  // The router inside mmx.js is preserved — the helper is
  // imported as `makeCappedAppender` and called from a wrapper
  // that every stdout/stderr append goes through.
  assert.ok(s.includes('makeCappedAppender'),
    'mmx.js must import the cap helper from mmxStreamCaps');
});

// ============================================================================
// H4 — fb:write checks base64 string length BEFORE Buffer.from
// ============================================================================
test('H4 FIX: fb:write checks string length before Buffer.from', () => {
  const s = src('main/ipc/registerFileBrowserIpc.js');
  assert.ok(s.includes('MAX_BASE64_CHARS'),
    'fb:write must derive a MAX_BASE64_CHARS ceiling from MAX_WRITE_BYTES');
  // The string-length check must come BEFORE Buffer.from. We verify
  // by checking the source order: the base64-length check appears
  // earlier in the file than the Buffer.from call.
  const lenCheckIdx = s.indexOf('base64Data.length > MAX_BASE64_CHARS');
  const bufFromIdx = s.indexOf("Buffer.from(base64Data, 'base64')");
  assert.ok(lenCheckIdx > 0 && bufFromIdx > 0,
    'both the length check and Buffer.from must be present');
  assert.ok(lenCheckIdx < bufFromIdx,
    'the base64 string-length check must come BEFORE Buffer.from (pre-v1.1 allocated first, allowing OOM)');
});

// ============================================================================
// H5 — InstallDownloadService wires res.on('error') + a download timeout
// ============================================================================
test('H5 FIX: InstallDownloadService handles mid-stream network errors', () => {
  const s = src('main/services/InstallDownloadService.js');
  assert.ok(s.includes("res.on('error'"),
    "InstallDownloadService must wire res.on('error') so a Wi-Fi flap mid-download rejects the promise");
  assert.ok(s.includes('destroy()'),
    'the error handler must destroy both the response and destination streams');
  // A download timeout (so a hung socket with no error also rejects).
  assert.ok(/setTimeout\([\s\S]{0,300}Download timed out/.test(s),
    'InstallDownloadService must arm a download timeout (a hung socket with no error used to hang forever)');
});

// ============================================================================
// H6 — preview pane pauses audio/video before replacing innerHTML
// ============================================================================
test('H6 FIX: fileBrowser2a exposes _stopPreviewMedia + every preview entry calls it', () => {
  const a = src('renderer/services/fileBrowser2a.js');
  assert.ok(a.includes('function _stopPreviewMedia'),
    'fileBrowser2a must define _stopPreviewMedia');
  assert.ok(a.includes("window._stopPreviewMedia = _stopPreviewMedia"),
    'the helper must be exposed on window so fileBrowser2b can reuse it');
  assert.ok(/previewImageFromFile[\s\S]{0,400}?_stopPreviewMedia\(\)/.test(a),
    'previewImageFromFile must call _stopPreviewMedia before replacing the pane');
  assert.ok(/previewImagesFromFiles[\s\S]{0,400}?_stopPreviewMedia\(\)/.test(a),
    'previewImagesFromFiles must call _stopPreviewMedia before replacing the pane');
  const b = src('renderer/services/fileBrowser2b.js');
  // Audio + video previews in fileBrowser2b must also call it.
  const audioStop = b.match(/previewAudioFromFile[\s\S]{0,600}?_stopPreviewMedia/);
  const videoStop = b.match(/previewVideoFromFile[\s\S]{0,600}?_stopPreviewMedia/);
  assert.ok(audioStop, 'fileBrowser2b previewAudioFromFile must call _stopPreviewMedia');
  assert.ok(videoStop, 'fileBrowser2b previewVideoFromFile must call _stopPreviewMedia');
});

// ============================================================================
// H7 — ParamRow number-kind: typed value flows through (no OK button).
// v1.1.17 (reported by user): the OK button was removed because it
// actively rewrote the user's typed value to the dropdown's max (e.g.
// typed 10 with max 4 → silently clamped to 4) without surfacing a
// clear toast, making the user think their value was accepted. The
// user's request: "The OK buttons are not needed actually, as long as
// the tool reads the typed values after starting generation." The new
// behaviour is the typed value IS the effective value at Generate time;
// the preflight validateValues() and the mmx CLI both reject unknown
// values with a clear error.
// ============================================================================
test('H7 FIX: ParamRow number-kind no longer clamps typed value via OK button', () => {
  const s = src('renderer/components/ParamRow.js');
  // The OK button is gone — no numOkBtn, no addEventListener('click' …)
  // that does validation/clamping. The wrapper still exists so the
  // 50/50 CSS layout (combo-select-number + number-custom-active)
  // continues to work, but only the dropdown + text input live in it.
  assert.ok(!/numOkBtn\s*=\s*el\(/.test(s),
    "H7 FIX: number-kind must NOT create an OK button (user reported it silently clamps typed values to def.max)");
  // The min/max CSS hint on the inner <input type="number"> is
  // still set so the browser can show the up/down spinners' valid
  // range, but we never actively rewrite num.value on blur or
  // change. The typed text stays as the user left it.
  assert.ok(/type:\s*['"]number['"][\s\S]{0,200}?max:\s*def\.max/.test(s),
    'H7 FIX: number-kind inner input must still advertise max: def.max as a hint to the browser (visual only — we no longer clamp on it)');
});

test('H8 FIX: attachImageDimGuards also listens on the inner custom-number input', () => {
  const s = src('renderer/components/ParamRow.js');
  assert.ok(s.includes(".number-custom-input"),
    'attachImageDimGuards must look up the inner .number-custom-input element');
  assert.ok(/inner\.addEventListener\('input', recheck\)/.test(s),
    "attachImageDimGuards must add an 'input' listener on the inner input so typing a custom W/H fires the warning live (no OK button to gate it)");
});

// ============================================================================
// M1 (music) — --bitrate gated for lossless formats (mirrors speech M4 fix)
// ============================================================================
test('M1(music) FIX: musicTab gates --bitrate for lossless formats', () => {
  const s = src('renderer/tabs/musicTab.js');
  // The unconditional appendFlag must be gone for the bitrate row.
  // We strip comments so this test's own explanation does not trip it.
  const noComments = s.replace(/^\s*\/\/.*$/gm, '');
  // The pre-v1.1 line was: appendFlag(args, bitrate.input);
  // followed immediately by appendBoolFlag(args, watermark...). Both
  // must NOT be adjacent in executable code anymore.
  assert.ok(!/appendFlag\(args, bitrate\.input\);\s*\n\s*appendBoolFlag\(args, watermark/.test(noComments),
    'musicTab must NOT unconditionally appendFlag the bitrate row (pre-v1.1 sent --bitrate even for wav/pcm)');
  // The new gated form must be present.
  assert.ok(/if \(\['mp3'\]\.includes\(fmt\)\) appendFlag\(args, bitrate\.input\)/.test(s),
    'musicTab must gate appendFlag(bitrate) on the lossy-format check');
});

// ============================================================================
// M3 — imageOverlays guard + invoke the SAME function (no mismatch)
// ============================================================================
test('M3 FIX: imageOverlays guard tests the same function it invokes', () => {
  const s = src('renderer/overlays/imageOverlays.js');
  // The mismatched pattern must be gone: testing updatePreviewPane
  // but calling previewImageFromFile.
  const noComments = s.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!noComments.includes("typeof updatePreviewPane === 'function'"),
    'imageOverlays must NOT test typeof updatePreviewPane (the function it actually calls is previewImageFromFile)');
  assert.ok(noComments.includes("typeof previewImageFromFile === 'function'"),
    'imageOverlays must test typeof previewImageFromFile (the function it actually invokes)');
});

// ============================================================================
// M5 — JobSummary treats unknown status as err AND records a reason,
// AND guards against non-string r.error
// ============================================================================
test('M5 FIX: JobSummary records unknown status + guards non-string error', () => {
  const s = src('renderer/jobs/JobSummary.js');
  assert.ok(s.includes('unknown++') || s.includes("failureReasons.set('(unknown status)'"),
    'JobSummary must record an "(unknown status)" entry for results with status outside {ok,warn,cancel,err}');
  assert.ok(s.includes('typeof r.error === \'string\''),
    'JobSummary must guard against non-string r.error (pre-v1.1 threw TypeError, losing the whole summary)');
});

// ============================================================================
// M9 — thumbnail click no longer uses { once: true }
// ============================================================================
test('M9 FIX: thumbnail click listener is re-clickable', () => {
  const s = src('renderer/services/fileBrowser2a.js');
  // The { once: true } literal must be gone from the click binding.
  const noComments = s.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!noComments.includes("addEventListener('click', open, { once: true })"),
    'thumbnail click listener must NOT use { once: true } (made the thumb unclickable after first click)');
  assert.ok(noComments.includes("addEventListener('click', open)"),
    'thumbnail click listener must use the plain form so the user can re-open the same thumb');
});

// ============================================================================
// M11 — showConvertOverlay handles extension-less source paths
// ============================================================================
test('M11 FIX: showConvertOverlay handles extension-less source paths', () => {
  const s = src('renderer/overlays/imageOverlays.js');
  // The pre-v1.1 split('.').pop() returned the whole filename for
  // extension-less paths. The fix uses a path-aware extraction.
  // Strip comments so this regression-test's own explanation (which
  // mentions the old buggy pattern) does not trip the check.
  const noComments = s.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/srcPath\.split\(['"]\.['"]\)\.pop\(\)/.test(noComments),
    "showConvertOverlay must NOT use split('.').pop() in executable code (returns whole filename for extension-less paths)");
  assert.ok(s.includes('lastIndexOf') && s.includes('hasExt'),
    'showConvertOverlay must use path-aware extension extraction');
});

// ============================================================================
// M13 — mmx path validator supports --flag=value form AND validates cwd
// R1.5b.1: replaced the legacy `findInvalidMmxPath` + `validateMmxCwd`
// gate with a grant-based authorisation. The path-flag collector +
// the grant-based path authoriser were extracted to a separate
// file (`main/ipc/mmxPathAuthz.js`) to keep the IPC file under
// its frozen 384-line lint budget. The split-on-'=' form is
// preserved in `collectMmxPathFlags`; the cwd check is folded
// into the grant authorisation (operation:'mkdir' on the cwd).
// The test is rewritten to assert the new contract: the helper
// that walks the args splits on '=', and mmx:run:job authorises
// the cwd via the grant helper before forwarding to runMmx.
// ============================================================================
test('M13 FIX: mmx validator supports --flag=value form + validates cwd', () => {
  // R1.5b.1: the path-flag collector + the authoriser are now in
  // `mmxPathAuthz.js`. The IPC file (`registerMmxIpc.js`) imports
  // them.
  const sMmxPath = src('main/ipc/mmxPathAuthz.js');
  const sIpc = src('main/ipc/registerMmxIpc.js');
  // The path-flag collector must split args on '=' to catch the
  // --flag=value form (the single-token variant).
  assert.ok(sMmxPath.includes("indexOf('=')"),
    'collectMmxPathFlags must split args on = to catch the --flag=value form');
  // The authoriser uses grantAuthorizer for the actual check
  // (path.authorize delegates to PathGrantService.defaultService).
  assert.ok(sMmxPath.includes("require('./grantAuthorizer')"),
    'mmxPathAuthz must import the shared grantAuthorizer helper');
  // The cwd check is folded into the authoriser (operation:'mkdir').
  assert.ok(sMmxPath.includes("'mkdir'"),
    'authorizeMmxPaths must use operation "mkdir" for the cwd check');
  // The IPC file imports the extracted helpers + calls them
  // between the mmx:run:job opening and the runMmx() call.
  assert.ok(sIpc.includes("require('./mmxPathAuthz')"),
    'registerMmxIpc must import the shared mmxPathAuthz helper (R1.5b.1)');
  assert.ok(/mmx:run:job[\s\S]{0,3000}?_authorizeMmxPaths/.test(sIpc),
    'mmx:run:job must call _authorizeMmxPaths (which authorises the cwd via grantAuthorizer) before forwarding to runMmx');
});

// ============================================================================
// M7 — fb:move EXDEV fallback (cross-device rename)
// ============================================================================
test('M7 FIX: fileBrowser.moveTo falls back to copy+delete on EXDEV', () => {
  const s = src('src/fileBrowser.js');
  assert.ok(s.includes("'EXDEV'"),
    'moveTo must check for EXDEV (cross-device link error)');
  assert.ok(/EXDEV[\s\S]{0,300}?fs\.cp/.test(s),
    'on EXDEV, moveTo must fall back to fs.cp (copy) so cross-drive moves work');
  assert.ok(/EXDEV[\s\S]{0,500}?fs\.rm/.test(s),
    'on EXDEV, moveTo must remove the source after the copy (completing the move semantics)');
});

// ============================================================================
// M10 — previewImagesFromFiles clears _lastPreviewPath on grid show
// ============================================================================
test('M10 FIX: previewImagesFromFiles clears _lastPreviewPath', () => {
  const s = src('renderer/services/fileBrowser2a.js');
  assert.ok(/previewImagesFromFiles[\s\S]{0,2000}?state\._lastPreviewPath = null/.test(s),
    'previewImagesFromFiles must reset state._lastPreviewPath on grid show so the early-return cache in previewImageFromFile does not silently no-op a later single-click');
});
