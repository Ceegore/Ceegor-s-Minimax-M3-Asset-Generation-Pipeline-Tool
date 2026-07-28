// main/ipc/mmxPathAuthz.js
// ============================================================================
// R1.5b.1 — shared path-authorisation helper for the mmx IPC handlers.
//
// Extracted from `main/ipc/registerMmxIpc.js` (was inline in the handler
// closure) to keep the IPC file under its frozen 384-line lint budget.
//
// Contract:
//   - `MMX_FILE_PATH_FLAGS` / `MMX_DIR_PATH_FLAGS` are the path-taking
//     flags the renderer's `args` may carry. `--out` / `--download` /
//     `-o` name a FILE (so we authorise 'write' on the file; the
//     grant's relation rule is the source of truth for "is the
//     parent inside the grant?"). `--out-dir` names a DIRECTORY mmx
//     writes into (the grant must cover the directory itself — a
//     default `directory` grant does NOT cover the root per S1
//     §2.5; the renderer must mint a `directory-root` grant
//     (coversRoot:true) for the --out-dir use case).
//   - `collectMmxPathFlags(args)` walks the args array, splitting
//     `--flag=value` (one token) and `--flag value` (two tokens)
//     forms. Returns an array of `{ flag, value, kind }` where
//     `kind` is 'file' or 'dir'.
//   - `authorizeMmxPaths(grantId, pathFlags, cwd)` authorises every
//     path the args (and optional cwd) would touch against a single
//     grant. Returns `null` on success, or an error string (suitable
//     for the IPC's `stderr` field) on the first failed
//     authorisation. A missing / non-string grantId fails closed
//     (same envelope as the legacy "outside the allowed directories"
//     error so the renderer's existing error surface is unchanged).
//
// Why a separate file:
//   - Keeps `registerMmxIpc.js` under its frozen 384-line lint
//     budget (R1.5b.1 added the grant-gated path-authorisation
//     code which would push the file over without extraction).
//   - The helper is logically distinct from the IPC plumbing
//     (subcommand allowlist, spawn lifecycle, log routing) —
//     splitting aligns with the "one concern per file" SRP rule.
// ============================================================================

const { authorizePath: _authorizePath } = require('./grantAuthorizer');

const MMX_FILE_PATH_FLAGS = new Set(['--out', '--download', '-o']);
const MMX_DIR_PATH_FLAGS = new Set(['--out-dir']);

/**
 * Walk the args array and collect every path-taking flag + its
 * value. Returns `[{ flag, value, kind }]` where `kind` is 'file'
 * or 'dir'.
 *
 * Supports both `--flag=value` (one token) and `--flag value` (two
 * adjacent tokens) forms. The first form is one token; the second
 * consumes the next token UNLESS the next token starts with `-`
 * (which would be a flag, not a value, in mmx-cli convention).
 * `--flag` / `--flag --another` (no value) is ignored.
 */
function collectMmxPathFlags(args) {
  const out = [];
  if (!Array.isArray(args)) return out;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      const flag = a.slice(0, eq);
      const value = a.slice(eq + 1);
      if (!value) continue;
      const kind = MMX_FILE_PATH_FLAGS.has(flag) ? 'file'
                 : MMX_DIR_PATH_FLAGS.has(flag) ? 'dir'
                 : null;
      if (kind) out.push({ flag, value, kind });
      continue;
    }
    if (i >= args.length - 1) continue;
    const value = args[i + 1];
    if (typeof value !== 'string' || !value) continue;
    const kind = MMX_FILE_PATH_FLAGS.has(a) ? 'file'
               : MMX_DIR_PATH_FLAGS.has(a) ? 'dir'
               : null;
    if (!kind) continue;
    // A value starting with '-' is itself a flag, not a value.
    // mmx-cli's convention: --flag --another means --flag has
    // no value (the next token is a new flag). We skip the
    // path-flag collection in that case (the renderer's mmx
    // call will fail with mmx-cli's own "missing value" error,
    // which is the correct user-facing message — not a
    // "path outside allowed directories" error from us).
    if (value.startsWith('-')) continue;
    out.push({ flag: a, value, kind });
    i++; // consume the value
  }
  return out;
}

/**
 * Authorise every path the args (and optional cwd) would touch
 * against a single grant. Returns `null` on success, or an error
 * string on the first failed authorisation.
 *
 * A single grant must cover:
 *   - every file path in the args (--out / --download / -o):
 *     'write' on the file (the grant must cover the parent).
 *   - the directory path in the args (--out-dir): 'write' on the
 *     directory itself. A default `directory` grant does NOT
 *     cover the root (S1 §2.5); the renderer must mint a
 *     `directory-root` grant (coversRoot:true) for --out-dir.
 *   - the payload's cwd (if present): 'mkdir' on the cwd.
 */
function authorizeMmxPaths(grantId, pathFlags, cwd) {
  if (!grantId || typeof grantId !== 'string') {
    return 'mmx: a grantId is required for the output path(s) (use a Main-minted grant from the picker or app-output)';
  }
  for (const { flag, value } of pathFlags) {
    const authz = _authorizePath(grantId, 'write', value);
    if (!authz.ok) {
      return `mmx: "${flag}" path "${value}" is not authorised by the grant (${authz.error})`;
    }
  }
  if (typeof cwd === 'string' && cwd) {
    const authz = _authorizePath(grantId, 'mkdir', cwd);
    if (!authz.ok) {
      return `mmx: cwd "${cwd}" is not authorised by the grant (${authz.error})`;
    }
  }
  return null;
}

module.exports = {
  MMX_FILE_PATH_FLAGS,
  MMX_DIR_PATH_FLAGS,
  collectMmxPathFlags,
  authorizeMmxPaths,
};
