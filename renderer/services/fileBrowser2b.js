// renderer/services/fileBrowser2b.js
// Second half of fileBrowser2.js (context menu + clipboard).

// Per-tab "is anything running?" gate. Used by the gen poller below so
// a parallel job on a different tab doesn't keep this poller alive.
// Falls back to the legacy `state.generating` single-slot value when
// JobRunner isn't loaded.
function _isSomeTabGenerating() {
  if (window.JobRunner && typeof window.JobRunner.activeJobs === 'function') {
    return window.JobRunner.activeJobs().length > 0;
  }
  return !!(window.state && window.state.generating);
}

function notifyImageGenerated(p) {
  if (!p || typeof p !== 'string') return;
  const key = p.toLowerCase();
  if (_previewedPaths.has(key)) return;
  _previewedPaths.add(key);
  // 1. Push the path to the multi-image batch so the thumbnail
  //    shows up in the preview pane. If no batch is currently
  //    active, we start one with just this file (the user can
  //    then continue to add more). The new thumbnail is marked
  //    with the "preview-new" class so the CSS can briefly
  //    highlight it.
  if (!state._previewBatch) {
    state._previewBatch = { paths: [p], index: 0 };
  } else if (!state._previewBatch.paths.includes(p)) {
    state._previewBatch.paths.push(p);
  }
  // 2. Re-render the preview pane. If a grid already exists,
  //    we APPEND a new slot instead of re-creating everything
  //    (preserves the existing thumbnails + their click
  //    handlers). If the grid doesn't exist yet (e.g. the
  //    user is on a non-image tab), this is a no-op — the
  //    next refreshBrowser() will pick up the file in the
  //    folder explorer.
  const content = $('#fb-preview-content');
  if (content) {
    let grid = content.querySelector('.preview-pane-grid');
    if (!grid) {
      // No grid yet — build one with just this file.
      content.innerHTML = '';
      grid = el('div', { class: 'preview-pane-grid' });
      content.appendChild(grid);
      const summary = el('div', { class: 'preview-pane-summary' }, '1 image — click any thumbnail to open at 1:1.');
      content.appendChild(summary);
    } else {
      // Grid already there — update the "N images" summary line
      // (if present) so the user can see the count grow.
      const summary = content.querySelector('.preview-pane-summary');
      if (summary) {
        const n = grid.querySelectorAll('.preview-pane-thumb').length + 1;
        summary.textContent = `${n} image${n === 1 ? '' : 's'} — click any thumbnail to open at 1:1.`;
      }
    }
    const slot = _buildPreviewThumb(p, { isActive: true, isNew: true });
    grid.appendChild(slot);
  }
  // 3. Mark the file as active in the folder explorer (and scroll
  //    the row into view if it's off-screen).
  markFbItemActive(p);
}

// F5: After speech/music generation, show the just-created audio in the Assets
// Preview pane (same pane a file-browser click uses). Non-autoplay.
function notifyAudioGenerated(p) {
  if (!p || typeof p !== 'string') return;
  // previewAudioFromFile early-returns if state._lastPreviewPath === p; clear it
  // so a re-generated identical path still refreshes the pane.
  if (window.state && window.state._lastPreviewPath === p) window.state._lastPreviewPath = null;
  if (typeof previewAudioFromFile === 'function') previewAudioFromFile(p);
}
window.notifyAudioGenerated = notifyAudioGenerated;

// Polling timer for "live" folder-explorer updates while a generation is
// in flight. 1s polling (not fs.watch): OS-agnostic, invisible on the IPC
// channel, and covers the --out-dir case where the renderer doesn't know
// the per-call output filenames. Started by armGenBtnWithCancel
// (startGenPolling), stopped by its cleanup (stopGenPolling). Each tick:
// list the polled dir, diff against state._lastPolledItems, push new
// files through notifyImageGenerated + blink their rows, refresh the
// items snapshot.
let _genPollTimer = null;
let _genPollBusy = false;
// A `_genPollActive` flag covers the await window inside the tick
// (the tick nulls _genPollTimer on entry, so a guard on the timer
// alone would let two rapid startGenPolling calls during the await
// schedule two tick chains). The flag is only cleared in
// stopGenPolling.
let _genPollActive = false;
// P4.5 (DB-H-006): thumbnail pushes require an IMAGE job — a speech/
// music/video run must not turn image files appearing in the folder
// mid-run into "generated image" thumbnails.
function _isImageJobActive() {
  if (window.JobRunner && typeof window.JobRunner.activeJobs === 'function') {
    return window.JobRunner.activeJobs().some((j) => j && (j.tab === 'image' || j.type === 'image'));
  }
  return !!(window.state && window.state.generating === 'image');
}
async function startGenPolling() {
  // Defensive: never start two pollers at once.
  if (_genPollActive) return;
  _genPollActive = true;
  // P4.5 (DB-H-006): bind the whole poll run to the dir current at
  // start. Re-reading state.fbDir per tick let a mid-run folder
  // navigation re-point the diff at the WRONG dir, flagging the user's
  // browsed files as "new generations".
  const pollDir = state.fbDir;
  // Snapshot the current items so the first tick doesn't see "everything
  // is new" (the folder may have had files before the run started).
  try {
    const _g = (window.GrantHelper && window.GrantHelper.ensureDirList) ? await window.GrantHelper.ensureDirList(pollDir) : undefined;
    const r = (_g && _g.ok === false) ? _g : await window.api.fbList(pollDir, _g);
    if (r && r.ok) state._lastPolledItems = (r.items || []).map((it) => it.path);
  } catch (_) {
    state._lastPolledItems = [];
  }
  // Reset the dedup set so the polling starts fresh for this run
  // (notifyImageGenerated is idempotent for already-pushed files).
  _resetPreviewedPaths();
  const tick = async () => {
    _genPollTimer = null;
    // BUG #3 companion fix: when the poller self-terminates it must
    // also clear _genPollActive — otherwise the guard in
    // startGenPolling() no-ops every future start and the poller
    // can never run again after its first self-termination.
    if (!_isSomeTabGenerating()) { _genPollActive = false; return; }
    if (_genPollBusy) return; // skip overlapping ticks
    _genPollBusy = true;
    try {
      const _g2 = (window.GrantHelper && window.GrantHelper.ensureDirList) ? await window.GrantHelper.ensureDirList(pollDir) : undefined;
      const r = (_g2 && _g2.ok === false) ? _g2 : await window.api.fbList(pollDir, _g2);
      if (!r || !r.ok) return;
      const newItems = r.items || [];
      // Filter to supported asset types (isItemVisibleInList) so the
      // re-render matches the "show all files" toggle; fresh-detection
      // still walks the full list.
      const visibleItems = newItems.filter(isItemVisibleInList);
      const newPaths = newItems.map((it) => it.path);
      const prev = new Set((state._lastPolledItems || []).map((p) => p.toLowerCase()));
      const fresh = newPaths.filter((p) => !prev.has(p.toLowerCase()));
      state._lastPolledItems = newPaths;
      // P4.5 (DB-H-006): the user navigated away from the polled dir —
      // don't clobber the new folder's rendered list / preview with the
      // polled dir's items; keep diffing silently until they return.
      if (state.fbDir !== pollDir) return;
      // 1. Re-render the list so the new file is visible. Preserve the
      //    scroll position: renderFbList rebuilds the list, which would
      //    snap it to the top every second otherwise.
      const ul = $('#fb-list');
      const savedScroll = ul ? ul.scrollTop : 0;
      const sorted = sortFbItems(visibleItems, state.fbSort);
      renderFbList(sorted);
      applyFileSearch();
      if (ul && savedScroll > 0) {
        // Clamp to the new scrollHeight in case the list shrank.
        ul.scrollTop = Math.min(savedScroll, ul.scrollHeight);
      }
      // 2. Run each newly-discovered file through the same live-update
      //    pipeline the gen handler uses (covers the --out-dir case).
      const imgActive = _isImageJobActive();
      for (const p of fresh) {
        // Thumbnail push only for images AND only while an image job is
        // actually running (P4.5).
        const ext = (p.split('.').pop() || '').toLowerCase();
        if (imgActive && ['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
          notifyImageGenerated(p);
        }
        // Blink the row (data-path lookup — the re-render just created
        // fresh DOM nodes).
        const row = document.querySelector(`.fb-item[data-path="${CSS.escape(p)}"]`);
        if (row) row.classList.add('fb-item-new');
      }
    } catch (_) {
      // Don't let a transient IPC error kill the poller — just
      // try again on the next tick.
    } finally {
      _genPollBusy = false;
      // Schedule the next tick only if we're still generating.
      // The next tick is re-armed here (rather than via a
      // setInterval) so an error inside tick() doesn't queue
      // up overlapping polls.
      // R4: also require _genPollActive — an in-flight tick reaches this finally
      // after stopGenPolling() cleared the flag and must not re-arm an orphaned chain.
      if (_genPollActive && _isSomeTabGenerating()) _genPollTimer = setTimeout(tick, 1000);
      else _genPollActive = false; // BUG #3 companion fix: allow restart
    }
  };
  _genPollTimer = setTimeout(tick, 1000);
}
function stopGenPolling() {
  if (_genPollTimer) { clearTimeout(_genPollTimer); _genPollTimer = null; }
  _genPollActive = false;
  state._lastPolledItems = null;
}

// Audio preview: the filename is shown prominently + a big "▶ Play"
// button (not the OS-native audio controls bar). Clicking Play starts
// playback; the button then switches to "■ Stop" for the duration of
// the audio, and reverts to "▶ Play" when the audio ends. The audio
// element itself is hidden (it's only there as a JS-controlled
// playback source — the user interacts only via the Play button). The
// audio plays once and then stops.
function previewAudioFromFile(p) {
  const root = $(`#fb-preview-content`);
  if (!root) return;
  if (state._lastPreviewPath === p) return;
  state._lastPreviewPath = p;
  state._previewBatch = null;
  markFbItemActive(p);
  const url = fileUrl(p);
  const filename = (p || '').split(/[\\/]/).pop() || 'audio';
  // Pause any previously-playing media before replacing the pane. The
  // audio element created for the previous file is detached by the
  // innerHTML='' below; without an explicit pause it kept playing in
  // the background.
  if (typeof window._stopPreviewMedia === 'function') window._stopPreviewMedia();
  root.innerHTML = '';
  // Hidden audio element. The user never sees the native controls;
  // the Play/Stop button below drives playback. Use preload
  // 'metadata' (not 'auto') so the renderer doesn't download the
  // entire file before the user hits Play — for a multi-hundred-MB
  // .wav that would freeze the UI until the download finished.
  // 'metadata' fetches duration + a tiny header buffer; Play
  // triggers the full download.
  const audio = el('audio', { src: url, preload: 'metadata' });
  audio.style.display = 'none';
  // Container with the filename header + a centred Play
  // button. Uses the same preview-pane layout as images
  // (filename row under the media) so the three preview
  // types (image / video / audio) read as one family.
  const wrap = el('div', { class: 'preview-pane-audio' });
  const icon = el('div', { class: 'preview-pane-audio-icon' }, '🎵');
  const name = el('div', { class: 'preview-pane-audio-name', title: filename }, filename);
  const playBtn = el('button', { class: 'primary preview-pane-audio-btn', type: 'button' }, '▶ Play');
  const status = el('div', { class: 'preview-pane-audio-status' }, '');
  // Drive the audio element via JS so the button label can swap
  // between Play / Stop / Loading, and playback never auto-loops
  // (play once, then stop).
  function setPlaying(isPlaying) {
    playBtn.textContent = isPlaying ? '■ Stop' : '▶ Play';
    playBtn.classList.toggle('playing', isPlaying);
    status.textContent = isPlaying ? `Playing ${filename}…` : '';
  }
  playBtn.addEventListener('click', () => {
    if (audio.paused) {
      // .play() returns a promise that can reject if the
      // browser blocks autoplay. We treat that as a soft
      // "couldn't start" rather than a hard error — the user
      // can click Play again.
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        playBtn.disabled = true;
        p.then(() => { playBtn.disabled = false; setPlaying(true); })
         .catch((e) => { playBtn.disabled = false; setPlaying(false); console.warn('audio play() rejected:', e); });
      } else {
        setPlaying(true);
      }
    } else {
      audio.pause();
      audio.currentTime = 0;
      setPlaying(false);
    }
  });
  audio.addEventListener('ended', () => {
    // "Play once and then stop" — when the audio finishes
    // naturally, reset the button to its initial Play state.
    // The audio element's `loop` attribute is NOT set, so we
    // never get into a loop on our own.
    setPlaying(false);
  });
  audio.addEventListener('pause', () => {
    // If the audio pauses for any reason (manual, ended, OS
    // media-key), reset the button label.
    if (audio.currentTime === 0 || audio.ended) setPlaying(false);
  });
  wrap.append(icon, name, playBtn, status);
  root.append(wrap, audio);
  const fname = el('div', { class: 'preview-pane-filename', title: p }, filename);
  root.appendChild(fname);
}

// Video preview. Click on a .mp4 (or other supported video) in the
// file browser → the preview pane shows the video with the OS-native
// <video controls> bar so the user can play / pause / seek / adjust
// volume / go fullscreen. Clicking the video element itself opens a
// larger overlay (the same overlay pattern used for images, adapted
// to host a <video> element + a big Play button).
function previewVideoFromFile(p) {
  const root = $('#fb-preview-content');
  if (!root) return;
  if (state._lastPreviewPath === p) return;
  state._lastPreviewPath = p;
  state._previewBatch = null;
  markFbItemActive(p);
  const url = fileUrl(p);
  const filename = (p || '').split(/[\\/]/).pop() || 'video';
  // Pause any previously-playing media first.
  if (typeof window._stopPreviewMedia === 'function') window._stopPreviewMedia();
  root.innerHTML = '';
  // Thumbnail-style video preview: a <video> with `controls`
  // AND `preload="metadata"` so the first frame is fetched
  // and shown even before the user clicks Play. The thumbnail
  // is the click target for the overlay.
  const wrap = el('div', { class: 'preview-pane-video' });
  const vid = el('video', {
    src: url,
    controls: '',
    preload: 'metadata',
    title: filename + ' — click for the full-size overlay',
    class: 'preview-pane-video-el',
  });
  // The overlay path is the same modal used for images; it
  // accepts a custom render callback so we can put a <video>
  // + big Play button inside. We use the user's spec: "preview
  // image to trigger the overlay, in which a play button can
  // play the video".
  vid.addEventListener('click', (e) => {
    // Don't open the overlay if the user is interacting with
    // the native controls (the controls bar is at the bottom
    // of the element).
    e.preventDefault();
    openVideoOverlay(url, filename, p);
  });
  wrap.appendChild(vid);
  root.appendChild(wrap);
  const fname = el('div', { class: 'preview-pane-filename', title: p }, filename);
  root.appendChild(fname);
}

// Open the full-size video overlay (image-overlay shape, but
// with a <video> + big Play button in the centre). Uses the
// shared showModal primitive so Esc / click-outside close
// it. The Play button is hidden once the video starts
// playing (the user can pause via the native controls at the
// bottom of the video).
function openVideoOverlay(src, filename, filePath) {
  if (typeof showModal !== 'function') return;
  showModal((m, close) => {
    m.classList.add('video-overlay');
    const header = el('div', { class: 'video-overlay-header' }, [
      el('span', { class: 'video-overlay-filename', title: filename || '' }, filename || ''),
      el('button', { type: 'button', class: 'btn-mini', onclick: close }, '✕ Close'),
    ]);
    m.appendChild(header);
    const wrap = el('div', { class: 'video-overlay-stage' });
    const vid = el('video', { src, controls: '', preload: 'metadata', class: 'video-overlay-el' });
    wrap.appendChild(vid);
    // Big Play button overlay, centred on top of the video.
    // Click → start playback; the button hides itself once
    // the video starts playing and the native controls take
    // over.
    const playBtn = el('button', { type: 'button', class: 'video-overlay-playbtn' }, '▶ Play');
    playBtn.addEventListener('click', () => {
      const p = vid.play();
      if (p && typeof p.then === 'function') {
        p.then(() => { playBtn.style.display = 'none'; })
         .catch((e) => { console.warn('video play() rejected:', e); });
      } else {
        playBtn.style.display = 'none';
      }
    });
    vid.addEventListener('play', () => { playBtn.style.display = 'none'; });
    vid.addEventListener('pause', () => {
      // Re-show the Play button when paused (e.g. user clicked
      // pause on the native controls, or the video ended).
      if (vid.currentTime > 0 || vid.ended) playBtn.style.display = '';
    });
    vid.addEventListener('ended', () => {
      // "Play once and then stop" — when the video ends, reset
      // the playhead AND re-show the big Play button so the
      // user can play it again. The video element's `loop`
      // attribute is NOT set.
      vid.currentTime = 0;
      playBtn.style.display = '';
    });
    wrap.appendChild(playBtn);
    m.appendChild(wrap);
    const fname = el('div', { class: 'video-overlay-meta', title: filePath || '' }, filePath || '');
    m.appendChild(fname);
  });
}

async function previewTextFromFile(p) {
  const root = $(`#tab-${state.currentTab} .preview`);
  if (!root) return;
  // BGR-009 fix: mint read grant for fbRead (R1.3 gate).
  const readGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(p) : undefined;
  const r = await window.api.fbRead(p, readGrant);
  root.innerHTML = '';
  if (!r.ok) { root.innerHTML = '<div class="empty">Cannot read: ' + escapeHtml(r.error) + '</div>'; return; }
  // Decode base64 → binary string → UTF-8 text. Plain `atob` only gives a
  // Latin-1 binary string, which mangles non-ASCII characters. TextDecoder
  // with {fatal: false} replaces invalid sequences with U+FFFD instead of
  // throwing, so partially-decodable files still display.
  let txt = '';
  try {
    const bin = atob(r.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    txt = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (_) {
    // Fallback to the old (Latin-1-ish) decoding if TextDecoder is missing
    txt = atob(r.base64);
  }
  const pre = el('pre', { class: 'meta', style: 'white-space: pre-wrap; max-height: 60vh; overflow: auto;' }, txt);
  root.appendChild(pre);
  root.appendChild(el('div', { class: 'meta' }, p));
}

// In-app clipboard for the file browser. The OS clipboard is shared via the
// browser's native copy/paste (Ctrl+C / Ctrl+X / Ctrl+V on selected items),
// but the in-app file ops use this list so we can track cut vs. copy
// semantics and undo a paste on failure.
let _fbClipboard = null; // { op: 'copy' | 'cut', paths: string[] }

function fbClipboardCopy(paths) {
  _fbClipboard = { op: 'copy', paths: paths.slice() };
  toast(`Copied ${paths.length} item${paths.length === 1 ? '' : 's'} to clipboard.`, 'ok', 1500);
}
function fbClipboardCut(paths) {
  _fbClipboard = { op: 'cut', paths: paths.slice() };
  toast(`Cut ${paths.length} item${paths.length === 1 ? '' : 's'} to clipboard.`, 'ok', 1500);
}
async function fbClipboardPaste(destDir) {
  if (!_fbClipboard || !_fbClipboard.paths.length) {
    toast('Clipboard is empty.', 'warn'); return;
  }
  if (!destDir) { toast('No destination folder selected.', 'err'); return; }
  const op = _fbClipboard.op;
  const src = _fbClipboard.paths;
  let ok = 0, fail = 0, skipped = 0;
  for (const p of src) {
    // Refuse to copy/cut a folder into itself or any of its descendants.
    const pLow = p.replace(/[\\/]+$/, '').toLowerCase();
    const dLow = destDir.replace(/[\\/]+$/, '').toLowerCase();
    if (pLow === dLow || dLow.startsWith(pLow + (destDir.includes('\\') ? '\\' : '/'))) {
      toast('Skipped: cannot paste a folder into itself.', 'warn');
      skipped++;
      continue;
    }
    if (op === 'cut') {
      // Move: prefer fbMove (handles clobber auto-rename in the main process)
      // BGR-009 fix: mint move grant (R1.3 gate).
      // gewv2 GEW-002 fix: ensureMove returns { ok, srcGrant, destGrant }.
      const mv = (window.GrantHelper) ? await window.GrantHelper.ensureMove(p, destDir) : undefined;
      const r = await window.api.fbMove(p, destDir, mv && mv.srcGrant, mv && mv.destGrant);
      if (r.ok) ok++; else fail++;
    } else {
      // Copy: read + write via the main process. We don't have a fbCopy
      // yet; fall back to reading + writing a file at a time. For folders,
      // skip with a warning (the main process doesn't recurse-copy).
      // BGR-009 fix: mint copy grant (R1.3 gate).
      // gewv2 GEW-002 fix: ensureCopy returns { ok, srcGrant, destGrant }.
      const cp = (window.GrantHelper) ? await window.GrantHelper.ensureCopy(p, destDir) : undefined;
      const r = await window.api.fbCopy(p, destDir, cp && cp.srcGrant, cp && cp.destGrant).catch(() => null);
      if (r && r.ok) ok++;
      else if (r && r.error) { toast(r.error, 'err'); fail++; }
      else { toast('Copy not supported for this item.', 'err'); fail++; }
    }
  }
  toast(`${op === 'cut' ? 'Moved' : 'Copied'} ${ok}${fail ? `, ${fail} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}.`,
        fail ? 'warn' : 'ok');
  if (op === 'cut' && ok) _fbClipboard = null;
  await refreshBrowser();
}

function showItemContextMenu(it, x, y, opts) {
  // Multi-select batch for the image-pipeline actions. When this menu
  // is opened from the folder explorer (opts.allowBatch) on an image
  // that is itself CHECKED, and ≥2 images are checked, the pipeline
  // actions (Upscale / Crop / Convert / Optimize / Remove background)
  // apply to ALL checked images instead of only the right-clicked one.
  // The preview-pane / overlay / music-tab entry points go through
  // showItemContextMenuForPath, which does NOT pass allowBatch, so
  // they keep the single-file behaviour.
  const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
  const extOfPath = (p) => {
    const name = (p || '').split(/[\\/]/).pop() || '';
    const d = name.lastIndexOf('.');
    return d > 0 ? name.slice(d).toLowerCase() : '';
  };
  const itIsImage = !it.isDir && IMG_EXTS.includes(it.ext);
  let batchTargets = null;
  if (opts && opts.allowBatch && itIsImage && state.fbSelected && state.fbSelected.has(it.path)) {
    const imgs = Array.from(state.fbSelected).filter((p) => IMG_EXTS.includes(extOfPath(p)));
    if (imgs.length >= 2) batchTargets = imgs;
  }
  const batchN = batchTargets ? batchTargets.length : 0;

  showModal((m, close) => {
    m.classList.add('fb-context-menu-modal');
    m.appendChild(el('h2', {}, batchN ? `${batchN} images selected` : it.name));
    m.appendChild(el('div', { class: 'meta', style: 'margin-bottom: 8px; color: var(--fg-2);' }, batchN ? `${it.path}  (+${batchN - 1} more)` : it.path));
    if (batchN) {
      m.appendChild(el('div', {
        style: 'margin: 0 0 8px; padding: 6px 9px; border: 1px solid var(--accent, #5b9dd9); border-radius: var(--radius-sm, 6px); background: rgba(91,157,217,0.10); color: var(--fg-1); font-size: 12px;',
      }, `🗂 Image-pipeline actions below (Upscale / Crop / Convert / Optimize / Remove background) will run on all ${batchN} checked images.`));
    }

    // The action list is rendered as a 2-column grid (CSS grid,
    // auto-flow row) so the modal stays compact. The image preview
    // lives in the right column. When the file is an image, the grid
    // pulls the preview to the right and stacks the action grid on
    // the left; for non-image files the preview becomes a small
    // placeholder.
    const body = el('div', { class: 'fb-context-menu-body' });
    const leftCol = el('div', { class: 'fb-context-menu-left' });
    const rightCol = el('div', { class: 'fb-context-menu-right' });
    body.appendChild(leftCol);
    body.appendChild(rightCol);
    m.appendChild(body);

    // File-info block (one row of meta: type, size, modified, …)
    const isImage = !it.isDir && ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(it.ext);
    const isAudio = !it.isDir && ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.opus', '.aac', '.wma', '.aif', '.aiff'].includes(it.ext);
    const info = el('div', { class: 'fb-item-info' });
    if (it.isDir) {
      info.appendChild(el('div', { class: 'fb-info-row' }, [
        el('span', { class: 'fb-info-key' }, 'Type'),
        el('span', {}, 'Folder'),
      ]));
    } else {
      const extLabel = (it.ext || '').replace('.', '').toUpperCase() || 'file';
      info.appendChild(el('div', { class: 'fb-info-row' }, [
        el('span', { class: 'fb-info-key' }, 'Type'),
        el('span', {}, extLabel),
      ]));
      info.appendChild(el('div', { class: 'fb-info-row' }, [
        el('span', { class: 'fb-info-key' }, 'Size'),
        el('span', {}, humanSize(it.size || 0)),
      ]));
      info.appendChild(el('div', { class: 'fb-info-row' }, [
        el('span', { class: 'fb-info-key' }, 'Modified'),
        el('span', {}, formatDate(it.mtimeMs)),
      ]));
      if (isImage) {
        const dimCell = el('div', { class: 'fb-info-row' }, [
          el('span', { class: 'fb-info-key' }, 'Dimensions'),
          el('span', { class: 'fb-info-dim' }, 'detecting…'),
        ]);
        info.appendChild(dimCell);
        loadImageFromFile(it.path).then((img) => {
          const dim = dimCell.querySelector('.fb-info-dim');
          if (!dim) return;
          if (img.naturalWidth && img.naturalHeight) {
            dim.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
          } else {
            dim.textContent = 'unknown';
          }
        }).catch(() => {
          const dim = dimCell.querySelector('.fb-info-dim');
          if (dim) dim.textContent = 'unreadable';
        });
      }
    }
    leftCol.appendChild(info);

    // ---- 2-column action grid ----
    // Build a flat list of action descriptors; the grid wraps them
    // into a CSS grid (auto-fit, min 120px). Each action is just a
    // <button> + an optional help "?" pill.
    const actions = [];
    // Open / Preview, Open in Explorer, Reveal
    actions.push({ label: '👁 Open / Preview', onClick: async () => { close(); await openItem(it); } });
    actions.push({ label: '📂 Open in Explorer', onClick: async () => {
      close();
      try {
        const r = await window.api.fbOpenInExplorer(it.path);
        if (!r || !r.ok) toast('Open in Explorer failed: ' + ((r && r.error) || 'unknown error'), 'err', 4000);
      } catch (e) { toast('Open in Explorer failed: ' + (e && e.message || e), 'err', 4000); }
    } });
    actions.push({ label: '↗ Reveal', onClick: async () => { close(); await window.api.fbReveal(it.path); } });

    // Image pipeline — only for image files
    if (isImage) {
      actions.push({
        label: batchN ? `🔍 Upscale ${batchN}` : '🔍 Upscale',
        onClick: () => { close(); showUpscaleDirect(it.path, batchTargets); },
        help: 'Make the image bigger (2×, 3×, or 4×) using the built-in canvas pipeline, or the higher-quality Real-ESRGAN binary if installed. The new file is written next to the original with a "_2x" / "_3x" / "_4x" suffix in the filename.',
      });
      actions.push({
        label: batchN ? `✂ Crop ${batchN}` : '✂ Crop',
        onClick: () => { close(); showCropOverlay(it.path, batchTargets); },
        help: 'Crop the image to a specific rectangle. Drag the crop frame with the mouse, or type exact W × H values. The cropped file is written next to the original with a "_cropped_WxH" suffix. For a multi-selection the same crop rectangle is applied to every checked image (clamped to each image\'s bounds).',
      });
      actions.push({
        label: batchN ? `📐 Resize ${batchN}` : '📐 Resize',
        onClick: () => { close(); showResizeOverlay(it.path, batchTargets); },
        help: 'Resize to an exact target resolution (W × H in pixels) with best-quality Lanczos3 resampling. A 🔗 chain link keeps the source aspect ratio (default); unlock it to set W and H independently. A subtle sharpen is applied when downscaling. For a large enlargement the tool offers the dedicated Upscale (Real-ESRGAN) instead, which adds real detail.',
      });
      actions.push({
        label: batchN ? `⇄ Convert ${batchN}` : '⇄ Convert',
        onClick: () => { close(); showConvertOverlay(it.path, batchTargets); },
        help: 'Re-encode the image to a different format. PNG is lossless (good for screenshots / illustrations, supports transparency). JPEG is much smaller (good for photos, no transparency). WebP is a modern middle ground.',
      });
      actions.push({
        label: batchN ? `🗜 Optimize ${batchN}` : '🗜 Optimize',
        onClick: () => { close(); showOptimizeOverlay(it.path, batchTargets); },
        help: 'Shrink the file size while keeping the image looking (almost) the same. The default quality of 82 is the "perceptually lossless" sweet spot for photos. You can also re-encode to WebP / AVIF for further size savings, and strip non-essential EXIF data.',
      });
      actions.push({
        label: batchN ? `✨ Remove BG (${batchN})` : '✨ Remove BG',
        onClick: () => { close(); showRemoveBgOverlay(it.path, batchTargets); },
        help: 'Replace the background of the image with transparency. Uses the optional IS-Net model (a state-of-the-art segmentation model) — the tool walks you through the one-time install on first use. The result is a transparent PNG written next to the original.',
      });
      actions.push({
        label: batchN ? `✏ Edit (${batchN})` : '✏ Edit',
        onClick: () => { close(); showImageEditOverlay(it.path, batchTargets); },
        help: 'Open the in-app pixel editor (paint brush, spray, eraser to transparency, color picker, zoom/pan). Also lets you load a second image and place/rotate/scale it onto the canvas, and heal/inpaint small mistakes from background removal.',
      });
    }
    if (isAudio) {
      actions.push({
        label: '✂ Audio cut',
        onClick: () => {
          close();
          try {
            if (typeof window.showAudioCutter === 'function') window.showAudioCutter(it.path);
            else toast('Audio cutter module not loaded.', 'err');
          } catch (e) { toast('Audio cutter failed: ' + (e && e.message || e), 'err', 5000); }
        },
        help: 'Open the audio in a waveform editor. Drag the two markers to set the selection, or use the time inputs for millisecond precision. Quality-of-life helpers: "Auto-trim silence" removes leading/trailing silence, "Snap to zero-crossing" prevents clicks at the cut edges, and a configurable micro-fade (5 ms by default) buries any residual click. Pick a different output format (MP3 / WAV / OGG / Opus / FLAC / M4A) from the dropdown, then "Export" writes the trimmed file next to the original.',
      });
    }

    // "Add to Pipeline" for image files. Copies the selected image(s)
    // into the Pipeline workspace's Original column (non-destructive —
    // the source files stay where they are). Works on the single
    // clicked item OR the multi-selection (batchTargets).
    if (isImage) {
      actions.push({
        label: batchN ? `🛤 Add to Pipeline (${batchN})` : '🛤 Add to Pipeline',
        onClick: async () => {
          close();
          try {
            if (typeof window.Pipeline === 'undefined' || !window.Pipeline.enqueueFromPaths) {
              toast('Pipeline module not loaded.', 'err'); return;
            }
            const targets = batchTargets || [it.path];
            const r = await window.Pipeline.enqueueFromPaths(targets);
            if (r && r.ok) toast(`Added ${r.added} image(s) to Pipeline.`, 'ok');
            else toast('Add to Pipeline failed: ' + ((r && r.error) || 'unknown'), 'err');
          } catch (e) { toast('Add to Pipeline failed: ' + (e && e.message || e), 'err', 5000); }
        },
        help: 'Copy the selected image(s) into the Pipeline workspace so you can run them through the visual column-based workflow. Your original files are not moved.',
      });
    }

    // External tools (3rd-party .exe hand-off). For each configured
    // tool, render a button that launches it with the file path
    // appended. When multi-file is in effect (batchTargets or a
    // checked non-image file), every tool button applies to ALL
    // selected files — same shape as the image-pipeline batch above.
    // The args come from the persisted tool config; the file paths
    // come from the selection. A one-click "Open with…" entry opens
    // the settings dialog's External tools pane when no tools are
    // configured.
    const externalTools = (state.config && Array.isArray(state.config.external_tools)) ? state.config.external_tools : [];
    // For non-folder items: choose either the batchTargets (image
    // multi-select) OR a generic multi-file selection from
    // state.fbSelected. We prefer the same list the image pipeline
    // used so the user gets a consistent "this many files" answer
    // across the whole menu.
    let handOffPaths = null;
    if (!it.isDir) {
      if (batchTargets) handOffPaths = batchTargets;
      else if (state.fbSelected && state.fbSelected.has(it.path) && state.fbSelected.size >= 2) {
        // Multi-file selection of non-image files: hand them all off.
        handOffPaths = Array.from(state.fbSelected);
      } else {
        handOffPaths = [it.path];
      }
    }
    if (!it.isDir && handOffPaths) {
      // Header pill (acts as a visual section break inside the
      // grid; the grid packs it inline because it's a button-
      // styled <div>).
      actions.push({ label: `🔧 Open in… (${handOffPaths.length})`, isSectionHeader: true });
      for (const tool of externalTools) {
        if (!tool || !tool.name) continue;
        const label = handOffPaths.length > 1
          ? `🔧 Open ${handOffPaths.length} in ${tool.name}`
          : `🔧 Open in ${tool.name}`;
        actions.push({
          label,
          onClick: async () => {
            close();
            try {
              // R1.5b.2: mint a read grant for the file paths before handing off.
              const grantId = (window.GrantHelper) ? await window.GrantHelper.ensureExternalToolRead(handOffPaths) : undefined;
              if (grantId && grantId.ok === false) {
                toast(`Could not launch ${tool.name}: ${grantId.error || 'grant error'}`, 'err', 5000);
                return;
              }
              const r = await window.api.externalToolsRun({ name: tool.name, paths: handOffPaths }, grantId);
              if (!r || !r.ok) {
                toast(`Could not launch ${tool.name}: ${(r && r.error) || 'unknown error'}`, 'err', 5000);
              } else {
                toast(`Launched ${tool.name} with ${handOffPaths.length} file${handOffPaths.length === 1 ? '' : 's'} (pid ${r.pid || '?'}).`, 'ok', 3500);
              }
            } catch (e) { toast(`External tool launch failed: ${e && e.message || e}`, 'err', 5000); }
          },
        });
      }
      // "Manage tools…" entry — opens the dedicated "External tools"
      // settings tab (Issue-3), which hosts the External tools editor
      // (H7-016). Before the Issue-3 restructure the editor lived in the
      // Add-ons tab and this entry targeted data-tab-button="addons".
      actions.push({
        label: '⚙ Manage tools…',
        onClick: () => {
          close();
          try {
            if (typeof showSettingsAndSwitchTab === 'function') {
              showSettingsAndSwitchTab('tools');
            } else if (typeof openSettings === 'function') {
              openSettings();
              setTimeout(() => {
                try {
                  const tab = document.querySelector('.settings-tab-button[data-tab-button="tools"]');
                  if (tab) tab.click();
                } catch (_) { /* best-effort */ }
              }, 100);
            }
          } catch (e) { toast('Could not open settings: ' + (e && e.message || e), 'err', 4000); }
        },
        help: externalTools.length
          ? 'Edit the list of 3rd-party tools (name, exe path, extra args).'
          : 'No external tools configured yet. Add a 3rd-party .exe (GIMP, Photoshop, Notepad++, …) and it will appear here.',
      });
    }

    // File-level actions (clipboard + rename/move/delete)
    actions.push({ label: '📋 Copy', onClick: () => { close(); fbClipboardCopy([it.path]); } });
    actions.push({ label: '✂ Cut', onClick: () => { close(); fbClipboardCut([it.path]); } });
    actions.push({ label: '✎ Rename…', onClick: () => { close(); promptRename(it); } });
    actions.push({ label: '➡ Move to…', onClick: () => { close(); promptMove(it); } });
    actions.push({ label: '📥 Paste here', onClick: async () => { close(); await fbClipboardPaste(state.fbDir); } });
    actions.push({ label: '🗑 Delete', onClick: () => { close(); confirmDelete(it); }, danger: true });

    // Render the action grid. Each action is a <button> wrapped in
    // a <div class="fb-context-menu-action">. The grid uses
    // `auto-fit, minmax(120px, 1fr)` so a 2-wide layout becomes 3 or
    // 4 columns on a wider modal — the user just doesn't see
    // scrollbars (the grid always fits the available width).
    const grid = el('div', { class: 'fb-context-menu-grid' });
    for (const a of actions) {
      if (a.isSectionHeader) {
        // Section header is a non-button strip; it acts as a visual
        // separator AND the first item of the next "column" in the
        // grid (CSS `grid-column: 1 / -1`).
        const header = el('div', { class: 'fb-context-menu-section-header' }, a.label);
        grid.appendChild(header);
        continue;
      }
      const btn = el('button', {
        class: 'btn-mini fb-context-menu-action' + (a.danger ? ' danger' : ''),
        type: 'button',
        title: a.help || a.label,
        onclick: a.onClick,
      }, a.label);
      if (a.help) {
        btn.setAttribute('data-help', a.help);
      }
      grid.appendChild(btn);
    }
    leftCol.appendChild(grid);

    // Right column: image preview (or a placeholder).
    if (isImage) {
      const previewWrap = el('div', { class: 'fb-context-menu-preview' });
      const filename = it.name || 'image';
      const url = fileUrl(it.path);
      const img = el('img', {
        src: url,
        alt: filename,
        class: 'fb-context-menu-thumb',
        title: 'Click to open full-size preview',
      });
      let clickBound = false;
      const bindClick = (w, h) => {
        if (clickBound) return;
        clickBound = true;
        img.addEventListener('click', () => {
          close();
          openImageOverlay(url, filename, w, h, it.path);
        });
      };
      const probe = new Image();
      probe.onload = () => bindClick(probe.naturalWidth, probe.naturalHeight);
      probe.onerror = () => bindClick(0, 0);
      probe.src = url;
      setTimeout(() => bindClick(0, 0), 3000);
      previewWrap.appendChild(img);
      previewWrap.appendChild(el('div', { class: 'fb-context-menu-thumb-caption' }, filename));
      rightCol.appendChild(previewWrap);
    } else {
      const empty = el('div', { class: 'fb-context-menu-preview-empty' }, [
        el('div', { class: 'fb-context-menu-preview-icon' }, it.isDir ? '📁' : '🗎'),
        el('div', { class: 'fb-context-menu-preview-label' }, it.isDir ? 'Folder' : 'No preview'),
      ]);
      rightCol.appendChild(empty);
    }

    const footer = el('div', { class: 'footer' }, el('button', { class: 'btn-mini', onclick: close }, 'Close'));
    m.appendChild(footer);
  });
}

function showContainerContextMenu(x, y) {
  showModal((m, close) => {
    m.classList.add('fb-context-menu-modal');
    m.appendChild(el('h2', {}, 'Folder options'));
    m.appendChild(el('div', { class: 'meta', style: 'margin-bottom: 8px; color: var(--fg-2);' }, state.fbDir || ''));
    const actions = [
      { label: '📥 Paste here', onClick: async () => { close(); await fbClipboardPaste(state.fbDir); } },
      { label: '📁 New folder…', onClick: () => { close(); promptNewFolder(); } },
      { label: '↻ Refresh', onClick: () => { close(); refreshBrowser(); } },
    ];
    const grid = el('div', { class: 'fb-context-menu-grid' });
    for (const a of actions) {
      grid.appendChild(el('div', { class: 'fb-context-menu-action' },
        el('button', { type: 'button', class: 'btn-mini', onclick: a.onClick }, a.label)));
    }
    m.appendChild(grid);
    m.appendChild(el('div', { class: 'footer' }, el('button', { class: 'btn-mini', onclick: close }, 'Close')));
  });
}

window.showContainerContextMenu = showContainerContextMenu;
window.fbClipboardPaste = fbClipboardPaste;


