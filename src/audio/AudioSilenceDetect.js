const { spawn } = require('child_process');
const { findBinary } = require('./AudioBinary');
const { probe } = require('./AudioMetadata');
const { getSafeThreadCount, getSafeProcessEnv } = require('../cpuGuard');

/**
 * Runs ffmpeg silencedetect filter and parses its stderr.
 * 
 * @param {string} filePath
 * @param {{ thresholdDb?: number, minSilenceMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, duration?: number, silences?: {start: number, end: number}[], error?: string }>}
 */
async function detectSilences(filePath, opts = {}) {
  const thresholdDb = opts.thresholdDb != null ? opts.thresholdDb : -35;
  const minSilenceMs = opts.minSilenceMs != null ? opts.minSilenceMs : 250;

  const probeR = await probe(filePath);
  if (!probeR.ok) {
    return { ok: false, error: probeR.error };
  }
  const duration = probeR.duration;

  const bin = findBinary();
  if (!bin) {
    return { ok: false, error: 'ffmpeg binary not found.' };
  }

  // Ensure thresholdDb and minSilenceMs are safe numbers
  const safeDb = Number.isFinite(thresholdDb) ? thresholdDb : -35;
  const safeMs = Number.isFinite(minSilenceMs) && minSilenceMs >= 50 ? minSilenceMs : 250;

  const filterStr = `silencedetect=noise=${safeDb}dB:d=${(safeMs / 1000).toFixed(4)}`;
  const args = [
    '-i', filePath,
    '-af', filterStr,
    '-f', 'null',
    '-'
  ];

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, ['-hide_banner', '-nostdin', '-threads', String(getSafeThreadCount()), ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: getSafeProcessEnv(),
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
      return;
    }

    let stderr = '';
    const timeoutTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      resolve({ ok: false, error: 'silencedetect timed out' });
    }, 5 * 60 * 1000);

    proc.stderr.on('data', (b) => {
      stderr += b.toString('utf8');
    });

    proc.on('error', (e) => {
      clearTimeout(timeoutTimer);
      resolve({ ok: false, error: String((e && e.message) || e) });
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutTimer);
      // Even if code is non-zero, try parsing since warning output might still be useful
      const silences = parseSilenceDetectStderr(stderr, duration);
      resolve({ ok: true, duration, silences });
    });
  });
}

function parseSilenceDetectStderr(stderr, duration) {
  const silences = [];
  const lines = stderr.split(/\r?\n/);
  
  const startRegex = /silence_start:\s*(-?[\d.]+)/;
  const endRegex = /silence_end:\s*(-?[\d.]+)/;

  let currentStart = null;

  for (const line of lines) {
    const startMatch = line.match(startRegex);
    if (startMatch) {
      let startVal = parseFloat(startMatch[1]);
      if (startVal < 0) startVal = 0;
      if (startVal > duration) startVal = duration;
      currentStart = startVal;
    }
    const endMatch = line.match(endRegex);
    if (endMatch && currentStart !== null) {
      let endVal = parseFloat(endMatch[1]);
      if (endVal < 0) endVal = 0;
      if (endVal > duration) endVal = duration;
      if (endVal < currentStart) endVal = currentStart;
      silences.push({ start: currentStart, end: endVal });
      currentStart = null;
    }
  }

  if (currentStart !== null) {
    silences.push({ start: currentStart, end: duration });
  }

  return silences;
}

/**
 * Inverts silence segments to sound segments.
 * Gaps between silences (including before first and after last silence) are sound.
 * 
 * @param {{start: number, end: number}[]} silences
 * @param {number} duration
 * @returns {{start: number, end: number}[]}
 */
function invertSilences(silences, duration) {
  const soundSegments = [];
  let currentPos = 0;

  for (const sil of silences) {
    if (sil.start > currentPos) {
      soundSegments.push({ start: currentPos, end: sil.start });
    }
    currentPos = Math.max(currentPos, sil.end);
  }

  if (duration > currentPos) {
    soundSegments.push({ start: currentPos, end: duration });
  }

  return soundSegments.filter(s => (s.end - s.start) > 0.0001);
}

module.exports = {
  detectSilences,
  parseSilenceDetectStderr,
  invertSilences
};
