// Preload bridge: expose a small, typed API to the renderer
const { contextBridge, ipcRenderer } = require('electron');

// ---- sandbox-safe path utilities ------------------------------------------
// This preload runs with `sandbox: true` (see main/window/createMainWindow.js
// and scripts/smoke-renderer.js). A sandboxed preload may only require a tiny
// allow-list of modules (`electron`, `events`, `timers`, `url`) — Node's
// built-in `path` is NOT on it. PRE-1 originally did `require('path')` here,
// which crashed the preload with "module not found: path" and left the whole
// renderer without `window.api` (init() then died on `window.api.getConfig`).
//
// The functions below are faithful ports of Node's `path.win32` algorithms
// (they accept both `/` and `\` separators and understand drive letters and
// UNC roots), so the renderer's path helpers behave exactly like the real
// `path` module without needing Node. Do NOT add `require('path')` (or any
// other Node built-in) to this file — the preload-sandbox regression test in
// tests/unit/main/preloadSandboxSafety.test.js guards this.
const CHAR_FORWARD_SLASH = 0x2f; /* / */
const CHAR_BACKWARD_SLASH = 0x5c; /* \ */
const CHAR_DOT = 0x2e; /* . */
const CHAR_COLON = 0x3a; /* : */

function _isPathSep(code) {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}
function _isDeviceRoot(code) {
  // A-Z or a-z
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}
function _assertString(v, name) {
  if (typeof v !== 'string') {
    throw new TypeError(`The "${name}" argument must be of type string. Received ${typeof v}`);
  }
}

// path.win32.dirname — faithful port of Node's algorithm.
function _winDirname(p) {
  _assertString(p, 'path');
  const len = p.length;
  let rootEnd = -1;
  let offset = 0;
  const code = p.charCodeAt(0);

  if (len === 1) {
    // `path` contains just a single char: a separator stays, else '.'.
    return _isPathSep(code) ? p : '.';
  }

  // Try to match a root
  if (_isPathSep(code)) {
    // Possible UNC root
    rootEnd = offset = 1;
    if (_isPathSep(p.charCodeAt(1))) {
      // Matched double path separator at beginning
      let j = 2;
      let last = j;
      // Match 1 or more non-path separators (the server)
      for (; j < len; ++j) { if (_isPathSep(p.charCodeAt(j))) break; }
      if (j < len && j !== last) {
        last = j;
        // Match 1 or more path separators
        for (; j < len; ++j) { if (!_isPathSep(p.charCodeAt(j))) break; }
        if (j < len && j !== last) {
          last = j;
          // Match 1 or more non-path separators (the share)
          for (; j < len; ++j) { if (_isPathSep(p.charCodeAt(j))) break; }
          if (j === len) {
            // We matched a UNC root only
            return p;
          }
          if (j !== last) {
            // We matched a UNC root with leftovers. Offset by 1 to include
            // the separator after the UNC root, treating it as a "normal
            // root" on top of the (UNC) root.
            rootEnd = offset = j + 1;
          }
        }
      }
    }
    // Possible device root
  } else if (_isDeviceRoot(code) && p.charCodeAt(1) === CHAR_COLON) {
    rootEnd = (len > 2 && _isPathSep(p.charCodeAt(2))) ? 3 : 2;
    offset = rootEnd;
  }

  let end = -1;
  let matchedSlash = true;
  for (let i = len - 1; i >= offset; --i) {
    if (_isPathSep(p.charCodeAt(i))) {
      if (!matchedSlash) { end = i; break; }
    } else {
      // We saw the first non-path separator
      matchedSlash = false;
    }
  }

  if (end === -1) {
    if (rootEnd === -1) return '.';
    end = rootEnd;
  }
  return p.slice(0, end);
}

// path.win32.basename (single-argument form) — faithful port of Node's.
function _winBasename(p) {
  _assertString(p, 'path');
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  // Check for a drive letter prefix so as not to mistake the following path
  // separator as an extra separator at the end of the path.
  if (p.length >= 2 && _isDeviceRoot(p.charCodeAt(0)) && p.charCodeAt(1) === CHAR_COLON) {
    start = 2;
  }
  for (let i = p.length - 1; i >= start; --i) {
    if (_isPathSep(p.charCodeAt(i))) {
      // A separator that was not part of trailing separators: stop.
      if (!matchedSlash) { start = i + 1; break; }
    } else if (end === -1) {
      // First non-separator: mark the end of the basename.
      matchedSlash = false;
      end = i + 1;
    }
  }
  if (end === -1) return '';
  return p.slice(start, end);
}

// path.win32.extname — faithful port of Node's algorithm.
function _winExtname(p) {
  _assertString(p, 'path');
  let start = 0;
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  // Track the state of characters (if any) we see before our first dot and
  // after any path separator we find.
  let preDotState = 0;
  // Check for a drive letter prefix so as not to mistake the following path
  // separator as an extra separator at the end of the path.
  if (p.length >= 2 && p.charCodeAt(1) === CHAR_COLON && _isDeviceRoot(p.charCodeAt(0))) {
    start = startPart = 2;
  }
  for (let i = p.length - 1; i >= start; --i) {
    const code = p.charCodeAt(i);
    if (_isPathSep(code)) {
      // A separator not part of trailing separators: stop.
      if (!matchedSlash) { startPart = i + 1; break; }
      continue;
    }
    if (end === -1) {
      // First non-separator: mark the end of our extension.
      matchedSlash = false;
      end = i + 1;
    }
    if (code === CHAR_DOT) {
      // If this is our first dot, mark it as the start of our extension.
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      // We saw a non-dot and non-separator before our dot, so we should
      // return a good extension.
      preDotState = -1;
    }
  }
  if (startDot === -1 ||
      end === -1 ||
      // We saw a non-dot character immediately before the dot
      preDotState === 0 ||
      // The (right-most) trimmed path component is exactly '..'
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
    return '';
  }
  return p.slice(startDot, end);
}

// Windows reserved device names (CON, PRN, COM1, ...) — verbatim from Node.
const _WINDOWS_RESERVED_NAMES = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  'COM\u00b9', 'COM\u00b2', 'COM\u00b3',
  'LPT\u00b9', 'LPT\u00b2', 'LPT\u00b3',
];
function _isWindowsReservedName(path, colonIndex) {
  const devicePart = path.slice(0, colonIndex).toUpperCase();
  return _WINDOWS_RESERVED_NAMES.includes(devicePart);
}

// Shared helper for _winNormalize — VERBATIM port of Node's normalizeString
// (StringPrototype* primordials replaced with method calls). Resolves '.' and
// '..' segments in the part of the path AFTER the root.
function _normalizeString(path, allowAboveRoot, separator) {
  let res = '';
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) {
      code = path.charCodeAt(i);
    } else if (_isPathSep(code)) {
      break;
    } else {
      code = CHAR_FORWARD_SLASH;
    }

    if (_isPathSep(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // NOOP
      } else if (dots === 2) {
        if (res.length < 2 ||
            lastSegmentLength !== 2 ||
            res.charCodeAt(res.length - 1) !== CHAR_DOT ||
            res.charCodeAt(res.length - 2) !== CHAR_DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.length - lastSegmentLength - 1;
            if (lastSlashIndex === -1) {
              res = '';
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf(separator);
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = '';
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? `${separator}..` : '..';
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) {
          res += `${separator}${path.slice(lastSlash + 1, i)}`;
        } else {
          res = path.slice(lastSlash + 1, i);
        }
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === CHAR_DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

// path.win32.normalize — VERBATIM port of Node's algorithm (used by _winJoin).
function _winNormalize(p) {
  _assertString(p, 'path');
  const len = p.length;
  if (len === 0) return '.';
  let rootEnd = 0;
  let device;
  let isAbsolute = false;
  const code = p.charCodeAt(0);

  // Try to match a root
  if (len === 1) {
    // `path` contains just a single char, exit early to avoid unnecessary work
    return code === CHAR_FORWARD_SLASH ? '\\' : p;
  }
  if (_isPathSep(code)) {
    // Possible UNC root. If we started with a separator, we know we at least
    // have an absolute path of some kind (UNC or otherwise).
    isAbsolute = true;
    if (_isPathSep(p.charCodeAt(1))) {
      // Matched double path separator at beginning
      let j = 2;
      let last = j;
      // Match 1 or more non-path separators
      while (j < len && !_isPathSep(p.charCodeAt(j))) j++;
      if (j < len && j !== last) {
        const firstPart = p.slice(last, j);
        // Matched!
        last = j;
        // Match 1 or more path separators
        while (j < len && _isPathSep(p.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          // Matched!
          last = j;
          // Match 1 or more non-path separators
          while (j < len && !_isPathSep(p.charCodeAt(j))) j++;
          if (j === len || j !== last) {
            if (firstPart === '.' || firstPart === '?') {
              // We matched a device root (e.g. \\.\PHYSICALDRIVE0)
              device = `\\\\${firstPart}`;
              rootEnd = 4;
              const colonIndex = p.indexOf(':');
              // Special case: handle \\?\COM1: or similar reserved device paths
              const possibleDevice = p.slice(4, colonIndex + 1);
              if (_isWindowsReservedName(possibleDevice, possibleDevice.length - 1)) {
                device = `\\\\?\\${possibleDevice}`;
                rootEnd = 4 + possibleDevice.length;
              }
            } else if (j === len) {
              // We matched a UNC root only — return the normalized version of
              // the UNC root since there is nothing left to process.
              return `\\\\${firstPart}\\${p.slice(last)}\\`;
            } else {
              // We matched a UNC root with leftovers
              device = `\\\\${firstPart}\\${p.slice(last, j)}`;
              rootEnd = j;
            }
          }
        }
      }
    } else {
      rootEnd = 1;
    }
  } else {
    const colonIndex = p.indexOf(':');
    if (colonIndex > 0) {
      if (_isDeviceRoot(code) && colonIndex === 1) {
        // Possible device root
        device = p.slice(0, 2);
        rootEnd = 2;
        if (len > 2 && _isPathSep(p.charCodeAt(2))) {
          // Treat separator following drive name as an absolute path indicator
          isAbsolute = true;
          rootEnd = 3;
        }
      } else if (_isWindowsReservedName(p, colonIndex)) {
        device = p.slice(0, colonIndex + 1);
        rootEnd = colonIndex + 1;
      }
    }
  }

  let tail = rootEnd < len ?
    _normalizeString(p.slice(rootEnd), !isAbsolute, '\\') : '';
  if (tail.length === 0 && !isAbsolute) tail = '.';
  if (tail.length > 0 && _isPathSep(p.charCodeAt(len - 1))) tail += '\\';
  if (!isAbsolute && device === undefined && p.includes(':')) {
    // If the original path was not absolute and we have not resolved it
    // relative to a particular device, ensure the `tail` has not become
    // something Windows might interpret as an absolute path (CVE-2024-36139).
    if (tail.length >= 2 &&
        _isDeviceRoot(tail.charCodeAt(0)) &&
        tail.charCodeAt(1) === CHAR_COLON) {
      return `.\\${tail}`;
    }
    let index = p.indexOf(':');
    do {
      if (index === len - 1 || _isPathSep(p.charCodeAt(index + 1))) {
        return `.\\${tail}`;
      }
    } while ((index = p.indexOf(':', index + 1)) !== -1);
  }
  const colonIndex = p.indexOf(':');
  if (_isWindowsReservedName(p, colonIndex)) {
    return `.\\${(device || '')}${tail}`;
  }
  if (device === undefined) {
    return isAbsolute ? `\\${tail}` : tail;
  }
  return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`;
}

// path.win32.join — VERBATIM port of Node's algorithm.
function _winJoin(...args) {
  if (args.length === 0) return '.';

  const segs = [];
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    _assertString(arg, 'path[' + i + ']');
    if (arg.length > 0) segs.push(arg);
  }
  if (segs.length === 0) return '.';

  const firstPart = segs[0];
  let joined = segs.join('\\');

  // Make sure that the joined path doesn't start with two slashes, because
  // normalize() will mistake it for a UNC path then. This step is skipped
  // when it is very clear that the user actually intended to point at a UNC
  // path (first non-empty arg starts with exactly two slashes followed by at
  // least one more non-slash character).
  let needsReplace = true;
  let slashCount = 0;
  if (_isPathSep(firstPart.charCodeAt(0))) {
    ++slashCount;
    const firstLen = firstPart.length;
    if (firstLen > 1 && _isPathSep(firstPart.charCodeAt(1))) {
      ++slashCount;
      if (firstLen > 2) {
        if (_isPathSep(firstPart.charCodeAt(2))) {
          ++slashCount;
        } else {
          // We matched a UNC path in the first part
          needsReplace = false;
        }
      }
    }
  }
  if (needsReplace) {
    // Find any more consecutive slashes we need to replace
    while (slashCount < joined.length && _isPathSep(joined.charCodeAt(slashCount))) {
      slashCount++;
    }
    // Replace the slashes if needed
    if (slashCount >= 2) {
      joined = `\\${joined.slice(slashCount)}`;
    }
  }

  // Skip normalization when reserved device names are present
  const parts = [];
  let part = '';
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '\\') {
      if (part) parts.push(part);
      part = '';
      // Skip consecutive backslashes
      while (i + 1 < joined.length && joined[i + 1] === '\\') i++;
    } else {
      part += joined[i];
    }
  }
  // Add the final part if any
  if (part) parts.push(part);

  // Check if any part has a Windows reserved name
  if (parts.some((p) => {
    const colonIndex = p.indexOf(':');
    return colonIndex !== -1 && _isWindowsReservedName(p, colonIndex);
  })) {
    // Replace forward slashes with backslashes
    let result = '';
    for (let i = 0; i < joined.length; i++) {
      result += joined[i] === '/' ? '\\' : joined[i];
    }
    return result;
  }

  return _winNormalize(joined);
}

contextBridge.exposeInMainWorld('api', {
  // ---- app metadata ----
  // Read from package.json at runtime so the version string stays
  // single-sourced (no stale hardcoded copy in the renderer).
  getAppVersion: () => ipcRenderer.invoke('app:version'),

  // ---- path utilities (PRE-1: sandboxed renderer has no require('path')) ----
  // Backed by the sandbox-safe path.win32 ports above (NOT Node's `path`,
  // which a sandboxed preload cannot require).
  pathDirname: (p) => _winDirname(p),
  pathBasename: (p) => _winBasename(p),
  pathExtname: (p) => _winExtname(p),
  pathJoin: (...args) => _winJoin(...args),

  // ---- config ----
  // SEC-001: `config:get` (raw, includes api_key) REMOVED. The renderer
  // uses only the secret-free DTO via `config:getPublic`.
  // P0-B (360° Audit C-001): secret-free config DTO. Returns hasApiKey,
  // apiKeyLast4, output_dir, region, theme, styles — NEVER the raw api_key.
  getConfigPublic: () => ipcRenderer.invoke('config:getPublic'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  getPremadeStyles: () => ipcRenderer.invoke('config:getPremadeStyles'),
  // pickFolder opens the native Browse-for-folder dialog and returns
  // the chosen path STRING on success, or null on cancel/error.
  // opts: { purpose?: 'config-output'|'config-report' } (optional).
  // For callers that also need the grantId (e.g. the Settings save
  // flow), use pickFolderFull() which returns the full envelope.
  pickFolder: async (opts) => {
    const r = await ipcRenderer.invoke('config:pickFolder', opts);
    return (r && r.ok && typeof r.path === 'string') ? r.path : null;
  },
  // pickFolderFull returns the FULL result envelope:
  //   { ok: true, path, grantId, capabilities } on success
  //   { ok: false, canceled: true } on cancel
  // Used by the Settings pane which needs the grantId to pass to
  // config:set when output_dir / report_dir changes.
  pickFolderFull: (opts) => ipcRenderer.invoke('config:pickFolder', opts),
  configPath: () => ipcRenderer.invoke('config:path'),
  defaultOutputDir: () => ipcRenderer.invoke('config:defaultOutputDir'),

  // ---- mmx ----
  // R7.5 (S1 §6 R1.5b): mmx:run / mmx:run:job are grant-gated — any path the
  // args carry (--out / --out-dir / --download / -o) or payload.cwd must be
  // covered by a Main-minted grantId, forwarded as the trailing arg. Without
  // it a path-bearing generation call fails closed in main. Callers that mint
  // the output grant via ensureSubDir (state._fbGrantId) thread it through.
  mmxRun: (args, grantId) => ipcRenderer.invoke('mmx:run', args, grantId),
  // Job-aware mmx run: the handler attaches every chunk to the jobId
  // so the renderer's LogService routes the line into the right log row.
  mmxRunJob: (payload, grantId) => ipcRenderer.invoke('mmx:run:job', payload, grantId),
  voices: () => ipcRenderer.invoke('mmx:voices'),
  quota: () => ipcRenderer.invoke('mmx:quota'),
  // Returns { ok, concurrentLimit, planType } with a 5-minute main-side
  // cache. Used by the Diagnose modal to show a "your plan allows N
  // concurrent calls" hint.
  mmxProfile: () => ipcRenderer.invoke('mmx:profile'),
  authStatus: () => ipcRenderer.invoke('mmx:authStatus'),
  diagnose: () => ipcRenderer.invoke('mmx:diagnose'),
  // Accepts an optional { jobId } payload for per-job cancel. With no
  // payload it kills every in-flight proc. `opts` is forwarded as-is;
  // the legacy `mmxCancel()` (no args) ends up with `args.length === 0`
  // at the test layer.
  mmxCancel: (opts) => opts ? ipcRenderer.invoke('mmx:cancel', opts) : ipcRenderer.invoke('mmx:cancel'),

  // ---- file browser ----
  fbList: (dir, grantId) => (grantId !== undefined ? ipcRenderer.invoke('fb:list', dir, grantId) : ipcRenderer.invoke('fb:list', dir)),
  // The renderer pushes its current `state.fbDir` here on every
  // navigation. The main process uses this as the explicit gate for
  // every write IPC ("you can only write in the folder you're looking
  // at"). Mirrors setActiveDir() in main/services/PathSecurityService.js.
  fbSetActiveDir: (dir) => ipcRenderer.invoke('fb:set-active-dir', dir),
  // Trust a path + its ancestors so the Up button can climb out of
  // output_dir without forcing the user through the file picker. Only
  // Enumerates available drives so the file browser's Up button can
  // navigate to a drive list when already at a drive root. Returns
  // { ok, drives: [{ name, label }] } (Windows: C:\, D:\, ...; POSIX: /).
  // No path-allowlist check needed (no user-supplied path).
  fbListDrives: () => ipcRenderer.invoke('fb:listDrives'),
  // R1.3: every mutating handler now requires a `grantId` minted by
  // Main (picker, app-output, config-output). The renderer must hold
  // the grant and pass it on each call. A missing/empty grantId is
  // rejected before any file-system operation. Read-side handlers
  // (fb:list, fb:reveal, fb:openInExplorer) stay ungated per S1 §3.
  fbMkdir: (dir, name, grantId) => ipcRenderer.invoke('fb:mkdir', dir, name, grantId),
  fbEnsureDir: (dir, grantId) => ipcRenderer.invoke('fb:ensureDir', dir, grantId),
  fbRename: (path, newName, grantId) => ipcRenderer.invoke('fb:rename', path, newName, grantId),
  fbDelete: (path, grantId) => ipcRenderer.invoke('fb:delete', path, grantId),
  // gewv2 GEW-002: optional 4th arg destGrantId lets the caller authorize
  // the destination with a SEPARATE grant when src and destDir don't share
  // a common-ancestor grant (e.g. two different trusted roots).
  fbMove: (src, destDir, grantId, destGrantId) => ipcRenderer.invoke('fb:move', src, destDir, grantId, destGrantId),
  fbCopy: (src, destDir, grantId, destGrantId) => ipcRenderer.invoke('fb:copy', src, destDir, grantId, destGrantId),
  fbReveal: (path) => ipcRenderer.invoke('fb:reveal', path),
  // Open a NEW Windows Explorer window at the file's parent folder.
  // fbReveal only highlights the file in an existing window; this opens
  // a fresh one. Both honour the same allow-list in the main process.
  fbOpenInExplorer: (path) => ipcRenderer.invoke('fb:openInExplorer', path),
  // R1.3: fb:read and fb:exists now require a read grant (S1 §3
  // "Existenz-Probes" and content reads). Same grantId channel as
  // the mutating handlers.
  fbRead: (path, grantId) => ipcRenderer.invoke('fb:read', path, grantId),
  fbExists: (path, grantId) => ipcRenderer.invoke('fb:exists', path, grantId),
  fbWrite: (outPath, base64Data, grantId) => ipcRenderer.invoke('fb:write', outPath, base64Data, grantId),
  // Uncapped atomic base64 write for the image editor. Mirrors fbWrite's
  // path validation + atomic rename but skips the 25 MB cap so a large
  // editor export (e.g. a 4x upscaled PNG) can be saved. R1.3:
  // also takes a grantId (same as fbWrite).
  writeImageBase64: (outPath, base64Data, grantId) => ipcRenderer.invoke('image:writeBase64', outPath, base64Data, grantId),
  // Editor Heal — Telea-style inpaint (small fixes). The renderer sends the
  // source path + a base64 PNG mask (or mode:'transparency' to auto-mask
  // alpha=0 holes); the main process synthesises + writes the result.
  inpaintRunTelea: (args) => ipcRenderer.invoke('inpaint:runTelea', args),
  // Editor Heal AI tier — LaMa / MI-GAN ONNX inpaint for larger fills. Same
  // arg shape as inpaintRunTelea (srcPath + maskB64) but runs a bundled AI
  // model out of the box.
  inpaintRunOnnx: (args) => ipcRenderer.invoke('inpaint:runOnnx', args),
  inpaintModelsAvailable: () => ipcRenderer.invoke('inpaint:modelsAvailable'),
  inpaintReplaceModel: (modelKey) => ipcRenderer.invoke('inpaint:replaceModel', modelKey),
  inpaintRestoreModel: (modelKey) => ipcRenderer.invoke('inpaint:restoreModel', modelKey),

  // ---- Path-grant minting (R1.5a.follow-up) ----
  // The renderer can request a Main-minted grant for a specific
  // (path, operation) pair BEFORE calling a mutation IPC. The
  // grantId is then passed to the mutation IPC. This closes the
  // R1.5a grantId-gap where the renderer-callsites did not pass
  // a grantId, causing every mutation IPC to fail with
  // 'grantId is required for read on <path>'.
  //
  // Usage pattern (renderer):
  //   // File-grant, single capability (default — R1.5a.follow-up Phases 1-4b):
  //   const { ok, grantId, error } = await window.api.mintGrant(srcPath, 'read');
  //   if (!ok) { showError(error); return; }
  //   const r = await window.api.optimizeImage(srcPath, opts, grantId);
  //
  //   // Directory-grant, multi-capability (R1.5a.follow-up Phase 6 — for
  //   // optimize/resize/inpaint/removeBg where the output is a SIBLING
  //   // of the source and a single grant must cover both paths):
  //   const parentDir = path.dirname(srcPath);
  //   const { ok, grantId } = await window.api.mintGrant(parentDir, 'read', {
  //     kind: 'directory',
  //     capabilities: ['read', 'write'],
  //   });
  //
  // The grant is multi-use until explicitly revoked. The renderer
  // is expected to cache grantIds per (path, operation) so that
  // repeated calls on the same path share a single grant.
  mintGrant: (path, operation, opts) => ipcRenderer.invoke('pathGrant:mint', path, operation, opts),
  revokeGrant: (grantId) => ipcRenderer.invoke('pathGrant:revoke', grantId),

  // ---- R6.6.1: Unified job cancellation ----
  // Routes through src/jobRegistry.js — the shared registry for ALL
  // backend child processes (mmx, Real-ESRGAN, IS-Net, Inpaint, Sharp).
  // The existing mmxCancel remains for mmx jobs; jobCancel is the
  // unified cancel for ALL backends (once R6.6.2-R6.6.5 wire them up).
  jobCancel: (opts) => ipcRenderer.invoke('job:cancel', opts),
  jobCancelAll: () => ipcRenderer.invoke('job:cancel-all'),
  jobList: () => ipcRenderer.invoke('job:list'),

  // ---- External tools (GIMP, Photoshop, ...) ----
  // The renderer only sends the tool NAME (looked up from the
  // persisted config) and the file PATHS (already validated
  // through the file-browser allow-list). The main process then
  // spawns the .exe with the paths appended — same shape as a
  // Windows-Explorer "Open with" verb. See
  // main/ipc/registerExternalToolsIpc.js for the security model.
  externalToolsRun: (payload, grantId) => ipcRenderer.invoke('externalTools:run', payload, grantId),
  externalToolsProbe: (payload) => ipcRenderer.invoke('externalTools:probe', payload),

  // ---- Real-ESRGAN (optional upscaler, BSD-3-Clause) ----
  // Returns { available, binaryPath, version }. When unavailable, the
  // renderer falls back to the built-in multi-step createImageBitmap
  // pipeline.
  realesrganAvailable: () => ipcRenderer.invoke('upscale:realesrgan:available'),
  // Spawn the binary. srcPath/dstPath must live under the allowed
  // roots (validated in main.js). opts: { model, scale, gpu? }.
  // R1.5a.follow-up Phase 5: grantId is now forwarded.
  realesrganRun: (srcPath, dstPath, opts, grantId) => ipcRenderer.invoke('upscale:realesrgan:run', srcPath, dstPath, opts, grantId),
  // One-click install of the Real-ESRGAN binary into ./bin/. The main
  // process streams download + extract progress back to the renderer
  // through the 'upscale:realesrgan:download:progress' channel. Returns
  // { ok, binDir } on success or { ok: false, error } on failure. The
  // "Pick file..." button (installPickAndCopy) is the universal fallback
  // if the upstream asset is ever removed.
  realesrganDownload: () => ipcRenderer.invoke('upscale:realesrgan:download'),
  onRealesrganDownloadProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('upscale:realesrgan:download:progress', listener);
    return () => ipcRenderer.removeListener('upscale:realesrgan:download:progress', listener);
  },
  // H11-1B: per-run upscale progress (Real-ESRGAN stdout %), keyed by the
  // pipeline-item id (progressKey). The renderer maps key → card bar.
  onRealesrganProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('upscale:realesrgan:progress', listener);
    return () => ipcRenderer.removeListener('upscale:realesrgan:progress', listener);
  },

  // ---- Optional add-ons install (unified popup) ----
  // Open a URL in the user's default browser. Used by the popup to send
  // the user to the Real-ESRGAN releases page, the IS-Net model mirror,
  // or the project README without auto-downloading a specific URL that
  // may break later.
  installOpenUrl: (url) => ipcRenderer.invoke('install:openUrl', url),
  // Universal fallback: open a file picker and copy the picked file into
  // ./bin/ (or ./bin/models/) at the name the wrapper probes for. `kind`
  // is one of: 'realesrgan-binary' | 'isnetbg-binary' | 'isnetbg-model'.
  // Returns { ok, destPath, kind } on success, { ok: false, canceled: true }
  // if the user cancelled, or { ok: false, error } on copy failure. Resets
  // the binary detector cache so the next probe sees the new file.
  installPickAndCopy: (kind) => ipcRenderer.invoke('install:pickAndCopy', kind),
  assetsReset: () => ipcRenderer.invoke('assets:reset'),

  // ---- IS-Net background removal (optional, user-supplied binary) ----
  // Returns { available, binaryPath, modelPath, modelPresent, version }.
  // When unavailable (no binary, no model), the renderer's "Remove
  // background" actions show a clear install hint instead of failing silently.
  isnetbgAvailable: () => ipcRenderer.invoke('isnetbg:available'),
  // Spawn the binary. srcPath/dstPath are validated against the
  // allowedRoots() allowlist in main.js. opts: { useGpu?: boolean }.
  // On success the binary writes a transparent PNG to dstPath.
  // R1.5a.follow-up Phase 5: grantId is now forwarded.
  isnetbgRun: (srcPath, dstPath, opts, grantId) => ipcRenderer.invoke('isnetbg:run', srcPath, dstPath, opts, grantId),
  isnetbgDownloadModel: (model) => ipcRenderer.invoke('isnetbg:download-model', model),
  onIsnetbgDownloadProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('isnetbg:download-progress', listener);
    return () => ipcRenderer.removeListener('isnetbg:download-progress', listener);
  },

  // ---- Image optimization / compression (Sharp + libvips) ----
  // Re-encodes the source image to shrink its file size while
  // preserving best-possible visual quality. opts:
  //   {
  //     quality:       1..100,                  // default 82
  //     format:        'jpeg'|'png'|'webp'|'avif'|null, // null = keep source
  //     stripMetadata: boolean,                 // default true (keeps ICC)
  //     outputPath:    string|null,             // null = sibling with _optimized
  //   }
  // Returns a structured result envelope:
  //   { ok, outputPath, inputSize, outputSize, savedBytes,
  //     savedPercent, format, width, height, error? }
  // Failures (corrupt file, sharp not installed, etc.) are
  // returned as { ok: false, error: '...' } — never thrown.
  // R1.5a.follow-up Phase 5: grantId is now forwarded. The
  // R1.5a preload dropped the third arg (silently), so the
  // handler's grant-check always received `undefined` and
  // returned `{ok: false, error: 'grantId is required for read
  // on <path>'}` for every production call. The renderer
  // (section07, batchPostprocess, pipelineOps) was already
  // passing grantId via ensurePathGrant, but the preload
  // dropped it. Now the preload forwards it.
  optimizeImage: (srcPath, opts, grantId) => ipcRenderer.invoke('image:optimize', srcPath, opts, grantId),
  // Resize to a free target resolution (Lanczos3, best quality).
  // opts: { width, height, format?, quality?, stripMetadata?, sharpenOnDownscale?, outputPath? }
  // Returns the same envelope shape as optimizeImage plus srcWidth/srcHeight/downscaled.
  resizeImage: (srcPath, opts, grantId) => ipcRenderer.invoke('image:resize', srcPath, opts, grantId),
  imageMetadata: (srcPath, grantId) => ipcRenderer.invoke('image:metadata', srcPath, grantId),
  // Sniffs the real format from content and renames the file to match
  // when mmx's downloaded CDN bytes (e.g. JPEG) disagree with the
  // hardcoded --out extension (always .png).
  //   fixImageExtension(path, grantId?) -> { ok, path, renamed, error? }
  fixImageExtension: (filePath, grantId) => ipcRenderer.invoke('image:fixExtension', filePath, grantId),
  // Pre-flight existence check for a --subject-ref reference image so a
  // stale/missing path is caught with a clear message instead of a
  // cryptic, 4x-retried mmx ENOENT. URLs (http/https) report
  // exists:true (validated server-side, not on disk).
  //   refImageExists(path) -> { ok, exists, url? }
  refImageExists: (filePath) => ipcRenderer.invoke('image:refExists', filePath),

  // ---- Audio cut / probe (folder-browser right-click) ----
  // Wraps the bundled ffmpeg-static binary. Used by the "Audio cut..."
  // overlay opened from the right-click menu on any audio file the file
  // browser recognises. The wrapper enforces the same path-allowlist
  // as fb:* / image:*.
  //   audioAvailable()     → { available, path }
  //   audioProbe(src)      → { ok, duration, codec, sampleRate,
  //                            channels, channelLayout, bitRate,
  //                            format, size }
  //   audioDecodePeaks(src, opts) → downsampled peak buckets +
  //                            optional raw mono PCM for snap-to-zero.
  //                            opts: { duration, targetRate=8000,
  //                                    maxBuckets=4000,
  //                                    startSec, endSec, withPcm }
  //   audioFindZeroCrossing(pcm, targetSample, window) → { ok, index }
  //   audioTrimSilence(src, opts) → { ok, startSec, endSec,
  //                            leadSilenceSec, tailSilenceSec, … }
  //   audioCut(src, dst, opts) → streams the trimmed range to dst,
  //                            applying the requested micro-fade.
  //                            opts: { startSec, endSec, fadeMs=5,
  //                                    fade=true, copy=false }
  //   audioAutocutDetect(src, opts) → { ok, duration, plan, stats }.
  //                            Runs ffmpeg silencedetect → invert →
  //                            planAutoCut. opts are the raw auto-cut
  //                            rules (sanitised server-side).
  audioAvailable: () => ipcRenderer.invoke('audio:available'),
  // R7.5: the path-taking audio IPCs are grant-gated (R1.5a.2) — the
  // handler requires a trailing grantId. The renderer mints a directory
  // grant (read+write on the source's parent) and forwards it. The
  // grantId was previously dropped here, so every audio:probe/cut call
  // failed with "grantId is required for read on <path>".
  audioProbe: (srcPath, grantId) => ipcRenderer.invoke('audio:probe', srcPath, grantId),
  audioDecodePeaks: (srcPath, opts, grantId) => ipcRenderer.invoke('audio:decodePeaks', srcPath, opts, grantId),
  audioFindZeroCrossing: (pcm, targetSample, window) => ipcRenderer.invoke('audio:findZeroCrossing', pcm, targetSample, window),
  audioTrimSilence: (srcPath, opts, grantId) => ipcRenderer.invoke('audio:trimSilence', srcPath, opts, grantId),
  audioCut: (srcPath, dstPath, opts, grantId) => ipcRenderer.invoke('audio:cut', srcPath, dstPath, opts, grantId),
  audioAutocutDetect: (srcPath, opts, grantId) => ipcRenderer.invoke('audio:autocutDetect', srcPath, opts, grantId),

  // ---- batches (BatchGen storage) ----
  batchesGet: () => ipcRenderer.invoke('batches:get'),
  batchesSet: (batches) => ipcRenderer.invoke('batches:set', batches),

  // ---- file picker ----
  pickFile: (opts) => ipcRenderer.invoke('file:pick', opts),
  fileSaveAs: (srcPath) => ipcRenderer.invoke('file:saveAs', srcPath),
  // Legacy alias for `window.api.fbOpenDialog`, kept so leftover callers
  // (e.g. 3rd-party extensions) keep working. New code should use pickFile.
  fbOpenDialog: (opts) => ipcRenderer.invoke('file:pick', opts),

  // ---- state autosave (tab settings) ----
  stateGet: () => ipcRenderer.invoke('state:get'),
  stateSet: (s) => ipcRenderer.invoke('state:set', s),
  // Archive IPCs (history).
  stateArchiveRead: (opts) => ipcRenderer.invoke('state:archiveRead', opts),
  stateArchiveClear: () => ipcRenderer.invoke('state:archiveClear'),
  stateArchiveSize: () => ipcRenderer.invoke('state:archiveSize'),
  stateArchiveDelete: (id) => ipcRenderer.invoke('state:archiveDelete', { id }),
  // Graceful shutdown signal from main to renderer. The main process
  // emits this on `before-quit`; the renderer has `graceMs` (default
  // 500) to flush in-flight state. The quit proceeds regardless of ack.
  onBeforeQuit: (cb) => {
    const fn = (_e, payload) => { try { cb(payload); } catch (_) {} };
    ipcRenderer.on('app:before-quit', fn);
    return () => ipcRenderer.removeListener('app:before-quit', fn);
  },
  batchesGenerateExamples: (format) => ipcRenderer.invoke('batches:generateExamples', format),
  // Open a native Save-As dialog for the import-doc manual so the user
  // picks the file name + location. fmt = 'md' | 'txt' (default 'md').
  saveManualAs: (fmt) => ipcRenderer.invoke('batches:saveManualAs', fmt),

  // ---- events ----
  onLog: (cb) => {
    // Backwards-compat: the legacy `onLog(cb)` callback receives a plain
    // string. The main-side handler sends { line, jobId, kind }; we unwrap
    // the `line` here so the renderer's legacy `log(line)` wrapper keeps
    // working. New code should prefer `onLogRich(cb)` which receives the
    // full payload.
    const fn = (_e, payload) => {
      if (payload == null) return;
      if (typeof payload === 'string') {
        cb(payload);
        return;
      }
      cb(payload.line != null ? payload.line : '');
    };
    ipcRenderer.on('mmx:log', fn);
    return () => ipcRenderer.removeListener('mmx:log', fn);
  },
  // onLogRich(cb) receives the full payload { line, jobId, kind } so the
  // renderer can route the chunk to the right job row.
  onLogRich: (cb) => {
    const fn = (_e, payload) => {
      if (payload == null) return;
      if (typeof payload === 'string') {
        // Legacy main build that still sends strings — wrap so the
        // renderer's payload-only code path doesn't need its own shim.
        // The jobId is null (free-form line).
        cb({ line: payload, jobId: null, kind: 'stderr' });
        return;
      }
      cb(payload);
    };
    ipcRenderer.on('mmx:log', fn);
    return () => ipcRenderer.removeListener('mmx:log', fn);
  },

  // ---- renderer-side error log ----
  // Writes a line to renderer-error.log in the project root. Used by
  // debugLog.js to collect every error without opening DevTools.
  logToFile: (line) => ipcRenderer.send('renderer:log', line),

  // ---- close handshake (R2.5) ----
  // The main process sends `app:prepare-close` to give the renderer a
  // bounded grace period to flush its in-flight state (state.json
  // autosave, log rotation, job status). The renderer responds with
  // `app:prepare-close:ack` via `ackPrepareClose()`. The main waits
  // up to CLOSE_HANDSHAKE_TIMEOUT_MS (2s) before forcing the close,
  // so a non-responding renderer can never trap the user in a hang.
  onPrepareClose: (cb) => {
    const fn = () => {
      try { cb(); } catch (_) { /* renderer-side handler must not throw */ }
    };
    ipcRenderer.on('app:prepare-close', fn);
    return () => ipcRenderer.removeListener('app:prepare-close', fn);
  },
  ackPrepareClose: () => ipcRenderer.send('app:prepare-close:ack'),

  // ---- Pipeline ----
  // The column-based image workflow. import/replace/trash do on-disk work in
  // the main process (cross-volume copies, atomic moves); thumb generates a
  // cached webp thumbnail via Sharp. pathForDragFile bridges the OS File
  // objects dropped from Windows Explorer into real OS paths (webUtils is only
  // available in the preload under contextIsolation — the renderer can't
  // require('electron') itself).
  // QA-001 fix: pass the full payload (including workspaceId) so the main
  // handler can resolve the correct workspace instead of always falling back.
  pipelineImport: (payload) => ipcRenderer.invoke('pipeline:import', Array.isArray(payload) ? { items: payload } : payload),
  pipelineMintWorkspace: (payload) => ipcRenderer.invoke('pipeline:mintWorkspace', payload),
  pipelineReplace: (payload) => ipcRenderer.invoke('pipeline:replace', payload),
  pipelineTrash: (payload) => ipcRenderer.invoke('pipeline:trash', payload),
  pipelineThumb: (payload) => ipcRenderer.invoke('pipeline:thumb', payload),
  pathForDragFile: (file) => {
    try {
      const { webUtils } = require('electron');
      return webUtils.getPathForFile(file);
    } catch (_) {
      return '';
    }
  },

  // ---- Reset / Danger zone (F7) ----
  // P1-G (360° Audit H-016): destructive operations require a confirmation
  // token minted via native dialog. Call confirmRequest() first, then pass
  // the returned token to the destructive call.
  confirmRequest: (opts) => ipcRenderer.invoke('confirm:request', opts),
  // Deletes ONLY the tool's own settings/state files (+ mmx CLI key).
  // NEVER the user's generated assets. Returns per-file results for
  // honest partial-failure reporting.
    resetAllData: (payload) => ipcRenderer.invoke('app:resetAllData', payload),
    relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
    resetAndRelaunch: (payload) => ipcRenderer.invoke('app:resetAndRelaunch', payload),

  // ---- M3 in-tool document generation (F3) ----
  // Sends a chat-completion request to MiniMax M3 via the main process.
  // The API key is read from config in main — the renderer never sees it.
  // Payload: { messages, jsonMode?, temperature?, maxTokens?, model? }
  m3Chat: (payload) => ipcRenderer.invoke('m3:chat', payload),

  // ---- Other APIs tab (non-MiniMax providers) ----
  // SEC-002: `providers:get` (raw, includes apiKey) REMOVED. The renderer
  // uses only the secret-free DTO via `providers:getPublic`.
  // P0-B (360° Audit C-002): secret-free provider DTO. Returns providers
  // with hasKey boolean + apiKeyLast4 instead of raw apiKey values.
  providersGetPublic: () => ipcRenderer.invoke('providers:getPublic'),
  providersSet: (d) => ipcRenderer.invoke('providers:set', d),
  // Model discovery (GET /models for OpenAI-compatible providers).
  providersListModels: (payload) => ipcRenderer.invoke('providers:listModels', payload),
  // Generate: {jobId, modality, providerId, model, prompt, input, params, outDir, grantId}
  providersGenerate: (req) => ipcRenderer.invoke('providers:generate', req),
  // Cancel an in-flight generation job.
  providersCancel: (jobId) => ipcRenderer.invoke('providers:cancel', { jobId }),
  // Progress events for async jobs (video/music poll loops).
  onProvidersProgress: (cb) => {
    const fn = (_e, d) => cb(d);
    ipcRenderer.on('providers:progress', fn);
    return () => ipcRenderer.removeListener('providers:progress', fn);
  },
});
