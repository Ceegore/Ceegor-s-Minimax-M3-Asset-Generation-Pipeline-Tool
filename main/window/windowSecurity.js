// main/window/windowSecurity.js
// Setzt Electron-Switches für DPI + Native-Win-Occlusion.
// Wird beim App-Start VOR `app.whenReady` per Side-Effect ausgeführt.
//
// Grund für diese Exporte: ohne `disable-features=CalculateNativeWinOcclusion`
// wendet der Windows-Compositor auf teilweise verdeckte Fenster Unschärfe an
// (sichtbar als matschiger Text beim Verschieben). Der Scale-Switch stellt
// sicher, dass die Renderer-UI nie durch fraktionale DPI-Werte unscharf wird.
//
// Beide Switches sind absichtlich **global** — sie wirken app-weit und
// werden vom Renderer nicht überschrieben.

const { app, session } = require('electron');

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// Do not override the user's Windows DPI, text-size, or magnifier setting.
app.enableSandbox();

// KGO7-014: `frame-ancestors` is header-only — Chromium ignores it in a
// <meta> CSP and logs a console ERROR on every boot. The renderer's meta
// CSP therefore omits it and it is appended here as a real response
// header, so the protection is actually enforced AND the console stays
// clean. Everything else stays in the meta tag (it must apply to
// file:// documents, where response headers are not always available).
app.whenReady().then(() => {
  try {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = Object.assign({}, details.responseHeaders);
      // Append rather than replace: the meta CSP still carries the rest of
      // the policy, and multiple CSPs are intersected by the browser.
      headers['Content-Security-Policy'] = ["frame-ancestors 'none'"];
      callback({ responseHeaders: headers });
    });
  } catch (_) { /* best-effort: a header hook failure must never block boot */ }
});
