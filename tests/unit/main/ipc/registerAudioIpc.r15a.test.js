// tests/unit/main/ipc/registerAudioIpc.r15a.test.js
// ============================================================================
// R1.5a.2 (S1 §6 R1.5a) — Audio IPC Grant-Contract.
//
// Invarianten:
//   • audio:probe, audio:decodePeaks, audio:trimSilence, audio:autocutDetect
//     require a `grantId` parameter; the grant must authorise `read` on
//     srcPath.
//   • audio:cut requires a `grantId`; the grant must authorise `read`
//     on srcPath AND `write` on dstPath.
//   • audio:available stays ungated (no path; binary check).
//   • audio:findZeroCrossing stays ungated (no path; PCM data the
//     renderer already owns).
//   • Without a grantId (or with an unknown one) the handler returns
//     {ok:false, error} and does NOT touch the filesystem.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const AUDIO_IPC = path.join(ROOT, 'main', 'ipc', 'registerAudioIpc.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15a2-audio-'));

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---- Helper: load registerAudioIpc with stubbed electron + a fresh
// PathGrantService.defaultService. The audioCutter module is loaded
// fresh per test so the mocks we set on it don't leak across tests. ----
function loadIpc(audioCutterMock) {
  for (const p of [AUDIO_IPC, PATH_SECURITY, PATH_GRANT]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  // Also clear the audioCutter module so our mock takes effect.
  try { delete require.cache[require.resolve(ROOT + '/src/audioCutter.js')]; } catch (_) {}
  // Reset the defaultService singleton so each test starts clean.
  try {
    const { defaultService } = require(PATH_GRANT);
    defaultService.destroy();
  } catch (_) {}

  const handlers = new Map();
  require.cache[require.resolve(PATH_SECURITY)] = {
    exports: {
      getAllowedRoots: () => [TMP],
      isPathUnderAny: () => true, // legacy — not used by R1.5a.2
      isParentUnderAny: () => true,
      addTrusted: () => [],
      setActiveDir: () => null,
      getActiveDir: () => null,
    },
  };
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      app: { getPath: () => TMP },
    },
  };
  // Mock audioCutter so the handlers can run without a real ffmpeg.
  require.cache[require.resolve(ROOT + '/src/audioCutter.js')] = {
    exports: audioCutterMock,
  };
  require(AUDIO_IPC).register({ appRoot: ROOT });
  return { handlers };
}

function mintDirectoryGrant(svc, dir, opts = {}) {
  return svc.mintDirectoryGrant({
    origin: opts.origin || 'picker-browser-dir',
    purpose: opts.purpose || 'R1.5a.2 test grant',
    path: dir,
    capabilities: opts.capabilities || ['read', 'write', 'rename', 'delete', 'mkdir'],
  });
}

function mintFileGrant(svc, file, opts = {}) {
  return svc.mintFileGrant({
    origin: opts.origin || 'picker-browser-file',
    purpose: opts.purpose || 'R1.5a.2 test file grant',
    path: file,
    capabilities: opts.capabilities || ['read', 'write'],
  });
}

// Standard mock: ffmpeg-less, deterministic, records calls.
function defaultMock() {
  return {
    isAvailable: () => true,
    findBinary: () => 'C:\\bin\\ffmpeg.exe',
    async probe(srcPath) {
      return { ok: true, duration: 2, path: srcPath };
    },
    async decodePeaks(srcPath) {
      return {
        ok: true,
        peaks: [0.25, 0.75],
        pcm: [1, -1, 1],
        bucketSec: 0.001,
      };
    },
    findZeroCrossing() {
      return 9;
    },
    async trimSilence(srcPath) {
      return { ok: true, startSec: 0.2, endSec: 1.8 };
    },
    async cut(_srcPath, dstPath) {
      return { ok: true, outputPath: dstPath };
    },
    async detectSilences(srcPath) {
      return { ok: true, duration: 2, silences: [{ start: 0.5, end: 1.0 }] };
    },
    invertSilences(silences, duration) {
      return [{ start: 0, end: 0.5 }, { start: 1.0, end: 2.0 }];
    },
    planAutoCut(segments) {
      return { segments, stats: { kept: 2, droppedShort: 0, truncated: 0, split: 0, capped: 0 } };
    },
    sanitizeAutoCutRules(rules) {
      return rules;
    },
  };
}

// ============================================================================
// audio:available — no path, ungated
// ============================================================================

test('R1.5a.2: audio:available is NOT gated by grantId (binary check, no path)', () => {
  const { handlers } = loadIpc(defaultMock());
  const r = handlers.get('audio:available')();
  assert.equal(r.available, true);
  assert.equal(r.path, 'C:\\bin\\ffmpeg.exe');
});

// ============================================================================
// audio:probe
// ============================================================================

test('R1.5a.2: audio:probe with a read grant probes the source', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'tone.wav');
  fs.writeFileSync(src, Buffer.from([0])); // minimal stub
  const grant = mintFileGrant(defaultService, src);
  assert.equal(grant.ok, true);
  const r = await handlers.get('audio:probe')(null, src, grant.grantId);
  assert.equal(r.ok, true);
  assert.equal(r.duration, 2);
});

test('R1.5a.2: audio:probe without a grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'no-grant.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  const r = await handlers.get('audio:probe')(null, src, undefined);
  assert.equal(r.ok, false, 'no grantId MUST reject audio:probe');
  assert.match(r.error, /grantId is required/i);
});

test('R1.5a.2: audio:probe with an unknown grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'unknown.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  const r = await handlers.get('audio:probe')(null, src, 'grant_does_not_exist_xyz');
  assert.equal(r.ok, false);
});

test('R1.5a.2: audio:probe with a grant for a different path is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'for-src.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  // Grant covers a DIFFERENT file.
  const otherGrant = mintFileGrant(defaultService, path.join(TMP, 'for-other.wav'));
  const r = await handlers.get('audio:probe')(null, src, otherGrant.grantId);
  assert.equal(r.ok, false, 'a grant for a different file MUST not authorise the read');
});

// ============================================================================
// audio:decodePeaks
// ============================================================================

test('R1.5a.2: audio:decodePeaks with a read grant returns typed-array-converted peaks', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'dec-peaks.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  const grant = mintFileGrant(defaultService, src);
  const r = await handlers.get('audio:decodePeaks')(null, src, {}, grant.grantId);
  assert.equal(r.ok, true);
  // The IPC handler converts Float32Array → plain Array for structured-clone.
  assert.deepEqual(r.peaks, [0.25, 0.75]);
  assert.deepEqual(r.pcm, [1, -1, 1]);
});

test('R1.5a.2: audio:decodePeaks without a grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'dec-no-grant.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  const r = await handlers.get('audio:decodePeaks')(null, src, {}, undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /grantId is required/i);
});

test('R1.5a.2: audio:decodePeaks with an unknown grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'dec-unk.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  const r = await handlers.get('audio:decodePeaks')(null, src, {}, 'grant_does_not_exist_xyz');
  assert.equal(r.ok, false);
});

// ============================================================================
// audio:findZeroCrossing — no path, ungated
// ============================================================================

test('R1.5a.2: audio:findZeroCrossing is NOT gated by grantId (PCM data, no path)', async () => {
  const { handlers } = loadIpc(defaultMock());
  const r = await handlers.get('audio:findZeroCrossing')(null, [1, -1, 1], 4, 12);
  assert.equal(r.ok, true);
  assert.equal(r.index, 9);
});

// ============================================================================
// audio:trimSilence — read-only (returns metadata, no file write)
// ============================================================================

test('R1.5a.2: audio:trimSilence with a read grant returns the silence plan', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'trim.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  const grant = mintFileGrant(defaultService, src);
  const r = await handlers.get('audio:trimSilence')(null, src, {}, grant.grantId);
  assert.equal(r.ok, true);
  assert.equal(r.startSec, 0.2);
});

test('R1.5a.2: audio:trimSilence without a grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'trim-no-grant.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  const r = await handlers.get('audio:trimSilence')(null, src, {}, undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /grantId is required/i);
});

test('R1.5a.2: audio:trimSilence with an unknown grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'trim-unk.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  const r = await handlers.get('audio:trimSilence')(null, src, {}, 'grant_does_not_exist_xyz');
  assert.equal(r.ok, false);
});

// ============================================================================
// audio:cut — read on src + write on dst
// ============================================================================

test('R1.5a.2: audio:cut with a directory grant covering both src+dst cuts successfully', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'cut-src.wav');
  const dst = path.join(TMP, 'subdir', 'cut-dst.wav');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(src, Buffer.from([0]));
  // A directory grant for TMP covers BOTH src and dst.
  const dirGrant = mintDirectoryGrant(defaultService, TMP);
  const r = await handlers.get('audio:cut')(null, src, dst, {}, dirGrant.grantId);
  assert.equal(r.ok, true);
  assert.equal(r.outputPath, dst);
});

test('R1.5a.2: audio:cut without a grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'cut-no-grant.wav');
  const dst = path.join(TMP, 'cut-no-grant-out.wav');
  const r = await handlers.get('audio:cut')(null, src, dst, {}, undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /grantId is required/i);
});

test('R1.5a.2: audio:cut with a read-only grant for src is REJECTED (write on dst missing)', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'cut-read-src.wav');
  const dst = path.join(TMP, 'cut-read-out.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  // A read-only file grant for src fails the write-on-dst check.
  const grant = mintFileGrant(defaultService, src, { capabilities: ['read'] });
  const r = await handlers.get('audio:cut')(null, src, dst, {}, grant.grantId);
  assert.equal(r.ok, false, 'a read-only grant must fail the write check on dst');
});

test('R1.5a.2: audio:cut where src === dst is REJECTED (no overwriting source)', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'cut-same.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  const grant = mintFileGrant(defaultService, src);
  const r = await handlers.get('audio:cut')(null, src, src, {}, grant.grantId);
  assert.equal(r.ok, false);
  assert.match(r.error, /must differ from the source/i);
});

// ============================================================================
// audio:autocutDetect — read-only
// ============================================================================

test('R1.5a.2: audio:autocutDetect with a read grant returns the cut plan', async () => {
  const { handlers } = loadIpc(defaultMock());
  const { defaultService } = require(PATH_GRANT);
  const src = path.join(TMP, 'autocut.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  const grant = mintFileGrant(defaultService, src);
  const r = await handlers.get('audio:autocutDetect')(null, src, {}, grant.grantId);
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan, [{ start: 0, end: 0.5 }, { start: 1.0, end: 2.0 }]);
});

test('R1.5a.2: audio:autocutDetect without a grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'autocut-no-grant.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  const r = await handlers.get('audio:autocutDetect')(null, src, {}, undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /grantId is required/i);
});

test('R1.5a.2: audio:autocutDetect with an unknown grantId is REJECTED', async () => {
  const { handlers } = loadIpc(defaultMock());
  const src = path.join(TMP, 'autocut-unk.wav');
  fs.writeFileSync(src, Buffer.from([0]));
  const r = await handlers.get('audio:autocutDetect')(null, src, {}, 'grant_does_not_exist_xyz');
  assert.equal(r.ok, false);
});
