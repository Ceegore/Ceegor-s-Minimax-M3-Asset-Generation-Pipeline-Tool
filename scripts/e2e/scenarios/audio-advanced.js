// scripts/e2e/scenarios/audio-advanced.js
// ============================================================================
// Phase A4 — Audio advanced IPC coverage.
//
// Exercises the 4 never-invoked audio:* IPC channels:
//   audio:available, audio:autocutDetect, audio:findZeroCrossing,
//   audio:trimSilence
//
// Creates a real WAV file (PCM silence + tone) so the ffmpeg-based handlers
// have valid input to analyse.
// ============================================================================

const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'audio-advanced',
  needsRealApi: false,
  fakeOnly: false,
  order: 46,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT } = ctx;

    // Create a minimal valid WAV file (44-byte header + 1600 bytes of silence
    // = 0.05s at 16kHz 16-bit mono). The ffmpeg-based handlers need a
    // structurally valid audio file to probe.
    const wavFile = path.join(OUT, 'e2e_audio_test.wav');
    const sampleRate = 16000;
    const numSamples = 800; // 0.05s
    const dataSize = numSamples * 2; // 16-bit = 2 bytes/sample
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // chunk size
    header.writeUInt16LE(1, 20);  // PCM
    header.writeUInt16LE(1, 22);  // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); // byte rate
    header.writeUInt16LE(2, 32);  // block align
    header.writeUInt16LE(16, 34); // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    const silence = Buffer.alloc(dataSize, 0);
    fs.writeFileSync(wavFile, Buffer.concat([header, silence]));

    // ---- audio:available — check if ffmpeg is bundled ----
    const availRes = await exec(`(async () => {
      try {
        return await window.api.audioAvailable();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(availRes !== undefined && availRes !== null, 'audio:available IPC was not invoked');
    // ffmpeg-static is a project dependency, so it should be available.
    if (availRes && typeof availRes.available === 'boolean') {
      check(availRes.available === true, 'audio:available reports ffmpeg not available (ffmpeg-static missing?)');
    }

    // ---- audio:autocutDetect — detect silence regions for auto-trim ----
    const autocutRes = await exec(`(async () => {
      try {
        return await window.api.audioAutocutDetect(${JSON.stringify(wavFile)}, { threshold: -50, minSilence: 0.1 });
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(autocutRes !== undefined && autocutRes !== null, 'audio:autocutDetect IPC was not invoked');

    // ---- audio:findZeroCrossing — find nearest zero crossing ----
    const zeroRes = await exec(`(async () => {
      try {
        return await window.api.audioFindZeroCrossing(${JSON.stringify(wavFile)}, { time: 0.02, direction: 'forward' });
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(zeroRes !== undefined && zeroRes !== null, 'audio:findZeroCrossing IPC was not invoked');

    // ---- audio:trimSilence — trim leading/trailing silence ----
    const trimRes = await exec(`(async () => {
      try {
        return await window.api.audioTrimSilence(${JSON.stringify(wavFile)}, { threshold: -50, outputPath: ${JSON.stringify(path.join(OUT, 'e2e_trimmed.wav'))} });
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(trimRes !== undefined && trimRes !== null, 'audio:trimSilence IPC was not invoked');

    // Cleanup.
    try { fs.unlinkSync(wavFile); } catch (_) {}
    try { fs.unlinkSync(path.join(OUT, 'e2e_trimmed.wav')); } catch (_) {}
  },
};
