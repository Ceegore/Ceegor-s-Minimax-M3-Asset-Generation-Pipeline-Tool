// renderer/sections/section09_Style_dropdown_refresh.js
// Extracted: Style dropdown refresh

// ----------------- Style dropdown refresh -----------------
// Refresh every open style-preset dropdown so the new list of styles is
// immediately reflected after add/edit/delete — without requiring the user
// to switch tabs. Implemented as a class query so detached dropdowns
// (from rebuilt tabs) are automatically ignored.
function _refreshAllStyleDropdowns() {
  for (const sel of document.querySelectorAll('select.style-select')) {
    // Skip if the select is no longer in the document
    if (!sel.isConnected) continue;
    const cur = sel.value;
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '' }, '(no style)'));
    for (const s of (state.config.styles || [])) {
      const opt = el('option', { value: s.name }, s.name);
      if (s.value && s.value.length > 60) opt.title = s.value;
      sel.appendChild(opt);
    }
    // Try to preserve the current selection
    if (cur && (state.config.styles || []).some((s) => s.name === cur)) sel.value = cur;
  }
}

