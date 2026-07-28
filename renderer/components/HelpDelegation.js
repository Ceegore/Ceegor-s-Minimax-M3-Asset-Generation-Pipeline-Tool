// renderer/components/HelpDelegation.js
// Click delegation for the `?` help icons. Per spec these icons are
// hover-only: help text appears on mouseover via the HelpTooltip system
// (renderer/components/HelpTooltip.js), and a click is a no-op that just
// prevents submit/bubbling. No modal opens on click.

function setupHelpDelegation() {
  document.addEventListener('click', (e) => {
    // Only react to clicks on a real help icon — otherwise this delegation
    // would intercept every click on the page.
    const t = e.target && e.target.closest && e.target.closest('.help-button, .help-btn');
    if (!t) return;
    // Don't hijack clicks on form controls (a `?` icon next to a form
    // control shouldn't break the control's click).
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
}

window.HelpDelegation = { setupHelpDelegation };
