// renderer/services/fileBrowser2a.js
// First half of fileBrowser2.js (preview + thumbs).

// Pause + release any <audio>/<video> element currently in the preview
// pane. The browser does NOT reliably pause detached media, so
// replacing innerHTML while a song is playing left the audio running
// in the background with no UI to stop it. We pause + clear the src
// explicitly so the element's resources (network buffer, audio graph)
// are released even if the element is GC'd late.
function _stopPreviewMedia() {
  try {
    const content = $('#fb-preview-content');
    if (!content) return;
    const media = content.querySelectorAll('audio, video');
    for (const el of media) {
      try { el.pause(); } catch (_) {}
      try { el.src = ''; } catch (_) {}
    }
  } catch (_) { /* best-effort — never block the preview swap */ }
}
// Expose on window so fileBrowser2b.js (audio/video preview pane
// helpers) and any future caller can reuse the same cleanup.
window._stopPreviewMedia = _stopPreviewMedia;

function markFbItemActive(path) {
  if (!path || typeof path !== 'string') return;
  const ul = $('#fb-list');
  if (!ul) return;
  // De-select all rows, then select the one matching `path`. The
  // pre-existing click handler also removes `.selected` from every
  // row first, so the behaviour is consistent.
  const target = path.toLowerCase();
  const rows = $$('.fb-item', ul);
  let match = null;
  for (const li of rows) {
    const isMatch = (li.getAttribute('data-path') || '').toLowerCase() === target;
    li.classList.toggle('selected', isMatch);
    if (isMatch) match = li;
  }
  if (match) {
    // Update state._selected so the right-click context menu operates
    // on the same item the user sees as "active" in the preview pane.
    // We only set _selected to a directory-shaped object if we have
    // an existing fs-item record; otherwise the context menu would
    // be missing the size/ext metadata. Look it up by path from the
    // last-rendered list (state._fbItems is populated by
    // refreshBrowser when we wired it up — see the read in the
    // helper below).
    if (Array.isArray(state._fbItems)) {
      const found = state._fbItems.find((it) => (it.path || '').toLowerCase() === target);
      if (found) state._selected = found;
    }
    // Scroll into view if needed. The "nearest" choice keeps the
    // current scroll position when the row is already visible, so
    // a click within the visible area doesn't jump the view.
    try { match.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
  }
}

function previewImageFromFile(p) {
  // Pause any playing <audio>/<video> before replacing the pane — the
  // browser does NOT reliably pause detached media, so the previously-
  // previewed song would keep playing in the background.
  _stopPreviewMedia();
  // File-browser images go to the Picture preview pane (bottom-right of
  // the log bar), NOT the tab's generation preview. Pre-load the image
  // to grab the natural dimensions for the overlay / title hint.
  if (!p) {
    // A null/empty path resets the pane to the empty state instead of
    // rendering a broken <img src=""> (onerror would fire and the pane
    // would show a tiny invisible placeholder).
    const content = $('#fb-preview-content');
    if (content) content.innerHTML = '<div class="preview-pane-empty">Click an image in the file browser to preview it here.</div>';
    state._lastPreviewPath = null;
    state._previewBatch = null;
    state._previewRevision = (state._previewRevision || 0) + 1; // P4.5: void pending commits
    return;
  }
  // Same file twice → the preview already shows it; skip the redundant
  // re-decode + flicker (compared on path — the file didn't change).
  if (state._lastPreviewPath === p) return;
  state._lastPreviewPath = p;
  // P4.5 (DB-H-005): revision counter — each preview commit is tagged
  // with the revision current at click time (see `commit` below).
  const rev = (state._previewRevision = (state._previewRevision || 0) + 1);
  // A single-image preview always replaces the multi-image grid. Clear
  // _previewBatch so the overlay's arrow-keys don't walk a stale batch.
  state._previewBatch = null;
  // The file shown in the preview pane should always be the active row
  // in the folder explorer. Mark it before the async image decode so the
  // highlight is instant and doesn't flicker after the image paints.
  markFbItemActive(p);
  const url = fileUrl(p);
  const filename = (p || '').split(/[\\/]/).pop() || 'image';
  const preLoad = new Image();
  // P4.5 (DB-H-005): commit only if {revision, path} is still current —
  // a slow decode's late onload must not clobber a newer preview (another
  // image, an audio/video pane, or the multi-image grid).
  const commit = (w, h) => { if (state._previewRevision === rev && state._lastPreviewPath === p) updatePreviewPane(url, filename, w, h, p); };
  preLoad.onload = () => commit(preLoad.naturalWidth, preLoad.naturalHeight);
  preLoad.onerror = () => commit(0, 0);
  preLoad.src = url;
}

// Multi-file variant of previewImageFromFile. Used by the image tab's
// generate handler after a batch (or --n > 1) run completes, so the
// user can see ALL the generated images at once in the right-side
// folder-explorer's preview pane. Single-file runs delegate to
// previewImageFromFile (the one big image looks the same as before).
//
// For 1 file: show a single fit-to-pane image (no behaviour change).
// For N files: divide the pane into N equal-width slots. Each slot
// shows a small thumbnail + the filename; clicking any thumbnail
// opens the image overlay at 1:1 mode (same flow as the file browser).
// The pane scrolls horizontally if there are too many thumbs to fit
// at the current pane width.
function previewImagesFromFiles(paths) {
  // Pause any playing media before replacing the pane.
  _stopPreviewMedia();
  const content = $('#fb-preview-content');
  if (!content) return;
  if (!Array.isArray(paths) || !paths.length) {
    previewImageFromFile(null);
    return;
  }
  // Filter out null / empty paths so a single bad file in a batch
  // doesn't break the whole preview pane.
  const valid = paths.filter((p) => p && typeof p === 'string');
  if (!valid.length) {
    previewImageFromFile(null);
    return;
  }
  if (valid.length === 1) {
    // Single image: delegate to the single-image preview path.
    return previewImageFromFile(valid[0]);
  }
  // N > 1 → grid of thumbnails; container built once, dimensions async.
  content.innerHTML = '';
  // Clear _lastPreviewPath so a later single-click preview of the file
  // last shown before this grid is not no-op'd by previewImageFromFile's
  // `_lastPreviewPath === p` early-return. P4.5 (DB-H-005): also bump the
  // revision so a still-pending single-image onload can't stomp the grid.
  state._lastPreviewPath = null;
  state._previewRevision = (state._previewRevision || 0) + 1;
  // Stash the current batch on state so the image overlay's
  // arrow-key handler (added in a later feature) can navigate to
  // the previous / next thumbnail without re-fetching the list
  // from the DOM. The first item in the list is marked as the
  // "currently active" one in the folder explorer (and the
  // preview-pane highlight) until the user clicks a different
  // thumbnail or uses the arrow keys.
  state._previewBatch = {
    paths: valid.slice(),
    // Index of the path that is currently considered "selected"
    // (mirrors what the folder explorer's .selected row is). The
    // openImageOverlay handler updates this on every arrow press.
    index: 0,
  };
  // The file shown in the preview pane (or its full image viewer) must
  // always be the active row in the folder explorer. The first image of
  // a freshly-shown batch is the natural default.
  markFbItemActive(valid[0]);
  const grid = el('div', { class: 'preview-pane-grid' });
  for (let i = 0; i < valid.length; i++) {
    const p = valid[i];
    const filename = (p || '').split(/[\\/]/).pop() || 'image';
    const url = fileUrl(p) + '?t=' + Date.now();
    // data-path stores the filesystem path the slot represents.
    // The overlay's arrow-key handler reads it (via
    // navigateToOverlayImage) so the user can step through the
    // multi-image preview-pane thumbnails without losing track of
    // which file is currently highlighted.
    const slot = el('div', {
      class: 'preview-pane-thumb',
      title: filename + ' — click to view 1:1',
      'data-path': p,
    });
    if (i === 0) slot.classList.add('preview-active');
    const img = el('img', { src: url, alt: filename, loading: 'lazy' });
    const caption = el('div', { class: 'preview-pane-thumb-caption' }, filename);
    slot.append(img, caption);
    // Flag the click handler attachment so the slow-disk fallback
    // below doesn't double-bind. addEventListener doesn't write to
    // `.onclick`, so a plain `if (!slot.onclick)` guard can't tell
    // that a listener is already attached — the onload path and the
    // setTimeout path would both bind, and a single click would open
    // the overlay twice.
    let clickBound = false;
    const bind = (w, h) => {
      if (clickBound) return;
      clickBound = true;
      const open = () => {
        // Update the "selected" thumbnail + folder-explorer's active
        // row so both stay in sync with the user's last action (the
        // arrow-key handler in openImageOverlay does the same thing on
        // every keypress). Look up the index in
        // `state._previewBatch.paths` by value (not array reference)
        // — `valid` is sliced into the batch, so a reference compare
        // would never match.
        if (state._previewBatch && Array.isArray(state._previewBatch.paths)) {
          const found = state._previewBatch.paths.findIndex((q) => (q || '').toLowerCase() === p.toLowerCase());
          if (found >= 0) state._previewBatch.index = found;
        }
        $$('.preview-pane-thumb', grid).forEach((n) => n.classList.remove('preview-active'));
        slot.classList.add('preview-active');
        markFbItemActive(p);
        if (w && h) openImageOverlay(url, filename, w, h, p);
        else openImageOverlay(url, filename, 0, 0, p);
      };
    slot.addEventListener('click', open);
    // The clickBound flag above already prevents double-binding, so no
    // `{ once: true }` here — that would make the thumbnail unclickable
    // after the first click (closing the overlay and clicking the same
    // thumb again would do nothing).
    };
    // Resolve the natural size async so the overlay can show it.
    const probe = new Image();
    probe.onload = () => {
      slot.title = `${filename} (${probe.naturalWidth}×${probe.naturalHeight}) — click to view 1:1`;
      bind(probe.naturalWidth, probe.naturalHeight);
    };
    probe.onerror = () => bind(0, 0);
    probe.src = url;
    // Fallback: if the probe never resolves (slow disk), still allow a
    // click so the user isn't locked out of the overlay.
    setTimeout(() => bind(0, 0), 3000);
    grid.appendChild(slot);
  }
  content.appendChild(grid);
  // Below the grid, a small summary line so the user knows how many
  // images they got (and the click hint).
  const summary = el('div', { class: 'preview-pane-summary' },
    `${valid.length} image${valid.length === 1 ? '' : 's'} — click any thumbnail to open at 1:1.`);
  content.appendChild(summary);
}

// Render the file-browser image into the new Picture preview pane.
// The image is fit-to-content (object-fit: contain in the CSS) so a
// 4K screenshot is shown shrunken and a tiny icon stays at its natural
// size — both rendered completely, no cropping. Clicking the image
// (or the filename) opens the image overlay at 1:1 mode.
function updatePreviewPane(src, filename, naturalWidth, naturalHeight, filePath) {
  const content = $('#fb-preview-content');
  if (!content) return;
  content.innerHTML = '';
  const size = (naturalWidth && naturalHeight) ? ` (${naturalWidth}×${naturalHeight})` : '';
  const img = el('img', {
    src,
    alt: filename || '',
    title: (filename || '') + size + ' — click to view 1:1',
  });
  img.addEventListener('click', () => {
    openImageOverlay(src, filename, naturalWidth, naturalHeight, filePath);
  });
  content.appendChild(img);
  const fname = el('div', { class: 'preview-pane-filename', title: filename || '' },
    (filename || '') + size);
  content.appendChild(fname);
}

// Track the paths that have already been pushed to the preview
// pane for the current multi-image batch (or single-image preview).
// Used by notifyImageGenerated() to dedupe — the same file can
// arrive via the gen handler's "variant complete" callback AND
// the 1s polling, so without this set we'd double-add thumbnails.
// Keyed on lowercase path so a Windows path-case change doesn't
// produce duplicates either.
let _previewedPaths = new Set();
function _resetPreviewedPaths() {
  _previewedPaths = new Set();
}

// Build a single thumbnail slot for the multi-image preview pane.
// Extracted from previewImagesFromFiles so notifyImageGenerated
// can use the same DOM shape when appending new variants. The
// returned slot is already wired up (click handler + data-path)
// and the "preview-active" class is applied if `isActive` is
// true.
function _buildPreviewThumb(p, options) {
  const opts = options || {};
  const filename = (p || '').split(/[\\/]/).pop() || 'image';
  const cacheBust = opts.cacheBust !== false ? ('?t=' + Date.now()) : '';
  const url = fileUrl(p) + cacheBust;
  const slot = el('div', {
    class: 'preview-pane-thumb',
    title: filename + ' — click to view 1:1',
    'data-path': p,
  });
  if (opts.isActive) slot.classList.add('preview-active');
  if (opts.isNew) slot.classList.add('preview-new');
  const img = el('img', { src: url, alt: filename, loading: 'lazy' });
  const caption = el('div', { class: 'preview-pane-thumb-caption' }, filename);
  slot.append(img, caption);
  let clickBound = false;
  const bind = (w, h) => {
    if (clickBound) return;
    clickBound = true;
    const open = () => {
      // Update active selection — the user's last action wins.
      $$('.preview-pane-thumb').forEach((n) => n.classList.remove('preview-active'));
      slot.classList.add('preview-active');
      if (state._previewBatch) {
        const i = state._previewBatch.paths.findIndex((q) => (q || '').toLowerCase() === p.toLowerCase());
        if (i >= 0) state._previewBatch.index = i;
      }
      markFbItemActive(p);
      if (w && h) openImageOverlay(url, filename, w, h, p);
      else openImageOverlay(url, filename, 0, 0, p);
    };
    slot.addEventListener('click', open);
    // No `{ once: true }` — the clickBound flag already prevents
    // double-binding, so once:true would only make the thumbnail
    // unclickable after the first click.
    slot.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { showItemContextMenuForPath(p, e.clientX, e.clientY); }
      catch (_) { /* silent — context menu is best-effort */ }
    });
  };
  const probe = new Image();
  probe.onload = () => {
    slot.title = `${filename} (${probe.naturalWidth}×${probe.naturalHeight}) — click to view 1:1`;
    bind(probe.naturalWidth, probe.naturalHeight);
  };
  probe.onerror = () => bind(0, 0);
  probe.src = url;
  setTimeout(() => bind(0, 0), 3000);
  return slot;
}

// Live-update hook: an image was just generated and the user
// wants the UI to react instantly (folder-explorer blink +
// preview-pane thumbnail + active-row mark) without waiting
// for the full generation run to finish. Called from:
//   1. The image tab's gen handler after each variant (when
//      the output path is known in advance — i.e. not
//      --out-dir runs).
//   2. The 1s polling timer in startGenPolling() that watches
//      the output directory for new files (catches --out-dir
//      runs, plus any variant the gen handler missed).
//
// Idempotent: if the same path is reported twice (e.g. both
// the gen handler AND the polling saw it), the second call
// is a no-op — we use the lowercased path as the dedup key
// via _previewedPaths.
