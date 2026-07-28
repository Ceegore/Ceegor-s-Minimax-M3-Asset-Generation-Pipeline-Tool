// src/pathUtils.js
// Helpers to safely validate file paths before any file operation. All
// fb:* IPC handlers must funnel their paths through `isPathUnderAny` so a
// compromised renderer (or a future bug in one of the build functions)
// can't trick the main process into reading, writing, renaming, or
// deleting files outside the directories the user authorised.
//
// Threats this guards against:
//   - Path traversal via `..` segments ("C:\Generated\..\..\Windows\…")
//   - Mixed-separator confusion ("C:/Generated\..\..\Windows")
//   - Windows case-insensitive filesystem mismatches
//   - Symlink targets pointing outside the allowed roots
//     (we do a best-effort check by resolving the parent dir; a hardlink
//      inside the allowed root that points at a system file would still
//      be reachable — that's an OS-level concern we can't fully close)
//   - Null-byte / control-character injection in paths
const path = require('path');
const fs = require('fs');

// Resolve a path to an absolute, normalised form. Returns null when the
// path is empty, not a string, or contains characters that should never
// appear in a legitimate filesystem path.
function normalize(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  // Reject NULs and other control chars — they have no legitimate use
  // and `fs` calls will throw on them anyway, but we'd rather fail
  // early and clearly.
  if (/[\x00-\x1f]/.test(p)) return null;
  try {
    return path.resolve(p);
  } catch {
    return null;
  }
}

// Lowercase, separator-normalised, trimmed form. For Windows-friendly
// comparison only — DO NOT use the result as a real path (it can change
// the case of letters that ARE significant on case-sensitive filesystems,
// but our threat model is "user on Windows or macOS, attacker can't
// influence case-sensitive mount points").
function canon(p) {
  if (!p) return '';
  return String(p).replace(/[\\/]+/g, path.sep).replace(/[\\/]+$/, '').toLowerCase();
}

// True iff `p` is `root` itself, or sits under `root` (after both are
// resolved). Both are compared case-insensitively so it works on
// Windows.
//
// Bug-fix #12 (2026-06-19): resolve symlinks via realIfExists()
// before comparison so a symlink *inside* an allowed root that points
// outside the root is not silently treated as under-the-root.
// Previously a symlink at `<output>/escape -> C:/Windows/System32`
// would have been accepted by isPathUnder, allowing an IPC handler
// to operate on files outside the user's authorised directory.
//
// realIfExists falls back to the normalised path when realpath
// throws, so non-existent leaves (write targets that don't exist
// yet, like fb:write / audio:cut dst) still work — the parent
// directory is the one that gets realpath-resolved through the
// existing isParentUnderAny helper.
function isPathUnder(p, root) {
  const pAbs = normalize(p);
  const rAbs = normalize(root);
  if (!pAbs || !rAbs) return false;
  const pLow = canon(realIfExists(pAbs));
  const rLow = canon(realIfExists(rAbs));
  if (pLow === rLow) return true;
  return pLow.startsWith(rLow + path.sep);
}

// True iff `p` is under any of the given roots.
function isPathUnderAny(p, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  for (const r of roots) {
    if (isPathUnder(p, r)) return true;
  }
  return false;
}

// True iff the path's *parent directory* is under any of the given roots.
// Used by fb:write where the user provides a full output path and we want
// to authorise "write next to an existing file in an allowed dir".
function isParentUnderAny(p, roots) {
  const pAbs = normalize(p);
  if (!pAbs) return false;
  return isPathUnderAny(path.dirname(pAbs), roots);
}

// Resolve a path through any symlinks in its parents so the result
// reflects what the OS will actually see.
//
// R5 (F1): when the leaf does not exist yet (a write target), we must NOT
// fall back to the unresolved string — a symlinked PARENT pointing outside
// the trust root would then slip through isPathUnder, because the raw
// `<root>/escape-link/evil.png` still starts with `<root>\` even though the
// OS will really write to the link's target. Walk up to the deepest EXISTING
// ancestor, realpath it (resolving any symlink in the parent chain), and
// reattach the missing tail — the same algorithm PathGrantService uses in
// _canonicalize. Only when no existing ancestor can be resolved at all do we
// fall back to the normalised path (best effort, e.g. platforms without
// realpath support).
function realIfExists(p) {
  const pAbs = normalize(p);
  if (!pAbs) return null;
  try {
    return fs.realpathSync(pAbs);
  } catch {
    let acc = pAbs;
    let tail = '';
    let safety = 256; // bound the walk against pathological inputs
    while (acc && safety-- > 0) {
      try {
        const deepest = fs.realpathSync(acc);
        return tail ? path.join(deepest, tail) : deepest;
      } catch {
        const base = path.basename(acc);
        if (!base || base === acc) break; // reached the root / made no progress
        tail = base + (tail ? path.sep + tail : '');
        acc = path.dirname(acc);
      }
    }
    return pAbs;
  }
}

module.exports = { normalize, canon, isPathUnder, isPathUnderAny, isParentUnderAny, realIfExists };
