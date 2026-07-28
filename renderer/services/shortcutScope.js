// renderer/services/shortcutScope.js
// PE-018: central shortcut-scope stack. Only the topmost surface's
// keyboard handler fires — the global app.js handler yields when a
// modal/editor scope is active.
//
// Usage:
//   const pop = window.ShortcutScope.push('editor');
//   // ... editor is active; global shortcuts are suppressed ...
//   pop(); // editor closed; global shortcuts resume
//
// The global handler checks window.ShortcutScope.isGlobalSuppressed()
// at the top; if true, it returns immediately (the scoped surface
// handles its own keys via its own keydown listener).

(function () {
  'use strict';

  /** @type {string[]} */
  const stack = [];

  /**
   * Push a new scope onto the stack. Returns a pop function that
   * removes THIS scope (idempotent — calling pop() twice is safe).
   * @param {string} name — scope label (e.g. 'editor', 'modal', 'settings')
   * @returns {() => void} pop function
   */
  function push(name) {
    stack.push(name || 'anonymous');
    let popped = false;
    return function pop() {
      if (popped) return;
      popped = true;
      const idx = stack.lastIndexOf(name || 'anonymous');
      if (idx >= 0) stack.splice(idx, 1);
    };
  }

  /**
   * True when any non-global scope is active (editor, modal, etc.).
   * The global handler in app.js checks this and yields.
   */
  function isGlobalSuppressed() {
    return stack.length > 0;
  }

  /** Current topmost scope name (or null if global). */
  function current() {
    return stack.length > 0 ? stack[stack.length - 1] : null;
  }

  /** Full stack depth (useful for diagnostics/tests). */
  function depth() {
    return stack.length;
  }

  window.ShortcutScope = { push, isGlobalSuppressed, current, depth };
})();
