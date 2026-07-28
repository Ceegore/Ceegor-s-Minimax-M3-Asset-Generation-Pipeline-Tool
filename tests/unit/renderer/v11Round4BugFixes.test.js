// tests/unit/renderer/v11Round4BugFixes.test.js
// ============================================================================
// v1.1 round-4 regression tests. Pins every defect fixed in the final
// "fix all open bugs" pass (M2, M4, L2-L19).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ============================================================================
// M2 (round-2): imageOverlays crop overlay guards Esc mid-decode
// ============================================================================
test('M2 FIX: showCropOverlay guards loadImageFromFile resolve/reject after Esc', () => {
  const s = src('renderer/overlays/imageOverlays.js');
  assert.ok(s.includes('let closed = false'),
    'showCropOverlay must track a `closed` flag so the loadImageFromFile .then is a no-op when Esc was pressed mid-decode');
  assert.ok(/close = \(\) => \{ closed = true; origClose\(\); \}/.test(s),
    'the close function must set closed=true before calling the original close');
  assert.ok(/if \(closed\) return;/.test(s),
    'the .then callback must early-return when closed (so it does not mutate a detached modal)');
  assert.ok(/if \(closed\) return;[^]*origClose\(\)/.test(s),
    'the .catch callback must also early-return when closed (so it does not double-close)');
});

// ============================================================================
// M4 (round-2): fileBrowser1.refreshBrowser serialises concurrent calls
// ============================================================================
test('M4 FIX: refreshBrowser has an in-flight guard + pending follow-up', () => {
  const s = src('renderer/services/fileBrowser1.js');
  assert.ok(s.includes('let _refreshInFlight = null'),
    'refreshBrowser must declare an in-flight promise slot');
  assert.ok(s.includes('let _refreshPending = false'),
    'refreshBrowser must declare a pending flag for the follow-up');
  assert.ok(/if \(_refreshInFlight\) \{[\s\S]*?_refreshPending = true/.test(s),
    'a concurrent caller must set _refreshPending and await the in-flight refresh');
  assert.ok(/_refreshPending = false;\s*_refreshInFlight = \(async/.test(s),
    'the primary caller must clear _refreshPending before starting the real refresh');
  assert.ok(/try \{ await _refreshInFlight; \} finally \{ _refreshInFlight = null; \}/.test(s),
    'the in-flight slot must be cleared in a finally block');
});



// ============================================================================
// L4: imageOptimizer does not pass quality to PNG
// ============================================================================
test('L4 FIX: imageOptimizer PNG branch omits quality', () => {
  const s = src('src/imageOptimizer.js');
  // v1.1 changed the PNG case to build a pngOpts object (without
  // quality) then pass it as a variable. We verify the pngOpts
  // object does NOT contain `quality`.
  const pngOptsMatch = s.match(/const pngOpts = \{([\s\S]*?)\}/);
  assert.ok(pngOptsMatch, 'PNG case must build a pngOpts object');
  assert.ok(!pngOptsMatch[1].includes('quality'),
    'pngOpts must NOT include quality (sharp silently ignores it for lossless PNG)');
});

// ============================================================================
// L5: realesrgan.js legacy opts.gpu only fires when opts.gpuId is undefined
// ============================================================================
test('L5 FIX: realesrgan legacy gpu branch only fires when gpuId is undefined', () => {
  const s = src('src/realesrgan.js');
  assert.ok(s.includes("opts.gpuId === undefined && opts.gpu !== undefined"),
    'the legacy opts.gpu branch must be gated on opts.gpuId === undefined so a user-explicit "auto" is respected');
});

// ============================================================================
// L7: fileBrowser2b preserves scroll position during polling re-renders
// ============================================================================
test('L7 FIX: fileBrowser2b polling preserves scroll position', () => {
  const s = src('renderer/services/fileBrowser2b.js');
  assert.ok(s.includes('savedScroll'),
    'the polling tick must capture the scroll position before renderFbList');
  assert.ok(/ul\.scrollTop = Math\.min\(savedScroll/.test(s),
    'the polling tick must restore scrollTop after the re-render (clamped to scrollHeight)');
});

// ============================================================================
// L8: fileBrowser2b startGenPolling has a _genPollActive flag
// ============================================================================
test('L8 FIX: startGenPolling has a _genPollActive flag', () => {
  const s = src('renderer/services/fileBrowser2b.js');
  assert.ok(s.includes('let _genPollActive = false'),
    'fileBrowser2b must declare a _genPollActive flag (the _genPollTimer guard failed during the await window)');
  assert.ok(s.includes('if (_genPollActive) return;'),
    'startGenPolling must early-return when _genPollActive is true');
  assert.ok(s.includes('_genPollActive = true;'),
    'startGenPolling must set _genPollActive = true before the first tick');
  assert.ok(/stopGenPolling[\s\S]*?_genPollActive = false/.test(s),
    'stopGenPolling must clear _genPollActive');
});

// ============================================================================
// L9: fbSelectAll only selects visible items
// ============================================================================
test('L9 FIX: fbSelectAll only selects visible items', () => {
  const s = src('renderer/services/fileBrowser1.js');
  assert.ok(s.includes('const visibleItems = state._fbItems.filter((it) => isItemVisibleInList(it))'),
    'fbSelectAll must filter state._fbItems through isItemVisibleInList so hidden items are not pre-checked');
});

// ============================================================================
// L10: parentDir preserves UNC prefix + drive roots + handles trailing slashes
// ============================================================================
test('L10 FIX: parentDir handles UNC + trailing slashes + drive roots', () => {
  const s = src('renderer/utils/pureFuncs.js');
  assert.ok(s.includes('isUNC'),
    'parentDir must detect UNC paths (leading \\\\) so the prefix is preserved');
  assert.ok(s.includes('replace(/[\\\\/]+$/,'),
    'parentDir must strip trailing slashes before splitting (so "C:\\out\\" → "C:" not "C:\\out")');
  // Behavioural checks via direct evaluation of the extracted function.
  const m = s.match(/function parentDir\(p\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'parentDir must be defined');
  // eslint-disable-next-line no-new-func
  const parentDir = new Function(m[0] + '; return parentDir;')();
  assert.equal(parentDir('C:\\Users\\Test'), 'C:\\Users', 'Windows drive path');
  assert.equal(parentDir('C:\\Users\\Test\\'), 'C:\\Users', 'trailing slash stripped');
  assert.equal(parentDir('C:\\'), '', 'drive root → empty (parent of root is root)');
  assert.equal(parentDir('\\\\server\\share\\dir'), '\\\\server\\share', 'UNC path preserves \\\\ prefix');
  assert.equal(parentDir('/home/user/docs'), '/home/user', 'POSIX path');
  assert.equal(parentDir('/'), '', 'POSIX root → empty');
});

// ============================================================================
// L11: PowerShellSpawner.expandArchive has a timeout + SIGKILL escalation
// ============================================================================
test('L11 FIX: PowerShellSpawner.expandArchive has a 5-min timeout', () => {
  const s = src('main/utils/PowerShellSpawner.js');
  assert.ok(s.includes('5 * 60 * 1000'),
    'expandArchive must arm a 5-minute timeout');
  assert.ok(/setTimeout\([\s\S]{0,200}?ps\.kill/.test(s),
    'the timeout must kill the proc');
  assert.ok(s.includes('SIGKILL'),
    'the timeout must escalate to SIGKILL after 2s');
  assert.ok(/ps\.on\('close'[\s\S]{0,200}clearTimeout\(killTimer\)/.test(s),
    "the 'close' handler must clearTimeout");
});

// ============================================================================
// L12: InstallDownloadService uses a staging dir for extraction
// ============================================================================
test('L12 FIX: InstallDownloadService extracts to a staging dir then moves', () => {
  const s = src('main/services/InstallDownloadService.js');
  assert.ok(s.includes('stageDir'),
    'InstallDownloadService must extract into a staging dir (not bin/ directly)');
  assert.ok(s.includes('moveDir'),
    'the staging dir must be moved into bin/ after extraction');
  assert.ok(/finally \{[\s\S]*?fs\.rmSync\(stageDir/.test(s),
    'the staging dir must be cleaned up in a finally block (success or failure)');
});

// ============================================================================
// L13: mmx.js cancel uses SIGKILL escalation
// ============================================================================
test('L13 FIX: mmx.js cancel uses SIGKILL escalation', () => {
  const s = src('src/mmx.js');
  assert.ok(s.includes('_killWithEscalation'),
    'mmx.js must define a _killWithEscalation helper');
  assert.ok(/_killWithEscalation[\s\S]{0,300}?SIGTERM[\s\S]{0,300}?SIGKILL/.test(s),
    '_killWithEscalation must send SIGTERM then SIGKILL after 2s');
  assert.ok(/cancelOne[\s\S]{0,200}?_killWithEscalation/.test(s),
    'cancelOne must use _killWithEscalation');
  assert.ok(/cancelAll[\s\S]{0,200}?_killWithEscalation/.test(s),
    'cancelAll must use _killWithEscalation');
});

// ============================================================================
// L14: mmx.js routes the API key through ~/.mmx/config.json instead of argv
// ============================================================================
test('L14 FIX: mmx.js syncs the API key to ~/.mmx/config.json + drops argv on success', () => {
  // v1.1 (lint-size split + BUG-N4 fix): the API-key sync was
  // extracted to src/mmxApiKeySync.js so mmx.js stays under
  // the 500-line HARD limit AND so the sync can track the
  // file's mtime+size (the BUG-N4 fix for "external `mmx
  // config set` not detected" — the inline version in mmx.js
  // did not have room for the stat tracking). The mmx.js
  // caller now imports the helper; the L14 fix itself is
  // unchanged in behaviour.
  const s = src('src/mmx.js');
  const sync = src('src/mmxApiKeySync.js');
  assert.ok(sync.includes('syncApiKeyToMmxCliConfig'),
    'mmxApiKeySync.js must export syncApiKeyToMmxCliConfig');
  assert.ok(sync.includes('.mmx'),
    'the sync must target the ~/.mmx directory');
  assert.ok(sync.includes('config.json'),
    'the sync must write to config.json');
  assert.ok(s.includes('mmxApiKeySync'),
    'mmx.js must import the sync helper from mmxApiKeySync');
  // H7-013/022: the --api-key argv is STILL only a fallback when the sync
  // fails, but it now lives inside an `else` of the sessionOnly branch and
  // sets keyInArgv so the returned argv can be redacted. Assert the fallback
  // condition + the keyInArgv marker.
  assert.ok(/keySyncedToConfig = _syncApiKeyToMmxCliConfig\(apiKey\)/.test(s),
    'the sync must be attempted for the persistent (non-session-only) path');
  assert.ok(/if \(!keySyncedToConfig\) \{[\s\S]*?fullArgs\.push\('--api-key'/.test(s),
    'the --api-key argv must only be used as a FALLBACK when the sync failed');
  assert.ok(/sessionOnly[\s\S]*?MMX_API_KEY/.test(s),
    'session-only mode must route the key via an ephemeral env var, not disk (H7-022)');
  assert.ok(/redactedArgs/.test(s),
    'the returned argv must be redacted so the key never reaches the renderer (H7-013)');
  assert.ok(sync.includes('chmod'),
    'the synced config file must get restrictive permissions (chmod 0o600)');
});

// ============================================================================
// L15: mmx.js duplicate jobId kills the orphan
// ============================================================================
test('L15 FIX: mmx.js duplicate jobId kills the orphan proc', () => {
  const s = src('src/mmx.js');
  assert.ok(s.includes('priorProc'),
    'mmx.js must check for a prior proc with the same jobId');
  assert.ok(/priorProc && priorProc !== proc[\s\S]{0,100}?_killWithEscalation/.test(s),
    'a duplicate jobId must kill the orphan proc before overwriting the map entry');
});

// ============================================================================
// L16: mmx.js error envelopes include command + argv
// ============================================================================
test('L16 FIX: mmx.js error envelopes include command + argv', () => {
  const s = src('src/mmx.js');
  // Every resolveP on an error path must include command + argv.
  const errorResolves = s.match(/resolveP\(\{ ok: false[\s\S]*?\}\)/g) || [];
  assert.ok(errorResolves.length >= 4,
    `mmx.js must have at least 4 error-path resolves (found ${errorResolves.length})`);
  for (const r of errorResolves) {
    assert.ok(r.includes('command'),
      `error resolve must include command: ${r.slice(0, 80)}...`);
    assert.ok(r.includes('argv'),
      `error resolve must include argv: ${r.slice(0, 80)}...`);
  }
});

// ============================================================================
// L17: CropFrameDrag cleans up document listeners on Esc mid-drag
// ============================================================================
test('L17 FIX: CropFrameDrag removes document listeners on Esc mid-drag', () => {
  const s = src('renderer/components/CropFrameDrag.js');
  assert.ok(s.includes('onEscDuringDrag'),
    'CropFrameDrag must define an onEscDuringDrag handler');
  assert.ok(s.includes("e.key === 'Escape'"),
    'the handler must check for Escape key');
  assert.ok(/function onUp\(\)[\s\S]{0,500}removeEventListener\('keydown', onEscDuringDrag\)/.test(s),
    'onUp must remove the keydown listener (cleanup)');
  assert.ok(s.includes("addEventListener('keydown', onEscDuringDrag)"),
    'onDown must add the keydown listener for Esc-during-drag cleanup');
});

// ============================================================================
// L18: SplitterDrag has finite upper bounds (not Infinity)
// ============================================================================
test('L18 FIX: SplitterDrag has finite upper bounds', () => {
  const s = src('renderer/components/SplitterDrag.js');
  const noComments = s.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!noComments.includes('Infinity'),
    'SplitterDrag MAX must NOT contain Infinity (was Infinity for all three pre-v1.1)');
  assert.ok(s.includes('3840') && s.includes('2160'),
    'SplitterDrag MAX must be finite (3840 for sidebar/preview, 2160 for logbar)');
});

// ============================================================================
// L19: SplitterDrag mousedown checks e.button === 0
// ============================================================================
test('L19 FIX: SplitterDrag mousedown checks e.button === 0', () => {
  const s = src('renderer/components/SplitterDrag.js');
  assert.ok(s.includes('e.button !== 0'),
    'SplitterDrag mousedown must reject non-primary buttons (right-click no longer starts a drag)');
});
