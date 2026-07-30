// renderer/sections/section18_Startup_popup.js
// Startup popup

// ----------------- Startup popup -----------------
// Shown on every fresh launch. Single OK button to dismiss.
//
// Honours the user-configurable popup policy (state.popupPolicy):
//   'once-fresh'   — default. Show on every fresh launch until the user
//                    dismisses it; once dismissed, never show again.
//   'per-session'  — Show once per app start.
//   'never'        — Skip entirely.
//   'always'       — Always show (ignoring any prior dismissal).
// The popup id is 'startup'. openGatedPopup() is the central dispatcher;
// new tab-triggered popups should reuse it with their own stable id.
function shouldShowPopup(id) {
  // Default popup policy is 'once-fresh' (show until dismissed).
  const policy = state.popupPolicy || 'once-fresh';
  if (policy === 'always') return true;
  if (policy === 'never') return false;
  if (policy === 'per-session') {
    return !_popupSeenThisSession.has(id);
  }
  // 'once-fresh' (default): persist dismissal in state.seenPopups so
  // a returning user never sees the popup again unless they reset
  // the seen set from ⚙ Settings → Popups.
  return !(state.seenPopups && state.seenPopups[id]);
}
function markPopupSeen(id) {
  if (!id) return;
  _popupSeenThisSession.add(id);
  if (!state.seenPopups || typeof state.seenPopups !== 'object') state.seenPopups = {};
  state.seenPopups[id] = new Date().toISOString();
  scheduleStateSave();
}
function resetPopupSeen() {
  // Wipe both the persistent record AND the per-session set so a
  // "Reset all popup history" action in ⚙ Settings immediately
  // re-triggers every popup on the very next trigger.
  state.seenPopups = {};
  _popupSeenThisSession.clear();
  scheduleStateSave();
}
function openGatedPopup(id, build, opts) {
  // Centralised dispatcher: gates a popup behind the user's chosen
  // popup policy, then opens it via the standard showModal() so it
  // gets all the same Esc/click-outside/stack behaviour as every
  // other dialog. Callers wrap the popup body in `build(m, close,
  // markSeen)` and MUST call `markSeen()` exactly once (typically
  // from every close path) so the 'once-fresh' / 'per-session'
  // policies don't re-fire it.
  //
  // `opts` is forwarded to showModal so callers can attach an
  // `onClose` hook (e.g. the startup-popup chain uses it to
  // decrement a counter and fire the pending tab-intro popup).
  // `opts.force` bypasses the policy gate for popups that are NOT
  // informational nags but required flows (the first-time setup form).
  if (!(opts && opts.force) && !shouldShowPopup(id)) {
    // Log the suppression too — when the user reports "I never see the welcome
    // popup", the breadcrumb shows the policy decision.
    if (typeof window.logAction === 'function') {
      window.logAction('popup', 'suppressed-by-policy', {
        id,
        policy: state.popupPolicy || '(unset)',
      });
    }
    // Even when the popup is suppressed by policy, fire the caller's onClose
    // hook so any bookkeeping it set up BEFORE calling us is balanced. The
    // startup-popup chain increments _introStartupChainOpen before calling
    // openGatedPopup and relies on onClose to decrement it; without this, a
    // suppressed startup/first-time popup leaves the counter stuck > 0 and
    // every later tab-intro popup is deferred forever.
    if (opts && typeof opts.onClose === 'function') {
      try { opts.onClose(); }
      catch (err) {
        // A popup's onClose hook is part of the startup chain bookkeeping; if
        // it throws (e.g. a buggy listener), log it rather than swallowing it
        // and ending up with the chain counter stuck — every later gated popup
        // would get deferred forever.
        if (typeof window.logError === 'function') {
          window.logError('popup-onClose', `renderer/sections/section18_Startup_popup.js:openGatedPopup:${id}`, err);
        }
      }
    }
    return null;
  }
  if (typeof window.logAction === 'function') {
    window.logAction('popup', 'show', { id, forced: !!(opts && opts.force) });
  }
  const markSeen = () => {
    if (typeof window.logAction === 'function') {
      window.logAction('popup', 'mark-seen', { id });
    }
    markPopupSeen(id);
  };
  return showModal((m, close) => {
    build(m, close, markSeen);
  }, Object.assign({ id: id }, opts || {}));
}
function showStartupPopup(opts) {
  // Enter the startup-popup chain so showTab() defers any
  // tab-intro popup until the user has dismissed welcome +
  // (optional) first-time-setup + (optional) optional-addons.
  if (typeof _enterIntroStartupChain === 'function') _enterIntroStartupChain();
  // Exit the chain whenever this popup closes (any path: OK, Esc,
  // click-outside). If a follow-up popup (setup / addons) is about
  // to open, it will re-enter the chain itself, so the counter
  // stays balanced.
  const _exit = () => { if (typeof _exitIntroStartupChain === 'function') _exitIntroStartupChain(); };
  
  openGatedPopup('startup', (m, close, markSeen) => {
    m.classList.add('startup-modal');
    // Issue 0: show the project logo (logo.webp lives at the app root,
    // one level above renderer/) at the very top of the welcome window.
    // The relative path resolves against renderer/index.html in both dev
    // and the packaged asar (logo.webp is listed in package.json "files").
    const logo = el('img', {
      class: 'startup-logo',
      src: '../logo.webp',
      alt: 'MiniMax Asset Tool logo',
      draggable: 'false',
    });
    // Hide gracefully if the asset is missing (e.g. a stripped build) so the
    // popup never shows a broken-image glyph.
    logo.addEventListener('error', () => { logo.style.display = 'none'; });
    m.appendChild(logo);
    m.appendChild(el('h2', { class: 'startup-title' }, TOOL_NAME));
    const versionEl = el('div', { class: 'startup-version' }, BUILD_VERSION);
    const versionWrapper = el('div', { class: 'startup-version-wrapper' }, [versionEl]);
    m.appendChild(versionWrapper);
    if (window.api && typeof window.api.getAppVersion === 'function') {
      window.api.getAppVersion().then((info) => {
        if (info && info.version) versionEl.textContent = 'v' + info.version;
      }).catch(() => {});
    }
    const infoParagraphs = String(TOOL_INFO).split('\n\n');
    for (const pText of infoParagraphs) {
      if (pText.trim()) m.appendChild(el('p', { class: 'startup-info' }, pText.trim()));
    }
    const shortcuts = el('div', { class: 'shortcuts-box' });
    shortcuts.appendChild(el('h4', {}, '⌨ Keyboard shortcuts'));
    // KGO-022 fix: provide a hardcoded fallback so the list is never empty
    // if GlobalShortcutRegistry fails to load.
    const FALLBACK_SHORTCUTS = [
      ['Ctrl+Enter', 'Generate on the active tab'],
      ['Ctrl+1 / 2 / 3 / 4 / 5', 'Switch to Image / Speech / Music / Video / Other APIs'],
      ['Ctrl+B', 'Open BatchGen for the active tab'],
      ['Ctrl+F', 'Focus the file-browser filter'],
      ['Ctrl+P', 'Open or focus the Image Pipeline'],
      ['Ctrl+E', 'Open or focus the Image Editor'],
    ];
    const list = (window.GlobalShortcutRegistry && typeof window.GlobalShortcutRegistry.getDocumentationList === 'function')
      ? window.GlobalShortcutRegistry.getDocumentationList()
      : FALLBACK_SHORTCUTS;
    list.push(['← / →', 'When the image overlay is open: step to the previous / next image']);
    for (const [keys, desc] of list) {
      shortcuts.appendChild(el('div', { class: 'shortcut-row' }, [
        el('kbd', {}, keys),
        el('span', {}, desc),
      ]));
    }
    shortcuts.appendChild(el('div', { style: 'font-size: 11px; color: var(--fg-3); margin-top: 6px; font-style: italic;' }, 'Note: Image Editor has its own shortcuts; press ? inside the editor for details.'));
    m.appendChild(shortcuts);

    m.appendChild(el('div', { class: 'footer', style: 'display: flex; justify-content: flex-end; align-items: center; width: 100%;' }, [
      el('button', { class: 'primary', onclick: () => {
        markSeen();
        close();
        if (!state.config.hasApiKey || !state.config.output_dir) {
          openFirstTimeSetup();
        } else if (!state.realesrganFirstRunDismissed) {
          openOptionalAddons({ autoOpened: true }).catch(() => {});
        }
      } }, 'OK'),
    ]));
    // OK on Enter for convenience
    setTimeout(() => { m.querySelector('button.primary')?.focus(); }, 0);
    // Welcome popup always opens on launch (force: true) so new users see
    // setup & add-ons chain; tab-intros remain gated by popupPolicy.
  }, Object.assign({ force: true, onClose: () => { markSeen(); _exit(); } }, opts || {}));
}
