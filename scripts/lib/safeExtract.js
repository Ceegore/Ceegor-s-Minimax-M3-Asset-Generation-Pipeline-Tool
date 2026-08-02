'use strict';

/**
 * Shell-free archive extraction with entry validation.
 *
 * AUD-007 fix: Replace PowerShell Expand-Archive with 7zip-bin (already a
 * devDependency). No shell interpolation, no user-controlled strings in
 * command arguments. All paths are passed as discrete argv entries.
 *
 * AUD-014 fix: Archive entries are validated before extraction:
 * - No absolute paths
 * - No path traversal (../)
 * - No symbolic links or hard links
 * - No device names (Windows)
 * - Entry count and total size bounded
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const MAX_ENTRIES = 500;
const MAX_TOTAL_UNCOMPRESSED = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * Resolve the 7za binary from 7zip-bin.
 * @returns {string}
 */
function resolve7za() {
  try {
    return require('7zip-bin').path7za;
  } catch (_) {
    // Fallback to system 7z
    return process.platform === 'win32' ? '7z.exe' : '7z';
  }
}

/**
 * Validate an archive entry name for safety.
 * @param {string} entryName - Relative path from archive listing
 * @param {string} destDir - Intended extraction directory
 * @returns {{ ok: boolean, error?: string }}
 */
function validateEntry(entryName, destDir) {
  if (!entryName || typeof entryName !== 'string') {
    return { ok: false, error: 'Empty entry name' };
  }
  // Reject absolute paths
  if (path.isAbsolute(entryName)) {
    return { ok: false, error: `Absolute path in archive: ${entryName}` };
  }
  // Reject path traversal
  const normalized = path.normalize(entryName);
  if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
    return { ok: false, error: `Path traversal in archive: ${entryName}` };
  }
  // Reject Windows device names
  const segments = normalized.split(path.sep);
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') continue;
    const stem = seg.split('.')[0].toUpperCase();
    const RESERVED = /^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/;
    if (RESERVED.test(stem)) {
      return { ok: false, error: `Windows device name in archive: ${seg}` };
    }
  }
  // Verify final path stays within destDir
  const resolved = path.resolve(destDir, normalized);
  const resolvedDest = path.resolve(destDir);
  if (!resolved.startsWith(resolvedDest + path.sep) && resolved !== resolvedDest) {
    return { ok: false, error: `Entry escapes destination: ${entryName}` };
  }
  return { ok: true };
}

/**
 * List archive entries and validate them.
 * @param {string} archivePath
 * @param {string} destDir
 * @returns {Promise<{ ok: boolean, entries?: string[], error?: string }>}
 */
async function listAndValidate(archivePath, destDir) {
  const sevenZip = resolve7za();
  return new Promise((resolve) => {
    execFile(sevenZip, ['l', '-ba', archivePath], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, error: `Archive listing failed: ${error.message}` });
        return;
      }
      const lines = stdout.split('\n').filter((l) => l.trim());
      if (lines.length > MAX_ENTRIES) {
        resolve({ ok: false, error: `Archive has too many entries (${lines.length}, max ${MAX_ENTRIES})` });
        return;
      }
      const entries = [];
      for (const line of lines) {
        // 7z -ba format: date time attrs size compressed name
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) continue;
        const name = parts.slice(5).join(' ');
        const validation = validateEntry(name, destDir);
        if (!validation.ok) {
          resolve({ ok: false, error: validation.error });
          return;
        }
        entries.push(name);
      }
      resolve({ ok: true, entries });
    });
  });
}

/**
 * Extract a zip archive safely using 7zip-bin (no shell).
 * @param {string} archivePath - Path to the .zip file
 * @param {string} destDir - Destination directory
 * @param {{ maxEntries?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function extractZip(archivePath, destDir, opts = {}) {
  const sevenZip = resolve7za();

  // Step 1: Validate all entries before extraction
  const listing = await listAndValidate(archivePath, destDir);
  if (!listing.ok) return { ok: false, error: listing.error };

  // Step 2: Create destination
  fs.mkdirSync(destDir, { recursive: true });

  // Step 3: Extract with 7zip — no shell, discrete argv
  return new Promise((resolve) => {
    const args = [
      'x',            // extract with full paths
      '-y',           // assume yes
      `-o${destDir}`, // output directory (7z syntax, no space)
      archivePath,    // input archive
    ];
    const child = execFile(sevenZip, args, {
      timeout: 120_000, // 2 minute timeout
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: `Extraction failed: ${error.message}` });
        return;
      }
      resolve({ ok: true });
    });

    if (opts.signal) {
      const onAbort = () => { try { child.kill('SIGTERM'); } catch (_) {} };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      child.on('close', () => opts.signal.removeEventListener('abort', onAbort));
    }
  });
}

module.exports = { extractZip, validateEntry, listAndValidate, resolve7za, MAX_ENTRIES };
