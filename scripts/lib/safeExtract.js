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
  // L-001 (hhhhu2 audit): segment-aware traversal detection.
  // Reject only when a path segment is exactly '..' (parent traversal),
  // NOT names that merely start with two dots like '..foo/model.bin'.
  const normalized = path.normalize(entryName);
  const segments = normalized.split(path.sep);
  for (const seg of segments) {
    if (seg === '..') {
      return { ok: false, error: `Path traversal in archive: ${entryName}` };
    }
  }
  // Reject Windows device names
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
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
 * H-012 (hhhhu2 audit): Also enforces total uncompressed size, rejects
 * symlink/hardlink entries, and honors opts.maxEntries.
 * @param {string} archivePath
 * @param {string} destDir
 * @param {{ maxEntries?: number }} [opts]
 * @returns {Promise<{ ok: boolean, entries?: string[], error?: string }>}
 */
async function listAndValidate(archivePath, destDir, opts = {}) {
  const sevenZip = resolve7za();
  const maxEntries = opts.maxEntries || MAX_ENTRIES;
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
      if (lines.length > maxEntries) {
        resolve({ ok: false, error: `Archive has too many entries (${lines.length}, max ${maxEntries})` });
        return;
      }
      const entries = [];
      let totalUncompressed = 0;
      for (const line of lines) {
        // 7z -ba format: date time attrs size compressed name
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) continue;
        const attrs = parts[2] || '';
        const size = parseInt(parts[3] || '0', 10) || 0;
        const name = parts.slice(5).join(' ');

        // H-012: reject symlink/hardlink entries (attributes contain 'l').
        if (attrs.includes('l') || attrs.includes('L')) {
          resolve({ ok: false, error: `Symlink/hardlink entry rejected: ${name}` });
          return;
        }

        // H-012: enforce total uncompressed size.
        totalUncompressed += size;
        if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
          resolve({ ok: false, error: `Archive uncompressed size exceeds ${MAX_TOTAL_UNCOMPRESSED} bytes (zip bomb protection)` });
          return;
        }

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
 * H-012 (hhhhu2 audit): Extracts to a fresh staging directory first, then
 * atomically renames to the destination. Partial extraction is cleaned up
 * on failure. Symlinks/hardlinks are rejected. Total size is enforced.
 * @param {string} archivePath - Path to the .zip file
 * @param {string} destDir - Destination directory
 * @param {{ maxEntries?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function extractZip(archivePath, destDir, opts = {}) {
  const sevenZip = resolve7za();

  // H-012: Extract to a staging directory, not directly to destination.
  const stagingDir = destDir + '.extract-stage-' + process.pid + '-' + Date.now().toString(36);

  // Step 1: Validate all entries before extraction
  const listing = await listAndValidate(archivePath, stagingDir, { maxEntries: opts.maxEntries });
  if (!listing.ok) return { ok: false, error: listing.error };

  // Step 2: Create staging directory
  fs.mkdirSync(stagingDir, { recursive: true });

  // Step 3: Extract with 7zip — no shell, discrete argv
  const result = await new Promise((resolve) => {
    const args = [
      'x',              // extract with full paths
      '-y',             // assume yes
      `-o${stagingDir}`, // output to staging directory
      archivePath,      // input archive
    ];
    const child = execFile(sevenZip, args, {
      timeout: 120_000, // 2 minute timeout
      maxBuffer: 10 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    }, (error) => {
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

  // H-012: On failure, clean up staging and return error.
  if (!result.ok) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
    return result;
  }

  // Step 4: Atomically activate — move existing dest aside, rename staging in.
  try {
    const backupDir = destDir + '.old-' + Date.now().toString(36);
    if (fs.existsSync(destDir)) {
      fs.renameSync(destDir, backupDir);
    }
    fs.renameSync(stagingDir, destDir);
    // Clean up old directory best-effort.
    if (fs.existsSync(backupDir)) {
      try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (_) {}
    }
    return { ok: true };
  } catch (e) {
    // Activation failed — clean up staging.
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, error: `Activation failed: ${e.message}` };
  }
}

module.exports = { extractZip, validateEntry, listAndValidate, resolve7za, MAX_ENTRIES };
