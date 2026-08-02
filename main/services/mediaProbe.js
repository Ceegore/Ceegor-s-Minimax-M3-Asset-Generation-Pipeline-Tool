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
 * Resolve the ffprobe binary path.
 * Uses ffmpeg-static's bundled ffprobe or falls back to system ffprobe.
 * @returns {string}
 */
function resolveFfprobe() {
  try {
    // ffmpeg-static bundles ffprobe alongside ffmpeg
    const ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath) {
      const dir = path.dirname(ffmpegPath);
      const probeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
      const probePath = path.join(dir, probeName);
      const fs = require('fs');
      if (fs.existsSync(probePath)) return probePath;
    }
  } catch (_) {}
  // Fallback: system ffprobe
  return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
}

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
  const duration = parseFloat(format.duration || '0');
  if (duration > constraints.maxDuration) {
    resolve({ ok: false, error: `Duration ${duration}s exceeds maximum ${constraints.maxDuration}s.` });
    return;
  }

  // Video dimension checks
  if (constraints.expectedStreamType === 'video') {
    for (const s of matching) {
      const w = parseInt(s.width || '0', 10);
      const h = parseInt(s.height || '0', 10);
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

module.exports = { probeMedia, resolveFfprobe, PROBE_TIMEOUT_MS, MODALITY_STREAM };
