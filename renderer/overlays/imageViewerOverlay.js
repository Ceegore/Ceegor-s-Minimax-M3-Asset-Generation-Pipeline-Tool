// renderer/overlays/imageViewerOverlay.js
// Full-screen image viewer overlay with zoom, arrow-key navigation,
// and context menu. Extracted from musicTab.js (H3 Batch 7) so the
// viewer lives in its own module, independent of any tab.
//
// Depends on globals: el, $$, state, toast, fileUrl, markFbItemActive,
// window.ImageOverlayContextMenu, window.showImageEditOverlay.

(function () {
  'use strict';

  // Track the most recent overlay's close function so a re-open can
  // dispose the previous one cleanly (removes its document-level
  // keydown listener). Without this, every rapid thumbnail click
  // leaks one Esc listener on `document`, requiring Esc to be pressed
  // N times to dismiss a single overlay after N re-opens.
  let _openImageOverlayClose = null;

  // Set of extensions the overlay's arrow-key navigation considers
  // "browsable" — i.e. an image file the user can step through.
  // Mirrors the same set the file browser / preview pane use to
  // decide what to render.
  const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

  // Build the list of image paths the user can step through with
  // the arrow keys in the overlay. Prefers the active multi-image
  // batch (state._previewBatch) when the current path is in it;
  // otherwise falls back to the folder explorer's currently-rendered
  // image list, which is sorted the same way as the folder explorer
  // (because the file browser sorts server-side and the renderer
  // displays the items in the order it received them).
  //
  // Returns { paths: string[], index: number } or null when no list
  // could be built (e.g. no folder context, no batch, no match).
  function buildOverlayNavList(currentPath) {
    const cur = (currentPath || '').toLowerCase();
    // 1) Multi-image batch — only if the current path is actually in it.
    if (state._previewBatch && Array.isArray(state._previewBatch.paths) && state._previewBatch.paths.length > 1) {
      const idx = state._previewBatch.paths.findIndex((p) => (p || '').toLowerCase() === cur);
      if (idx >= 0) {
        return { paths: state._previewBatch.paths, index: idx };
      }
    }
    // 2) Fallback: all image files in the current folder, in the
    //    same order the folder explorer renders them. The
    //    file-browser renderer stores the items on state._fbItems
    //    (added in feature #2) and they arrive pre-sorted from the
    //    main process (name + dirs-first). We further filter to
    //    image files so the arrow keys only step through images
    //    and not, say, the user's text notes.
    if (Array.isArray(state._fbItems) && state._fbItems.length) {
      const paths = state._fbItems
        .filter((it) => !it.isDir && IMAGE_EXTS.includes((it.ext || '').toLowerCase()))
        .map((it) => it.path);
      if (!paths.length) return null;
      const idx = paths.findIndex((p) => (p || '').toLowerCase() === cur);
      return { paths, index: idx >= 0 ? idx : 0 };
    }
    return null;
  }

  // Open the image overlay: a full-screen modal showing the image at
  // 1:1 pixel mode by default, with a zoom dropdown (200% / 175% / 150% /
  // 125% / 100% / 75% / 50% / 25% / Fit-to-window). Used by both the
  // generation preview thumbnail and the file-browser preview pane.
  function openImageOverlay(src, filename, naturalWidth, naturalHeight, filePath) {
    // If there's already an overlay open, close it cleanly (this
    // removes the previous keydown listener before we open a new one).
    if (_openImageOverlayClose) {
      try { _openImageOverlayClose(); } catch (_) {}
      _openImageOverlayClose = null;
    }
    // Closing the prior overlay removes the DOM and unregisters the
    // keydown listener; the cleanup lives in _openImageOverlayClose
    // above.
    const overlay = el('div', { class: 'image-overlay', id: 'image-overlay' });
    // Header
    const fname = el('span', { class: 'image-overlay-filename', title: filename || '' }, filename || '');
    const size = el('span', { class: 'image-overlay-size' },
      (naturalWidth && naturalHeight) ? `${naturalWidth}×${naturalHeight}` : '');
    // Position counter (e.g. "3 / 12") on the overlay header. Shown
    // when the arrow keys can navigate, hidden otherwise. Built
    // from the same nav list the arrow keys use, so the two stay
    // in lock-step.
    const navList = buildOverlayNavList(filePath);
    const pos = el('span', { class: 'image-overlay-pos' }, '');
    if (navList && navList.paths.length > 1) {
      pos.textContent = ` (${navList.index + 1} / ${navList.paths.length})`;
    }
    const zoom = el('select', { class: 'image-overlay-zoom', title: 'Zoom level' });
    // Issue-1: zoom levels ABOVE 100% (125–200%) so the user can verify
    // clean pixel edges after remove-bg / upscale at more than 1:1.
    for (const [val, label] of [
      ['200', '200%'],
      ['175', '175%'],
      ['150', '150%'],
      ['125', '125%'],
      ['100', '100% (1:1)'],
      ['75', '75%'],
      ['50', '50%'],
      ['25', '25%'],
      ['fit', 'Fit to window'],
    ]) {
      const opt = el('option', { value: val }, label);
      if (val === '100') opt.selected = true;
      zoom.appendChild(opt);
    }
    const closeBtn = el('button', { class: 'btn-mini image-overlay-close', title: 'Close (Esc)' }, '×');
    // Prev / next arrow buttons on the header. Same keyboard / click
    // behaviour — the buttons exist so the user can navigate on a
    // touch device or with the mouse without using the keyboard.
    const prevBtn = el('button', { class: 'btn-mini image-overlay-prev', title: 'Previous (←)' }, '‹');
    const nextBtn = el('button', { class: 'btn-mini image-overlay-next', title: 'Next (→)' }, '›');
    if (!navList || navList.paths.length <= 1) {
      // Single-image overlay — hide the nav controls so the user
      // doesn't think there's more to see.
      prevBtn.style.display = 'none';
      nextBtn.style.display = 'none';
    }
    // Open this image in the in-app pixel editor. The editor loads its
    // own overlay on top, so close the viewer first. Lazy-resolved via
    // window.showImageEditOverlay (the editor module loads after this
    // file).
    const editBtn = el('button', { class: 'btn-mini image-overlay-edit', title: 'Edit this image in the pixel editor' }, '✏');
    editBtn.addEventListener('click', () => {
      if (typeof window.showImageEditOverlay === 'function') { close(); window.showImageEditOverlay(filePath, null); }
      else toast('Image editor not loaded.', 'err', 4000);
    });
    const header = el('div', { class: 'image-overlay-header' }, [fname, pos, size, prevBtn, nextBtn, editBtn, zoom, closeBtn]);
    // Content
    const img = el('img', { class: 'image-overlay-img zoom-100', src, alt: filename || '' });
    if (naturalWidth && naturalHeight) {
      // Hint the browser at the natural size for layout (CSS then scales
      // according to .zoom-100/75/50/25/fit).
      img.width = naturalWidth;
      img.height = naturalHeight;
    }
    const content = el('div', { class: 'image-overlay-content' }, [img]);
    overlay.append(header, content);
    document.body.appendChild(overlay);
    let closeContextMenu = () => {};
    // Zoom on change
    zoom.addEventListener('change', () => {
      img.className = 'image-overlay-img zoom-' + zoom.value;
    });
    // H10-2.1: Ctrl + mouse wheel zooms in/out (plain wheel still pans). Steps through the same levels as the <select>.
    // Issue-1: extended above 100% (125/150/175/200) for pixel-edge checks.
    const ZOOM_STEPS = ['25', '50', '75', '100', '125', '150', '175', '200', 'fit'];
    const applyZoom = (val) => {
      zoom.value = val;
      for (const o of zoom.options) o.selected = (o.value === val);
      img.className = 'image-overlay-img zoom-' + val;
    };
    content.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const cur = String(zoom.value);
      let idx = ZOOM_STEPS.indexOf(cur);
      if (idx === -1) idx = 3; // unknown → treat as 100%
      // deltaY < 0 (wheel up) zooms in, > 0 (wheel down) zooms out.
      idx += (e.deltaY < 0) ? 1 : -1;
      idx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx));
      applyZoom(ZOOM_STEPS[idx]);
    }, { passive: false });
    // Close on button click
    const close = () => {
      closeContextMenu();
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (_openImageOverlayClose === close) _openImageOverlayClose = null;
    };
    closeBtn.addEventListener('click', close);
    // Close on background click (not on the image itself, i.e. overlay or content wrapper)
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target === content) close(); });

    // Stop propagation on the image so clicking the image doesn't close
    // the overlay (the user is likely trying to interact with the image).
    img.addEventListener('click', (e) => e.stopPropagation());

    // Right-click on the overlay image or filename: open simplified context menu
    if (filePath) {
      // H10-2.2: the "Save to…" context menu (with robust dismissal) lives in
      // overlays/imageOverlayContextMenu.js so this file stays within budget.
      const showMenu = (e) => {
        if (window.ImageOverlayContextMenu && window.ImageOverlayContextMenu.showSaveMenu) {
          window.ImageOverlayContextMenu.showSaveMenu(filePath, e, (fn) => { closeContextMenu = fn; });
        }
      };
      img.addEventListener('contextmenu', showMenu);
      fname.addEventListener('contextmenu', showMenu);
    }
    // The keyboard handler covers:
    //   Esc   → close the overlay
    //   ← / → → step to the previous / next image (with wrap-around
    //           when the user reaches the ends, so the keyboard
    //           navigation matches what the user expects from a
    //           typical image viewer)
    // Other keys are ignored. We compute the nav list lazily on
    // each arrow press so a newly-shown multi-image batch is picked
    // up the moment the user opens the overlay (and so the list
    // stays accurate even if the user clicks into a different
    // thumbnail in the preview pane while the overlay is open —
    // which is currently not possible, but defensive code is cheap).
    const onKey = (e) => {
      if (document.getElementById('modal-root')?.classList.contains('active')) return;
      if (e.key === 'Escape') {
        const hadMenu = !!document.querySelector('.custom-context-menu');
        closeContextMenu();
        if (!hadMenu) close();
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const list = buildOverlayNavList(filePath);
      if (!list || list.paths.length <= 1) return;
      const delta = e.key === 'ArrowLeft' ? -1 : +1;
      // Wrap-around: at the end, ← jumps to the last; at the start,
      // → jumps to the first. The preview-pane highlight + the
      // folder-explorer .selected row follow.
      const nextIdx = (list.index + delta + list.paths.length) % list.paths.length;
      navigateToOverlayImage(list.paths[nextIdx], { wrap: true });
    };
    document.addEventListener('keydown', onKey);
    // Wire the prev/next header buttons to the same navigateToOverlayImage
    // path so mouse-only users get the same behaviour.
    if (navList && navList.paths.length > 1) {
      prevBtn.addEventListener('click', () => {
        const list = buildOverlayNavList(filePath);
        if (!list || list.paths.length <= 1) return;
        const nextIdx = (list.index - 1 + list.paths.length) % list.paths.length;
        navigateToOverlayImage(list.paths[nextIdx], { wrap: true });
      });
      nextBtn.addEventListener('click', () => {
        const list = buildOverlayNavList(filePath);
        if (!list || list.paths.length <= 1) return;
        const nextIdx = (list.index + 1) % list.paths.length;
        navigateToOverlayImage(list.paths[nextIdx], { wrap: true });
      });
    }
    // Hand the close function to the next open call so a re-open
    // disposes this one cleanly.
    _openImageOverlayClose = close;
  }

  // Open the next / previous image in the current overlay nav list.
  // Called by the arrow-key / prev-next-button handlers inside
  // openImageOverlay. Closes the current overlay, re-opens a new
  // one for `path`, and updates the multi-image preview-pane
  // highlight (if a batch is shown) + the folder-explorer's
  // .selected row. The "wrap" option is accepted for future use
  // (e.g. disabling wrap-around when the user explicitly clicks
  // a thumbnail), but currently the keyboard always wraps.
  function navigateToOverlayImage(path, opts) {
    if (!path) return;
    // Update the multi-image preview-pane highlight so the new
    // "current" thumbnail gets the .preview-active class. We
    // update _previewBatch.index even if the path is not in the
    // batch — buildOverlayNavList falls back to the folder list
    // in that case.
    if (state._previewBatch && Array.isArray(state._previewBatch.paths)) {
      const idx = state._previewBatch.paths.findIndex((p) => (p || '').toLowerCase() === path.toLowerCase());
      if (idx >= 0) state._previewBatch.index = idx;
    }
    // Folder-explorer's .selected row follows the user, so the
    // file they're navigating to is always the active row.
    if (typeof markFbItemActive === 'function') markFbItemActive(path);
    // Re-render the preview-pane highlight (the .preview-active
    // class on the thumbnail). We do this by walking the
    // current grid and toggling the class.
    const grid = document.querySelector('#fb-preview-content .preview-pane-grid');
    if (grid) {
      let activeSlot = null;
      $$('.preview-pane-thumb', grid).forEach((slot) => {
        // The slot's `title` attribute is the filename, which is
        // not a reliable key. Instead, the click handler stores
        // the path on a data attribute when it binds; for the
        // public path it is read from the slot's stored state.
        // As a fallback, the slot's first child <img> has a
        // src that includes a cache-buster; it can't be reversed
        // into a path. So the lookup is by data-path
        // if the slot has it (we set it below in
        // previewImagesFromFiles).
        const slotPath = slot.getAttribute('data-path');
        const isMatch = slotPath && slotPath.toLowerCase() === path.toLowerCase();
        slot.classList.toggle('preview-active', !!isMatch);
        if (isMatch) activeSlot = slot;
      });
      if (activeSlot) {
        try { activeSlot.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
      }
    }
    // Close the current overlay (which also unregisters the
    // keyboard listener) and open a new one for the new path.
    // The close() inside openImageOverlay() handles the
    // _openImageOverlayClose cleanup; we then load the natural
    // size async so the new overlay's title shows the right
    // dimensions.
    const url = fileUrl(path) + '?t=' + Date.now();
    const filename = (path || '').split(/[\\/]/).pop() || 'image';
    const probe = new Image();
    probe.onload = () => {
      openImageOverlay(url, filename, probe.naturalWidth, probe.naturalHeight, path);
    };
    probe.onerror = () => {
      openImageOverlay(url, filename, 0, 0, path);
    };
    probe.src = url;
  }

  // Expose globally so all tabs and the file browser can open the viewer.
  window.openImageOverlay = openImageOverlay;
  window.navigateToOverlayImage = navigateToOverlayImage;
  window.buildOverlayNavList = buildOverlayNavList;
  window.IMAGE_EXTS = IMAGE_EXTS;
})();
