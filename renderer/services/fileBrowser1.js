// renderer/services/fileBrowser1.js
// First half of the File browser section.

// This file loads before the state module. If 'state' is undefined,
// any 'state.X' line throws a TypeError and aborts the whole file.
// With 'var state = window.state || {}' the local is an empty object
// until the real state module loads and mutates window.state.
var state = window.state || {};
var refreshBrowser; // forward-declaration, defined below
var applyFileSearch; // forward-declaration

// Filter the items the renderer receives down to the supported asset
// types (images, audio, video, text/lrc) plus directories, and drop
// anything else. Folders always pass (a folder might contain a
// "generated" subfolder the user wants to navigate into), so the ".."
// parent row and every subdir stays visible. The user can opt out of
// the filter via the "Show all files" toggle in the Folder options
// dialog (default: OFF — only the supported types show).
//
// One global list, kept in sync with the iconForFile / openItem /
// type-filter dropdowns so a future change to a single source (e.g.
// "we now also preview .heic") flips the behaviour in every consumer.
// Directories always pass (their "type" is "folder", no extension).
const SUPPORTED_FILE_EXTS = [
  // Images (preview + image-pipeline + thumbnails). AVIF is included because
  // the image optimizer/pipeline can both read and WRITE .avif output — a
  // generated/converted AVIF must stay visible in the browser (H7-019).
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif',
  // Audio (preview + audio cutter)
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.opus',
  '.pcm', '.aac', '.wma', '.aif', '.aiff',
  // Video (preview)
  '.mp4', '.webm', '.mov', '.mkv', '.avi',
  // Text (subtitles / lyrics / notes)
  '.txt', '.srt', '.json', '.md', '.lrc',
];
const _supportedExtSet = new Set(SUPPORTED_FILE_EXTS);
function isSupportedAssetFile(it) {
  if (!it) return false;
  if (it.isDir) return true;
  const ext = (it.ext || '').toLowerCase();
  return _supportedExtSet.has(ext);
}

// When the user enables "Show all files" in the Folder options, this
// is the live filter. Used both by refreshBrowser (to drop items at
// the list source) and by applyFileSearch (to double-check the
// typeFilter dropdown), so the two paths stay in lock-step.
function isItemVisibleInList(it) {
  if (!it) return false;
  if (it.isDir) return true;
  // When the user wants to see everything, skip the supported-
  // types check. We still respect the typeFilter dropdown below
  // (so a user who set "Images only" doesn't suddenly see
  // .exes too).
  if (state.fbShowAllFiles) return true;
  return _supportedExtSet.has((it.ext || '').toLowerCase());
}

// Expose the key functions on window eagerly. Function declarations
// are hoisted, so they exist on window even if a later line in this
// file throws.
//
// refreshBrowser is serialised: two overlapping refreshes (a
// double-click on ".." right after clicking into a subfolder, or a
// polling tick during a manual refresh) used to resolve in IPC order,
// so the later-completing one wrote state.fbDir and could land the
// user at the wrong folder. A shared-promise + pending-flag pattern
// is used instead: the first caller runs the real refresh, concurrent
// callers await the same promise, and if any caller arrived during the
// refresh exactly ONE follow-up runs afterwards — so the user's latest
// intent wins.
//
// The in-flight IIFE only writes `state.fbDir = target.dir` when the
// live value still matches the entry-time snapshot. If the user has
// navigated elsewhere during the await, the write is skipped and the
// in-flight guard runs a follow-up refresh that reads the new
// state.fbDir. This prevents the IIFE from clobbering a newer
// navigation that happened while fbList was in flight.
let _refreshInFlight = null;
let _refreshPending = false;
async function refreshBrowser(opts = {}) {
  // R1.3: push the renderer's current file-browser location to the
  // main process on every navigation. The IPC is a NAVIGATION-ONLY
  // ACK — it no longer widens the trust set or alters the activeDir
  // (S1 §4 "File Browser"). The call is kept here for renderer-API
  // surface stability but is a no-op for authorization. A mutating
  // IPC must present a Main-minted grantId; the visible fbDir is
  // NOT sufficient to authorise a write. The '__DRIVES__' sentinel
  // is skipped (it's not a real path) and so is an empty fbDir
  // (which would be meaningless to forward).
  try {
    const cur = String(state && state.fbDir || '');
    if (cur && cur !== '__DRIVES__'
        && window.api && typeof window.api.fbSetActiveDir === 'function') {
      window.api.fbSetActiveDir(cur).catch(() => {});
    }
  } catch (_) {}
  // KGO4-009: mint a directory read grant before listing.
  async function fbListWithGrant(dir) {
    if (!dir) return { ok: false, error: 'Path is required.' };
    const g = (window.GrantHelper && window.GrantHelper.ensureDirList) ? await window.GrantHelper.ensureDirList(dir) : undefined;
    return (g && g.ok === false) ? g : window.api.fbList(dir, g);
  }
  if (_refreshInFlight) {
    // Mark a single follow-up; the in-flight refresh will re-run
    // with the latest state (state.fbDir will reflect the user's
    // most recent navigation by then).
    _refreshPending = true;
    try { await _refreshInFlight; } catch (_) {}
    if (_refreshPending) {
      _refreshPending = false;
      // Recurse to run the follow-up with the freshest state. The
      // recursion is bounded because the follow-up clears
      // _refreshPending before awaiting.
      return refreshBrowser(opts);
    }
    return;
  }
  _refreshPending = false;
  _refreshInFlight = (async () => {
  // Drives-list view. When the user clicks Up from a drive root,
  // state.fbDir is set to the '__DRIVES__' sentinel — a non-path
  // value that means "render the list of available drives". The list
  // comes from the main process (fb:listDrives IPC) so the renderer
  // doesn't have to know which platform it's on. Selecting a drive
  // sets state.fbDir to the drive's path and the next refreshBrowser()
  // lands the user in that drive's root. The sentinel is never
  // persisted (state.fbDir is reset to the output root on restart).
  if (state.fbDir === '__DRIVES__') {
    try {
      const drivesRes = await window.api.fbListDrives();
      const drives = (drivesRes && Array.isArray(drivesRes.drives)) ? drivesRes.drives : [];
      renderFbDrivesList(drives);
      const fbPath = $('#fb-path');
      if (fbPath) { fbPath.textContent = '(drives)'; fbPath.title = 'Pick a drive to continue'; }
      // Update the Up button (disabled at the drives list).
      const upBtn = $('#fb-up');
      if (upBtn) { upBtn.disabled = true; upBtn.classList.add('fb-up-disabled'); upBtn.title = 'You are at the drives list. Pick a drive to continue.'; }
    } catch (e) {
      // Surface the actual IPC failure so the user can see why the
      // drives list is empty (typically a permission issue or a
      // malformed preload binding). Without this, the browser just
      // goes blank.
      if (typeof window.logError === 'function') {
        window.logError('fb-list-drives', 'renderer/services/fileBrowser1.js:fbListDrives', e);
      }
      const fbListEl = $('#fb-list');
      if (fbListEl) fbListEl.innerHTML = '';
      const fbPath = $('#fb-path');
      if (fbPath) fbPath.textContent = '(could not list drives)';
    }
    return;
  }
  // Prefer the per-tab saved folder (set when the user last visited this
  // tab), then the current fbDir, then the output root, then the
  // platform-default output dir (Electron's `userData/generated`,
  // resolved via the main process). The final fallback exists so a
  // brand-new install with no config, no per-tab folder, and no
  // fbDir still lands on a real, existing folder (%APPDATA%\…
  // \MiniMaxAssetTool\generated on Windows, …/.config/…/generated
  // on Linux) instead of an empty string that fbList() would
  // reject with "Path is outside the allowed directories." See
  // src/config.js#defaultOutputDir for the canonical resolution.
  const saved = (state.currentTab && state.fbDirs[state.currentTab]) || '';
  // Capture the entry-time fbDir into a local so the IIFE can detect
  // (after the await) whether the user has navigated away. Comparing
  // against this snapshot (not the live value) means a navigation
  // that happens BEFORE this refresh starts is honoured, but one that
  // happens DURING the await is not clobbered.
  let startDir = state.fbDir || saved || state.config.output_dir || '';
  if (!startDir) {
    // Last-ditch fallback: ask the main process for the same
    // path the IPC would default to. `window.api.defaultOutputDir`
    // is exposed in preload and resolves to a folder that always
    // exists (Electron creates `userData` on first access). If the
    // IPC is missing (test context) or the call throws, fall
    // through to '' — the !out branch below then shows a clear
    // "no output dir" message and re-enables the Up button so the
    // user can navigate to a real folder manually.
    try {
      const def = await window.api.defaultOutputDir();
      if (def) startDir = def;
    } catch (_) { /* best-effort */ }
  }
  let out = await fbListWithGrant(startDir);
  // If the user's persisted folder is gone (deleted, drive removed),
  // fall back to output_dir. For explicit navigation outside the
  // allow-list, surface the error instead of silently rolling back.
  // Trust parent + sibling dirs of output_dir on demand so the Up
  // button works without forcing the user through the file picker.
  if (!out.ok && startDir && startDir !== (state.config.output_dir || '')) {
    // Did the user reach this folder through an explicit navigation
    // (e.g. the Up button / file picker / manual URL)? If so,
    // surface the error — silently rolling back is confusing.
    const _explicitNav = !!(opts && opts.keepCurrent) || window.__explicitFbDirNav === startDir;
    if (typeof window.logAction === 'function') {
      window.logAction('file-browser', 'fb-list-failed', {
        requested: startDir,
        err: out.error,
        keepCurrent: !!(opts && opts.keepCurrent),
        explicitNav: _explicitNav,
      });
    }
    if (_explicitNav) {
      // KGO5-006: revert + toast instead of clobbering the view.
      const prevDir = state.fbDirs[state.currentTab] || state.config.output_dir || '';
      if (typeof toast === 'function') toast('Navigation outside the authorized folder. Use the \uD83D\uDCC2 button to authorize a different directory.', 'warn', 6000);
      window.__explicitFbDirNav = null;
      if (!prevDir) return;
      state.fbDir = prevDir;
      const prevOut = await fbListWithGrant(prevDir);
      if (!prevOut || !prevOut.ok) return;
      out = prevOut;
      startDir = prevDir;
      // KGO6-004: STOP here. The revert succeeded; do NOT fall through
      // to the rollback block below (which would wipe fbDirs and fbDir,
      // undoing the revert we just performed).
    } else {
      if (state.currentTab && state.fbDirs[state.currentTab]) {
        state.fbDirs[state.currentTab] = '';
        scheduleStateSave();
      }
      state.fbDir = '';
      const fallback = state.config.output_dir || '';
      if (fallback) {
        startDir = fallback;
        out = await fbListWithGrant(fallback);
      }
    }
  }
  // Clear the explicit-nav marker so the next refresh doesn't
  // get stuck in the error branch above.
  if (window.__explicitFbDirNav === startDir) window.__explicitFbDirNav = null;
  // If even the output_dir root is gone (the user typed a path that
  // doesn't exist, or the drive was unmounted between launches), try
  // the platform-default directory (the same <userData>/generated the
  // main process uses as the canonical fallback). That folder always
  // exists (Electron creates userData on first access). Only after
  // that fails too do we surface the error.
  if (!out.ok) {
    try {
      const def = await window.api.defaultOutputDir();
      if (def && def !== startDir) {
        const fallbackOut = await fbListWithGrant(def);
        if (fallbackOut.ok) {
          out = fallbackOut;
          if (state.currentTab) {
            state.fbDirs[state.currentTab] = def;
            scheduleStateSave();
          }
          state.fbDir = def;
          startDir = def;
        }
      }
    } catch (_) { /* best-effort */ }
  }
  if (!out.ok) {
    $('#fb-list').innerHTML = '';
    $('#fb-path').textContent = out.error || '(no output dir)';
    // Re-enable the Up button so a transient error doesn't leave the
    // user stuck. The sentinel-driven drives-list branch (above)
    // handles the disabled state separately.
    const upBtn = $('#fb-up');
    if (upBtn) { upBtn.disabled = false; upBtn.classList.remove('fb-up-disabled'); upBtn.title = 'Up one level'; }
    return;
  }
  // For the file browser, default to current tab's subfolder if it exists.
  // Skip this when:
  //   - opts.keepCurrent is set (e.g. the Up button)
  //   - we already have a saved per-tab folder (the user has navigated
  //     within this tab before — respect their choice)
  let target = out;
  if (!opts.keepCurrent && !saved) {
    const sub = pathJoin(target.dir, state.currentTab);
    const subTry = await fbListWithGrant(sub);
    if (subTry.ok) target = subTry;
  }
  // The user's latest intent wins. The IIFE only updates state.fbDir
  // if the live value still matches the entry-time snapshot — i.e.
  // the user has not navigated elsewhere during the await. If they
  // have, the in-flight guard runs a follow-up refresh that reads the
  // new value, so we must not overwrite it here.
  if (state.fbDir === startDir || !state.fbDir) {
    state.fbDir = target.dir;
    // Keep the per-tab slot in sync with the actual browser location so
    // navigating within a tab (e.g. via the Up button) is remembered.
    // Also trigger an autosave so the new folder survives an app
    // restart even if the user never switches tabs afterwards.
    if (state.currentTab && state.fbDirs[state.currentTab] !== target.dir) {
      state.fbDirs[state.currentTab] = target.dir;
      scheduleStateSave();
    }
  } else {
    // The user has navigated elsewhere while we were waiting on
    // fbList. Mark a follow-up so the in-flight guard reruns
    // with the freshest state.fbDir.
    _refreshPending = true;
  }
  $('#fb-path').textContent = target.dir;
  $('#fb-path').title = target.dir;
  // Apply the user's preferred sort before rendering so the DOM
  // is created in the right order on the first paint (avoids a
  // flicker of "server-side default" → "user's sort" on every
  // refresh). sortFbItems never mutates the input array.
  const sorted = sortFbItems(target.items, state.fbSort);
  // Drop any items the tool can't do anything with. Directories always
  // pass; for files isItemVisibleInList() honours the user's "Show all
  // files" option (default: OFF — only supported asset types show).
  const visible = sorted.filter(isItemVisibleInList);
  renderFbList(visible);
  // Apply current search filter if any
  applyFileSearch();
  // Re-enable the Up button now that the user is in a real folder. The
  // button is disabled at the drives list (handled in the early-return
  // branch above), so every non-drives refresh must clear the disabled
  // state.
  const upBtn = $('#fb-up');
  if (upBtn) { upBtn.disabled = false; upBtn.classList.remove('fb-up-disabled'); upBtn.title = 'Up one level'; }
  // KGO7-007: …then let app.js re-apply the real ceiling (output_dir).
  if (typeof window.updateFbUpButton === 'function') { try { window.updateFbUpButton(); } catch (_) { /* never break a refresh */ } }
  })();
  // Wait for the wrapped refresh to settle, then clear the
  // in-flight slot. If a concurrent caller marked _refreshPending,
  // it will run a single follow-up with the latest state.
  try { await _refreshInFlight; } finally { _refreshInFlight = null; }
}
// Build the CSS grid-template-columns string for the file
// browser rows. Order: checkbox + icon + name (mandatory), then the
// user-enabled columns in declaration order.
//
// The icon column is wider (44px) when the image-thumbnail toggle is on
// so a small thumbnail can be centered in the cell. The ".." parent row
// skips the leftmost select column (checkboxes on the up row would be
// confusing), so the caller passes `withCheckbox = false` for the parent.
function buildFbGridTemplate(withCheckbox = true) {
  const iconW = state.fbThumbnails ? '44px' : '16px';
  const cols = withCheckbox ? ['18px', iconW, 'minmax(120px, 1fr)'] : [iconW, 'minmax(120px, 1fr)'];
  const fbCols = normalizeFbColumns(state.fbColumns);
  for (const c of FB_COLUMNS) {
    if (fbCols[c.id]) cols.push(c.gridTemplate);
  }
  return cols.join(' ');
}
// Build the icon cell (the first column) for a file-browser row.
// Renders either a centered thumbnail of the actual image file or
// the regular text icon. The cell carries a CSS class
// ('fb-thumb' or 'fb-icon') so styles.css can pick the right
// alignment per mode.
function _buildFbIconCell(it) {
  if (state.fbThumbnails && !it.isDir && _isImageExt(it.ext)) {
    const wrap = el('span', { class: 'icon fb-thumb', title: it.name + ' — thumbnail' });
    const img = el('img', {
      src: fileUrl(it.path),
      alt: '',
      loading: 'lazy',
      // Decoding async keeps the list scroll smooth even when a
      // folder contains hundreds of images.
      decoding: 'async',
    });
    img.addEventListener('error', () => {
      // If the thumbnail can't load (deleted file, permission
      // problem) fall back to the regular icon so the row still
      // shows something. We replace the <img> in-place rather
      // than recreating the row so the row's click handlers stay
      // attached.
      wrap.classList.remove('fb-thumb');
      wrap.classList.add('fb-icon');
      wrap.textContent = iconForFile(it.ext);
      // Tag the fallback with the per-type CSS class so the audio
      // icon is colour-tinted on the dark theme and stays visible at
      // a glance.
      const ic = iconClassForFile(it.ext);
      if (ic) wrap.classList.add(ic);
      wrap.title = it.name;
    });
    wrap.appendChild(img);
    return wrap;
  }
  // Apply the per-type icon class on the plain icon path too. The
  // class lets styles.css colour-tint the icon's background (so the
  // music-note icon stays visible on the dark theme). Without it the
  // music-note icon is effectively invisible on the dark-bg row.
  const iconCls = 'icon fb-icon' + (it.isDir ? '' : ' ' + (iconClassForFile(it.ext) || ''));
  return el('span', { class: iconCls, title: '' }, it.isDir ? '📁' : iconForFile(it.ext));
}

// Open the folder-options overlay. Lists every optional column
// as a checkbox (the "name" column is shown but locked on), and
// the "Sort" dropdown. The user toggles a column, clicks
// "Apply" (or just sees the change live via the change event),
// and the folder explorer re-renders with the new layout. The
// overlay re-renders the folder explorer immediately on every
// change so the user can see the columns appear / disappear
// before closing the modal.
function openFolderOptions() {
  showModal((m, close) => {
    m.classList.add('folder-options-modal');
    m.appendChild(el('h2', {}, '📁 Folder options'));
    m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
      'Pick which columns the folder explorer shows. The file-name column is always visible — turning it off would make the list unscannable. The horizontal scroll bar at the bottom of the list appears automatically when the columns don\'t fit the available width. Changes apply immediately.'));

    // Image-thumbnail toggle. When on, image rows in the file
    // browser show a centered thumbnail of the actual file
    // instead of the 🖼 icon. Row heights grow automatically so
    // the thumbnail is fully visible even when every column is
    // enabled. Folder rows and non-image files are unaffected.
    const thumbCb = el('input', { type: 'checkbox', class: 'folder-options-thumbnail-cb' });
    thumbCb.checked = !!state.fbThumbnails;
    thumbCb.addEventListener('change', () => {
      state.fbThumbnails = !!thumbCb.checked;
      scheduleStateSave();
      if (Array.isArray(state._fbItems) && state._fbItems.length) {
        renderFbList(sortFbItems(state._fbItems, state.fbSort));
        applyFileSearch();
      }
    });
    const thumbLabel = el('label', { class: 'folder-options-thumbnail-label' }, [
      thumbCb,
      el('span', {}, 'Show image thumbnails in the folder list'),
    ]);
    m.appendChild(thumbLabel);

    // The default hides any non-supported extension; the user can flip
    // the switch back to "show all" to see other files (e.g. a custom
    // binary helper dropped into the output folder).
    const showAllCb = el('input', { type: 'checkbox', class: 'folder-options-show-all-cb' });
    showAllCb.checked = !!state.fbShowAllFiles;
    showAllCb.addEventListener('change', () => {
      state.fbShowAllFiles = !!showAllCb.checked;
      scheduleStateSave();
      // Re-fetch + re-render the list so the filter is
      // applied (or lifted) immediately.
      if (typeof refreshBrowser === 'function') {
        refreshBrowser();
      }
    });
    const showAllLabel = el('label', { class: 'folder-options-show-all-label' }, [
      showAllCb,
      el('span', {}, 'Show all files (including unsupported types like .exe / .md)'),
    ]);
    m.appendChild(showAllLabel);

    // Column checkboxes
    const cols = normalizeFbColumns(state.fbColumns);
    const colGrid = el('div', { class: 'folder-options-cols' });
    for (const c of FB_COLUMNS) {
      const cb = el('input', { type: 'checkbox', class: 'folder-options-col-cb' });
      cb.checked = !!cols[c.id];
      cb.addEventListener('change', () => {
        state.fbColumns[c.id] = !!cb.checked;
        scheduleStateSave();
        // Re-render the live list so the user sees the column
        // appear / disappear immediately, without having to
        // close the modal first.
        if (Array.isArray(state._fbItems) && state._fbItems.length) {
          renderFbList(sortFbItems(state._fbItems, state.fbSort));
          applyFileSearch();
        }
      });
      const label = el('label', { class: 'folder-options-col-label' }, [
        cb,
        el('span', { class: 'folder-options-col-name' }, c.label),
      ]);
      colGrid.appendChild(label);
    }
    // "Name" column (mandatory) — shown but locked, so the user
    // knows the column order but can't accidentally remove it.
    {
      const cb = el('input', { type: 'checkbox', checked: 'checked', disabled: 'disabled' });
      const label = el('label', { class: 'folder-options-col-label folder-options-col-locked' }, [
        cb,
        el('span', { class: 'folder-options-col-name' }, 'File name (always shown)'),
      ]);
      colGrid.appendChild(label);
    }
    m.appendChild(colGrid);

    // Footer with Close.
    m.appendChild(el('div', { class: 'footer' }, [
      el('button', { class: 'primary', onclick: close }, 'Close'),
    ]));
  });
}


// H-047 (_5 audit): ONE shared predicate for "does this item match the
// active search + type filters". applyFileSearch (rendered-row
// visibility) and fbSelectAll (selection eligibility) both consume it,
// so a row hidden by the text search or the type dropdown can never
// silently enter the bulk selection and get deleted / moved.
function currentFbFilterState() {
  const query = ($('#fb-search')?.value || '').toLowerCase();
  // The dropdown value is a comma-separated list of extensions (no
  // dot, lower case); empty string = "All types" (no type filtering).
  const raw = ($('#fb-type-filter')?.value || '').trim();
  const typeSet = raw
    ? new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
    : null;
  return { query, typeSet };
}
function matchesFileBrowserFilters(it, filterState) {
  if (!it) return false;
  const fState = filterState || { query: '', typeSet: null };
  // Asset-type filter: hide files whose extension isn't in the
  // selected set. Directories always pass (their "type" is "folder",
  // shown via the icon column); extensionless files pass too — the
  // historical row logic only hid rows with a non-matching extension.
  if (fState.typeSet && !it.isDir) {
    // Extensions carry a leading dot on items and rows (".png"), but
    // the dropdown's type set holds bare extensions ("png"). Strip
    // the dot before comparing.
    const ext = String(it.ext || '').toLowerCase().replace(/^\./, '');
    if (ext && !fState.typeSet.has(ext)) return false;
  }
  // Free-text filter: empty query matches everything that survived
  // the type filter. Applies to directories too (same as the rows).
  if (fState.query) {
    const name = String(it.name || '').toLowerCase();
    if (!name.includes(fState.query)) return false;
  }
  return true;
}

function applyFileSearch() {
  const fState = currentFbFilterState();
  for (const item of $$('.fb-item')) {
    // The ".." parent row has no .name / .ext attribute; always
    // show it regardless of the filter (it's navigation, not a
    // real item).
    if (!item.dataset.name) { item.style.display = ''; continue; }
    const rowItem = {
      name: item.dataset.name || item.querySelector('.name')?.textContent || '',
      ext: item.dataset.ext || '',
      isDir: item.dataset.isdir === '1',
    };
    item.style.display = matchesFileBrowserFilters(rowItem, fState) ? '' : 'none';
  }
}
// Expose the key functions on window after all declarations. Function
// declarations are hoisted, so applyFileSearch and refreshBrowser are
// on window even if a later line in this file throws.
window.applyFileSearch = applyFileSearch;
window.refreshBrowser = refreshBrowser;
window.isItemVisibleInList = isItemVisibleInList;
window.isSupportedAssetFile = isSupportedAssetFile;
window.SUPPORTED_FILE_EXTS = SUPPORTED_FILE_EXTS;
window.matchesFileBrowserFilters = matchesFileBrowserFilters; // H-047
window.currentFbFilterState = currentFbFilterState; // H-047
// Bare-name aliases (in addition to window.X) so every lookup path
// works.
var applyFileSearch = window.applyFileSearch;
var refreshBrowser = window.refreshBrowser;

// Multi-select via the leftmost checkbox column. state.fbSelected is
// a Set of fs-item paths. The Set lives on window.state so the bulk-
// action toolbar (added in app.js) can read it. The add/remove logic
// is centralised here so the checkbox click and the bulk-action
// "select all" / "clear" buttons stay in sync.
function _toggleFbSelected(path, checked) {
  if (!path) return;
  if (!state.fbSelected || typeof state.fbSelected.has !== 'function') state.fbSelected = new Set();
  if (checked) state.fbSelected.add(path);
  else state.fbSelected.delete(path);
  // Re-render the bulk-action toolbar so the count + buttons
  // reflect the new selection. The toolbar is a sibling of
  // the fb-list, NOT inside it, so a refresh of the fb-list
  // wouldn't auto-update it. We dispatch a custom event the
  // app.js toolbar listens for.
  try {
    window.dispatchEvent(new CustomEvent('fb-selection-changed', { detail: { size: state.fbSelected.size } }));
  } catch (_) { /* no-op in tests */ }
}
// "Select all" / "clear" helpers. Used by the bulk-action
// toolbar's master checkbox + the keyboard shortcut Ctrl+A.
function fbSelectAll() {
  if (!Array.isArray(state._fbItems) || !state._fbItems.length) return;
  if (!state.fbSelected) state.fbSelected = new Set();
  // Only select items that are actually visible RIGHT NOW: the
  // supported-types gate (isItemVisibleInList) AND the live text
  // search + type filter (matchesFileBrowserFilters — the same
  // predicate applyFileSearch gates the rendered rows on). H-047:
  // previously only the first gate applied, so files hidden by the
  // search box or the type dropdown silently entered the bulk
  // selection and could be deleted or moved.
  const fState = currentFbFilterState();
  const visibleItems = state._fbItems.filter((it) => isItemVisibleInList(it) && matchesFileBrowserFilters(it, fState));
  for (const it of visibleItems) state.fbSelected.add(it.path);
  // Re-render the list (so the checkboxes flip to checked) AND
  // the toolbar (so the count + master checkbox update).
  const sorted = sortFbItems(state._fbItems, state.fbSort);
  renderFbList(sorted);
  applyFileSearch();
  try { window.dispatchEvent(new CustomEvent('fb-selection-changed', { detail: { size: state.fbSelected.size } })); } catch (_) {}
}
function fbClearSelection() {
  if (!state.fbSelected || state.fbSelected.size === 0) return;
  state.fbSelected = new Set();
  const sorted = Array.isArray(state._fbItems) ? sortFbItems(state._fbItems, state.fbSort) : [];
  renderFbList(sorted);
  applyFileSearch();
  try { window.dispatchEvent(new CustomEvent('fb-selection-changed', { detail: { size: 0 } })); } catch (_) {}
}
// Bulk-action worker. Iterates the selected paths and calls
// `op(path, i, total)`. The op runs sequentially because some
// ops (rename, delete) can race if fired in parallel via IPC.
// On each success we remove the path from fbSelected + update
// the toolbar; on failure we surface the error and KEEP the
// path in fbSelected so the user can retry. We re-render the
// list at the end so the deleted / moved rows disappear.
async function fbBulkAction(label, op) {
  const paths = state.fbSelected ? Array.from(state.fbSelected) : [];
  if (!paths.length) { toast('Select at least one item first.', 'warn'); return; }
  if (!await asyncConfirm(`${label} ${paths.length} item${paths.length === 1 ? '' : 's'}?`)) return;
  let ok = 0, fail = 0;
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    try {
      await op(p, i, paths.length);
      if (state.fbSelected) state.fbSelected.delete(p);
      ok++;
    } catch (e) {
      fail++;
      console.error('fbBulkAction failed for', p, e);
    }
  }
  if (fail) toast(`${label}: ${ok} ok, ${fail} failed (kept in selection).`, 'warn', 6000);
  else toast(`${label}: ${ok} item${ok === 1 ? '' : 's'} ok.`, 'ok', 2000);
  // Re-render so deleted / moved rows disappear + checkboxes
  // for succeeded paths flip off. Bulk move/delete also needs
  // the folder contents to refresh, so we re-fetch.
  await refreshBrowser();
  try { window.dispatchEvent(new CustomEvent('fb-selection-changed', { detail: { size: state.fbSelected ? state.fbSelected.size : 0 } })); } catch (_) {}
}
window.fbSelectAll = fbSelectAll;
window.fbClearSelection = fbClearSelection;
window.fbBulkAction = fbBulkAction;

// Batch counterpart to the folder-explorer right-click pipeline actions
// (Upscale / Crop / Convert / Optimize / Remove background), which act
// on the multi-select checkboxes rather than just the right-clicked
// image. The action's dialog collects its settings ONCE, then this
// applies the per-file operation to EVERY given target sequentially
// (IPC pipeline ops can corrupt each other's temp state if fired in
// parallel), with a live status line + a single summary toast. It is
// deliberately separate from fbBulkAction: (a) it takes an EXPLICIT
// `targets` list (the image subset of the selection — fbBulkAction
// iterates the whole fbSelected, which may include folders / audio),
// and (b) it does NOT confirm() again — the pipeline dialog the user
// just clicked through is the confirmation. `perFileFn(path, i, total)`
// runs the underlying per-file worker (upscaleImageFile /
// convertImageFile / …) and must throw on failure. Succeeded paths are
// unchecked; failed ones stay selected so the user can retry. Returns
// { ok, fail }.
async function runImagePipelineBatch(label, targets, perFileFn) {
  const paths = Array.isArray(targets) ? targets.filter(Boolean) : [];
  if (!paths.length) return { ok: 0, fail: 0 };
  const total = paths.length;
  let ok = 0, fail = 0;
  const errors = [];
  for (let i = 0; i < total; i++) {
    const p = paths[i];
    try {
      if (typeof setStatus === 'function') setStatus(`${label} ${i + 1}/${total}…`, true);
      await perFileFn(p, i, total);
      if (state.fbSelected) state.fbSelected.delete(p);
      ok++;
    } catch (e) {
      fail++;
      errors.push((p.split(/[\\/]/).pop() || p) + ': ' + (e && e.message || e));
      console.error(`${label} failed for`, p, e);
    }
  }
  if (typeof setStatus === 'function') setStatus(`${label}: ${ok} ok${fail ? `, ${fail} failed` : ''}.`, false);
  const detail = fail ? ` (kept in selection: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''})` : '';
  toast(`${label}: ${ok} ok${fail ? `, ${fail} failed` : ''}${detail}`, fail ? 'warn' : 'ok', fail ? 7000 : 3500);
  try { await refreshBrowser(); } catch (_) { /* best-effort */ }
  try { window.dispatchEvent(new CustomEvent('fb-selection-changed', { detail: { size: state.fbSelected ? state.fbSelected.size : 0 } })); } catch (_) { /* no-op in tests */ }
  return { ok, fail };
}
window.runImagePipelineBatch = runImagePipelineBatch;

// Drives-list rendering. The Up button jumps to this view when the
// user is already at a drive root. Each row is a clickable drive
// (e.g. C:\, D:\, E:\ on Windows or / on POSIX). Clicking a drive
// sets state.fbDir to the drive path and refreshes — the user lands
// at the drive's root. Double-clicking does the same (a single click
// on a drive is enough, but double-click is honoured too because it's
// the file-browser muscle memory for "navigate in").
function renderFbDrivesList(drives) {
  const ul = $('#fb-list');
  if (!ul) return;
  ul.innerHTML = '';
  ul.classList.remove('fb-thumbs-on');
  ul.classList.add('fb-thumbs-off');
  // Set a sensible column template for the drives list
  // (icon + name only — drives don't have size / type / mtime).
  ul.style.gridTemplateColumns = '44px minmax(120px, 1fr)';
  if (!drives || drives.length === 0) {
    const empty = el('li', { class: 'fb-empty' });
    empty.appendChild(el('div', { class: 'fb-empty-title' }, 'No drives found'));
    empty.appendChild(el('div', { class: 'fb-empty-hint' },
      'Your system does not expose any drives. Use 📂 to pick a folder.'));
    ul.appendChild(empty);
    return;
  }
  for (const drv of drives) {
    // Drive rows: emoji icon (💽 for the hard-disk glyph) + a label
    // like "C:" + the full path as the title tooltip. The renderer is
    // a browser context (contextIsolation:true, nodeIntegration:false),
    // so `process` does NOT exist there. Detect the platform by the
    // drive's NAME shape: a Windows drive name is `C:\` (or `D:/`,
    // `C:`), a POSIX root is `/`. This mirrors isDriveRoot() in
    // app.js — shape-based, no `process` reference.
    const drvName = String((drv && drv.name) || '');
    const isWinDrive = /^[A-Za-z]:[\\\/]?$/.test(drvName);
    const driveIcon = isWinDrive ? '💽' : '🖴';
    const li = el('li', {
      class: 'fb-item fb-drive-row',
      'data-path': drv.name,
      'data-isdir': '1',
      'data-name': drv.label,
      'data-ext': '',
      draggable: 'false',
      style: 'grid-template-columns: 44px minmax(120px, 1fr);',
      title: drv.name,
    }, [
      el('span', { class: 'icon fb-icon' }, driveIcon),
      el('span', { class: 'name' }, drv.label + '  —  ' + drv.name),
    ]);
    const navigate = () => {
      // Set fbDir to the drive root and re-enable the Up
      // button. The next refreshBrowser() call lists the
      // drive's contents.
      state.fbDir = drv.name;
      // Mirror the drive into the per-tab saved slot so
      // switching tabs and coming back keeps the user
      // where they were.
      if (state.currentTab) state.fbDirs[state.currentTab] = drv.name;
      scheduleStateSave();
      // Re-enable the Up button (it was disabled at the
      // drives list).
      const upBtn = $('#fb-up');
      if (upBtn) { upBtn.disabled = false; upBtn.classList.remove('fb-up-disabled'); upBtn.title = 'Up one level'; }
      refreshBrowser();
    };
    li.addEventListener('click', navigate);
    li.addEventListener('dblclick', navigate);
    ul.appendChild(li);
  }
}
window.renderFbDrivesList = renderFbDrivesList;

const { attachDropTarget: _attachDropTarget } = window.DropTarget;

function renderFbList(items) {
  const ul = $('#fb-list');
  if (ul && !ul._hasContainerCtxMenu) {
    ul._hasContainerCtxMenu = true;
    ul.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.fb-item')) {
        e.preventDefault();
        if (typeof window.showContainerContextMenu === 'function') {
          window.showContainerContextMenu(e.clientX, e.clientY);
        }
      }
    });
  }
  ul.innerHTML = '';
  // Empty-state hint. Rendering an empty <ul> with no message makes a
  // new or empty folder look like a broken page. The hint tells the
  // user what to do next (pick a folder, or generate an image) and
  // dismisses itself as soon as a file appears. Rendered inside the
  // <ul> so the layout flexes correctly with the splitter resizes.
  if (!items || items.length === 0) {
    const empty = el('li', { class: 'fb-empty' });
    const isOutput = state.fbDir && state.config.output_dir
      && state.fbDir.toLowerCase() === state.config.output_dir.toLowerCase();
    empty.appendChild(el('div', { class: 'fb-empty-title' }, isOutput ? 'This folder is empty' : 'No items'));
    empty.appendChild(el('div', { class: 'fb-empty-hint' },
      isOutput
        ? 'Click Generate on a tab above to create your first asset.'
        : 'Click 📂 to pick a folder, or ↑ to go up.'));
    ul.appendChild(empty);
    return;
  }
  // Apply the user's selected columns by setting a CSS
  // grid-template-columns on the <ul>. The column definitions in
  // FB_COLUMNS (see above) drive the template string. The
  // <ul> uses `min-width: max-content` so the grid expands
  // beyond the available width when necessary — the
  // overflow-x: auto on the list then kicks in to provide a
  // horizontal scroll bar (see styles.css). The "name" column
  // uses minmax(120px, 1fr) so the file name always gets at
  // least 120px, and the path column (when enabled) takes the
  // remaining 1fr.
  ul.style.gridTemplateColumns = buildFbGridTemplate();
  // Tag the <ul> so CSS knows which alignment to apply: thumbs
  // get a taller row + centered image; plain icons are
  // left-aligned (the user explicitly asked for left-alignment
  // when thumbnails are off). The class is also useful for the
  // zebra-striping rule which uses :nth-child(even) and would
  // otherwise re-paint the wrong row in the wider thumbnail
  // variant.
  ul.classList.toggle('fb-thumbs-on', !!state.fbThumbnails);
  ul.classList.toggle('fb-thumbs-off', !state.fbThumbnails);
  // Snapshot the rendered items on state so other helpers (e.g.
  // markFbItemActive when the user is shown a preview/overlay for a
  // path) can look up the full fs-item record (size, ext, mtime)
  // without re-fetching from the main process. This was previously
  // only available via DOM lookups, which limited context-menu code
  // to operations that only needed the path.
  state._fbItems = Array.isArray(items) ? items.slice() : [];
  // Show ".. (up)" whenever we're inside a real subdir of the output root.
  const outRoot = state.config.output_dir || '';
  if (state.fbDir && outRoot && state.fbDir.toLowerCase() !== outRoot.toLowerCase()) {
    const parent = el('li', {
      class: 'fb-item',
      // Same grid-template-columns as the regular rows below so the
      // .. (up) row's icon + name cells line up with the rest. Pass
      // withCheckbox=false so the ".." row skips the leftmost select
      // column (a checkbox on the up row would be confusing — the row
      // isn't a real item to operate on).
      style: 'grid-template-columns: ' + buildFbGridTemplate(false) + ';',
    }, [
      el('span', { class: 'icon fb-icon' }, '↩'),
      el('span', { class: 'name' }, '.. (up)'),
      // .. gets a "size" column so the row stays aligned with
      // the regular rows below it; the other columns (if any)
      // are not rendered for the parent row to keep the visual
      // noise down.
      el('span', { class: 'size' }, '—'),
    ]);
    parent.addEventListener('click', () => {
      // Go up one level. Use the shared parentDir() helper — it preserves
      // UNC roots (\\server\share) and POSIX absolute paths, which the
      // naive split/pop/join would strip (turning \\server\share\x into
      // server\share\x and breaking the browse).
      state.fbDir = parentDir(state.fbDir) || outRoot;
      refreshBrowser();
    });
    // Drop a file on ".." to move it into the parent dir.
    const _parentDir = parentDir(state.fbDir) || outRoot;
    _attachDropTarget(parent, _parentDir);
    ul.appendChild(parent);
  } else if (state.fbDir && outRoot && state.fbDir.toLowerCase() === outRoot.toLowerCase()) {
    // At the output root, but allow one "Open in Explorer" hint as a no-op row? Skip.
  }
  // Sanitise the column flags once per render so the inner loop
  // can read the booleans without re-checking the object shape.
  const fbCols = normalizeFbColumns(state.fbColumns);
  for (const it of items) {
    // Build the row's children. Icon + name are mandatory; the
    // rest of the cells come from FB_COLUMNS, in order, with a
    // CSS class matching the column id (so user styles can
    // target e.g. ".fb-item .col-size" without false-positives
    // on incidental matches).
    const cellEls = [
      _buildFbIconCell(it),
      el('span', { class: 'name', title: it.name }, it.name),
    ];
    for (const c of FB_COLUMNS) {
      if (!fbCols[c.id]) continue;
      const [text, title] = c.render(it);
      const cls = `col-${c.id}`;
      cellEls.push(el('span', { class: cls, title: title || '' }, text));
    }
    // Leftmost checkbox for multi-select. Directories can also be
    // selected (a bulk move of a folder tree is a valid use case). The
    // checkbox is the FIRST cell in the row. The click handler is bound
    // to the checkbox only (stopPropagation), so a click on the
    // checkbox doesn't also trigger the row's normal click handler
    // (which would change state._selected and load a preview). The grid
    // template has 1 extra column for the checkbox (see
    // buildFbGridTemplate above).
    const cb = el('input', { type: 'checkbox', class: 'fb-select-cb' });
    if (state.fbSelected && state.fbSelected.has(it.path)) cb.checked = true;
    cb.addEventListener('click', (ev) => { ev.stopPropagation(); _toggleFbSelected(it.path, cb.checked); });
    cb.addEventListener('change', () => { _toggleFbSelected(it.path, cb.checked); });
    const cbCell = el('div', { class: 'fb-cb-cell' }, cb);
    cellEls.unshift(cbCell);
    const li = el('li', {
      class: 'fb-item',
      'data-path': it.path,
      'data-isdir': it.isDir ? '1' : '0',
      // Persist the lowercase extension on the row so the asset-type
      // filter (#fb-type-filter) can read it without re-parsing the
      // filename each time. Empty string for folders (their "type" is
      // "folder", always passes the filter).
      'data-ext': (it.ext || '').toLowerCase(),
      'data-name': it.name,
      draggable: it.isDir ? 'false' : 'true',
      // CSS grid does NOT inherit grid-template-columns from the
      // parent (the .fb-list ul). Without this explicit copy, the
      // row's children (icon / name / col-size / ...) are auto-placed
      // inside the .fb-item, ignoring the parent's column widths.
      // Result: the name column collapsed to its text width, the
      // row read as a thick grey bar instead of an active line of
      // content, and clicks on the right side of the row landed on
      // dead space. Re-applying the template here makes every cell
      // line up with the parent grid and the row reads as one
      // continuous strip of clickable content.
      style: 'grid-template-columns: ' + buildFbGridTemplate() + ';',
    }, cellEls);
    li.addEventListener('click', (e) => {
      $$('.fb-item', ul).forEach((n) => n.classList.remove('selected'));
      li.classList.add('selected');
      state._selected = it;
      // Single-click on an asset: push it into the bottom-right
      // Assets preview pane so the user gets immediate feedback.
      if (!it.isDir) previewItem(it);
    });
    li.addEventListener('dblclick', () => openItem(it));
    // Drag-and-drop: dragging a file over a folder moves it there. We do NOT
    // expose the actual native file path (Electron doesn't allow it), so the
    // drag is internal to the app. We use a custom MIME type so external
    // drops are ignored.
    if (!it.isDir) {
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-minimax-fb', it.path);
        e.dataTransfer.effectAllowed = 'move';
      });
    }
    // Folders accept drops: dropping a file onto a folder moves it inside.
    if (it.isDir) {
      _attachDropTarget(li, it.path);
    }
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      $$('.fb-item', ul).forEach((n) => n.classList.remove('selected'));
      li.classList.add('selected');
      state._selected = it;
      // allowBatch: this is the folder-explorer entry point, where the
      // multi-select checkboxes live. When several images are checked
      // and one of them is right-clicked, the pipeline actions apply to
      // the whole checked set (see showItemContextMenu → batchTargets).
      showItemContextMenu(it, e.clientX, e.clientY, { allowBatch: true });
    });
    ul.appendChild(li);
  }
}



async function openItem(it) {
  // Defensive: items from the FS list always have {path, ext, isDir}, but
  // a future caller might pass a partial object. Bail out cleanly instead
  // of dereferencing undefined and getting a confusing stack trace.
  if (!it || !it.path) { toast('Invalid file item.', 'err'); return; }
  if (it.isDir) {
    state.fbDir = it.path;
    await refreshBrowser();
  } else {
    const ext = String(it.ext || '').toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext) && window.ImageOverlays && typeof window.ImageOverlays.showImageViewer === 'function') {
      window.ImageOverlays.showImageViewer(it.path);
      return;
    }
    if (previewItem(it)) {
      return;
    } else {
      const _rg = (window.GrantHelper) ? await window.GrantHelper.ensureRead(it.path) : undefined;
      await window.api.fbReveal(it.path, _rg);
    }
  }
}

function previewItem(it) {
  const ext = String(it.ext || '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
    if (typeof previewImageFromFile === 'function') previewImageFromFile(it.path);
  } else if (['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.opus', '.pcm'].includes(ext)) {
    if (typeof previewAudioFromFile === 'function') previewAudioFromFile(it.path);
  } else if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) {
    // Preview pane also handles video files. Click on a .mp4 etc. in
    // the file browser → preview pane shows the video with native
    // controls. Same UX as images (click thumbnail → opens a larger
    // overlay) but with an HTML5 <video> instead of an <img>.
    if (typeof previewVideoFromFile === 'function') previewVideoFromFile(it.path);
  } else if (['.txt', '.srt', '.json', '.md', '.lrc'].includes(ext)) {
    if (typeof previewTextFromFile === 'function') previewTextFromFile(it.path);
  } else {
    if (typeof clearPreview === 'function') clearPreview();
    return false;
  }
  return true;
}

// Mark the file-browser row that corresponds to `path` as the
// currently-active item (the same `.selected` class that the click
// handler in renderFbList applies when the user clicks the row).
// Also scrolls the row into view if it's currently off-screen.
//
// The user's spec is: "the file clicked and shown last in the image
// preview element (and its full image viewer) should always be marked
// as active in the folder explorer". This helper is the single place
// that enforces that. Every preview path / overlay open should call
// it with the path the user is currently looking at, so the row in
// the file browser never lags behind the preview pane.
//
// `path` is matched case-insensitively (Windows paths are
// case-insensitive in practice) and against the `data-path` attribute
// set by renderFbList. We deliberately ignore the `..` (up) row
// because it has no data-path.
