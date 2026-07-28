// renderer/bootstrap.js — post-load wiring for the renderer.

(function bootstrapRenderer() {
  // Stamp the version string into the topbar.
  if (window.api && typeof window.api.getAppVersion === 'function') {
    window.api.getAppVersion().then((info) => {
      const v = (info && info.version) || 'unknown';
      const el = document.getElementById('brand-version');
      if (el) el.textContent = 'v' + v;
    }).catch(() => {});
  }
  // Wire up the hover-help tooltips and the topic-keyed help click
  // delegation. Both are event-delegation-based, so calling setup once
  // covers the whole renderer lifetime.
  try {
    if (window.HelpTooltip && typeof window.HelpTooltip.setupHoverHelpTooltips === 'function') {
      window.HelpTooltip.setupHoverHelpTooltips();
    }
  } catch (e) { console.warn('setupHoverHelpTooltips failed:', e); }
  try {
    if (window.HelpDelegation && typeof window.HelpDelegation.setupHelpDelegation === 'function') {
      window.HelpDelegation.setupHelpDelegation();
    }
  } catch (e) { console.warn('setupHelpDelegation failed:', e); }
  // Boot the active-jobs widget. It's a pure projection of state.jobs,
  // so it just subscribes to JobRunner events and renders.
  try {
    if (window.ActiveJobsWidget && typeof window.ActiveJobsWidget.init === 'function') {
      window.ActiveJobsWidget.init();
    }
  } catch (e) { console.warn('ActiveJobsWidget.init failed:', e); }
  // LogService init: registers the click/keyboard listener on #log that
  // toggles row expansion, and makes the log text selectable.
  // (The toolbar wiring in setupLogToolbar() is called from app.js init.)
  try {
    if (window.LogService && typeof window.LogService.init === 'function') {
      window.LogService.init();
    }
  } catch (e) { console.warn('LogService.init failed:', e); }
  // Note: the persisted-L2 render call lives in app.js init(), right
  // after the disk state (including state.jobsSnapshot) is loaded —
  // not here, since this IIFE runs before app.js init() populates state.
})();
