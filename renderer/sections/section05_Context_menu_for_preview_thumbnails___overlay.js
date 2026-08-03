// renderer/sections/section05_Context_menu_for_preview_thumbnails___overlay.js
// Extracted: Context menu for preview thumbnails + overlay

// ----------------- Context menu for preview thumbnails + overlay -----------------
// Right-click context menu for image thumbnails in the picture
// preview pane and for the full-size image overlay. Mirrors the
// folder-browser context menu (showItemContextMenu) — the same
// Upscale / Crop / Convert / Optimize / Remove-background pipeline
// entries are available, plus the file-level Copy / Cut / Rename /
// Move / Delete actions. The same context menu is reused for both
// entry points so behaviour stays consistent.
//
// The helpers accept either:
//   - a full fs-item record (as returned by the main process and
//     cached in state._fbItems), or
//   - just a path string (for the preview pane / overlay where the
//     caller doesn't have the full record). When only a path is
//     given we synthesise a minimal item on the fly so the same
//     action handlers can be reused.
function buildItemFromPath(path) {
  if (!path || typeof path !== 'string') return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts.length ? parts[parts.length - 1] : path;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  return {
    path,
    name,
    ext,
    isDir: false,
    size: 0,
    mtimeMs: 0,
    birthtimeMs: 0,
    _synthesised: true,
  };
}
function showItemContextMenuForPath(path, x, y) {
  let it = (state._fbItems || []).find((it) => it.path === path);
  if (!it) it = buildItemFromPath(path);
  if (!it) return;
  showItemContextMenu(it, x, y);
}

// Standalone "Remove background" action triggered by the folder
// browser's right-click context menu. Unlike the in-tab flow
// (which is gated on the upscaling popup's checkbox) and the
// right-click "Upscale" dialog (which can chain upscale →
// crop → background removal in one step), this is a single-shot

// formatDate is defined as formatLocalShort() in FormatUtils.js;
// aliased here for readability.
const { formatLocalShort: formatDate } = window.FormatUtils;

function promptRename(it) {
  showModal((m, close) => {
    m.appendChild(el('h2', {}, 'Rename'));
    const inp = el('input', { type: 'text', value: it.name });
    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'New name'), inp]));
    const ok = el('button', { class: 'primary' }, 'Rename');
    const cancel = el('button', { onclick: close }, 'Cancel');
    ok.addEventListener('click', async () => {
      const newName = inp.value.trim();
      if (!newName) { toast('Name is required.', 'warn'); return; }
      if (newName === it.name) { close(); return; }
      // BGR-009 fix: mint rename grant (R1.3 gate).
      const renameGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRename(it.path) : undefined;
      // B-007 (hhhhu3 audit): rename needs a one-shot intent token minted
      // by the native confirmation (window.FbIntent).
      const r = await window.FbIntent.rename(it.path, newName, renameGrant);
      if (window.FbIntent.isCanceled(r)) return; // user declined the native confirmation
      if (!r.ok) { toast('Rename failed: ' + r.error, 'err'); return; }
      toast('Renamed.', 'ok');
      await refreshBrowser();
      close();
    });
    m.appendChild(el('div', { class: 'footer' }, [cancel, ok]));
  });
}

async function promptMove(it) {
  const dest = await window.api.pickFolder();
  if (!dest) return;
  // BGR-009 fix: mint move grant (R1.3 gate).
  // gewv2 GEW-002 fix: ensureMove returns { ok, srcGrant, destGrant }.
  const mv = (window.GrantHelper) ? await window.GrantHelper.ensureMove(it.path, dest) : undefined;
  // B-007 (hhhhu3 audit): move needs a one-shot intent token minted by
  // the native confirmation (window.FbIntent).
  const r = await window.FbIntent.move(it.path, dest, mv && mv.srcGrant, mv && mv.destGrant);
  if (window.FbIntent.isCanceled(r)) return; // user declined the native confirmation
  if (!r.ok) toast(r.error, 'err'); else {
    toast('Moved.', 'ok');
    // Same as confirmDelete: if the moved file was being previewed,
    // the preview pane now has a broken file:// URL. Clear it.
    if (!it.isDir && state._selected && state._selected.path === it.path) {
      previewImageFromFile(null);
    }
    await refreshBrowser();
  }
}

async function confirmDelete(it) {
  showModal((m, close) => {
    m.appendChild(el('h2', {}, 'Delete ' + (it.isDir ? 'folder' : 'file') + '?'));
    m.appendChild(el('p', {}, it.path));
    if (it.isDir) m.appendChild(el('p', { style: 'color: var(--danger);' }, 'This will recursively delete the folder and all its contents.'));
    const ok = el('button', { class: 'danger' }, 'Delete');
    const cancel = el('button', { onclick: close }, 'Cancel');
    ok.addEventListener('click', async () => {
      // BGR-009 fix: mint delete grant (R1.3 gate).
      const deleteGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(it.path) : undefined;
      // B-007 (hhhhu3 audit): delete needs a one-shot intent token minted
      // by the native confirmation (window.FbIntent).
      const r = await window.FbIntent.del(it.path, deleteGrant);
      if (window.FbIntent.isCanceled(r)) return; // user declined the native confirmation
      if (!r.ok) toast(r.error, 'err'); else { toast('Deleted.', 'ok'); await refreshBrowser(); }
      // If the deleted file was the one being previewed, clear the
      // preview pane — otherwise it holds a broken <img> with an
      // invalid file:// URL, which Chromium logs as a console error
      // every time the user opens a different file.
      if (!it.isDir && state._selected && state._selected.path === it.path) {
        previewImageFromFile(null);
      }
      close();
    });
    m.appendChild(el('div', { class: 'footer' }, [cancel, ok]));
  });
}

async function promptNewFolder() {
  const dir = state.fbDir || state.config.output_dir || '';
  if (!dir) { toast('No output directory set. Configure in Settings.', 'warn'); return; }
  showModal((m, close) => {
    m.appendChild(el('h2', {}, 'New folder'));
    const inp = el('input', { type: 'text', value: 'New folder' });
    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Folder name'), inp]));
    m.appendChild(el('div', { class: 'footer' }, [
      el('button', { onclick: close }, 'Cancel'),
      el('button', { class: 'primary', onclick: async () => {
        const name = inp.value.trim();
        if (!name) { toast('Folder name is required.', 'warn'); return; }
        // BGR-009 fix: mint mkdir grant (R1.3 gate).
        const mkdirGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDir(dir) : undefined;
        const r = await window.api.fbMkdir(dir, name, mkdirGrant);
        if (!r.ok) { toast('Create failed: ' + r.error, 'err'); return; }
        toast('Created.', 'ok');
        await refreshBrowser();
        close();
      } }, 'Create'),
    ]));
  });
}
// _quotaSeg() + _formatQuotaModel() live in
// renderer/utils/quotaFormatter.js. Pure formatting logic, no
// app coupling (only escapeHtml via window).
const { quotaSeg: _quotaSeg, formatQuotaModel: _formatQuotaModel, formatQuotaSummary: _formatQuotaSummary } = window.QuotaFormatter;
async function refreshQuota() {
  if (typeof window.logAction === 'function') window.logAction('quota', 'refresh-start');
  const el2 = $('#quota-value');
  el2.innerHTML = '<span class="spinner"></span>';
  const r = await window.api.quota();
  if (!r.ok) { el2.textContent = r.error || '—'; return; }
  // The mmx CLI has returned the quota in a few different shapes depending
  // on the version. Try the documented one first (`model_remains` at root
  // or under `data`), then fall back to other common shapes.
  const data = r.parsed;
  let models = null;
  if (data) {
    if (Array.isArray(data.model_remains)) models = data.model_remains;
    else if (Array.isArray(data.models)) models = data.models;
    else if (Array.isArray(data.data && data.data.model_remains)) models = data.data.model_remains;
    else if (Array.isArray(data.quota)) models = data.quota;
  }
  if (!models || !models.length) {
    // No recognizable models — log the raw response so the user can see
    // exactly what the API is returning (helps diagnose shape changes
    // between mmx-cli versions). Truncate to keep the log readable.
    try {
      const raw = JSON.stringify(data).slice(0, 4000);
      log(`[quota] unexpected response shape — raw: ${raw}${raw.length >= 4000 ? '…' : ''}`);
    } catch (_) { /* ignore circular refs etc. */ }
    el2.textContent = 'no data';
    return;
  }
  const parts = models.map(_formatQuotaModel);
  // Issue-5: prefer the compact one-line summary (used-percentages +
  // video counts, per-model breakdown in the tooltip). It returns null
  // only when no model reports usable counts — then fall back to the
  // legacy per-model lines so the user still sees the percent-based
  // fallback rendering.
  const summary = _formatQuotaSummary(models);
  el2.innerHTML = summary || parts.join(' · ');
}

