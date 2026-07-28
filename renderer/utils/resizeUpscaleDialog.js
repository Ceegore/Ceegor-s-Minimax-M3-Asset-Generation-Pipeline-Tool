// renderer/utils/resizeUpscaleDialog.js
// The enlargement warning popup. Fires whenever a resize would enlarge
// the image by more than 120% on either axis. Plain Lanczos resize
// softens enlargements; the dedicated Upscale feature (Real-ESRGAN AI)
// adds real detail. This popup gives the user the choice in one place,
// with the upscale settings inline.
//
// Usage from any resize entry point (Pipeline Resize column, right-click
// Optimize overlay, image editor):
//   await maybeWarnUpscale({ srcW, srcH, targetW, targetH, onProceed, srcPath })
//   - If NOT a large enlargement → resolves immediately (no popup), calls
//     onProceed?.() is the caller's job after the await returns 'proceed'.
//   - Returns one of: 'proceed' (resize anyway), 'upscale' (user chose the
//     dedicated upscale; the dialog already opened showUpscaleDirect), 'cancel'.
//
// The dialog is modal (showModal). It reads srcPath to hand to the upscale
// flow. The inline settings (multiplier, model, auto-crop, anchor) mirror what
// showUpscaleDirect would show, but applied non-interactively when the user
// clicks "Upscale instead" — the chosen settings are written to state, then the
// full upscale dialog opens so the preview and confirm step are preserved.

(function () {
  'use strict';
  const AL = () => window.AspectLink;

  // Threshold: a resize enlarging either axis beyond 120% of the source
  // triggers the warning. 120% matches the industry-standard threshold
  // (SmartAlbums and most print/photography software warn at 120%).
  const THRESHOLD = 1.2;

  /**
   * Maybe show the upscale-warning popup. Resolves to:
   *   'proceed' — caller should do the plain resize
   *   'upscale' — user chose the dedicated upscale; dialog handled it
   *   'cancel'  — user cancelled (caller should abort)
   * If the resize is not a large enlargement, resolves 'proceed' immediately.
   */
  function maybeWarnUpscale(opts) {
    opts = opts || {};
    const srcW = Number(opts.srcW) || 0;
    const srcH = Number(opts.srcH) || 0;
    const targetW = Number(opts.targetW) || 0;
    const targetH = Number(opts.targetH) || 0;
    const srcDims = { w: srcW, h: srcH };
    const target = { width: targetW, height: targetH };

    if (!AL() || !AL().isLargeUpscale(srcDims, target)) {
      return Promise.resolve('proceed');
    }

    return new Promise((resolve) => {
      const pct = AL().upscalePercent(srcDims, target);
      if (typeof showModal !== 'function') {
        // No modal host (e.g. test env) → default to proceed.
        resolve('proceed');
        return;
      }
      showModal((m, close) => {
        m.appendChild(el('h3', { style: 'margin-bottom: 8px;' }, '⚠ Large enlargement'));
        m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); margin-bottom: 12px;' },
          `Resizing from ${srcW}×${srcH} to ${targetW}×${targetH} is a ~${pct}% increase. ` +
          `Plain resize (Lanczos) will soften the image at this size. The Upscale feature ` +
          `(Real-ESRGAN AI) adds real detail and delivers noticeably sharper results for enlargements this large.`));

        // ---- Inline upscale settings (mirror showUpscaleDirect's defaults) ----
        const setBox = el('div', {
          style: 'margin: 0 0 14px; padding: 10px 12px; border: 1px solid var(--border-2); border-radius: var(--radius-sm); background: rgba(255,255,255,0.02);',
        });
        setBox.appendChild(el('div', { style: 'font-weight: 500; margin-bottom: 8px;' }, 'Upscale settings'));
        const grid = el('div', { style: 'display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; align-items: center;' });

        // Multiplier: default to the one nearest the requested increase (2/3/4).
        const requestedMult = Math.max(2, Math.min(4, Math.ceil((Math.max(targetW / Math.max(1, srcW), targetH / Math.max(1, srcH))) )));
        const multSel = el('select', {});
        for (const [v, lbl] of [['2', '2×'], ['3', '3×'], ['4', '4×']]) multSel.appendChild(el('option', { value: v }, lbl));
        multSel.value = String(requestedMult);
        grid.append(el('label', {}, 'Multiplier'), multSel);

        // Real-ESRGAN model (whitelisted — matches pipelineCard).
        const modelSel = el('select', {});
        const curModel = (window.state && window.state.realesrganModel) || 'realesrgan-x4plus';
        const reModels = (window.PipelineModel && window.PipelineModel.REALESRGAN_MODEL_DETAILS) || [];
        for (const { value: v, label: lbl } of reModels) modelSel.appendChild(el('option', { value: v }, lbl));
        modelSel.value = curModel;
        grid.append(el('label', {}, 'Model'), modelSel);

        // Auto-crop after upscale (mirrors state.upscaleSettings.autoCrop).
        const autoCropCb = el('input', { type: 'checkbox' });
        autoCropCb.checked = !!(window.state && window.state.upscaleSettings && window.state.upscaleSettings.autoCrop);
        grid.append(el('label', {}, [el('span', {}, 'Auto-crop after upscale'), autoCropCb]));

        setBox.appendChild(grid);

        // ---- H10-3: live resolution info label ----
        // Shows the source resolution and the target resolution the upscale
        // would produce with the current (inline) settings. Recomputes whenever
        // the multiplier or the auto-crop toggle changes — same math as
        // showUpscaleDirect.refreshTarget (section07).
        const resInfo = el('div', {
          class: 'meta',
          style: 'margin-top: 10px; padding: 6px 8px; border-left: 3px solid var(--accent); background: rgba(255,255,255,0.02); font-size: 12px; color: var(--fg-2);',
        }, '');
        function refreshInfo() {
          const mult = parseInt(multSel.value, 10) || 2;
          const tW = srcW * mult;
          const tH = srcH * mult;
          let note = '';
          if (autoCropCb.checked) {
            // Auto-crop clamps to the originally-requested target dims when
            // they are smaller than the upscaled result (matches
            // showUpscaleDirect.refreshTarget's clamp).
            const cropW = (targetW > 0) ? Math.min(targetW, tW) : tW;
            const cropH = (targetH > 0) ? Math.min(targetH, tH) : tH;
            note = ` · after auto-crop: ${cropW} × ${cropH}`;
          }
          resInfo.textContent = `Source ${srcW} × ${srcH} px  →  after upscale: ${tW} × ${tH} px${note}`;
        }
        multSel.addEventListener('change', refreshInfo);
        autoCropCb.addEventListener('change', refreshInfo);
        refreshInfo();
        setBox.appendChild(resInfo);

        m.appendChild(setBox);

        // ---- Buttons ----
        const resizeBtn = el('button', {}, '🖼 Resize anyway (Lanczos)');
        const upscaleBtn = el('button', { class: 'primary' }, '✨ Upscale instead');
        const cancelBtn = el('button', { class: 'btn-mini' }, 'Cancel');
        const footer = el('div', { class: 'footer', style: 'display: flex; gap: 8px; justify-content: flex-end;' }, [cancelBtn, resizeBtn, upscaleBtn]);
        m.appendChild(footer);

        resizeBtn.addEventListener('click', () => { close(); resolve('proceed'); });
        cancelBtn.addEventListener('click', () => { close(); resolve('cancel'); });
        upscaleBtn.addEventListener('click', () => {
          // Persist the chosen settings so showUpscaleDirect picks them up.
          try {
            window.state = window.state || {};
            window.state.realesrganModel = modelSel.value;
            window.state.upscaleSettings = Object.assign({}, window.state.upscaleSettings || {}, {
              multiplier: parseInt(multSel.value, 10) || 2,
              autoCrop: autoCropCb.checked,
            });
            if (typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
          } catch (_) { /* best-effort */ }
          close();
          // Open the full upscale dialog (it has the preview + confirm). Pass
          // the source path so it operates on the right image, and forward the
          // caller's onUpscaleDone callback so the pipeline can write the
          // produced file back into the board item (H10-5).
          try {
            if (typeof window.showUpscaleDirect === 'function') {
              const dlgOpts = (typeof opts.onUpscaleDone === 'function')
                ? { onDone: opts.onUpscaleDone }
                : undefined;
              window.showUpscaleDirect(opts.srcPath || '', null, dlgOpts);
            } else if (typeof toast === 'function') {
              toast('Upscale dialog unavailable. Use the right-click → Upscale action.', 'warn', 4000);
            }
          } catch (e) {
            if (typeof toast === 'function') toast('Could not open the upscale dialog: ' + (e && e.message || e), 'err', 5000);
          }
          resolve('upscale');
        });
      }, opts.modalId ? { id: opts.modalId } : undefined);
    });
  }

  window.ResizeUpscaleDialog = { maybeWarnUpscale, THRESHOLD };
})();
