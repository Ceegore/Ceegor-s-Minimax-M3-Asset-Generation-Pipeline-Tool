// renderer/sections/section15_Optional_add_ons_popup__unified_.js
// Extracted: Optional add-ons popup (unified)

// ----------------- Optional add-ons popup (unified) -----------------
// The single place where the user installs every optional component
// the tool supports: Real-ESRGAN upscaler, isnetbg binary, and the
// IS-Net ONNX model. Designed to be shown both as a first-run
// prompt (when nothing is installed) and as a re-openable manager
// from ⚙ Settings (the "Re-open add-ons" link in the Upscale
// Settings section re-invokes it).
//
// Per-component install options:
//   1. "Download" (Real-ESRGAN only) — fixed GitHub URL in main.js.
//      Streams progress via the existing realesrganDownload IPC.
//   2. "Open download page" (Real-ESRGAN + model) — opens the
//      upstream release page / HuggingFace mirror in the user's
//      default browser. The user then downloads the file
//      themselves and uses the file-picker. This is the universal
//      "no auto-download breakage" path.
//   3. "Pick file…" (all three) — file-picker copies the picked
//      file into ./bin/ (or ./bin/models/) under the name the
//      wrapper probes for. This is the universal fallback for
//      when neither auto-download nor the upstream URL is
//      available (e.g. the user built the isnetbg binary from
//      the C# reference in the README).
//
// A single "Re-detect" button at the bottom re-probes both
// Real-ESRGAN and isnetbg so the user sees the status reflect
// their latest install attempt. The popup itself can stay open
// across multiple install attempts (it doesn't auto-close on
// success) so the user can install all three components in one
// sitting.
async function openOptionalAddons({ autoOpened = false, force = false } = {}) {
  if (typeof window.logAction === 'function') {
    window.logAction('install', 'open-addons', { autoOpened, force });
  }
  // Probe both backends BEFORE opening the modal. If everything
  // is already installed (e.g. the developer pre-bundled the
  // files in ./bin/ before building the portable .exe), skip the
  // popup entirely on first run — the same "don't nag" logic the
  // previous Real-ESRGAN-only popup had.
  //
  // Enter the startup-popup chain ONLY when this is the first-run
  // auto-open from the welcome / first-time-setup chain. Manual
  // re-opens from ⚙ Settings are not part of that chain, so they
  // must not block the pending tab-intro popup (which was deferred
  // by showTab() on launch). The enter + exit is bracketed around
  // showModal() below so early-return paths (already-installed,
  // popup-policy-never) stay out of the chain.
  const probeAll = async () => {
    let reSt = null, isSt = null;
    try { reSt = await window.api.realesrganAvailable(); } catch (_) {}
    try { isSt = await window.api.isnetbgAvailable(); } catch (_) {}
    return { reSt, isSt };
  };
  // If this is the first-run auto-open, AND everything is
  // installed, AND the user hasn't explicitly opened the popup
  // via the ⚙ Settings link, silently dismiss.
  if (autoOpened) {
    if (!force && !shouldShowPopup('optional-addons')) return;
    const { reSt, isSt } = await probeAll();
    const reOk = reSt && reSt.available;
    const isOk = isSt && isSt.available && isSt.modelPresent;
    if (reOk && isOk) {
      state.realesrganFirstRunDismissed = true;
      scheduleStateSave();
      return;
    }
  }

  // We're committed to opening the modal — bracket the chain
  // counter around it so the pending tab-intro popup stays
  // deferred until the user dismisses this dialog.
  if (autoOpened && typeof _enterIntroStartupChain === 'function') _enterIntroStartupChain();
  const _exit = () => { if (typeof _exitIntroStartupChain === 'function') _exitIntroStartupChain(); };

  showModal((m, close) => {
    m.classList.add('optional-addons-modal');
    m.appendChild(el('h2', {}, '🧩 Optional add-ons'));
    m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
      'The tool ships with built-in defaults that work without any extra software. The components below are optional quality upgrades — install them if you want sharper upscale, transparent backgrounds, or both. You can re-open this popup any time from ⚙ Settings → Image upscaling → "Re-open add-ons".'));

    // ---- Section 1: Real-ESRGAN upscaler ----
    const reCard = el('div', { class: 'addon-card' });
    reCard.appendChild(el('h3', {}, '🔍 Real-ESRGAN upscaler (BSD-3-Clause)'));
    reCard.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px; margin: 4px 0 8px;' },
      'Drop-in upgrade for the built-in multi-step upscaler. Noticeably more detail on 4× upscale, and the only way to use the official 4× BSD-3 model.'));
    const reStatus = el('div', { class: 'addon-status' }, 'Detecting…');
    reCard.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Status'), reStatus]));
    const reProgress = el('div', { class: 'addon-progress' });
    reProgress.style.display = 'none';
    reProgress.style.color = 'var(--fg-2)';
    reProgress.style.fontSize = '12px';
    reCard.appendChild(reProgress);
    const reActions = el('div', { class: 'addon-actions' });
    const reDownload = el('button', { class: 'primary' }, 'Download from GitHub');
    const rePick = el('button', {}, 'Pick file…');
    const reOpenPage = el('button', { class: 'btn-mini' }, 'Open releases page');
    reActions.append(reOpenPage, rePick, reDownload);
    reCard.appendChild(reActions);
    m.appendChild(reCard);

    // ---- Section 2: IS-Net background-removal engine ----
    // The tool ships the Node.js wrapper (onnxruntime-node) and the
    // IS-Net ONNX model out of the box, so the user should see
    // "Detected: …" on a fresh install without doing anything. The
    // Pick-binary path is reserved for power users who want to swap in
    // a hand-built isnetbg.exe (faster than the Node wrapper on
    // CPU-only hardware).
    const isBinCard = el('div', { class: 'addon-card' });
    isBinCard.appendChild(el('h3', {}, '✨ IS-Net background removal — Node.js wrapper (MIT)'));
    isBinCard.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px; margin: 4px 0 8px;' },
      'Bundled by default — the tool ships the onnxruntime-node wrapper and the IS-Net ONNX model. The Re-detect button below should show "Detected" on a fresh install. Pick-binary is only needed if you want to swap in your own C# isnetbg.exe (faster on CPU-only hardware). Optional higher-quality BiRefNet models can be downloaded later in Settings.'));
    const isBinStatus = el('div', { class: 'addon-status' }, 'Detecting…');
    isBinCard.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Status'), isBinStatus]));
    const isBinActions = el('div', { class: 'addon-actions' });
    const isBinPick = el('button', {}, 'Pick binary… (optional)');
    const isBinOpenReadme = el('button', { class: 'btn-mini' }, 'Open README');
    isBinActions.append(isBinOpenReadme, isBinPick);
    isBinCard.appendChild(isBinActions);
    m.appendChild(isBinCard);

    // ---- Section 3: IS-Net model file ----
    // The model is bundled. If the Re-detect says "Not found" for the
    // model specifically, only then does the user need to pick one
    // (rare — happens if the bundled model got corrupted or replaced).
    const isModelCard = el('div', { class: 'addon-card' });
    isModelCard.appendChild(el('h3', {}, '✨ IS-Net model — isnet-general-use.onnx (MIT, ~170 MB)'));
    isModelCard.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px; margin: 4px 0 8px;' },
      'Bundled by default — the IS-Net general-use model ships at ./bin/models/. Re-detect should report "Detected". Pick a different .onnx only if you want a custom model (e.g. a fine-tune for a specific domain).'));
    const isModelStatus = el('div', { class: 'addon-status' }, 'Detecting…');
    isModelCard.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Status'), isModelStatus]));
    const isModelActions = el('div', { class: 'addon-actions' });
    const isModelPick = el('button', { class: 'primary' }, 'Pick model…');
    const isModelOpenPage = el('button', { class: 'btn-mini' }, 'Open HuggingFace');
    isModelActions.append(isModelOpenPage, isModelPick);
    isModelCard.appendChild(isModelActions);
    m.appendChild(isModelCard);

    // ---- Footer: Re-detect + Dismiss + Don't-ask-again ----
    const footer = el('div', { class: 'footer' });
    const redetect = el('button', { class: 'btn-mini' }, '🔄 Re-detect');
    const skipBtn = el('button', { onclick: () => { markPopupSeen('optional-addons'); close(); } }, 'Save and close');
    const neverBtn = el('button', { class: 'btn-mini' }, "Don't ask again");
    footer.append(neverBtn, skipBtn, redetect);
    m.appendChild(footer);

    // ---- Wiring ----
    function setStatus(node, text, color) {
      node.textContent = text;
      if (color) node.style.color = color;
    }

    async function refreshAll() {
      setStatus(reStatus, 'Detecting…');
      setStatus(isBinStatus, 'Detecting…');
      setStatus(isModelStatus, 'Detecting…');
      const { reSt, isSt } = await probeAll();
      if (reSt && reSt.available) {
        const v = reSt.version ? ` v${reSt.version}` : '';
        setStatus(reStatus, 'Detected: ' + (reSt.binaryPath || '') + v, 'var(--success)');
      } else {
        setStatus(reStatus, 'Not found — choose an install method below.', 'var(--fg-2)');
      }
      if (isSt && isSt.available && isSt.modelPresent) {
        // Differentiate the Node.js backend from a hand-built C#
        // binary. The `version` field returned by probeVersion()
        // is the string 'node-onnxruntime' for the Node backend
        // and a semver for the C# binary; for the binary path we
        // also display the resolved binaryPath so the user can
        // see WHICH binary was detected.
        const isNode = isSt.version === 'node-onnxruntime';
        if (isNode) {
          setStatus(isBinStatus, 'IS-Net Node.js wrapper (onnxruntime-node) + model detected.', 'var(--success)');
        } else {
          const v = isSt.version ? ` v${isSt.version}` : '';
          setStatus(isBinStatus, 'IS-Net binary' + v + ' + model detected.', 'var(--success)');
        }
        setStatus(isModelStatus, 'Detected: ' + (isSt.modelPath || ''), 'var(--success)');
      } else if (isSt && isSt.available && !isSt.modelPresent) {
        setStatus(isBinStatus, 'Binary detected — model file missing.', 'var(--warn, #d9a300)');
        setStatus(isModelStatus, 'Not found — pick the .onnx file below.', 'var(--fg-2)');
      } else {
        setStatus(isBinStatus, 'Not found — pick the binary you built.', 'var(--fg-2)');
        setStatus(isModelStatus, 'Not found — pick the .onnx file below.', 'var(--fg-2)');
      }
    }
    refreshAll();

    // Re-detect button — single place to refresh after any install.
    redetect.addEventListener('click', () => refreshAll());

    // Don't-ask-again: persist dismissal and close. We use the
    // same state flag the old Real-ESRGAN popup used so existing
    // state.json files still work.
    neverBtn.addEventListener('click', async () => {
      state.realesrganFirstRunDismissed = true;
      markPopupSeen('optional-addons');
      try { await scheduleStateSave(); } catch (_) {}
      close();
    });

    // Real-ESRGAN: download (with progress) + open releases page + pick file.
    reDownload.addEventListener('click', async () => {
      reDownload.disabled = true; rePick.disabled = true; reOpenPage.disabled = true;
      reProgress.style.display = '';
      reProgress.style.color = 'var(--fg-2)';
      reProgress.textContent = 'Starting download…';
      const off = window.api.onRealesrganDownloadProgress((data) => {
        if (data.phase === 'download') {
          if (data.total > 0) {
            const pct = (data.downloaded / data.total) * 100;
            const mb = (data.downloaded / 1024 / 1024).toFixed(1);
            const totalMb = (data.total / 1024 / 1024).toFixed(1);
            reProgress.textContent = `Downloading… ${mb} / ${totalMb} MB (${pct.toFixed(0)}%)`;
          } else {
            reProgress.textContent = 'Downloading…';
          }
        } else if (data.phase === 'verify') {
          reProgress.textContent = 'Verifying checksum…';
        } else if (data.phase === 'extract') {
          reProgress.textContent = 'Extracting…';
        } else if (data.phase === 'done') {
          reProgress.textContent = 'Done. Refreshing status…';
        }
      });
      try {
        const r = await window.api.realesrganDownload();
        off();
        if (r && r.ok) {
          reProgress.textContent = 'Installed to ' + (r.binDir || './bin') + '.';
          await refreshAll();
          state.realesrganFirstRunDismissed = true;
          try { await scheduleStateSave(); } catch (_) {}
        } else {
          reProgress.textContent = 'Download failed: ' + ((r && r.error) || 'unknown') +
            ' — try "Pick file…" or "Open releases page" instead.';
          reProgress.style.color = 'var(--danger)';
        }
      } catch (e) {
        off();
        reProgress.textContent = 'Download failed: ' + (e && e.message || e) +
          ' — try "Pick file…" or "Open releases page" instead.';
        reProgress.style.color = 'var(--danger)';
      } finally {
        reDownload.disabled = false; rePick.disabled = false; reOpenPage.disabled = false;
      }
    });
    reOpenPage.addEventListener('click', () => {
      window.api.installOpenUrl('https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0');
    });
    rePick.addEventListener('click', async () => {
      // Wrap in try/catch — a rejected IPC (rare but possible on
      // main-process crash mid-call) would otherwise surface as an
      // unhandled promise rejection with no user feedback.
      reDownload.disabled = true; rePick.disabled = true; reOpenPage.disabled = true;
      try {
        const r = await window.api.installPickAndCopy('realesrgan-binary');
        if (r && r.ok) {
          toast('Real-ESRGAN binary installed.', 'ok', 2500);
          await refreshAll();
        } else if (r && r.canceled) {
          // Silent — user just cancelled the dialog.
        } else {
          toast('Install failed: ' + ((r && r.error) || 'unknown'), 'err', 6000);
        }
      } catch (e) {
        toast('Install failed: ' + ((e && e.message) || String(e)), 'err', 6000);
      } finally {
        reDownload.disabled = false; rePick.disabled = false; reOpenPage.disabled = false;
      }
    });

    // IS-Net binary: pick file (user built it from the README's C# ref) + open README.
    isBinPick.addEventListener('click', async () => {
      isBinPick.disabled = true; isBinOpenReadme.disabled = true;
      try {
        const r = await window.api.installPickAndCopy('isnetbg-binary');
        if (r && r.ok) {
          toast('isnetbg binary installed.', 'ok', 2500);
          await refreshAll();
        } else if (r && r.canceled) {
          // Silent.
        } else {
          toast('Install failed: ' + ((r && r.error) || 'unknown'), 'err', 6000);
        }
      } catch (e) {
        toast('Install failed: ' + ((e && e.message) || String(e)), 'err', 6000);
      } finally {
        isBinPick.disabled = false; isBinOpenReadme.disabled = false;
      }
    });
    isBinOpenReadme.addEventListener('click', () => {
      // Open the upstream IS-Net project page (DIS on GitHub) —
      // the README there links to every current ONNX mirror +
      // a C# reference implementation the user can build their
      // isnetbg binary from. We don't try to ship a bundled
      // build script because the binary has to be compiled on
      // the user's machine (OS + ONNX runtime + ImageSharp),
      // and a one-click compile cross-platform from Electron
      // is its own can of worms.
      window.api.installOpenUrl('https://github.com/xuebinqin/DIS');
    });

    // IS-Net model: pick file + open HuggingFace mirror.
    isModelPick.addEventListener('click', async () => {
      isModelPick.disabled = true; isModelOpenPage.disabled = true;
      try {
        const r = await window.api.installPickAndCopy('isnetbg-model');
        if (r && r.ok) {
          toast('isnet-general-use.onnx installed.', 'ok', 2500);
          await refreshAll();
        } else if (r && r.canceled) {
          // Silent.
        } else {
          toast('Install failed: ' + ((r && r.error) || 'unknown'), 'err', 6000);
        }
      } catch (e) {
        toast('Install failed: ' + ((e && e.message) || String(e)), 'err', 6000);
      } finally {
        isModelPick.disabled = false; isModelOpenPage.disabled = false;
      }
    });
    isModelOpenPage.addEventListener('click', () => {
      // The IS-Net ONNX model is hosted on several HuggingFace
      // mirrors. We open the DIS project README on GitHub
      // (which links to all current mirrors + a C# reference
      // implementation) instead of hard-coding a single mirror
      // that may go stale.
      window.api.installOpenUrl('https://github.com/xuebinqin/DIS');
    });
  }, autoOpened ? { onClose: _exit } : null);
}

