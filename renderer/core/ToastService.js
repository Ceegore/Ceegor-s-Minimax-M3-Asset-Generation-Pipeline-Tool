// renderer/core/ToastService.js
// Central toast notification. Hosted in #toast-root (see index.html).

const DEFAULT_TIMEOUT_MS = 4000;

function show(message, opts) {
  opts = opts || {};
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast' + (opts.type ? ' toast-' + opts.type : '');
  el.textContent = message;
  // `btn` is declared up here (null when no action button is present)
  // so the dismiss-click handler below always has a defined value to
  // compare against — without this, a toast with no action button
  // would throw a ReferenceError when clicked.
  let btn = null;
  if (opts.actionLabel && typeof opts.onAction === 'function') {
    btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => {
      try { opts.onAction(); } catch (_) {}
      el.remove();
    });
    el.appendChild(btn);
  }
  root.appendChild(el);
  const t = setTimeout(() => el.remove(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  el.addEventListener('click', (e) => {
    if (btn && e.target === btn) return;
    clearTimeout(t);
    el.remove();
  });
}

window.ToastService = { show };
