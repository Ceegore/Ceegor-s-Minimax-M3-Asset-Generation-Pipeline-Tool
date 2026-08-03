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
    // M-018 (hhhhu3 audit): the origin allowlist policy must survive
    // redirects — build it once and apply it to the initial URL and to
    // every hop.
    const policy = { allowedOrigins: opts.allowedOrigins };
    validateDownloadUrl(url, policy);
    await fsp_mkdir(path.dirname(destPath));

    const result = await downloadWithRedirects(url, tmpPath, config, 0, ac.signal, policy);
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
function downloadWithRedirects(url, tmpPath, config, hops, signal, policy) {
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
    // M-018 (hhhhu3 audit): apply the origin allowlist to EVERY hop.
    try { validated = validateDownloadUrl(url, policy); } catch (e) { reject(e); return; }

    const req = https.get(validated.href, {
      timeout: config.connectTimeoutMs,
      headers: { 'user-agent': 'MiniMaxAssetTool-Setup/1.0' },
    }, (res) => {
      // M-019 (hhhhu3 audit): the response arrived — the headers budget no
      // longer applies.
      if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        res.resume();
        if (!location) {
          detachReqListeners();
          reject(new Error('Redirect with no Location header.'));
          return;
        }
        const nextUrl = new URL(location, url).href;
        // Revalidate the redirect target against the SAME policy (M-018).
        try { validateDownloadUrl(nextUrl, policy); } catch (e) { detachReqListeners(); reject(e); return; }
        detachReqListeners();
        downloadWithRedirects(nextUrl, tmpPath, config, hops + 1, signal, policy).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        detachReqListeners();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }

      // Content-length early cap
      const declared = parseInt(res.headers['content-length'] || '0', 10);
      if (declared > config.maxBytes) {
        res.resume();
        detachReqListeners();
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
        detachReqListeners();
        out.destroy();
        res.destroy();
        reject(err);
      }

      // H-011: abort signal destroys the response stream.
      // M-019 (hhhhu3 audit): the listener is detached again once the stream
      // settles so long-lived AbortControllers don't accumulate handlers.
      let onAbortRes = null;
      if (signal) {
        onAbortRes = () => fail(new Error('Download aborted (overall timeout).'));
        if (signal.aborted) { fail(new Error('Download aborted.')); return; }
        signal.addEventListener('abort', onAbortRes, { once: true });
      }
      const detachResAbort = () => {
        if (onAbortRes && signal) {
          try { signal.removeEventListener('abort', onAbortRes); } catch (_) {}
          onAbortRes = null;
        }
      };

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
          detachResAbort();
          detachReqListeners();
          resolve({ sha256: hash.digest('hex'), bytes: downloaded });
        });
      });
      out.on('error', (e) => fail(e));
      res.on('error', (e) => fail(e));
      res.on('close', detachResAbort);
    });

    // M-019 (hhhhu3 audit): enforce the headers timeout — the server must
    // start responding within headersTimeoutMs. Node's socket `timeout`
    // option alone only covers socket inactivity, not a connected-but-silent
    // server holding the request open.
    let headersTimer = setTimeout(() => {
      req.destroy(new Error(`No response headers within ${config.headersTimeoutMs}ms.`));
    }, config.headersTimeoutMs);
    headersTimer.unref?.();

    // M-019 (hhhhu3 audit): request-level abort listeners are tracked so they
    // can be detached when the request settles (success, failure, redirect).
    let onAbortReq = null;
    const detachReqListeners = () => {
      if (onAbortReq && signal) {
        try { signal.removeEventListener('abort', onAbortReq); } catch (_) {}
        onAbortReq = null;
      }
      req.removeListener('timeout', onReqTimeout);
      req.removeListener('error', onReqError);
    };
    const onReqTimeout = () => {
      if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }
      req.destroy();
      reject(new Error('Connection timed out.'));
    };
    const onReqError = (e) => {
      if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }
      reject(e);
    };
    req.on('timeout', onReqTimeout);
    req.on('error', onReqError);
    // H-011: abort signal also destroys the request.
    if (signal) {
      onAbortReq = () => { req.destroy(); reject(new Error('Download aborted (overall timeout).')); };
      if (signal.aborted) { req.destroy(); reject(new Error('Download aborted.')); return; }
      signal.addEventListener('abort', onAbortReq, { once: true });
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
