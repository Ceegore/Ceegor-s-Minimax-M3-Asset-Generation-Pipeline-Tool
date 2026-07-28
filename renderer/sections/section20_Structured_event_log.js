// renderer/sections/section20_Structured_event_log.js
// Structured event log

// ----------------- Structured event log -----------------
// The log pane is a list of structured events (one per row) instead of the old
// raw-text <pre>. Each event has:
//   { id, ts, category, headline, details, result, expanded, raw }
// and is rendered as a row with time stamp + category icon + result icon +
// headline. The user can multi-select rows with the mouse (click / ctrl-click /
// shift-click), expand a row to see its details, and copy the selected events
// (or all) to the clipboard in a plain-text format that includes both the
// headline and the expanded details — so pasting into a support ticket gives
// the helper every piece of information the renderer has.
// LogCategories lives in renderer/services/LogCategories.js


// Add a new event to the log. Returns the new event id so the
// caller can reference it later (e.g. for a "background
// generation complete" event that needs to update a prior
// "background generation started" event).
//
// Args:
//   opts.headline  : string, short one-line description (required)
//   opts.category  : string, one of LOG_CATEGORIES keys (default 'info')
//   opts.details   : string | string[] | null, extra lines shown
//                    when the row is expanded. Strings are split
//                    on \n into multiple lines; null is no details.
//   opts.result    : 'ok' | 'err' | null (default null). Drives the
//                    trailing ✅ / ❌ icon.
//   opts.ts        : Date | null (default: now). Pass a custom

function toast(msg, kind = 'info', ms = 3000) {
  const root = $('#toast-root');
  const t = el('div', { class: 'toast ' + (kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : '') }, msg);
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; }, ms - 300);
  setTimeout(() => t.remove(), ms);
}

// "What's new" toast: fires the first time the user launches a build
// whose package.json version is newer than the one they last saw. The
// seen-flag is per-version, so each upgrade surfaces its own changelog.
// The user dismisses it with the X button; it won't show again until the
// next version bump.
async function maybeShowWhatsNewToast() {
  try {
    const meta = await window.api.getAppVersion();
    if (!meta || !meta.version) return;
    // KGO4-007 fix: read from the global `state` object directly (not
    // `state.state` which doesn't exist) and pass the FULL state to
    // stateSet so no fields are wiped.
    const seen = state.lastSeenVersion || '';
    if (seen === meta.version) return;
    // KGO5-020: skip on fresh install (no prior version seen AND no
    // meaningful prior state). A fresh user has nothing "new" to see.
    // KGO6-010: the real field is `jobsSnapshot` (not `jobsArchive`).
    const isFreshInstall = !seen && !(Array.isArray(state.jobsSnapshot) && state.jobsSnapshot.length) && !(state.config && state.config.styles && state.config.styles.length);
    if (isFreshInstall) {
      // Mark as seen so it doesn't fire on the next launch either.
      state.lastSeenVersion = meta.version;
      try { await window.api.stateSet(state); } catch (_) {}
      return;
    }
    const headline = `v${meta.version} is here`;
    const items = [
      'Generate images, speech, music, and video from text prompts',
      'Automated asset pipeline: upscale, remove background, crop, resize, convert',
      'In-app pixel editor with inpainting and heal tools',
      'Batch generation and reusable style presets',
      'Audio cutter with auto-silence-trim',
    ];
    showWhatsNewToast(headline, items, async () => {
      // Persist "I've seen this version" so the toast doesn't
      // fire again on the next launch of the same build.
      try {
        state.lastSeenVersion = meta.version;
        await window.api.stateSet(state);
      } catch (_) { /* non-fatal */ }
    });
  } catch (_) { /* non-fatal */ }
}

function showWhatsNewToast(headline, items, onDismiss) {
  const root = $('#toast-root');
  // The toast is a compact card (single column, ~380px wide — see styles.css
  // .whats-new-toast) with a header row (X button) + the headline + a collapsed
  // bullet list. Clicking the headline expands the bullets. The 380px width +
  // 15px headline font keep the headline readable on smaller windows.
  const t = el('div', { class: 'whats-new-toast' });
  const header = el('div', { class: 'whats-new-header' });
  const h = el('span', { class: 'whats-new-headline' }, headline);
  h.title = 'Click to expand';
  const x = el('button', { class: 'btn-mini whats-new-x', type: 'button' }, '×');
  header.append(h, x);
  t.appendChild(header);
  const list = el('ul', { class: 'whats-new-list' });
  for (const item of items) list.appendChild(el('li', {}, item));
  t.appendChild(list);
  // Click anywhere on the toast body to expand. Click X to
  // dismiss.
  h.addEventListener('click', () => { t.classList.toggle('expanded'); });
  t.addEventListener('click', (e) => { if (e.target === t) t.classList.toggle('expanded'); });
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    t.style.transition = 'opacity 200ms ease, transform 200ms ease';
    t.style.opacity = '0';
    t.style.transform = 'translateY(-8px)';
    setTimeout(() => { t.remove(); if (onDismiss) onDismiss(); }, 220);
  });
  root.appendChild(t);
  // KGO5-020: auto-dismiss after 15s so it doesn't block the UI forever.
  // The user can still click X to dismiss early.
  // KGO6-009: call onDismiss on auto-dismiss too so lastSeenVersion is
  // persisted and the toast doesn't re-fire on every launch.
  setTimeout(() => {
    if (t.parentNode) {
      t.style.transition = 'opacity 200ms ease, transform 200ms ease';
      t.style.opacity = '0';
      t.style.transform = 'translateY(-8px)';
      setTimeout(() => { t.remove(); if (onDismiss) onDismiss(); }, 220);
    }
  }, 15000);
}

