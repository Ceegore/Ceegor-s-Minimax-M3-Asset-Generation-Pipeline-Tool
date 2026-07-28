// renderer/overlays/imageResizeOverlay.js
// The "📐 Resize…" overlay opened from the file-browser right-click menu. Lets
// the user resize one (or many) images to a free target resolution with
// best-practice Lanczos3 resampling (Sharp/libvips, MIT — commercially safe),
// plus the GIMP/Photoshop 🔗 aspect-ratio chain.
//
// Quality notes (mirrored in src/imageResize.js):
//   - Lanczos3 kernel (libvips' best general-purpose resampler).
//   - Subtle sharpen applied ONLY when downscaling (Photoshop "Bicubic Sharper"
//     equivalent) — upscaling deliberately doesn't sharpen (it amplifies
//     artefacts; the dedicated Upscale feature is the right tool there).
//   - When the target is a large enlargement (>120% on either axis) the warning
//     popup offers the dedicated Upscale (Real-ESRGAN) with inline settings.
//
// Multi-select: when ≥2 images are checked in the folder browser, the same
// W×H + chain settings apply to every file (runImagePipelineBatch).
function showResizeOverlay(srcPath, targets) {
  const batch = Array.isArray(targets) && targets.length > 1 ? targets.slice() : null;

  showModal((m, close) => {
    m.appendChild(el('h2', {}, '📐 Resize image'));
    m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px;' },
      batch ? `Resizing ${batch.length} selected images` : 'Source: ' + srcPath));

    // Read the source dims so the 🔗 chain can compute the linked axis. For a
    // batch, the primary file's dims are loaded (the dialog reflects srcPath).
    let srcDims = { w: 0, h: 0 };
    const dimsLabel = el('span', { class: 'meta', style: 'color: var(--fg-3); font-size: 11.5px; margin-left: 8px;' }, 'loading dimensions…');
    m.appendChild(el('div', { class: 'row', style: 'align-items: center;' }, [
      el('label', {}, 'Source size'),
      dimsLabel,
    ]));
    if (window.PureFuncs && window.PureFuncs.loadImageFromFile) {
      window.PureFuncs.loadImageFromFile(srcPath).then((img) => {
        if (img) {
          srcDims = { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
          dimsLabel.textContent = srcDims.w && srcDims.h ? `${srcDims.w} × ${srcDims.h} px` : '(unreadable)';
        } else { dimsLabel.textContent = '(unreadable)'; }
      }).catch(() => { dimsLabel.textContent = '(unreadable)'; });
    }

    // ---- W 🔗 H with the GIMP/Photoshop chain-link ----
    // KGO8-004: max is REQUIRED. Without it the field accepted 100000, and
    // image:resize then blocked ~3.5 min producing a 4.3-gigapixel file the
    // app itself cannot reopen. src/imageResize.js enforces the real
    // (total-pixel) ceiling; this stops the obvious case at the keyboard.
    const wInput = el('input', { type: 'number', min: '1', max: '65500', step: '1', placeholder: 'width' });
    const hInput = el('input', { type: 'number', min: '1', max: '65500', step: '1', placeholder: 'height' });
    wInput.style.width = hInput.style.width = '90px';
    const AL = window.AspectLink;
    const chain = AL.buildChainToggle(true, (linked) => {
      if (linked && Number(wInput.value) > 0) {
        const p = AL.linkedPair(srcDims, 'w', Number(wInput.value));
        hInput.value = p.height || '';
      }
    });
    wInput.addEventListener('input', () => {
      if (chain.linked) { const p = AL.linkedPair(srcDims, 'w', Number(wInput.value)); hInput.value = p.height || ''; }
    });
    hInput.addEventListener('input', () => {
      if (chain.linked) { const p = AL.linkedPair(srcDims, 'h', Number(hInput.value)); wInput.value = p.width || ''; }
    });
    m.appendChild(el('div', { class: 'row', style: 'align-items: center; gap: 6px;' }, [
      el('label', {}, 'Target'),
      wInput, chain, hInput, el('span', { class: 'meta', style: 'font-size: 11px; color: var(--fg-3);' }, 'px'),
    ]));

    // ---- Sharpen-on-downscale toggle ----
    const sharpenCb = el('input', { type: 'checkbox' }); sharpenCb.checked = true;
    m.appendChild(el('div', { class: 'row' }, [
      el('label', { class: 'auto-crop-label' }, [sharpenCb, ' Sharpen when downscaling (recovers softness)']),
    ]));
    m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-3); font-size: 11px; margin: -4px 0 8px;' },
      'Lanczos3 resampling. Linked 🔗 keeps the source aspect ratio; unlock to set W and H independently (may distort).'));

    // ---- Run / status ----
    const runBtn = el('button', { class: 'primary' }, '📐 Resize');
    const cancelBtn = el('button', { onclick: close }, 'Cancel');
    const status = el('div', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px; min-height: 16px; margin: 4px 0;' }, '');
    m.appendChild(status);

    runBtn.addEventListener('click', async () => {
      const tw = Math.max(0, Math.floor(Number(wInput.value) || 0));
      const th = Math.max(0, Math.floor(Number(hInput.value) || 0));
      if (!tw || !th) { toast('Enter a target width and height.', 'warn', 3000); return; }

      // Enlargement warning (single-file only — for a batch the user is
      // explicitly resizing many, so each one isn't second-guessed).
      if (!batch && window.ResizeUpscaleDialog) {
        const choice = await window.ResizeUpscaleDialog.maybeWarnUpscale({
          srcW: srcDims.w, srcH: srcDims.h, targetW: tw, targetH: th, srcPath,
        });
        if (choice !== 'proceed') return; // 'upscale' opened the dialog; 'cancel' aborts
      }

      const sharpen = sharpenCb.checked;
      runBtn.disabled = true;
      runBtn.textContent = 'Resizing…';
      status.textContent = `Resizing to ${tw}×${th}…`;
      // A truncated/heavy source can keep decoding for several seconds before
      // it fails (libvips retries internally). The static "Resizing…" copy
      // reads as a hang. After ~4 s of no resolution, swap in a reassuring hint
      // so the user knows it's still working (or stuck on a hard-to-decode
      // source) rather than frozen. Cleared on settle below.
      const slowTimer = setTimeout(() => {
        if (runBtn.disabled) status.textContent = 'Still working… (large or hard-to-decode images can take a few seconds)';
      }, 4000);
      try {
        if (batch) {
          const { ok, fail } = await runImagePipelineBatch(`Resize ${tw}x${th}`, batch,
            (p) => resizeImageFile(p, { width: tw, height: th, sharpenOnDownscale: sharpen }));
          status.textContent = `Done. ${ok} resized${fail ? `, ${fail} failed` : ''}.`;
          toast(`Resized ${ok} image(s) to ${tw}×${th}.`, 'ok', 4000);
        } else {
          const r = await resizeImageFile(srcPath, { width: tw, height: th, sharpenOnDownscale: sharpen });
          status.textContent = `Done → ${r.outputPath}`;
          toast(`Resized to ${tw}×${th} → ${r.outputPath}`, 'ok', 4000);
          try { await refreshBrowser(); } catch (_) {}
        }
      } catch (e) {
        status.textContent = 'Failed: ' + (e && e.message || e);
        toast('Resize failed: ' + (e && e.message || e), 'err', 6000);
      } finally {
        clearTimeout(slowTimer);
        runBtn.disabled = false;
        runBtn.textContent = '📐 Resize';
      }
    });
    m.appendChild(el('div', { class: 'footer' }, [cancelBtn, runBtn]));
  }, { id: 'image-resize' });
}

window.ImageOverlays = window.ImageOverlays || {};
window.ImageOverlays.showResizeOverlay = showResizeOverlay;
window.showResizeOverlay = showResizeOverlay;
