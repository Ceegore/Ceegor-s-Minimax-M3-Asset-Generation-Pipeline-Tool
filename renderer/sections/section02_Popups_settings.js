// renderer/sections/section02_Popups_settings.js
// Popups settings

// ----------------- Popups settings -----------------
// Sub-modal inside ⚙ Settings that lets the user change the popup
// display policy (which controls the startup / first-time-setup /
// optional-addons / tab-intro popups) and reset the "seen" history
// so every popup fires again on the next trigger. Persisted to
// state.json via scheduleStateSave — the policy itself is part of
// state.popupPolicy, and the seen record is state.seenPopups.
function showPopupSettings() {
  // The Popups UI lives as a tab inside the multi-tab Settings dialog
  // (buildSettingsPopupsPane). This stub opens Settings and switches
  // to that tab.
  showSettingsAndSwitchTab('popups');
}

