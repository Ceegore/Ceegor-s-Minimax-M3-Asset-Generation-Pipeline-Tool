// src/deepRedactor.js
// ============================================================================
// R2.4 — DeepRedactor: walks any value and scrubs known secret patterns.
//
// Closes R0.1-002.D (diagnose snapshot must not leak the in-memory
// session-only API key), R0.1-003.A (`Authorization: Bearer <secret>` in
// stderr must be redacted in onLog + IPC), R0.1-003.B (`--api-key=<value>`
// arg must be redacted in argv + cmdLine), R0.1-003.C (spawn ENOENT must
// not leak the key in argv/stderr/result), and R0.1-003.D (shared
// DeepRedactor helper must exist in src/).
//
// Contract (design contract §5 SYS-003, Soll):
//   • `deepRedact(value, options?)` — walks strings/arrays/objects/Errors
//     and replaces any substring matching a known secret pattern with
//     `***REDACTED***` (or the configured replacement).
//   • Patterns:
//       - `Authorization:\s*Bearer\s+<token>` → `Authorization: ***`
//       - `--api-key <value>` (two-token) → `--api-key ***`
//       - `--api-key=<value>` (single-token) → `--api-key=***`
//       - `--api-key "<value>"` / `--api-key '<value>'` (quoted) → `***`
//       - `MMX_API_KEY=<value>` env form → `MMX_API_KEY=***`
//       - `api_key` / `apiKey` object FIELD values are scrubbed (the
//         key in the diag snapshot / argv return must NEVER include
//         the raw value).
//   • `redactString(s, options?)` — same as deepRedact but for a single
//     string. Returns the scrubbed string.
//   • Never throws. Non-string/non-object values are returned as-is
//     (or replaced with a safe placeholder for objects with no own
//     properties).
//   • Pure / synchronous / no side effects. Unit-testable in isolation.
// ============================================================================

// Default redaction marker. The H7-013 test (and the legacy per-element
// walker before R2.4) used the short `***`. We keep that as the default
// for backward-compat with existing logs / tests, and the helper
// accepts a custom `replacement` option for callers that want a
// longer marker (e.g. the diagnose snapshot's UI hint).
const REDACTED = '***';

// Field names that carry the API key as a VALUE (not as a label we
// want to keep). Case-insensitive. "api_key", "apiKey",
// "minimax_api_key", etc. are matched. The full list is conservative —
// false positives (e.g. a "key" field that isn't a secret) are
// preferred over false negatives (missing a real secret).
const SECRET_FIELD_NAMES = new Set([
  'api_key',
  'apikey',
  'minimax_api_key',
  'minimax_apikey',
  'mmx_api_key',
  'mmxapikey',
  'session_api_key',
  'sessionapikey',
  'password',
  'pass',
  'token',
  'secret',
]);

// Substring patterns that identify a SECRET inside a string. Match
// case-insensitively for the keyword; the value is whatever follows
// until a terminator (whitespace, quote, end-of-string).
//
// Note: we deliberately do NOT use lookbehind for the regex (Node 22
// supports it but some older runtimes don't); instead we anchor the
// pattern with a non-capturing group so the keyword + value replace
// works in plain `String.replace(regex, ...)` form.
function _buildPatterns() {
  return [
    // Authorization: Bearer <token>  (also: case-insensitive, optional
    // whitespace, optional quoted value)
    {
      // Authorization: Bearer <token>  (also handle basic / token schemes)
      re: /(\bauthorization\s*:\s*(?:bearer|basic|token)\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      replace: '$1***',
    },
    // --api-key=<value>  (single-token = form, also quoted)
    {
      re: /(--api-key=)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      replace: '$1***',
    },
    // --api-key <value>  (two-token, also quoted)
    {
      re: /(--api-key)(\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      replace: '$1$2***',
    },
    // MMX_API_KEY=<value>  / MINIMAX_API_KEY=<value>  (env form,
    // case-insensitive so `mmx_api_key=` in a lower-case env dump
    // is also caught).
    {
      re: /(\b(?:MMX|MINIMAX)_API_KEY\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      replace: '$1***',
    },
  ];
}

const _PATTERNS = _buildPatterns();

// Array element patterns: when an array contains a secret-marker string
// (e.g. "--api-key"), the NEXT element is treated as the secret value
// and replaced. This covers the common CLI-args case where the key is
// passed as a separate argv token (e.g. ['mmx', 'image', '--api-key',
// SECRET]) — the regex patterns above can't see across array-element
// boundaries, so this walker does it instead.
//
// The marker list is checked case-insensitively (matching the
// regex patterns in `_buildPatterns`) so `['--API-KEY', SECRET]` is
// also caught. The marker itself is preserved (only the value is
// redacted) so the redacted argv is still self-describing.
//
// IMPORTANT: only the TWO-TOKEN form (`--api-key` followed by a
// separate VALUE) is in this list. The single-token form
// (`--api-key=VALUE`) has the value in the same string as the
// marker, so it doesn't need a "next element" redactor — the
// subsequent same-token-form check handles it. Including the
// single-token form here would falsely match and redact the
// WRONG array element (the next element, which is unrelated).
const _ARRAY_SECRET_MARKER_PATTERNS = [
  /^--api(-?)key$/i,         // two-token form only (no = at the end)
  /^--apikey$/i,             // alternate spelling, two-token only
  /^(?:MMX|MINIMAX)_API_KEY$/i, // env name passed as argv
];

/**
 * Redact known secret patterns from a string. Pure, never throws.
 *
 * @param {string} s
 * @param {{ replacement?: string }} [opts]
 * @returns {string}
 */
function redactString(s, opts) {
  if (typeof s !== 'string') return s;
  const repl = (opts && opts.replacement) || REDACTED;
  let out = s;
  for (const p of _PATTERNS) {
    // Re-create the regex per call so the `g` flag's lastIndex doesn't
    // leak between replacements (defensive; the function is pure and
    // we want the unit tests to be deterministic).
    const re = new RegExp(p.re.source, p.re.flags);
    out = out.replace(re, p.replace.replace('***', repl));
  }
  return out;
}

/**
 * Deep-redact any value. Recursively walks strings, arrays, and plain
 * objects (own enumerable properties). Errors get their message +
 * stack scrubbed. Functions, Dates, RegExps, Maps, Sets, Buffers, and
 * other non-plain values are returned as-is (they can't carry a raw
 * secret in a serialised form, and we don't want to break them).
 *
 * Cycles are guarded via a WeakSet to avoid infinite recursion.
 *
 * @param {any} value
 * @param {{ replacement?: string }} [opts]
 * @returns {any}  a structurally-equivalent copy with secrets redacted
 */
function deepRedact(value, opts) {
  const repl = (opts && opts.replacement) || REDACTED;
  return _walk(value, repl, new WeakSet(), 0);
}

const _MAX_DEPTH = 50;

function _walk(value, repl, seen, depth) {
  if (depth > _MAX_DEPTH) return value;
  if (value == null) return value;
  const t = typeof value;
  if (t === 'string') return redactString(value, { replacement: repl });
  if (t === 'number' || t === 'boolean' || t === 'bigint' || t === 'undefined' || t === 'symbol' || t === 'function') {
    return value;
  }
  // Object branch
  if (seen.has(value)) return value; // cycle guard
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        const el = value[i];
        // Check if THIS element is a secret-marker and the NEXT element
        // is the value (covers CLI argv: ['--api-key', SECRET]).
        if (typeof el === 'string' && el.trim() !== '' && _ARRAY_SECRET_MARKER_PATTERNS.some((re) => re.test(el.trim()))) {
          // A capability snapshot may list flag names consecutively. The
          // token after --api-key is only secret when it is a value, never
          // when it is another flag.
          if (i + 1 < value.length && !(typeof value[i + 1] === 'string' && value[i + 1].trim().startsWith('--'))) {
            out[i] = el; // keep the marker
            out[i + 1] = repl; // redact the value
            i++; // skip the next element (already redacted)
            continue;
          }
        }
        // Same-token form: ['--api-key=SECRET'] (single argv element)
        if (typeof el === 'string' && /--api(-?)key=.+/i.test(el)) {
          out[i] = el.replace(/--api(-?)key=.+/i, '--api-key=***');
          continue;
        }
        out[i] = _walk(el, repl, seen, depth + 1);
      }
      return out;
    }
    if (value instanceof Error) {
      // Errors: rebuild a new Error with the redacted message + stack.
      // We don't try to copy every custom Error subclass (e.g.
      // MmSessionError) — the message + stack are what gets serialised
      // into IPC envelopes, and that's what the tests assert on. We DO
      // copy the non-secret Error fields (code, errno, syscall) and
      // scrub the secret-prone fields (path, paths, addresses,
      // hostname, host, port) — the spawn ENOENT case in particular
      // carries the spawn-target path in `error.path`, which on
      // Windows can include a username or a path that the user typed
      // (and might include a secret literal).
      const out = new Error(redactString(String(value.message || ''), { replacement: repl }));
      out.name = String(value.name || 'Error');
      const stack = value.stack;
      if (typeof stack === 'string') {
        out.stack = redactString(stack, { replacement: repl });
      }
      // Non-secret fields: copied verbatim (they are numeric or
      // platform-constants, never carry a secret).
      for (const k of ['code', 'errno', 'syscall']) {
        if (k in value) out[k] = value[k];
      }
      // Secret-prone fields: walked through the normaliser so any
      // secret pattern in the value is scrubbed.
      for (const k of ['path', 'paths', 'address', 'hostname', 'host', 'port']) {
        if (k in value) out[k] = _walk(value[k], repl, seen, depth + 1);
      }
      return out;
    }
    if (value instanceof Date || value instanceof RegExp || value instanceof Buffer) {
      return value;
    }
    // Plain object: walk own enumerable properties.
    const out = {};
    for (const k of Object.keys(value)) {
      const isSecretField = SECRET_FIELD_NAMES.has(String(k).toLowerCase());
      if (isSecretField) {
        const v = value[k];
        if (v == null || v === '') {
          out[k] = v;
        } else {
          // Replace the value with a redacted placeholder. We DO
          // preserve the original TYPE (number → number, etc.) so a
          // test that checks `result.apiKeyLength` still works.
          if (typeof v === 'string') {
            out[k] = repl; // string fields: replace with the redaction marker
          } else {
            out[k] = v; // non-string fields: keep the value (e.g. apiKeyLength stays a number)
          }
        }
      } else {
        out[k] = _walk(value[k], repl, seen, depth + 1);
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Convenience: redacts a known secret value OUT of a string. If the
 * secret is not present, the string is returned unchanged. This is
 * the building block the higher-level call sites use when they know
 * the exact secret (e.g. the in-memory apiKey from the SessionCredentialStore).
 *
 * @param {string} s
 * @param {string} secret
 * @returns {string}
 */
function redactValue(s, secret) {
  if (typeof s !== 'string' || typeof secret !== 'string' || !secret) return s;
  // Use a literal string replace — no regex special-char escaping
  // needed because the secret is a literal value. Split + join is
  // safe for large strings and avoids global-regex lastIndex pitfalls.
  return s.split(secret).join('***');
}

module.exports = {
  deepRedact,
  redactString,
  redactValue,
  REDACTED,
  // Exposed for tests only — do not consume from app code.
  _SECRET_FIELD_NAMES: SECRET_FIELD_NAMES,
  _PATTERNS: _PATTERNS,
};
