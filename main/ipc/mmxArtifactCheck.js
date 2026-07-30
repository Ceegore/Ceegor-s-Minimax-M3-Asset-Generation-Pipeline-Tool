// main/ipc/mmxArtifactCheck.js
// ============================================================================
// P4.1 (360° Audit DB-H-002 / DB-H-008): post-run output validation for the
// mmx IPC handlers (`mmx:run` / `mmx:run:job`).
//
// mmx-cli is trusted to exit 0, but "exit 0" does NOT prove the artifact it
// claims to have written actually exists, is non-empty, or is a real media
// file. A network hiccup mid-download, a full disk, or an upstream API error
// swallowed by the CLI can all leave a missing / zero-byte / HTML-error-page
// "image" behind while the result envelope still says ok:true. The renderer
// then reports success, previews a broken file, and the user has paid for
// nothing.
//
// `finalizeMmxArtifacts(result, pathFlags)` is called by registerMmxIpc.js
// AFTER runMmx resolves (nested inside the existing redaction call so the
// frozen 384-line budget of that file is respected):
//   - a failed result (ok !== true) passes through untouched — the CLI
//     already reported the error and there is nothing to validate;
//   - for every OUTPUT file flag (kind === 'file': --out / --download / -o,
//     as classified by mmxPathAuthz.collectMmxPathFlags) the named file must
//     exist, be a regular file, be >= MIN_ARTIFACT_SIZE bytes, and carry
//     magic bytes of the family its extension implies;
//   - `--out-dir` (kind 'dir') is NOT checked here: mmx picks its own file
//     names inside the dir, so the per-file contract lives with the caller
//     (private run dirs, P4.2). Input flags (kind 'input') are reads.
//
// Magic bytes are validated per FAMILY, not per exact extension: mmx is
// known to write JPEG data into a `.png` --out path (the renderer's
// fixImageExtension later renames it), so any image extension accepts any
// of png/jpeg/webp/gif. Audio/video extensions map to their container
// signatures. Unknown extensions skip the magic check (size still applies).
//
// Invalid artifacts are deleted (best-effort) so a truncated/corrupt file
// can't be mistaken for a good output later, and the whole result flips to
// the standard fail envelope { ok:false, code:-1, stderr, parsed } that the
// renderer's existing error surface already understands.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { checkMagicBytes, MIN_ARTIFACT_SIZE } = require('../services/ArtifactFinalizer');

// Extension → acceptable magic-byte types (families, see header comment).
const IMAGE_TYPES = ['png', 'jpeg', 'webp', 'gif'];
const EXT_TYPES = Object.freeze({
  '.png': IMAGE_TYPES,
  '.jpg': IMAGE_TYPES,
  '.jpeg': IMAGE_TYPES,
  '.webp': IMAGE_TYPES,
  '.gif': IMAGE_TYPES,
  '.mp3': ['mp3'],
  '.wav': ['wav'],
  '.ogg': ['ogg'],
  '.flac': ['flac'],
  '.m4a': ['m4a'],
  '.mp4': ['mp4'],
  '.mov': ['mov'],
});

/**
 * Validate one output file. Returns `null` when the file is a plausible
 * artifact, or a human-readable problem string. Invalid files (undersized
 * or magic-byte mismatch) are deleted best-effort so they can't be picked
 * up as "results" by directory scans later.
 */
async function _validateOne(p, types) {
  let stat;
  try {
    stat = await fs.promises.stat(p);
  } catch (_) {
    return 'the output file was not created';
  }
  if (!stat.isFile()) return 'the output path is not a regular file';
  if (stat.size < MIN_ARTIFACT_SIZE) {
    try { await fs.promises.unlink(p); } catch (_) {}
    return `the output is only ${stat.size} bytes (minimum ${MIN_ARTIFACT_SIZE}) — deleted the truncated file`;
  }
  if (types && types.length) {
    let header;
    try {
      const fd = await fs.promises.open(p, 'r');
      header = Buffer.alloc(16);
      await fd.read(header, 0, 16, 0);
      await fd.close();
    } catch (e) {
      return `cannot read the output header: ${e.message}`;
    }
    if (!types.some((t) => checkMagicBytes(header, t))) {
      try { await fs.promises.unlink(p); } catch (_) {}
      return `the output does not look like a valid ${types.join('/')} file — deleted the corrupt file`;
    }
  }
  return null;
}

/**
 * Validate every OUTPUT file the mmx args named. Pass-through for failed
 * results; flips ok:true → the standard fail envelope when any output file
 * is missing/truncated/corrupt.
 *
 * @param {object} result    runMmx result envelope
 * @param {Array<{flag:string,value:string,kind:string}>} pathFlags
 *        from mmxPathAuthz.collectMmxPathFlags(args)
 * @returns {Promise<object>} the (possibly replaced) result envelope
 */
async function finalizeMmxArtifacts(result, pathFlags) {
  if (!result || result.ok !== true || !Array.isArray(pathFlags)) return result;
  const problems = [];
  for (const pf of pathFlags) {
    if (!pf || pf.kind !== 'file' || typeof pf.value !== 'string' || !pf.value) continue;
    const types = EXT_TYPES[path.extname(pf.value).toLowerCase()] || null;
    const problem = await _validateOne(pf.value, types);
    if (problem) problems.push(`"${pf.flag}" ${pf.value}: ${problem}`);
  }
  if (problems.length) {
    return {
      ok: false,
      code: -1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: `mmx reported success but the output failed validation — ${problems.join('; ')}`,
      parsed: result.parsed != null ? result.parsed : null,
    };
  }
  return result;
}

module.exports = { finalizeMmxArtifacts, EXT_TYPES };
