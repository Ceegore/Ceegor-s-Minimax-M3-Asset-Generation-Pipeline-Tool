// renderer/components/HelpTooltip.js
// Hover-driven tooltip for inline `data-help` icons.
// Extracted from app.js.
//
// Replaces the previous CSS pseudo-element approach
// ([data-help]:hover::after) which positioned the tooltip
// `absolute` next to the icon and was clipped by the content
// area's `overflow: auto`. Long tooltips (e.g. for --width,
// --model) routinely extended past the right edge of #content
// and were rendered invisible behind the folder-explorer area.
// The tooltip is `position: fixed` so no parent container
// can clip it.
//
// A single tooltip element is created and reused. Event
// delegation on `document` so dynamically added icons (e.g. the
// per-tab build() calls) pick up the behaviour for free.

/**
 * @returns {{ showFor: (el: HTMLElement) => void, hide: () => void }}
 */
function setupHoverHelpTooltips() {
  const tip = document.createElement('div');
  tip.className = 'help-hover-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.style.display = 'none';
  document.body.appendChild(tip);
  let activeEl = null;

  function showFor(el) {
    const text = el.getAttribute('data-help') || el.getAttribute('title') || '';
    if (!text) { hide(); return; }
    tip.textContent = text;
    tip.style.display = '';
    activeEl = el;
    position(tip, el);
  }
  function hide() {
    tip.style.display = 'none';
    activeEl = null;
  }
  function position(tipEl, anchor) {
    // Position below the icon by default. If the tooltip would
    // overflow the bottom of the viewport, flip it above the
    // icon instead. If it would overflow the right edge, clamp
    // the left position so the right edge stays inside the
    // viewport. We use getBoundingClientRect (relative to the
    // viewport) because the tooltip itself is position: fixed.
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8; // px from the viewport edge
    // Measure the tooltip after we set the text but BEFORE we
    // position it. display:none / display:'' flicker is
    // unavoidable but lasts one frame, which is fine.
    const tipR = tipEl.getBoundingClientRect();
    let top = r.bottom + 6;
    let left = r.left;
    if (top + tipR.height > vh - margin) {
      const above = r.top - tipR.height - 6;
      if (above >= margin) top = above;
      else top = Math.max(margin, vh - tipR.height - margin);
    }
    if (left + tipR.width > vw - margin) {
      left = vw - tipR.width - margin;
    }
    if (left < margin) left = margin;
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  }
  let hoverTimer = null;

  // MutationObserver to hide tooltip if the anchor element is removed from DOM
  const observer = new MutationObserver((mutations) => {
    if (activeEl && !document.body.contains(activeEl)) {
      hide();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Event delegation on the document. We use mouseover /
  // mouseout (NOT mouseenter / mouseleave) because they bubble
  // — critical for delegation.
  document.addEventListener('mouseover', (e) => {
    const t = e.target && e.target.closest && e.target.closest('[data-help]');
    if (!t) return;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      // Removed context-menu entries do not fire mouseout. Do not show a
      // delayed tooltip for a detached (or no-longer-hovered) anchor.
      if (t.isConnected && t.matches(':hover')) showFor(t);
    }, 250);
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target && e.target.closest && e.target.closest('[data-help]');
    if (!t) return;
    // Only hide if we're really leaving the icon (not just
    // moving to a child node inside the icon). relatedTarget
    // is the element the pointer is moving to; if it's still
    // inside `[data-help]`, we keep the tooltip open.
    const to = e.relatedTarget;
    if (to && t.contains(to)) return;
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hide();
  });
  // Hide on any mousedown/click to prevent sticking on action clicks
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('click', hide, true);
  // Hide on Esc and on window blur (alt-tabbing away).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeEl) hide();
  });
  window.addEventListener('blur', hide);
  // Hide tooltip when a native <select> dropdown opens
  document.addEventListener('focusin', (e) => {
    if (e.target?.tagName === 'SELECT') hide();
  });
  document.addEventListener('change', (e) => {
    if (e.target?.tagName === 'SELECT') hide();
  }, true);
  // Reposition on scroll / resize so the tooltip stays glued.
  // capture: true on the scroll listener so we catch scrolls
  // inside the scrollable #content (which doesn't bubble to
  // window).
  window.addEventListener('scroll', () => {
    if (activeEl) position(tip, activeEl);
  }, true);
  window.addEventListener('resize', () => {
    if (activeEl) position(tip, activeEl);
  });
  return { showFor, hide };
}

window.HelpTooltip = { setupHoverHelpTooltips };
