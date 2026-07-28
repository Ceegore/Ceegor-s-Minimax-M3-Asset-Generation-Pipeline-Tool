// tests/unit/kgo6Fixes.test.js
// ============================================================================
// KGO6 (QA Run 13) regression suite — one test per fix so a revert of any
// KGO6 change fails loudly here. Behavioral tests where the module is
// loadable in plain Node (src/, renderer services via mock window, vm
// extraction for app.js); source-integrity checks for renderer/main files
// that only run inside Electron (same pattern as kgo2AndCpuFixes.test.js).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// KGO6-001 — asyncConfirm dedup deadlock: the static `id: 'async-confirm'`
// dedup key must stay removed (a second concurrent confirm deadlocked).
// ---------------------------------------------------------------------------
test('KGO6-001: section19_Modal asyncConfirm has no static dedup id', () => {
  const src = read('renderer/sections/section19_Modal.js');
  // Strip line comments (the KGO6-001 rationale comment cites the removed key).
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/id:\s*['"]async-confirm['"]/.test(code),
    'the static async-confirm dedup id must not return (deadlocks concurrent confirms)');
  assert.ok(src.includes('KGO6-001'), 'the KGO6-001 rationale comment must remain');
});

// ---------------------------------------------------------------------------
// KGO6-002 — inpaint:runOnnx must write the mask to disk before invoking the
// worker (inpaint_node.js checks fs.existsSync(mask)), and must validate
// maskB64 BEFORE the write so a missing mask yields a clean envelope.
// ---------------------------------------------------------------------------
test('KGO6-002: registerInpaintOnnxIpc writes the mask file before runOnnx', () => {
  const src = read('main/ipc/registerInpaintOnnxIpc.js');
  const validateIdx = src.indexOf('A mask (base64 PNG) is required.');
  // KGO8-009 moved the base64 decode one statement earlier (the mask/source
  // dimension check needs the buffer), so the write is now `writeFile(maskPath,
  // maskBuf)`. Match either shape — the invariant under test is the ORDER.
  const writeIdx = Math.max(
    src.indexOf("writeFile(maskPath, Buffer.from(args.maskB64, 'base64'))"),
    src.indexOf('writeFile(maskPath, maskBuf)'),
  );
  const runIdx = src.indexOf('inpaint.runOnnx(srcPath, maskPath');
  assert.ok(validateIdx > -1, 'maskB64 validation must exist');
  assert.ok(writeIdx > -1, 'the mask temp-file write must exist (KGO6-002)');
  assert.ok(runIdx > -1, 'runOnnx call must exist');
  assert.ok(validateIdx < writeIdx && writeIdx < runIdx,
    'order must be: validate maskB64 → write mask → runOnnx');
});

// ---------------------------------------------------------------------------
// KGO6-004 — file-browser revert must not fall through to the rollback block
// (which wiped fbDirs/fbDir and undid the revert).
// ---------------------------------------------------------------------------
test('KGO6-004: fileBrowser1 explicit-nav revert does not fall through to rollback', () => {
  const src = read('renderer/services/fileBrowser1.js');
  const branchStart = src.indexOf('if (_explicitNav) {');
  assert.ok(branchStart > -1, 'the _explicitNav branch must exist');
  const after = src.slice(branchStart, branchStart + 1400);
  assert.ok(after.includes('KGO6-004'), 'the KGO6-004 stop-here marker must remain');
  assert.ok(/\}\s*else\s*\{/.test(after),
    'rollback must live in an else-branch (no fall-through after the revert)');
});

// ---------------------------------------------------------------------------
// KGO6-005 — worker process priority: all 4 spawn sites must use the named
// os constant (the old raw value silently no-oped on Windows).
// ---------------------------------------------------------------------------
test('KGO6-005: all 4 spawn sites lower priority via PRIORITY_BELOW_NORMAL', () => {
  const sites = [
    ['src/realesrgan.js', 1],
    ['src/inpaint/index.js', 1],
    ['src/isnetbg.js', 2],
  ];
  for (const [rel, expected] of sites) {
    const src = read(rel);
    const count = (src.match(/os\.constants\.priority\.PRIORITY_BELOW_NORMAL|_os\.constants\.priority\.PRIORITY_BELOW_NORMAL/g) || []).length;
    assert.equal(count, expected, `${rel}: expected ${expected} PRIORITY_BELOW_NORMAL site(s), got ${count}`);
  }
});

// ---------------------------------------------------------------------------
// KGO6-006 — ok:true envelopes with warnings[] must surface a warn toast.
// Behavioral: run the real handleIpcResult in a vm with a captured toast.
// ---------------------------------------------------------------------------
test('KGO6-006: assertIpcOk surfaces warnings[] as warn toasts', () => {
  const src = read('renderer/utils/ipcResult.js');
  const toasts = [];
  const ctx = vm.createContext({
    window: {},
    toast: (msg, kind, ms) => toasts.push({ msg, kind, ms }),
  });
  vm.runInContext(src, ctx);
  const handle = ctx.window.assertIpcOk;
  assert.equal(typeof handle, 'function', 'assertIpcOk must be defined');
  const ok = handle({ ok: true, warnings: ['partial clear failed'] }, 'Privacy');
  assert.equal(ok, true, 'ok:true result must still return true');
  assert.equal(toasts.length, 1, 'exactly one warn toast for one warning');
  assert.equal(toasts[0].kind, 'warn');
  assert.ok(toasts[0].msg.includes('partial clear failed'));
  // No warnings → no toast.
  toasts.length = 0;
  handle({ ok: true }, 'Privacy');
  assert.equal(toasts.length, 0, 'no toast without warnings');
});

// ---------------------------------------------------------------------------
// KGO6-007 — resize-panel refresh must resolve the modal via ctrl.modal
// (document.querySelector broke with stacked/duplicate modals).
// ---------------------------------------------------------------------------
test('KGO6-007: imageEditorOverlay refreshDims lookups go through ctrl.modal', () => {
  const src = read('renderer/overlays/imageEditorOverlay.js');
  assert.ok(src.includes('ctrl.modal = m'), 'ctrl.modal must be assigned at modal creation');
  const sites = src.match(/ctrl\.modal \|\| document\.querySelector\('\.image-editor-modal'\)/g) || [];
  assert.equal(sites.length, 2, 'both refreshDims sites (slot switch + base decode) must prefer ctrl.modal');
});

// ---------------------------------------------------------------------------
// KGO6-008 — over-cap resize dims: envelope reports clamped/requested* and
// the renderer toasts. Behavioral on the real src/imageResize.js with sharp.
// ---------------------------------------------------------------------------
test('KGO6-008: resize over the 65500 cap reports clamped + requested dims', async () => {
  const { sharp, ensureSharp } = require(path.join(ROOT, 'src/imageOptimizer/formatUtils'));
  assert.equal(ensureSharp(), null, 'sharp must load');
  const os = require('os');
  const fsp = fs.promises;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kgo6-rz-'));
  try {
    const src = path.join(dir, 'in.png');
    await fsp.writeFile(src, await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer());
    const imageResize = require(path.join(ROOT, 'src/imageResize'));
    const r = await imageResize.resize(src, { width: 70000, height: 4, outputPath: path.join(dir, 'out.png') });
    assert.equal(r.ok, true, 'over-cap width must still succeed (clamped): ' + (r.error || ''));
    assert.equal(r.width, 65500, 'width must clamp to the libvips cap');
    assert.equal(r.clamped, true, 'envelope must flag the clamp');
    assert.equal(r.requestedWidth, 70000, 'envelope must echo the requested width');
    assert.equal(r.requestedHeight, 4, 'envelope must echo the requested height');
    // In-range dims must NOT be flagged.
    const r2 = await imageResize.resize(src, { width: 16, height: 8, outputPath: path.join(dir, 'out2.png') });
    assert.equal(r2.ok, true);
    assert.equal(r2.clamped, false, 'in-range resize must not be flagged clamped');
  } finally {
    for (let i = 0; i < 8; i++) {
      try { await fsp.rm(dir, { recursive: true, force: true }); break; }
      catch (_) { await new Promise((res) => setTimeout(res, 300)); }
    }
  }
  // KGO7-020: the clamp notice is attached to `warnings[]` behind the IPC
  // boundary and toasted centrally, so ALL SIX resizeImage call sites
  // report it — not just section08Helpers (which was the only reader of
  // the bare `clamped` flag).
  const ipcSrc = read('main/ipc/registerImageIpc.js');
  assert.ok(/r\.clamped/.test(ipcSrc) && /Dimensions clamped/.test(ipcSrc),
    'image:resize must attach the clamp notice to warnings[]');
  const ipcResult = read('renderer/utils/ipcResult.js');
  assert.ok(/function reportIpcWarnings/.test(ipcResult),
    'ipcResult must expose one shared warning reporter');
  // KGO7-020: every direct resizeImage call site reports explicitly.
  // Wrapping window.api does NOT work — contextBridge objects are frozen,
  // so the assignment fails silently (measured __autoWarnWrapped=false).
  // The per-call-site count check lives in tests/unit/kgo7Fixes.test.js.
  assert.ok(/reportIpcWarnings/.test(read('renderer/sections/section08Helpers.js')),
    'the resize helper must report the clamp notice');
});

// ---------------------------------------------------------------------------
// KGO6-009 / KGO6-010 — what's-new toast: auto-dismiss persists lastSeen
// (onDismiss) and the fresh-install guard reads the real jobsSnapshot field.
// ---------------------------------------------------------------------------
test('KGO6-009/010: whats-new auto-dismiss calls onDismiss; fresh-install guard uses jobsSnapshot', () => {
  const src = read('renderer/sections/section20_Structured_event_log.js');
  const auto = src.slice(src.indexOf('KGO6-009'));
  assert.ok(auto.includes('if (onDismiss) onDismiss()'),
    'the 15s auto-dismiss must call onDismiss (persists lastSeenVersion)');
  assert.ok(src.includes('state.jobsSnapshot'), 'fresh-install guard must read jobsSnapshot');
  assert.ok(!src.includes('state.jobsArchive'), 'the phantom state.jobsArchive read must stay gone');
});

// ---------------------------------------------------------------------------
// KGO6-011 — fbExists consumers must distinguish grant/IPC errors from a
// genuinely missing file (both overlays).
// ---------------------------------------------------------------------------
test('KGO6-011: convert + optimize overlays split grant errors from missing files', () => {
  for (const rel of ['renderer/overlays/imageOverlays.js', 'renderer/overlays/imageOptimizeOverlay.js']) {
    const src = read(rel);
    assert.ok(src.includes('!exists || !exists.ok'), `${rel}: must check the envelope ok first`);
    assert.ok(src.includes('!exists.exists'), `${rel}: must check exists.exists separately`);
    assert.ok(src.includes('Source file not found'), `${rel}: missing-file path keeps its message`);
  }
});

// ---------------------------------------------------------------------------
// KGO6-012 — quota classifier: "usage limit" phrasings must classify as
// 'rate' (retryable), not 'quota' (permanent). Behavioral via vm extraction
// of the real classifyMmxError (same loader as mmxErrorClassify.test.js).
// ---------------------------------------------------------------------------
test('KGO6-012: classifyMmxError no longer tags usage-limit messages as quota', () => {
  const { extractFnSrc } = require(path.join(ROOT, 'tests/unit/_fnExtract'));
  const appSrc = read('renderer/app.js');
  const fnSrc = extractFnSrc(appSrc, 'function classifyMmxError(r, msg) {');
  const ctx = vm.createContext({});
  vm.runInContext(`${fnSrc}\nglobalThis.classifyMmxError = classifyMmxError;`, ctx);
  const classify = ctx.classifyMmxError;
  // Rate-limit phrasing: must be retryable 'rate', not permanent 'quota'.
  assert.equal(classify({ stderr: 'usage limit exceeded, retry later' }, 'usage limit exceeded, retry later'), 'rate');
  // Genuine quota phrasings still classify as quota.
  assert.equal(classify({ stderr: 'insufficient balance' }, 'insufficient balance'), 'quota');
  assert.equal(classify({ stderr: 'token plan exhausted' }, 'token plan exhausted'), 'quota');
  assert.equal(classify({ stderr: 'quota exceeded for this billing cycle' }, 'quota exceeded for this billing cycle'), 'quota');
});

// ---------------------------------------------------------------------------
// KGO6-013 — audio cut with only startSec must probe the source duration
// (not default to a ~1ms file). Behavioral with stubbed probe + findBinary.
// ---------------------------------------------------------------------------
test('KGO6-013: cut without endSec probes duration; with endSec it does not', async () => {
  const Module = require('module');
  const metaPath = require.resolve(path.join(ROOT, 'src/audio/AudioMetadata.js'));
  const binPath = require.resolve(path.join(ROOT, 'src/audio/AudioBinary.js'));
  const tcPath = require.resolve(path.join(ROOT, 'src/audio/AudioTrimCut.js'));
  const saved = { meta: require.cache[metaPath], bin: require.cache[binPath], tc: require.cache[tcPath] };
  let probeCalls = 0;
  const stub = (absPath, exportsObj) => {
    const m = new Module(absPath);
    m.filename = absPath; m.loaded = true; m.exports = exportsObj;
    require.cache[absPath] = m;
  };
  try {
    delete require.cache[tcPath];
    stub(metaPath, { probe: async () => { probeCalls++; return { ok: true, duration: 42.5 }; } });
    // findBinary → null makes cut() stop deterministically right after the
    // range computation (no ffmpeg spawn), which is all this test needs.
    stub(binPath, { findBinary: () => null });
    const { cut } = require(tcPath);

    // No endSec → the probe MUST be consulted (pre-fix: 1ms default, 0 calls).
    const r1 = await cut('C:/x/in.wav', 'C:/x/out.wav', { startSec: 5 });
    assert.equal(probeCalls, 1, 'cut without endSec must probe the source duration');
    assert.equal(r1.ok, false);
    assert.equal(r1.error, 'ffmpeg binary not found.', 'must reach the binary stage (range accepted)');

    // KGO8-007 CHANGED THIS CONTRACT, deliberately.
    //
    // This used to assert "explicit endSec → no probe", saving one ffprobe
    // spawn. That optimisation is what let a range entirely past the end of
    // the file through: cut() had no idea how long the source was, so
    // {startSec:10, endSec:12} on a 6 s file returned ok:true with duration 2
    // while ffmpeg wrote a 78-byte WAV that this app's own audioProbe then
    // rejects as corrupt. The range cannot be validated without the duration,
    // so the probe is now unconditional — one ~50 ms ffprobe on an operation
    // that already spawns ffmpeg and writes a file is the right trade.
    probeCalls = 0;
    await cut('C:/x/in.wav', 'C:/x/out.wav', { startSec: 1, endSec: 2 });
    assert.equal(probeCalls, 1,
      'cut must always probe the source so the range can be validated against its real duration (KGO8-007)');

    // Inverted range still rejected (KGO4-010 unchanged).
    const r3 = await cut('C:/x/in.wav', 'C:/x/out.wav', { startSec: 5, endSec: 4 });
    assert.equal(r3.ok, false);
    assert.ok(/must be > startSec/.test(r3.error));

    // Probe failure → graceful fallback, no throw.
    probeCalls = 0;
    stub(metaPath, { probe: async () => { probeCalls++; return { ok: false, error: 'nope' }; } });
    delete require.cache[tcPath];
    const { cut: cut2 } = require(tcPath);
    const r4 = await cut2('C:/x/in.wav', 'C:/x/out.wav', { startSec: 5 });
    assert.equal(probeCalls, 1);
    assert.equal(r4.ok, false, 'fallback path must still return a clean envelope');
  } finally {
    // Restore the real modules for any later test in this process.
    for (const [p, m] of [[metaPath, saved.meta], [binPath, saved.bin], [tcPath, saved.tc]]) {
      if (m) require.cache[p] = m; else delete require.cache[p];
    }
  }
});

// ---------------------------------------------------------------------------
// KGO6-014 — grantCache key canonicalization: identical opts in different
// property order must be ONE cache entry (one mint). Behavioral.
// ---------------------------------------------------------------------------
test('KGO6-014: grantCache dedupes opts objects regardless of key order', async () => {
  const gcPath = require.resolve(path.join(ROOT, 'renderer/services/grantCache.js'));
  delete require.cache[gcPath];
  let mints = 0;
  global.window = { api: { mintGrant: async () => { mints++; return { ok: true, grantId: 'g' + mints }; } } };
  try {
    const { ensurePathGrant, clearPathGrants } = require(gcPath);
    clearPathGrants();
    const a = await ensurePathGrant('C:/img/a.png', 'read', { kind: 'directory', capabilities: ['read', 'write'] });
    const b = await ensurePathGrant('C:/img/a.png', 'read', { capabilities: ['read', 'write'], kind: 'directory' });
    assert.equal(mints, 1, 'reordered-but-identical opts must hit the cache (1 mint)');
    assert.equal(a, b, 'both calls must return the same grantId');
    // Different opts still mint separately.
    await ensurePathGrant('C:/img/a.png', 'read', { kind: 'file', capabilities: ['read'] });
    assert.equal(mints, 2, 'semantically different opts must mint a new grant');
  } finally {
    delete global.window;
    delete require.cache[gcPath];
  }
});

// ---------------------------------------------------------------------------
// KGO6-016 — unknown-model fallback: silent for the normal "no model" path,
// warns for bogus keys, and the IPC envelope reports the substitution.
// ---------------------------------------------------------------------------
test('KGO6-016/KGO7-019: resolveModelKeyEx reports fallbacks and the registry does no I/O', () => {
  const reg = require(path.join(ROOT, 'src/isnetbg/modelRegistry'));
  const { resolveModelKey, resolveModelKeyEx, DEFAULT_MODEL } = reg;
  // KGO7-019: the registry must be a PURE module. The old version wrote
  // the fallback warning to process.stderr, which a packaged Windows GUI
  // app has no console for — the message went nowhere.
  const writes = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    assert.equal(resolveModelKey(undefined), DEFAULT_MODEL);
    assert.equal(resolveModelKey('totally-bogus'), DEFAULT_MODEL);
    assert.equal(writes.length, 0, 'the registry must never write to stderr');
  } finally {
    process.stderr.write = realWrite;
  }
  // The "no model specified" path is NOT a fallback.
  for (const empty of [undefined, null, '']) {
    const r = resolveModelKeyEx(empty);
    assert.equal(r.key, DEFAULT_MODEL);
    assert.equal(r.fellBack, false, `${JSON.stringify(empty)} must not count as a fallback`);
    assert.equal(r.requested, null);
  }
  // A genuinely bogus key IS a fallback and echoes what was asked for.
  const bogus = resolveModelKeyEx('totally-bogus');
  assert.equal(bogus.key, DEFAULT_MODEL);
  assert.equal(bogus.fellBack, true, 'a bogus key must be reported as a fallback');
  assert.equal(bogus.requested, 'totally-bogus');
  // A known key resolves to itself with no fallback.
  const known = resolveModelKeyEx(DEFAULT_MODEL);
  assert.equal(known.key, DEFAULT_MODEL);
  assert.equal(known.fellBack, false);

  // IPC side: the envelope must report the silent substitution.
  const ipcSrc = read('main/ipc/registerIsnetbgIpc.js');
  assert.ok(ipcSrc.includes('result.fellBack = true'), 'isnetbg:run must flag the fallback');
  assert.ok(ipcSrc.includes('result.resolvedModel'), 'isnetbg:run must report the resolved model');
  assert.ok(ipcSrc.includes('result.requestedModel'), 'isnetbg:run must echo the requested model');

  // KGO7-010: and the renderer must actually READ it — a flag with no
  // consumer is the bug this replaced. One shared implementation
  // (Section08Helpers.warnModelFallback), called from all three sites.
  assert.ok(/function warnModelFallback/.test(read('renderer/sections/section08Helpers.js')),
    'the fallback warning must have exactly one implementation');
  const consumers = [
    'renderer/sections/section08_Image_pipeline__Upscale___Crop___Convert_.js',
    'renderer/overlays/imageEditorActions.js',
    'renderer/overlays/imageEditorAssetBg.js',
  ];
  for (const f of consumers) {
    assert.ok(/warnModelFallback/.test(read(f)),
      `${f} must surface the model fallback to the user`);
  }
});

// ---------------------------------------------------------------------------
// KGO6-017 — IPC coverage gate ratchet: threshold must stay ≥ 97.
// ---------------------------------------------------------------------------
test('KGO6-017: test:ipc-coverage threshold is ratcheted to >= 97', () => {
  const pkg = JSON.parse(read('package.json'));
  const m = /--threshold=(\d+)/.exec(pkg.scripts['test:ipc-coverage'] || '');
  assert.ok(m, 'test:ipc-coverage must pass an explicit --threshold');
  assert.ok(Number(m[1]) >= 97, `threshold must not regress below 97 (got ${m[1]})`);
});

// ---------------------------------------------------------------------------
// KGO6 follow-up — every test-harness Electron main must suppress the
// blocking "A JavaScript error occurred in the main process" dialog by
// registering an uncaughtException handler.
// ---------------------------------------------------------------------------
test('KGO6-followup: all 5 harness Electron mains register uncaughtException handlers', () => {
  const harnessMains = [
    'scripts/e2e/ipc-coverage.js',
    'scripts/e2e/run.js',
    'scripts/smoke-renderer.js',
    'scripts/smoke-eval.js',
    'scripts/e2e/packaged-boot.js', // wrapper template
  ];
  for (const rel of harnessMains) {
    const src = read(rel);
    assert.ok(src.includes("process.on('uncaughtException'"),
      `${rel}: must register an uncaughtException handler (Electron pops a blocking dialog otherwise)`);
    assert.ok(src.includes("process.on('unhandledRejection'"),
      `${rel}: must register an unhandledRejection handler`);
  }
});
