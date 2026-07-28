// renderer/sections/section16_Real_ESRGAN_first_run_popup.js
// Extracted: Real-ESRGAN first-run popup

// ----------------- Real-ESRGAN first-run popup -----------------
// Surfaces the one-click Real-ESRGAN installer on the very first
// launch (after the first-time setup popup) so the user doesn't
// have to dig through ⚙ Settings to discover it. If the binary is
// already present (e.g. the user copied it in themselves), the
// popup auto-closes without bothering them. The "Don't ask again"
// button persists a flag in state.json so this never re-appears
// after dismissal.
