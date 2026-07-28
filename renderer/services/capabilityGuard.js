// renderer/services/capabilityGuard.js
// ============================================================================
// R7.2b — Renderer-side CapabilityGuard.
//
// Fetches the mmx CLI capability snapshot from the main process (via
// window.api.diagnose()) at boot and caches it. Tabs and overlays use
// this to disable unsupported controls BEFORE the user clicks them.
//
// R7-Gate: "unsupported Controls nicht klickbar" — this service is the
// single source of truth for "is this generation mode / flag available?"
// in the renderer.
//
// Usage (renderer):
//   await window.CapabilityGuard.init();          // called once at boot
//   if (!window.CapabilityGuard.isSubcommandAvailable('video')) { ... }
//   if (!window.CapabilityGuard.isFlagSupported('image', '--model')) { ... }
//   const models = window.CapabilityGuard.getModels('image');
//
// The guard is BEST-EFFORT: if the diagnose call fails (e.g. main
// process not ready), all queries return permissive defaults (true /
// empty array) so the UI is never accidentally locked out.
//
// Loaded via <script> tag. Exposes window.CapabilityGuard.
// ============================================================================

(function () {
'use strict';

// Cached capability object from mmx:diagnose. null = not yet fetched.
let _capability = null;
let _available = false;
let _initDone = false;

/**
 * Fetch the capability snapshot from the main process.
 * Called once at boot (from app.js). Safe to call multiple times.
 * @returns {Promise<void>}
 */
async function init() {
  if (_initDone) return;
  _initDone = true;
  try {
    if (window.api && typeof window.api.diagnose === 'function') {
      const d = await window.api.diagnose();
      if (d && d.capabilityAvailable && d.capability) {
        _capability = d.capability;
        _available = true;
      }
    }
  } catch (_) {
    // Best-effort: a failed probe must never lock the UI.
    _capability = null;
    _available = false;
  }
}

/**
 * Re-fetch the capability snapshot (e.g. after a CLI update in Settings).
 * @returns {Promise<void>}
 */
async function refresh() {
  _initDone = false;
  _capability = null;
  _available = false;
  await init();
}

/**
 * Feed an already-fetched diagnose result into the guard.
 * Avoids a second IPC round-trip when the boot code already
 * called window.api.diagnose() for the version warning.
 * @param {object} d - The mmx:diagnose response.
 */
function setFromDiagnose(d) {
  if (d && d.capabilityAvailable && d.capability) {
    _capability = d.capability;
    _available = true;
  }
  _initDone = true;
}

/**
 * Check if a subcommand (image, speech, music, video, sound-effect)
 * is available in the installed CLI.
 * Returns true (permissive) if the capability data is not yet loaded.
 * @param {string} sub
 * @returns {boolean}
 */
function isSubcommandAvailable(sub) {
  if (!_available || !_capability || !_capability.subcommands) return true;
  const entry = _capability.subcommands[sub];
  return entry ? !!entry.available : true;
}

/**
 * Check if a specific flag is supported by a subcommand.
 * Returns true (permissive) if the capability data is not yet loaded.
 * @param {string} sub
 * @param {string} flag - e.g. '--model', '--dry-run'
 * @returns {boolean}
 */
function isFlagSupported(sub, flag) {
  if (!_available || !_capability || !_capability.subcommands) return true;
  const entry = _capability.subcommands[sub];
  // gewv2 NF-01 fix: an EMPTY flags array means the probe returned no data
  // (unknown), not "no flags exist" — treat it as permissive so a probe gap
  // never wrongly disables a genuinely-supported control.
  if (!entry || !entry.available || !entry.flags || entry.flags.length === 0) return true;
  return entry.flags.includes(flag.toLowerCase());
}

/**
 * Get the list of available models for a subcommand.
 * Returns an empty array if the capability data is not yet loaded.
 * @param {string} sub
 * @returns {string[]}
 */
function getModels(sub) {
  if (!_available || !_capability || !_capability.subcommands) return [];
  const entry = _capability.subcommands[sub];
  return (entry && entry.models) ? entry.models : [];
}

/**
 * Get the full cached capability object (or null if not loaded).
 * @returns {object|null}
 */
function getSnapshot() {
  return _capability;
}

/**
 * Whether the capability data was successfully loaded.
 * @returns {boolean}
 */
function isLoaded() {
  return _available;
}

window.CapabilityGuard = {
  init,
  refresh,
  setFromDiagnose,
  isSubcommandAvailable,
  isFlagSupported,
  getModels,
  getSnapshot,
  isLoaded,
};

})();
