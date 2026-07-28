// main/services/PathSecurityService.js
// Authoritative path-security service. Every IPC handler with path arguments
// MUST route its inputs through `isPathUnderAny` / `isParentUnderAny` — never
// touch `fs`/`dialog` directly.
//
// Security model: the folder the user is looking at in the file browser
// (`state.fbDir`) is the only place any write / delete / move / copy /
// create-dir action is allowed. The renderer pushes its current `state.fbDir`
// to the main process on every navigation (Up click, drive pick, folder pick,
// tab switch) via `setActiveDir(dir)`. The main process gates every write IPC
// on the active dir. If the user wants to write somewhere else, they navigate
// there first.
//
// READS (fb:list, fb:read, fb:exists) are NOT gated by the main process. They
// go straight to the OS — if the OS allows the read, it succeeds; if not, the
// real ENOENT / EACCES / EPERM error is returned to the renderer and surfaced
// in the log. Access is governed by OS permissions, and genuine access errors
// are surfaced rather than hidden.
//
// The legacy "trusted picks" Set is kept (and `addTrusted` is still callable)
// so the existing per-folder write gate — for the case where a user generates
// while sitting on a folder picked via the Open Folder dialog — still works
// without requiring a setActiveDir round-trip from the renderer. setActiveDir
// widens further: it makes the current folder the explicit gate for every
// write.

const cfgMod = require('../../src/config');
const pathUtils = require('../../src/pathUtils');
const nodePath = require('path');

/** @type {Set<string>} Session-scoped paths explicitly chosen by the user. */
const trustedPickPaths = new Set();

/** @type {string|null} The folder the renderer is currently showing in the file browser. */
let activeDir = null;

/**
 * True if `p` (normalised) is under one of the roots.
 * @param {string} p
 * @param {string[]} [roots]
 * @returns {boolean}
 */
function isPathUnderAny(p, roots) {
  return pathUtils.isPathUnderAny(p, roots || getAllowedRoots());
}

/**
 * True if the **Parent** of `p` is under one of the roots.
 * @param {string} p
 * @param {string[]} [roots]
 * @returns {boolean}
 */
function isParentUnderAny(p, roots) {
  return pathUtils.isParentUnderAny(p, roots || getAllowedRoots());
}

/**
 * Current list of allowed roots.
 * @returns {string[]} effectiveOutputDir + trustedPickPaths + activeDir
 */
function getAllowedRoots() {
  const cfg = cfgMod.read();
  // Use the *effective* output dir so a blank `output_dir` (user skipped
  // first-run setup) still yields a valid root = `<configDir>/generated`.
  const roots = [cfgMod.effectiveOutputDir(cfg)];
  // A dedicated report_dir (when set) is always writable so the Pipeline
  // clear/export-with-report flow can drop a .md there without the user first
  // navigating the file browser to that folder.
  if (cfg.report_dir && typeof cfg.report_dir === 'string' && cfg.report_dir.trim()) {
    roots.push(cfg.report_dir.trim());
  }
  for (const p of trustedPickPaths) roots.push(p);
  if (activeDir) roots.push(activeDir);
  return roots;
}

/**
 * Adds a path permanently (for the session) to the allowed roots. Called by
 * the file picker once the user has explicitly chosen a file or folder via
 * the system dialog.
 * @param {string} p
 * @returns {string[]} the new path(s) added to the trusted set
 */
function addTrusted(p) {
  if (!p) return [];
  const norm = (() => { try { return nodePath.resolve(String(p)); } catch (_) { return ''; } })();
  if (!norm) return [];
  if (trustedPickPaths.has(norm)) return [];
  trustedPickPaths.add(norm);
  return [norm];
}

/**
 * The renderer pushes its current file-browser location (`state.fbDir`) on
 * every navigation (Up click, drive select, folder pick, tab switch). The
 * main process uses this as the single explicit gate for every write / mutate
 * IPC: any path the user wants to write into must be inside the active dir (or
 * be the active dir itself). This matches the user's mental model: the
 * generated image may only be written in the folder shown in the folder
 * explorer.
 *
 * Passing `null` / empty clears the gate (the next navigation will set a new
 * one).
 *
 * @param {string|null} dir
 */
function setActiveDir(dir) {
  if (!dir) { activeDir = null; return; }
  const norm = (() => { try { return nodePath.resolve(String(dir)); } catch (_) { return ''; } })();
  activeDir = norm || null;
}

/** @returns {string|null} the currently-active directory, or null if none. */
function getActiveDir() {
  return activeDir;
}

/**
 * Re-reads `config.output_dir`. Call after `config:set` so the root list
 * stays consistent.
 */
function refreshOutputRoot() {
  // The Set is read-only-by-design; `getAllowedRoots()` reads fresh from
  // `cfgMod` on every call, so there is nothing to do here. This function
  // exists only as an explicit refresh hook for future caching optimisations.
}

module.exports = {
  getAllowedRoots,
  isPathUnderAny,
  isParentUnderAny,
  addTrusted,
  setActiveDir,
  getActiveDir,
  refreshOutputRoot,
};
