// renderer/utils/securityUtils.js
// API key masking + reveal-on-demand input row.
//
//   maskApiKey(key)      -> "abcde***" or "***" for short/empty keys
//   maskLine(line, key)  -> replaces every occurrence of the key in `line`
//   showRevealableKey()  -> returns { row, input, getValue, isRevealed }

/**
 * Mask an API key for display.
 * Short / empty keys are fully replaced with "***".
 * @param {string} key
 * @returns {string}
 */
function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 5) return '***';
  return key.slice(0, 5) + '***';
}

/**
 * Replace every occurrence of the raw key in `line` with its masked
 * form. Safe for log output.
 * @param {string} line
 * @param {string} apiKey
 * @returns {string}
 */
function maskLine(line, apiKey) {
  if (!apiKey || typeof line !== 'string') return line;
  return line.split(apiKey).join(maskApiKey(apiKey));
}

/**
 * Build an input row that shows the key masked and only reveals it
 * after clicking "Show" / "Hide".
 *
 * Security notes:
 *   - When a value exists and is NOT revealed, the input is
 *     `readonly` (prevents accidental typing over the mask).
 *   - When the value is empty, the input is editable (so paste
 *     works during first-run setup).
 *   - getValue() always returns the raw value — save handlers can
 *     read it safely.
 *
 * @param {string} realKey
 * @param {{ label?: string, placeholder?: string }} [opts]
 * @returns {{ row: HTMLElement, input: HTMLInputElement, getValue: () => string, isRevealed: () => boolean }}
 */
function showRevealableKey(realKey, opts) {
  opts = opts || {};
  const placeholder = opts.placeholder || '';
  const label = opts.label || 'API key';
  let curValue = realKey || '';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.placeholder = placeholder;
  inp.autocomplete = 'off';
  let revealed = false;
  const toggle = document.createElement('button');
  toggle.className = 'btn-mini';
  toggle.type = 'button';
  toggle.textContent = 'Show';

  function refresh() {
    const hasValue = !!curValue;
    if (hasValue) {
      inp.value = revealed ? curValue : maskApiKey(curValue);
      inp.readOnly = !revealed;
    } else {
      inp.value = '';
      inp.readOnly = false;
    }
    toggle.textContent = revealed ? 'Hide' : 'Show';
  }
  inp.addEventListener('input', () => {
    // Typing sets the new real value. refresh() re-enables readonly
    // once the value is non-empty.
    curValue = inp.value;
    if (curValue && !revealed) {
      revealed = true;
    }
    refresh();
  });
  inp.addEventListener('focus', () => {
    if (!curValue && !revealed) inp.readOnly = false;
  });
  toggle.addEventListener('click', () => {
    revealed = !revealed;
    refresh();
  });
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  const combo = document.createElement('div');
  combo.className = 'combo';
  combo.appendChild(inp);
  combo.appendChild(toggle);
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(labelEl);
  row.appendChild(combo);
  refresh();
  return { row, input: inp, getValue: () => curValue, isRevealed: () => revealed };
}

window.SecurityUtils = { maskApiKey, maskLine, showRevealableKey };
