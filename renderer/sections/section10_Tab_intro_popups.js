// renderer/sections/section10_Tab_intro_popups.js
// Extracted: Tab intro popups

// ----------------- Tab intro popups -----------------
// A short, friendly "what's this tab about" popup shown the first
// time the user opens each tab. Gated by the popup policy in
// state.popupPolicy (configured in ⚙ Settings → Popups). The popup
// is rendered with the same showModal() primitive so it gets the
// full Esc/click-outside/stack behaviour. The default text is short
// on purpose: the detailed field-level help is still available via
// the `?` icons on every input.

// _pendingTabIntro / _introStartupChainOpen coordinate deferring the
// intro while the startup popup chain is running (welcome, first-time
// setup, optional add-ons auto-open), so the intro doesn't pop up on
// top of them. While any of these is open we stash the requested intro
// tab in _pendingTabIntro instead of showing it. As soon as the chain
// drains, we fire the pending intro IF the requested tab is still the
// active one — switching tabs while the chain is open cancels the
// pending intro.
var _pendingTabIntro = null;
var _introStartupChainOpen = 0;
function _enterIntroStartupChain() {
  _introStartupChainOpen++;
}
function _maybeFirePendingTabIntro() {
  if (_introStartupChainOpen > 0) return; // chain still running
  const tabName = _pendingTabIntro;
  _pendingTabIntro = null;
  if (!tabName) return;
  // Only fire if the user is still on the same tab. If they
  // switched to another tab while the welcome popup was open,
  // they don't want a popup for the tab they navigated AWAY from.
  if (typeof state !== 'undefined' && state.currentTab === tabName) {
    // Defer one tick so the modal stack settles (the chain popup's
    // own focus-restore runs before this fires).
    setTimeout(() => {
      try { maybeShowTabIntro(tabName); } catch (_) { /* ignore */ }
    }, 0);
  }
}
function _exitIntroStartupChain() {
  if (_introStartupChainOpen > 0) _introStartupChainOpen--;
  _maybeFirePendingTabIntro();
}

function maybeShowTabIntro(tabName) {
  const intros = {
    image:  '🖼 Image tab — describe what you want to generate in the prompt, tweak the model + aspect + variants, then click Generate. Enable the Upscale / Optimize toggle to run a local pipeline after the API returns.',
    speech: '🗣 Speech tab — type or paste the text, pick a voice, then click Generate. Use the ▶ button next to each voice to hear a quick preview. The output is an MP3 (or your chosen format) saved to the folder browser on the right.',
    music:  '🎵 Music tab — describe the music you want (genre, mood, instruments, tempo). Toggle "Instrumental only" to skip vocals. Each click of Generate produces one short track and writes it to the folder browser.',
    video:  '🎬 Video tab — describe the short video you want, pick the model + resolution + duration, then click Generate. Note: Token Plan keys allow only 3 video generations per week; pay-as-you-go (PAYG) keys are billed per video with no weekly cap. Each video takes a few minutes to render.',
  };
  const text = intros[tabName];
  if (!text) return;
  openGatedPopup('tab-intro:' + tabName, (m, close, markSeen) => {
    m.classList.add('tab-intro-modal');
    const titles = { image: 'Image', speech: 'Speech', music: 'Music', video: 'Video' };
    m.appendChild(el('h2', {}, '👋 Welcome to the ' + (titles[tabName] || tabName) + ' tab'));
    m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 13px; line-height: 1.55;' }, text));
    m.appendChild(el('p', { style: 'color: var(--fg-3); font-size: 11px;' },
      'You can disable these intro popups in ⚙ Settings → Popups.'));
    m.appendChild(el('div', { class: 'footer' }, [
      el('button', { class: 'primary', onclick: () => { markSeen(); close(); } }, 'Got it'),
    ]));
    setTimeout(() => { m.querySelector('button.primary')?.focus(); }, 0);
  });
}

// Update the colored status dots on the tab buttons. The rules are:
//   - genStatus === 'running'  → red dot
//   - genStatus === 'done' and tab !== currentTab → green dot
//   - genStatus === 'done' and tab === currentTab → no dot (the user has
//     effectively "seen" the result by switching into the tab)
//   - genStatus === 'idle'     → no dot
function refreshTabStatusDots() {
  for (const tabKey of ['image', 'speech', 'music', 'video']) {
    const t = $(`.tab[data-tab="${tabKey}"]`);
    if (!t) continue;
    // Remove any prior dot
    t.classList.remove('tab-dot-red', 'tab-dot-green');
    const st = state.genStatus[tabKey] || 'idle';
    if (st === 'running') t.classList.add('tab-dot-red');
    else if (st === 'done' && state.currentTab !== tabKey) t.classList.add('tab-dot-green');
  }
  refreshTabEtas();
}

// Per-tab ETA timer. While a generation is running, show a small mm:ss
// countdown next to the tab label, based on the average time of the last
// successful generation in that tab. For batch runs (variants, --n > 1),
// the countdown reflects the TOTAL remaining time for all items in the
// queue (current item + future items). As each item completes, the
// running average is updated and the ETA is recomputed on the next
// 1-second tick. The countdown is an estimate, not a guarantee — but it
// gives the user a sense of how long the current call will still take.
function refreshTabEtas() {
  for (const tabKey of ['image', 'speech', 'music', 'video']) {
    const t = $(`.tab[data-tab="${tabKey}"]`);
    if (!t) continue;
    // Lazily create the eta span the first time we need it.
    let eta = t.querySelector('.tab-eta');
    if (!eta) {
      eta = el('span', { class: 'tab-eta' }, '');
      t.appendChild(eta);
    }
    eta.textContent = _formatTabEta(tabKey);
  }
}
function _formatTabEta(tabKey) {
  const status = state.genStatus[tabKey];
  if (status !== 'running') return '';
  const start = state.genStartMs && state.genStartMs[tabKey];
  if (!start) return '...';
  // Use the running average if we have one; otherwise a sensible per-tab
  // default so the user always sees an estimate even on the very first
  // generation. (If they only see "...", the timer looks broken.)
  let avg = (state.genAvgSec && state.genAvgSec[tabKey]) || 0;
  if (!avg) {
    const defaults = { image: 35, speech: 12, music: 75, video: 90 };
    avg = defaults[tabKey] || 30;
  }
  // Total queue size for the current run (variants × n, where n is the
  // --n count). When the gen handler kicks off, it sets
  // state.genQueueSize[tabKey] and increments state.genQueueDone[tabKey]
  // after each completed item.
  const queueSize = Math.max(1, (state.genQueueSize && state.genQueueSize[tabKey]) || 1);
  const queueDone = Math.max(0, (state.genQueueDone && state.genQueueDone[tabKey]) || 0);
  const itemsLeft = Math.max(1, queueSize - queueDone);
  // How much of the current item is still pending. Inferred from the
  // total run-elapsed MINUS the expected cost of the items already
  // done, so the previous items' cost isn't smudged into the current
  // item.
  const runElapsed = Math.max(0, (Date.now() - start) / 1000);
  // Never let the predicted per-item avg dip below the actual
  // run-elapsed. When a generation runs longer than the running avg
  // (common for video: the default is 90s, but actual can be 60-300s),
  // bump the effective avg up to whatever we've actually spent, with a
  // small buffer, so the ETA keeps ticking instead of stalling at 0:00.
  const effectiveAvg = Math.max(avg, runElapsed + 5);
  const currentItemElapsed = Math.max(0, Math.min(effectiveAvg, runElapsed - (queueDone * avg)));
  const currentItemRemaining = Math.max(0, effectiveAvg - currentItemElapsed);
  // Future items in the current run. Use the effective avg for them
  // too, so the predicted wall-clock future time also adapts to reality
  // — if the first item took longer than the historic avg, the future
  // ones probably will too.
  const futureItems = Math.max(0, itemsLeft - 1);
  const futureTime = futureItems * effectiveAvg;
  // Also include the BatchGen queue (if the user kicked off a batch
  // from the same tab after this single Generate click).
  // state.batchQueueLeft[tabKey] is the number of items still to
  // process; the batch runner updates it on every item. If unset (no
  // batch running), defaults to 0 — no contribution.
  const batchLeft = Math.max(0, (state.batchQueueLeft && state.batchQueueLeft[tabKey]) || 0);
  const batchTime = batchLeft * effectiveAvg;
  const totalRemaining = currentItemRemaining + futureTime + batchTime;
  const remaining = Math.max(0, Math.round(totalRemaining));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `- ${m}:${String(s).padStart(2, '0')}`;
}
// Update the ETA once a second while a tab is running. Cheap text update —
// the tab has only 4 instances.
let _etaTimer = null;
function ensureEtaTimer() {
  if (_etaTimer) return;
  _etaTimer = setInterval(() => {
    let anyRunning = false;
    for (const k of ['image', 'speech', 'music', 'video']) {
      if (state.genStatus[k] === 'running') { anyRunning = true; break; }
    }
    if (!anyRunning) {
      clearInterval(_etaTimer);
      _etaTimer = null;
      // Clear the ETA labels one last time.
      for (const k of ['image', 'speech', 'music', 'video']) {
        const t = $(`.tab[data-tab="${k}"]`);
        if (!t) continue;
        const eta = t.querySelector('.tab-eta');
        if (eta) eta.textContent = '';
      }
      // Also clear the "all types" ETA next to the BatGen All Types
      // button (it only shows while a batch is in flight; the helper
      // hides itself when no batch is active).
      if (typeof _refreshAllBatchEta === 'function') _refreshAllBatchEta();
      return;
    }
    refreshTabEtas();
    // Tick the "all types" ETA every second too.
    if (typeof _refreshAllBatchEta === 'function') _refreshAllBatchEta();
  }, 1000);
}

