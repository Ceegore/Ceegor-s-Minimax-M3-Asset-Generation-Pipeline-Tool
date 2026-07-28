// renderer/overlays/imageOptimizeOverlay.js
// Image-optimisation overlay used by the folder-browser right-click
// menu ("🗜 Optimize / Compress…"). Lets the user re-encode a
// single image to shrink its file size while preserving best-
// possible visual quality, using the Sharp-backed `image:optimize`
// IPC.
//
// Three controls, matching the spec:
//   - Quality slider (1..100, default 82 — the perceptual sweet
//     spot for JPEG / WebP).
//   - Format dropdown (Keep / JPEG / PNG / WebP / AVIF). "Keep"
//     preserves the source format; the other four re-encode the
//     image to the target format (e.g. PNG → WebP for ~30%
//     smaller files at the same Q).
//   - "Strip non-essential EXIF (keep ICC profile)" checkbox, on
//     by default — drops camera model / GPS / software tags but
//     keeps the colour profile so the image still renders
//     correctly on colour-managed displays.
//
// On success, the dialog stays open and shows a results block
// ("4.2 MB → 612 KB · 85% smaller") with a one-click "Open
// folder" link. The user can keep clicking "Run" with different
// settings without re-opening the dialog (the slider
// reposition would otherwise re-trigger the action).
async function showOptimizeOverlay(srcPath, targets) {
  // KGO4-014: verify the source file still exists before opening the modal.
  const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(srcPath) : undefined;
  const exists = await window.api.fbExists(srcPath, existsGrant);
  // KGO6-011: distinguish grant errors from genuinely missing files.
  if (!exists || !exists.ok) { toast((exists && exists.error) || 'Cannot access source file: ' + srcPath, 'err', 6000); return; }
  if (!exists.exists) { toast('Source file not found: ' + srcPath, 'err', 5000); return; }
  // Multi-select batch: when ≥2 images are checked, run the chosen
  // quality/format/strip settings across every one. The dialog UI reflects the
  // primary srcPath; the per-file results block is replaced by a batch summary
  // line.
  const batch = Array.isArray(targets) && targets.length > 1 ? targets.slice() : null;
  // Path-aware extension extraction. split('.').pop() returns the WHOLE
  // filename for an extension-less source path, mis-classifying it as a known
  // format.
  const lastDot = Math.max(srcPath.lastIndexOf('.'), srcPath.lastIndexOf('/'), srcPath.lastIndexOf('\\'));
  const hasExt = lastDot >= 0 && srcPath.indexOf('.', lastDot) === lastDot && srcPath.slice(lastDot + 1).length > 0;
  const ext = hasExt ? srcPath.slice(lastDot + 1).toLowerCase() : '';
  const srcFmt = (ext === 'jpg' ? 'jpeg' : ext) || 'jpeg';
  // Pre-fill from the persisted settings so the user only has to
  // override the field they care about on a given run. The
  // settings dialog (Upscale settings → "Optimize" sub-section)
  // shares the same state, so a user who picked Q=70 for
  // "all generated images" gets the same starting point here.
  const cfg = state.optimizeSettings || { quality: 82, format: 'keep', stripMetadata: true };
  showModal((m, close) => {
    m.appendChild(el('h2', {}, '🗜 Optimize / Compress image'));
    m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px;' },
      batch ? `Optimizing ${batch.length} selected images` : 'Source: ' + srcPath));

    // ---- Quality slider ----
    // The slider's range is 1..100. The current value is displayed
    // next to the slider so the user always knows the exact
    // number they're picking. Default 82 (perceptually lossless
    // on photographic content).
    const qualityInput = el('input', { type: 'range', min: '1', max: '100', step: '1', value: String(cfg.quality || 82) });
    const qualityLabel = el('span', { class: 'meta', style: 'min-width: 32px; text-align: right;' }, String(qualityInput.value));
    function syncQuality() { qualityLabel.textContent = String(qualityInput.value); }
    qualityInput.addEventListener('input', syncQuality);
    m.appendChild(el('div', { class: 'row' }, [
      el('label', {}, 'Quality'),
      qualityInput,
      qualityLabel,
    ]));
    // Tiny "presets" row so a user who's new to the concept can
    // jump to the canonical "sweet spot" with one click. The
    // explicit slider next to it is still the source of truth.
    const presetRow = el('div', { class: 'row', style: 'gap: 4px; flex-wrap: wrap;' });
    for (const [q, lbl] of [[60, 'small (60)'], [75, 'balanced (75)'], [82, 'max quality (82)'], [95, 'near-lossless (95)']]) {
      const b = el('button', { class: 'btn-mini', type: 'button' }, lbl);
      b.addEventListener('click', () => {
        qualityInput.value = String(q);
        syncQuality();
      });
      presetRow.appendChild(b);
    }
    m.appendChild(presetRow);

    // ---- Format dropdown ----
    // "Keep" preserves the source format; the other four re-encode
    // the image. The current source format is never shown as a
    // separate "Same" option — that's exactly what "Keep" means.
    const fmtSel = el('select', {});
    const fmtDefs = [
      ['keep', `Keep source (${srcFmt.toUpperCase()})`],
      ['jpeg', 'JPEG (smallest lossy, no transparency)'],
      ['png',  'PNG  (lossless, supports transparency)'],
      ['webp', 'WebP (modern, ~30% smaller than JPEG)'],
      ['avif', 'AVIF (newest, smallest files, slow encode)'],
    ];
    for (const [v, lbl] of fmtDefs) {
      const opt = el('option', { value: v }, lbl);
      if ((cfg.format || 'keep') === v) opt.selected = true;
      fmtSel.appendChild(opt);
    }
    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Output format'), fmtSel]));

    // ---- Strip-metadata checkbox ----
    // On by default. Drops EXIF (camera model, GPS, software
    // tag) but keeps the ICC colour profile (see
    // src/imageOptimizer.js for the exact pipeline).
    const stripCb = el('input', { type: 'checkbox' });
    stripCb.checked = cfg.stripMetadata !== false;
    m.appendChild(el('div', { class: 'row' }, [
      el('label', { class: 'auto-crop-label' }, [stripCb, ' Strip non-essential EXIF (keeps ICC colour profile)']),
    ]));

    // ---- Advanced Encoder Settings ----
    if (!state.pipelineAdvancedSettings) state.pipelineAdvancedSettings = {};
    if (!state.pipelineAdvancedSettings.optimize) state.pipelineAdvancedSettings.optimize = {
      jpegChromaSubsampling: '4:2:0', jpegMozjpeg: true, pngCompressionLevel: 9, pngPalette: false,
      webpMode: 'lossy', webpEffort: 6, avifEffort: 9, avifChromaSubsampling: '4:4:4',
    };
    const advOpt = state.pipelineAdvancedSettings.optimize;

    const advDetails = el('details', { style: 'margin-top: 12px; font-size: 13px;' });
    advDetails.appendChild(el('summary', {}, 'Advanced Encoder Settings'));
    
    const jpegChromaSel = el('select', {});
    for (const v of ['4:2:0', '4:4:4']) {
      const opt = el('option', { value: v }, v);
      if (advOpt.jpegChromaSubsampling === v) opt.selected = true;
      jpegChromaSel.appendChild(opt);
    }
    const jpegMozCb = el('input', { type: 'checkbox' });
    jpegMozCb.checked = !!advOpt.jpegMozjpeg;
    
    const pngCompSel = el('select', {});
    for (let i = 1; i <= 9; i++) {
      const opt = el('option', { value: String(i) }, String(i));
      if (advOpt.pngCompressionLevel === i) opt.selected = true;
      pngCompSel.appendChild(opt);
    }
    const pngPalCb = el('input', { type: 'checkbox' });
    pngPalCb.checked = !!advOpt.pngPalette;
    
    const webpModeSel = el('select', {});
    for (const [v, lbl] of [['lossy', 'Lossy'], ['lossless', 'Lossless'], ['nearLossless', 'Near-lossless']]) {
      const opt = el('option', { value: v }, lbl);
      if (advOpt.webpMode === v) opt.selected = true;
      webpModeSel.appendChild(opt);
    }
    const webpEffortSel = el('select', {});
    for (let i = 0; i <= 6; i++) {
      const opt = el('option', { value: String(i) }, String(i));
      if (advOpt.webpEffort === i) opt.selected = true;
      webpEffortSel.appendChild(opt);
    }
    
    const avifEffortSel = el('select', {});
    for (let i = 0; i <= 9; i++) {
      const opt = el('option', { value: String(i) }, String(i));
      if (advOpt.avifEffort === i) opt.selected = true;
      avifEffortSel.appendChild(opt);
    }
    const avifChromaSel = el('select', {});
    for (const v of ['4:4:4', '4:2:0']) {
      const opt = el('option', { value: v }, v);
      if (advOpt.avifChromaSubsampling === v) opt.selected = true;
      avifChromaSel.appendChild(opt);
    }
    
    advDetails.appendChild(el('div', { class: 'row', style: 'margin-top: 8px;' }, [el('strong', {}, 'JPEG'), el('label', { style: 'margin-left: 8px;' }, 'Chroma'), jpegChromaSel, el('label', { style: 'margin-left: 8px;' }, [jpegMozCb, ' MozJPEG'])]));
    advDetails.appendChild(el('div', { class: 'row' }, [el('strong', {}, 'PNG'), el('label', { style: 'margin-left: 14px;' }, 'Compression (1-9)'), pngCompSel, el('label', { style: 'margin-left: 8px;' }, [pngPalCb, ' Palette'])]));
    advDetails.appendChild(el('div', { class: 'row' }, [el('strong', {}, 'WebP'), el('label', { style: 'margin-left: 6px;' }, 'Mode'), webpModeSel, el('label', { style: 'margin-left: 8px;' }, 'Effort (0-6)'), webpEffortSel]));
    advDetails.appendChild(el('div', { class: 'row' }, [el('strong', {}, 'AVIF'), el('label', { style: 'margin-left: 14px;' }, 'Effort (0-9)'), avifEffortSel, el('label', { style: 'margin-left: 8px;' }, 'Chroma'), avifChromaSel]));
    
    m.appendChild(advDetails);

    // ---- Run / status / results block ----
    // The status row + results block live inside the same
    // container so the dialog can be re-used for multiple
    // consecutive runs (e.g. user picks a different Q, hits
    // Run again). Results are wiped on each click.
    const runBtn = el('button', { class: 'primary' }, '🗜 Optimize');
    const cancelBtn = el('button', { onclick: close }, 'Cancel');
    const status = el('div', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px; min-height: 16px; margin: 4px 0;' }, '');
    const resultsBox = el('div', { style: 'margin: 8px 0; display: none;' });
    m.appendChild(status);
    m.appendChild(resultsBox);

    // Run handler. Catches failures into a single toast and
    // keeps the dialog open (with the Run button re-enabled) so
    // the user can fix a corrupt file or change settings and
    // retry without re-opening the dialog.
    runBtn.addEventListener('click', async () => {
      const quality = Math.max(1, Math.min(100, parseInt(qualityInput.value, 10) || 82));
      const format = fmtSel.value;
      const stripMetadata = stripCb.checked;
      // Persist the latest values so a subsequent "Optimize" run
      // from the right-click menu pre-fills the same choices.
      // BUG #8 fix: merge instead of replace — the object literal
      // dropped the `enabled` key, so after one dialog run the
      // post-generation optimize stage (section07 checks
      // optimizeSettings.enabled) silently stopped running, and the
      // loss was persisted to state.json.
      state.optimizeSettings = Object.assign({}, state.optimizeSettings, { quality, format, stripMetadata });
      
      state.pipelineAdvancedSettings.optimize.jpegChromaSubsampling = jpegChromaSel.value;
      state.pipelineAdvancedSettings.optimize.jpegMozjpeg = !!jpegMozCb.checked;
      // Effort 0 is a legal pick in these selects (fastest encode) — parse
      // with an explicit NaN check instead of `|| default`, which silently
      // rewrote a selected 0 to the SLOWEST setting (the BUG-A falsy-zero
      // class, fixed in the optimizer but previously not in this save path).
      const pngComp = parseInt(pngCompSel.value, 10);
      state.pipelineAdvancedSettings.optimize.pngCompressionLevel = Number.isFinite(pngComp) ? pngComp : 9;
      state.pipelineAdvancedSettings.optimize.pngPalette = !!pngPalCb.checked;
      state.pipelineAdvancedSettings.optimize.webpMode = webpModeSel.value;
      const webpEff = parseInt(webpEffortSel.value, 10);
      state.pipelineAdvancedSettings.optimize.webpEffort = Number.isFinite(webpEff) ? webpEff : 6;
      const avifEff = parseInt(avifEffortSel.value, 10);
      state.pipelineAdvancedSettings.optimize.avifEffort = Number.isFinite(avifEff) ? avifEff : 9;
      state.pipelineAdvancedSettings.optimize.avifChromaSubsampling = avifChromaSel.value;
      
      await scheduleStateSave();

      runBtn.disabled = true;
      runBtn.textContent = 'Optimizing…';
      status.textContent = `Re-encoding at quality ${quality}…`;
      resultsBox.style.display = 'none';
      resultsBox.innerHTML = '';
      // Batch: run every checked image through the same settings, then
      // report a summary. The per-file results block (bytes saved etc.)
      // is single-file only; the batch worker's toast carries the roll-up.
      if (batch) {
        try {
          const { ok, fail } = await runImagePipelineBatch(`Optimize q${quality}`, batch,
            (p) => optimizeImageFile(p, { quality, format, stripMetadata }));
          status.textContent = `Done. ${ok} optimized${fail ? `, ${fail} failed (kept in selection)` : ''}.`;
        } catch (e) {
          status.textContent = 'Failed: ' + (e && e.message || e);
          toast('Optimize failed: ' + (e && e.message || e), 'err', 6000);
        }
        runBtn.disabled = false;
        runBtn.textContent = '🗜 Optimize';
        return;
      }
      try {
        const r = await optimizeImageFile(srcPath, { quality, format, stripMetadata });
        // Build a human-friendly results block. The exact bytes
        // and percent saved are shown so the user can see
        // whether the slider change was worth it. The link
        // re-selects the optimised file in the file browser
        // and opens its containing folder in Explorer.
        const fmtLbl = (r.format || '').toUpperCase() || '?';
        const inSize = humanSize(r.inputSize);
        const outSize = humanSize(r.outputSize);
        const saved = r.savedPercent || 0;
        const colorClass = saved >= 30 ? 'ok' : (saved >= 10 ? 'meta' : 'warn');
        const dimLbl = r.width && r.height ? `${r.width} × ${r.height}` : '';
        resultsBox.innerHTML = '';
        resultsBox.style.display = '';
        resultsBox.appendChild(el('div', { class: 'fb-item-info' }, [
          el('div', { class: 'fb-info-row' }, [
            el('span', { class: 'fb-info-key' }, 'Result'),
            el('span', { style: 'color: var(--' + (saved >= 30 ? 'ok' : 'fg-1') + ');' },
              `${inSize} → ${outSize}  (−${saved}%)`),
          ]),
          el('div', { class: 'fb-info-row' }, [
            el('span', { class: 'fb-info-key' }, 'Format'),
            el('span', {}, fmtLbl + (dimLbl ? ` · ${dimLbl}` : '')),
          ]),
          el('div', { class: 'fb-info-row' }, [
            el('span', { class: 'fb-info-key' }, 'Output'),
            el('span', { style: 'word-break: break-all;' }, r.outputPath),
          ]),
        ]));
        // "Reveal in Explorer" + "Preview" buttons, so the user
        // doesn't have to dig through the folder browser to
        // find the result.
        const revealBtn = el('button', { class: 'btn-mini', onclick: () => window.api.fbReveal(r.outputPath) }, '↗ Reveal in Explorer');
        const previewBtn = el('button', { class: 'btn-mini', onclick: () => { try { previewImageFromFile(r.outputPath); } catch (_) {} } }, '🖼 Preview');
        resultsBox.appendChild(el('div', { class: 'row', style: 'margin-top: 6px; gap: 6px;' }, [revealBtn, previewBtn]));
        // Refresh the file browser so the new sibling shows up
        // in the listing.
        try { await refreshBrowser(); } catch (_) {}
        // Toast + status so the user gets a clear "it worked"
        // signal even if they missed the inline result block.
        // cosm1 fix: toast() only recognises 'err'/'ok'/'warn' —
        // 'info' rendered neutral; 'warn' flags the sub-1% saving
        // (matches the colorClass convention at :242).
        const tone = saved >= 1 ? 'ok' : 'warn';
        toast(`Optimized ${inSize} → ${outSize} (−${saved}%) → ${r.outputPath}`, tone, 4000);
        status.textContent = `Done. ${inSize} → ${outSize} (−${saved}%).`;
        // Mark the saved settings as "the ones the user just
        // ran with" so a follow-up right-click on the optimised
        // file pre-fills the same choices.
        runBtn.disabled = false;
        runBtn.textContent = '🗜 Optimize';
      } catch (e) {
        // Structured failure from the IPC. Show the precise
        // message in the status line (toast is redundant here
        // because the user is staring at the dialog).
        status.textContent = 'Failed: ' + (e && e.message || e);
        toast('Optimize failed: ' + (e && e.message || e), 'err', 6000);
        runBtn.disabled = false;
        runBtn.textContent = '🗜 Optimize';
      }
    });
    m.appendChild(el('div', { class: 'footer' }, [cancelBtn, runBtn]));
  }, { id: 'image-optimize' });
}

// Extend the existing ImageOverlays object
window.ImageOverlays = window.ImageOverlays || {};
window.ImageOverlays.showOptimizeOverlay = showOptimizeOverlay;
