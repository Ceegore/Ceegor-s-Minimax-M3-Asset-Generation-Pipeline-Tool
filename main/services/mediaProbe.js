'use strict';

/**
 * Media probe — audio/video semantic validation using ffprobe.
 *
 * AUD-009 fix: Type detection from bytes, not provider metadata.
 * Audio/video validation uses the bundled ffmpeg/ffprobe binary with:
 * - shell disabled
 * - fixed argument array
 * - 15-second timeout
 * - output cap
 * - no network protocols
 * - canonical local stage path
 * - JSON output parsed with a small cap
 */

const { execFile } = require('child_process');
const path = require('path');

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_OUTPUT_CAP = 1024 * 1024; // 1 MiB max JSON output

/** Modality to expected stream type mapping. */
const MODALITY_STREAM = Object.freeze({
  image: null, // images use sharp, not ffprobe
  audio: 'audio',
  video: 'video',
});

/**
 * H-004 (hhhhu3 audit): packaged builds must never execute an ffprobe found
 * on PATH — only pinned, release-verified binaries are acceptable there.
 * @returns {boolean}
 */
function _isPackaged() {
  try { return !!require('electron').app.isPackaged; } catch (_) { return false; }
}

/**
 * H-004: executables inside the asar archive cannot be spawned; the builder
 * unpacks them into app.asar.unpacked (asarUnpack rule).
 * @param {string} p
 * @returns {string}
 */
function _asarUnpacked(p) {
  return p.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
}

/**
 * Discover the ffprobe binary. Order:
 *   1. @ffprobe-installer/ffprobe — pinned npm dependency (H-004);
 *   2. ffprobe bundled next to ffmpeg-static;
 *   3. explicitly bundled copies in bin/ and resources/bin (verified by
 *      scripts/runtime-assets.json in releases);
 *   4. system PATH — ONLY in unpackaged (dev) mode. H-004 prohibits the
 *      PATH fallback in packaged builds so an attacker-prepositioned
 *      ffprobe.exe on PATH can never be executed by release code.
 * M-022 (hhhhu3 audit): the result (including a negative one) is cached at
 * module level — previously every artifact re-ran a synchronous
 * `ffprobe -version` discovery (5 s timeout) that froze the main process.
 * @returns {string|null}
 */
function _discoverFfprobe() {
  const fs = require('fs');
  const probeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  // 1. Pinned bundled dependency.
  try {
    const pinned = require('@ffprobe-installer/ffprobe');
    if (pinned && pinned.path && fs.existsSync(_asarUnpacked(pinned.path))) return _asarUnpacked(pinned.path);
  } catch (_) {}
  // 2. ffmpeg-static bundles ffprobe alongside ffmpeg in some layouts.
  try {
    const ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath) {
      const probePath = _asarUnpacked(path.join(path.dirname(ffmpegPath), probeName));
      if (fs.existsSync(probePath)) return probePath;
    }
  } catch (_) {}
  // 3. Explicitly bundled copies (bin/ in dev, resources/bin in releases).
  const bundledCandidates = [
    path.join(__dirname, '..', '..', 'bin', probeName),
    path.join(__dirname, '..', '..', 'resources', 'bin', probeName),
  ];
  try {
    if (process.resourcesPath) bundledCandidates.push(path.join(process.resourcesPath, 'bin', probeName));
  } catch (_) {}
  for (const candidate of bundledCandidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (_) {}
  }
  // 4. System PATH — dev only (H-004).
  if (_isPackaged()) return null;
  try {
    const { execFileSync } = require('child_process');
    execFileSync(probeName, ['-version'], { timeout: 5000, windowsHide: true, stdio: 'ignore' });
    return probeName;
  } catch (_) {
    return null; // ffprobe not available
  }
}

// M-022 (hhhhu3 audit): module-level discovery cache. `undefined` = not yet
// resolved; `null` = resolved-absent (also cached, so repeated provider
// outputs cannot re-trigger the synchronous probe on every artifact).
let _ffprobeCache;

/**
 * Resolve the ffprobe binary path.
 * M-004 (hhhhu2 audit): returns null when ffprobe cannot be found, so the
 * caller can produce a clear diagnostic instead of a cryptic spawn error.
 * @returns {string|null}
 */
function resolveFfprobe() {
  if (_ffprobeCache !== undefined) return _ffprobeCache;
  _ffprobeCache = _discoverFfprobe();
  return _ffprobeCache;
}

/** Test hook: clear the discovery cache. */
function _resetFfprobeCacheForTest() { _ffprobeCache = undefined; }

/**
 * Probe a media file and validate it against modality constraints.
 * @param {string} filePath - Canonical path to the staged file
 * @param {{
 *   modality: 'audio' | 'video',
 *   maxDurationSec?: number,
 *   maxWidth?: number,
 *   maxHeight?: number,
 *   maxStreams?: number
 * }} opts
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: true, streams: object[], duration: number, format: string} | {ok: false, error: string}>}
 */
async function probeMedia(filePath, opts, signal) {
  const ffprobe = resolveFfprobe();
  // M-004 (hhhhu2 audit): fail with a clear diagnostic when ffprobe is absent.
  if (!ffprobe) {
    return { ok: false, error: 'ffprobe is not available. Audio/video validation requires the bundled ffprobe binary. Reinstall the application.' };
  }
  const maxDuration = opts.maxDurationSec || 3600; // 1 hour default
  const maxWidth = opts.maxWidth || 7680;
  const maxHeight = opts.maxHeight || 4320;
  const maxStreams = opts.maxStreams || 10;
  const expectedStreamType = MODALITY_STREAM[opts.modality];

  if (!expectedStreamType) {
    return { ok: false, error: `Cannot probe modality: ${opts.modality}` };
  }

  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-protocol_whitelist', 'file,pipe',
    '-i', filePath,
  ];

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: 'Aborted before probe.' });
      return;
    }

    const child = execFile(ffprobe, args, {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_OUTPUT_CAP,
      shell: false,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed || (error.signal && error.signal === 'SIGTERM')) {
          resolve({ ok: false, error: 'ffprobe timed out.' });
        } else {
          resolve({ ok: false, error: `ffprobe failed: ${(error.message || '').slice(0, 200)}` });
        }
        return;
      }
      if (!stdout || stdout.length > PROBE_OUTPUT_CAP) {
        resolve({ ok: false, error: 'ffprobe output too large or empty.' });
        return;
      }
      let data;
      try { data = JSON.parse(stdout); } catch (_) {
        resolve({ ok: false, error: 'ffprobe returned invalid JSON.' });
        return;
      }
      validateProbeResult(data, resolve, {
        expectedStreamType,
        maxDuration,
        maxWidth,
        maxHeight,
        maxStreams,
      });
    });

    // Wire abort signal to kill the child
    if (signal) {
      const onAbort = () => { try { child.kill('SIGTERM'); } catch (_) {} };
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('close', () => signal.removeEventListener('abort', onAbort));
    }
  });
}

/**
 * Validate the parsed ffprobe JSON result.
 */
function validateProbeResult(data, resolve, constraints) {
  const streams = data.streams || [];
  const format = data.format || {};

  // Check stream count
  if (streams.length === 0) {
    resolve({ ok: false, error: 'No streams found in media file.' });
    return;
  }
  if (streams.length > constraints.maxStreams) {
    resolve({ ok: false, error: `Too many streams (${streams.length}, max ${constraints.maxStreams}).` });
    return;
  }

  // Must have at least one stream of the expected type
  const matching = streams.filter((s) => s.codec_type === constraints.expectedStreamType);
  if (matching.length === 0) {
    resolve({ ok: false, error: `No ${constraints.expectedStreamType} stream found.` });
    return;
  }

  // Reject files with unexpected executable/attachment streams
  const suspicious = streams.filter((s) =>
    s.codec_type === 'attachment' || s.codec_type === 'data'
  );
  if (suspicious.length > 0) {
    resolve({ ok: false, error: 'File contains suspicious attachment/data streams.' });
    return;
  }

  // Duration check
  // M-005 (hhhhu2 audit): reject zero, NaN, or negative duration.
  const duration = parseFloat(format.duration || '');
  if (!Number.isFinite(duration) || duration <= 0) {
    resolve({ ok: false, error: `Media has invalid duration (${format.duration || 'missing'}). File may be structurally corrupt.` });
    return;
  }
  if (duration > constraints.maxDuration) {
    resolve({ ok: false, error: `Duration ${duration}s exceeds maximum ${constraints.maxDuration}s.` });
    return;
  }

  // Video dimension checks
  if (constraints.expectedStreamType === 'video') {
    for (const s of matching) {
      const w = parseInt(s.width || '0', 10);
      const h = parseInt(s.height || '0', 10);
      // M-005 (hhhhu2 audit): reject zero dimensions.
      if (w <= 0 || h <= 0) {
        resolve({ ok: false, error: `Video has invalid dimensions (${w}x${h}). File may be structurally corrupt.` });
        return;
      }
      if (w > constraints.maxWidth || h > constraints.maxHeight) {
        resolve({ ok: false, error: `Video dimensions ${w}x${h} exceed maximum.` });
        return;
      }
    }
  }

  resolve({
    ok: true,
    streams,
    duration,
    format: format.format_name || 'unknown',
  });
}

module.exports = { probeMedia, resolveFfprobe, _resetFfprobeCacheForTest, PROBE_TIMEOUT_MS, MODALITY_STREAM };
