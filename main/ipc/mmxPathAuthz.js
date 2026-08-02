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
//     `kind` is 'file', 'dir', 'input' or 'url'.
//     B-003: input flag values are strictly typed — an https:// URL
//     is kind 'url' (URL policy, no local grant); any other scheme
//     (http:, file:, \\unc via smb:, data:, …) is rejected in the
//     authoriser; everything else is a LOCAL path requiring a read
//     grant. `--subject-ref` carries a composite value
//     (`type=character,image=<path-or-url>`) — the `image=` part is
//     extracted for classification/authorisation.
//   - `authorizeMmxPaths(grantId, pathFlags, cwd, readGrantIds)`
//     authorises every path the args (and optional cwd) would touch.
//     B-002: `readGrantIds` is plural — a single grantId string OR an
//     array of grantId strings. An input path is authorised if ANY of
//     the supplied read grants covers it (falls back to grantId for
//     backward compat when no read grants are supplied).
//     Returns `null` on success, or an error string (suitable
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

// P1-B (360° Audit C-005): input file flags that carry a path the
// renderer wants mmx-cli to READ. These require a READ grant.
// A compromised renderer could otherwise read arbitrary files by
// passing them as --text-file / --first-frame etc.
const MMX_INPUT_FILE_FLAGS = new Set([
  '--text-file',       // image/speech: text prompt from file
  '--lyrics-file',     // music: lyrics from file
  '--audio-file',      // speech: reference audio
  '--first-frame',     // video: first frame image
  '--last-frame',      // video: last frame image
  '--subject-image',   // image: subject reference
  '--subject-ref',     // image: subject reference (alternate)
  '--reference-image', // image: style reference
  '--mask',            // image: inpainting mask
  '--input',           // generic input file
]);

// B-003: any value with a URL scheme (`scheme://…`). Windows drive
// paths (`C:\…`) don't match — no `//` after the colon.
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// B-002/B-003: `--subject-ref` values are composites in the form
// `type=character,image=<path-or-url>`. Extract the `image=` part —
// that's the thing mmx actually opens. A plain value (no `image=`)
// is returned unchanged.
function extractSubjectRefTarget(value) {
  const idx = value.indexOf('image=');
  return idx === -1 ? value : value.slice(idx + 'image='.length);
}

/**
 * Walk the args array and collect every path-taking flag + its
 * value. Returns `[{ flag, value, kind }]` where `kind` is 'file',
 * 'dir', 'input' (local input path needing a read grant) or 'url'
 * (B-003: https-only URL policy, no local grant).
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
  // B-002/B-003: type the collected entry. Input flags carry either a
  // local path (kind 'input' → read grant) or a URL (kind 'url' →
  // https-only policy). `--subject-ref` composites are unwrapped first.
  const push = (flag, rawValue) => {
    let kind = MMX_FILE_PATH_FLAGS.has(flag) ? 'file'
             : MMX_DIR_PATH_FLAGS.has(flag) ? 'dir'
             : MMX_INPUT_FILE_FLAGS.has(flag) ? 'input'
             : null;
    if (!kind) return;
    let value = rawValue;
    if (kind === 'input') {
      if (flag === '--subject-ref') value = extractSubjectRefTarget(value);
      if (URL_SCHEME_RE.test(value)) kind = 'url';
    }
    out.push({ flag, value, kind });
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      const flag = a.slice(0, eq);
      const value = a.slice(eq + 1);
      if (!value) continue;
      push(flag, value);
      continue;
    }
    if (i >= args.length - 1) continue;
    const value = args[i + 1];
    if (typeof value !== 'string' || !value) continue;
    const isPathFlag = MMX_FILE_PATH_FLAGS.has(a) || MMX_DIR_PATH_FLAGS.has(a) || MMX_INPUT_FILE_FLAGS.has(a);
    if (!isPathFlag) continue;
    // A value starting with '-' is itself a flag, not a value.
    if (value.startsWith('-')) continue;
    push(a, value);
    i++; // consume the value
  }
  return out;
}

/**
 * Authorise every path the args (and optional cwd) would touch.
 * Returns `null` on success, or an error string on the first failed
 * authorisation.
 *
 * B-002: plural read grants. Input file flags (--first-frame,
 * --subject-ref image=, etc.) are authorised with operation 'read'
 * against the supplied `readGrantIds` (string or array of strings) —
 * an input path passes if ANY read grant covers it. When no read
 * grants are supplied, input paths fall back to the single `grantId`
 * for backward compatibility. Output file/dir flags (--out, --out-dir)
 * are authorised against `grantId` with operation 'write'.
 *
 * B-003: kind 'url' entries are never authorised as local paths —
 * they must be https:// (http:, file:, data:, … fail closed).
 *
 * @param {string} grantId - write grant for output paths
 * @param {Array} pathFlags - collected path flags
 * @param {string} [cwd] - optional working directory
 * @param {string|string[]} [readGrantIds] - B-002: read grant(s) for local input paths
 */
function authorizeMmxPaths(grantId, pathFlags, cwd, readGrantIds) {
  const hasInputFlags = pathFlags.some(({ kind }) => kind === 'input');
  const hasOutputFlags = pathFlags.some(({ kind }) => kind === 'file' || kind === 'dir');
  if (hasOutputFlags && (!grantId || typeof grantId !== 'string')) {
    return 'mmx: a grantId is required for the output path(s) (use a Main-minted grant from the picker or app-output)';
  }
  // B-002: normalise readGrantIds (string | string[] | undefined) into a
  // candidate list; fall back to the write grantId for backward compat.
  const readGrants = (Array.isArray(readGrantIds) ? readGrantIds : [readGrantIds])
    .filter((g) => g && typeof g === 'string');
  if (readGrants.length === 0 && grantId && typeof grantId === 'string') {
    readGrants.push(grantId);
  }
  if (hasInputFlags && readGrants.length === 0) {
    return 'mmx: a readGrantId (or grantId) is required for input file path(s)';
  }
  for (const { flag, value, kind } of pathFlags) {
    if (kind === 'url') {
      // B-003: URL policy — https only. Everything else (http:, file:,
      // ftp:, data:, …) fails closed; there is no grant that can
      // authorise a non-https remote reference.
      if (!/^https:\/\//i.test(value)) {
        return `mmx: "${flag}" URL "${value}" is not allowed (only https:// URLs are accepted for remote references)`;
      }
      continue;
    }
    if (kind === 'input') {
      // B-002: pass if ANY supplied read grant authorises the path.
      let lastErr = 'no read grant supplied';
      let authorized = false;
      for (const rg of readGrants) {
        const authz = _authorizePath(rg, 'read', value);
        if (authz.ok) { authorized = true; break; }
        lastErr = authz.error;
      }
      if (!authorized) {
        return `mmx: "${flag}" path "${value}" is not authorised by the read grant (${lastErr})`;
      }
    } else {
      const authz = _authorizePath(grantId, 'write', value);
      if (!authz.ok) {
        return `mmx: "${flag}" path "${value}" is not authorised by the grant (${authz.error})`;
      }
    }
  }
  if (typeof cwd === 'string' && cwd) {
    if (!grantId || typeof grantId !== 'string') {
      return 'mmx: a grantId is required for the output path(s) (use a Main-minted grant from the picker or app-output)';
    }
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
  MMX_INPUT_FILE_FLAGS,
  extractSubjectRefTarget,
  collectMmxPathFlags,
  authorizeMmxPaths,
};
