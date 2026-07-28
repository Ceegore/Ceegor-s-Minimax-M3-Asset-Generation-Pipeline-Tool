// renderer/overlays/imageEditorAssetGen.js
// H8-F2-P3: "Generate…" popover + history strip for the Asset Composer panel.
//
// The popover reuses the imageTab generation contract VERBATIM (minus the tab
// chrome): same guards (api_key, prompt length), same spec preflight
// (validateTabAgainstSpec), same output resolution (ensureSubDir('image') +
// uniquePath), same grant capture (state._fbGrantId right after ensureSubDir
// — R7.5), same mmxRunJob args shape, same single-retry-on-transient loop
// (isRetryableMmxError), and JobRunner.run for ActiveJobsWidget tracking +
// ✕-cancel. No new IPC channels.
//
// On success the generated file is loaded into the asset session (panel
// module) and pushed onto the in-session history strip (last 8, click to
// reload). The history is per-editor-session (ctrl.assetHistory) — it is
// intentionally NOT persisted: the files themselves live in the output dir
// and stay visible in the file browser (refreshBrowser() after success).
//
// H8-F2 C1: Count select (1–4). For --n > 1 the mmx CLI rejects --out, so
// the run uses --out-dir and the produced files are discovered by an mtime
// scan (imageTab's resolveOutDirFiles pattern), then offered in a 2×2
// picker modal — click a thumbnail to load it into the asset canvas.
(function () {
  'use strict';

  const HISTORY_MAX = 8;
  const PROMPT_MAX = 1500; // imageTab contract
  const RETRY_DELAY_MS = 1500;

  // Same defensive file-URL helper as imageEditorSource.js.
  function fileUrlOf(p) {
    if (window.FileUrl && window.FileUrl.fileUrl) return window.FileUrl.fileUrl(p);
    const enc = encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
    return 'file:///' + (enc.startsWith('/') ? enc.slice(1) : enc);
  }

  // Clamp a W/H input to the API's own limits (512–2048, multiple of 8 —
  // spec: "explicitly cap generation-popover W/H at 2048 like the API's own
  // limit"). Rounding to 8 keeps arbitrary typing valid instead of failing
  // server-side.
  function clampDim(v, fallback) {
    let n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) n = fallback;
    n = Math.max(512, Math.min(2048, n));
    return Math.round(n / 8) * 8;
  }

  function mmxErrMsg(r) {
    if (typeof formatMmxError === 'function') return formatMmxError(r);
    return (r && (r.stderr || r.error)) || 'mmx run failed';
  }
  function mmxRetryable(r) {
    if (typeof isRetryableMmxError === 'function') return isRetryableMmxError(r, mmxErrMsg(r));
    return true; // best-effort when app.js globals are absent (never in prod)
  }

  // ---------- history strip ----------

  function ensureHistory(ctrl) {
    if (!Array.isArray(ctrl.assetHistory)) ctrl.assetHistory = [];
    return ctrl.assetHistory;
  }

  // Re-render the panel's thumbnail strip from ctrl.assetHistory. No-op when
  // the panel (or its strip container) is not present — the gen module can be
  // called from tests/sandboxes without the panel loaded.
  function renderHistory(ctrl) {
    const P = ctrl.assetPanel;
    if (!P || !P.historyStrip) return;
    const strip = P.historyStrip;
    strip.textContent = '';
    const h = ensureHistory(ctrl);
    if (!h.length) {
      strip.appendChild(el('span', { class: 'ie-asset-history-empty' }, '—'));
      return;
    }
    for (const p of h) {
      const img = el('img', {
        class: 'ie-asset-history-thumb',
        src: fileUrlOf(p) + '?t=' + Date.now(),
        alt: 'generated asset',
        title: p,
      });
      img.addEventListener('click', () => {
        if (window.ImageEditorAssetPanel && typeof window.ImageEditorAssetPanel.loadAssetFromPath === 'function') {
          window.ImageEditorAssetPanel.loadAssetFromPath(ctrl, p);
        }
      });
      strip.appendChild(img);
    }
  }

  // Newest first, de-duplicated, capped at HISTORY_MAX.
  function pushHistory(ctrl, path) {
    const h = ensureHistory(ctrl);
    const i = h.indexOf(path);
    if (i === 0) { renderHistory(ctrl); return; }
    if (i > 0) h.splice(i, 1);
    h.unshift(path);
    if (h.length > HISTORY_MAX) h.length = HISTORY_MAX;
    renderHistory(ctrl);
  }

  // ---------- Generate popover ----------

  // C1: discover the files an --out-dir (--n > 1) run produced by scanning
  // outDir for image entries written during this run (mmx picks its own
  // filenames, so the renderer can't know them up front). Mirrors
  // imageTab.resolveOutDirFiles, including the 1.5 s pre-roll.
  async function scanRunFiles(outDir, startMs) {
    try {
      const _g = (window.GrantHelper && window.GrantHelper.ensureDirList) ? await window.GrantHelper.ensureDirList(outDir) : undefined;
      const dirList = (_g && _g.ok === false) ? _g : await window.api.fbList(outDir, _g);
      if (dirList && dirList.ok && Array.isArray(dirList.items)) {
        const nowMs = Date.now();
        return dirList.items
          .filter((it) => !it.isDir && ['.png', '.jpg', '.jpeg', '.webp'].includes(it.ext))
          .filter((it) => { const m = it.mtimeMs || 0; return m >= startMs - 1500 && m <= nowMs + 5000; })
          .sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0))
          .map((it) => it.path);
      }
    } catch (_) { /* fall through with whatever we have */ }
    return [];
  }

  // C1: 2×2 picker for multi-image (--n > 1) runs — click a thumbnail to
  // load it into the asset canvas (and push it onto the history strip).
  function openVariantPicker(ctrl, paths) {
    window.showModal((m, close) => {
      m.style.width = 'min(460px, 94vw)';
      m.appendChild(el('h2', {}, '🖼 Pick a variant'));
      const grid = el('div', { class: 'ie-asset-pick-grid' });
      for (const p of paths.slice(0, 4)) {
        const img = el('img', {
          class: 'ie-asset-pick-thumb',
          src: fileUrlOf(p) + '?t=' + Date.now(),
          alt: 'generated variant',
          title: p,
        });
        img.addEventListener('click', () => {
          pushHistory(ctrl, p);
          if (window.ImageEditorAssetPanel && typeof window.ImageEditorAssetPanel.loadAssetFromPath === 'function') {
            window.ImageEditorAssetPanel.loadAssetFromPath(ctrl, p);
          }
          close();
        });
        grid.appendChild(img);
      }
      m.appendChild(grid);
      const closeBtn = el('button', { class: 'ie-btn' }, 'Close');
      closeBtn.addEventListener('click', () => close());
      m.appendChild(el('div', { class: 'ie-asset-gen-btnrow' }, [closeBtn]));
    }, { id: 'ie-asset-pick' });
  }

  function openGeneratePopover(ctrl) {
    if (!ctrl || !ctrl.assetPanel) { toast('Asset panel is not available.', 'warn'); return; }
    const cfg = (window.state && window.state.config) || {};
    if (!cfg.api_key) {
      toast('No API key configured — set it in Settings first.', 'err', 6000);
      return;
    }
    // id gives stack dedup (H8-003): a second click focuses the existing
    // popover instead of stacking a copy; the editor goes inert underneath.
    window.showModal((m, close) => {
      m.style.width = 'min(400px, 94vw)';
      m.appendChild(el('h2', {}, '✨ Generate Asset'));

      const promptTa = el('textarea', {
        class: 'ie-asset-gen-prompt',
        rows: 3,
        maxlength: PROMPT_MAX,
        placeholder: 'Describe the asset to generate…',
        style: 'width:100%;box-sizing:border-box;resize:vertical;',
      });
      m.appendChild(promptTa);

      const row = (labelText, inputEl) => el('div', { class: 'ie-asset-gen-row' },
        [el('label', { class: 'ie-asset-gen-label' }, labelText), inputEl]);

      const styleSel = el('select', { class: 'ie-asset-gen-input', 'aria-label': 'Model / style' }, [
        el('option', { value: 'image-01' }, 'image-01 — general purpose'),
        el('option', { value: 'image-01-live' }, 'image-01-live — hand-drawn / cartoon'),
      ]);
      m.appendChild(row('Style', styleSel));

      const wIn = el('input', { type: 'number', min: 512, max: 2048, step: 8, value: 512, 'aria-label': 'Width' });
      const hIn = el('input', { type: 'number', min: 512, max: 2048, step: 8, value: 512, 'aria-label': 'Height' });
      m.appendChild(row('Size', el('div', { class: 'ie-asset-gen-size' },
        [wIn, el('span', {}, '×'), hIn, el('span', { class: 'ie-asset-gen-hint' }, 'px, 512–2048')])));

      const seedIn = el('input', { type: 'number', min: 0, max: 2147483647, step: 1, placeholder: 'Random', 'aria-label': 'Seed' });
      m.appendChild(row('Seed', seedIn));

      // C1: batch variants (one mmx call, --n > 1 → --out-dir + picker).
      const countSel = el('select', { class: 'ie-asset-gen-input', 'aria-label': 'Number of images' }, [
        el('option', { value: '1' }, '1'),
        el('option', { value: '2' }, '2 — pick afterwards'),
        el('option', { value: '3' }, '3 — pick afterwards'),
        el('option', { value: '4' }, '4 — pick afterwards'),
      ]);
      m.appendChild(row('Count', countSel));

      const status = el('div', { class: 'ie-asset-gen-status', role: 'status' });
      m.appendChild(status);

      const genBtn = el('button', { class: 'ie-btn primary' }, '✨ Generate');
      const closeBtn = el('button', { class: 'ie-btn' }, 'Close');
      closeBtn.addEventListener('click', () => close());
      m.appendChild(el('div', { class: 'ie-asset-gen-btnrow' }, [closeBtn, genBtn]));

      genBtn.addEventListener('click', async () => {
        const promptText = (promptTa.value || '').trim();
        if (!promptText) { status.textContent = 'Enter a prompt first.'; promptTa.focus(); return; }
        if (promptText.length > PROMPT_MAX) { status.textContent = `Prompt too long (${promptText.length}/${PROMPT_MAX}).`; return; }
        const w = clampDim(wIn.value, 512);
        const h = clampDim(hIn.value, 512);
        const seedRaw = (seedIn.value || '').trim();
        const seedVal = seedRaw === '' ? '' : String(parseInt(seedRaw, 10) | 0);
        // C1: how many images in this ONE mmx call (each counts against quota).
        const nCount = Math.max(1, Math.min(4, parseInt(countSel.value, 10) || 1));

        // Spec preflight — same contract as imageTab (range checks etc.).
        try {
          const MS = window.ModelSpecs;
          if (MS && typeof MS.validateTabAgainstSpec === 'function') {
            const params = { '--width': { value: w }, '--height': { value: h } };
            if (seedVal !== '') params['--seed'] = { value: Number(seedVal) };
            const vis = (window.ImageUtils && window.ImageUtils.isFlagVisibleForCurrentModel) || (() => true);
            const errs = MS.validateTabAgainstSpec('image', params, styleSel.value, null, vis);
            if (errs && errs.length) { status.textContent = errs[0]; return; }
          }
        } catch (_) { /* preflight is best-effort; the run itself re-validates */ }

        genBtn.disabled = true;
        status.textContent = 'Resolving output folder…';
        let outDir;
        try { outDir = await ensureSubDir('image'); }
        catch (e) {
          status.textContent = 'Cannot resolve output folder: ' + ((e && e.message) || String(e));
          genBtn.disabled = false;
          return;
        }
        // R7.5: capture the grant immediately (before any further await can
        // let a concurrent tab overwrite the shared slot).
        const mmxGrant = window.state._fbGrantId;
        const slug = (typeof slugify === 'function' ? slugify(promptText) : 'asset').slice(0, 60) || 'asset';
        const outFile = uniquePath(outDir, `${timestamp()}_asset_${slug}.png`);
        const promptShort = promptText.replace(/\s+/g, ' ').slice(0, 120);
        // C1: --out-dir runs need the run start time for the mtime scan.
        const runStartMs = Date.now();
        status.textContent = nCount > 1 ? `Generating ${nCount} images… (Active Jobs ✕ cancels)` : 'Generating… (Active Jobs ✕ cancels)';

        let jctrl;
        jctrl = window.JobRunner.run({
          tabKey: 'image',
          type: 'image',
          title: `Asset${nCount > 1 ? ' ×' + nCount : ''}: ${promptShort}${promptText.length > 120 ? '…' : ''}`,
          subtitle: 'Generate popover (image editor)',
          runFn: async (ctx) => {
            const aborted = () => !!(ctx && ctx.signal && ctx.signal.aborted);
            const args = ['image', 'generate', '--prompt', promptText, '--model', styleSel.value,
              '--width', String(w), '--height', String(h)];
            if (seedVal !== '') args.push('--seed', seedVal);
            args.push('--response-format', 'url');
            // C1: the mmx CLI rejects --out with --n > 1 ("Use --out-dir
            // instead") — same contract as imageTab.
            if (nCount > 1) args.push('--n', String(nCount), '--out-dir', outDir);
            else args.push('--out', outFile);
            let r = await window.api.mmxRunJob({ args, jobId: jctrl.jobId }, mmxGrant);
            // Single retry on transient errors (imageTab loops up to 3×; one
            // is enough for the popover — the spec says so explicitly).
            if (!r.ok && !aborted() && mmxRetryable(r)) {
              await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
              if (!aborted()) r = await window.api.mmxRunJob({ args, jobId: jctrl.jobId }, mmxGrant);
            }
            if (aborted()) return { status: 'cancel' };
            if (!r.ok) {
              const msg = mmxErrMsg(r);
              return { status: 'err', error: msg, details: [msg] };
            }
            if (nCount > 1) {
              const scanned = await scanRunFiles(outDir, runStartMs);
              return { outputPaths: scanned.length ? scanned : [], details: scanned };
            }
            return { outputPaths: [outFile], details: [outFile] };
          },
        });
        // JobRunner.run returns a REJECTED PROMISE (not a throw) on the hard
        // cap / same-tab gate — mirror imageTab's handling.
        if (jctrl && typeof jctrl.catch === 'function') {
          jctrl.catch(() => {}); // JobRunner already toasted the reason
          status.textContent = 'Could not start — another image job is running.';
          genBtn.disabled = false;
          return;
        }
        const res = await jctrl.done;
        if (res && res.status === 'ok') {
          // R7: JobRunner's done resolves { job, status, error } — the runFn's
          // outputPaths live on res.job.outputPaths (reading res.outputPaths
          // always yielded [] so multi-image runs reported "no files found").
          const outs = Array.isArray(res.job && res.job.outputPaths) ? res.job.outputPaths : [];
          if (typeof refreshBrowser === 'function') { try { refreshBrowser(); } catch (_) {} }
          if (nCount > 1) {
            // C1: push every variant onto the history strip (newest first),
            // close the popover, and let the user pick from a 2×2 grid.
            for (let i = outs.length - 1; i >= 0; i--) pushHistory(ctrl, outs[i]);
            close();
            if (outs.length) {
              toast(outs.length + ' variants generated — pick one.', 'ok', 3000);
              openVariantPicker(ctrl, outs);
            } else {
              toast('Generated, but no files were found in the output dir.', 'warn', 5000);
            }
          } else {
            pushHistory(ctrl, outFile);
            if (window.ImageEditorAssetPanel && typeof window.ImageEditorAssetPanel.loadAssetFromPath === 'function') {
              window.ImageEditorAssetPanel.loadAssetFromPath(ctrl, outFile);
            }
            toast('Asset generated.', 'ok', 2500);
            close();
          }
        } else if (res && res.status === 'cancel') {
          status.textContent = 'Cancelled.';
          genBtn.disabled = false;
        } else {
          status.textContent = 'Failed: ' + ((res && res.error) || 'unknown error');
          genBtn.disabled = false;
        }
      });

      promptTa.focus();
    }, { id: 'ie-asset-gen' });
  }

  window.ImageEditorAssetGen = { openGeneratePopover, pushHistory, renderHistory, clampDim };
})();
