// src/mmxArgSanitizer.js
// ============================================================================
// R2.4 — Strip any `--api-key=VALUE` or `--api-key VALUE` that the renderer
// may have smuggled into its `args`. Without this, a malicious or buggy
// renderer could put the api key in the spawn argv — and on Windows, any
// local process can read every other process's argv via WMI for the
// entire call duration.
//
// Extracted to its own file (closes R0.1-003.B and the related H7-013
// scan) so src/mmx.js can stay under its frozen 542-LOC SIZE-BUDGET.
//
// Note: this is purely a defence against a renderer that TRIES to
// bypass the SessionCredentialStore flow. The legitimate API key
// routing (--api-key argv fallback when ~/.mmx sync fails) still runs
// in its own controlled block in runMmx — that path uses the Main-side
// `apiKey` parameter, not the renderer's `args`.
//
// P0-C (360° Audit C-004): EXTENDED to block ALL dangerous global flags
// that mmx-cli 1.0.18 accepts. A compromised renderer could redirect
// API calls to an attacker server via --base-url, leak credentials via
// --config, or enable debug output. We now use a BLOCKLIST of known-
// dangerous flags PLUS strip any unknown --flag that is not in the
// per-subcommand allowlist.
// ============================================================================

/**
 * Global flags that are ALWAYS blocked regardless of subcommand.
 * These control authentication, networking, and debug behaviour.
 * A compromised renderer must NEVER be able to inject them.
 * @type {ReadonlySet<string>}
 */
const BLOCKED_GLOBAL_FLAGS = new Set([
  '--api-key',        // credential injection
  '--apikey',         // alternate spelling
  '--base-url',       // C-004: redirect API calls to attacker server
  '--baseurl',        // alternate spelling
  '--config',         // alternate config file (could point to attacker-controlled)
  '--proxy',          // traffic interception
  '--debug',          // verbose output may leak secrets
  '--verbose',        // same
  '--trace',          // same
  '--log-level',      // same
  '--no-verify',      // disable TLS verification
  '--insecure',       // same
  '--token',          // alternate credential flag
  '--secret',         // generic secret injection
  '--password',       // generic credential
  '--endpoint',       // alternate API endpoint
  '--host',           // alternate host
  '--port',           // alternate port
  '--scheme',         // http vs https downgrade
]);

/**
 * Per-subcommand flag allowlist. Only flags listed here are permitted
 * for each subcommand. Any --flag NOT in this list (and not in the
 * blocked list) is stripped as unknown/potentially dangerous.
 *
 * Derived from mmx-cli 1.0.18's documented per-command options.
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
const SUBCOMMAND_FLAG_ALLOWLIST = Object.freeze({
  image: new Set([
    '--prompt', '-p', '--model', '-m', '--n', '--size', '-s',
    '--out', '-o', '--out-dir', '--download', '--negative-prompt',
    '--seed', '--guidance-scale', '--steps', '--width', '--height',
    '--aspect-ratio', '--style', '--ref-image', '--strength',
  ]),
  speech: new Set([
    '--text', '-t', '--model', '-m', '--voice', '-v', '--speed',
    '--out', '-o', '--out-dir', '--download', '--format',
    '--text-file', '--language',
  ]),
  music: new Set([
    '--prompt', '-p', '--model', '-m', '--out', '-o', '--out-dir',
    '--download', '--lyrics', '--lyrics-file', '--duration',
    '--instrumental',
  ]),
  video: new Set([
    '--prompt', '-p', '--model', '-m', '--out', '-o', '--out-dir',
    '--download', '--duration', '--resolution', '--fps',
    '--first-frame', '--last-frame', '--subject-image', '--subject-ref',
    '--audio-file',
  ]),
  quota: new Set([]),
  voices: new Set(['--model', '-m']),
});

/**
 * Strip any `--api-key=VALUE` (single-token = form) or `--api-key VALUE`
 * (two-token form) that the renderer may have smuggled into its `args`.
 * Returns a new array; the original is left untouched so the caller can
 * still inspect it (e.g. for IPC logging).
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function stripRendererSuppliedApiKey(args) {
  if (!Array.isArray(args)) return args;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === 'string') {
      // Single-token form: "--api-key=VALUE"
      if (/^--api(-?)key=/i.test(a)) {
        continue;
      }
      // Two-token form: "--api-key" followed by "VALUE"
      if (/^--api(-?)key$/i.test(a)) {
        i++;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/**
 * P0-C (360° Audit C-004): Full argument sanitizer for mmx CLI calls.
 *
 * 1. Strips --api-key (legacy behaviour).
 * 2. Blocks ALL flags in BLOCKED_GLOBAL_FLAGS (both --flag=value and
 *    --flag value forms).
 * 3. If a subcommand is provided, strips any --flag NOT in the
 *    per-subcommand allowlist (defence against unknown future flags).
 *
 * Returns { args: string[], blocked: string[] } where `blocked` lists
 * the flags that were removed (for audit logging / error reporting).
 *
 * @param {string[]} args - The renderer-supplied args array
 * @param {string} [subcommand] - The mmx subcommand (image/speech/music/video)
 * @returns {{ args: string[], blocked: string[] }}
 */
function sanitizeMmxArgs(args, subcommand) {
  if (!Array.isArray(args)) return { args: [], blocked: [] };
  const allowlist = subcommand ? SUBCOMMAND_FLAG_ALLOWLIST[subcommand] : null;
  const out = [];
  const blocked = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') { out.push(a); continue; }

    // Extract the flag name from --flag=value form
    const eqIdx = a.indexOf('=');
    const flagName = (a.startsWith('--') && eqIdx > 0) ? a.slice(0, eqIdx).toLowerCase() : a.toLowerCase();

    // 1. Always block --api-key variants (legacy)
    if (/^--api(-?)key(=.*)?$/i.test(a)) {
      blocked.push('--api-key');
      if (eqIdx < 0 && i + 1 < args.length && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('-')) i++;
      continue;
    }

    // 2. Block all dangerous global flags
    if (BLOCKED_GLOBAL_FLAGS.has(flagName)) {
      blocked.push(flagName);
      // Consume the value token if this is --flag value form
      if (eqIdx < 0 && i + 1 < args.length && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('-')) i++;
      continue;
    }

    // 3. If we have a per-subcommand allowlist, block unknown flags
    if (allowlist && a.startsWith('-')) {
      // Normalize: --flag=value -> --flag, -x stays as -x
      const normalizedFlag = eqIdx > 0 ? a.slice(0, eqIdx) : a;
      if (!allowlist.has(normalizedFlag) && !allowlist.has(normalizedFlag.toLowerCase())) {
        blocked.push(normalizedFlag);
        // Consume value token for --flag value form
        if (eqIdx < 0 && i + 1 < args.length && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('-')) i++;
        continue;
      }
    }

    out.push(a);
  }

  return { args: out, blocked };
}

/**
 * P0-C (C-004) convenience wrapper for the mmx:run / mmx:run:job IPC handlers:
 * sanitizes the FULL arg vector (args[0] = subcommand) and returns either the
 * ready-to-return error envelope or the safe args, so both handlers stay a
 * two-liner (registerMmxIpc.js has a frozen size budget).
 * @param {string[]} args - full arg vector including the subcommand
 * @returns {{ err?: object, safeArgs?: string[] }}
 */
function sanitizeOrReject(args) {
  const subcommand = args[0];
  const sanitized = sanitizeMmxArgs(args.slice(1), subcommand);
  if (sanitized.blocked.length > 0) {
    return { err: { ok: false, code: -1, stdout: '', stderr: `mmx: blocked disallowed flag(s): ${sanitized.blocked.join(', ')}`, parsed: null } };
  }
  return { safeArgs: [subcommand, ...sanitized.args] };
}

module.exports = {
  stripRendererSuppliedApiKey,
  sanitizeMmxArgs,
  sanitizeOrReject,
  BLOCKED_GLOBAL_FLAGS,
  SUBCOMMAND_FLAG_ALLOWLIST,
};
