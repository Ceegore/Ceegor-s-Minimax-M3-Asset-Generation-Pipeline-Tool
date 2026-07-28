// src/audio/AudioRunner.js
// Low-level ffmpeg-Spawn-Wrapper. Resolved die Binary, kapselt stdout/stderr
// in eine Promise mit dem Standard-Shape { ok, code, stdout, stderr }.

const { spawn } = require('child_process');
const { findBinary } = require('./AudioBinary');

/**
 * @param {string[]} args        ffmpeg-Argumente (ohne -hide_banner/-nostdin).
 * @param {{ onSpawn?: (proc) => void }} [opts]
 * @returns {Promise<{ok: boolean, code: number, stdout: string, stderr: string}>}
 */
function runFFmpeg(args, opts = {}) {
  const bin = findBinary();
  if (!bin) {
    return Promise.resolve({
      ok: false,
      code: -1,
      stdout: '',
      stderr: 'ffmpeg binary not found (install ffmpeg-static or add ffmpeg.exe to PATH)',
    });
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 5 * 60 * 1000;
  return new Promise((resolve) => {
    let proc;
    let timeoutTimer = null;
    let settled = false;
    // Single settle point: the timeout-kill below also fires 'close', so this
    // guards against resolving the caller twice.
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(r);
    };
    const { getSafeThreadCount, getSafeProcessEnv } = require('../cpuGuard');
    const safeThreads = String(getSafeThreadCount());
    try {
      proc = spawn(bin, ['-hide_banner', '-nostdin', '-threads', safeThreads, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: getSafeProcessEnv(),
      });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String((e && e.message) || e) });
      return;
    }
    // Kill a hung ffmpeg instead of letting the caller (audio:probe, etc.)
    // block forever. Mirrors the AudioSilenceDetect timeout pattern.
    timeoutTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      done({ ok: false, code: -1, stdout: '', stderr: 'ffmpeg timed out after ' + Math.round(timeoutMs / 1000) + 's' });
    }, timeoutMs);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    proc.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    proc.on('error', (e) => {
      done({ ok: false, code: -1, stdout, stderr: String((e && e.message) || e) });
    });
    proc.on('close', (code) => {
      done({ ok: code === 0, code, stdout, stderr });
    });
    if (opts.onSpawn) opts.onSpawn(proc);
  });
}

module.exports = { runFFmpeg };
