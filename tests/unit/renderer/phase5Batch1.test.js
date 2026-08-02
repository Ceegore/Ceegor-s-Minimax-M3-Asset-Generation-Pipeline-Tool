// tests/unit/renderer/phase5Batch1.test.js
// ============================================================================
// Phase 5 batch 1 regression tests:
//   H-026: secureHandle central error catch
//   H-028: sensitive path descendant blocking
//   H-002: video duration enum validation
//   H-013: polling_url origin check
//   H-015: per-fetch timeout combined with caller signal
//   H-017: duplicate provider jobId rejection
//   H-019: Real-ESRGAN runtime timeout + stderr cap
//   H-020: tiny-image scale whitelist
//   H-033: recursive copy force:false explicit
//   H-034: archive trim scan window
//   H-035: UTF-8 chunk boundary (StringDecoder)
//   H-029: fbReveal/fbOpenInExplorer grant passing
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// H-026: secureHandle catches handler errors centrally
// ---------------------------------------------------------------------------
test('H-026: secureHandle catches synchronous handler throws', () => {
  const handlers = new Map();
  require.cache[require.resolve('electron')] = {
    exports: { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) } },
  };
  delete require.cache[require.resolve(path.join(ROOT, 'main', 'ipc', 'secureHandle'))];
  const { secureHandle } = require(path.join(ROOT, 'main', 'ipc', 'secureHandle'));
  secureHandle('test:syncThrow', { getMainWindow: () => null, skipSenderCheck: true }, () => {
    throw new Error('sync boom sk-abc123456789');
  });
  const fn = handlers.get('test:syncThrow');
  const r = fn({ sender: {} }, {});
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('sync boom'));
  assert.ok(!r.error.includes('sk-abc123456789'), 'API key must be redacted');
  assert.ok(r.error.includes('sk-[REDACTED]'));
  assert.equal(r.code, 'HANDLER_ERROR');
});

test('H-026: secureHandle catches async handler rejections', async () => {
  const handlers = new Map();
  require.cache[require.resolve('electron')] = {
    exports: { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) } },
  };
  delete require.cache[require.resolve(path.join(ROOT, 'main', 'ipc', 'secureHandle'))];
  const { secureHandle } = require(path.join(ROOT, 'main', 'ipc', 'secureHandle'));
  secureHandle('test:asyncThrow', { getMainWindow: () => null, skipSenderCheck: true }, async () => {
    throw new Error('async boom Bearer eyJhbGciOi');
  });
  const fn = handlers.get('test:asyncThrow');
  const r = await fn({ sender: {} }, {});
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('async boom'));
  assert.ok(!r.error.includes('eyJhbGciOi'), 'Bearer token must be redacted');
  assert.equal(r.code, 'HANDLER_ERROR');
});

test('H-026: secureHandle passes through sync handler results unchanged', () => {
  const handlers = new Map();
  require.cache[require.resolve('electron')] = {
    exports: { ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) } },
  };
  delete require.cache[require.resolve(path.join(ROOT, 'main', 'ipc', 'secureHandle'))];
  const { secureHandle } = require(path.join(ROOT, 'main', 'ipc', 'secureHandle'));
  secureHandle('test:ok', { getMainWindow: () => null, skipSenderCheck: true }, () => ({ ok: true, data: 42 }));
  const fn = handlers.get('test:ok');
  const r = fn({ sender: {} }, {});
  assert.deepEqual(r, { ok: true, data: 42 });
});

// ---------------------------------------------------------------------------
// H-028: sensitive path descendant blocking
// ---------------------------------------------------------------------------
test('H-028: isSensitiveRoot blocks descendants of credential dirs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'services', 'PathGrantService.js'), 'utf8');
  // Must have DEEP + SELF split
  assert.ok(src.includes('SENSITIVE_DEEP'), 'SENSITIVE_DEEP list must exist');
  assert.ok(src.includes('SENSITIVE_SELF'), 'SENSITIVE_SELF list must exist');
  // Must use path.relative for descendant check
  assert.ok(src.includes('path.relative(root, lower)'), 'descendant check via path.relative');
  // .ssh must be in DEEP (blocks descendants)
  assert.ok(src.includes(".ssh"), '.ssh must be in sensitive list');
});

test('H-028: PathGrantService blocks grants inside .ssh', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'main', 'services', 'PathGrantService'))];
  const { PathGrantService } = require(path.join(ROOT, 'main', 'services', 'PathGrantService'));
  const svc = new PathGrantService({ realpath: (p) => p });
  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (!userProfile) return; // skip on CI without HOME
  const sshPath = path.join(userProfile, '.ssh', 'id_rsa');
  const r = svc.mintFileGrant({
    origin: 'test', purpose: 'test', path: sshPath, capabilities: ['read'],
  });
  assert.equal(r.ok, false, 'grant inside .ssh must be rejected');
  assert.ok(r.error.includes('sensitive'));
});

test('H-028: PathGrantService blocks C:\\Windows\\Temp (descendant of DEEP root)', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'main', 'services', 'PathGrantService'))];
  const { PathGrantService } = require(path.join(ROOT, 'main', 'services', 'PathGrantService'));
  const svc = new PathGrantService({ realpath: (p) => p });
  // Audit acceptance: "C:\Windows\Temp\asset.png" must be blocked.
  const r = svc.mintFileGrant({
    origin: 'test', purpose: 'test', path: 'C:\\Windows\\Temp\\asset.png', capabilities: ['write'],
  });
  assert.equal(r.ok, false, 'grant under C:\\Windows must be rejected (DEEP)');
  assert.ok(r.error.includes('sensitive'));
  // Similarly-named path must NOT be blocked (boundary check).
  const r2 = svc.mintFileGrant({
    origin: 'test', purpose: 'test', path: 'C:\\WindowsBackup\\file.txt', capabilities: ['read'],
  });
  // WindowsBackup is NOT a descendant of C:\Windows (path.relative check).
  // It may still fail for other reasons (not in allowed root at IPC layer),
  // but at the PathGrantService level it must NOT be flagged as sensitive.
  if (!r2.ok) {
    assert.ok(!r2.error.includes('sensitive'),
      'C:\\WindowsBackup must not trigger sensitive-root rejection');
  }
});

// ---------------------------------------------------------------------------
// H-002: video duration enum validation
// ---------------------------------------------------------------------------
test('H-002: duration uses enumCheck not rangeCheck', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'specs', 'modelSpecs.js'), 'utf8');
  // The video branch must use enumCheck for duration
  const videoSection = src.slice(src.indexOf("} else if (tabKey === 'video')"));
  assert.ok(videoSection.includes("enumCheck('duration'"), 'duration must use enumCheck');
  assert.ok(!videoSection.includes("rangeCheck('duration'"), 'duration must NOT use rangeCheck');
});

// ---------------------------------------------------------------------------
// H-013: polling_url origin check
// ---------------------------------------------------------------------------
test('H-013: polling_url validated against baseUrl origin', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'providers', 'openaiCompatible.js'), 'utf8');
  assert.ok(src.includes('new URL(j.polling_url).origin'), 'must parse polling_url origin');
  assert.ok(src.includes('baseOrigin'), 'must compare against base origin');
  // Must NOT blindly use j.polling_url
  assert.ok(!src.includes('j.polling_url || ('), 'must not use polling_url without check');
});

// ---------------------------------------------------------------------------
// H-015: per-fetch timeout combined with caller signal
// ---------------------------------------------------------------------------
test('H-015: _fetchSignal helper combines signal + timeout', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'providers', 'openaiCompatible.js'), 'utf8');
  assert.ok(src.includes('_fetchSignal'), 'must have _fetchSignal helper');
  assert.ok(src.includes('AbortSignal.any'), 'must use AbortSignal.any for combining');
  // images and speech must use _fetchSignal
  const imagesFn = src.slice(src.indexOf('async function images'));
  assert.ok(imagesFn.includes('_fetchSignal(signal)'), 'images must use _fetchSignal');
});

// ---------------------------------------------------------------------------
// H-017: duplicate provider jobId rejection
// ---------------------------------------------------------------------------
test('H-017: duplicate in-flight jobId is rejected', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerProvidersIpc.js'), 'utf8');
  assert.ok(src.includes('inflight.has(req.jobId)'), 'must check for existing in-flight job');
  assert.ok(src.includes('already in-flight'), 'must return descriptive error');
});

// ---------------------------------------------------------------------------
// H-019: Real-ESRGAN runtime timeout + stderr cap
// ---------------------------------------------------------------------------
test('H-019: realesrgan has runtime timeout and stderr cap', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'realesrgan.js'), 'utf8');
  assert.ok(src.includes('RUNTIME_TIMEOUT_MS'), 'must have runtime timeout constant');
  assert.ok(src.includes('killTimer'), 'must have kill timer');
  assert.ok(src.includes('STDERR_CAP'), 'must have stderr cap');
  assert.ok(src.includes('clearTimeout(killTimer)'), 'must clear timer on close');
});

// ---------------------------------------------------------------------------
// H-020: tiny-image scale whitelist
// ---------------------------------------------------------------------------
test('H-020: tiny-image fallback clamps scale to whitelist', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'realesrgan.js'), 'utf8');
  // The tiny-image section must have its own scale clamp
  const tinySection = src.slice(src.indexOf('dims.width <= 8'));
  assert.ok(tinySection.includes('SCALES.includes(rawS)'), 'tiny-image must clamp scale');
});

// ---------------------------------------------------------------------------
// H-033: recursive copy force:false explicit
// ---------------------------------------------------------------------------
test('H-033: copyTo uses force:false for directory copy', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'fileBrowser.js'), 'utf8');
  const copySection = src.slice(src.indexOf('async function copyTo'));
  assert.ok(copySection.includes('force: false'), 'must have explicit force:false');
  assert.ok(copySection.includes('errorOnExist: true'), 'must have errorOnExist:true');
});

// ---------------------------------------------------------------------------
// H-034: archive trim scan window covers max line
// ---------------------------------------------------------------------------
test('H-034: archive trim uses backward block search (no fixed window)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'ArchiveService.js'), 'utf8');
  assert.ok(src.includes('const BLOCK = MAX_LINE_BYTES'), 'must search in blocks of MAX_LINE_BYTES');
  assert.ok(src.includes('searchEnd = blockStart'), 'must walk backward through blocks');
  assert.ok(!src.includes("const SCAN = 8 * 1024"), 'old 8KB scan window must be gone');
});

// ---------------------------------------------------------------------------
// H-035: UTF-8 chunk boundary (StringDecoder)
// ---------------------------------------------------------------------------
test('H-035: ArchiveService uses StringDecoder for chunk reads', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'ArchiveService.js'), 'utf8');
  assert.ok(src.includes("require('string_decoder')"), 'must import string_decoder');
  assert.ok(src.includes('StringDecoder'), 'must use StringDecoder');
  assert.ok(src.includes('decoder.write('), 'readChunk must use decoder.write');
  assert.ok(src.includes('decoder2.write('), 'deleteOne streaming must use decoder2.write');
});

// ---------------------------------------------------------------------------
// H-029: fbReveal/fbOpenInExplorer pass grantId
// ---------------------------------------------------------------------------
test('H-029: preload fbReveal and fbOpenInExplorer accept grantId', () => {
  const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.ok(src.includes("fbReveal: (path, grantId) => ipcRenderer.invoke('fb:reveal', path, grantId)"),
    'fbReveal must pass grantId');
  assert.ok(src.includes("fbOpenInExplorer: (path, grantId) => ipcRenderer.invoke('fb:openInExplorer', path, grantId)"),
    'fbOpenInExplorer must pass grantId');
});

test('H-029: renderer callers use GrantHelper.ensureRead before reveal', () => {
  const fb1 = fs.readFileSync(path.join(ROOT, 'renderer', 'services', 'fileBrowser1.js'), 'utf8');
  assert.ok(fb1.includes('GrantHelper.ensureRead(it.path)'), 'fileBrowser1 must mint read grant');
  const fb2b = fs.readFileSync(path.join(ROOT, 'renderer', 'services', 'fileBrowser2b.js'), 'utf8');
  assert.ok(fb2b.includes('GrantHelper.ensureRead(it.path)'), 'fileBrowser2b must mint read grant');
});

// ---------------------------------------------------------------------------
// H-032: atomic no-clobber rename via link + unlink
// ---------------------------------------------------------------------------
test('H-032: rename uses fs.link() for atomic no-clobber (files)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'fileBrowser.js'), 'utf8');
  const renameFn = src.slice(src.indexOf('async function rename'));
  assert.ok(renameFn.includes('await fs.link(p, dest)'), 'must use fs.link for atomic create');
  assert.ok(renameFn.includes("e.code === 'EEXIST'"), 'must catch EEXIST from link');
  assert.ok(renameFn.includes('await fs.unlink(p)'), 'must remove source after link');
  // Directories fall back to existsSync guard
  assert.ok(renameFn.includes('st.isDirectory()'), 'must branch on directory');
});

test('H-032: moveTo uses fs.link() for atomic no-clobber (files)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'fileBrowser.js'), 'utf8');
  const moveFn = src.slice(src.indexOf('async function moveTo'), src.indexOf('async function copyTo'));
  assert.ok(moveFn.includes('await fs.link(src, dest)'), 'moveTo must use fs.link for files');
  assert.ok(moveFn.includes("e.code === 'EEXIST'"), 'moveTo must catch EEXIST');
  assert.ok(moveFn.includes('COPYFILE_EXCL'), 'moveTo cross-device must use COPYFILE_EXCL');
  assert.ok(moveFn.includes('await fs.unlink(src)'), 'moveTo must remove source after link');
  assert.ok(moveFn.includes('st.isDirectory()'), 'moveTo must branch on directory');
});

// ---------------------------------------------------------------------------
// H-021: ONNX output PNG validation (source assertions)
// ---------------------------------------------------------------------------
test('H-021: inpaint validates PNG output (magic + dimensions + pixel budget)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'inpaint', 'index.js'), 'utf8');
  assert.ok(src.includes('PNG_MAGIC'), 'must define PNG magic constant');
  assert.ok(src.includes('validatePngOutput'), 'must have validatePngOutput function');
  assert.ok(src.includes('readUInt32BE(16)'), 'must parse IHDR width');
  assert.ok(src.includes('readUInt32BE(20)'), 'must parse IHDR height');
  assert.ok(src.includes('32768'), 'must enforce pixel budget');
  assert.ok(src.includes('MIN_OUTPUT_BYTES'), 'must reject too-small files');
  // Validation is called on success path
  assert.ok(src.includes('const check = validatePngOutput(dstPath)'), 'must call validation on close');
});

test('H-021: isnetbg validates PNG output in both runBinary and runNode', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'isnetbg.js'), 'utf8');
  assert.ok(src.includes('validatePngOutput'), 'must have validatePngOutput');
  // Both code paths (binary + node) must call validation
  const matches = src.match(/validatePngOutput\(dstPath\)/g);
  assert.ok(matches && matches.length >= 2, 'both runBinary and runNode must validate output');
  assert.ok(src.includes('STDERR_CAP'), 'must cap stderr');
});

// ---------------------------------------------------------------------------
// H-036: corrupt providers.json backup
// ---------------------------------------------------------------------------
test('H-036: providersStore backs up corrupt file before falling back to defaults', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'providersStore.js'), 'utf8');
  assert.ok(src.includes('.corrupt-'), 'must create .corrupt- timestamped backup');
  assert.ok(src.includes('copyFileSync'), 'must copy the corrupt file to backup');
  assert.ok(src.includes('H-036'), 'must reference the audit finding');
});

// ---------------------------------------------------------------------------
// H-068: archive split post-build size check
// ---------------------------------------------------------------------------
test('H-068: zip-portable enforces GitHub 2 GiB limit post-build', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'zip-portable.js'), 'utf8');
  assert.ok(src.includes('GITHUB_LIMIT'), 'must define GITHUB_LIMIT constant');
  assert.ok(src.includes('2 * 1024 * 1024 * 1024'), 'must be 2 GiB');
  assert.ok(src.includes('PART_RAW_CAP'), 'must define PART_RAW_CAP');
  assert.ok(src.includes('archiveSize > GITHUB_LIMIT'), 'must check each archive against limit');
  assert.ok(src.includes('fail('), 'must fail the build on oversized archive');
});

// ---------------------------------------------------------------------------
// H-037: Save-As source read grant authorization
// ---------------------------------------------------------------------------
test('H-037: file:saveAs accepts sourceReadGrantId for authorization', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerFilePickerIpc.js'), 'utf8');
  assert.ok(src.includes('sourceReadGrantId'), 'must accept sourceReadGrantId parameter');
  assert.ok(src.includes("operation: 'read'"), 'must authorize read operation on source');
  assert.ok(src.includes('pathGrantService.authorize(sourceReadGrantId'), 'must validate the grant');
  assert.ok(src.includes('isPathUnderAny'), 'must fall back to trust-root check');
});
