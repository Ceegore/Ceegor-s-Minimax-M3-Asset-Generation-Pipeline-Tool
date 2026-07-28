// renderer/services/LogCategories.js
// Log event categories + global limits.

/** Maximum number of events kept in memory. Newer events push older
 *  ones out (FIFO). Caps memory growth over a long session. */
const LOG_MAX_EVENTS = 500;

/** Map of category id → (icon glyph, label). The icon is the leading
 *  character in each row; the label is shown on hover (and used by
 *  the keyboard-shortcut help modal). Kept short so a single row
 *  stays one line in the collapsed state. */
const LOG_CATEGORIES = {
  info:     { icon: '·', label: 'Info' },
  gen:      { icon: '✎', label: 'Generate' },
  upscale:  { icon: '⇔', label: 'Upscale' },
  bg:       { icon: '◐', label: 'Background' },
  optimize: { icon: '∇', label: 'Optimize' },
  batch:    { icon: '▶', label: 'Batch' },
  error:    { icon: '!', label: 'Error' },
  cancel:   { icon: '×', label: 'Cancel' },
  pipeline: { icon: '🛤', label: 'Pipeline' },
};

window.LogCategories = { LOG_MAX_EVENTS, LOG_CATEGORIES };
