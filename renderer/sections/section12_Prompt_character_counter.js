// renderer/sections/section12_Prompt_character_counter.js
// Extracted: Prompt character counter

// ----------------- Prompt character counter -----------------
// Builds a small "X / 2000" counter for the --prompt argument. The API
// limit is on the --prompt VALUE only (not the entire command line), so
// we count exactly what would be sent in the --prompt argument:
//   extraPrefix + styleText + manual
// We count Unicode CODE POINTS, not UTF-16 code units (String.length).
// String.length over-counts astral characters (emoji, some CJK extensions)
// because they occupy a surrogate pair (2 code units). Array.from() splits
// on code points, so a Chinese user's prompt or an emoji-laden prompt shows
// an accurate count instead of a inflated one.
function computePromptSize(selEl, manualEl, extraPrefix = '') {
  const selVal = selEl ? selEl.value : '';
  const manual = manualEl ? manualEl.value.trim() : '';
  const styleText = getStyleText(selVal);
  return Array.from(extraPrefix + styleText + manual).length;
}
function buildPromptCounter({ selEl, manualEl, getExtraPrefix = () => '', max = 2000, id = '' }) {
  const lbl = el('span', { class: 'prompt-counter-label' }, 'Prompt length:');
  const val = el('span', { class: 'prompt-counter-val' }, '0');
  const maxEl = el('span', { class: 'prompt-counter-max' }, ` / ${max}`);
  const wrap = el('div', { class: 'prompt-counter', id: id ? `counter-${id}` : '' }, [lbl, val, maxEl]);
  const update = () => {
    const extra = getExtraPrefix() || '';
    const n = computePromptSize(selEl, manualEl, extra);
    val.textContent = String(n);
    wrap.classList.toggle('warn', n > max * 0.9 && n <= max);
    wrap.classList.toggle('err', n > max);
  };
  if (selEl) selEl.addEventListener('change', update);
  if (manualEl) manualEl.addEventListener('input', update);
  // Initial
  update();
  return { wrap, update };
}

