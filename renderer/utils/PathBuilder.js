// renderer/utils/PathBuilder.js
// Pure helpers for output path construction.

/**
 * Append a suffix to a path (before the extension).
 * Examples:
 *   "C:/out/foo.png" + "_optimized" → "C:/out/foo_optimized.png"
 *   "C:/out/foo" + "_cut"          → "C:/out/foo_cut"
 *   ".gitignore" + "_bak"          → ".gitignore_bak"  (dotfile: no extension cut)
 */
function derivedOutputPath(srcPath, suffix) {
  if (!srcPath) return srcPath;
  const lastDot = srcPath.lastIndexOf('.');
  const lastSlash = Math.max(srcPath.lastIndexOf('/'), srcPath.lastIndexOf('\\'));
  // lastDot > 0 prevents dotfiles (.gitignore) from being treated as
  // having an extension at position 0. lastDot > lastSlash ensures the
  // dot belongs to the filename, not a directory name.
  if (lastDot > 0 && lastDot > lastSlash) {
    return srcPath.slice(0, lastDot) + suffix + srcPath.slice(lastDot);
  }
  return srcPath + suffix;
}

/**
 * Returns a name that does not collide with an existing file.
 * If "out.png" exists, "out (1).png", "out (2).png" are tried.
 * Existence is checked via window.api.fbExists (async) — this sync
 * variant does NOT check; it only generates the next free name. Callers
 * needing a collision-free guarantee must use the async
 * `resolveUniqueOutputPath`.
 */
function nextFreeName(srcPath) {
  const lastDot = srcPath.lastIndexOf('.');
  const lastSlash = Math.max(srcPath.lastIndexOf('/'), srcPath.lastIndexOf('\\'));
  const base = lastDot > lastSlash && lastDot !== -1 ? srcPath.slice(0, lastDot) : srcPath;
  const ext = lastDot > lastSlash && lastDot !== -1 ? srcPath.slice(lastDot) : '';
  return function tryN(n) {
    return n === 0 ? srcPath : `${base} (${n})${ext}`;
  };
}

/**
 * Async: returns a guaranteed non-existent path.
 * @param {string} srcPath
 * @param {number} [maxAttempts=1000]
 */
async function resolveUniqueOutputPath(srcPath, maxAttempts = 1000) {
  if (!srcPath) return srcPath;
  const tryN = nextFreeName(srcPath);
  for (let i = 0; i < maxAttempts; i++) {
    const cand = tryN(i);
    // fbExists returns { ok, exists } — pull the boolean out of .exists.
    // BGR-009 fix: mint read grant for fbExists (R1.3 gate).
    const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(cand) : undefined;
    // R6: a failed grant envelope must not be forwarded — fb:exists would resolve {ok:false,exists:false} and we'd return an unverifiable name as "free" (silent overwrite). Treat as occupied; the maxAttempts cap + timestamp fallback below still yields a unique path.
    const exRes = (existsGrant && existsGrant.ok === false) ? { exists: true } : await window.api.fbExists(cand, existsGrant);
    const exists = !!(exRes && exRes.exists);
    if (!exists) return cand;
  }
  // Fallback: random suffix
  const lastDot = srcPath.lastIndexOf('.');
  const ext = lastDot > 0 ? srcPath.slice(lastDot) : '';
  return srcPath + '-' + Date.now() + ext;
}

window.PathBuilder = { derivedOutputPath, resolveUniqueOutputPath, nextFreeName };
