// src/config.js
// Read/write config.txt that lives next to the executable (or in dev: next to package.json).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { randomUUID } = require('crypto');

function configDir() {
  // 1) Env override (lets the launcher.bat force a specific dir)
  if (process.env.MINIMAX_CONFIG_DIR) return process.env.MINIMAX_CONFIG_DIR;
  // 2) Packaged .exe: the directory holding MiniMaxAssetsTool.exe
  try {
    if (app && app.isPackaged) return path.dirname(app.getPath('exe'));
  } catch { /* fall through */ }
  // 3) Dev: Electron knows the application root; do not write into
  // node_modules/electron/dist next to Electron.exe.
  try {
    if (app && typeof app.getAppPath === 'function') return app.getAppPath();
  } catch { /* fall through */ }
  // 4) Launcher / plain Node fallback.
  return process.cwd();
}

function configPath() {
  return path.join(configDir(), 'config.txt');
}

function defaultConfig() {
  return {
    api_key: '',
    output_dir: '',
    report_dir: '',      // optional folder for Pipeline clear/export reports ('' = use the asset destination folder)
    region: 'global',
    theme: 'dark',
    styles: [],          // [{ name, value }]
    external_tools: [],  // [{ name, exe, args }] — 3rd-party tools reachable from the file-browser context menu
    raw: '',
  };
}

function parse(text) {
  const out = defaultConfig();
  out.raw = text || '';
  if (!text) return out;
  let inStyles = false;
  let inExtTools = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { inStyles = false; inExtTools = false; continue; }
    if (line.startsWith('#') || line.startsWith(';')) continue;
    if (/^\[\s*styles\s*\]$/i.test(line)) { inStyles = true; inExtTools = false; continue; }
    if (/^\[\s*external_tools\s*\]$/i.test(line)) { inExtTools = true; inStyles = false; continue; }
    if (/^\[.+\]$/.test(line)) { inStyles = false; inExtTools = false; continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (inStyles) {
      // style entry: name = value
      if (k && v) out.styles.push({ name: k, value: v });
      continue;
    }
    if (inExtTools) {
      // External-tool entry. The first '=' splits name from a
      // pipe-separated record (exe|args), matching the editor's
      // "name | exe | args" summary line. exe and args may both be
      // empty (user is mid-edit), so we only require name.
      if (k) {
        const parts = v.split('|');
        out.external_tools.push({
          name: k,
          exe: (parts[0] || '').trim(),
          args: (parts[1] || '').trim(),
        });
      }
      continue;
    }
    if (k === 'api_key') out.api_key = v;
    else if (k === 'output_dir') out.output_dir = v;
    else if (k === 'report_dir') out.report_dir = v;
    // removebg_api_key is intentionally NOT assigned: the feature was removed
    // (H7-018 — the UI collected it but no code consumed it). We still
    // tolerate the line in old config.txt files so they migrate cleanly; the
    // value is silently dropped on the next write.
    else if (k === 'region') out.region = v || 'global';
    else if (k === 'theme') out.theme = (v === 'light' ? 'light' : 'dark');
  }
  return out;
}

function serialize(cfg) {
  const styles = Array.isArray(cfg.styles) ? cfg.styles : [];
  const extTools = Array.isArray(cfg.external_tools) ? cfg.external_tools : [];
  const lines = [
    '# MiniMax Assets Tool configuration',
    '# Put your MiniMax API key on the line below, save as config.txt next to the .exe.',
    '# Both Token Plan keys (sk-cp-…) and pay-as-you-go keys are accepted.',
    '',
    `api_key=${cfg.api_key || ''}`,
    '',
    '# Default output directory for generated assets (created if missing).',
    '# Leave blank to use ./generated/ next to the executable.',
    `output_dir=${cfg.output_dir || ''}`,
    '',
    '# Optional: where Pipeline clear/export reports (.md) are written.',
    '# Leave blank to write the report next to the assets (their destination folder).',
    `report_dir=${cfg.report_dir || ''}`,
    '',
    '# Region: global (default) or cn',
    `region=${cfg.region || 'global'}`,
    '',
    '# Theme: dark (default) or light',
    `theme=${cfg.theme === 'light' ? 'light' : 'dark'}`,
    '',
    '# ---------- Style presets ----------',
    '# Each line: <name> = <prompt prefix to prepend>',
    '# Used in every tab to prepend a style to your manual prompt.',
    '# Manage via the gear icon → "Style Settings".',
    '',
  ];
  if (styles.length) {
    lines.push('[styles]');
    for (const s of styles) {
      // escape '=' inside value to avoid parse ambiguity
      const safeName = String(s.name || '').replace(/[\r\n]+/g, ' ').slice(0, 80);
      const safeVal = String(s.value || '').replace(/[\r\n]+/g, ' ').slice(0, 2000);
      lines.push(`${safeName} = ${safeVal}`);
    }
    lines.push('');
  } else {
    lines.push('# [styles]');
    lines.push('# (no styles yet — open the app, click ⚙ → "Style Settings" to add some)');
    lines.push('');
  }
  if (extTools.length) {
    lines.push('# ---------- External tools ----------');
    lines.push('# Each line: <name> = <exe-path>[|<extra-cli-args>]');
    lines.push('# The tool is launched with the file path(s) appended as the last');
    lines.push('# argument(s). Lines live in [external_tools] below.');
    lines.push('# Manage via the gear icon → "External tools".');
    lines.push('');
    lines.push('[external_tools]');
    for (const t of extTools) {
      const safeName = String(t.name || '').replace(/[\r\n|]+/g, ' ').slice(0, 80);
      const safeExe = String(t.exe || '').replace(/[\r\n|]+/g, ' ').slice(0, 1024);
      const safeArgs = String(t.args || '').replace(/[\r\n|]+/g, ' ').slice(0, 1024);
      // Pipe is the in-band separator; the parse() side splits on the
      // FIRST pipe so a value with no pipe → no args.
      lines.push(`${safeName} = ${safeExe}|${safeArgs}`);
    }
    lines.push('');
  } else {
    lines.push('# ---------- External tools ----------');
    lines.push('# (no external tools yet — open the app, click ⚙ → "External tools" to add some)');
    lines.push('# Each line: <name> = <exe-path>[|<extra-cli-args>]');
    lines.push('');
  }
  return lines.join('\n');
}

function read() {
  const p = configPath();
  if (!fs.existsSync(p)) return defaultConfig();
  try {
    return parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // Don't silently lose the user's API key when parse fails — back the
    // file up so a human (or a future write) can recover it. The next
    // successful write overwrites the backup.
    try {
      const backup = p + '.corrupt-' + Date.now();
      fs.copyFileSync(p, backup);
      // eslint-disable-next-line no-console
      console.error('[config] parse failed, backed up to', backup, e);
    } catch { /* backup may fail (read-only fs), continue with default */ }
    return defaultConfig();
  }
}

function write(cfg) {
  const p = configPath();
  // Atomic write: write to a temp file in the same directory then rename.
  // If the process is killed mid-write the original is untouched.
  const tmp = p + '.tmp-' + randomUUID();
  fs.writeFileSync(tmp, serialize(cfg), 'utf8');
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    // Best-effort cleanup of the temp file on rename failure
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function effectiveOutputDir(cfg) {
  if (cfg.output_dir && cfg.output_dir.trim()) return cfg.output_dir.trim();
  return defaultOutputDir();
}

/**
 * Resolve the effective output directory and create it (recursively) if it
 * does not yet exist. Returns the resolved directory path.
 *
 * Electron only auto-creates `app.getPath('userData')` on first access — it
 * does NOT create a `generated` subfolder under it. Without this call, a
 * clean first launch pointed the file browser at `<userData>/generated`
 * (the default) and the renderer's first `fb:list` threw
 * `ENOENT: no such file or directory, scandir ...\generated` (H7-004).
 *
 * Failures are thrown to the caller so boot can decide whether to log+continue
 * (a read-only userData) or hard-abort. The directory is created with
 * `{ recursive: true }` so an arbitrary nested `output_dir` also works.
 */
function ensureOutputDir(cfg) {
  const dir = effectiveOutputDir(cfg || {});
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Default output directory when `cfg.output_dir` is blank.
 *
 * Generated assets are written under Electron's `app.getPath('userData')`
 * (e.g. `C:\Users\<user>\AppData\Roaming\MiniMaxAssetTool` on Windows) plus
 * a `generated` subdir. That is the canonical per-user, per-app data
 * location, keeps generated assets grouped under one discoverable path, and
 * avoids collisions with config.txt / state.json / batches.json / voices.json.
 *
 * In dev (`electron .`) `app.getPath('userData')` returns `<project-root>`
 * by default, which is also fine; the location can be changed in Settings at
 * any time.
 */
function defaultOutputDir() {
  let base;
  try {
    const { app } = require('electron');
    base = app.getPath('userData');
  } catch {
    // Fallback for tests / non-Electron contexts.
    base = path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'MiniMaxAssetTool');
  }
  return path.join(base, 'generated');
}

module.exports = { configPath, read, write, effectiveOutputDir, ensureOutputDir, defaultConfig, parse, serialize, configDir, defaultOutputDir };
