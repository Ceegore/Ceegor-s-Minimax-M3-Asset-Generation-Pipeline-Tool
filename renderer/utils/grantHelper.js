// renderer/utils/grantHelper.js
// ============================================================================
// BGR-009 fix: shared grant-mint utility for the renderer.
//
// The R1.x "fail-closed path grants" refactor requires every gated IPC
// (fb:read, fb:exists, fb:write, fb:delete, fb:mkdir, fb:rename, fb:move,
// fb:copy, image:writeBase64, audio:cut, etc.) to receive a Main-minted
// grantId as its trailing argument. Many callsites were never migrated and
// call these IPCs without a grant, causing hard rejections.
//
// This module provides thin convenience wrappers around GrantCache that
// mint the correct grant kind + capabilities for each operation class.
// All functions return the grantId string on success, or {ok:false, error}
// on failure (never throw). Callers should check for `.ok === false` and
// propagate the error.
//
// Usage:
//   const g = await window.GrantHelper.ensureRead(filePath);
//   if (g && g.ok === false) { handleError(g.error); return; }
//   const r = await window.api.fbExists(filePath, g);
//
// Loaded via <script> tag. Exposes window.GrantHelper.
// ============================================================================

(function () {
'use strict';

/**
 * Mint a read grant for a single file (fbExists, fbRead).
 * @param {string} filePath
 * @returns {Promise<string|{ok:false, error:string}>}
 */
async function ensureRead(filePath) {
  if (!filePath || !window.GrantCache) return undefined;
  return window.GrantCache.ensurePathGrant(filePath, 'read', {
    kind: 'file', capabilities: ['read'],
  });
}

/**
 * Mint a directory grant covering read+write on a file's parent directory.
 * Used for write operations that produce a sibling output (writeImageBase64,
 * fbWrite, optimize, resize, crop output, etc.).
 * @param {string} filePath - the target file path (grant covers its parent dir)
 * @returns {Promise<string|{ok:false, error:string}>}
 */
async function ensureWrite(filePath) {
  if (!filePath || !window.GrantCache || !window.api) return undefined;
  const dir = window.api.pathDirname(filePath);
  return window.GrantCache.ensurePathGrant(dir, 'read', {
    kind: 'directory', capabilities: ['read', 'write'],
  });
}

/**
 * Mint a directory grant with mkdir+write for fbEnsureDir / fbMkdir.
 * coversRoot:true is REQUIRED: fb:ensureDir authorises the 'mkdir'
 * operation on the directory ITSELF, and a plain directory grant only
 * covers strict descendants (S1 §2.5) — without coversRoot the handler
 * rejects with 'directory grant covers only strict descendants, not the
 * root itself'. fb:mkdir (which authorises the named CHILD) works with
 * coversRoot too, so the flag is safe for both callers. Same pattern as
 * ensureSubDir (app.js R7.5) and the batch grant (batchManager.js B.1).
 * @param {string} dirPath - the directory to create
 * @returns {Promise<string|{ok:false, error:string}>}
 */
async function ensureDir(dirPath) {
  if (!dirPath || !window.GrantCache) return undefined;
  return window.GrantCache.ensurePathGrant(dirPath, 'mkdir', {
    kind: 'directory', capabilities: ['mkdir', 'write'], coversRoot: true,
  });
}

/**
 * Mint a grant for fbDelete. Uses a directory grant on the parent with
 * delete capability so the handler can remove the file.
 * @param {string} filePath
 * @returns {Promise<string|{ok:false, error:string}>}
 */
async function ensureDelete(filePath) {
  if (!filePath || !window.GrantCache || !window.api) return undefined;
  const dir = window.api.pathDirname(filePath);
  return window.GrantCache.ensurePathGrant(dir, 'delete', {
    kind: 'directory', capabilities: ['read', 'delete'],
  });
}

/**
 * Mint a grant for fbRename. Uses a directory grant on the file's parent
 * with rename capability. The 'write' capability is ALSO required: the
 * fb:rename handler authorises TWO operations against the same grant —
 * 'rename' on the source path AND 'write' on the target path (parent +
 * newName). Without 'write' the second check rejects.
 * @param {string} filePath
 * @returns {Promise<string|{ok:false, error:string}>}
 */
async function ensureRename(filePath) {
  if (!filePath || !window.GrantCache || !window.api) return undefined;
  const dir = window.api.pathDirname(filePath);
  return window.GrantCache.ensurePathGrant(dir, 'rename', {
    kind: 'directory', capabilities: ['read', 'rename', 'write'],
  });
}

/**
 * Deepest common ancestor directory of two paths, using only
 * window.api.pathDirname (the sandboxed renderer has no require('path')).
 * Comparison is case-insensitive (Windows paths are). Returns null when
 * no common ancestor can be found (e.g. different drives) — callers fall
 * back to destDir (legacy behaviour; the handler then rejects the src
 * path with a clear error instead of a silent wrong-folder grant).
 * @param {string} a
 * @param {string} b
 * @returns {string|null}
 */
function _commonAncestor(a, b) {
  if (!a || !b || !window.api || typeof window.api.pathDirname !== 'function') return null;
  // Normalize separators for COMPARISON only: pathDirname (a win32 port)
  // preserves the input's separator style, so a '/'-style src and a
  // '\'-style destDir would otherwise never string-match even though they
  // share an ancestor. The returned path keeps its original form — the
  // grant mint canonicalizes it via realpath, so that is safe.
  const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase();
  // Ancestor chain of `a` (includes `a` itself so destDir === parentDir
  // and destDir-inside-src-dir cases resolve to the right root).
  const chain = new Set();
  let cur = a;
  let guard = 512; // bound against pathological inputs
  while (cur && guard-- > 0) {
    chain.add(norm(cur));
    const d = window.api.pathDirname(cur);
    if (!d || norm(d) === norm(cur)) break; // reached the drive/FS root
    cur = d;
  }
  // Walk `b` up until it hits a's chain.
  cur = b;
  guard = 512;
  while (cur && guard-- > 0) {
    if (chain.has(norm(cur))) return cur;
    const d = window.api.pathDirname(cur);
    if (!d || norm(d) === norm(cur)) break;
    cur = d;
  }
  return null;
}

/**
 * Mint a grant for fbMove. The fb:move handler authorises TWO paths:
 * 'move' on the SOURCE and 'write' on the destination path (destDir +
 * basename). Prefer minting ONE grant on the deepest common ancestor of
 * src and destDir (both paths are then strict descendants of one root —
 * the normal same-root cut/paste case). gewv2 GEW-002 fix: when src and
 * destDir do NOT share a common ancestor that is itself an allowed root
 * (e.g. two different trusted top-level folders — the common ancestor
 * mint is then rejected), fall back to minting TWO SEPARATE grants, one
 * per endpoint, and passing both to fb:move (which now accepts an
 * optional destGrantId 5th arg). This fixes cross-root moves WITHOUT
 * weakening the invariant that every endpoint needs its own valid,
 * authorizing grant — a genuinely untrusted endpoint still fails to mint.
 * @param {string} src - source file path
 * @param {string} destDir - destination directory
 * @returns {Promise<{ok:true, srcGrant:string, destGrant:string}|{ok:false, error:string}>}
 */
async function ensureMove(src, destDir) {
  if (!destDir || !window.GrantCache) return undefined;
  const root = _commonAncestor(src, destDir) || destDir;
  const shared = await window.GrantCache.ensurePathGrant(root, 'move', {
    kind: 'directory', capabilities: ['read', 'write', 'move', 'mkdir'],
  });
  if (shared && shared.ok !== false) return { ok: true, srcGrant: shared, destGrant: shared };
  // Common-ancestor mint failed — try two independent grants.
  const srcDir = (window.api && window.api.pathDirname) ? window.api.pathDirname(src) : null;
  const srcGrant = srcDir ? await window.GrantCache.ensurePathGrant(srcDir, 'move', {
    kind: 'directory', capabilities: ['read', 'move'],
  }) : { ok: false, error: 'ensureMove: could not resolve source directory' };
  if (srcGrant && srcGrant.ok === false) return srcGrant;
  const destGrant = await window.GrantCache.ensurePathGrant(destDir, 'write', {
    kind: 'directory', capabilities: ['write', 'mkdir'], coversRoot: true,
  });
  if (destGrant && destGrant.ok === false) return destGrant;
  return { ok: true, srcGrant, destGrant };
}

/**
 * Mint a grant for fbCopy. Same dual-path authorisation as fb:move
 * ('copy' on src + 'write' on destPath) — mint on the common ancestor
 * first, falling back to two independent grants (gewv2 GEW-002) when the
 * endpoints don't share a trusted common ancestor.
 * @param {string} src
 * @param {string} destDir
 * @returns {Promise<{ok:true, srcGrant:string, destGrant:string}|{ok:false, error:string}>}
 */
async function ensureCopy(src, destDir) {
  if (!destDir || !window.GrantCache) return undefined;
  const root = _commonAncestor(src, destDir) || destDir;
  const shared = await window.GrantCache.ensurePathGrant(root, 'copy', {
    kind: 'directory', capabilities: ['read', 'write', 'copy', 'mkdir'],
  });
  if (shared && shared.ok !== false) return { ok: true, srcGrant: shared, destGrant: shared };
  const srcDir = (window.api && window.api.pathDirname) ? window.api.pathDirname(src) : null;
  const srcGrant = srcDir ? await window.GrantCache.ensurePathGrant(srcDir, 'copy', {
    kind: 'directory', capabilities: ['read', 'copy'],
  }) : { ok: false, error: 'ensureCopy: could not resolve source directory' };
  if (srcGrant && srcGrant.ok === false) return srcGrant;
  const destGrant = await window.GrantCache.ensurePathGrant(destDir, 'write', {
    kind: 'directory', capabilities: ['write', 'mkdir'], coversRoot: true,
  });
  if (destGrant && destGrant.ok === false) return destGrant;
  return { ok: true, srcGrant, destGrant };
}

/**
 * Mint a grant for a "read src -> transform -> write dst" IPC
 * (upscale:realesrgan:run, isnetbg:run, image:resize, image:optimize,
 * inpaint:*, audio:cut). These handlers authorise TWO paths against the
 * SAME grant: 'read' on srcPath and 'write' on dstPath. When dst is not a
 * sibling of src — e.g. the Pipeline board writes ws/original/x.png ->
 * ws/upscale/y.png (a DIFFERENT column folder) — minting on
 * pathDirname(src) fails the dst write check ("directory grant covers
 * only strict descendants"). Mint on the deepest common ancestor of src
 * and dst so both are strict descendants of the grant root.
 * @param {string} srcPath - source file to read
 * @param {string} dstPath - destination file to write
 * @returns {Promise<string|{ok:false, error:string}|undefined>}
 */
async function ensureTransform(srcPath, dstPath) {
  if (!srcPath || !dstPath || !window.GrantCache || !window.api) return undefined;
  const normSrc = String(srcPath).replace(/\\/g, '/');
  const normDst = String(dstPath).replace(/\\/g, '/');
  if (normSrc.toLowerCase() === normDst.toLowerCase()) {
    return { ok: false, error: 'Source and destination paths are identical.' };
  }
  const srcDir = window.api.pathDirname(srcPath);
  const dstDir = window.api.pathDirname(dstPath);
  const root = _commonAncestor(srcDir, dstDir);
  // KGO-015 fix: reject drive-root ancestors (e.g. "C:\" or "/").
  // A grant on the drive root would cover the entire volume — far too broad
  // for a single transform operation. Require at least 2 path segments.
  const _isDriveRoot = (p) => {
    const n = String(p).replace(/[\\/]+$/, '');
    // Windows drive root: "C:" or "C:\" or "C:/"
    if (/^[A-Za-z]:$/.test(n)) return true;
    // POSIX root: "/"
    if (n === '' || n === '/') return true;
    return false;
  };
  if (root && !_isDriveRoot(root)) {
    const shared = await window.GrantCache.ensurePathGrant(root, 'read', {
      kind: 'directory', capabilities: ['read', 'write'],
    });
    if (shared && shared.ok !== false) return shared;
  }
  // KGO-019 fix: fall back to srcDir (not dstDir) so the grant authorizes
  // the READ on the source. The old code fell back to dstDir, which only
  // authorized the write — leading to a misleading "not authorized to read"
  // error when the real cause was the ancestor not being a trusted root.
  return window.GrantCache.ensurePathGrant(srcDir, 'read', {
    kind: 'directory', capabilities: ['read', 'write'],
  });
}

/**
 * Mint grant(s) for the External Tools hand-off (externalTools:run).
 * The handler authorises 'read' on EVERY file path in payload.paths.
 * A directory grant on the parent of the first file covers all files
 * in the same folder (the normal case for the file-browser context
 * menu and the pipeline card).
 *
 * gewv2 GEW-012 fix: for a multi-folder selection, minting a SINGLE grant
 * on the common ancestor of just the first and last path could miss a
 * MIDDLE path that lies outside that ancestor (e.g. [C:\A\x, D:\B\y,
 * C:\A\z] — the ancestor of first+last is D:\, which authorises neither
 * C:\A file). Fix: mint one grant per DISTINCT parent directory among ALL
 * paths, and return the array — externalTools:run now accepts an array of
 * grantIds and authorises each path against any one of them.
 * @param {string[]} paths - file paths to hand off
 * @returns {Promise<string[]|{ok:false, error:string}|undefined>}
 */
async function ensureExternalToolRead(paths) {
  if (!Array.isArray(paths) || !paths.length || !window.GrantCache || !window.api) return undefined;
  const dirs = [];
  for (const p of paths) {
    const d = window.api.pathDirname(p);
    if (d && !dirs.includes(d)) dirs.push(d);
  }
  const grants = [];
  for (const dir of dirs) {
    const g = await window.GrantCache.ensurePathGrant(dir, 'read', {
      kind: 'directory', capabilities: ['read'],
    });
    if (g && g.ok === false) return g;
    grants.push(g);
  }
  return grants;
}

/**
 * Mint a directory read grant for fb:list (KGO4-009).
 * coversRoot:true is required because fb:list authorises the directory
 * itself, not just its descendants.
 * @param {string} dir - the directory to list
 * @returns {Promise<string|{ok:false, error:string}>}
 */
async function ensureDirList(dir) {
  if (!dir || !window.GrantCache) return undefined;
  return window.GrantCache.ensurePathGrant(dir, 'read', {
    kind: 'directory', capabilities: ['read'], coversRoot: true,
  });
}

window.GrantHelper = {
  ensureRead,
  ensureWrite,
  ensureDir,
  ensureDirList,
  ensureDelete,
  ensureRename,
  ensureMove,
  ensureCopy,
  ensureTransform,
  ensureExternalToolRead,
};

// Node.js test compatibility.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = window.GrantHelper;
}

})();
