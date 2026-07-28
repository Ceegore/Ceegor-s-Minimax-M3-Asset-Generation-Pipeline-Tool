// renderer/overlays/imageOverlays.js
// 3 Image-Pipeline-Overlays: showConvertOverlay (Format-Convert),
// showCropOverlay (Crop), showOptimizeOverlay (Compress).

// Format-converter overlay. Shows the source format and a dropdown of
// supported targets (PNG, JPEG, WebP). Output file uses the new
// extension; quality is fixed at 0.95.
async function showConvertOverlay(srcPath, targets) {
  // KGO4-014: verify the source file still exists before opening the modal.
  const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(srcPath) : undefined;
  const exists = await window.api.fbExists(srcPath, existsGrant);
  // KGO6-011: distinguish grant errors from genuinely missing files.
  if (!exists || !exists.ok) { toast((exists && exists.error) || 'Cannot access source file: ' + srcPath, 'err', 6000); return; }
  if (!exists.exists) { toast('Source file not found: ' + srcPath, 'err', 5000); return; }
  // Multi-select batch: when ≥2 images are checked in the folder explorer,
  // `targets` holds all of them and the confirm loops over every one with the
  // chosen output format. The dialog UI still reflects the primary (right-
  // clicked) srcPath.
  const batch = Array.isArray(targets) && targets.length > 1 ? targets.slice() : null;
  // Path-based extension extraction, NOT split('.').pop(). split('.').pop()
  // returns the WHOLE filename for an extension-less source, which then fails
  // to match any format and pre-selects all three format options.
  const lastDot = Math.max(srcPath.lastIndexOf('.'), srcPath.lastIndexOf('/'), srcPath.lastIndexOf('\\'));
  const hasExt = lastDot >= 0 && srcPath.indexOf('.', lastDot) === lastDot && srcPath.slice(lastDot + 1).length > 0;
  const ext = hasExt ? srcPath.slice(lastDot + 1).toLowerCase() : '';
  const srcFmt = ext.toUpperCase() || '?';
  showModal((m, close) => {
    m.appendChild(el('h2', {}, '⇄ Convert image format'));
    m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px;' },
      batch ? `Converting ${batch.length} selected images` : 'Source: ' + srcPath));
    const srcFmtLabel = el('input', { type: 'text', value: srcFmt, readonly: '' });
    const outSel = el('select', {});
    // Supported output targets. All three are written natively by
    // canvas.toDataURL (Chromium supports image/webp since v32).
    for (const [v, lbl] of [
      ['png',  'PNG  (lossless, supports transparency)'],
      ['jpeg', 'JPEG (smaller files, no transparency)'],
      ['webp', 'WebP (modern, smaller files)'],
    ]) {
      const opt = el('option', { value: v }, lbl);
      // Default to a different format than the source
      if (v !== ext) opt.selected = true;
      outSel.appendChild(opt);
    }
    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Input format'), srcFmtLabel]));
    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Output format'), outSel]));
    
    const qualityInput = el('input', { type: 'range', min: '1', max: '100', step: '1', value: '95' });
    const qualityLabel = el('span', { class: 'meta', style: 'min-width: 32px; text-align: right;' }, '95');
    qualityInput.addEventListener('input', () => { qualityLabel.textContent = qualityInput.value; });
    m.appendChild(el('div', { class: 'row' }, [
      el('label', {}, 'Quality'), qualityInput, qualityLabel
    ]));

    const convertBtn = el('button', { class: 'primary' }, 'Convert');
    const cancelBtn = el('button', { onclick: close }, 'Cancel');
    convertBtn.addEventListener('click', async () => {
      const target = outSel.value;
      // The "same format, nothing to do" guard only makes sense for a
      // single source; a batch can contain mixed source formats.
      if (!batch && target === ext) {
        toast('Source and target format are the same — nothing to do.', 'warn', 3000);
        return;
      }
      convertBtn.disabled = true; convertBtn.textContent = 'Converting…';
      const quality = parseInt(qualityInput.value, 10) / 100;
      try {
        if (batch) {
          // Loop every checked image through the same target format.
          await runImagePipelineBatch(`Convert → ${target.toUpperCase()}`, batch, (p) => convertImageFile(p, target, quality));
          close();
          return;
        }
        const out = await convertImageFile(srcPath, target, quality);
        toast(`Converted to ${target.toUpperCase()} → ${out}`, 'ok', 4000);
        await refreshBrowser();
        // Guard + invoke the SAME function being tested, to avoid a latent
        // ReferenceError hidden by the surrounding try/catch.
        if (typeof previewImageFromFile === 'function') {
          try { previewImageFromFile(out); } catch (_) {}
        }
        close();
      } catch (e) {
        toast('Convert failed: ' + (e && e.message || e), 'err', 6000);
        convertBtn.disabled = false; convertBtn.textContent = 'Convert';
      }
    });
    m.appendChild(el('div', { class: 'footer' }, [cancelBtn, convertBtn]));
  }, { id: 'image-convert' });
}

// Crop overlay. The image is rendered at its natural pixel size inside
// a scrollable container; the user enters W x H, clicks Apply, and a
// green-bordered draggable frame appears at the specified size. The
// user can drag the frame to position it; clicking Crop finalizes.
function showCropOverlay(srcPath, targets, opts) {
  // Multi-select batch: apply the SAME crop rectangle (position + W × H, as
  // dragged on the primary image) to every checked image. cropImageFile clamps
  // the rectangle to each image's own bounds and throws if it falls entirely
  // outside — those count as failures in the batch summary. Best suited to
  // same-sized images (the common case for a batch of generated assets).
  const batch = Array.isArray(targets) && targets.length > 1 ? targets.slice() : null;
  showModal((m, close) => {
    m.appendChild(el('h2', {}, '✂ Crop image'));
    m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px;' },
      batch ? `Cropping ${batch.length} selected images — the frame below is set on the first; the same rectangle is applied to all.` : 'Source: ' + srcPath));

    // Inputs row: auto-size checkbox, Width, Height, Apply
    // The "auto-size" checkbox is on by default: when checked, the
    // image and the green crop frame are both scaled to fit inside the
    // stage so a 4K source doesn't overflow the modal. The W/H inputs
    // still describe the crop in image pixels (the scale only affects
    // the on-screen display).
    const autoSizeCb = el('input', { type: 'checkbox', class: 'auto-size-cb' });
    autoSizeCb.checked = true;
    // KGO8-004: bounded — see src/imageResize.js for the total-pixel ceiling.
    const wInput = el('input', { type: 'number', min: '1', max: '65500', value: '1024' });
    const hInput = el('input', { type: 'number', min: '1', max: '65500', value: '1024' });
    const applyBtn = el('button', { class: 'btn-mini' }, 'Apply');
    const cropBtn = el('button', { class: 'primary' }, 'Crop');
    const cancelBtn = el('button', { onclick: close }, 'Cancel');
    // The image stage: image + draggable frame overlay.
    const stage = el('div', { class: 'crop-stage' });
    const img = el('img', { class: 'crop-image' });
    // Hidden until the image's natural size is known.
    img.style.visibility = 'hidden';
    stage.appendChild(img);
    let frame = null;
    let frameX = 0, frameY = 0;
    // displayScale converts image pixels -> display pixels:
    //   displayW = imageW * displayScale
    //   displayH = imageH * displayScale
    // When auto-size is on and the image is bigger than the stage,
    // displayScale < 1 so the whole image + frame fit on screen. When
    // auto-size is off, displayScale = 1 (natural size, the original
    // behaviour). The drag handler uses this value to convert
    // display-pixel mouse deltas back into image-pixel positions.
    let displayScale = 1;

    m.appendChild(el('div', { class: 'crop-dim-row' }, [
      el('label', { class: 'auto-size-label' }, [autoSizeCb, ' auto-size']),
      el('label', {}, 'Width'), wInput, el('label', {}, 'Height'), hInput, applyBtn,
    ]));
    m.appendChild(stage);
    m.appendChild(el('div', { class: 'footer' }, [cancelBtn, cropBtn]));

    // Recompute the image's CSS size + the displayScale. Called when
    // the image finishes loading and when the user toggles the
    // checkbox. Reads the stage's actual client size (subtracting the
    // 4px padding on each side) so the math holds even after the
    // modal has been resized by the user.
    function applyAutoSize() {
      if (!img.naturalW) return;
      const stageW = stage.clientWidth || 1;
      const stageH = stage.clientHeight || 1;
      if (autoSizeCb.checked) {
        // Fit completely; never upscale beyond 1:1 (to avoid
        // bloating a small image to look pixelated).
        const s = Math.min(stageW / img.naturalW, stageH / img.naturalH, 1);
        displayScale = isFinite(s) && s > 0 ? s : 1;
      } else {
        displayScale = 1;
      }
      img.style.width = (img.naturalW * displayScale) + 'px';
      img.style.height = (img.naturalH * displayScale) + 'px';
    }
    autoSizeCb.addEventListener('change', () => {
      applyAutoSize();
      if (frame) showFrame();
    });

    // Load the image. Once decoded, show it and pre-fill W/H with the natural
    // size so the user can immediately Apply. Track a `closed` flag so an Esc
    // pressed mid-decode skips both the resolve branch (which would otherwise
    // mutate a detached modal) and the reject branch (which would re-fire
    // close() and call the onClose hooks twice).
    let closed = false;
    const origClose = close;
    close = () => { closed = true; origClose(); };
    loadImageFromFile(srcPath).then((loaded) => {
      if (closed) return; // Esc pressed mid-decode — modal is gone
      img.naturalW = loaded.naturalWidth;
      img.naturalH = loaded.naturalHeight;
      img.src = loaded.src;
      img.style.visibility = '';
      wInput.value = String((opts && opts.w) || loaded.naturalWidth);
      hInput.value = String((opts && opts.h) || loaded.naturalHeight);
      applyAutoSize();
      if (opts && (opts.w || opts.h)) {
        showFrame();
      }
    }).catch((e) => {
      if (closed) return; // already closed via Esc — don't double-close
      toast('Failed to load image: ' + e.message, 'err', 6000);
      origClose();
    });

    // Create / recreate the frame at the specified W x H, centered.
    // frameX/frameY are always in IMAGE pixels; the CSS left/top are
    // scaled by displayScale so the frame visually fits the image.
    function showFrame() {
      const w = Math.max(1, parseInt(wInput.value, 10) || 1);
      const h = Math.max(1, parseInt(hInput.value, 10) || 1);
      if (img.naturalW && (w > img.naturalW || h > img.naturalH)) {
        toast(`Frame size ${w}×${h} exceeds image size ${img.naturalW}×${img.naturalH}.`, 'warn', 4000);
        return;
      }
      if (frame) frame.remove();
      frame = el('div', { class: 'crop-frame', title: 'Drag to position' });
      // Center the frame initially, or use provided initial coordinates
      if (opts && typeof opts.x === 'number' && typeof opts.y === 'number') {
        frameX = Math.max(0, Math.min(img.naturalW - w, opts.x));
        frameY = Math.max(0, Math.min(img.naturalH - h, opts.y));
      } else {
        frameX = Math.max(0, Math.floor((img.naturalW - w) / 2));
        frameY = Math.max(0, Math.floor((img.naturalH - h) / 2));
      }
      // Display position = image position * scale
      frame.style.width = (w * displayScale) + 'px';
      frame.style.height = (h * displayScale) + 'px';
      frame.style.left = (frameX * displayScale) + 'px';
      frame.style.top = (frameY * displayScale) + 'px';
      stage.appendChild(frame);
      // Pass displayScale so the drag handler can convert
      // display-pixel mouse deltas to image-pixel positions.
      setupCropFrameDrag(frame, stage, () => img.naturalW, () => img.naturalH,
        (x, y) => { frameX = x; frameY = y; }, displayScale);
    }
    applyBtn.addEventListener('click', showFrame);

    cropBtn.addEventListener('click', async () => {
      if (!frame) { toast('Click Apply first to position the crop frame.', 'warn'); return; }
      const w = parseInt(wInput.value, 10) || 1;
      const h = parseInt(hInput.value, 10) || 1;
      if (opts && typeof opts.onComplete === 'function') {
        opts.onComplete(frameX, frameY, w, h);
        close();
        return;
      }
      cropBtn.disabled = true; cropBtn.textContent = 'Cropping…';
      try {
        if (batch) {
          // Same rectangle for every checked image (clamped per-image).
          await runImagePipelineBatch(`Crop ${w}×${h}`, batch, (p) => cropImageFile(p, frameX, frameY, w, h));
          close();
          return;
        }
        const out = await cropImageFile(srcPath, frameX, frameY, w, h);
        toast(`Cropped to ${w}×${h} → ${out}`, 'ok', 4000);
        await refreshBrowser();
        // Guard + invoke the SAME function being tested.
        if (typeof previewImageFromFile === 'function') {
          try { previewImageFromFile(out); } catch (_) {}
        }
        close();
      } catch (e) {
        toast('Crop failed: ' + (e && e.message || e), 'err', 6000);
        cropBtn.disabled = false; cropBtn.textContent = 'Crop';
      }
    });
  }, { id: (opts && opts.modalId) || 'image-crop' });
}

window.ImageOverlays = {
  showConvertOverlay,
  showCropOverlay
};
