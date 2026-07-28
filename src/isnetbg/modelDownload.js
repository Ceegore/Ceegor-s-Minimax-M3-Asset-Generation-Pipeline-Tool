// src/isnetbg/modelDownload.js
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { getModel, resolveModelKey, DEFAULT_MODEL } = require('./modelRegistry');
const { findModelPath } = require('./binaryDiscovery');

let activeDownload = null;

// Hard caps so a misbehaving mirror can't hang the UI forever or fill the
// disk with a runaway response (H7-014).
const MAX_REDIRECTS = 5;          // total redirect budget per download
const RESPONSE_TIMEOUT_MS = 60 * 1000;   // no response headers/body for 60s
const OVERALL_TIMEOUT_MS = 20 * 60 * 1000; // hard ceiling for the whole download
const MAX_MODEL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB guard

// followRedirects resolves the final non-3xx response stream. The redirect
// budget is now DECREMENTED per hop (the earlier version recursed without
// decrementing, which made a redirect loop unbounded — H7-014). Sockets are
// given an idle timeout so a stalled mirror can't hang the promise.
function followRedirects(url, maxRedirects = MAX_REDIRECTS, overallDeadline) {
  return new Promise((resolve, reject) => {
    function get(target, remaining) {
      if (remaining < 0) return reject(new Error('Too many redirects'));
      const req = https.get(target, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const next = res.headers.location;
          res.resume(); // drain + free the redirect response
          if (!next) return reject(new Error('Redirect response missing Location header'));
          return get(new URL(next, target).toString(), remaining - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${target}`));
        }
        resolve(res);
      });
      // Idle timeout: no headers or no body chunk for RESPONSE_TIMEOUT_MS.
      req.setTimeout(RESPONSE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Response timed out after ${RESPONSE_TIMEOUT_MS}ms (no data from ${target})`));
      });
      req.on('error', reject);
      // Hard overall deadline so a slow-but-steady mirror can't run forever.
      if (overallDeadline) {
        const left = overallDeadline - Date.now();
        if (left <= 0) { req.destroy(new Error('Download exceeded the overall time budget.')); }
      }
    }
    get(url, maxRedirects);
  });
}

/**
 * KGO7-017: delete orphaned `<model>.onnx.tmp-<pid>-<uuid>` files.
 *
 * The download path unlinks its temp on a caught rejection, but a hard
 * process kill (or closing the app mid-download) leaves the partial file
 * behind forever — measured on 2026-07-27: a 161 MB
 * `isnet-general-use.onnx.tmp-25876-0fcb71cf…` sitting in bin/models, and
 * `npm run check` / `check:deps` / `verify:release` all green with it there.
 *
 * Only sweeps temps older than `maxAgeMs` so a download in flight in
 * another process is never touched.
 *
 * @param {string} dir
 * @param {number} [maxAgeMs] default 6 h
 * @returns {{ removed: string[], failed: string[] }}
 */
function sweepStaleTemps(dir, maxAgeMs = 6 * 60 * 60 * 1000) {
  const removed = [];
  const failed = [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return { removed, failed }; }
  for (const name of entries) {
    if (!/\.tmp-\d+-[0-9a-f-]{8,}$/i.test(name)) continue;
    const p = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs < maxAgeMs) continue;
      fs.unlinkSync(p);
      removed.push(p);
    } catch (e) {
      failed.push(p + ': ' + ((e && e.message) || e));
    }
  }
  return { removed, failed };
}

async function downloadModel(modelKey, onProgress) {
  const resolvedKey = resolveModelKey(modelKey);
  const m = getModel(resolvedKey);

  if (!m.url) {
    return { ok: false, error: `Model "${resolvedKey}" does not support auto-download.` };
  }

  if (activeDownload) {
    return { ok: false, error: 'A model download is already in progress.' };
  }

  activeDownload = resolvedKey;

  try {
    // Determine destination path
    const assetPaths = require('../assetPaths');
    const destPath = assetPaths.resolveAsset('models', m.file);

    const tmp = destPath + '.tmp-' + process.pid + '-' + crypto.randomUUID();

    const overallDeadline = Date.now() + OVERALL_TIMEOUT_MS;
    const res = await followRedirects(m.url, MAX_REDIRECTS, overallDeadline);
    // statusCode === 200 is guaranteed by followRedirects at this point.

    const total = parseInt(res.headers['content-length'] || '0', 10);
    // Prefer sha256 (the registry's modern integrity field); fall back to the
    // legacy md5 for back-compat with models that only record one.
    const wantSha256 = m.sha256 || null;
    const wantMd5 = m.md5 || null;
    const sha = wantSha256 ? crypto.createHash('sha256') : null;
    const md5 = wantMd5 ? crypto.createHash('md5') : null;

    // Track the write stream so a reject (network reset, disk full) can destroy
    // it + unlink the temp file. The prior version only rejected the promise,
    // leaking the open file handle and leaving the .tmp-* file on disk on every
    // failed BiRefNet download.
    let out = null;
    try {
      await new Promise((resolve, reject) => {
        out = fs.createWriteStream(tmp);
        let downloaded = 0;
        let lastProgressTime = 0;

        // Overall timeout watchdog: kills the response if the download
        // exceeds OVERALL_TIMEOUT_MS even when data keeps trickling in.
        const watchdog = setTimeout(() => {
          reject(new Error('Download exceeded the overall time budget.'));
        }, Math.max(0, overallDeadline - Date.now()));
        watchdog.unref();

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (sha) sha.update(chunk);
          if (md5) md5.update(chunk);

          // Size guard: refuse to keep writing past MAX_MODEL_BYTES so a
          // malicious/misconfigured mirror can't fill the disk.
          if (downloaded > MAX_MODEL_BYTES) {
            reject(new Error(`Download exceeded the ${MAX_MODEL_BYTES} byte size guard.`));
            try { res.destroy(); } catch (_) {}
            return;
          }

          const now = Date.now();
          if (now - lastProgressTime >= 500 || (total && downloaded === total)) {
            lastProgressTime = now;
            if (typeof onProgress === 'function') {
              try {
                onProgress({ downloaded, total });
              } catch (_) {}
            }
          }
        });

        res.pipe(out);
        out.on('finish', () => {
          clearTimeout(watchdog);
          out.close(() => { resolve(); });
        });
        out.on('error', (e) => { clearTimeout(watchdog); reject(e); });
        res.on('error', (e) => { clearTimeout(watchdog); reject(e); });
      });
    } catch (streamErr) {
      // Clean up on any stream error so a reset mid-download doesn't leak the
      // temp file or the write-stream handle.
      try { if (out) out.destroy(); } catch (_) {}
      try { res.destroy(); } catch (_) {}
      try { await fsp.unlink(tmp); } catch (_) {}
      throw streamErr;
    }

    // Integrity check: sha256 wins if both are present (stronger).
    if (sha) {
      const actual = sha.digest('hex');
      if (actual.toLowerCase() !== wantSha256.toLowerCase()) {
        try { await fsp.unlink(tmp); } catch (_) {}
        throw new Error('SHA-256 checksum mismatch — download corrupted, please retry.');
      }
    } else if (md5) {
      const actualMd5 = md5.digest('hex');
      if (actualMd5 !== wantMd5) {
        try { await fsp.unlink(tmp); } catch (_) {}
        throw new Error('Checksum mismatch — download corrupted, please retry.');
      }
    }

    await fsp.rename(tmp, destPath);
    return { ok: true, path: destPath };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    activeDownload = null;
  }
}

module.exports = {
  downloadModel,
  sweepStaleTemps,
  // Exposed for tests so the constants can be asserted without magic numbers.
  _constants: { MAX_REDIRECTS, RESPONSE_TIMEOUT_MS, OVERALL_TIMEOUT_MS, MAX_MODEL_BYTES },
};
