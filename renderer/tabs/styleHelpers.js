// renderer/tabs/styleHelpers.js
// Style-preset helpers + status-bar setter. Called from imageTab,
// musicTab, speechTab, videoTab, and the context-menu section.

function setStatus(text, busy = false) {
  // Issue-8: the status line moved from the header (#status, removed) to
  // the sticky top bar of the tab area (#statusbar in index.html).
  const s = $('#statusbar');
  if (!s) return;
  s.textContent = text;
  s.classList.toggle('busy', !!busy);
  s.classList.remove('error');
}

// Transient error state in the status bar with up to two inline action links.
// KGO5-028: sticky by default (ms=0) so Retry/Diagnose links survive until
// the next setStatus() call. Pass ms>0 for auto-clear behavior.
function setStatusError(text, actions, ms = 0) {
  const s = $('#statusbar'); if (!s) return;
  s.classList.remove('busy'); s.classList.add('error');
  s.textContent = ''; s.appendChild(document.createTextNode('⚠ ' + text + '  '));
  for (const a of (actions || [])) {
    const link = el('a', { href: '#', class: 'statusbar-action' }, a.label);
    link.addEventListener('click', (e) => { e.preventDefault(); try { a.onClick(); } catch (_) {} });
    s.appendChild(link); s.appendChild(document.createTextNode('  '));
  }
  clearTimeout(s._errTimer);
  if (ms > 0) s._errTimer = setTimeout(() => { s.classList.remove('error'); setStatus('Ready', false); }, ms);
}
window.setStatusError = setStatusError;

function getStyleById(id) {
  return (state.config.styles || []).find((s) => s.name === id);
}

function getStyleText(id) {
  const s = getStyleById(id);
  return s && s.value ? s.value.trim() : '';
}

function buildStyleRow(tabKey, helpText) {
  // Dropdown listing all style presets. Empty value = no style.
  // The `style-select` class is queried by _refreshAllStyleDropdowns so
  // style add/edit/delete reflects in every open tab without a refresh.
  const sel = el('select', { class: 'style-select' });
  sel.appendChild(el('option', { value: '' }, '(no style)'));
  for (const s of (state.config.styles || [])) {
    const opt = el('option', { value: s.name }, s.name);
    if (s.value && s.value.length > 60) opt.title = s.value;
    sel.appendChild(opt);
  }
  const manage = el('button', { class: 'btn-mini', onclick: () => openStyleSettings(tabKey) }, '⚙');
  const combo = el('div', { class: 'combo' }, [sel, manage]);
  const lbl = el('label', {}, [
    'Style preset (prepended to your prompt)',
    el('span', { class: 'help', 'data-help': helpText }, '?'),
  ]);
  sel.setAttribute('aria-label', 'Style preset');
  const row = el('div', { class: 'row' }, [lbl, combo]);
  return { row, sel };
}

function buildStylePreviewBlock() {
  return el('div', { class: 'style-preview' });
}

function updateStylePreview(tab, extraPrefix = '') {
  // tab = { previewEl, selEl, manualEl }
  if (!tab || !tab.previewEl) return;
  const selVal = tab.selEl ? tab.selEl.value : '';
  const manual = tab.manualEl ? tab.manualEl.value.trim() : '';
  const styleText = getStyleText(selVal);
  const preview = tab.previewEl;
  preview.innerHTML = '';
  if (!extraPrefix && !styleText && !manual) {
    preview.appendChild(el('span', { class: 'empty' }, 'Will send: (empty prompt)'));
    return;
  }
  if (extraPrefix) {
    preview.appendChild(el('div', {}, [el('span', { class: 'prefix' }, extraPrefix), el('span', {}, ', ')]));
  }
  if (styleText) {
    preview.appendChild(el('div', {}, [el('span', { class: 'prefix' }, styleText), el('span', {}, ', ')]));
  }
  if (manual) {
    preview.appendChild(el('div', {}, [el('span', {}, manual)]));
  }
}

function buildFinalPrompt(selEl, manualEl, extraPrefix = '') {
  const selVal = selEl ? selEl.value : '';
  const manual = manualEl ? manualEl.value.trim() : '';
  const styleText = getStyleText(selVal);
  // Compose: extraPrefix, styleText, manual
  const parts = [extraPrefix, styleText, manual].filter(Boolean);
  return parts.join(', ');
}

window.StyleHelpers = { setStatus, setStatusError, getStyleText, buildStyleRow, buildStylePreviewBlock, updateStylePreview, buildFinalPrompt };
