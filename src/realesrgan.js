// src/realesrgan.js
// Wrapper around the `realesrgan-ncnn-vulkan` command-line tool from
// https://github.com/xinntao/Real-ESRGAN. BSD-3-Clause license
// (commercial use is fine, attribution appreciated).
//
// Release packages bundle the binary and its model files. Development
// checkouts may instead provide it through `bin/` or PATH. If the binary is
// missing, the renderer falls back to its built-in multi-step
// canvas/createImageBitmap path so the tool is never blocked.
//
// Detection order (first match wins, cached after first success):
//   1. Cached path from a previous successful detection (this run).
//   2. `where realesrgan-ncnn-vulkan.exe` (Windows) /
//      `which realesrgan-ncnn-vulkan` (POSIX) on PATH.
//   3. `./bin/realesrgan-ncnn-vulkan[.exe]` next to the package root.

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const jobRegistry = require('./jobRegistry');

const BINARY_NAME = process.platform === 'win32'
  ? 'realesrgan-ncnn-vulkan.exe'
  : 'realesrgan-ncnn-vulkan';

let cachedBinaryPath = null;
let cachedBinaryVersion = null;

function findBinary() {
  if (cachedBinaryPath && fs.existsSync(cachedBinaryPath)) return cachedBinaryPath;

  // 1. System PATH lookup via `where` / `which`. On a fresh shell the
  // PATH may not include the binary's directory yet, so we also probe
  // the well-known bundled location below.
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(whichCmd, [BINARY_NAME], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const found = r.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
      if (found) {
        cachedBinaryPath = found;
        return found;
      }
    }
  } catch { /* ignore */ }

  // 2. Writable override or bundled fallback
  const assetPaths = require('./assetPaths');
  const p = assetPaths.resolveAsset('', BINARY_NAME);
  if (p && fs.existsSync(p)) {
    cachedBinaryPath = p;
    return p;
  }
  return null;
}

function isAvailable() {
  return findBinary() !== null;
}

function getBinaryPath() {
  return findBinary();
}

// Run the binary on a single image. Returns a Promise that resolves
// with { ok, code, stderr, outputPath } on completion.
//
// The binary's stdout is mostly progress lines; we don't surface
function cleanStderr(raw) {
  if (!raw) return '';
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const filtered = lines.filter((l) => !/^\[\d+\s+.*?\]/.test(l) && !/queueC=/i.test(l) && !/^\s*\d+(?:[.,]\d+)?\s*%\s*$/.test(l));
  return filtered.length ? filtered.join('\n') : lines.join('\n');
}

function getPngDimensionsSync(filePath) {
  if (!filePath || typeof filePath !== 'string' || !fs.existsSync(filePath)) return null;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
  } catch (_) {}
  return null;
}

// Run the binary on a single image. Returns a Promise that resolves
// with { ok, code, stderr, outputPath } on completion.
function run(srcPath, dstPath, opts = {}) {
  const binary = findBinary();
  if (!binary) {
    return Promise.resolve({
      ok: false,
      code: -1,
      stderr: 'The bundled Real-ESRGAN component is missing. Reinstall the complete release package.',
      outputPath: null,
    });
  }

  return new Promise((resolveP) => {
    let tempSrc = null;
    const cleanupTemp = () => {
      if (tempSrc) {
        try { fs.unlinkSync(tempSrc); } catch (_) {}
        tempSrc = null;
      }
    };

    const startSpawn = (inputPath) => {
      const REALESRGAN_MODELS = ['realesrgan-x4plus', 'realesrgan-x4plus-anime', 'realesr-animevideov3'];
      const model = (typeof opts.model === 'string' && REALESRGAN_MODELS.includes(opts.model))
        ? opts.model
        : 'realesrgan-x4plus';
      // KGO8-008: `String(opts.scale || 4)` put ANY number straight into the
      // binary's -s flag. scale:99 on a 128×96 source returned ok:true after
      // producing a 94 MB, ~120-megapixel PNG. The binary only ships x2/x3/x4
      // weights, so anything else is a caller bug: clamp to the supported set
      // instead of forwarding it. (No shell-injection risk — spawn takes an
      // argv array — but an unbounded -s is still a resource bomb.)
      const REALESRGAN_SCALES = [1, 2, 3, 4];
      const rawScale = Math.round(Number(opts.scale));
      const scale = String(REALESRGAN_SCALES.includes(rawScale) ? rawScale : 4);
      const fmt = 'png';
      const args = [
        '-i', inputPath,
        '-o', dstPath,
        '-n', model,
        '-s', scale,
        '-f', fmt,
      ];
    // Advanced opts (per-feature advanced pipeline settings):
    //   -t <tile>  tile size for VRAM-constrained GPUs. 0 = auto
    //              (the binary's default). Values <32 are rejected
    //              by the binary; sanitise at the state layer so
    //              only the whitelist [0,32,64,128,256,512,1024,2048]
    //              reaches here.
    //   -x         enable TTA (test-time augmentation) mode. Boosts
    //              quality at the cost of ~2× runtime. Off by default.
    //   -g <id>    pin to a specific GPU. 'auto' (the default) lets
    //              the binary pick. Only forwarded when the user
    //              explicitly chose a numeric id, so the default
    //              spawn argv stays unchanged for users who never
    //              opened the advanced overlay.
    //   -j l:p:s   thread count for load/proc/save. Power-user knob;
    //              not exposed in the overlay (the default 1:2:2 is
    //              optimal for almost every workload) but honoured if
    //              a caller passes it.
    // tileSize must be a finite number in [0, 4096] (the renderer's
    // documented Custom-input range). Only emit -t when the value is
    // finite and in-range; tileSize=0 means "auto" and the binary's
    // default — do NOT emit -t. The state.js whitelist mirror is the
    // first defence; this wrapper check is the second.
    if (Number.isFinite(Number(opts.tileSize))) {
      const t = Math.round(Number(opts.tileSize));
      // The binary rejects a tile size below 32 ("invalid tilesize
      // argument"), which would bubble up as a hard Real-ESRGAN failure
      // and silently downgrade every upscale to the canvas pipeline.
      // Only emit -t for a value the binary accepts ([32, 4096]);
      // 0 / 1..31 / out-of-range all drop the flag (binary default = auto).
      // The state layer already maps 1..31 → 0, so this is the defensive
      // mirror for a hand-edited state.json or a programmatic caller.
      if (t >= 32 && t <= 4096) {
        args.push('-t', String(t));
      }
    }
    if (opts.ttaMode === true) {
      args.push('-x');
    }
    // gpuId resolution. The advanced overlay sends opts.gpuId as
    // 'auto' | '0' | '1' | '2' | '3'. A legacy renderer may send
    // opts.gpu as a number; that path is honoured only when no
    // opts.gpuId was supplied at all (so a user's explicit 'auto' is
    // respected).
    // Whitelist mirror: accept GPU ids in [0, 15] (the overlay help text
    // invites "4 for a 5th GPU", and a real multi-GPU rig can have more
    // than 4 devices). 'auto' (the default) never emits -g. An id
    // outside the range is dropped (auto); an id in range but absent
    // on this machine makes the binary error → canvas fallback.
    if (typeof opts.gpuId === 'string' && /^\d+$/.test(opts.gpuId)
        && Number(opts.gpuId) >= 0 && Number(opts.gpuId) <= 15) {
      args.push('-g', opts.gpuId);
    } else if (opts.gpuId === undefined && opts.gpu !== undefined && opts.gpu !== null) {
      // Legacy shim: accept a number here too, validated against the same
      // [0, 15] range so a corrupted caller can't pin a nonsensical device.
      const n = Number(opts.gpu);
      if (Number.isInteger(n) && n >= 0 && n <= 15) args.push('-g', String(n));
    }
    const { getSafeThreadCount, getSafeProcessEnv } = require('./cpuGuard');
    const safeThreads = getSafeThreadCount();
    if (typeof opts.threads === 'string' && /^\d+:\d+:\d+$/.test(opts.threads)) {
      args.push('-j', opts.threads);
    } else {
      args.push('-j', `1:${safeThreads}:2`);
    }

    // KGO8-008: announce silent substitutions (unknown model key, unsupported
    // scale) instead of hiding them. Both used to be swapped for the default
    // with ok:true, so the caller could not tell what actually ran. This text
    // is promoted into the result's `warnings[]` by the IPC legacy adapter.
    let stderr = '';
    if (typeof opts.model === 'string' && opts.model && opts.model !== model) {
      stderr += `Unknown upscale model "${opts.model}" — using "${model}" instead.\n`;
    }
    if (opts.scale != null && String(Math.round(Number(opts.scale))) !== scale) {
      stderr += `Unsupported upscale factor ${opts.scale}× — using ${scale}× (supported: 1, 2, 3, 4).\n`;
    }
    let proc;
    try {
      proc = spawn(binary, args, { windowsHide: true, env: getSafeProcessEnv() });
    } catch (err) {
      resolveP({ ok: false, code: -1, stderr: String(err.message || err), outputPath: null });
      return;
    }
    // KGO5-023: lower priority so the OS stays responsive during heavy upscale.
    // KGO6-005: use the proper BELOW_NORMAL constant (numeric 1 fell in the NORMAL band).
    try { if (process.platform === 'win32') { const _os = require('os'); _os.setPriority(proc.pid, _os.constants.priority.PRIORITY_BELOW_NORMAL); } } catch (_) {}
    // R6.6.2: register with the shared jobRegistry so the renderer can
    // cancel this spawn mid-flight via job:cancel IPC.
    if (opts.jobId) {
      jobRegistry.register(opts.jobId, proc, { backend: 'realesrgan', srcPath, dstPath });
    }
    // X3-05: Real-ESRGAN ncnn prints progress percentages to STDERR (not
    // stdout — stdout stays empty), and on a comma-decimal locale they read
    // "12,34%". Parse from stderr and normalise the comma so opts.onProgress
    // gets a real 0..100 number and the pipeline card's determinate bar can
    // actually move. Best-effort: a malformed/missing line just means no
    // update (the card falls back to indeterminate). The same stderr chunks
    // still accumulate into `stderr` below for error reporting.
    const onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;
    let lastPct = -1;
    proc.stderr.on('data', (b) => {
      const txt = b.toString('utf8');
      stderr += txt;
      if (!onProgress) return;
      // Match the LAST percentage in the chunk (a chunk may contain several
      // lines). Accept both dot and comma decimal separators.
      const matches = txt.match(/(\d+(?:[.,]\d+)?)\s*%/g);
      if (matches && matches.length) {
        const last = matches[matches.length - 1];
        const pct = parseFloat(last.replace(',', '.'));
        if (Number.isFinite(pct) && pct !== lastPct && pct >= 0 && pct <= 100) {
          lastPct = pct;
          try { onProgress(pct); } catch (_) { /* best-effort */ }
        }
      }
    });
    proc.on('error', (err) => {
      // ENOENT etc. — the binary disappeared between find and spawn.
      cachedBinaryPath = null;
      if (opts.jobId) jobRegistry.unregister(opts.jobId, proc);
      cleanupTemp();
      resolveP({ ok: false, code: -1, stderr: String(err.message || err), outputPath: null });
    });
    proc.on('close', (code) => {
      if (opts.jobId) jobRegistry.unregister(opts.jobId, proc);
      cleanupTemp();
      if (code === 0 && fs.existsSync(dstPath)) {
        // KGO-007 fix: emit a final 100% progress event so the bar completes.
        if (onProgress && lastPct < 100) {
          try { onProgress(100); } catch (_) {}
        }
        resolveP({ ok: true, code, stderr, outputPath: dstPath });
      } else {
        const cleaned = cleanStderr(stderr);
        resolveP({ ok: false, code, stderr: cleaned || `realesrgan exited with code ${code}`, outputPath: null });
      }
    });
  };

    const dims = getPngDimensionsSync(srcPath);
    if (dims && (dims.width <= 8 || dims.height <= 8)) {
      try {
        const { sharp } = require('./imageOptimizer/formatUtils');
        if (typeof sharp === 'function') {
          // KGO4-008 fix: resize directly to the expected final dimensions
          // (source * scale) instead of pre-resizing to an arbitrary 16px
          // minimum per-axis (which distorted aspect ratio and doubled the
          // effective scale when the model's -s was applied on top).
          const scaleNum = Number(opts.scale || 4);
          const finalW = Math.max(1, Math.round((dims.width || 1) * scaleNum));
          const finalH = Math.max(1, Math.round((dims.height || 1) * scaleNum));
          sharp(srcPath)
            .resize({ width: finalW, height: finalH, fit: 'fill', kernel: 'lanczos3' })
            .png()
            .toFile(dstPath)
            .then(() => resolveP({ ok: true, code: 0, stderr: '', outputPath: dstPath }))
            .catch(() => startSpawn(srcPath));
          return;
        }
      } catch (_) { /* fallback */ }
    }
    startSpawn(srcPath);
  });
}

// One-shot probe: run with --help to check that the binary is
// actually working (not just present on disk). Returns a string
// version (or "" if unknown) so the renderer can display "Real-ESRGAN
// v0.2.5.0 detected" if the user is curious. Best-effort: never
// throws.
function probeVersion() {
  if (cachedBinaryVersion !== null) return cachedBinaryVersion;
  const binary = findBinary();
  if (!binary) { cachedBinaryVersion = ''; return ''; }
  try {
    const r = spawnSync(binary, ['--help'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const out = (r.stdout || '') + '\n' + (r.stderr || '');
    const m = out.match(/realesrgan[- ]?ncnn[- ]?vulkan[^\n]*?v?(\d+\.\d+\.\d+(?:\.\d+)?)/i);
    cachedBinaryVersion = m ? m[1] : '';
    return cachedBinaryVersion;
  } catch {
    cachedBinaryVersion = '';
    return '';
  }
}

// Forget the cached "is the binary installed?" answer. The main
// process calls this after a successful in-app install of the
// binary (upscale:realesrgan:download), so the next probe re-runs
// the detection and finds the new file.
function resetCache() {
  cachedBinaryPath = null;
  cachedBinaryVersion = null;
}

module.exports = { isAvailable, getBinaryPath, run, probeVersion, resetCache };
