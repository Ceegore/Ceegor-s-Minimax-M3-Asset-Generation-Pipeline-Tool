// main/ipc/registerAudioIpc.js
// IPC handlers: `audio:*` (available, probe, decodePeaks, findZeroCrossing,
// trimSilence, cut). Backs the right-click "✂ Audio cut…" dialog.
//
// R1.5a.2 (S1 §6 R1.5a): the path-taking handlers (audio:probe,
// audio:decodePeaks, audio:trimSilence, audio:cut, audio:autocutDetect)
// each require a `grantId` minted by Main (e.g. via file:pick /
// file:saveAs). The grant is authorised through PathGrantService
// before the handler touches the filesystem. audio:available stays
// ungated (no path). audio:findZeroCrossing stays ungated (no path;
// operates on PCM data the renderer already owns).

const { ipcMain } = require('electron');
const audioCutter = require('../../src/audioCutter');
const pathUtils = require('../../src/pathUtils');
const { authorizePath: _authorizePath } = require('./grantAuthorizer');

/**
 * @param {{ appRoot: string }} deps
 */
function register(_deps) {
  ipcMain.handle('audio:available', () => {
    // R4 fix: wrap in try/catch so a throw from the binary probe (e.g. an fs
    // access error) returns a clean envelope instead of rejecting the invoke.
    try {
      return { ok: true, available: audioCutter.isAvailable(), path: audioCutter.findBinary() };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('audio:probe', async (_e, srcPath, grantId) => {
    if (!srcPath || typeof srcPath !== 'string') {
      return { ok: false, error: 'Source path is required.' };
    }
    // R1.5a.2: read grant on srcPath (replaces the legacy
    // isPathUnderAny gate).
    const readAuthz = _authorizePath(grantId, 'read', srcPath);
    if (!readAuthz.ok) return { ok: false, error: readAuthz.error };
    try { return await audioCutter.probe(srcPath); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('audio:decodePeaks', async (_e, srcPath, opts, grantId) => {
    if (!srcPath || typeof srcPath !== 'string') {
      return { ok: false, error: 'Source path is required.' };
    }
    // R1.5a.2: read grant on srcPath.
    const readAuthz = _authorizePath(grantId, 'read', srcPath);
    if (!readAuthz.ok) return { ok: false, error: readAuthz.error };
    try {
      const r = await audioCutter.decodePeaks(srcPath, opts || {});
      // Float32Array / buffers don't survive IPC structured-clone as
      // typed arrays — we serialise them to a plain array + an extra
      // peakAbsMax field the renderer can pre-normalise with.
      if (r && r.ok && r.peaks && typeof r.peaks === 'object' && 'length' in r.peaks) {
        r.peaks = Array.from(r.peaks);
      }
      if (r && r.ok && r.pcm && typeof r.pcm === 'object' && 'length' in r.pcm) {
        r.pcm = Array.from(r.pcm);
      }
      return r;
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('audio:findZeroCrossing', async (_e, pcm, targetSample, window) => {
    // The PCM comes back from the renderer as a plain array (the IPC
    // marshal round-trip strips typed-array-ness). We restore it here.
    // R1.5a.2: no path → no grant required (ungated).
    let arr = pcm;
    if (arr && !Array.isArray(arr) && typeof arr.length === 'number') {
      arr = Array.from(arr);
    }
    if (!Array.isArray(arr)) return { ok: false, error: 'PCM data required.' };
    try {
      const f32 = new Float32Array(arr);
      const idx = audioCutter.findZeroCrossing(f32, targetSample | 0, window | 0);
      return { ok: true, index: idx };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('audio:trimSilence', async (_e, srcPath, opts, grantId) => {
    if (!srcPath || typeof srcPath !== 'string') {
      return { ok: false, error: 'Source path is required.' };
    }
    // R1.5a.2: read grant on srcPath. trimSilence is read-only
    // (it returns [startSec, endSec] metadata; no file is written).
    const readAuthz = _authorizePath(grantId, 'read', srcPath);
    if (!readAuthz.ok) return { ok: false, error: readAuthz.error };
    try { return await audioCutter.trimSilence(srcPath, opts || {}); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('audio:cut', async (_e, srcPath, dstPath, opts, grantId) => {
    if (!srcPath || typeof srcPath !== 'string') {
      return { ok: false, error: 'Source path is required.' };
    }
    if (!dstPath || typeof dstPath !== 'string') {
      return { ok: false, error: 'Destination path is required.' };
    }
    // R1.5a.2: read on srcPath + write on dstPath (replaces the
    // legacy isPathUnderAny + isParentUnderAny gates).
    const readAuthz = _authorizePath(grantId, 'read', srcPath);
    if (!readAuthz.ok) return { ok: false, error: readAuthz.error };
    const writeAuthz = _authorizePath(grantId, 'write', dstPath);
    if (!writeAuthz.ok) return { ok: false, error: writeAuthz.error };
    // Refuse to overwrite the source file (sanity check that survives
    // the grant gate — a renderer that has a read+write grant for the
    // same file is allowed to do dumb things, but cut must not).
    const srcAbs = pathUtils.normalize(srcPath);
    const dstAbs = pathUtils.normalize(dstPath);
    if (srcAbs && dstAbs && srcAbs.toLowerCase() === dstAbs.toLowerCase()) {
      return { ok: false, error: 'Destination must differ from the source.' };
    }
    try { return await audioCutter.cut(srcPath, dstPath, opts || {}); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('audio:autocutDetect', async (_e, srcPath, opts, grantId) => {
    if (!srcPath || typeof srcPath !== 'string') {
      return { ok: false, error: 'Source path is required.' };
    }
    // R1.5a.2: read grant on srcPath. autocutDetect is read-only
    // (it returns a cut plan; no file is written).
    const readAuthz = _authorizePath(grantId, 'read', srcPath);
    if (!readAuthz.ok) return { ok: false, error: readAuthz.error };
    try {
      // `sanitizeAutoCutRules` returns only the planning fields and DROPS
      // thresholdDb/minSilenceMs, so passing it to detectSilences would lose
      // the user's threshold/gap inputs and silently fall back to the
      // -35dB / 250ms defaults. Pass the raw opts to detectSilences (it has
      // its own finite-guards) and the sanitized rules to planAutoCut.
      const rules = audioCutter.sanitizeAutoCutRules(opts);
      const detectOpts = opts || {};
      const res = await audioCutter.detectSilences(srcPath, detectOpts);
      if (!res.ok) {
        return { ok: false, error: res.error };
      }
      const soundSegments = audioCutter.invertSilences(res.silences, res.duration);
      const plan = audioCutter.planAutoCut(soundSegments, rules, res.duration);
      return { ok: true, duration: res.duration, plan: plan.segments, stats: plan.stats };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

module.exports = { register };
