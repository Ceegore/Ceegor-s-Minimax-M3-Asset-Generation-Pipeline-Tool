// src/audio/AudioMetadata.js
// Cheap metadata-only probe: ffmpeg -i parsed aus stderr.
// Liefert duration, codec, sampleRate, channels, channelLayout, bitRate,
// format (Datei-Extension), size.

const path = require('path');
const fsp = require('fs').promises;
const { runFFmpeg } = require('./AudioRunner');

/**
 * @param {string} filePath
 * @returns {Promise<{
 *   ok: boolean,
 *   duration?: number,
 *   codec?: string,
 *   sampleRate?: number,
 *   channels?: number,
 *   channelLayout?: string,
 *   bitRate?: number,
 *   format?: string,
 *   size?: number,
 *   error?: string,
 *   stderr?: string,
 * }>}
 */
async function probe(filePath) {
  const r = await runFFmpeg(['-i', filePath]);
  const stderr = r.stderr || '';
  const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!dur) {
    return {
      ok: false,
      error: 'Could not read audio metadata (unsupported format? corrupt file?).',
      stderr,
    };
  }
  const duration = (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]);

  // Find the first audio stream line in stderr.
  const streamMatch = stderr.match(/Stream\s+#\d+:\d+.*?:\s*Audio:\s*([^,]+),\s*(\d+)\s*Hz(?:,\s*([^,\s]+))?/);
  let codec = '';
  let sampleRate = 0;
  let channels = 0;
  let channelLayout = '';
  if (streamMatch) {
    codec = streamMatch[1].trim();
    sampleRate = parseInt(streamMatch[2], 10) || 0;
    const ch = (streamMatch[3] || '').toLowerCase();
    channelLayout = ch;
    if (ch === 'mono') channels = 1;
    else if (ch === 'stereo') channels = 2;
    else if (ch === '5.1') channels = 6;
    else if (ch === '7.1') channels = 8;
    else if (ch) {
      const n = parseFloat(ch);
      if (isFinite(n) && n > 0) channels = Math.round(n);
    }
  }
  const brMatch = stderr.match(/Audio:[^,]+,\s*\d+\s*Hz,[^,]+,\s*(\d+)\s*kb\/s/);
  const bitRate = brMatch ? (parseInt(brMatch[1], 10) * 1000) : 0;

  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');

  let stat = null;
  try { stat = await fsp.stat(filePath); } catch (_) { /* ignore */ }

  return {
    ok: true,
    duration,
    codec,
    sampleRate,
    channels,
    channelLayout,
    bitRate,
    format: ext,
    size: stat ? stat.size : 0,
  };
}

module.exports = { probe };
