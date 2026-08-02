// renderer/sections/section19_Modal.js
// Modal

// ----------------- Modal -----------------
// Stack-based modal manager. A single `_modalClose` slot that wipes `modal-root`
// on every `showModal` would destroy any underlying modal (e.g. opening the
// bulk-paste dialog from the BatchGen manager would wipe the BatchGen modal
// entirely, and the user lost Esc-to-close on the parent). Stacking keeps each
// modal's DOM around until its own close is called, and Esc closes the topmost
// modal first.
//
// Focus restoration: when a modal opens, the document.activeElement is
// remembered so focus can be restored on close. Without this, clicking into the
// folder-browser filter opened the help modal AND stripped focus from the
// input; after dismissing the modal the user had to click the input again,
// which would re-trigger the same help modal — an infinite loop. Restoring
// focus on close breaks the cycle.
//
// Stack dedup: every modal can carry an optional `id` string. If a modal with
// the same id is already on the stack, the new call is treated as a no-op
// (returns the existing modal's close fn). Without this, mashing a help button
// on a glitchy trackpad could pile up five identical help modals on top of
// each other.
let _modalClose = null;
const _modalStack = [];

// H8-003: mark every modal below the new top as `inert`. A stacked modal
// previously did NOT block its parent — every .modal is a sibling inside
// #modal-root with no per-modal backdrop, so e.g. the editor's Heal button
// stayed clickable underneath the heal menu, and mashing it stacked
// duplicates. Setting `inert` on lower modals makes the whole stack truly
// modal (pointer + focus + AT) in one place. `inert` is supported by the
// shipped Chromium (>=102).
function _reapplyInert() {
  for (let i = 0; i < _modalStack.length; i++) {
    const entry = _modalStack[i];
    const elNode = entry && entry.el;
    if (!elNode) continue;
    try {
      if (i < _modalStack.length - 1) {
        elNode.setAttribute('inert', '');
      } else if (typeof elNode.removeAttribute === 'function') {
        elNode.removeAttribute('inert');
      }
    } catch (_) { /* best-effort: a broken node must never block modal open/close */ }
  }
}

function showModal(build, opts) {
  const root = $('#modal-root');
  const id = (opts && opts.id) || null;
  const onClose = (opts && typeof opts.onClose === 'function') ? opts.onClose : null;
  // Stack dedup: refuse to open a second modal with the same id
  // when one is already showing. The user gets the existing one
  // (and its focus) — clicking the same help button twice is a
  // no-op rather than stacking two copies.
  if (id) {
    for (let i = 0; i < _modalStack.length; i++) {
      const entry = _modalStack[i];
      if (entry && entry.id === id) {
        // KGO4-017: validate the DOM node is still attached. A stale
        // entry (node removed externally) would silently block re-open.
        if (entry.el && document.contains(entry.el)) return entry.close;
        _modalStack.splice(i, 1);
        break;
      }
    }
  }
  root.classList.add('active');
  const m = el('div', { class: 'modal' });
  // H7-021: dialog semantics. role=dialog + aria-modal=true lets screen
  // readers announce the overlay as a separate dialog context and tells
  // assistive tech the background is inert. aria-labelledby is wired below
  // once the builder has produced its first heading.
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-modal', 'true');
  root.appendChild(m);
  // Remember the currently-focused element so it can be restored on close.
  // Capture this BEFORE running the builder, because the builder typically
  // focuses its primary button (which would otherwise become the "previously
  // focused" element).
  const prevFocus = document.activeElement;
  // PE-007: a modal may supply `onRequestClose` — the Escape handler then
  // asks the OWNER to close (dirty-confirm etc.) instead of closing raw.
  // Assigned after the literal so the entry's base shape (id/close/el,
  // pinned by the H8-003 gate) stays stable.
  const stackEntry = { id, close: null, el: m };
  stackEntry.onRequestClose = (opts && typeof opts.onRequestClose === 'function') ? opts.onRequestClose : null;
  let focusTrapHandler = null;
  const close = () => {
    if (m.parentNode) m.remove();
    if (root.children.length === 0) {
      root.classList.remove('active');
    }
    const idx = _modalStack.indexOf(stackEntry);
    if (idx >= 0) _modalStack.splice(idx, 1);
    if (_modalStack.length > 0) {
      _modalClose = _modalStack[_modalStack.length - 1].close;
    } else if (_modalClose === close) {
      _modalClose = null;
    }
    _reapplyInert();
    // Detach the focus-trap key handler installed below (H7-021).
    if (focusTrapHandler) {
      try { document.removeEventListener('keydown', focusTrapHandler, true); } catch (_) {}
      focusTrapHandler = null;
    }
    // Restore focus to the element that was focused when the
    // modal opened. Falls back to <body> if the original element
    // was removed from the DOM in the meantime (e.g. a settings
    // dialog re-rendered its form).
    try {
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) {
        prevFocus.focus();
      }
    } catch (_) { /* ignore */ }
    // Fire the post-close hook (if any) AFTER focus restoration so
    // a hook that opens another modal (e.g. the next popup in the
    // startup chain) sees the original focus, not the restored one.
    if (onClose) {
      try { onClose(); } catch (_) { /* ignore hook errors */ }
    }
  };
  stackEntry.close = close;
  _modalStack.push(stackEntry);
  _modalClose = close;
  _reapplyInert();
  // H-043 (_5 audit): wrap the builder in try/catch. If it throws, the
  // half-built modal is cleaned up via close() (removes the stack entry,
  // restores inert/focus) so the modal system is never permanently jammed.
  try {
    build(m, close);
  } catch (buildErr) {
    close(); // idempotent cleanup: pop stack, restore inert + focus
    try { window.toast('Modal failed to open: ' + ((buildErr && buildErr.message) || buildErr), 'err', 6000); } catch (_) {}
    return null;
  }

  // H7-021: wire aria-labelledby to the first heading inside the modal (if
  // any) so screen readers announce a name for the dialog. Give the heading
  // a stable id if it doesn't already have one.
  try {
    const heading = m.querySelector('h1,h2,h3');
    if (heading) {
      if (!heading.id) heading.id = 'modal-title-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
      m.setAttribute('aria-labelledby', heading.id);
    }
  } catch (_) { /* best-effort */ }

  // H7-021: focus trap. Tab / Shift-Tab cycle within the modal so the
  // background (which is now aria-hidden via aria-modal) never receives
  // focus. Use a capture-phase listener so we run before any app-level
  // shortcut handler that might also swallow Tab.
  try {
    focusTrapHandler = (e) => {
      if (e.key !== 'Tab') return;
      const focusables = m.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      );
      if (!focusables.length) { e.preventDefault(); m.focus(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !m.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !m.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', focusTrapHandler, true);
    // Move focus into the modal immediately so the background's last-focused
    // control isn't left active behind the overlay.
    const firstFocusable = m.querySelector('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])');
    if (firstFocusable && typeof firstFocusable.focus === 'function') {
      firstFocusable.focus();
    } else {
      m.setAttribute('tabindex', '-1');
      m.focus();
    }
  } catch (_) { /* best-effort: focus trap must never break the open */ }

  return close;
}

// Close the active modal when the user presses Escape. Also auto-focus the
// first primary button so Enter triggers it.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _modalClose) {
    e.preventDefault();
    // PE-007: if the topmost modal intercepts close REQUESTS (e.g. the
    // image editor confirms unsaved edits before actually closing), defer
    // to its hook; modals without a hook close directly.
    const top = _modalStack[_modalStack.length - 1];
    if (top && typeof top.onRequestClose === 'function') top.onRequestClose();
    else if (_modalClose) _modalClose();
  }
});

// KGO7-015: in-flight confirms keyed by title+message. Asking the SAME
// question twice (a double-click on Delete) reuses the open dialog and
// resolves both callers from one answer; asking a DIFFERENT question
// stacks a second dialog, because two distinct questions genuinely need
// two answers.
//
// This deliberately replaces KGO5-025's `showModal({ id: 'async-confirm' })`
// approach, which deduped on a STATIC id: showModal's dedup early-returns
// before wiring the new caller's `onClose`, so the second concurrent
// asyncConfirm() never settled (KGO6-001). Deduping in this function keeps
// the promise contract intact — every caller always settles.
const _asyncConfirmPending = new Map();

function asyncConfirm(message, title = 'Confirm') {
  if (typeof showModal !== 'function') return Promise.resolve(false);
  const dedupKey = JSON.stringify([String(title), String(message)]);
  const inflight = _asyncConfirmPending.get(dedupKey);
  if (inflight) return inflight;
  const p = _buildAsyncConfirm(message, title);
  _asyncConfirmPending.set(dedupKey, p);
  // Clear the slot once settled so the same question can be asked again
  // later. `finally` keeps the resolved value untouched.
  p.then(
    () => { if (_asyncConfirmPending.get(dedupKey) === p) _asyncConfirmPending.delete(dedupKey); },
    () => { if (_asyncConfirmPending.get(dedupKey) === p) _asyncConfirmPending.delete(dedupKey); },
  );
  return p;
}

function _buildAsyncConfirm(message, title) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => {
      if (!resolved) {
        resolved = true;
        resolve(val);
      }
    };
    showModal((m, closeModal) => {
      m.classList.add('confirm-modal');
      m.appendChild(el('h3', { style: 'margin: 0 0 10px;' }, title));
      const pLines = String(message).split('\n');
      for (const line of pLines) {
        if (line.trim()) m.appendChild(el('p', { style: 'margin: 4px 0;' }, line.trim()));
      }
      const confirmBtn = el('button', { class: 'primary', onclick: () => { done(true); closeModal(); } }, 'Confirm');
      const cancelBtn = el('button', { class: 'btn-secondary', onclick: () => { done(false); closeModal(); } }, 'Cancel');
      m.appendChild(el('div', { class: 'footer', style: 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;' }, [cancelBtn, confirmBtn]));
      setTimeout(() => confirmBtn.focus(), 0);
    }, {
      onClose: () => done(false),
      // NOTE: intentionally NO `id:` here — showModal's id dedup discards
      // the new caller's `onClose` (KGO6-001 deadlock). Same-question
      // dedup lives in asyncConfirm() above instead (KGO7-015).
    });
  });
}
if (typeof window !== 'undefined') window.asyncConfirm = asyncConfirm;

// KGO8-001: a non-blocking replacement for window.prompt().
//
// Electron does NOT implement prompt() — it THROWS "prompt() is not
// supported." That killed the danger-zone reset outright: the throw escaped
// the click handler as an unhandled rejection, so the button did nothing at
// all (no toast, no error, still enabled). Any typed-confirmation flow must
// use this instead.
//
// Resolves to the typed string, or null when the user cancels / closes.
// When `expect` is given, the Confirm button stays disabled until the input
// matches it exactly, so the caller never has to re-check the answer.
function asyncPrompt(message, expect = null, title = 'Confirm') {
  if (typeof showModal !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    showModal((m, closeModal) => {
      m.classList.add('confirm-modal');
      m.appendChild(el('h3', { style: 'margin: 0 0 10px;' }, title));
      for (const line of String(message).split('\n')) {
        if (line.trim()) m.appendChild(el('p', { style: 'margin: 4px 0;' }, line.trim()));
      }
      const input = el('input', { type: 'text', style: 'width: 100%; margin: 10px 0 4px;' });
      m.appendChild(input);
      const confirmBtn = el('button', {
        class: 'primary',
        onclick: () => { done(input.value); closeModal(); },
      }, 'Confirm');
      if (expect != null) {
        confirmBtn.disabled = true;
        input.addEventListener('input', () => { confirmBtn.disabled = input.value !== expect; });
      }
      // KGO9-003: Enter must submit in BOTH modes. This listener used to live
      // inside the `if (expect != null)` above, so a free-form prompt could
      // only be committed with the mouse — Enter did nothing and the dialog
      // just sat there. Guarding on `disabled` keeps the typed-confirmation
      // behaviour identical (Enter is inert until the word matches).
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !confirmBtn.disabled) { done(input.value); closeModal(); }
      });
      const cancelBtn = el('button', { class: 'btn-secondary', onclick: () => { done(null); closeModal(); } }, 'Cancel');
      m.appendChild(el('div', { class: 'footer', style: 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;' }, [cancelBtn, confirmBtn]));
      setTimeout(() => input.focus(), 0);
    }, { onClose: () => done(null) });
  });
}
if (typeof window !== 'undefined') window.asyncPrompt = asyncPrompt;

