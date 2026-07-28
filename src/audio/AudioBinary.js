// src/audio/AudioBinary.js
// Auflösung des ffmpeg-Binärpfads. Cache, damit wiederholte Probes
// den Filesystem nicht unnötig belasten.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let cachedBinaryPath = null;

// In packaged Electron apps the `ffmpeg-static` package lives
// inside `app.asar`, which Electron exposes as a virtual read-only
// filesystem. spawn() cannot execute a binary from inside the
// asar (Windows returns ENOENT / EACCES). electron-builder
// transparently extracts these binaries to `app.asar.unpacked`
// (see the `asarUnpack` config in package.json). This helper
// resolves the asar-internal path to its real on-disk twin.
function resolveAsarPath(p) {
  if (!p) return p;
  // Replace the LAST occurrence of `.asar` with `.asar.unpacked`.
  // We use a regex that matches `app.asar` (or any `.asar`) at
  // any position in the path. The `g` flag would match all, but
  // we only want the asar segment nearest the binary.
  const m = p.match(/^(.*\.asar)[\\/](.+)$/);
  if (!m) return p;
  return path.join(m[1] + '.unpacked', m[2]);
}

function findBinary() {
  if (cachedBinaryPath && fs.existsSync(cachedBinaryPath)) return cachedBinaryPath;

  // 0. Writable override or manual package bin (takes highest precedence)
  const assetPaths = require('../assetPaths');
  const BIN_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const override = assetPaths.resolveAsset('', BIN_NAME);
  if (override && fs.existsSync(override)) {
    cachedBinaryPath = override;
    return override;
  }

  // 1. Bundled binary from `ffmpeg-static`. The package returns the
  // absolute path to the prebuilt exe on the current platform.
  // In a packaged build that path lives inside `app.asar` — Electron
  // fakes the read-only mount, so fs.existsSync returns true, but
  // spawn() cannot execute a binary that is not on disk. We therefore
  // prefer the unpacked twin before falling back to the asar path.
  try {
    const bundled = require('ffmpeg-static');
    if (bundled) {
      const unpacked = resolveAsarPath(bundled);
      if (unpacked !== bundled && fs.existsSync(unpacked)) {
        cachedBinaryPath = unpacked;
        return unpacked;
      }
      if (fs.existsSync(bundled)) {
        cachedBinaryPath = bundled;
        return bundled;
      }
    }
  } catch (_) { /* not installed */ }

  // 2. Dev fallback: `where ffmpeg` / `which ffmpeg` on PATH.
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(whichCmd, ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const found = r.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
      if (found) {
        cachedBinaryPath = found;
        return found;
      }
    }
  } catch (_) { /* ignore */ }

  // 3. Production fallback: ./bin/ffmpeg[.exe] next to the package root.
  try {
    const candidates = [
      path.join(__dirname, '..', '..', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
      process.resourcesPath ? path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : null,
    ].filter(Boolean);
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        cachedBinaryPath = p;
        return p;
      }
    }
  } catch (_) { /* ignore */ }

  return null;
}

function isAvailable() {
  return !!findBinary();
}

function resetCache() {
  cachedBinaryPath = null;
}

module.exports = { findBinary, isAvailable, resetCache, resolveAsarPath };
