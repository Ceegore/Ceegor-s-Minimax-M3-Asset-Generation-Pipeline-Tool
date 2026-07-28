// renderer/core/DomHelpers.js
// DOM selector wrappers + element/escape helpers. Centralising
// createElement + escapeHtml here keeps string interpolation safe from
// XSS via unfiltered innerHTML assignments.

// 'var' (not 'const') at the top level of a <script> tag is what makes
// these globals. Sections loaded after DomHelpers.js but before app.js
// call bare '$'/'$$', so they must be global.
var $ = (sel, root = document) => root.querySelector(sel);
var $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Creates a DOM element with attributes + children.
 * @param {string} tag
 * @param {object} [attrs]
 * @param {(Node|string|null)[]} [children]
 * @returns {HTMLElement}
 */
function createElement(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v != null && v !== false) el.setAttribute(k, v);
    }
  }
  if (children) for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

// Basic HTML escape, used for XSS-safe string interpolation.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Expose on window (renderer has no module bundler).
window.$ = $;
window.$$ = $$;
window.createElement = createElement;
window.escapeHtml = escapeHtml;
