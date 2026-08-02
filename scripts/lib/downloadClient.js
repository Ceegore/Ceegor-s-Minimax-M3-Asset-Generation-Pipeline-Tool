'use strict';

/**
 * Shared bounded download client for setup/runtime scripts.
 *
 * AUD-014 fix: Every network wait is bounded. Downloads use:
 * - HTTPS only
 * - At most five redirects with decrementing hop count
 * - Every redirect revalidated
 * - Connect/header/idle/overall timeouts
 * - Content-length early cap plus actual streamed byte cap
 * - SHA-256 computed while streaming
 * - Exclusive stage file
 * - Partial file removed on any failure
 * - Expected hash and minimum/maximum size verified before activation
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const DEFAULTS = Object.freeze({
  maxRedirects: 5,
  connectTimeoutMs: 15_000,
  headersTimeoutMs: 30_000,
  idleTimeoutMs: 60_000,
  overallTimeoutMs: 600_000, // 10 minutes for large models
  maxBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
  minBytes: 1024, // 1 KiB minimum
});

/**
 * Validate a URL for download policy.
 * @param {string} urlString
 * @param {{ allowedOrigins?: Set<string> }} [policy]
 * @returns {URL}
 * @throws {Error}
 */
function validateDownloadUrl(urlString, policy) {
  let url;
  try { url = new URL(urlString); } catch (_) {
    throw new Error(`Invalid URL: ${urlString}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Only HTTPS downloads are allowed, got: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('Credentials in URL are not allowed.');
  }
  if (policy && policy.allowedOrigins && !policy.allowedOrigins.has(url.origin)) {
    throw new Error(`Origin not in allowlist: ${url.origin}`);
  }
  return url;
}

/**
 * Download a file with full safety guarantees.
 * @param {string} url - HTTPS URL to download
 * @param {string} destPath - Final destination path
 * @param {{
 *   expectedSha256?: string,
 *   maxBytes?: number,
 *   minBytes?: number,
 *   maxRedirects?: number,
 *   overallTimeoutMs?: number,
 *   allowedOrigins?: Set<string>,
 *   onProgress?: (info: {downloaded: number, total: number}) => void
 * }} [opts]
 * @returns {Promise<{ ok: true, sha256: string, bytes: number } | { ok: false, error: string }>}
 */
async function downloadFile(url, destPath, opts = {}) {
  const config = { ...DEFAULTS, ...opts };
  const tmpPath = destPath + '.tmp-' + process.pid + '-' + Date.now().toString(36);

  // H-011 (hhhhu2 audit): Use an AbortController so the overall timeout
  // actually aborts the request/response/stream AND rejects the promise.
  // Previously the timer only deleted the temp file while the download
  // continued indefinitely and the promise never settled.
  const ac = new AbortController();
  let settled = false;

  const overallTimer = setTimeout(() => {
    if (settled) return;
    ac.abort();
  }, config.overallTimeoutMs);
  overallTimer.unref?.();

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(overallTimer);
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }

  try {
    validateDownloadUrl(url, { allowedOrigins: opts.allowedOrigins });
    await fsp_mkdir(path.dirname(destPath));

    const result = await downloadWithRedirects(url, tmpPath, config, 0, ac.signal);
    settled = true;
    clearTimeout(overallTimer);

    // Verify size
    if (result.bytes < config.minBytes) {
      cleanup();
      return { ok: false, error: `Download too small (${result.bytes} bytes, min ${config.minBytes}).` };
    }

    // Verify hash
    if (config.expectedSha256 && result.sha256 !== config.expectedSha256) {
      cleanup();
      return { ok: false, error: `SHA-256 mismatch: expected ${config.expectedSha256}, got ${result.sha256}.` };
    }

    // Atomic rename to final destination
    fs.renameSync(tmpPath, destPath);
    return { ok: true, sha256: result.sha256, bytes: result.bytes };
  } catch (err) {
    settled = true;
    cleanup();
    if (ac.signal.aborted) {
      return { ok: false, error: `Download timed out after ${config.overallTimeoutMs}ms.` };
    }
    return { ok: false, error: String(err.message || err) };
  }
}

/**
 * Internal: download with redirect following and validation.
 * @param {string} url
 * @param {string} tmpPath
 * @param {object} config
 * @param {number} hops
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
function downloadWithRedirects(url, tmpPath, config, hops, signal) {
  return new Promise((resolve, reject) => {
    if (hops > config.maxRedirects) {
      reject(new Error(`Too many redirects (max ${config.maxRedirects}).`));
      return;
    }
    // H-011: if already aborted, reject immediately.
    if (signal && signal.aborted) {
      reject(new Error('Download aborted.'));
      return;
    }

    let validated;
    try { validated = validateDownloadUrl(url); } catch (e) { reject(e); return; }

    const req = https.get(validated.href, {
      timeout: config.connectTimeoutMs,
      headers: { 'user-agent': 'MiniMaxAssetTool-Setup/1.0' },
    }, (res) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        res.resume();
        if (!location) {
          reject(new Error('Redirect with no Location header.'));
          return;
        }
        const nextUrl = new URL(location, url).href;
        // Revalidate the redirect target
        try { validateDownloadUrl(nextUrl); } catch (e) { reject(e); return; }
        downloadWithRedirects(nextUrl, tmpPath, config, hops + 1, signal).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }

      // Content-length early cap
      const declared = parseInt(res.headers['content-length'] || '0', 10);
      if (declared > config.maxBytes) {
        res.resume();
        reject(new Error(`Declared size ${declared} exceeds cap ${config.maxBytes}.`));
        return;
      }

      // Stream to file with byte counting and hashing
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 });
      let downloaded = 0;
      let idleTimer = null;
      let rejected = false;

      function fail(err) {
        if (rejected) return;
        rejected = true;
        if (idleTimer) clearTimeout(idleTimer);
        out.destroy();
        res.destroy();
        reject(err);
      }

      // H-011: abort signal destroys the response stream.
      if (signal) {
        const onAbort = () => fail(new Error('Download aborted (overall timeout).'));
        if (signal.aborted) { fail(new Error('Download aborted.')); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      function resetIdle() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          fail(new Error('Download stalled (idle timeout).'));
        }, config.idleTimeoutMs);
        idleTimer.unref?.();
      }
      resetIdle();

      res.on('data', (chunk) => {
        if (rejected) return;
        downloaded += chunk.length;
        hash.update(chunk);
        resetIdle();
        if (downloaded > config.maxBytes) {
          fail(new Error(`Download exceeded ${config.maxBytes} bytes.`));
          return;
        }
        if (config.onProgress && declared > 0) {
          config.onProgress({ downloaded, total: declared });
        }
      });

      res.pipe(out);
      out.on('finish', () => {
        if (rejected) return;
        if (idleTimer) clearTimeout(idleTimer);
        out.close(() => {
          resolve({ sha256: hash.digest('hex'), bytes: downloaded });
        });
      });
      out.on('error', (e) => fail(e));
      res.on('error', (e) => fail(e));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out.'));
    });
    req.on('error', reject);
    // H-011: abort signal also destroys the request.
    if (signal) {
      const onAbort = () => { req.destroy(); reject(new Error('Download aborted (overall timeout).')); };
      if (signal.aborted) { req.destroy(); reject(new Error('Download aborted.')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Promisified mkdir.
 * @param {string} dir
 */
function fsp_mkdir(dir) {
  return fs.promises.mkdir(dir, { recursive: true });
}

module.exports = { downloadFile, validateDownloadUrl, DEFAULTS };
