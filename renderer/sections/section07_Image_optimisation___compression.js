// renderer/sections/section07_Image_optimisation___compression.js
// Image optimisation / compression

// ----------------- Image optimisation / compression -----------------
// Thin wrapper around the main-process `image:optimize` IPC. The
// actual Sharp / libvips work happens in src/imageOptimizer.js; the
// renderer just translates UI choices into the IPC envelope and
// returns a structured result.
//
// `opts`:
//   {
//     quality:       1..100,                  // default 82
//     format:        'keep'|'jpeg'|'png'|'webp'|'avif',
//                                            // default 'keep'
//     stripMetadata: boolean,                 // default true
//     // `overwriteSource: true` writes the optimised bytes
//     // back to `srcPath` (atomic temp-file + rename on the
//     // main side). The post-generation pipeline uses this so
//     // the file the user just paid API credits to generate
//     // ends up as the smaller, optimised file — no
//     // intermediate "_optimized" sibling cluttering the
//     // output folder. The folder-browser right-click overlay
//     // leaves this off and uses a sibling file instead so
//     // the user can A/B the original against the optimised
//     // version.
//     overwriteSource: boolean,               // default false
//   }
//
// Returns the IPC envelope (see src/imageOptimizer.js header for
// the full shape). Throws an Error on the rare `!ok` path so the
// caller's catch block can show a single toast; the envelope
// itself also carries the message in `.error` for callers that
// want to render it inline (e.g. a results block in the dialog).
async function optimizeImageFile(srcPath, opts) {
  opts = opts || {};
  // Defensive: derive the actual `format` to pass to the IPC
  // from the UI's `format: 'keep' | 'jpeg' | ...` value. The
  // 'keep' alias is renderer-side only — the IPC expects
  // either a real format string or null/undefined for
  // "preserve source format".
  const fmt = (opts.format === 'keep' || !opts.format) ? null : opts.format;
  const overwrite = !!opts.overwriteSource;
  // A format conversion must get a matching extension. In-place overwrite is
  // only safe when the format is kept; otherwise write a sibling and return it.
  const sourceWithFormat = fmt
    ? srcPath.replace(/(\.[^./\\]+)?$/, '.' + fmt)
    : srcPath;
  const out = overwrite && !fmt
    ? srcPath
    : await uniqueOutputPath(derivedOutputPath(sourceWithFormat, '_optimized'));
  // R1.5a.follow-up Phase 2: mint grant before mutation (graceful fallthrough when missing).
  // R1.5a.follow-up Phase 6: directory-grant on the PARENT of srcPath
  // (with both 'read' AND 'write' capabilities) — the source is read
  // and the sibling output (`out`, derived from srcPath) is written.
  // A file-grant on srcPath with 'read' would FAIL the handler's
  // write-check on the output path (file-grants cover only their
  // exact path), and a file-grant with only 'read' would FAIL the
  // write-check on the source path itself (in-place overwrite case).
  // The directory-grant on path.dirname(srcPath) covers both.
  const grantId = window.api && window.api.mintGrant
    ? await window.GrantCache.ensurePathGrant(
        window.api.pathDirname(srcPath), 'read',
        { kind: 'directory', capabilities: ['read', 'write'] }
      ) : undefined;
  if (grantId && grantId.ok === false) throw new Error('optimize: ' + (grantId.error || 'mintGrant failed'));
  // Per-format encoder knobs: sharp applies only the relevant ones; the advanced overlay may be unopened (default {}).
  const encoders = (state.pipelineAdvancedSettings && state.pipelineAdvancedSettings.optimize) || {};
  const r = await window.api.optimizeImage(srcPath, {
    quality: opts.quality,
    format: fmt,
    stripMetadata: opts.stripMetadata !== false,
    outputPath: out,
    encoders,
  }, grantId);
  // Log the optimization to the structured log pane so the user
  // can see every step.
  // (The post-process chain logs its own copy at the end
  // with the size savings; this is the lower-level helper
  // version that logs the raw success/failure of the IPC
  // call, so a stand-alone "Optimize" overlay also gets a
  // log entry.)
  if (typeof window.addLogEvent === 'function') {
    try {
      if (r && r.ok) {
        const inSize = humanSize(r.inputSize);
        const outSize = humanSize(r.outputSize);
        const saved = r.savedPercent || 0;
        const savedSuffix = saved >= 1 ? ` (−${saved}%)` : '';
        window.addLogEvent({
          category: 'optimize',
          result: 'ok',
          headline: `Optimized ${(out || '').split(/[\\/]/).pop()}${savedSuffix}`,
          details: [
            `Source: ${srcPath}`,
            `Output: ${out}`,
            `Size: ${inSize} → ${outSize} (${saved >= 0 ? '−' : '+'}${Math.abs(saved)}%)`,
            `Quality: ${r.quality || opts.quality}`,
            `Format: ${r.format || (fmt || 'keep')}`,
            `Metadata stripped: ${!!(r && r.strippedMetadata)}`,
          ],
        });
      } else {
        window.addLogEvent({
          category: 'error',
          result: 'err',
          headline: `Optimize failed: ${(r && r.error) || 'unknown error'}`,
          details: [`Source: ${srcPath}`, `Output: ${out}`],
        });
      }
    } catch (_) { /* best-effort */ }
  }
  if (!r || !r.ok) {
    const msg = (r && r.error) || 'Image optimisation failed.';
    const err = new Error(msg);
    err.result = r;
    throw err;
  }
  return r;
}

// Apply the full post-processing chain (upscale → auto-crop → remove
// background → optimize) to a single generated image. The chain runs
// once per generated file so variants 1..N all receive the same
// processing.
//
// Each step is wrapped in its own try/catch and falls back to the
// best-available path on failure. The chain returns the final path
// (which may equal `srcPath` if every step was a no-op or failed).
//
// Args:
//   srcPath: the generated file to process
//   opts:
//     label:    optional suffix to add to status messages (e.g. " (2/3)")
//     onStatus: optional callback (msg) => void for the
//               "Upscaling 2×…" / "Cropping…" / "Removing background…"
//               / "Optimizing…" status lines. If absent, the helper
//               just calls setStatus() + updates the image-tab preview
//               pane.
//     onRefresh: optional callback to call after a step that writes
//               a new file (so the folder explorer can update right
//               away). Callers (the image-tab gen handler, the
//               right-click "Optimize" overlay, etc.) decide when
//               to refresh.
async function runPostProcessChain(srcPath, opts) {
  opts = opts || {};
  const label = opts.label || '';
  const onStatus = opts.onStatus || ((msg) => {
    setStatus(msg, true);
    const preview = $(`#tab-${state.currentTab} .preview`);
    if (preview) preview.innerHTML = `<div class="empty"><span class="spinner"></span> ${escapeHtml(msg)}</div>`;
  });
  const onRefresh = opts.onRefresh || (() => { try { refreshBrowser(); } catch (_) {} });
  // R6.1/SYS-004: srcPath is immutable; only pipeline-produced intermediates may be deleted.
  let displayFile = srcPath;
  // If the Upscale checkbox is on, run the generated image through
  // the local upscaler after the mmx call returns. The preview then
  // shows the upscaled version, and the file browser gets the
  // new "<name>_Nx.png" file next to the original.
  if (state.upscaleEnabled && state.upscaleSettings) {
    try {
      onStatus(`Upscaling ${state.upscaleSettings.multiplier}×${label}…`);
      displayFile = await upscaleImageFile(displayFile, state.upscaleSettings.multiplier);
      addLogEvent({
        category: 'upscale',
        result: 'ok',
        headline: `Upscaled ${state.upscaleSettings.multiplier}×${label ? ' ' + label.trim() : ''} → ${displayFile.split(/[\\/]/).pop()}`,
        details: [
          `Source: ${srcPath}`,
          `Output: ${displayFile}`,
          `Multiplier: ${state.upscaleSettings.multiplier}×`,
        ],
      });
      toast(`Upscaled to ${state.upscaleSettings.multiplier}× → ${displayFile}`, 'ok', 3000);
      // If auto-crop is also on, apply it now. The flow mirrors
      // showUpscaleDirect: load the upscaled file, compute the
      // crop frame at the chosen anchor, write the cropped file
      // and delete the intermediate.
      if (state.upscaleSettings.autoCrop) {
        // BUG #7 fix: the auto-crop stage gets its own try/catch.
        // Pre-fix, a crop failure after a SUCCESSFUL upscale fell
        // into the outer upscale catch: the toast claimed 'Upscale
        // failed (kept original)' and displayFile was reset to
        // srcPath — orphaning the _Nx intermediate and lying to the
        // user. Now the upscaled file is kept (it's the deliverable)
        // and the crop failure is reported accurately.
        try {
          const a = state.upscaleSettings;
          const upImg = await loadImageFromFile(displayFile);
          const uW = upImg.naturalWidth;
          const uH = upImg.naturalHeight;
          const wantW = a.cropWidth || uW;
          const wantH = a.cropHeight || uH;
          const w = Math.min(wantW, uW);
          const h = Math.min(wantH, uH);
          const maxX = uW - w;
          const maxY = uH - h;
          let x, y;
          if (a.cropAnchorX === 'left')        x = 0;
          else if (a.cropAnchorX === 'right') x = maxX;
          else                                x = Math.floor(maxX / 2);
          if (a.cropAnchorY === 'top')         y = 0;
          else if (a.cropAnchorY === 'bottom') y = maxY;
          else                                y = Math.floor(maxY / 2);
          onStatus(`Cropping to ${w} × ${h}${label}…`);
          const cropped = await cropImageFile(displayFile, x, y, w, h);
          // R6.1: defensive guard (upscale ALWAYS produces a new file).
          // BGR-009 fix: mint delete grant (R1.3 gate).
          if (displayFile !== srcPath) { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(displayFile) : undefined; window.FbIntent.del(displayFile, dg).catch(() => {}); } // B-007 (hhhhu3 audit): delete via native confirmation
          displayFile = cropped;
          toast(`Upscaled ${state.upscaleSettings.multiplier}× and cropped to ${w} × ${h} → ${cropped}`, 'ok', 4000);
        } catch (cropErr) {
          console.error('Auto-crop failed (kept upscaled):', cropErr);
          toast('Auto-crop failed (kept upscaled): ' + (cropErr && cropErr.message || cropErr), 'warn', 4000);
        }
      }
      onRefresh();
    } catch (e) {
      console.error('Upscale failed:', e);
      toast('Upscale failed (kept original): ' + (e && e.message || e), 'warn', 4000);
      displayFile = srcPath;
    }
  }
  // "Remove background" stage — runs after upscale (if any) so
  // the user gets the transparent version of their final
  // image, not the raw generated file. Runs even when Upscale
  // is off (in that case the input is the raw generated file).
  // A failure here is non-fatal — we keep the (possibly
  // upscaled) displayFile and surface a warning, so the user
  // never loses the image they just paid API credits to
  // generate.
  if (state.removeBackgroundEnabled && displayFile) {
    try {
      onStatus(`Removing background${label}…`);
      const noBg = await removeBackgroundFile(displayFile);
      // R6.1/SYS-004: when no Upscale ran, displayFile IS the original paid API result; deleting it would destroy the user's image.
      if (noBg !== displayFile) {
        if (displayFile !== srcPath) {
          // BGR-009 fix: mint delete grant (R1.3 gate).
          const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(displayFile) : undefined;
          window.FbIntent.del(displayFile, dg).catch(() => {}); // B-007 (hhhhu3 audit): delete via native confirmation
        }
        displayFile = noBg;
      }
      addLogEvent({
        category: 'bg',
        result: 'ok',
        headline: `Background removed${label ? ' ' + label.trim() : ''} → ${displayFile.split(/[\\/]/).pop()}`,
        details: [
          `Source: ${srcPath}`,
          `Output: ${displayFile}`,
        ],
      });
      toast(`Background removed → ${displayFile}`, 'ok', 4000);
      onRefresh();
    } catch (e) {
      console.error('Remove background failed:', e);
      toast('Background removal failed (kept image): ' + (e && e.message || e), 'warn', 5000);
    }
  }
  // "Optimize / Compress" stage — runs as the LAST step of the
  // post-processing chain (generate → upscale → crop → remove
  // background → optimize) so the user's final deliverable
  // ends up in the smallest possible file. Uses the Sharp +
  // libvips pipeline in src/imageOptimizer.js, with
  // overwriteSource: true so the optimised bytes replace
  // the post-background-removal file in place (atomic
  // temp-file + rename on the main side). A failure here is
  // non-fatal — we keep the (possibly upscaled / no-bg)
  // displayFile and surface a warning, so the user never
  // loses the image they just paid API credits to generate.
  if (state.optimizeSettings && state.optimizeSettings.enabled && displayFile) {
    try {
      const oSet = state.optimizeSettings;
      const inFmt = (displayFile.split('.').pop() || '').toLowerCase();
      const fmtLbl = (oSet.format && oSet.format !== 'keep') ? oSet.format.toUpperCase() : inFmt.toUpperCase();
      onStatus(`Optimizing${label} (Q${oSet.quality} → ${fmtLbl})…`);
      const r = await optimizeImageFile(displayFile, {
        quality: oSet.quality,
        format: oSet.format,
        stripMetadata: oSet.stripMetadata !== false,
        overwriteSource: true,
      });
      if (r && r.outputPath && r.outputPath !== displayFile) {
        // R6.1: optimize uses overwriteSource:true; guard is defensive.
        if (displayFile !== srcPath) {
          // BGR-009 fix: mint delete grant (R1.3 gate).
          const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(displayFile) : undefined;
          window.FbIntent.del(displayFile, dg).catch(() => {}); // B-007 (hhhhu3 audit): delete via native confirmation
        }
        displayFile = r.outputPath;
      }
      // The Sharp wrapper always writes to outputPath; with
      // overwriteSource: true that's the same path as the
      // input. The renderer doesn't get a new path back, so
      // displayFile stays the same — the bytes behind it
      // are now the smaller, optimised version.
      const inSize = humanSize(r.inputSize);
      const outSize = humanSize(r.outputSize);
      const saved = r.savedPercent || 0;
      // cosm1 fix: toast() only recognises 'err'/'ok'/'warn' — 'info'
      // rendered as a neutral toast, hiding the author's intent to
      // flag a sub-1% saving. 'warn' matches the colorClass
      // convention in imageOptimizeOverlay.js.
      const tone = saved >= 1 ? 'ok' : 'warn';
      const savedSuffix = saved >= 1 ? ` (−${saved}%)` : '';
      addLogEvent({
        category: 'optimize',
        result: 'ok',
        headline: `Optimized${label ? ' ' + label.trim() : ''} ${fmtLbl} ${inSize} → ${outSize}${savedSuffix}`,
        details: [
          `File: ${displayFile}`,
          `Quality: ${oSet.quality}`,
          `Format: ${fmtLbl}`,
          `Strip metadata: ${oSet.stripMetadata !== false ? 'yes' : 'no'}`,
          `Size: ${inSize} → ${outSize} (${saved >= 0 ? '−' : '+'}${Math.abs(saved)}%)`,
        ],
      });
      toast(`Optimized ${fmtLbl} ${inSize} → ${outSize}${savedSuffix}`, tone, 4000);
      onRefresh();
    } catch (e) {
      console.error('Optimize failed:', e);
      toast('Optimize failed (kept image): ' + (e && e.message || e), 'warn', 5000);
    }
  }
  return displayFile;
}

// =================== Image-pipeline overlays ===================
// All three (Upscale settings, Crop, Convert) are pure modals built on
// showModal(). They share the same panel layout: title, description,
// form fields, action button, cancel.

// Settings overlay used by the "Upscale" checkbox in the image tab.
// Saves the chosen multiplier to state.upscaleSettings and closes; the
// checkbox stays checked so the next generation is upscaled.
function showUpscaleSettings() {
  if (!state.upscaleSettings) {
    state.upscaleSettings = { multiplier: 2, autoCrop: false, cropWidth: 0, cropHeight: 0, cropAnchorX: 'center', cropAnchorY: 'center' };
  }
  // Defensive: also fill in any missing fields on state.js that
  // pre-date the auto-crop support.
  const s = state.upscaleSettings;
  if (typeof s.autoCrop !== 'boolean') s.autoCrop = false;
  if (typeof s.cropWidth !== 'number') s.cropWidth = 0;
  if (typeof s.cropHeight !== 'number') s.cropHeight = 0;
  if (typeof s.cropAnchorX !== 'string') s.cropAnchorX = 'center';
  if (typeof s.cropAnchorY !== 'string') s.cropAnchorY = 'center';

  showModal((m, close) => {
    m.appendChild(el('h2', {}, '🔍 Upscale settings'));
    m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
      'When the Upscale checkbox is on, every generated image is upscaled locally with the settings below before being shown. Pure browser Canvas — no API call, no network. The "auto-crop" options here are also picked up by the "Add" button on the image tab and applied to every entry in a batch.'));

    // Multiplier
    const multSel = el('select', {});
    for (const m2 of [2, 3, 4]) {
      const opt = el('option', { value: String(m2) }, `${m2}× (larger)`);
      if (m2 === s.multiplier) opt.selected = true;
      multSel.appendChild(opt);
    }
    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Multiplier'), multSel]));

    // auto-crop checkbox
    const autoCropCb = el('input', { type: 'checkbox', class: 'auto-crop-cb' });
    autoCropCb.checked = !!s.autoCrop;
    m.appendChild(el('div', { class: 'row' }, [
      el('label', { class: 'auto-crop-label' }, [autoCropCb, ' auto-crop to resolution']),
    ]));

    // crop W/H inputs (hidden by default)
    const cropWInput = el('input', { type: 'number', min: '0', value: String(s.cropWidth || 0) });
    const cropHInput = el('input', { type: 'number', min: '0', value: String(s.cropHeight || 0) });
    const cropSizeRow = el('div', { class: 'row auto-crop-only' }, [
      el('label', {}, 'Crop target W × H (0 = use post-upscale target)'),
      cropWInput, el('span', {}, ' × '), cropHInput,
    ]);
    cropSizeRow.style.display = s.autoCrop ? '' : 'none';
    m.appendChild(cropSizeRow);

    // 3×3 anchor grid (hidden by default)
    const anchor = { x: s.cropAnchorX, y: s.cropAnchorY };
    const anchorGrid = el('div', { class: 'anchor-grid' });
    const cells = [];
    const GLYPHS = [
      ['↖', 'top-left',     'left',    'top'],
      ['↑', 'top-center',   'center',  'top'],
      ['↗', 'top-right',    'right',   'top'],
      ['←', 'middle-left',  'left',    'center'],
      ['·', 'center',       'center',  'center'],
      ['→', 'middle-right', 'right',   'center'],
      ['↙', 'bottom-left',  'left',    'bottom'],
      ['↓', 'bottom-center','center',  'bottom'],
      ['↘', 'bottom-right', 'right',   'bottom'],
    ];
    for (let i = 0; i < GLYPHS.length; i++) {
      const [glyph, name, x, y] = GLYPHS[i];
      const cell = el('button', {
        type: 'button',
        class: 'anchor-cell' + (x === anchor.x && y === anchor.y ? ' selected' : ''),
        title: `Anchor: ${name} (crop keeps the ${name} corner)`,
        'data-x': x, 'data-y': y,
      }, glyph);
      cell.addEventListener('click', () => {
        for (const c of cells) c.classList.remove('selected');
        cell.classList.add('selected');
        anchor.x = x;
        anchor.y = y;
      });
      cells.push(cell);
      anchorGrid.appendChild(cell);
    }
    anchorGrid.style.display = s.autoCrop ? '' : 'none';
    m.appendChild(anchorGrid);

    function setAutoCropVisible(on) {
      cropSizeRow.style.display = on ? '' : 'none';
      anchorGrid.style.display = on ? '' : 'none';
    }
    autoCropCb.addEventListener('change', () => setAutoCropVisible(autoCropCb.checked));

    // ---- "Remove background" sub-section ----
    // Sits BELOW the upscale + auto-crop controls because it's the
    // last step in the pipeline (generate → upscale → crop →
    // background removal). The checkbox only saves the boolean
    // (and gates the whole section); the right-click "Remove
    // background" item still works regardless of this toggle.
    // We probe the isnetbg binary in the background so the UI can
    // show a precise "not installed" hint when needed (rather than
    // letting the user enable the toggle and only discover the
    // missing binary at generation time).
    const removeBgCb = el('input', { type: 'checkbox' });
    removeBgCb.checked = !!state.removeBackgroundEnabled;
    const removeBgStatus = el('span', { class: 'meta', style: 'color: var(--fg-2); font-size: 11px; margin-left: 8px;' }, '');
    const removeBgRow = el('div', { class: 'row' }, [
      el('label', { class: 'auto-crop-label' }, [removeBgCb, ' ✨ Remove background after upscale']),
      removeBgStatus,
    ]);
    m.appendChild(removeBgRow);
    m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 11px; margin: 2px 0 0;' },
      'Runs the optional isnetbg binary on the upscaled (and optionally cropped) image and writes a transparent PNG. The original file is preserved as the input to this step.'));
    // GPU sub-toggle. Visible only when the main checkbox is on, so
    // we don't tease a knob the user can't currently act on.
    const useGpuCb = el('input', { type: 'checkbox' });
    useGpuCb.checked = state.removeBackgroundUseGpu !== false;
    const useGpuRow = el('div', { class: 'row auto-crop-only' }, [
      el('label', { class: 'auto-crop-label' }, [useGpuCb, ' use GPU acceleration (DirectML / CUDA)']),
    ]);
    useGpuRow.style.display = removeBgCb.checked ? '' : 'none';
    m.appendChild(useGpuRow);

    // Model selection dropdown
    const modelSelect = el('select', { id: 'bgModelSelect', style: 'margin-left: 8px;' });
    const modelStatusSpan = el('span', { class: 'meta', style: 'color: var(--fg-2); font-size: 11px; margin-left: 8px;' }, '');
    const downloadBtn = el('button', { style: 'margin-left: 8px; display: none;' }, 'Download');
    const progressSpan = el('span', { class: 'meta', style: 'color: var(--fg-2); font-size: 11px; margin-left: 8px; display: none;' }, '');

    const modelRow = el('div', { class: 'row auto-crop-only', style: 'margin-top: 4px;' }, [
      el('label', { class: 'auto-crop-label' }, ['Model: ', modelSelect]),
      modelStatusSpan,
      downloadBtn,
      progressSpan
    ]);
    modelRow.style.display = removeBgCb.checked ? '' : 'none';
    m.appendChild(modelRow);

    let modelsInfo = {};

    async function populateModels() {
      try {
        const st = await window.probeIsnetbgStatus(true);
        modelsInfo = st.models || {};
        modelSelect.innerHTML = '';
        
        for (const key of Object.keys(modelsInfo)) {
          const mInfo = modelsInfo[key];
          const optionText = mInfo.label + (mInfo.present ? '' : ` — not downloaded (${mInfo.sizeMB} MB)`);
          const opt = el('option', { value: key }, optionText);
          modelSelect.appendChild(opt);
        }
        
        // gewv2 GEW-010 fix: default to the higher-quality bundled model.
        const currentModel = state.removeBackgroundModel || 'birefnet-general-lite';
        modelSelect.value = currentModel;
        updateDownloadButton();
      } catch (err) {
        console.error('Failed to populate models:', err);
      }
    }

    function updateDownloadButton() {
      const selectedKey = modelSelect.value;
      const mInfo = modelsInfo[selectedKey];
      if (mInfo && !mInfo.present && mInfo.downloadable) {
        downloadBtn.style.display = '';
        modelStatusSpan.textContent = `(${mInfo.sizeMB} MB required)`;
        modelStatusSpan.style.color = 'var(--warn, #d9a300)';
      } else {
        downloadBtn.style.display = 'none';
        modelStatusSpan.textContent = '';
      }
    }

    modelSelect.addEventListener('change', () => {
      state.removeBackgroundModel = modelSelect.value;
      updateDownloadButton();
    });

    let cancelDownloadProgress = null;

    downloadBtn.addEventListener('click', async () => {
      const selectedKey = modelSelect.value;
      const mInfo = modelsInfo[selectedKey];
      if (!mInfo) return;

      downloadBtn.disabled = true;
      modelSelect.disabled = true;
      progressSpan.style.display = '';
      progressSpan.textContent = 'Starting download...';

      if (cancelDownloadProgress) cancelDownloadProgress();

      cancelDownloadProgress = window.api.onIsnetbgDownloadProgress(({ downloaded, total }) => {
        const dlMB = (downloaded / 1048576).toFixed(0);
        const totMB = (total / 1048576).toFixed(0);
        progressSpan.textContent = `${dlMB} / ${totMB} MB`;
      });

      try {
        const res = await window.api.isnetbgDownloadModel(selectedKey);
        if (res.ok) {
          toast(`Downloaded ${mInfo.label} successfully.`, 'ok', 3000);
          await populateModels();
        } else {
          toast(`Download failed: ${res.error}`, 'warn', 5000);
        }
      } catch (err) {
        toast(`Download failed: ${err.message || err}`, 'warn', 5000);
      } finally {
        if (cancelDownloadProgress) {
          cancelDownloadProgress();
          cancelDownloadProgress = null;
        }
        downloadBtn.disabled = false;
        modelSelect.disabled = false;
        progressSpan.style.display = 'none';
      }
    });

    function setRemoveBgVisible(on) {
      useGpuRow.style.display = on ? '' : 'none';
      modelRow.style.display = on ? '' : 'none';
    }
    removeBgCb.addEventListener('change', () => setRemoveBgVisible(removeBgCb.checked));
    // Probe the binary in the background and surface a precise
    // status. We use a small helper so the right-click "Remove
    // background" action can reuse the same probe + status text.
    probeIsnetbgStatus().then((st) => {
      if (!st.checked) return;
      if (st.available && st.modelPresent) {
        // Same binary/node disambiguation as the add-ons popup.
        const isNode = st.version === 'node-onnxruntime';
        if (isNode) {
          removeBgStatus.textContent = '(IS-Net Node.js wrapper + model detected)';
        } else {
          const v = st.version ? ` v${st.version}` : '';
          removeBgStatus.textContent = `(isnetbg binary${v} + model detected)`;
        }
        removeBgStatus.style.color = 'var(--fg-2)';
      } else if (st.available && !st.modelPresent) {
        removeBgStatus.textContent = '(binary installed, model missing — see README)';
        removeBgStatus.style.color = 'var(--warn, #d9a300)';
      } else {
        removeBgStatus.textContent = '(not installed — see README)';
        removeBgStatus.style.color = 'var(--warn, #d9a300)';
      }
      populateModels();
    });

    // "Re-open add-ons" link. The full install UI lives in
    // openOptionalAddons() and is shown as a first-run popup;
    // this link gives the user a one-click re-entry from the
    // settings popup without having to dig through the README.
    // Cached probe is invalidated inside openOptionalAddons
    // after every install, so the next time the user opens
    // THIS popup the new status is reflected.
    const reopenLink = el('button', {
      class: 'btn-mini',
      style: 'margin-top: 6px;',
      onclick: () => openOptionalAddons({ autoOpened: false }),
    }, '🧩 Re-open add-ons manager…');
    m.appendChild(reopenLink);

    // ---- Section 3: 🗜 Optimize / Compress (post-generation) ----
    // Re-encodes every generated image with the Sharp + libvips
    // pipeline in src/imageOptimizer.js. Sits at the END of the
    // post-processing chain (generate → upscale → crop → remove
    // background → optimize) so the user's final deliverable
    // lands in the smallest possible file. The right-click
    // "Optimize / Compress…" entry in the folder browser uses
    // the same settings as defaults.
    if (!state.optimizeSettings) {
      state.optimizeSettings = { enabled: false, quality: 82, format: 'keep', stripMetadata: true };
    }
    const oSet = state.optimizeSettings;
    if (typeof oSet.enabled !== 'boolean') oSet.enabled = false;
    if (typeof oSet.quality !== 'number') oSet.quality = 82;
    if (typeof oSet.format !== 'string') oSet.format = 'keep';
    if (typeof oSet.stripMetadata !== 'boolean') oSet.stripMetadata = true;

    const optimizeCb = el('input', { type: 'checkbox' });
    optimizeCb.checked = !!oSet.enabled;
    m.appendChild(el('div', { class: 'row' }, [
      el('label', { class: 'auto-crop-label' }, [optimizeCb, ' 🗜 Optimize / compress the final image']),
    ]));
    m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 11px; margin: 2px 0 0;' },
      'Re-encodes the final image with Sharp + libvips to shrink its file size while preserving best-possible visual quality. Runs as the LAST step of the post-generation pipeline so the output you end up with is the smallest version that still looks the same.'));

    // Quality slider (1..100, default 82 — the perceptual sweet
    // spot for JPEG / WebP). Visible only when the master
    // checkbox is on, so we don't tease a knob the user can't
    // currently act on.
    const qualityInput = el('input', { type: 'range', min: '1', max: '100', step: '1', value: String(oSet.quality) });
    const qualityLabel = el('span', { class: 'meta', style: 'min-width: 32px; text-align: right;' }, String(qualityInput.value));
    function syncQuality() { qualityLabel.textContent = String(qualityInput.value); }
    qualityInput.addEventListener('input', syncQuality);
    const qualityRow = el('div', { class: 'row auto-crop-only' }, [
      el('label', {}, 'Quality'),



      qualityInput,
      qualityLabel,
    ]);
    qualityRow.style.display = optimizeCb.checked ? '' : 'none';
    m.appendChild(qualityRow);

    // Format dropdown (Keep / JPEG / PNG / WebP / AVIF). Same
    // shape as the right-click overlay; "Keep" preserves the
    // source format.
    const fmtSel = el('select', {});
    for (const [v, lbl] of [
      ['keep', 'Keep source format'],
      ['jpeg', 'JPEG (smallest lossy, no transparency)'],
      ['png',  'PNG  (lossless, supports transparency)'],
      ['webp', 'WebP (modern, ~30% smaller than JPEG)'],
      ['avif', 'AVIF (newest, smallest files, slow encode)'],
    ]) {
      const opt = el('option', { value: v }, lbl);
      if (oSet.format === v) opt.selected = true;
      fmtSel.appendChild(opt);
    }
    const fmtRow = el('div', { class: 'row auto-crop-only' }, [el('label', {}, 'Output format'), fmtSel]);
    fmtRow.style.display = optimizeCb.checked ? '' : 'none';
    m.appendChild(fmtRow);

    // Strip-metadata checkbox. On by default — drops EXIF
    // (camera model, GPS, software tag) but keeps the ICC
    // colour profile.
    const stripCb = el('input', { type: 'checkbox' });
    stripCb.checked = oSet.stripMetadata !== false;
    const stripRow = el('div', { class: 'row auto-crop-only' }, [
      el('label', { class: 'auto-crop-label' }, [stripCb, ' Strip non-essential EXIF (keeps ICC colour profile)']),
    ]);
    stripRow.style.display = optimizeCb.checked ? '' : 'none';
    m.appendChild(stripRow);
    function setOptimizeVisible(on) {
      qualityRow.style.display = on ? '' : 'none';
      fmtRow.style.display = on ? '' : 'none';
      stripRow.style.display = on ? '' : 'none';
    }
    optimizeCb.addEventListener('change', () => setOptimizeVisible(optimizeCb.checked));

    // Save
    const saveBtn = el('button', { class: 'primary' }, 'Save');
    const cancelBtn = el('button', { onclick: close }, 'Cancel');
    saveBtn.addEventListener('click', async () => {
      state.upscaleSettings = {
        multiplier: parseInt(multSel.value, 10) || 2,
        autoCrop: autoCropCb.checked,
        cropWidth: Math.max(0, parseInt(cropWInput.value, 10) || 0),
        cropHeight: Math.max(0, parseInt(cropHInput.value, 10) || 0),
        cropAnchorX: anchor.x,
        cropAnchorY: anchor.y,
      };
      state.removeBackgroundEnabled = !!removeBgCb.checked;
      state.removeBackgroundUseGpu = !!useGpuCb.checked;
      state.removeBackgroundModel = modelSelect.value;
      state.optimizeSettings = {
        enabled: !!optimizeCb.checked,
        quality: Math.max(1, Math.min(100, parseInt(qualityInput.value, 10) || 82)),
        format: ['keep', 'jpeg', 'png', 'webp', 'avif'].includes(fmtSel.value) ? fmtSel.value : 'keep',
        stripMetadata: !!stripCb.checked,
      };
      // This modal only configures upscale/bg-removal/optimize
      // SETTINGS. Whether upscaling is actually enabled is owned
      // exclusively by the dedicated "🔍 Upscale" checkbox in the
      // tab action bar (imageTab.js upscaleCb), which is how the
      // user opened this modal in the first place (clicking the label
      // next to that checkbox). Toggling it here would mean opening
      // the modal just to turn on background-removal (with upscale
      // left unchecked) silently turns upscaling on too.
      await scheduleStateSave();
      const extras = [];
      if (state.upscaleSettings.autoCrop) extras.push('auto-crop');
      if (state.removeBackgroundEnabled) extras.push('remove-background');
      if (state.optimizeSettings.enabled) {
        extras.push('optimize Q' + state.optimizeSettings.quality);
      }
      const extra = extras.length ? ' + ' + extras.join(' + ') : '';
      // The "🔍 Upscale 2×" label in the image tab was updated by
      // a closure inside build(); that closure is long gone by
      // the time the user opens this modal. refreshUpscaleLabel
      // is the module-level re-render that picks up the new
      // multiplier + .active class via DOM query.
      if (typeof refreshUpscaleLabel === 'function') refreshUpscaleLabel();
      toast(`Upscale settings saved (${state.upscaleSettings.multiplier}×${extra}).`, 'ok', 2000);
      close();
    });
    m.appendChild(el('div', { class: 'footer' }, [cancelBtn, saveBtn]));
  });
}

// Direct upscale overlay used by the right-click menu on an image
// in the file browser. Shows the source resolution + the target
// resolution after upscaling, an "auto-crop to resolution" toggle,
// and (when that toggle is on) a 3×3 anchor grid + W/H inputs so
// the user can upscale AND crop in one step. The flow:
//   1. upscaleImageFile() writes `<name>_Nx.png` to output_dir.
//   2. If auto-crop is on, cropImageFile() reads it back, places
//      the crop frame at the chosen anchor (top-left, center,
//      bottom-right, etc.), writes `<name>_Nx_cropped_WxH.png`,
//      and the intermediate `_Nx` file is deleted.
//   3. The cropped file is shown in the preview pane.


async function showUpscaleDirect(srcPath, targets, opts) {
  // Multi-select batch: when ≥2 images are checked in the folder
  // explorer, `targets` holds all of them and the whole upscale (+
  // optional crop + optional background-removal) pipeline runs on
  // every one with the settings chosen here. The
  // dialog's resolution/crop-preview UI still reflects the primary
  // (right-clicked) srcPath.
  const batch = Array.isArray(targets) && targets.length > 1 ? targets.slice() : null;
  // We need the source's natural resolution to compute the target.
  // If the image is unreadable, surface the error and bail — the
  // dialog needs a known sourceW × sourceH to do anything useful.
  let srcW = 0, srcH = 0;
  try {
    const img = await loadImageFromFile(srcPath);
    srcW = img.naturalWidth;
    srcH = img.naturalHeight;
    if (!srcW || !srcH) throw new Error('Image has no natural dimensions');
  } catch (e) {
    toast('Failed to load image: ' + (e && e.message || e), 'err', 6000);
    return;
  }
  // Pull defaults from the global upscale settings so the
  // right-click "Upscale" dialog and the tab's "Upscale Settings"
  // dialog are in sync. The user can still change anything for
  // this one-off run; the Save below updates state.upscaleSettings
  // if they do, so the next right-click / next generation sees
  // the new values.
  const us = state.upscaleSettings || { multiplier: 2, autoCrop: false, cropWidth: 0, cropHeight: 0, cropAnchorX: 'center', cropAnchorY: 'center' };
  showModal((m, close) => {
    m.appendChild(el('h2', {}, '🔍 Upscale image'));
    m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px;' },
      batch ? `Upscaling ${batch.length} selected images — settings below apply to all.` : 'Source: ' + srcPath));

    // Resolution row: source (immutable) + target after upscale (live).
    // The target updates whenever the multiplier or crop W/H changes.
    const targetText = el('div', { class: 'meta' }, '');
    function refreshTarget() {
      const mult = parseInt(multSel.value, 10) || 2;
      const tW = srcW * mult;
      const tH = srcH * mult;
      // 0 = use post-upscale target. Negative is impossible (the
      // min="0" attribute + Math.max in the save handler guard it).
      const wantCropW = parseInt(cropWInput.value, 10);
      const wantCropH = parseInt(cropHInput.value, 10);
      const cropW = (isNaN(wantCropW) || wantCropW <= 0) ? tW : wantCropW;
      const cropH = (isNaN(wantCropH) || wantCropH <= 0) ? tH : wantCropH;
      const w = Math.min(cropW, tW);
      const h = Math.min(cropH, tH);
      const cropNote = autoCropCb.checked ? ` · after auto-crop: ${w} × ${h} px` : '';
      targetText.textContent = `Source ${srcW} × ${srcH} px  →  after upscale: ${tW} × ${tH} px${cropNote}`;
    }

    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Resolution'), targetText]));

    // Multiplier selector (2× / 3× / 4× / 8×).
    const multSel = el('select', {});
    for (const m2 of [2, 3, 4, 8]) {
      const opt = el('option', { value: String(m2) }, `${m2}×`);
      if (m2 === (us.multiplier || 2)) opt.selected = true;
      multSel.appendChild(opt);
    }
    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Multiplier'), multSel]));

    // Model selector
    const modelSel = el('select', {});
    const modelOptions = ((window.PipelineModel && window.PipelineModel.REALESRGAN_MODEL_DETAILS) || [])
      .map((m) => [m.value, m.label]);
    for (const [val, lbl] of modelOptions) {
      const opt = el('option', { value: val }, lbl);
      if (val === (state.realesrganModel || 'realesrgan-x4plus')) opt.selected = true;
      modelSel.appendChild(opt);
    }
    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Model'), modelSel]));

    // auto-crop checkbox. Pre-checked from state.upscaleSettings.
    const autoCropCb = el('input', { type: 'checkbox', class: 'auto-crop-cb' });
    autoCropCb.checked = !!us.autoCrop;
    m.appendChild(el('div', { class: 'row' }, [
      el('label', { class: 'auto-crop-label' }, [autoCropCb, ' auto-crop to resolution']),
    ]));

    // Crop W / H inputs. Hidden by default; revealed when auto-crop
    // is checked. Pre-filled from state.upscaleSettings (or 0 = use
    // post-upscale target).
    const cropWInput = el('input', { type: 'number', min: '0', value: String(us.cropWidth || 0) });
    const cropHInput = el('input', { type: 'number', min: '0', value: String(us.cropHeight || 0) });
    const cropSizeRow = el('div', { class: 'row auto-crop-only' }, [
      el('label', {}, 'Crop target W × H (0 = use post-upscale target)'),
      cropWInput, el('span', {}, ' × '), cropHInput,
    ]);
    cropSizeRow.style.display = us.autoCrop ? '' : 'none';
    m.appendChild(cropSizeRow);

    // 3×3 anchor grid. Each cell = an (x, y) anchor in {left,
    // center, right} × {top, center, bottom}. The selected cell
    // comes from state.upscaleSettings.
    const anchor = { x: us.cropAnchorX || 'center', y: us.cropAnchorY || 'center' };
    const anchorGrid = el('div', { class: 'anchor-grid' });
    const cells = [];
    const GLYPHS = [
      ['↖', 'top-left',     'left',    'top'],
      ['↑', 'top-center',   'center',  'top'],
      ['↗', 'top-right',    'right',   'top'],
      ['←', 'middle-left',  'left',    'center'],
      ['·', 'center',       'center',  'center'],
      ['→', 'middle-right', 'right',   'center'],
      ['↙', 'bottom-left',  'left',    'bottom'],
      ['↓', 'bottom-center','center',  'bottom'],
      ['↘', 'bottom-right', 'right',   'bottom'],
    ];
    for (let i = 0; i < GLYPHS.length; i++) {
      const [glyph, name, x, y] = GLYPHS[i];
      const cell = el('button', {
        type: 'button',
        class: 'anchor-cell' + (x === anchor.x && y === anchor.y ? ' selected' : ''),
        title: `Anchor: ${name} (crop keeps the ${name} corner)`,
        'data-x': x, 'data-y': y,
      }, glyph);
      cell.addEventListener('click', () => {
        for (const c of cells) c.classList.remove('selected');
        cell.classList.add('selected');
        anchor.x = x;
        anchor.y = y;
      });
      cells.push(cell);
      anchorGrid.appendChild(cell);
    }
    anchorGrid.style.display = us.autoCrop ? '' : 'none';
    m.appendChild(anchorGrid);

    // A short explanation of the cropping section, so the user
    // doesn't have to guess what the 3×3 grid + W × H inputs
    // actually do. Uses inline <code> tags for the glyphs.
    const cropExplanation = el('div', { class: 'crop-explanation' }, [
      'When you click Upscale, the image is first scaled up by ',
      el('strong', {}, `${us.multiplier || 2}×`),
      ' (using the Real-ESRGAN binary if installed, otherwise multi-step canvas upscaling), then ',
      el('strong', {}, 'cropped'),
      ' to the target W × H at the chosen anchor. The 3×3 grid above picks the anchor: ',
      el('code', {}, '↖'),
      ' keeps the ',
      el('strong', {}, 'top-left'),
      ' corner, ',
      el('code', {}, '·'),
      ' keeps equal borders on all four sides, ',
      el('code', {}, '↘'),
      ' keeps the ',
      el('strong', {}, 'bottom-right'),
      '.',
    ]);
    cropExplanation.style.display = us.autoCrop ? '' : 'none';
    m.appendChild(cropExplanation);

    // Blank-image crop preview: a fixed 200×150 "source" with a
    // green crop frame overlay that updates whenever the user
    // picks a different anchor (or changes the W × H inputs).
    // The frame is sized proportionally to the post-upscale
    // target W × H so the user can see how much of the image
    // is actually kept.
    const cropPreviewBlock = el('div', { class: 'crop-preview' });
    const stage = el('div', { class: 'crop-preview-stage' });
    const blank = el('div', { class: 'crop-preview-image' });
    const frame = el('div', { class: 'crop-preview-frame' });
    stage.append(blank, frame);
    cropPreviewBlock.appendChild(stage);
    const legend = el('div', { class: 'crop-preview-legend' });
    cropPreviewBlock.appendChild(legend);
    const ANCHOR_LABELS = {
      'left-top':       'top-left',
      'center-top':     'top-center',
      'right-top':      'top-right',
      'left-center':    'middle-left',
      'center-center':  'center',
      'right-center':   'middle-right',
      'left-bottom':    'bottom-left',
      'center-bottom':  'bottom-center',
      'right-bottom':   'bottom-right',
    };
    function refreshCropPreview() {
      const mult = parseInt(multSel.value, 10) || 2;
      const geo = (window.CropPreviewGeometry && window.CropPreviewGeometry.computeStageSize)
        ? window.CropPreviewGeometry.computeStageSize(srcW, srcH)
        : { stageW: 200, stageH: 150 };
      const stageW = geo.stageW, stageH = geo.stageH;
      stage.style.width = stageW + 'px';
      stage.style.height = stageH + 'px';
      // Stage now matches the source aspect, so the displayed source fills it (no letterboxing, no offset).
      const dispSrcW = stageW;
      const dispSrcH = stageH;
      const srcOffsetX = 0;
      const srcOffsetY = 0;
      // Frame size: use the user's W × H if set, otherwise the
      // full post-upscale target.
      const tW = srcW * mult;
      const tH = srcH * mult;
      const wantW = parseInt(cropWInput.value, 10);
      const wantH = parseInt(cropHInput.value, 10);
      let cropW = (Number.isFinite(wantW) && wantW > 0) ? Math.min(wantW, tW) : tW;
      let cropH = (Number.isFinite(wantH) && wantH > 0) ? Math.min(wantH, tH) : tH;
      // Scale the frame to the displayed source size.
      const scale = dispSrcW / tW;
      const frameW = cropW * scale;
      const frameH = cropH * scale;
      const maxX = dispSrcW - frameW;
      const maxY = dispSrcH - frameH;
      let x, y;
      if (anchor.x === 'left')       x = 0;
      else if (anchor.x === 'right') x = maxX;
      else                            x = Math.floor(maxX / 2);
      if (anchor.y === 'top')         y = 0;
      else if (anchor.y === 'bottom') y = maxY;
      else                            y = Math.floor(maxY / 2);
      frame.style.width = frameW + 'px';
      frame.style.height = frameH + 'px';
      frame.style.left = (srcOffsetX + x) + 'px';
      frame.style.top = (srcOffsetY + y) + 'px';
      // Position the blank "image" to match the source size.
      blank.style.left = srcOffsetX + 'px';
      blank.style.top = srcOffsetY + 'px';
      blank.style.width = dispSrcW + 'px';
      blank.style.height = dispSrcH + 'px';
      // Legend.
      legend.innerHTML = '';
      const name = ANCHOR_LABELS[anchor.x + '-' + anchor.y] || 'center';
      legend.appendChild(document.createTextNode('Anchor: '));
      legend.appendChild(el('span', { class: 'crop-preview-anchor-name' }, name));
      legend.appendChild(document.createTextNode(' — the green frame shows what will be kept.'));
    }
    cropPreviewBlock.style.display = us.autoCrop ? '' : 'none';
    m.appendChild(cropPreviewBlock);

    // Toggle the auto-crop sub-UI. We do this in a single place so
    // the show / hide stays in sync and the target text always
    // reflects the current state.
    function setAutoCropVisible(on) {
      cropSizeRow.style.display = on ? '' : 'none';
      anchorGrid.style.display = on ? '' : 'none';
      cropExplanation.style.display = on ? '' : 'none';
      cropPreviewBlock.style.display = on ? '' : 'none';
      if (on) {
        // The preview depends on a few derived values; recompute
        // on show so the user sees the current W × H + anchor.
        refreshCropPreview();
      }
      refreshTarget();
    }
    autoCropCb.addEventListener('change', () => setAutoCropVisible(autoCropCb.checked));
    multSel.addEventListener('change', refreshTarget);
    cropWInput.addEventListener('input', refreshTarget);
    cropHInput.addEventListener('input', refreshTarget);
    // The crop preview also re-renders on any input change.
    multSel.addEventListener('change', refreshCropPreview);
    cropWInput.addEventListener('input', refreshCropPreview);
    cropHInput.addEventListener('input', refreshCropPreview);
    // Each anchor cell already updates anchor.x/y; we also
    // re-render the crop preview on click.
    for (const cell of cells) cell.addEventListener('click', refreshCropPreview);
    setAutoCropVisible(!!us.autoCrop); // also primes the W/H inputs + target text
    if (us.autoCrop) refreshCropPreview();

    // ---- "Remove background" sub-section for the right-click dialog ----
    // Pre-checked from state.removeBackgroundEnabled (same default as
    // the in-tab flow). Lives BELOW the upscale + crop UI so it reads
    // as the final pipeline step. A status badge next to the checkbox
    // tells the user whether the binary + model are installed, so they
    // don't click "Upscale" expecting a transparent result and only
    // discover the missing binary halfway through.
    const noBgCb = el('input', { type: 'checkbox' });
    noBgCb.checked = !!state.removeBackgroundEnabled;
    const noBgStatus = el('span', { class: 'meta', style: 'color: var(--fg-2); font-size: 11px; margin-left: 8px;' }, '');
    m.appendChild(el('div', { class: 'row' }, [
      el('label', { class: 'auto-crop-label' }, [noBgCb, ' ✨ Remove background after upscale']),
      noBgStatus,
    ]));
    probeIsnetbgStatus().then((st) => {
      if (!st.checked) return;
      if (st.available && st.modelPresent) {
        // Same binary/node disambiguation as the add-ons popup.
        const isNode = st.version === 'node-onnxruntime';
        if (isNode) {
          noBgStatus.textContent = '(IS-Net Node.js wrapper + model detected)';
        } else {
          const v = st.version ? ` v${st.version}` : '';
          noBgStatus.textContent = `(isnetbg binary${v} + model detected)`;
        }
        noBgStatus.style.color = 'var(--fg-2)';
      } else if (st.available && !st.modelPresent) {
        noBgStatus.textContent = '(model missing — see README)';
        noBgStatus.style.color = 'var(--warn, #d9a300)';
      } else {
        noBgStatus.textContent = '(not installed)';
        noBgStatus.style.color = 'var(--warn, #d9a300)';
      }
    });

    if (!state.pipelineAdvancedSettings) state.pipelineAdvancedSettings = {};
    if (!state.pipelineAdvancedSettings.realesrgan) state.pipelineAdvancedSettings.realesrgan = {};
    const adv = state.pipelineAdvancedSettings.realesrgan;

    const advDetails = el('details', {});
    advDetails.appendChild(el('summary', {}, 'Advanced Real-ESRGAN Settings'));
    
    const tileInp = el('input', { type: 'number', min: '0', max: '4096', step: '32', value: String(adv.tileSize || 0) });
    const ttaCb = el('input', { type: 'checkbox' });
    ttaCb.checked = !!adv.ttaMode;
    const gpuInp = el('input', { type: 'text', value: adv.gpuId || 'auto', placeholder: 'auto or 0,1,2...' });

    advDetails.appendChild(el('div', { class: 'row', style: 'margin-top: 8px;' }, [
      el('label', { title: '0 = auto' }, 'Tile size (0=auto, >=32)'), tileInp
    ]));
    advDetails.appendChild(el('div', { class: 'row' }, [
      el('label', {}, [ttaCb, ' Enable TTA mode (Test-Time Augmentation)'])
    ]));
    advDetails.appendChild(el('div', { class: 'row' }, [
      el('label', {}, 'GPU ID'), gpuInp
    ]));
    
    m.appendChild(advDetails);

    const upscaleBtn = el('button', { class: 'primary' }, 'Upscale');
    const cancelBtn = el('button', { onclick: close }, 'Cancel');
    upscaleBtn.addEventListener('click', async () => {
      const multiplier = parseInt(multSel.value, 10) || 2;
      // Persist whatever the user just configured so the next
      // right-click / next batch / next ⚙ Settings visit sees
      // the same values. We don't scheduleStateSave() here
      // (the action is fire-and-forget and the user can cancel);
      // scheduleStateSave() is called below on success.
      state.upscaleSettings = {
        multiplier,
        autoCrop: !!autoCropCb.checked,
        cropWidth: Math.max(0, parseInt(cropWInput.value, 10) || 0),
        cropHeight: Math.max(0, parseInt(cropHInput.value, 10) || 0),
        cropAnchorX: anchor.x,
        cropAnchorY: anchor.y,
      };
      state.realesrganModel = modelSel.value;
      
      state.pipelineAdvancedSettings.realesrgan.tileSize = parseInt(tileInp.value, 10) || 0;
      state.pipelineAdvancedSettings.realesrgan.ttaMode = !!ttaCb.checked;
      state.pipelineAdvancedSettings.realesrgan.gpuId = gpuInp.value.trim() || 'auto';
      // Persist the background-removal toggle too. The right-click
      // dialog is the natural place for users to flip this on /
      // off; making it sticky avoids re-checking the same box on
      // the next image.
      state.removeBackgroundEnabled = !!noBgCb.checked;
      // This is a one-off action on a single already-generated file
      // — it must NOT flip the tab's "🔍 Upscale"
      // auto-upscale-on-generate switch (state.upscaleEnabled is owned
      // exclusively by that dedicated checkbox).
      upscaleBtn.disabled = true; upscaleBtn.textContent = 'Upscaling…';
      // Snapshot the settings once so a single runOne() body serves both
      // the single-file and the batch path (and can't be perturbed by a
      // stray input event mid-run).
      const doCrop = !!autoCropCb.checked;
      const wantCropW = Math.max(1, parseInt(cropWInput.value, 10) || 1);
      const wantCropH = Math.max(1, parseInt(cropHInput.value, 10) || 1);
      const anchorX = anchor.x, anchorY = anchor.y;
      const doBg = !!noBgCb.checked;

      // Run the full pipeline on ONE image. Returns the path of the file
      // to keep (upscaled → optionally cropped → optionally bg-removed).
      // `quiet` suppresses per-file toasts + button-text updates so the
      // batch worker owns the progress/summary UI. Upscale/crop failures
      // throw (fatal for that item); background removal is non-fatal (the
      // upscaled/cropped file is kept and a warning shows in single mode).
      const runOne = async (path, quiet) => {
        const upscaled = await upscaleImageFile(path, multiplier);
        let out = upscaled;
        let bgRemoved = false;
        if (doCrop) {
          if (!quiet) upscaleBtn.textContent = 'Cropping…';
          // Need the actual upscaled dimensions to anchor correctly.
          const upImg = await loadImageFromFile(upscaled);
          const uW = upImg.naturalWidth;
          const uH = upImg.naturalHeight;
          // Clamp the crop to the upscaled size; anchor otherwise.
          const w = Math.min(wantCropW, uW);
          const h = Math.min(wantCropH, uH);
          const maxX = uW - w;
          const maxY = uH - h;
          let x, y;
          if (anchorX === 'left')       x = 0;
          else if (anchorX === 'right') x = maxX;
          else                           x = Math.floor(maxX / 2);
          if (anchorY === 'top')         y = 0;
          else if (anchorY === 'bottom') y = maxY;
          else                           y = Math.floor(maxY / 2);
          const cropped = await cropImageFile(upscaled, x, y, w, h);
          // Drop the intermediate (full-upscaled) file — the user
          // asked for the cropped one, not the raw intermediate.
          // BGR-009 fix: mint delete grant (R1.3 gate).
          { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(upscaled) : undefined; window.FbIntent.del(upscaled, dg).catch(() => {}); } // B-007 (hhhhu3 audit): delete via native confirmation
          out = cropped;
        }
        // Optional background removal. Non-fatal: a missing / failed
        // binary keeps the upscaled (or cropped) file as the deliverable,
        // so the user never loses the image they already paid API
        // credits to generate.
        if (doBg) {
          if (!quiet) upscaleBtn.textContent = 'Removing background…';
          try {
            const noBg = await removeBackgroundFile(out);
            if (noBg !== out) {
              // BGR-009 fix: mint delete grant (R1.3 gate).
              const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(out) : undefined;
              window.FbIntent.del(out, dg).catch(() => {}); // B-007 (hhhhu3 audit): delete via native confirmation
              out = noBg;
            }
            bgRemoved = true;
          } catch (e) {
            console.error('Remove background failed:', e);
            if (!quiet) toast('Background removal failed (kept upscaled image): ' + (e && e.message || e), 'warn', 5000);
          }
        }
        if (!quiet) {
          if (bgRemoved) toast(`Upscaled ${multiplier}× + background removed → ${out}`, 'ok', 4500);
          else toast(`Upscaled to ${multiplier}× → ${out}`, 'ok', 4000);
        }
        return out;
      };

      try {
        if (batch) {
          // Loop every checked image through the same pipeline. The
          // worker owns the progress line, summary toast, and refresh.
          await runImagePipelineBatch(`Upscale ${multiplier}×`, batch, (p) => runOne(p, true));
        } else {
          const final = await runOne(srcPath, false);
          await refreshBrowser();
          if (final) { try { previewImageFromFile(final); } catch (_) {} }
          // H10-5: notify the caller (e.g. the pipeline resize warning) of the produced file.
          if (opts && typeof opts.onDone === 'function') { try { opts.onDone(final); } catch (_) {} }
        }
        // Persist the new upscale settings now that we know the
        // upscale succeeded. (The setting is also updated in-place
        // by the input listeners, but a state.json round-trip
        // through the debounced scheduleStateSave isn't guaranteed
        // to have fired yet.)
        try { await scheduleStateSave(); } catch (_) {}
        close();
      } catch (e) {
        toast('Upscale' + (doCrop ? '+crop' : '') + ' failed: ' + (e && e.message || e), 'err', 6000);
        upscaleBtn.disabled = false;
        upscaleBtn.textContent = 'Upscale';
      }
    });
    m.appendChild(el('div', { class: 'footer' }, [cancelBtn, upscaleBtn]));
  });
}

// setupCropFrameDrag() lives in renderer/components/CropFrameDrag.js.
// Pure function, no app-state coupling.
var { setupCropFrameDrag } = window.CropFrameDrag;

