// main/services/InstallDownloadService.js
// One-click installer for Real-ESRGAN: downloads the v0.2.5.0 Windows zip
// from GitHub and extracts it via PowerShell into ./bin/.
//
// The correct asset name for v0.2.5.0 is dated
// (`realesrgan-ncnn-vulkan-20220424-windows.zip`). If the upstream asset is
// ever removed, the "Pick file..." button
// (main/services/InstallPickCopyService.js) is the fallback.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { httpsGetFollowingRedirects } = require('./HttpsRedirect');
const { createProgressEmitter } = require('./DownloadProgressEmitter');
const { expandArchive } = require('../utils/PowerShellSpawner');

const RE_ESRGAN_DOWNLOAD_URL =
  'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip';

// Pinned SHA-256 of the known-good zip, verified by downloading the asset
// above and hashing it independently with two separate tools (sha256sum +
// openssl dgst -sha256). If the upstream asset is ever legitimately replaced
// (new release version -> update RE_ESRGAN_DOWNLOAD_URL and this hash
// together), a mismatch here means the bytes are NOT what we expect — abort
// rather than extract and later spawn an unverified native binary.
const RE_ESRGAN_ZIP_SHA256 = 'abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d';

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * @typedef {object} DownloadProgress
 * @property {'download' | 'extract'} phase
 * @property {number} downloaded
 * @property {number} total
 * @property {'starting' | 'started' | 'progress' | 'done' | 'error'} status
 */

/**
 * Downloads Real-ESRGAN and extracts it into `<appRoot>/bin/`. Progress is
 * streamed to the renderer via `send`.
 *
 * @param {string} appRoot                  __dirname
 * @param {(p: DownloadProgress) => void} send
 * @param {{ expectedSha256?: string }} [deps] DI seam (mirrors the
 *   `{ get }` seam in HttpsRedirect.js): lets tests verify the
 *   match/mismatch branches without needing the real 45MB asset.
 *   Production callers never pass this — it defaults to the real
 *   pinned hash.
 * @returns {Promise<{ok: boolean, binDir?: string, error?: string}>}
 */
async function downloadRealesrgan(appRoot, send, deps = {}) {
  const expectedSha256 = deps.expectedSha256 || RE_ESRGAN_ZIP_SHA256;
  const tmpZip = path.join(os.tmpdir(), `realesrgan-${Date.now()}.zip`);

  const safeSend = (data) => { try { send(data); } catch (_) {} };

  try {
    // ---- Download ----
    safeSend({ phase: 'download', downloaded: 0, total: 0, status: 'starting' });
    await new Promise((resolve, reject) => {
      httpsGetFollowingRedirects(RE_ESRGAN_DOWNLOAD_URL).then((res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} from ${RE_ESRGAN_DOWNLOAD_URL}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        safeSend({ phase: 'download', downloaded: 0, total, status: 'started' });
        const file = fs.createWriteStream(tmpZip);
        const emit = createProgressEmitter(
          (data) => safeSend({ phase: 'download', status: 'progress', ...data }),
          () => ({ phase: 'download', downloaded: 0, total, status: 'started' })
        );
        let downloaded = 0;
        let aborted = false;
        // Wire res.on('error'). Node's stream.pipe() does NOT propagate
        // source errors, so a network failure mid-download would leave `file`
        // unclosed, `finish` never fired, and the surrounding Promise never
        // settled — the UI would freeze on "download: started" forever. Also
        // destroy the destination stream + clean up the tmp file on any error.
        const cleanup = () => {
          if (aborted) return;
          aborted = true;
          try { file.destroy(); } catch (_) {}
          try { res.destroy(); } catch (_) {}
          try { fs.unlinkSync(tmpZip); } catch (_) {}
        };
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          emit(downloaded, total);
        });
        res.on('error', (err) => {
          cleanup();
          reject(new Error('Download stream failed: ' + (err && err.message || err)));
        });
        // 30-minute download timeout. A hung socket (no error, no data) would
        // otherwise leave the promise pending forever. The timeout is generous
        // — the 200 MB Real-ESRGAN zip downloads in 1-5 min on most connections.
        const downloadTimer = setTimeout(() => {
          cleanup();
          reject(new Error('Download timed out after 30 minutes.'));
        }, 30 * 60 * 1000);
        downloadTimer.unref();
        const clearTimer = () => clearTimeout(downloadTimer);
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          clearTimer();
          safeSend({ phase: 'download', downloaded, total, status: 'done' });
          resolve();
        }));
        file.on('error', (err) => {
          clearTimer();
          cleanup();
          reject(err);
        });
      }).catch(reject);
    }).catch((err) => {
      try { fs.unlinkSync(tmpZip); } catch (_) {}
      throw err;
    });

    // ---- Verify checksum ----
    safeSend({ phase: 'verify', downloaded: 0, total: 0, status: 'starting' });
    const actualHash = await sha256OfFile(tmpZip);
    if (actualHash.toLowerCase() !== expectedSha256.toLowerCase()) {
      try { fs.unlinkSync(tmpZip); } catch (_) {}
      return {
        ok: false,
        error: `Checksum verification failed (expected ${expectedSha256}, got ${actualHash}). `
          + 'The downloaded file was deleted and NOT extracted or run. This could mean the upstream '
          + 'release asset changed, or the download was corrupted/tampered with in transit — try again, '
          + 'or use "Pick file…" if you have a trusted copy.',
      };
    }
    safeSend({ phase: 'verify', downloaded: 0, total: 0, status: 'done' });

    // ---- Extract ----
    // Extract into a TEMP staging dir first, then move into bin/ on success.
    // Extracting directly into bin/ would leave a half-extracted bin/ on a
    // mid-extract failure (antivirus kill, disk full, UAC cancel) that mixes
    // with the retry — sometimes the half-files were the wrong size / shape
    // and the next run picked them up as "already installed".
    const assetPaths = require('../../src/assetPaths');
    const binDir = assetPaths.writableAssetsDir();
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    const stageDir = path.join(os.tmpdir(), `mmx-bin-stage-${Date.now()}`);
    safeSend({ phase: 'extract', downloaded: 0, total: 0, status: 'starting' });
    try {
      await expandArchive(tmpZip, stageDir);
      // Walk the staging dir and move every file into bin/. Using
      // move (not copy) so a multi-GB Real-ESRGAN models dir does
      // not double the disk usage. fs.cp+rm would be the fallback
      // for cross-device moves (handled at the fs layer on Node ≥16).
      const moveDir = async (src, dst) => {
        if (!fs.existsSync(src)) return;
        if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const s = path.join(src, entry.name);
          const d = path.join(dst, entry.name);
          if (entry.isDirectory()) await moveDir(s, d);
          else {
            try { await fs.promises.rename(s, d); }
            catch (e) {
              if (e && (e.code === 'EXDEV' || /cross-device/i.test(String(e.message || '')))) {
                // Cross-device: copy+delete.
                await fs.promises.cp(s, d, { force: true });
                await fs.promises.rm(s, { force: true });
              } else throw e;
            }
          }
        }
      };
      await moveDir(stageDir, binDir);

    } finally {
      // Clean up the staging dir whether extraction succeeded or
      // failed. On failure, bin/ is untouched (no partial files).
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
    }
    safeSend({ phase: 'extract', downloaded: 0, total: 0, status: 'done' });

    // ---- Cleanup ----
    try { fs.unlinkSync(tmpZip); } catch (_) {}
    return { ok: true, binDir };
  } catch (e) {
    try { fs.unlinkSync(tmpZip); } catch (_) {}
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { downloadRealesrgan, RE_ESRGAN_DOWNLOAD_URL, RE_ESRGAN_ZIP_SHA256, sha256OfFile };
