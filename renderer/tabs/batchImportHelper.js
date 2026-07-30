// renderer/tabs/batchImportHelper.js
// Helper functions for BatchGen unstructured file import, example template generation,
// and multi-tab batch generation.

// Extract an optional style declaration from the top of an import
// document. Recognised shapes (any of):
//   # style: MyName = "cinematic, 35mm, neon"
//   ## style: MyName — cinematic, 35mm, neon
//   style: MyName = cinematic, 35mm, neon
//   [style] MyName = cinematic, 35mm, neon
//   <!-- style: MyName = cinematic, 35mm, neon -->
// The header must appear BEFORE the first asset row (i.e. in the preamble /
// header lines of the document). Lines that look like a row of the table
// itself (start with `|`, or `image|`, `speech|`, …) are NOT parsed as
// style declarations — those are clearly data, not metadata.
//
// Returns { name, value } on success, or null when no header was found.
// `name` and `value` are trimmed of surrounding quotes / whitespace; both
// are required (a line with a name but no value is ignored, since applying
// half a style would silently truncate the prompt).
function extractStyleHeader(content) {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  // Per-tab asset rows look like `| type | … |` or `type | …` — once we
  // see one, the preamble is over.
  const isDataRow = (l) => {
    const t = l.trim();
    if (!t) return false;
    if (t.startsWith('|')) return /^\|\s*(image|speech|music|video)\s*\|/i.test(t);
    return /^(image|speech|music|video)\s*\|/i.test(t);
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (isDataRow(line)) return null;
    // Strip a leading markdown bullet / checkbox / list marker so AI-generated
    // lists (`- style: Foo = bar`) are still recognised.
    const stripped = line.replace(/^[-*+]\s+/, '').replace(/^\[[ xX]\]\s+/, '');
    // Recognised prefixes: `style:`, `# style:`, `## style:`, `<!-- style: … -->`.
    // The match is permissive on case + whitespace; the body must contain `=`
    // OR an em-dash separator (so a body of pure prose is not mistaken for a
    // header — e.g. "Style: cinematic 35mm photography" without an explicit
    // name=value split is just a sentence, not a preset declaration).
    let body = null;
    const m1 = stripped.match(/^(?:#+\s*)?style\s*:\s*(.+)$/i);
    if (m1) body = m1[1];
    if (!body) {
      const m2 = stripped.match(/^<!--\s*style\s*:\s*(.+?)\s*-->$/i);
      if (m2) body = m2[1];
    }
    if (!body) continue;
    // Split on the FIRST `=` (config.txt format) OR an em/en-dash separator
    // OR a colon (markdown-style "Name: value"). The first segment is the
    // name, the rest is the value (joined back together so a value that
    // itself contains `=` — e.g. `cinematic=style` — is preserved).
    let name, value;
    const eq = body.indexOf('=');
    const em = body.indexOf('—'); // em-dash
    const en = body.indexOf('–'); // en-dash
    // Prefer `=` (the format this tool actually writes), then em-dash, then
    // en-dash, then the first colon. Each cutoff index must be > 0 so the
    // name segment is non-empty.
    let cut = -1;
    if (eq > 0) cut = eq;
    else if (em > 0) cut = em;
    else if (en > 0) cut = en;
    if (cut < 0) {
      // Fall back to the first `:` (markdown style). Reject if the colon is
      // the very first character — that would mean an empty name.
      const colon = body.indexOf(':');
      if (colon > 0) cut = colon;
    }
    if (cut < 0) continue;
    name = body.slice(0, cut).trim();
    value = body.slice(cut + 1).trim();
    // Strip a single layer of matching surrounding quotes ("…" or '…') so
    // AI tools that quote the value (most of them do) work out of the box.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    // Same for the name — quoted names are accepted too.
    if ((name.startsWith('"') && name.endsWith('"')) ||
        (name.startsWith("'") && name.endsWith("'"))) {
      name = name.slice(1, -1).trim();
    }
    if (!name || !value) continue;
    // `=` inside the name would break config.txt parsing — same rule the
    // applyStyleToImportedBatch() runtime check enforces. Surface it here
    // too so the import modal can show a useful message.
    if (name.includes('=')) continue;
    return { name, value };
  }
  return null;
}

// ---- Pure helpers for the batch entry shape ----
//
// The renderer stores TWO per-entry shapes:
//   1. Legacy: a non-empty trimmed string (the prompt itself).
//   2. Snapshot: an object { prompt, settings, ts, label, upscale? … }
//      captured via the "+ Add" button next to Generate. These carry
//      per-entry form state so the BatchGen runner can re-apply the
//      exact settings at run time.
//
// The BatchGen editor (batchManager.js → openBatchManager) needs to
// (a) seed each textarea from either shape, (b) write the edited
// prompt back into the same shape (preserving the snapshot's params),
// and (c) trim + filter empty rows without dropping params.
//
// These helpers centralise the shape logic so it's testable and so a
// future third shape (e.g. array of segments) only needs one edit.

// Extract the editable prompt text from a batch entry of either shape.
function batchEntryText(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') return String((entry && entry.prompt) || '');
  return '';
}

// Return a new entry of the same shape with the given prompt text.
// Strings stay strings; objects keep their params and just update
// `prompt`. null/undefined yields an empty string (consistent with
// the legacy shape so the editor doesn't have to special-case it).
function withBatchEntryText(entry, text) {
  if (typeof entry === 'string') return String(text || '');
  if (entry && typeof entry === 'object') return Object.assign({}, entry, { prompt: String(text || '') });
  return String(text || '');
}

// ---- Helper Functions for Custom Option Extraction & Mapping ----

function getTabInputs(tabKey) {
  const root = document.getElementById(`tab-${tabKey}`);
  if (!root) return {};
  const inputs = {};
  
  const rows = root.querySelectorAll('.row');
  for (const row of rows) {
    const labelEl = row.querySelector('label');
    if (!labelEl) continue;

    // The centralized help system injects a help "?"
    // button (class .help-btn, text "?") as a child of every param
    // label. labelEl.textContent therefore includes that trailing "?",
    // which would make every derived key come out as "n?" / "width?" /
    // ... instead of "n" / "width". The batch runner (batchManager.js)
    // looks up tabFields[cleanKey] with the CLEAN key parsed from the
    // imported row ("n"), so the lookup would always miss and every
    // generic imported param (--n, --width, --seed, ...) would be
    // silently dropped. Strip ALL buttons from a clone before reading
    // the text so keys are clean (a param label's semantic text is
    // never inside a button).
    const labelClone = labelEl.cloneNode(true);
    labelClone.querySelectorAll('button').forEach((b) => b.remove());
    let label = labelClone.textContent.trim().toLowerCase();

    // Clean label text:
    label = label.replace(/^[^\w-]+/, ''); // remove leading symbols/emojis
    label = label.replace(/^--/, ''); // remove CLI dashes
    label = label.replace(/\s*\(.*?\)/, ''); // remove parenthesized details
    label = label.split('\n')[0].trim();
    
    const inputContainer = row.children[1];
    if (inputContainer) {
      inputs[label] = inputContainer;
    }
  }
  return inputs;
}

function getTabInputValue(container) {
  if (container.tagName === 'SELECT' || container.tagName === 'TEXTAREA' || container.tagName === 'INPUT') {
    return container.value;
  }
  if (container.classList && container.classList.contains('combo-select-number')) {
    const sel = container.querySelector('select');
    const num = container.querySelector('input');
    if (sel.value === '__custom__') return num.value;
    return sel.value;
  }
  // `combo-select-enum` (the enum wrapper from ParamRow.js) needs
  // explicit handling. The fallback below (querySelector('input,
  // select, textarea')) matches the <select> first, so when
  // "Custom..." is selected the snapshot would store '__custom__' (the
  // select's value) instead of the typed text, and BatchGen would
  // re-run with the literal string '__custom__' as the
  // model/mode/etc. Mirror the combo-select-number branch.
  if (container.classList && container.classList.contains('combo-select-enum')) {
    const sel = container.querySelector('select');
    const txt = container.querySelector('input');
    if (sel.value === '__custom__') return txt ? txt.value : '';
    return sel.value;
  }
  if (container.classList && container.classList.contains('enum-text-row')) {
    const sel = container.querySelector('select');
    const txt = container.querySelector('input');
    return txt.value || sel.value;
  }
  if (container.classList && container.classList.contains('text-browse-row')) {
    const txt = container.querySelector('input');
    return txt ? txt.value : '';
  }
  const firstInput = container.querySelector('input, select, textarea');
  return firstInput ? firstInput.value : '';
}

function setTabInputValue(container, val) {
  const sel = container.querySelector ? container.querySelector('select') : null;

  // Boolean normalization
  if (sel && sel.options && sel.options.length === 2 && sel.options[0].value === 'off' && sel.options[1].value === 'on') {
    const isTrue = String(val).toLowerCase() === 'true' || String(val).toLowerCase() === 'on' || val === true;
    val = isTrue ? 'on' : 'off';
  }

  if (container.tagName === 'SELECT') {
    container.value = String(val);
    container.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (container.tagName === 'TEXTAREA' || container.tagName === 'INPUT') {
    container.value = String(val);
    container.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (container.classList && container.classList.contains('combo-select-number')) {
    const num = container.querySelector('input');
    if (sel && num) {
      const optionExists = Array.from(sel.options).some(o => o.value === String(val));
      if (optionExists) {
        sel.value = String(val);
        num.value = '';
        num.style.display = 'none';
      } else {
        sel.value = '__custom__';
        num.value = String(val);
        num.style.display = '';
      }
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      num.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else if (container.classList && container.classList.contains('combo-select-enum')) {
    // Mirror combo-select-number for the enum wrapper. The wrapper
    // has a <select>, a hidden text input, AND an OK button;
    // setCustomVisible (in ParamRow) is driven by the select's change
    // event, so dispatching change here makes the 50/50 layout flip
    // on for custom values.
    const txt = container.querySelector('input.enum-custom-input');
    if (sel && txt) {
      const optionExists = Array.from(sel.options).some(o => o.value === String(val));
      if (optionExists) {
        sel.value = String(val);
        txt.value = '';
      } else {
        sel.value = '__custom__';
        txt.value = String(val);
      }
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      txt.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else if (container.classList && container.classList.contains('enum-text-row')) {
    const txt = container.querySelector('input');
    if (sel && txt) {
      const optionExists = Array.from(sel.options).some(o => o.value === String(val));
      if (optionExists) {
        sel.value = String(val);
        txt.value = '';
      } else {
        sel.value = '';
        txt.value = String(val);
      }
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      txt.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else if (container.classList && container.classList.contains('text-browse-row')) {
    const txt = container.querySelector('input');
    if (txt) {
      txt.value = String(val);
      txt.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else {
    const firstInput = container.querySelector('input, select, textarea');
    if (firstInput) {
      firstInput.value = String(val);
      firstInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
}

// True when the token's FIRST colon is a URL-scheme separator ("://"),
// e.g. "http://x.com". Such a token is a bare URL, not a key:value pair,
// and must not be split on the colon. A token like "url:http://x.com" is
// NOT a scheme URL — its first colon separates the key from a value that
// merely contains a URL, so it must still be split on that first colon.
function _firstColonIsScheme(token) {
  const idx = token.indexOf(':');
  return idx !== -1 && token.slice(idx, idx + 3) === '://';
}

// Tokenizes parameters, respecting double-dashes, colons, equal signs, and quotes
function parseParams(paramStr) {
  const params = {};
  if (!paramStr) return params;
  
  const tokens = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < paramStr.length; i++) {
    const c = paramStr[i];
    if ((c === '"' || c === "'") && (i === 0 || paramStr[i-1] !== '\\')) {
      if (inQuote && c === quoteChar) {
        inQuote = false;
      } else if (!inQuote) {
        inQuote = true;
        quoteChar = c;
      } else {
        current += c;
      }
    } else if (c === ' ' && !inQuote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += c;
    }
  }
  if (current) tokens.push(current);

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.includes('=')) {
      const parts = token.split('=');
      const key = parts[0].replace(/^--/, '').replace(/:$/, '').trim().toLowerCase();
      const val = parts.slice(1).join('=').trim();
      params[key] = val;
      i++;
    } else if (token.endsWith(':') && i + 1 < tokens.length && (!tokens[i+1].startsWith('--') || /^--\d/.test(tokens[i+1]))) {
      const key = token.slice(0, -1).replace(/^--/, '').trim().toLowerCase();
      let val = tokens[i+1].trim(); if (/^--\d/.test(val)) val = val.slice(1); // R10: a "--flag" is never a "key:" value (fall through to reparse it), and "--5" is a doubled-dash negative ("-5") — same guard as the --key branch (R9)
      params[key] = val;
      i += 2;
    } else if (token.startsWith('--') && token.includes(':') && !_firstColonIsScheme(token)) {
      // BGR-021 extension: dashed key with an inline colon value
      // (e.g. "--duration:5", "--aspect-ratio:16:9"). Must be checked
      // BEFORE the bare `--key value` and boolean `--key` branches below,
      // which would otherwise misparse it as key 'duration:5'. Split on
      // the FIRST colon only; the value may itself contain colons — even
      // a URL scheme ("--url:http://x.com"). Only a token whose FIRST
      // colon is the "://" scheme separator is excluded (see helper).
      const colonIdx = token.indexOf(':');
      const key = token.slice(2, colonIdx).trim().toLowerCase();
      const val = token.slice(colonIdx + 1).trim();
      if (key) params[key] = val;
      i++;
    } else if (token.startsWith('--') && i + 1 < tokens.length && (!tokens[i+1].startsWith('--') || /^--\d/.test(tokens[i+1]))) {
      const key = token.slice(2).trim().toLowerCase();
      let val = tokens[i+1].trim(); if (/^--\d/.test(val)) val = val.slice(1); // R9: a "--5" after a flag is a doubled-dash negative value ("-5"), not a new flag
      params[key] = val;
      i += 2;
    } else if (token.startsWith('--')) {
      const key = token.slice(2).trim().toLowerCase();
      params[key] = 'true';
      i++;
    } else if (token.includes(':') && !_firstColonIsScheme(token)) {
      // BGR-021 fix: handle key:value tokens (e.g. "aspect-ratio:16:9").
      // Split on the FIRST colon only; the value may contain colons
      // (e.g. time ranges, or a URL value like "url:http://x.com"). A
      // bare scheme URL ("http://x.com") is excluded via the helper.
      const colonIdx = token.indexOf(':');
      const key = token.slice(0, colonIdx).replace(/^--/, '').trim().toLowerCase();
      const val = token.slice(colonIdx + 1).trim();
      if (key) params[key] = val;
      i++;
    } else {
      i++;
    }
  }
  return params;
}

// Build a batch entry from an imported row, running the authoritative
// parameter check. Invalid rows are STILL imported (so the prompt is
// kept) but tagged with `_defective: [reasons]` — the BatchGen
// runner skips defective rows, and the queue editor shows the reasons +
// allows repair. This is the "validate on import, mark defective, repair
// in the editor" behaviour.
//
// H9-008: unknown keys are no longer silently accepted. Each unknown /
// unsupported key adds a precise `_defective` reason so the user sees it in
// the queue editor and can repair it, instead of the row running and the key
// being dropped by the executor (which could spend a request for nothing).
// Aliases documented in importCapabilityRegistry are accepted and resolved to
// their canonical executor flag so the row actually executes.
function buildImportedEntry(type, prompt, params) {
  // First resolve aliases → canonical executor flag (H9-002).
  const { params: resolved, warnings: migrationWarnings } = window.BatchImportCompatibility.migrateLegacyParams(type, resolveAliases(type, params || {}));
  // H9-014: a `prompt`/`text` key in Parameters must NOT override the table's
  // Prompt/Text column (the canonical object persisted + executed validates the
  // table prompt). Drop them here; an explicit prompt in Parameters is flagged
  // below as an unknown/reserved key.
  let promptOverrideAttempt = false;
  for (const k of Object.keys(resolved)) {
    const bare = String(k).replace(/^--/, '').toLowerCase();
    if (bare === 'prompt' || bare === 'text') {
      promptOverrideAttempt = true;
      delete resolved[k];
    }
  }
  const entry = { prompt, ...resolved, ...(migrationWarnings.length ? { _importWarnings: migrationWarnings } : {}) };
  const errors = [];
  if (promptOverrideAttempt) {
    errors.push('A "prompt" or "text" key in the Parameters column was ignored — put the prompt in the Prompt / Text column.');
  }
  try {
    // Unknown-key check (H9-008): must run BEFORE validateValues so an unknown
    // key is reported even when validateValues has nothing to say about it.
    const unknown = findUnknownKeys(type, resolved);
    for (const k of unknown) errors.push(window.BatchImportCompatibility.unsupportedReason(type, k));
    const vv = window.ModelSpecs && window.ModelSpecs.validateValues;
    if (vv) {
      const { errors: vvErrors } = vv(type, Object.assign({}, resolved, { prompt }), { partial: true });
      if (vvErrors && vvErrors.length) errors.push(...vvErrors);
    }
  } catch (_) { /* validation must never block import */ }
  if (errors.length) entry._defective = errors;
  else if (entry._defective) delete entry._defective;
  return entry;
}

// H9-002 alias map: documented flag → canonical executor flag. Mirrors
// main/services/importCapabilityRegistry.js (kept in sync by tests). Keys are
// matched case-insensitively, with or without the leading `--`.
const PARAM_ALIASES = {
  image: { 'subject-reference-file': 'subject-ref', 'subject-reference-type': 'subject-reference-type' },
  // NOTE: for video, --subject-image is the executor's OWN canonical flag (S2V-01
  // reads 'subject-image' and sends --subject-image to the API), so it must NOT
  // be aliased. Only the frame-image variants are aliased to the canonical
  // --first-frame / --last-frame.
  video: { 'first-frame-image': 'first-frame', 'last-frame-image': 'last-frame' },
};
function resolveAliases(type, params) {
  const out = {};
  const aliasMap = PARAM_ALIASES[type] || {};
  for (const [k, v] of Object.entries(params || {})) {
    const bare = String(k).replace(/^--/, '').toLowerCase();
    const canonical = aliasMap[bare];
    if (canonical) {
      // Preserve the leading `--` convention the executor expects.
      const key = (String(k).startsWith('--') ? '--' : '') + canonical;
      out[key] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// H9-008: return the param keys that aren't recognized for this type. Recognized
// = (a) in MODEL_SPECS.supportedFlags, (b) a tool-level key every row may carry
// (variants, n, prompt, text, output policy, postprocess), or (c) an alias above.
function findUnknownKeys(type, params) {
  const specs = window.ModelSpecs && window.ModelSpecs.MODEL_SPECS;
  const supported = new Set();
  if (specs && specs[type] && Array.isArray(specs[type].supportedFlags)) {
    for (const f of specs[type].supportedFlags) {
      supported.add(String(f).replace(/^--/, '').toLowerCase());
    }
  }
  // Tool-level keys every row may legitimately carry (H9-005 postprocess +
  // H9-004 variants + H9-013 output policy).
  const TOOL_KEYS = [
    'variants', 'n', 'prompt', 'text',
    'upscale', 'upscale-enabled', 'upscale-multiplier', 'upscale-model', 'scale',
    'remove-background', 'remove-background-model', 'remove-background-use-gpu',
    'crop', 'resize', 'optimize-format', 'optimize-quality', 'strip-metadata',
    'sendtopipeline', 'send-to-pipeline', 'pipeline',
    // H9-013: per-row output-name prefix (applied to state.filePrefix for one item).
    'output-name', 'output-prefix', 'file-prefix',
    // H9-018: deterministic audio trim/auto-cut post-step.
    'trim-start', 'trim-end', 'auto-cut', 'auto-cut-format',
  ];
  for (const k of TOOL_KEYS) supported.add(k);
  // Aliases for this type are also recognized.
  const aliasMap = PARAM_ALIASES[type] || {};
  for (const k of Object.keys(aliasMap)) supported.add(k);
  // The canonical alias targets too.
  for (const v of Object.values(aliasMap)) supported.add(v);

  const unknown = [];
  for (const k of Object.keys(params || {})) {
    if (k && k.startsWith('_')) continue; // internal bookkeeping (_defective etc.)
    const bare = String(k).replace(/^--/, '').toLowerCase();
    if (!supported.has(bare)) unknown.push(k);
  }
  return unknown;
}
// Reconstruct a CLI-style flag string from a batch entry's params so the
// queue editor can display + re-edit them. Skips the prompt and internal
// bookkeeping keys.
function reconstructParamStr(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const skip = new Set(['prompt', 'text', '_defective', 'ts', 'label', 'settings']);
  const parts = [];
  for (const [k, val] of Object.entries(entry)) {
    if (skip.has(k)) continue;
    if (val === true || val === 'true') { parts.push('--' + k); continue; }
    if (val == null || val === '') continue;
    const s = String(val);
    parts.push('--' + k + ' ' + (/\s/.test(s) ? '"' + s + '"' : s));
  }
  return parts.join(' ');
}

// Apply a style preset to a freshly-imported batch.
//   - Saves {name, value} to the global config.styles list (de-duped
//     by name — overwrites an existing style of the same name without
//     asking, so the import flow is one-click). The list is persisted
//     to config.txt via setConfig so the style is available across
//     sessions and surfaces in every tab's style dropdown.
//   - Stamps `style: name` on every entry of every importedBatches
//     slot, so the existing BatchGen runner (batchManager.js
//     `item.style` handling) pre-selects the style on each entry's
//     per-tab dropdown and prepends it via buildFinalPrompt when the
//     row generates.
//   - Returns the chosen name (or '' if nothing was applied) so the
//     caller can refresh dropdowns + toast.
//
// Idempotence: if (name, value) already matches the in-memory style,
//   return early without re-persisting (a double-click of Overwrite /
//   Append would otherwise re-run the full flow).
// Mutation order: state.config.styles is mutated ONLY after setConfig
//   resolves with ok=true, so a failed IPC can't leave a half-applied
//   style that leaks into the next save.
async function applyStyleToImportedBatch({ name, value }) {
  const n = String(name || '').trim();
  const v = String(value || '').trim();
  if (!n || !v) return '';
  // 'config.txt' style name round-trip: '=' would break parsing
  // (the line format is `<name> = <value>` and the first '=' is
  // the name/value separator). Reject up-front with a toast — the
  // user can rename and re-import.
  if (n.includes('=')) {
    toast('Style name cannot contain "=" (would break config parsing). Rename and re-import.', 'err', 6000);
    return '';
  }
  state.config = state.config || {};
  state.config.styles = Array.isArray(state.config.styles) ? state.config.styles : [];
  // Idempotence: if a style of the same name is already in
  // state.config.styles AND its value is identical to what was just
  // entered, there's nothing to do — the in-memory state is already
  // correct, the dropdown is already showing the name, and the
  // persisted config.txt already has the value. Return the name so
  // the caller can stamp the entries without a redundant setConfig
  // round-trip.
  const existing = state.config.styles.find((s) => s && s.name === n);
  if (existing && String(existing.value || '').trim() === v) {
    return n;
  }
  // Build the NEW styles array (de-duped by name) WITHOUT mutating
  // state.config.styles yet — apply the mutation only after setConfig
  // confirms the write succeeded, so a failed IPC can't leave a
  // half-applied style that leaks into the next save.
  const newStyles = state.config.styles
    .filter((s) => s && s.name !== n)
    .concat([{ name: n, value: v }]);
  const nextConfig = Object.assign({}, state.config, { styles: newStyles });
  // KGO5-004: strip the in-memory API key when the privacy switch is on.
  if (state.apiKeyNoSave) nextConfig.api_key = '';
  let res;
  try {
    res = await window.api.setConfig(nextConfig);
  } catch (e) {
    toast('Could not save style preset: ' + (e && e.message || e), 'err', 5000);
    return '';
  }
  if (!res || res.ok !== true) {
    const msg = (res && res.error) || 'unknown error';
    toast('Could not save style preset: ' + msg, 'err', 5000);
    return '';
  }
  // Persist succeeded → commit the mutation to state.config.
  // The IPC returned the sanitised full config; use it
  // wholesale so other concurrently-edited fields stay in
  // lock-step with disk.
  state.config = (window.adoptConfig ? window.adoptConfig(res.config) : res.config) || nextConfig; // KGO7-003: keep the session key
  // Refresh every per-tab <select class="style-select"> so the
  // just-added name shows up in the dropdowns immediately.
  if (typeof _refreshAllStyleDropdowns === 'function') {
    try { _refreshAllStyleDropdowns(); } catch (_) {}
  }
  return n;
}

// Stamp `style: <name>` on every non-empty entry of an importedBatches
// object so the existing BatchGen runner picks it up. Mutates and
// returns the same object. Pure helper — no I/O.
function stampStyleOnImportedBatch(importedBatches, styleName) {
  const n = String(styleName || '').trim();
  if (!n) return importedBatches;
  for (const type of ['image', 'speech', 'music', 'video']) {
    const list = importedBatches[type] || [];
    for (const entry of list) {
      if (entry && typeof entry === 'object') entry.style = n;
    }
  }
  return importedBatches;
}

window.BatchManager = window.BatchManager || {};
window.BatchManager.buildImportedEntry = buildImportedEntry;
window.BatchManager.reconstructParamStr = reconstructParamStr;
window.BatchManager.applyStyleToImportedBatch = applyStyleToImportedBatch;
window.BatchManager.stampStyleOnImportedBatch = stampStyleOnImportedBatch;
window.BatchManager.extractStyleHeader = extractStyleHeader;

// H9-007: fenced-JSON canonical import path.
// The pipe-table parser splits every line on every `|`, so a pipe in book prose,
// Markdown-escaped pipes, multiline speech, and structured lyrics cannot round-trip
// losslessly. The fenced ```batch-json block is the canonical, lossless wire format:
// each entry is { type, prompt (or text), params: { '--flag': value } }. It runs
// each entry through the EXISTING buildImportedEntry so alias resolution, unknown-key
// detection, and defective-tagging all apply unchanged.
//
// Returns { parsed: bool, entries: {image,speech,music,video}, styleHeader, usedFenced }
// parsed=false → the content has no fenced block; the caller falls back to the table parser.
function parseFencedBatchJson(content) {
  const out = { parsed: false, entries: { image: [], speech: [], music: [], video: [] }, styleHeader: null, usedFenced: false };
  if (typeof content !== 'string' || !content.length) return out;
  // Find the first ```batch-json (or ```json) fenced block. Allow an optional
  // leading style header line before the fence.
  const lines = content.split(/\r?\n/);
  let fenceStart = -1, fenceEnd = -1, info = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^```(batch-json|json)\s*$/i);
    if (m) { fenceStart = i; info = m[1].toLowerCase(); break; }
  }
  if (fenceStart < 0) return out;
  for (let j = fenceStart + 1; j < lines.length; j++) {
    if (/^```\s*$/.test(lines[j])) { fenceEnd = j; break; }
  }
  if (fenceEnd < 0) {
    // Unterminated fence — treat the rest of the file as the block.
    fenceEnd = lines.length;
  }
  // Optional style header in the preamble (before the fence).
  const preamble = lines.slice(0, fenceStart).join('\n');
  out.styleHeader = extractStyleHeader(preamble);
  const blockText = lines.slice(fenceStart + 1, fenceEnd).join('\n').trim();
  if (!blockText) return out;
  let arr;
  try { arr = JSON.parse(blockText); }
  catch (e) {
    // A malformed fence must not fall through to the table parser (which mis-handles JSON braces) — surface a clear error.
    throw new Error('Fenced ```batch-json block could not be parsed: ' + (e.message || e) + '. Check the JSON syntax (trailing commas, unescaped quotes).');
  }
  if (!Array.isArray(arr)) throw new Error('Fenced ```batch-json block must be a JSON array of entries.');
  // R5 (L1): cap entries — a pathological batch file would otherwise build unbounded preview DOM rows and freeze the renderer (commit is capped at 100/type anyway).
  if (arr.length > 1000) throw new Error('Batch file has ' + arr.length + ' entries, over the 1000-entry import cap. Split it into smaller files.');
  for (let k = 0; k < arr.length; k++) {
    const row = arr[k] || {};
    const type = String(row.type || '').toLowerCase();
    if (!['image', 'speech', 'music', 'video'].includes(type)) {
      throw new Error('Entry ' + (k + 1) + ' has an invalid type "' + row.type + '". Use image / speech / music / video.');
    }
    const prompt = row.prompt != null ? row.prompt : (row.text != null ? row.text : '');
    const params = row.params && typeof row.params === 'object' ? row.params : {};
    const entry = buildImportedEntry(type, String(prompt), params);
    // BGR-011 fix: normalize all spellings of the send-to-pipeline flag so the batch runner's check (item.sendToPipeline) always fires.
    if (row.sendToPipeline || row.sendtopipeline || row['send-to-pipeline'] || row.pipeline ||
        params.sendToPipeline || params.sendtopipeline || params['send-to-pipeline'] || params.pipeline) {
      entry.sendToPipeline = true;
    }
    out.entries[type].push(entry);
  }
  out.parsed = true;
  out.usedFenced = true;
  return out;
}
window.BatchManager.parseFencedBatchJson = parseFencedBatchJson;

async function importBatchFileDialog() {
  try {
    const pickResult = await window.api.pickFile({
      title: 'Import Batch File',
      filters: [{ name: 'Text and Markdown files', extensions: ['txt', 'md'] }]
    });
    if (!pickResult.ok || pickResult.canceled) return;

    // BGR-008 fix: mint a read grant before fbRead (R1.3 gate).
    // gewv2 GEW-001 fix: file:pick already minted a read grant for the exact
    // picked file (works even outside the trusted roots) — prefer it instead
    // of discarding it and re-minting via ensureRead, which is rejected for
    // any path not already under an allowed root.
    const readGrant = pickResult.grantId
      || ((window.GrantHelper) ? await window.GrantHelper.ensureRead(pickResult.path) : undefined);
    const readResult = await window.api.fbRead(pickResult.path, readGrant);
    if (!readResult.ok) {
      toast('Failed to read file: ' + readResult.error, 'err');
      return;
    }

    const base64 = readResult.base64;
    let content = decodeURIComponent(escape(atob(base64)));
    // BGR-019 fix: strip UTF-8 BOM (U+FEFF) if present. Windows editors
    // often prepend it; without stripping, the first line's type token
    // becomes '\uFEFFimage' and fails the type check.
    content = content.replace(/^\uFEFF/, '');

    importBatchFromContent(content);
  } catch (err) {
    toast('Error reading file: ' + err.message, 'err');
    console.error(err);
  }
}

// Reusable entry point: parse a content string (fenced-JSON or legacy
// table) and show the import review modal. Called by importBatchFileDialog
// (after reading the picked file) and by the M3 in-tool pipeline (after
// producing the batch document). Exported as
// window.BatchManager.importBatchFromContent.
function importBatchFromContent(content) {
  try {
    const lines = content.split(/\r?\n/);
    const importedBatches = { image: [], speech: [], music: [], video: [] };

    // H9-007: try the fenced-JSON canonical (lossless) path first. The legacy
    // pipe-table parser stays as a fallback for compatibility — it splits every
    // line on every `|`, so pipes-in-prose, multiline speech, and structured
    // lyrics cannot round-trip through it.
    let usedFencedJson = false, fencedStyleHeader = null;
    try {
      const fenced = parseFencedBatchJson(content);
      if (fenced.parsed) {
        usedFencedJson = true; fencedStyleHeader = fenced.styleHeader;
        for (const type of ['image', 'speech', 'music', 'video']) {
          importedBatches[type] = fenced.entries[type];
        }
      }
    } catch (fencedErr) {
      toast('Fenced-JSON import error: ' + fencedErr.message, 'err', 7000);
      return;
    }
    // Surface the actual reasons an entry was flagged defective, not
    // just a count. Collect each defective entry (line index + type +
    // short prompt preview + the reasons validateValues returned) so
    // the import modal can show a "see what's wrong" detail list
    // instead of "N items invalid". Backwards-compat: `defectiveCount`
    // still exists for callers that want a quick yes/no.
    let importCount = 0;
    let defectiveCount = 0;
    const defectiveEntries = []; // { type, prompt, reasons: string[], lineNo }

    if (usedFencedJson) {
      for (const type of ['image', 'speech', 'music', 'video']) {
        const list = importedBatches[type] || [];
        importCount += list.length;
        for (let i = 0; i < list.length; i++) {
          const entry = list[i];
          if (entry._defective) {
            defectiveCount++;
            defectiveEntries.push({
              type,
              prompt: entry.prompt || '',
              reasons: Array.isArray(entry._defective) ? entry._defective.slice() : [String(entry._defective)],
              lineNo: i + 1,
            });
          }
        }
      }
    } else {
      // Legacy table path — surface a one-time hint that the lossless format exists.
      // (Only shown when the imported file actually looks like a table.)
      if (lines.some((l) => l.trim().startsWith('|'))) {
        toast('Tip: for lossless import (pipes in text, multiline speech, lyrics), use a fenced ```batch-json block. See the generated manual.', 'ok', 6000);
      }
    }
    const fileStyle = usedFencedJson ? fencedStyleHeader : extractStyleHeader(content);

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      if (usedFencedJson) break; // H9-007: fenced path already populated importedBatches
      let line = lines[lineNo];
      line = line.trim();
      if (!line) continue;

      if (line.startsWith('|') && line.endsWith('|')) {
        const parts = line.split('|').map(s => s.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
        if (parts.every(p => p.startsWith('-') || p === '')) continue;
        // BGR-018 fix: tighten the header heuristic. Only skip if the row
        // looks exactly like a header (type | prompt), not any row whose
        // prompt text happens to contain the word "prompt".
        if (parts[0].toLowerCase() === 'type' && parts[1]?.toLowerCase() === 'prompt') continue;

        if (parts.length >= 2) {
          const type = parts[0].toLowerCase();
          const prompt = parts[1];
          const paramStr = parts[2] || '';

          if (['image', 'speech', 'music', 'video'].includes(type) && prompt) {
            let sendToPipeline = false;
            let cleanPrompt = prompt;
            let cleanParamStr = paramStr;
            
            if (cleanPrompt.includes('→ pipeline')) {
              sendToPipeline = true;
              cleanPrompt = cleanPrompt.replace('→ pipeline', '').trim();
            }
            if (cleanParamStr.includes('pipeline: true')) {
              sendToPipeline = true;
              cleanParamStr = cleanParamStr.replace('pipeline: true', '').trim();
            }
            if (cleanParamStr.includes('→ pipeline')) {
              sendToPipeline = true;
              cleanParamStr = cleanParamStr.replace('→ pipeline', '').trim();
            }

            const params = parseParams(cleanParamStr);
            if (sendToPipeline) params.sendToPipeline = true;
            
            const entry = buildImportedEntry(type, cleanPrompt, params);
            if (entry._defective) {
              defectiveCount++;
              defectiveEntries.push({
                type, prompt: cleanPrompt,
                reasons: entry._defective.slice(),
                lineNo: lineNo + 1,
              });
            }
            importedBatches[type].push(entry);
            importCount++;
          }
        }
      } else if (line.includes('|')) {
        const parts = line.split('|').map(s => s.trim());
        if (parts.length >= 2) {
          const type = parts[0].toLowerCase();
          let prompt = parts[1];
          let paramStr = parts[2] || '';

          if (['image', 'speech', 'music', 'video'].includes(type) && prompt) {
            let sendToPipeline = false;
            if (prompt.includes('→ pipeline')) {
              sendToPipeline = true;
              prompt = prompt.replace('→ pipeline', '').trim();
            }
            if (paramStr.includes('pipeline: true')) {
              sendToPipeline = true;
              paramStr = paramStr.replace('pipeline: true', '').trim();
            }
            if (paramStr.includes('→ pipeline')) {
              sendToPipeline = true;
              paramStr = paramStr.replace('→ pipeline', '').trim();
            }

            const params = parseParams(paramStr);
            if (sendToPipeline) params.sendToPipeline = true;

            const entry = buildImportedEntry(type, prompt, params);
            if (entry._defective) {
              defectiveCount++;
              defectiveEntries.push({
                type, prompt,
                reasons: entry._defective.slice(),
                lineNo: lineNo + 1,
              });
            }
            importedBatches[type].push(entry);
            importCount++;
          }
        }
      }
    }

    if (importCount === 0) {
      toast('No valid asset requests found in the file. Check formatting.', 'warn');
      return;
    }

    showModal((m, close) => {
      m.appendChild(el('h2', {}, 'Import Batch Requests'));
      m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 13px;' },
        `Found ${importCount} asset requests in the file:`));

      const countsList = el('ul', { style: 'margin: 8px 0 16px 20px; font-size: 12px; color: var(--fg-2);' });
      for (const [type, list] of Object.entries(importedBatches)) {
        if (list.length > 0) {
          countsList.appendChild(el('li', {}, `${type.toUpperCase()}: ${list.length} item(s)`));
        }
      }
      m.appendChild(countsList);

      // Warn about entries that failed the parameter check. They are
      // imported but marked defective: the BatchGen runner skips them and
      // the queue editor (✎) allows repairing the flagged settings.
      //
      // The warning ALSO lists the per-entry reasons (collapsed
      // behind a `<details>` so the modal stays short by default).
      if (defectiveCount > 0) {
        const warn = el('div', {
          style: 'margin: 0 0 12px; padding: 8px 10px; border: 1px solid var(--danger); border-radius: var(--radius-sm); background: rgba(255,138,138,0.08); color: var(--danger); font-size: 12.5px;',
        });
        warn.appendChild(el('div', {},
          `⚠ ${defectiveCount} item${defectiveCount === 1 ? '' : 's'} ha${defectiveCount === 1 ? 's' : 've'} invalid settings and ${defectiveCount === 1 ? 'is' : 'are'} marked defective. They will be imported and kept in the queue but skipped during generation until you repair them in the queue editor (✎).`));

        const details = el('details', { style: 'margin-top: 6px;' });
        const summary = el('summary', { style: 'cursor: pointer; user-select: none; color: var(--danger); font-weight: 500;' },
          `Show ${defectiveCount} defective entr${defectiveCount === 1 ? 'y' : 'ies'} and their errors`);
        details.appendChild(summary);
        const defList = el('ul', {
          style: 'margin: 6px 0 0 18px; padding: 0; font-size: 11.5px; color: var(--fg-1); max-height: 200px; overflow-y: auto;',
        });
        for (const def of defectiveEntries) {
          const li = el('li', { style: 'margin: 4px 0;' });
          const promptPreview = (def.prompt || '').replace(/\s+/g, ' ').slice(0, 60) + (def.prompt && def.prompt.length > 60 ? '…' : '');
          li.appendChild(el('div', { style: 'font-weight: 500;' },
            `[line ${def.lineNo}] ${def.type.toUpperCase()}: "${promptPreview}"`));
          for (const r of def.reasons) {
            li.appendChild(el('div', { style: 'margin-left: 8px; color: var(--fg-2);' }, '• ' + r));
          }
          defList.appendChild(li);
        }
        details.appendChild(defList);
        warn.appendChild(details);
        m.appendChild(warn);
      }

      m.appendChild(el('p', { style: 'font-size: 12px; font-weight: bold;' }, 'Choose how to import these items:'));

      // Combined styles + import: a style preset can be attached
      // to the imported batch in one step. When enabled:
      //   - The preset is saved into the global config.styles list
      //     (de-duped by name) so it persists across sessions and
      //     shows up in every tab's style dropdown.
      //   - Every imported entry gets `style: <name>` stamped on it,
      //     which the existing BatchGen runner (batchManager.js
      //     `item.style` handling) picks up to pre-select the
      //     dropdown + prepend the value via buildFinalPrompt when
      //     the row generates.
      // The whole "style preset" feature is opt-in: leaving the
      // checkbox off imports just the prompts, and a style can be
      // picked per-tab in the editor.
      //
      // If the import FILE itself contains a `style: Name = value`
      // header (added by the AI that filled the template), the modal:
      //   1. Auto-checks the "apply preset" box.
      //   2. Pre-fills the name + value fields from the header.
      //   3. Changes the row copy to "Following preset was in the
      //      import and will be used" — with the name + value inline
      //      so it can be verified as expected.
      //   4. Keeps the same checkbox — the preset can still be
      //      skipped (e.g. a preset of the same name already exists
      //      and overwriting it is not desired).
      const styleBox = el('div', {
        style: 'margin: 4px 0 14px; padding: 10px 12px; border: 1px solid var(--border-2); border-radius: var(--radius-sm); background: rgba(255,255,255,0.02);',
      });
      const styleCb = el('input', { type: 'checkbox' });
      styleCb.id = 'batch-import-style-enabled';
      const styleCbRow = el('div', {}, [styleCb]);
      const styleFields = el('div', { style: 'margin: 8px 0 0 22px;' });
      const styleNameInput = el('input', {
        type: 'text',
        placeholder: 'Style name (e.g. "Imported batch — Watercolour")',
        style: 'width: 100%; margin-bottom: 6px;',
      });
      const styleValueInput = el('textarea', {
        placeholder: 'Style value — text prepended to every prompt (e.g. "watercolour, soft lighting, 35mm")',
        style: 'width: 100%; min-height: 56px;',
      });
      styleFields.appendChild(styleNameInput);
      styleFields.appendChild(styleValueInput);
      styleFields.appendChild(el('p', {
        style: 'margin: 6px 0 0; font-size: 11.5px; color: var(--fg-2);',
      }, 'The preset is saved to the global style list (used by every tab) AND pre-selected for every imported entry, so BatchGen prepends it automatically when each item runs.'));

      // Auto-detected preset copy. The label changes between "Apply a
      // style preset…" (no header found) and "Following preset was in
      // the import and will be used…" (header detected). The same
      // checkbox drives both — unchecking skips the preset entirely.
      let styleCbLabel;
      if (fileStyle && fileStyle.name && fileStyle.value) {
        // Pre-fill the fields so what the AI supplied is visible
        // (and editable). The existing-style dropdown stays usable —
        // the imported preset is only ADDED to the list on commit;
        // until then the fields are just an editable preview.
        styleNameInput.value = fileStyle.name;
        styleValueInput.value = fileStyle.value;
        styleCb.checked = true;
        // Note: the dropdown of existing styles (⚙ Settings → Style
        // presets) is the source of truth — the imported preset is
        // not merged into it pre-flight; the existing dropdown
        // already shows every saved style. Names can be compared by
        // opening ⚙ Settings in parallel.
        const valuePreview = (fileStyle.value || '').length > 60
          ? (fileStyle.value.slice(0, 60) + '…')
          : fileStyle.value;
        styleCbLabel = el('label', {
          for: 'batch-import-style-enabled',
          style: 'font-size: 12.5px; cursor: pointer; user-select: none;',
          title: 'Found at the top of the imported file. Uncheck to skip.',
        }, ` Following preset was in the import and will be used: "${fileStyle.name}" = "${valuePreview}"`);
      } else {
        styleCbLabel = el('label', {
          for: 'batch-import-style-enabled',
          style: 'font-size: 12.5px; cursor: pointer; user-select: none;',
        }, ' Apply a style preset to all items in this batch');
      }
      styleCbRow.appendChild(styleCbLabel);
      styleBox.appendChild(styleCbRow);
      styleBox.appendChild(styleFields);
      m.appendChild(styleBox);
      // Hide the fields when the box is unchecked, but pre-fill them
      // anyway so what would have been used is visible (and
      // re-checking the box applies it).
      styleFields.style.display = styleCb.checked ? '' : 'none';
      styleCb.addEventListener('change', () => {
        styleFields.style.display = styleCb.checked ? '' : 'none';
      });

      const overwriteBtn = el('button', { class: 'primary' }, 'Overwrite existing queues');
      const appendBtn = el('button', {}, 'Append to existing queues');
      const cancelBtn = el('button', { class: 'btn-mini' }, 'Cancel');

      // Double-click guard: disable the committing buttons (Overwrite
      // + Append) for the duration of the in-flight
      // applyStyleIfRequested await, so an impatient double-click
      // can't fire two setConfig / batchesSet round-trips in parallel.
      // Cancel stays enabled so abort is always possible.
      // The buttons are re-enabled on every return path (success,
      // validation failure, IPC failure) so a
      // rejected style write doesn't permanently lock the
      // dialog.
      const setCommitButtonsBusy = (busy) => {
        overwriteBtn.disabled = !!busy;
        appendBtn.disabled = !!busy;
        // also re-style so the lock is visible
        overwriteBtn.style.opacity = busy ? '0.5' : '';
        appendBtn.style.opacity = busy ? '0.5' : '';
        overwriteBtn.style.cursor = busy ? 'wait' : '';
        appendBtn.style.cursor = busy ? 'wait' : '';
      };

      async function applyStyleIfRequested() {
        if (!styleCb.checked) return '';
        const n = String(styleNameInput.value || '').trim();
        const v = String(styleValueInput.value || '').trim();
        if (!n || !v) {
          toast('Style name and value are required to apply a style, or uncheck the box.', 'warn', 5000);
          return '';
        }
        const savedName = await applyStyleToImportedBatch({ name: n, value: v });
        if (savedName) stampStyleOnImportedBatch(importedBatches, savedName);
        return savedName;
      }

      overwriteBtn.addEventListener('click', async () => {
        if (overwriteBtn.disabled) return;
        setCommitButtonsBusy(true);
        try {
          const applied = await applyStyleIfRequested();
          if (styleCb.checked && !applied) return;
          const next = { ...state.batches };
          // H9-011: detect capacity overflow BEFORE silently slicing to 100.
          const overflow = {};
          for (const type of ['image', 'speech', 'music', 'video']) {
            // BGR-020 fix: only overwrite types that have entries in the
            // import. An absent type (empty array) must NOT wipe the
            // user's existing queue for that type.
            if (importedBatches[type].length > 0) {
              next[type] = importedBatches[type].slice(0, 100);
              if (importedBatches[type].length > 100) overflow[type] = importedBatches[type].length;
            }
          }
          warnIfOverflow(overflow, 'overwrite');
          // H9-012: only close on a successful save.
          const ok = await saveImported(next);
          if (ok) close();
        } finally {
          setCommitButtonsBusy(false);
        }
      });

      appendBtn.addEventListener('click', async () => {
        if (appendBtn.disabled) return;
        setCommitButtonsBusy(true);
        try {
          const applied = await applyStyleIfRequested();
          if (styleCb.checked && !applied) return;
          const next = { ...state.batches };
          // H9-011: detect capacity overflow BEFORE silently slicing.
          const overflow = {};
          for (const type of ['image', 'speech', 'music', 'video']) {
            const combined = [...(state.batches[type] || []), ...importedBatches[type]];
            next[type] = combined.slice(0, 100);
            if (combined.length > 100) overflow[type] = { total: combined.length, kept: next[type].length };
          }
          warnIfOverflow(overflow, 'append');
          // H9-012: only close on a successful save.
          const ok = await saveImported(next);
          if (ok) close();
        } finally {
          setCommitButtonsBusy(false);
        }
      });

      // H9-011: surface silent capacity truncation instead of reporting success.
      function warnIfOverflow(overflow, mode) {
        const msgs = [];
        for (const [type, info] of Object.entries(overflow)) {
          if (mode === 'append' && typeof info === 'object') {
            msgs.push(`${type}: ${info.total} rows after append, only ${info.kept} kept (queue cap is 100)`);
          } else {
            msgs.push(`${type}: ${info} rows imported, truncated to 100 (queue cap)`);
          }
        }
        if (msgs.length) toast('Queue capacity reached — ' + msgs.join('; ') + '. Re-import the remainder in smaller batches.', 'warn', 8000);
      }

      cancelBtn.addEventListener('click', () => close());

      const footer = el('div', { class: 'footer', style: 'display: flex; gap: 8px; justify-content: flex-end;' }, [cancelBtn, appendBtn, overwriteBtn]);
      m.appendChild(footer);
    });

    async function saveImported(nextBatches) {
      const r = await window.api.batchesSet(nextBatches);
      if (!r.ok) {
        toast('Failed to save imported batches: ' + r.error + ' — your parsed batches are still in the review list; fix the issue and retry.', 'err', 7000);
        // H9-012: keep the modal open so the user can retry without losing the
        // parsed review state.
        return false;
      }
      state.batches = nextBatches;
      _refreshBatchButtons();
      toast(`Successfully imported batch requests!`, 'ok');
      if (typeof openAllBatchDashboard === 'function') openAllBatchDashboard();
      return true;
    }

  } catch (err) {
    toast('Error parsing file: ' + err.message, 'err');
    console.error(err);
  }
}

async function generateExampleFiles() {
  try {
    // The import-doc button opens a native Save-As dialog so the
    // file name + save location are picked manually (instead of
    // writing silently into the configured output folder). The
    // preferred format (Settings → BatchGen → "Example export format")
    // is used as the suggested filename/extension; the extension can
    // still be changed in the dialog and the content matches what's
    // saved.
    const fmt = state.batchesExportFormat || 'md';
    const r = await window.api.saveManualAs(fmt);
    if (r && r.ok && r.path) {
      toast('Saved import document to ' + r.path, 'ok', 5000);
    } else if (r && r.canceled) {
      // User cancelled the Save-As dialog — no toast (silent cancel).
    } else {
      toast('Failed to save import document: ' + ((r && r.error) || 'unknown'), 'err');
    }
  } catch (err) {
    toast('Error: ' + err.message, 'err');
  }
}

async function startAllBatchGen() {
  const tabsToRun = [];
  for (const type of ['image', 'speech', 'music', 'video']) {
    const n = (state.batches[type] || []).length;
    if (n > 0) {
      tabsToRun.push(type);
    }
  }

  if (tabsToRun.length === 0) {
    toast('All batch queues are empty.', 'warn');
    return;
  }

  if (!state.config.hasApiKey) {
    toast('No API key configured. Click ⚙ to open Settings.', 'err');
    return;
  }

  // T3/T4/T6: ONE combined confirmation overlay covering ALL types —
  // per-type item + paid-call counts, the grand total, the output folder
  // (changeable via a native folder picker), and the per-type subfolder
  // opt-out. After confirming, every type runs back-to-back with
  // skipConfirm so an overnight run is never interrupted by another
  // cost prompt.
  const computeCalls = (window.BatchManager && window.BatchManager.computeExpectedCalls) || (() => 0);
  const perType = tabsToRun.map((t) => ({
    type: t,
    items: (state.batches[t] || []).length,
    // P4.3 (DB-H-003): calls = API requests; units = billable outputs (image --n multiplies)
    calls: computeCalls(t, state.batches[t] || [], { callsOnly: true }), units: computeCalls(t, state.batches[t] || []),
  }));
  const totalItems = perType.reduce((s, x) => s + x.items, 0);
  const totalCalls = perType.reduce((s, x) => s + x.calls, 0); const totalUnits = perType.reduce((s, x) => s + x.units, 0);
  const videoCount = (state.batches.video || []).length;
  const choice = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    showModal((m, close) => {
      m.appendChild(el('h2', {}, 'Start BatchGen — all types'));
      const list = el('ul', { style: 'margin: 6px 0 10px; padding-left: 18px;' });
      for (const x of perType) {
        list.appendChild(el('li', {}, `${x.type.toUpperCase()}: ${x.items} item${x.items === 1 ? '' : 's'} → ${x.calls} paid API call${x.calls === 1 ? '' : 's'}${x.units > x.calls ? ` (up to ${x.units} images)` : ''}`));
      }
      m.appendChild(list);
      m.appendChild(el('p', { style: 'font-weight: 600; margin: 0 0 8px;' },
        `Total: ${totalItems} item${totalItems === 1 ? '' : 's'} → ${totalCalls} paid API call${totalCalls === 1 ? '' : 's'}${totalUnits > totalCalls ? ` (up to ${totalUnits} images)` : ''}. All types run in one go — no further confirmations.`));
      if (videoCount > 3) {
        m.appendChild(el('p', { style: 'color: var(--warn, #cc9900); font-size: 12px; margin: 0 0 8px;' },
          `⚠ ${videoCount} videos are queued but the Token Plan includes only 3 free video generations per week — the rest will fail with a quota error.`));
      }
      // T3: output folder display + native folder picker to redirect ALL
      // of this run's generations. pickFolderFull auto-trusts the picked
      // path (native dialog), and startBatchGen mints its own write grant
      // on the chosen base folder.
      let outDirBase = state.fbDir || (state.config && state.config.output_dir) || '';
      const dirSpan = el('span', { style: 'flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-2); font-size: 12px;', title: outDirBase }, outDirBase || '(default output folder)');
      const changeBtn = el('button', { class: 'btn-mini', title: 'Choose a different folder for all generations of this run', onclick: async () => {
        const r = await window.api.pickFolderFull({ purpose: 'config-output' });
        if (r && r.ok && r.path) { outDirBase = r.path; dirSpan.textContent = r.path; dirSpan.title = r.path; }
      } }, 'Change…');
      m.appendChild(el('div', { style: 'display: flex; gap: 8px; align-items: center; margin: 0 0 8px;' }, [
        el('span', { style: 'flex: 0 0 auto;' }, '💾 Save to:'), dirSpan, changeBtn,
      ]));
      // T4: per-asset-type subfolder opt-out (default unchecked = each
      // type is written to <base>\<type>, created on demand).
      const subCb = el('input', { type: 'checkbox' });
      m.appendChild(el('label', { style: 'display: flex; gap: 6px; align-items: center; font-size: 12px; margin: 0 0 10px; cursor: pointer;' }, [
        subCb, 'Do not use/create sub-folders for assets types',
      ]));
      const cancelBtn = el('button', { onclick: () => close() }, 'Cancel');
      const startBtn = el('button', { class: 'primary', onclick: () => {
        done({ outputDirBase: outDirBase, noTypeSubfolders: !!subCb.checked });
        close();
      } }, '▶ Start all');
      m.appendChild(el('div', { class: 'footer' }, [cancelBtn, startBtn]));
    }, { onClose: () => done(null) });
  });
  if (!choice) return;

  // startBatchGen owns window._batchAbortByTab (keyed per tab — see
  // batchManager.js for why a shared `_batchAbort` is wrong). This loop
  // runs each tab SEQUENTIALLY (awaited, never concurrent with itself),
  // so after each tab finishes its flag is checked — i.e. whether
  // "■ Stop batch" was clicked on that tab's overlay DURING this
  // dashboard-driven run — and if so, the rest of the tabs are not
  // walked either (preserving the existing "one stop halts the whole
  // sequential chain" behaviour without reintroducing a flag shared
  // with independent, concurrent per-tab "Start BatchGen" runs).
  for (const type of tabsToRun) {
    // Switch to the active generating tab so progress is visible
    showTab(type);

    // Start batchgen and wait for completion. skipConfirm: the combined
    // overlay above is the ONE confirmation for the whole run (T6).
    await startBatchGen(type, {
      skipConfirm: true,
      outputDirBase: choice.outputDirBase,
      noTypeSubfolders: choice.noTypeSubfolders,
    });

    if (window._batchAbortByTab && window._batchAbortByTab[type]) {
      toast('Global batch generation aborted.', 'warn');
      return;
    }
  }
  // T7: final success confirmation once every type has finished (the
  // per-type overlays auto-close on clean success in startBatchGen).
  toast('✅ All BatchGen types finished.', 'ok', 6000);
}

// Bind to window
window.BatchManager = window.BatchManager || {};
window.BatchManager.importBatchFileDialog = importBatchFileDialog;
window.BatchManager.importBatchFromContent = importBatchFromContent;
window.BatchManager.generateExampleFiles = generateExampleFiles;
window.BatchManager.startAllBatchGen = startAllBatchGen;
window.BatchManager.parseParams = parseParams;
// Exposed so batchManager.js (the editor) can call them and so tests
// can import them without DOM shims.
window.BatchManager.batchEntryText = batchEntryText;
window.BatchManager.withBatchEntryText = withBatchEntryText;
