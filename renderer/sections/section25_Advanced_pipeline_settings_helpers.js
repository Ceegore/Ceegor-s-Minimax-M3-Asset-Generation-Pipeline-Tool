// renderer/sections/section25_Advanced_pipeline_settings_helpers.js
// The section25 selRow / cbRow / numRow / sectionTitle helpers, in their own
// file so section25 itself stays under the 500-line lint cap. The helpers are
// pure DOM builders (no state coupling, no IPC) — they take the current value
// + change handler and return a styled .row element. The caller (section25's
// main file) supplies the el/toast globals + the onChange callback. Loaded
// BEFORE section25 in index.html.

// `valueSpec` (optional):
//   { kind: 'number', min, max, step } -> validate as number
//   { kind: 'string', pattern }        -> validate as regex
//   undefined / null                   -> no validation, free-form
window.Section25Helpers = (function () {
  function selRow(labelText, tooltip, currentValue, options, onChange, valueSpec) {
    const sel = el('select', { title: tooltip });
    for (const [val, lbl] of options) {
      const opt = el('option', { value: String(val) }, lbl);
      if (String(val) === String(currentValue)) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.appendChild(el('option', { value: '__custom__' }, 'Custom\u2026'));
    const inp = el('input', {
      type: (valueSpec && valueSpec.kind === 'number') ? 'number' : 'text',
      value: String(currentValue),
      placeholder: (valueSpec && valueSpec.kind === 'number') ? 'enter a number\u2026' : 'enter a custom value\u2026',
      class: 'section25-custom-input',
      title: tooltip,
    });
    if (valueSpec && valueSpec.kind === 'number') {
      if (Number.isFinite(valueSpec.min)) inp.min = String(valueSpec.min);
      if (Number.isFinite(valueSpec.max)) inp.max = String(valueSpec.max);
      if (Number.isFinite(valueSpec.step)) inp.step = String(valueSpec.step);
    } else if (valueSpec && valueSpec.kind === 'string' && valueSpec.pattern) {
      inp.pattern = valueSpec.pattern;
    }
    inp.style.display = 'none';
    inp.style.flex = '1';
    const okBtn = el('button', {
      type: 'button',
      class: 'btn-mini section25-custom-ok',
      title: 'Apply the typed custom value',
      style: 'display: none;',
    }, 'OK');
    const wrap = el('div', { class: 'section25-sel-row', style: 'display: flex; gap: 4px; align-items: center; flex: 1;' }, [sel, inp, okBtn]);
    function validate(raw) {
      if (!valueSpec || valueSpec.kind == null) return { ok: true, value: raw };
      if (valueSpec.kind === 'number') {
        if (raw === '' || raw == null) return { ok: false, error: 'Enter a number.' };
        const n = Number(raw);
        if (!Number.isFinite(n)) return { ok: false, error: 'Not a valid number.' };
        if (Number.isFinite(valueSpec.min) && n < valueSpec.min) return { ok: false, error: 'Must be \u2265 ' + valueSpec.min + '.' };
        if (Number.isFinite(valueSpec.max) && n > valueSpec.max) return { ok: false, error: 'Must be \u2264 ' + valueSpec.max + '.' };
        return { ok: true, value: n };
      }
      if (valueSpec.kind === 'string' && valueSpec.pattern) {
        try {
          const re = new RegExp(valueSpec.pattern);
          if (!re.test(raw)) return { ok: false, error: 'Value does not match the expected pattern.' };
        } catch (_) { /* invalid regex pattern from caller */ }
        return { ok: true, value: raw };
      }
      return { ok: true, value: raw };
    }
    function setCustomVisible(visible) {
      if (visible) {
        inp.style.display = '';
        okBtn.style.display = '';
        wrap.classList.add('section25-custom-active');
      } else {
        inp.style.display = 'none';
        okBtn.style.display = 'none';
        wrap.classList.remove('section25-custom-active');
      }
    }
    const matchInOptions = options.some(([val]) => String(val) === String(currentValue));
    if (matchInOptions) {
      sel.value = String(currentValue);
    } else {
      sel.value = '__custom__';
      inp.value = currentValue == null ? '' : String(currentValue);
      setCustomVisible(true);
    }
    sel.addEventListener('change', () => {
      if (sel.value === '__custom__') {
        setCustomVisible(true);
        setTimeout(() => { try { inp.focus(); inp.select(); } catch (_) {} }, 0);
      } else {
        setCustomVisible(false);
        inp.value = '';
        onChange(sel.value);
      }
    });
    function applyCustom() {
      const v = inp.value;
      const r = validate(v);
      if (!r.ok) {
        if (typeof toast === 'function') toast(r.error, 'warn', 2500);
        try { inp.focus(); inp.select(); } catch (_) {}
        return;
      }
      onChange(r.value);
    }
    okBtn.addEventListener('click', applyCustom);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyCustom();
      }
    });
    return el('div', { class: 'row' }, [
      el('label', { title: tooltip }, labelText),
      wrap,
    ]);
  }
  function cbRow(labelText, tooltip, currentChecked, onChange) {
    const cb = el('input', { type: 'checkbox', title: tooltip });
    cb.checked = !!currentChecked;
    cb.addEventListener('change', () => onChange(cb.checked));
    return el('div', { class: 'row' }, [
      el('label', { class: 'auto-crop-label', title: tooltip }, [cb, ' ' + labelText]),
    ]);
  }
  function numRow(labelText, tooltip, currentValue, min, max, step, onChange) {
    const inp = el('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(currentValue), title: tooltip });
    inp.style.width = '100px';
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
    });
    return el('div', { class: 'row' }, [
      el('label', { title: tooltip }, labelText),
      inp,
    ]);
  }
  function sectionTitle(glyph, text, subtitle) {
    const frag = el('div', {});
    frag.appendChild(el('h4', { class: 'settings-group-title', style: 'margin-top: 14px;' }, glyph + ' ' + text));
    if (subtitle) frag.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 11px; margin: 2px 0 6px;' }, subtitle));
    return frag;
  }
  return { selRow, cbRow, numRow, sectionTitle };
})();
