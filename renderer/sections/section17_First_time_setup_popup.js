// renderer/sections/section17_First_time_setup_popup.js
// Extracted: First-time setup popup

// ----------------- First-time setup popup -----------------
// Guided form for the two required settings (API key + output
// directory). Reachable in two ways:
//   1) Manually from ⚙ Settings → Account → "Run first-time
//      setup" (see buildSettingsAccountPane in section03).
//   2) Via the auto-open path inside openGatedPopup() below,
//      which respects the user's popup policy (state.popupPolicy).
//
// The "Save" button validates that both required fields are
// present and writes the config before closing. "Skip for now"
// closes without saving — the user can fill the values in later
// from ⚙ Settings.
//
// The popup is policy-gated like every other informational dialog.
// The user has an explicit "default off" preference in ⚙ Settings
// → Popups, so forcing an onboarding modal on every launch with a
// fresh install would contradict that preference. A user who
// skipped first-time setup but wants it back can re-open it from
// ⚙ Settings → "Run first-time setup" (which passes `force` to
// bypass the policy).
function openFirstTimeSetup(opts) {
  // Enter the startup-popup chain so the pending tab-intro
  // popup stays deferred while the first-time setup form is open.
  if (typeof _enterIntroStartupChain === 'function') _enterIntroStartupChain();
  const _exit = () => { if (typeof _exitIntroStartupChain === 'function') _exitIntroStartupChain(); };
  // `opts.force` — when the user explicitly invokes first-time
  // setup from ⚙ Settings (the "Run first-time setup" button),
  // bypass the popup policy. The user just asked for this
  // dialog; suppressing it would be wrong. The auto-open path
  // (e.g. the showStartupPopup chain) does NOT pass `force` and
  // is therefore subject to the popup policy, so a user with
  // 'never' is not nagged on every fresh install.
  const force = !!(opts && opts.force);
  // No `force: true` here — the popup policy is honoured. With
  // the new default of 'never' and a fresh install, the
  // first-time setup is silent; the user opts in from Settings.
  // The optional-addons follow-up (in onClose below) is also
  // policy-gated and additionally requires the binaries to be
  // missing, so it never nags a configured user either.
  openGatedPopup('first-time-setup', (m, close, markSeen) => {
    m.classList.add('first-time-setup-modal');
    m.appendChild(el('h2', {}, 'First-time setup'));
    // Plain-language description. Avoids jargon ("endpoint",
    // "config") and tells the user exactly what each value is
    // for and where it ends up.
    m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
      'Welcome! The tool needs two pieces of information to work: your MiniMax API key (so the tool can talk to the model) and the folder where you want generated files to be saved. Both can be changed later in ⚙ Settings. Click the "?" next to any field for a longer explanation.'));

    const cfg = { ...state.config };

    // API key. We use the showRevealableKey helper so the first-time
    // setup behaves the same as the regular ⚙ Settings popup: the
    // real key is hidden behind a "Show" toggle by default, but
    // the user can reveal it (or type a new one) with one click.
    // Without the toggle, the placeholder is a generic "sk-cp-xxx…"
    // so the user knows what shape to paste, but the value field
    // never contains the real key unless the user explicitly asked
    // for it. See the comment on showRevealableKey for the full
    // security rationale.
    //
    // Both Token Plan keys (sk-cp-…) and pay-as-you-go (PAYG) keys
    // are accepted. The placeholder shows the Token Plan shape as a
    // hint but the input is plain text — we do not enforce a prefix.
    const apiRow = showRevealableKey(cfg.api_key || '', {
      placeholder: 'sk-cp-xxxxxxxx  (or your PAYG key)',
      label: 'API key (MiniMax Token Plan or PAYG)',
    });
    // Help icon for the API-key field — the same one used in the
    // Settings dialog so the user gets a consistent explanation
    // regardless of which entry point they came from.
    try {
      const lbl = apiRow.row.querySelector('label');
      if (lbl) lbl.appendChild(helpButton('settings.apiKey'));
    } catch (_) {}
    m.appendChild(apiRow.row);
    const apiInput = apiRow.input;

    // Output directory — text input + Browse button that opens the
    // standard Windows folder-selection dialog (the same one the
    // ⚙ Settings popup uses).
    const outInput = el('input', { type: 'text', value: cfg.output_dir || '', placeholder: 'C:\\Users\\me\\Pictures\\MiniMax-Assets' });
    let _outDirGrantId = null;
    const browse = el('button', { class: 'btn-mini', type: 'button' }, 'Browse…');
    browse.addEventListener('click', async () => {
      const r = await window.api.pickFolderFull({ purpose: 'config-output' });
      if (r && r.ok && r.path) { outInput.value = r.path; _outDirGrantId = r.grantId || null; }
    });
    m.appendChild(el('div', { class: 'row' }, [
      el('label', {}, ['Output directory', helpButton('settings.outputDir')]),
      el('div', { class: 'combo' }, [outInput, browse]),
    ]));

    // Region (already has a default of 'global' but show it so the
    // user can confirm / change it on first launch).
    const regInput = el('select', {});
    for (const r of ['global', 'cn']) regInput.appendChild(el('option', { value: r }, r));
    regInput.value = cfg.region || 'global';
    m.appendChild(el('div', { class: 'row' }, [el('label', {}, ['Region', helpButton('settings.region')]), regInput]));

    const save = el('button', { class: 'primary' }, 'Save');
    const skip = el('button', { onclick: () => { markSeen(); close(); } }, 'Skip for now');
    save.addEventListener('click', async () => {
      // Use the helper's getValue() (not apiInput.value) so we
      // never accidentally persist the masked version. The helper
      // returns the real current value regardless of whether the
      // field is currently shown or hidden.
      const api_key = apiRow.getValue().trim();
      const output_dir = outInput.value.trim();
      const region = regInput.value || 'global';
      if (!api_key) { toast('API key is required. Paste it into the API key field above, or click "Skip for now" and set it later in ⚙ Settings.', 'err', 5000); return; }
      if (!output_dir) { toast('Output directory is required. Pick a folder with the Browse… button, or click "Skip for now".', 'err', 5000); return; }
      // Capture the pre-save output_dir BEFORE reassigning state.config
      // so the change-detection below compares the right values. Kept as
      // a local const (NOT a property of state) so the post-await block
      // can read the snapshot regardless of what state.config looks
      // like by then.
      const oldOut = (state.config && state.config.output_dir) || '';
      const newCfg = { ...state.config, api_key, output_dir, region };
      // R1.2a: pass the grant minted by the Browse button so config:set
      // can authorize the output_dir change. Built in a separate statement
      // to keep the saveBtn-handler body-extraction regex (used by the
      // v1129 A1 tests) from truncating on an inline object literal.
      const grants = _outDirGrantId ? { output_dir: _outDirGrantId } : undefined;
      const payload = { cfg: newCfg, grants };
      const result = await window.api.setConfig(payload);
      // config:set returns `{ ok, config, error }`. Branch on ok and
      // surface the real error to the user instead of falsely reporting
      // success (a write failure left state.config pointing at the
      // previous values, which then crashed refreshQuota).
      if (!result || result.ok !== true) {
        const msg = (result && result.error) || 'Could not write config.txt (disk full, read-only, or permission denied).';
        toast('Save failed: ' + msg, 'err', 8000);
        // KGO7-003: adoptConfig preserves a session-only API key.
        if (result && result.config) {
          state.config = window.adoptConfig ? window.adoptConfig(result.config) : result.config;
        }
        return;
      }
      state.config = window.adoptConfig ? window.adoptConfig(result.config) : result.config;
      toast('Settings saved.', 'ok');
      markSeen();
      close();
      // Reload anything that depends on config (quota + the file
      // browser, so the freshly-set output_dir is shown).
      refreshQuota();
      // Same behaviour as the Settings dialog — when first-time-setup
      // just wrote an output_dir, point the file browser at it (and
      // every per-tab folder) instead of leaving the user in the
      // previous folder. `oldOut` was captured at the top of the
      // handler from the pre-save state.config (the local `oldOut`
      // const above) so the comparison here is meaningful.
      const newOut = (result.config && result.config.output_dir) || '';
      if (newOut !== oldOut) {
        state.fbDir = newOut;
        if (state.fbDirs) for (const k of Object.keys(state.fbDirs)) state.fbDirs[k] = newOut;
        scheduleStateSave();
      }
      refreshBrowser();
    });
    m.appendChild(el('div', { class: 'footer' }, [skip, save]));

    // Focus the first empty field, then the second — saves the user a
    // click when both are blank.
    setTimeout(() => {
      if (!cfg.api_key) apiInput.focus();
      else if (!cfg.output_dir) outInput.focus();
      else apiInput.focus();
    }, 0);
    // `force` is forwarded to openGatedPopup — see comment at
    // the top of this function. The auto-open path (no `force`)
    // honours the popup policy; the manual open from ⚙ Settings
    // passes `force: true` to bypass it.
  }, {
    force,
    onClose: () => {
      _exit();
      // The optional add-ons follow-up is fired AFTER the
      // first-time-setup modal closes so the two modals don't
      // stack on top of each other. It is intentionally NOT
      // gated on "config was just set on this launch" — a user
      // who already had a valid config but a fresh install (no
      // ./bin/) should still see it on first launch.
      if (!state.realesrganFirstRunDismissed) {
        openOptionalAddons({ autoOpened: true }).catch(() => {});
      }
    },
  });
}

