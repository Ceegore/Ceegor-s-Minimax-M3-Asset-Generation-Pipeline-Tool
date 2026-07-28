// renderer/sections/section14_Form_helpers.js
// Extracted: Form helpers

// ----------------- Form helpers -----------------

// Build the "Target file prefix" input row. The same row is mounted on
// every tab (image/speech/music/video) but the value is global — when
// the user types in one tab, the other tabs' inputs are updated in
// place so they always show the same prefix. The prefix is prepended
// verbatim to the generated file's name in every gen handler (see
// image/speech/music/video .gen-btn click listeners). The value lives
// in state.filePrefix and is persisted to state.json via saveAllStates.
function buildFilePrefixRow() {
  const input = el('input', {
    type: 'text',
    class: 'file-prefix-input',
    value: state.filePrefix || '',
    placeholder: '(no prefix)',
  });
  // Keep the four mirrored inputs in sync and bump the autosave debounce
  // so the value lands in state.json within ~500ms of the last keystroke.
  input.addEventListener('input', () => {
    state.filePrefix = input.value;
    for (const other of document.querySelectorAll('input.file-prefix-input')) {
      if (other !== input) other.value = state.filePrefix;
    }
    scheduleStateSave();
  });
  // +1 button: scan the input value for the rightmost run of digits
  // and increment it by 1, padding with leading zeros to preserve
  // the original width. The rightmost match (not necessarily at the
  // end of the string) means the user can use prefixes like
  // "BildserieFürSpiel_Reihe1_" and have the trailing series counter
  // bump. The regex `(\d+)(?=\D*$)` matches the last digit run that
  // is followed by zero or more non-digits to the end-of-string
  // anchor; e.g. for "Reihe10_v2" it matches "10", for "abc" nothing.
  // When no number is present we surface a hint toast rather than
  // silently doing nothing.
  const plusOneBtn = el('button', {
    class: 'btn-mini plus-one-btn',
    type: 'button',
    title: 'Increment the rightmost number in the prefix by 1',
  }, '+1');
  plusOneBtn.addEventListener('click', () => {
    const val = input.value;
    const match = val.match(/(\d+)(?=\D*$)/);
    if (!match) {
      toast('No number in the prefix to increment. Add a number (e.g. "..._Reihe1_") first.', 'warn', 3500);
      return;
    }
    const numStr = match[1];
    const num = parseInt(numStr, 10);
    const newNum = num + 1;
    // Keep the leading-zero padding so "001" → "002", not "2".
    const newNumStr = String(newNum).padStart(numStr.length, '0');
    const newVal = val.substring(0, match.index) + newNumStr + val.substring(match.index + numStr.length);
    input.value = newVal;
    // Re-fire the input event so the four mirrored inputs across the
    // tabs stay in sync AND state.filePrefix + state.json are updated
    // (the input listener above does both).
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // "Force prefix only" checkbox. When checked, every generated file
  // is named exactly `<prefix><6-digit counter>.<ext>` — the
  // slugified prompt + timestamp is NOT prepended. The 6-digit counter
  // starts at 000001 at the beginning of every Generate click. The
  // counter is per-run (NOT per-prefix) — switching the prefix
  // mid-session does NOT pick up where the previous prefix left off.
  // The checkbox lives ON the file-prefix row so the prefix + the
  // force-only toggle are visually grouped; the four mirrored instances
  // (one per tab) all stay in sync via the same event-delegation
  // pattern as the input itself.
  const forceOnlyCb = el('input', {
    type: 'checkbox',
    class: 'file-prefix-force-only-cb',
    title: 'When checked, every generated file is named <prefix><6-digit counter>.<ext> (e.g. temp000001.jpg).',
  });
  forceOnlyCb.checked = !!state.filePrefixForceOnly;
  function _syncForceOnly() {
    forceOnlyCb.checked = !!state.filePrefixForceOnly;
    for (const other of document.querySelectorAll('input.file-prefix-force-only-cb')) {
      if (other !== forceOnlyCb) other.checked = state.filePrefixForceOnly;
    }
  }
  forceOnlyCb.addEventListener('change', () => {
    state.filePrefixForceOnly = !!forceOnlyCb.checked;
    _syncForceOnly();
    scheduleStateSave();
    toast(state.filePrefixForceOnly
      ? 'Force-prefix-only ON: every generated file will be <prefix>000001.<ext> etc.'
      : 'Force-prefix-only OFF: filenames use the legacy slugified prompt + timestamp.', 'ok', 2500);
  });
  // The +1 button sits BETWEEN the "?" help icon and the input field
  // (left of the input). The row reads:
  //   "Target file prefix   [?]   [+1]   [____________________]   [☐ Force prefix only]"
  // putting the increment affordance right where the user's eye is
  // after reading the help icon. The flex layout in styles.css keeps
  // the label fixed-width, the +1 button fixed-width, and the input
  // takes the remaining space.
  return el('div', { class: 'row file-prefix-row' }, [
    el('label', {}, [
      'Target file prefix',
      // H10-12: only data-help drives the custom HelpTooltip; the native
      // title attribute was removed because it spawned a second overlapping
      // OS tooltip that made the help text unreadable.
      el('span', {
        class: 'help',
        'data-help': 'Prepended to every generated file name. Empty = original name. Example: prefix "ZYX" turns abc123.jpg into ZYXabc.jpg.',
      }, '?'),
    ]),
    plusOneBtn,
    input,
    el('label', {
      class: 'file-prefix-force-only-label',
      title: 'When checked, every generated file is named <prefix><6-digit counter>.<ext> (e.g. temp000001.jpg)',
    }, [forceOnlyCb, ' Force prefix only']),
  ]);
}

// Build a "parameter row" with label, dropdown, optional help tooltip.
// `def = { kind, options, default, help, customType }`
//   kind: 'enum' | 'boolean' | 'text' | 'number' | 'enum-text' (enum with custom text override)
//   options: [{ value, label }]   value==='' means "off / default"
//   fileFilters (for kind:'text'): adds a Browse button with these filters
//   id: explicit DOM id (used for state save/load + cross-tab unique key)

// Extract the --flag from a param's enclosing .row label (e.g. "--model (hd)"
// → "--model"). The flag is the first "--xxx" token in the label. Returns
// null if the row is unlabeled (e.g. prompt, lyrics textarea, variants row).


