// renderer/utils/tinyUtils.js
// Small pure helpers shared across renderer sections.

function pathJoin(a, b) {
  if (!a) return b;
  const sep = a.includes('\\') ? '\\' : '/';
  return a.replace(/[\\/]+$/, '') + sep + b;
}

function safeStringify(o) {
  try { return JSON.stringify(o, null, 2).slice(0, 4000); }
  catch { return String(o); }
}

function extFromMime(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

function _isImageExt(ext) {
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes((ext || '').toLowerCase());
}

function appendBoolFlag(args, param, flag) {
  const v = param.getValue ? param.getValue() : param.value;
  if (v === 'on' || v === true) args.push(flag);
}

// Extract the --flag from a param's enclosing .row label (e.g. "--model (hd)"
// → "--model"). The flag is the first "--xxx" token in the label. Returns
// null if the row is unlabeled (e.g. prompt, lyrics textarea, variants row).
function _flagForParam(param) {
  if (!param) return null;
  const el = param.el || param;
  if (!el || !el.closest) return null;
  const row = el.closest('.row');
  if (!row) return null;
  const lbl = row.querySelector('label');
  if (!lbl) return null;
  const m = lbl.textContent && lbl.textContent.match(/--[a-zA-Z][a-zA-Z0-9-]*/);
  return m ? m[0] : null;
}

// Read a param's value and append "--flag value" to the args list.
// Auto-skips null/empty/'off' values. The flag is taken from the
// param's .row label (see _flagForParam) or from param.flag if set.
function appendFlag(args, param) {
  if (!param) return;
  const v = param.getValue ? param.getValue() : (param.value ?? param.el?.value);
  if (v == null || v === '' || v === 'off') return;
  const flag = param.flag || _flagForParam(param);
  if (!flag) {
    console.warn('[appendFlag] could not determine flag for param, skipping', param);
    return;
  }
  args.push(flag, String(v));
}

// QA-016: shared keyboard-accessibility helper. Makes a clickable element
// focusable via Tab and activatable via Enter/Space (WAI-ARIA pattern).
function makeFocusable(el, onClick) {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); }
  });
}

window.TinyUtils = {
  pathJoin, safeStringify, extFromMime, _isImageExt,
  appendBoolFlag, appendFlag, _flagForParam, makeFocusable,
};

