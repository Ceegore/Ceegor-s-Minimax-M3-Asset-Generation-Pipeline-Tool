// src/audio/AudioMath.js
// Pure Hilfs-Funktionen für Audio-Verarbeitung.
// Hat **keine** ffmpeg-Abhängigkeit — vollständig testbar ohne Binary.

/**
 * Sucht den nächsten Zero-Crossing-Sample-Index in ±window um `targetSample`.
 * Wird vom Renderer benutzt, um einen Marker klickfrei zu snappen.
 *
 * @param {Float32Array} pcm
 * @param {number} targetSample
 * @param {number} [window=4000]
 * @returns {number} sample-Index (targetSample wenn nichts gefunden)
 */
function findZeroCrossing(pcm, targetSample, window = 4000) {
  if (!pcm || !pcm.length) return targetSample;
  const t = Math.max(0, Math.min(pcm.length - 1, Math.floor(targetSample)));
  const lo = Math.max(0, t - window);
  const hi = Math.min(pcm.length - 1, t + window);
  const targetSign = pcm[t] >= 0 ? 1 : -1;
  let best = t;
  let bestDist = window + 1;
  for (let i = 0; i <= window; i++) {
    const a = t - i;
    const b = t + i;
    if (a >= lo) {
      const s = pcm[a] >= 0 ? 1 : -1;
      if (s !== targetSign) {
        if (i < bestDist) { best = a; bestDist = i; }
        break;
      }
    }
    if (b <= hi && b !== a) {
      const s = pcm[b] >= 0 ? 1 : -1;
      if (s !== targetSign) {
        if (i < bestDist) { best = b; bestDist = i; }
        break;
      }
    }
  }
  return best;
}

module.exports = { findZeroCrossing };
