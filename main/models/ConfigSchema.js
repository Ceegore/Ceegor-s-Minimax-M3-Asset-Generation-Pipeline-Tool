// main/models/ConfigSchema.js
// Sanitizer for config objects coming in from the renderer. Drops fields not
// defined in the schema and enforces types, so a compromised renderer can't
// inject unknown keys into config.txt.
//
// NOTE: sanitize() must whitelist every actively-collected field. Two such
// fields — external_tools (Settings -> Add-ons -> External tools) and
// report_dir (Settings -> General) — must be kept here, because config:set
// runs sanitize() before cfgMod.write() and otherwise simply opening Settings
// + Save would wipe them from config.txt.
//
// removebg_api_key was removed (H7-018): the UI collected it but no execution
// path consumed it, so it was misleading dead code + an unnecessary stored
// secret. A leftover line in an old config.txt is still tolerated by parse()
// (it is read but never serialized back), so existing files migrate cleanly.

const TOOL_NAME_MAX = 80;
const TOOL_PATH_MAX = 1024;
const TOOL_ARGS_MAX = 1024;

function clampStr(value, max) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

// Strip CR/LF (and other C0 control chars) from a scalar so it can't inject
// extra INI directives when written to config.txt. config.js parse() splits the
// file on /\r?\n/ and treats each line as a key=value, so a newline inside any
// scalar value overwrites arbitrary keys on the next read. Mirrors the [\r\n]
// strip styles/external_tools already do.
function cleanScalar(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\r\n\x00-\x1f]+/g, ' ');
}

// Sanitize the external_tools array: each entry must be { name, exe, args }
// with string fields; name/exe are clamped; args is clamped + optional.
function sanitizeExternalTools(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const t of value) {
    if (!t || typeof t !== 'object') continue;
    const name = clampStr(t.name, TOOL_NAME_MAX).replace(/[\r\n|]+/g, ' ').trim();
    const exe = clampStr(t.exe, TOOL_PATH_MAX).replace(/[\r\n|]+/g, ' ').trim();
    const args = clampStr(t.args, TOOL_ARGS_MAX).replace(/[\r\n|]+/g, ' ').trim();
    if (!name || !exe) continue; // a tool with no name or no exe is unusable
    out.push({ name, exe, args });
  }
  return out;
}

/**
 * Sanitises a config (from the renderer or any caller) against the schema
 * declared in the IConfigProvider contract.
 *
 * @param {object|undefined|null} cfg
 * @returns {{
 *   api_key: string,
 *   output_dir: string,
 *   report_dir: string,
 *   region: 'global' | 'cn',
 *   theme: 'light' | 'dark',
 *   batch_max_units: number,
 *   styles: Array<{name: string, value: string}>,
 *   external_tools: Array<{name: string, exe: string, args: string}>,
 * }}
 */
function sanitize(cfg) {
  cfg = cfg || {};
  return {
    // Every scalar field is written verbatim to config.txt (an INI-like file
    // parsed line-by-line), so a newline in ANY scalar injects an extra
    // key=value directive. A malicious renderer (or a pasted multi-line value)
    // could overwrite api_key / output_dir / report_dir via e.g.
    //   report_dir = "D:/ok\napi_key=PWNED"
    // (the injected value survives sanitize -> write -> read and replaces the
    // real api_key). styles + external_tools already strip [\r\n]; the three
    // scalars do not. Strip CR/LF (and other control chars) from every scalar
    // here.
    api_key: cleanScalar(cfg.api_key),
    output_dir: cleanScalar(cfg.output_dir),
    // report_dir is a persisted path setting for the Pipeline clear/export
    // reports. Whitelisted here so config:set keeps it.
    report_dir: cleanScalar(cfg.report_dir),
    region: cfg.region === 'cn' ? 'cn' : 'global',
    theme: cfg.theme === 'light' ? 'light' : 'dark',
    // P4.3 (DB-H-003): batch cost cap. Whitelisted so config:set keeps it —
    // clamp mirrors src/config.js parse() (1..10000, garbage → 200).
    batch_max_units: (() => {
      const n = parseInt(cfg.batch_max_units, 10);
      return Number.isFinite(n) && n >= 1 ? Math.min(n, 10000) : 200;
    })(),
    styles: Array.isArray(cfg.styles)
      ? cfg.styles
          .filter((s) => s && typeof s === 'object' && typeof s.name === 'string' && typeof s.value === 'string')
          .map((s) => ({ name: s.name, value: s.value }))
      : [],
    external_tools: sanitizeExternalTools(cfg.external_tools),
  };
}

module.exports = { sanitize };
