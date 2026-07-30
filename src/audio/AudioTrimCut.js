// src/audio/AudioTrimCut.js
// Higher-level audio operations: silence trimming (heuristic, via peaks) and
// cut/export (stream src[start..end] → dst, with an optional fade).

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { findBinary } = require('./AudioBinary');
const { probe } = require('./AudioMetadata');
const { decodePeaks } = require('./AudioWaveform');
const { getSafeThreadCount, getSafeProcessEnv } = require('../cpuGuard');

/**
 * Detects the longest sub-threshold run at the start and end of the file and
 * returns [startSec, endSec] for trimming.
 *
 * @param {string} filePath
 * @param {{ thresholdDb?: number, minSilenceMs?: number }} [opts]
 */
async function trimSilence(filePath, opts = {}) {
  const thresholdDb = opts.thresholdDb != null ? opts.thresholdDb : -50;
  const minSilenceMs = opts.minSilenceMs != null ? opts.minSilenceMs : 50;
  const linearThreshold = Math.pow(10, thresholdDb / 20);

  const probeR = await probe(filePath);
  if (!probeR.ok) return { ok: false, error: probeR.error };

  const peaksR = await decodePeaks(filePath, {
    duration: probeR.duration,
    targetRate: 4000,
    maxBuckets: 4000,
  });
  if (!peaksR.ok) return { ok: false, error: peaksR.error };

  const peaks = peaksR.peaks;
  const bucketSec = peaksR.bucketSec;
  const minSilenceBuckets = Math.max(1, Math.floor((minSilenceMs / 1000) / bucketSec));

  // Head silence
  let leadSilentCount = 0;
  let leadEndIdx = -1;
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i] < linearThreshold) leadSilentCount++;
    else { leadEndIdx = i; break; }
  }
  if (leadEndIdx === -1) {
    return {
      ok: true,
      startSec: 0,
      endSec: probeR.duration,
      threshold: thresholdDb,
      leadSilenceSec: 0,
      tailSilenceSec: 0,
      duration: probeR.duration,
      note: 'file appears fully silent',
    };
  }

  // Tail silence
  let tailSilentCount = 0;
  let tailLoudIdx = -1;
  for (let i = peaks.length - 1; i >= 0; i--) {
    if (peaks[i] < linearThreshold) tailSilentCount++;
    else { tailLoudIdx = i; break; }
  }
  if (tailLoudIdx === -1) {
    return {
      ok: true,
      startSec: 0,
      endSec: probeR.duration,
      threshold: thresholdDb,
      leadSilenceSec: 0,
      tailSilenceSec: 0,
      duration: probeR.duration,
      note: 'no loud sample detected',
    };
  }

  let startSec = 0;
  let endSec = probeR.duration;
  let leadSilenceSec = 0;
  let tailSilenceSec = 0;

  if (leadSilentCount >= minSilenceBuckets) {
    startSec = leadEndIdx * bucketSec;
    leadSilenceSec = leadSilentCount * bucketSec;
  }
  if (tailSilentCount >= minSilenceBuckets) {
    endSec = Math.min(probeR.duration, (tailLoudIdx + 1) * bucketSec);
    tailSilenceSec = tailSilentCount * bucketSec;
  }

  if (endSec - startSec < 0.005) {
    startSec = 0;
    endSec = probeR.duration;
    leadSilenceSec = 0;
    tailSilenceSec = 0;
  }

  return {
    ok: true,
    startSec,
    endSec,
    threshold: thresholdDb,
    leadSilenceSec,
    tailSilenceSec,
    duration: probeR.duration,
  };
}

/**
 * Codec selection per container extension. Default quality per codec — can
 * be overridden per-call via the `quality` option (advanced pipeline
 * settings). Map is stable: renderer / tests access default args via
 * `CODEC_BY_EXT`.
 * @type {Record<string, string[]>}
 */
const CODEC_BY_EXT = {
  wav:  ['-c:a', 'pcm_s16le'],
  mp3:  ['-c:a', 'libmp3lame', '-q:a', '2'],
  ogg:  ['-c:a', 'libvorbis', '-q:a', '6'],
  opus: ['-c:a', 'libopus', '-b:a', '128k'],
  flac: ['-c:a', 'flac'],
  m4a:  ['-c:a', 'aac', '-b:a', '192k'],
  aac:  ['-c:a', 'aac', '-b:a', '192k'],
};

/**
 * Build the codec argv for the chosen extension, substituting the
 * user-tuned quality values when present. `quality` is the advanced-pipeline-
 * settings shape:
 *   { mp3Quality, oggQuality, opusBitrate, m4aBitrate }
 * Each field is optional; missing fields keep the codec default.
 */
function codecArgsFor(ext, quality) {
  const base = CODEC_BY_EXT[ext] || ['-c:a', 'pcm_s16le'];
  if (!quality || typeof quality !== 'object') return base.slice();
  // The codec arrays are stable 2/4-tuples. Substitute the quality-bearing
  // token (the LAST element of the relevant codec array) when the user
  // provided an override. Coerce the input via Number() first, then validate:
  // state.js always normalises to numbers, but an external IPC handler or a
  // test might pass a numeric string, and a direct Number.isFinite check
  // would reject "5".
  const q = quality;
  const numQ = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
  if (ext === 'mp3' && Number.isFinite(numQ(q.mp3Quality))) {
    return ['-c:a', 'libmp3lame', '-q:a', String(Math.max(0, Math.min(9, Math.round(numQ(q.mp3Quality)))))];
  }
  if (ext === 'ogg' && Number.isFinite(numQ(q.oggQuality))) {
    return ['-c:a', 'libvorbis', '-q:a', String(Math.max(0, Math.min(10, Math.round(numQ(q.oggQuality)))))];
  }
  if (ext === 'opus' && typeof q.opusBitrate === 'string' && /^\d+k$/.test(q.opusBitrate)) {
    return ['-c:a', 'libopus', '-b:a', q.opusBitrate];
  }
  if ((ext === 'm4a' || ext === 'aac') && typeof q.m4aBitrate === 'string' && /^\d+k$/.test(q.m4aBitrate)) {
    return ['-c:a', 'aac', '-b:a', q.m4aBitrate];
  }
  return base.slice();
}

/**
 * Cut/export. Streams srcPath[startSec..endSec] to dstPath, optionally with a
 * micro-fade at both edges.
 *
 * @param {string} srcPath
 * @param {string} dstPath
 * @param {{ startSec?: number, endSec?: number, fadeMs?: number, fade?: boolean, copy?: boolean, meta?: object }} [opts]
 */
async function cut(srcPath, dstPath, opts = {}) {
  // KGO4-010: reject inverted ranges explicitly instead of silently
  // producing a 0-second file that reports success.
  if (opts.endSec != null && opts.startSec != null && opts.endSec <= opts.startSec) {
    return { ok: false, error: `endSec (${opts.endSec}) must be > startSec (${opts.startSec})` };
  }
  const startSec = Math.max(0, opts.startSec || 0);
  const MIN_RANGE_SEC = 0.02; // the UI's 20 ms floor; the API mirrors it
  // KGO6-013: when endSec is absent, probe the source duration instead of
  // defaulting to startSec + 1ms (which produced a near-empty file).
  // KGO7-016: VALIDATE BEFORE COERCING. The previous
  // `Math.max(startSec + 0.02, opts.endSec)` widened an explicit range up
  // to the floor first, so the guard below could never fire for it — a
  // 5 ms request silently became a 20 ms file reporting ok:true, while the
  // no-endSec branch hard-errored on the very same rule.
  // KGO8-007: the range must also be validated against the SOURCE DURATION.
  // Neither guard above looks at how long the file actually is, so a range
  // entirely past the end (startSec 10 on a 6 s file) returned ok:true with
  // the requested duration echoed back, while ffmpeg wrote a 78-byte WAV that
  // this app's own audioProbe then rejects as corrupt. Reachable through
  // batchPostprocess, which passes a row's cut range through unchecked.
  const srcProbe = await probe(srcPath);
  const srcDuration = (srcProbe && srcProbe.ok && Number.isFinite(srcProbe.duration))
    ? srcProbe.duration : null;
  if (srcDuration != null && startSec >= srcDuration) {
    return {
      ok: false,
      error: `startSec (${startSec}) is at or past the end of the source (${srcDuration.toFixed(3)} s).`,
    };
  }

  const warnings = [];
  let endSec;
  if (opts.endSec != null) {
    endSec = opts.endSec;
    if (endSec - startSec < MIN_RANGE_SEC) {
      return {
        ok: false,
        error: `Cut range must be at least 20 ms (got ${((endSec - startSec) * 1000).toFixed(1)} ms).`,
      };
    }
    // Clamp an over-long range to the real end and SAY SO, instead of
    // echoing back a duration the output does not have.
    if (srcDuration != null && endSec > srcDuration) {
      warnings.push(`endSec ${endSec} is past the end of the source; clamped to ${srcDuration.toFixed(3)} s.`);
      endSec = srcDuration;
    }
  } else {
    endSec = (srcDuration != null && srcDuration > startSec) ? srcDuration : startSec;
    if (endSec - startSec < MIN_RANGE_SEC) {
      return { ok: false, error: 'Cut range must be at least 20 ms.' };
    }
  }
  const duration = endSec - startSec;
  const fadeMs   = opts.fadeMs != null ? opts.fadeMs : 5;
  // FUNC-011: clamp fade so fadeIn + fadeOut <= clipDuration.
  // Each fade is fadeMs; both together must not exceed the clip.
  const maxFadeMs = Math.floor((duration * 1000) / 2);
  const clampedFadeMs = Math.min(fadeMs, maxFadeMs);
  const wantFade = !!opts.fade && clampedFadeMs > 0;
  // FUNC-009/010: stream-copy is only valid when NO filters are active.
  // A fade requires re-encoding (the -af filter graph), so copy mode
  // must be disabled when fade is requested.
  const useCopy = !!opts.copy && !wantFade;

  const ext = (path.extname(dstPath).toLowerCase().replace(/^\./, '') || 'wav');
  const codec = codecArgsFor(ext, opts.quality);

  // For "copy" mode (-c copy), the rules are different: ffmpeg needs
  // the fast seek (before -i) to keep stream-copying working. We keep
  // `-ss` before -i in that branch only.
  // FUNC-009/010: useCopy is false when fade is active (see above).
  let args;
  if (useCopy) {
    args = [
      '-ss', startSec.toFixed(6),
      '-i', srcPath,
      '-t', duration.toFixed(6),
      '-c', 'copy',
    ];
  } else {
    args = [
      '-i', srcPath,
      '-ss', startSec.toFixed(6),
      '-t', duration.toFixed(6),
      ...codec,
    ];
    if (wantFade) {
      // Use a tiny half-cosine fade. afade=t=in/out:st=…:d=…
      // FUNC-011: use clampedFadeMs to ensure fadeIn + fadeOut <= duration.
      const fadeSec = (clampedFadeMs / 1000).toFixed(4);
      args.push(
        '-af', `afade=t=in:st=0:d=${fadeSec},afade=t=out:st=${(duration - clampedFadeMs / 1000).toFixed(4)}:d=${fadeSec}`,
      );
    }
  }
  // P4.4 (DB-H-004): ffmpeg writes to a uuid-named temp file in the
  // DESTINATION folder (same volume → the final rename is atomic), never
  // straight to dstPath. A crash / kill / timeout mid-encode therefore can
  // never leave a truncated file at the destination — which matters most
  // when the caller is overwriting an existing asset. The real container
  // extension stays LAST so ffmpeg's muxer autodetection still works.
  const tmpPath = path.join(path.dirname(dstPath), `.cut-${crypto.randomUUID()}.tmp.${ext}`);
  args.push('-y', tmpPath);

  const bin = findBinary();
  if (!bin) return { ok: false, error: 'ffmpeg binary not found.' };

  return new Promise((resolve) => {
    let proc;
    let timeoutTimer = null;
    let settled = false;
    // P4.4: every failure path deletes the temp — the destination (and any
    // pre-existing file there) is never touched until the rename.
    const cleanupTmp = () => { try { fs.unlinkSync(tmpPath); } catch (_) {} };
    // Single settle point: the timeout-kill also fires 'close', so this
    // guards against resolving twice (and reporting a partial file as success).
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(r);
    };
    try {
      proc = spawn(bin, ['-hide_banner', '-nostdin', '-threads', String(getSafeThreadCount()), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: getSafeProcessEnv() });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    // Kill a hung ffmpeg instead of blocking audio:cut forever. On timeout
    // remove the partial TEMP file (mirrors the AudioSilenceDetect timeout
    // pattern) — the destination is untouched by design.
    timeoutTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      cleanupTmp();
      done({ ok: false, error: 'Audio cut timed out.' });
    }, 10 * 60 * 1000);
    let stderr = '';
    proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    proc.on('error', (e) => { cleanupTmp(); done({ ok: false, error: String((e && e.message) || e) }); });
    proc.on('close', (code) => {
      (async () => {
        if (code !== 0) {
          cleanupTmp();
          done({ ok: false, code, error: `ffmpeg exited with code ${code}`, stderr });
          return;
        }
        // P4.4: validate the temp BEFORE it replaces anything. ffmpeg can
        // exit 0 yet leave an unreadable stub (disk full mid-flush, broken
        // muxer); the probe must read a real duration or the original file
        // at dstPath is preserved untouched.
        const check = await probe(tmpPath);
        if (!check || !check.ok || !Number.isFinite(check.duration) || check.duration <= 0) {
          cleanupTmp();
          done({
            ok: false,
            error: `Cut output failed validation (${(check && check.error) || 'no readable duration'}); the original file was preserved.`,
            stderr,
          });
          return;
        }
        try {
          // Atomic swap: same folder ⇒ same volume ⇒ rename, never a copy.
          fs.renameSync(tmpPath, dstPath);
        } catch (e) {
          cleanupTmp();
          done({ ok: false, error: `Could not move the finished cut into place: ${String((e && e.message) || e)}`, stderr });
          return;
        }
        // KGO8-007: startSec/endSec/duration are the CLAMPED values actually
        // produced, and `warnings` says so when they differ from the request.
        done({ ok: true, outputPath: dstPath, startSec, endSec, duration, warnings });
      })().catch((e) => { cleanupTmp(); done({ ok: false, error: String((e && e.message) || e), stderr }); });
    });
  });
}

module.exports = { trimSilence, cut, codecArgsFor, CODEC_BY_EXT };
