// src/audioCutter.js
// Backward-compat re-export. The original monolithic file was split into
// focused modules under src/audio/. This shim keeps the
// `require('../../src/audioCutter')` path in main/ipc/registerAudioIpc.js
// stable.
//
// Layout:
//   src/audio/AudioBinary.js      ffmpeg binary resolution + cache
//   src/audio/AudioRunner.js      low-level ffmpeg spawn wrapper
//   src/audio/AudioMetadata.js    probe(filePath) — ffmpeg -i parsing
//   src/audio/AudioWaveform.js    decodePeaks() — s16le PCM -> peaks
//   src/audio/AudioMath.js        findZeroCrossing() — pure, no ffmpeg
//   src/audio/AudioTrimCut.js     trimSilence() + cut()

const { findBinary, isAvailable } = require('./audio/AudioBinary');
const { runFFmpeg } = require('./audio/AudioRunner'); // re-exported for tests
const { probe } = require('./audio/AudioMetadata');
const { decodePeaks } = require('./audio/AudioWaveform');
const { findZeroCrossing } = require('./audio/AudioMath');
const { trimSilence, cut, codecArgsFor, CODEC_BY_EXT } = require('./audio/AudioTrimCut');
const { detectSilences, invertSilences } = require('./audio/AudioSilenceDetect');
const { planAutoCut, sanitizeAutoCutRules } = require('./audio/AudioAutoCutPlan');

module.exports = {
  // Binary
  isAvailable,
  findBinary,
  // Probe + decode
  probe,
  decodePeaks,
  // Pure
  findZeroCrossing,
  // High-level
  trimSilence,
  cut,
  // Codec map + per-ext argv builder (re-exported for tests +
  // so the audio cutter modal can introspect defaults).
  codecArgsFor,
  CODEC_BY_EXT,
  // Internals (re-exported for tests + future use)
  runFFmpeg,
  // Auto-cut
  detectSilences,
  invertSilences,
  planAutoCut,
  sanitizeAutoCutRules,
};
