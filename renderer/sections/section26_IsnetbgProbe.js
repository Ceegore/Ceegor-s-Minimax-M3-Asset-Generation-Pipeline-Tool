// renderer/sections/section26_IsnetbgProbe.js
// Extracted from section08. Caches the isnetbg availability probe so the
// right-click context menu + the "✨ Remove background" sub-section of the
// upscale dialogs can both call probeIsnetbgStatus() without re-asking the
// main process 5×/sec when the user is hammering the menu.

// Cache the isnetbg availability probe. The IPC is cheap (just a
// `which` + an fs.stat on the binary + model) but the right-click
// context menu re-asks the main process every time it's opened, and
// probing 5 times / second when the user is hammering the menu adds
// up. One probe per session, refreshed only on user request
// (e.g. after a future "install isnetbg" flow that calls
// `resetCache()` on the main side).
let _isnetbgStatusCache = null;
async function probeIsnetbgStatus(forceRefresh = false) {
  if (!forceRefresh && _isnetbgStatusCache) return _isnetbgStatusCache;
  let st = { available: false, binaryPath: null, modelPath: null, modelPresent: false, version: '', checked: true };
  try { st = await window.api.isnetbgAvailable(); st.checked = true; }
  catch (_) { st.checked = false; }
  _isnetbgStatusCache = st;
  return st;
}

// Expose on window so section08's removeBackgroundFile and any
// other caller can reach the helper without a re-declaration. The
// function name is unchanged so existing call sites keep working.
window.probeIsnetbgStatus = probeIsnetbgStatus;
