// main/ipc/registerExternalToolsIpc.js
// IPC handlers for the "External tools" feature: user-defined
// 3rd-party programs (GIMP, Photoshop, Notepad++, Audacity, …) that
// the file-browser context menu can hand files off to.
//
// Why a dedicated module: spawning arbitrary user-chosen executables
// is a security-sensitive surface (every shell-escape hole is a remote
// code execution vector). All the allow-listing + spawn-arg-quoting
// logic lives here so the rest of the codebase never has to think
// about it. The renderer is reduced to a single IPC call:
//   window.api.externalToolsRun({ name, paths, grantId })
// which is forwarded to the spawn pipeline below.
//
// R1.5b.2: `externalTools:run` now takes a trailing `grantId`
// argument (same pattern as the R1.5a IPC migrations). The grant
// must authorise 'read' on every file path in `payload.paths` —
// the grant is the source of truth for "is the renderer allowed to
// hand this file to the spawned tool?". The legacy
// `pathUtils.isPathUnderAny` + `PathSecurityService.getAllowedRoots`
// gate has been replaced by the grant check (the legacy
// `pathSecurity` + `pathUtils` modules are no longer used in this
// file — the grant is the source of truth for the renderer's file
// paths). The tool's exe path is still validated by
// `validateExePath` (absolute + exists + is-a-regular-file +
// not-a-Windows-device-name) but that check is config-derived
// (the renderer can't influence the exe path; only the NAME is
// renderer-supplied). `externalTools:probe` is unchanged (no
// file paths in the payload — just exe metadata; no grant
// required).

const { ipcMain, shell } = require('electron');
const fsp = require('fs').promises;
const path = require('path');
const cfgMod = require('../../src/config');
// R1.5b.2: shared grant authoriser (R1.5a.6) replaces the legacy
// path-under-any gate for the renderer's file paths. The grant is
// the source of truth for "is the renderer allowed to hand this
// file to the spawned tool?".
const { authorizePath: _authorizePath } = require('./grantAuthorizer');

/**
 * Strict "no shell" quoting for Windows + POSIX.
 *
 * The user's hand-off is `<exe> "<file1>" "<file2>" … <extra-args>`. The
 * safe + portable way to deliver it on every platform is to pass the
 * full argv as an array to `child_process.spawn` (NEVER `exec` / a
 * shell). spawn() then handles per-arg quoting internally; the OS
 * receives the same argv the user expects (a process that reads
 * `GetCommandLineW` on Windows or `argv[]` on POSIX sees exactly the
 * path it would have seen from a normal Windows-Explorer "Open
 * with" verb).
 *
 * We do NOT call `shell.openPath` here — that would be the file's
 * OS-default association (a .png would launch in Photos), NOT the
 * user-picked tool. `spawn` is the right primitive.
 */
function buildArgvForTool(tool, filePaths, platform) {
  // Extra args first. The user can type a single string ("--no-sandbox"),
  // a quoted string, or leave it blank. We split on whitespace but
  // honour a single layer of double-quotes so a value like
  // "--foo \"bar baz\"" round-trips as two tokens.
  const tokens = [];
  const extra = (tool && tool.args) ? String(tool.args) : '';
  if (extra.trim()) {
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(extra)) !== null) tokens.push(m[1] !== undefined ? m[1] : m[2]);
  }
  // File paths go LAST so the user's --foo <value> flags parse
  // first (and any tool that does its own argv parsing on the file
  // list sees the right shape). This matches the Windows
  // "Open with" verb convention: %1 is appended.
  for (const fp of filePaths) tokens.push(fp);
  // `spawn` does not care about quoting when given an array, but we
  // sanitize against newlines / null bytes that would corrupt the
  // argv on some OSes.
  for (const t of tokens) {
    if (typeof t !== 'string') throw new Error('Every argv token must be a string.');
    if (/[\r\n\0]/.test(t)) throw new Error('argv token contains a control character: ' + JSON.stringify(t));
  }
  return tokens;
}

/**
 * Sanity-check the user-supplied exe path. We refuse to spawn
 * anything that:
 *   - is empty
 *   - is not absolute (relative paths would depend on CWD and
 *     surprise the user; if the tool is in PATH the user can
 *     still type the full path)
 *   - contains a shell meta character (`"`, `|`, `>`, `<`, `&`,
 *     `;`, backtick) — these are valid in normal paths on
 *     Windows but a stray `>` usually means the user typed
 *     something they didn't mean
 *   - has a Windows-style device-name collision (`C:\foo\CON.exe`)
 *   - does not exist OR is not a regular file
 */
async function validateExePath(exe) {
  if (!exe || typeof exe !== 'string') throw new Error('Exe path is required.');
  const trimmed = exe.trim();
  if (!trimmed) throw new Error('Exe path is required.');
  if (!path.isAbsolute(trimmed)) throw new Error('Exe path must be absolute (start with a drive letter or "/"). Paste the full path from the Windows Explorer address bar or "Browse…".');
  if (/["|>;&`<]/.test(trimmed)) throw new Error('Exe path contains a shell meta character that is almost certainly a typo. Remove the " | < > & ; ` " character and re-paste the path.');
  // Reject Windows reserved device names as the basename (a folder
  // named CON would be fine but the tool's exe almost certainly is
  // not). This also catches "nul", "prn", "aux" etc.
  const base = path.basename(trimmed).replace(/\.exe$/i, '').toUpperCase();
  if (['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'].includes(base)) {
    throw new Error(`Refusing to spawn reserved device name "${base}". Pick the real .exe of the tool.`);
  }
  // Existence + regular-file check. Symlinks are allowed (many tools
  // live in "Program Files" behind a junction) but the symlink
  // target MUST be a regular file.
  let st;
  try { st = await fsp.stat(trimmed); }
  catch (e) {
    throw new Error(`Exe path does not exist: ${trimmed}`);
  }
  if (!st.isFile()) throw new Error(`Exe path is not a regular file: ${trimmed}`);
  return trimmed;
}

/**
 * Spawn a configured external tool. The file paths in `payload.paths`
 * are authorised against a Main-minted grant (the renderer passes
 * the grantId as the 2nd argument to `externalTools:run`). The grant
 * is the source of truth for "is the renderer allowed to hand this
 * file to the spawned tool?".
 *
 * Errors come back as `{ ok: false, error }`. Success is
 * `{ ok: true, pid }` — we DO NOT wait for the tool to exit; the
 * user expects a "fire and forget" launch (GIMP / Photoshop
 * typically take seconds to start, and the tool's lifecycle is
 * independent of ours). We still pipe stdio to /dev/null-equivalent
 * so a chatty tool doesn't fill up the main process's stdio
 * buffers.
 *
 * R1.5b.2: signature is now `runExternalTool(payload, grantId)`.
 * The grantId is required. A missing / non-string grantId fails
 * closed (the renderer forgot to mint a grant for the file paths).
 * A grant that doesn't authorise any of the paths also fails
 * closed (per-path error message names the offending file).
 */
async function runExternalTool(payload, grantId) {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'Payload is required.' };
    }
    const { name, paths } = payload;
    if (!name || typeof name !== 'string') {
      return { ok: false, error: 'Tool name is required.' };
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, error: 'At least one file path is required.' };
    }
    // R1.5b.2: pre-validate the file paths' shape BEFORE the grant
    // check, so a non-string path yields the legacy "every file
    // path must be a non-empty string" error (the user-facing
    // surface is unchanged) rather than a grant error.
    for (const p of paths) {
      if (typeof p !== 'string' || !p) {
        return { ok: false, error: 'Every file path must be a non-empty string.' };
      }
    }
    // R1.5b.2: authorise every file path against the grant. The
    // grant must authorise 'read' on the file (a directory grant
    // for the parent dir covers the file as a strict descendant;
    // a file grant is an exact-path match). One failed path
    // fails the call closed with the offending path in the
    // error message.
    //
    // gewv2 GEW-012 fix: `grantId` may now be a single string OR an ARRAY
    // of grantIds — grantHelper.ensureExternalToolRead mints one grant per
    // DISTINCT parent directory among the selected paths (not just a single
    // common-ancestor mint of first+last), so a multi-folder selection whose
    // middle path lay outside that single ancestor is no longer rejected.
    // Each path only needs to be authorised by ANY ONE of the supplied
    // grants (still fail-closed: an unauthorised path still hard-rejects).
    const grantIds = Array.isArray(grantId) ? grantId : [grantId];
    if (!grantIds.length || grantIds.some((g) => !g || typeof g !== 'string')) {
      return { ok: false, error: 'A grantId is required to hand off files to an external tool (use a Main-minted grant from the picker or app-output).' };
    }
    for (const p of paths) {
      const authorised = grantIds.some((g) => _authorizePath(g, 'read', p).ok);
      if (!authorised) {
        return { ok: false, error: `File path "${p}" is not authorised by the grant` };
      }
    }
    // Pull the tool from the persisted config. We intentionally do
    // NOT accept the exe from the renderer (that would defeat the
    // allow-list — the user could send any .exe and the IPC would
    // spawn it). The renderer only sends the NAME; we look up the
    // exe ourselves.
    const cfg = cfgMod.read();
    const tool = (cfg.external_tools || []).find((t) => t && t.name === name);
    if (!tool) {
      return { ok: false, error: `Tool "${name}" is not configured. Open ⚙ Settings → External tools to add it.` };
    }
    if (!tool.exe) {
      return { ok: false, error: `Tool "${name}" has no exe path configured. Re-edit it in ⚙ Settings → External tools.` };
    }
    // Validate the exe (existence + safe shape). The exe path is
    // tool-config-derived (NOT renderer-supplied), so the legacy
    // path-under-any gate is still the right check here — the
    // grant is for the renderer's file paths, not the tool's
    // exe path.
    let exe;
    try { exe = await validateExePath(tool.exe); }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
    // Build the argv. Order: <extra-args> <file1> <file2> … — same
    // shape the user would see from `cmd /c "tool.exe" "a.png" "b.png"`.
    const argv = buildArgvForTool(tool, paths, process.platform);
    // Detach so the tool keeps running after our process is gone
    // (e.g. when the user closes the asset tool while GIMP is
    // still open). detached:true on Windows requires the
    // shell:true flag to actually free the parent. We choose
    // detached + unref() so the child survives the parent's
    // exit and stdio is discarded.
    const { spawn } = require('child_process');
    const child = spawn(exe, argv, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      // Don't let the spawned tool hijack the parent's console
      // window on Windows.
      windowsVerbatimArguments: false,
    });
    // Best-effort: don't keep the parent's event loop alive for
    // the child. On Windows, detached:true also requires the
    // child to be unref()'d so it can outlive the parent.
    if (typeof child.unref === 'function') {
      try { child.unref(); } catch (_) { /* best-effort */ }
    }
    return { ok: true, pid: child.pid, argv };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * `externalTools:probe` lets the renderer's "Test" button in the
 * External tools settings pane check the configured exe without
 * actually launching it. Returns a plain
 * `{ ok, exists, isFile, size, version }` summary so the pane
 * can show "GIMP 2.10.36 (26 MB) ✓" next to each configured tool.
 *
 * The version probing is intentionally minimal — we just read the
 * .exe file's version metadata via `fsp.stat` + a best-effort
 * "version" string the renderer can pretty-print. Reading the
 * actual Windows VERSIONINFO resource would need a parser we
 * don't want to ship, so we fall back to "(version unknown)" for
 * everything except the most common format.
 */
async function probeExternalTool(payload) {
  try {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'Payload is required.' };
    }
    const { name } = payload;
    // H10-7: an optional `exe` override lets the renderer probe the tool's
    // path BEFORE it has been saved to config (so the "Test" button in the
    // Add-ons editor works on the in-memory draft). When `exe` is supplied we
    // probe that path directly; otherwise we fall back to persisted config
    // (the original behaviour).
    const exeOverride = (typeof payload.exe === 'string' && payload.exe.trim()) ? payload.exe.trim() : null;
    let trimmed = '';
    if (exeOverride) {
      trimmed = exeOverride;
    } else {
      if (!name || typeof name !== 'string') {
        return { ok: false, error: 'Tool name is required.' };
      }
      const cfg = cfgMod.read();
      const tool = (cfg.external_tools || []).find((t) => t && t.name === name);
      if (!tool) return { ok: false, error: `Tool "${name}" is not configured.` };
      if (!tool.exe) return { ok: true, exists: false, isFile: false };
      trimmed = String(tool.exe).trim();
    }
    try {
      const st = await fsp.stat(trimmed);
      return {
        ok: true,
        exists: true,
        isFile: st.isFile(),
        size: st.size,
        path: trimmed,
      };
    } catch (_) {
      return { ok: true, exists: false, isFile: false, path: trimmed };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Register the IPC handlers. Kept tiny so a unit test can call
 * `register({ appRoot, getMainWindow })` directly without booting
 * Electron.
 */
function register() {
  // R1.5b.2: externalTools:run takes a trailing grantId (the
  // renderer's Main-minted grant that authorises the file paths
  // in `payload.paths`). The grant is the source of truth for
  // "is the renderer allowed to hand this file to the spawned
  // tool?".
  ipcMain.handle('externalTools:run', async (_e, payload, grantId) => runExternalTool(payload, grantId));
  // externalTools:probe is unchanged (no file paths in the
  // payload — just exe metadata).
  ipcMain.handle('externalTools:probe', async (_e, payload) => probeExternalTool(payload));
}

module.exports = {
  register,
  // Exposed for tests so the helpers can be driven without an IPC
  // round-trip. Production code goes through the IPC handlers.
  _internal: {
    buildArgvForTool,
    validateExePath,
    runExternalTool,
    probeExternalTool,
  },
};