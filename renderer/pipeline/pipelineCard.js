// renderer/pipeline/pipelineCard.js
// Builds one card's DOM (thumbnail + meta + settings + action row) and wires
// its actions (Back / Skip / Run / Finalize / Replace / Open-in / Delete).
//
// Each action mutates state.pipeline.image, persists via scheduleStateSave, and
// asks PipelineBoard to repaint the affected card/column. Operations themselves
// (upscale/removebg/crop/optimize) are delegated to pipelineOps.js so this file
// only owns the card UI + the workflow transitions.

(function () {
  const M = () => window.PipelineModel || null;
  // Lazily require the model constants via a global the bridge sets up. The
  // renderer can't require('src/...'), so pipelineModelBridge.js (loaded first)
  // copies the pure constants onto window.PipelineModel.

  function build(item, column) {
    const board = window.state.pipeline.image;
    const isFinal = column === 'final';
    const isOriginal = column === 'original';
    const isActive = ['upscale', 'removebg', 'crop', 'resize', 'optimize'].includes(column);
    const file = item.files[column];

    const card = el('div', {
      class: 'pipeline-card' +
        (item.status === 'running' ? ' running' : '') +
        (item.status === 'error' ? ' errored' : '') +
        (item.status === 'missing' ? ' missing' : ''),
      'data-card-id': item.id,
    });

    // ---- Thumbnail ----
    const thumb = el('div', { class: 'pipeline-card-thumb' });
    if (file) {
      const img = el('img', { loading: 'lazy', alt: item.name || '' });
      // Use the cached thumbnail if available; generate lazily.
      loadThumb(file, img);
      img.addEventListener('click', () => {
        const colFiles = board.items.filter((i) => i.column === column).map((i) => i.files[column]).filter(Boolean);
        window.Pipeline.openImage(file, colFiles);
      });
      // QA-016: keyboard accessibility for pipeline thumbnails.
      if (window.TinyUtils && window.TinyUtils.makeFocusable) {
        window.TinyUtils.makeFocusable(img, () => { img.click(); });
      }
      thumb.appendChild(img);
    } else {
      thumb.appendChild(el('div', { class: 'pipeline-card-nothumb' }, '—'));
    }

    // H10-1: "reuse last crop" label (crop column only, after the first crop
    // this session). Built by the dedicated helper so this file stays within
    // its frozen size budget.
    const lastCropEl = (window.PipelineCardLastCrop && window.PipelineCardLastCrop.buildLastCropLabel)
      ? window.PipelineCardLastCrop.buildLastCropLabel(item, column)
      : null;

    // ---- Meta ----
    const name = el('div', { class: 'pipeline-card-name', title: 'Click to rename' }, item.name || 'image');
    name.style.cursor = 'pointer';
    name.style.textDecoration = 'underline';
    name.style.textDecorationStyle = 'dotted';
    name.addEventListener('click', () => {
      if (typeof showModal === 'function') {
        showModal((m, close) => {
          m.appendChild(el('h3', { style: 'margin-bottom: 8px;' }, 'Rename Item'));
          m.appendChild(el('p', { class: 'meta' }, 'Changing the name will affect future output files for this item.'));
          const inp = el('input', { type: 'text', value: item.name || 'image', style: 'width: 100%; margin: 12px 0;' });
          const saveBtn = el('button', { class: 'primary' }, 'Save');
          const cancelBtn = el('button', { onclick: close }, 'Cancel');
          saveBtn.addEventListener('click', () => {
            const val = inp.value.trim();
            if (val) {
              const safe = (M() && M().safeBaseName) ? M().safeBaseName(val, item.name || 'image') : val;
              item.name = safe;
              if (typeof window.scheduleStateSave === 'function') window.scheduleStateSave();
              if (typeof window.PipelineBoard !== 'undefined' && window.PipelineBoard.render) window.PipelineBoard.render();
              else name.textContent = safe;
            }
            close();
          });
          inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
          m.appendChild(inp);
          m.appendChild(el('div', { class: 'footer' }, [cancelBtn, saveBtn]));
          setTimeout(() => inp.focus(), 10);
        }, { id: 'pipeline-rename-' + item.id });
      }
    });
    // QA-016: keyboard accessibility for pipeline card name (rename).
    if (window.TinyUtils && window.TinyUtils.makeFocusable) {
      window.TinyUtils.makeFocusable(name, () => { name.click(); });
    }
    let badge = '';
    if (item.status === 'running') badge = '⟳ working…';
    else if (item.status === 'error') badge = '⚠ ' + (item.error || 'error');
    else if (item.status === 'missing') badge = '✖ file missing';
    const meta = el('div', { class: 'pipeline-card-meta' }, [name, badge ? el('div', { class: 'pipeline-card-badge' }, badge) : null, (window.PipelineCardProgress && window.PipelineCardProgress.buildProgressBar) ? window.PipelineCardProgress.buildProgressBar(item) : null].filter(Boolean));

    // ---- Settings expander (active columns only) ----
    let settings = null;
    if (isActive) settings = buildSettings(item, column);

    // ---- Info panel (resolution + key info + warning line) ----
    // Delegated to pipelineCardExtras.js so this file stays under the lint cap.
    const info = (window.PipelineCardExtras && window.PipelineCardExtras.buildInfoPanel(item, column, file)) || null;

    // ---- Action row ----
    const actions = el('div', { class: 'pipeline-card-actions' });
    if (item.status === 'running') {
      // While running, only show a Cancel affordance (the op wrapper handles cancellation).
      actions.appendChild(btn('✖ Cancel', 'mini', () => { /* cancel is best-effort via the op */ PipelineOps.cancel(item.id); }));
    } else if (isFinal) {
      actions.appendChild(btn('⏪ Back', 'mini', () => moveBack(item)));
      actions.appendChild(btn('👁 Open', 'mini', () => openItem(item, column)));
      actions.appendChild(btn('📂 Reveal', 'mini', () => revealItem(item, column)));
      actions.appendChild(btn('↧ Export copy…', 'mini', () => exportCopy(item, column)));
      actions.appendChild(btn('💾 Save & Remove', 'mini', () => saveAndRemove(item, column)));
      actions.appendChild(btn('🗑 Remove', 'mini', () => removeItem(item)));
      actions.appendChild(btn('⧉ Duplicate', 'mini', () => duplicateItem(item)));
    } else {
      if (!isOriginal) actions.appendChild(btn('⏪ Back', 'mini', () => moveBack(item)));
      if (isActive) {
        actions.appendChild(btn('⏭ Skip', 'mini', () => skip(item)));
        actions.appendChild(btn('▶ Run', 'primary mini', () => runWithResizeCheck(item)));
      } else {
        // original column: advance to first active column
        actions.appendChild(btn('⏭ to Upscale', 'primary mini', () => advanceOriginal(item)));
      }
      actions.appendChild(btn('✓ Finalize', 'mini', () => finalize(item)));
      actions.appendChild(btn('↺ Replace…', 'mini', () => replaceFromDisc(item)));
      actions.appendChild(btn('🔧 Open in…', 'mini', () => openExternal(item, column)));
      actions.appendChild(btn('⧉ Duplicate', 'mini', () => duplicateItem(item)));
      actions.appendChild(btn('🗑 Delete', 'mini', () => removeItem(item)));
    }
    if (column === 'crop' && !isFinal && item.status !== 'running') {
      actions.appendChild(btn('🩹 Correct', 'mini', () => window.PipelineCardCorrect?.correctInEditor(item, column)));
    }
    // Assemble. Order: thumb, [last-crop], meta, [settings], [info], actions.
    const parts = [thumb];
    if (lastCropEl) parts.push(lastCropEl);
    parts.push(meta);
    if (settings) parts.push(settings);
    if (info) parts.push(info);
    parts.push(actions);
    card.append.apply(card, parts);
    return card;
  }

  // Small button helper.
  function btn(label, cls, onClick) {
    const b = el('button', { type: 'button', class: 'pipeline-btn-card ' + (cls || '') }, label);
    if (String(label).includes('Save & Remove')) b.classList.add('primary');
    b.addEventListener('click', onClick);
    return b;
  }

  // Load the thumbnail via the pipeline:thumb IPC, fall back to the raw file://.
  // Build a correct file:// URL via the canonical helper (fileUrl.js) — on
  // Windows `C:\x` must become `file:///C:/x` (three slashes), and the path
  // must be URI-encoded so spaces/#/? don't break the <img> src.
  function fileUrl(p) {
    if (window.FileUrl && typeof window.FileUrl.fileUrl === 'function') return window.FileUrl.fileUrl(p);
    return 'file:///' + String(p || '').replace(/\\/g, '/');
  }
  function loadThumb(file, imgEl) {
    const board = window.state.pipeline.image;
    window.api.pipelineThumb({ srcPath: file, workspaceId: board.workspaceId }).then((r) => {
      if (r && r.ok && r.thumbPath) {
        imgEl.src = fileUrl(r.thumbPath);
      } else {
        imgEl.src = fileUrl(file);
      }
    }).catch(() => { imgEl.src = fileUrl(file); });
  }

  // Per-column settings expander. Each active column exposes its relevant knobs.
  function buildSettings(item, column) {
    const board = window.state.pipeline.image;
    const resolved = PipelineModel.resolveSettings(column, item.settings);
    const details = el('details', { class: 'pipeline-card-settings' });
    if (item.settingsOpen && item.settingsOpen[column]) {
      details.setAttribute('open', '');
    }
    details.appendChild(el('summary', {}, '⚙ Settings'));
    details.addEventListener('toggle', () => {
      item.settingsOpen = item.settingsOpen || {};
      item.settingsOpen[column] = details.open;
      PipelineBoard.save();
    });
    const grid = el('div', { class: 'pipeline-card-settings-grid' });

    function numInput(label, val, opts) {
      const inp = el('input', Object.assign({ type: 'number', value: val }, opts || {}));
      inp.addEventListener('change', () => {
        item.settings[column] = item.settings[column] || {};
        const n = Number(inp.value);
        // Never persist NaN: it survives in-memory until the next save and
        // then reaches canvas sizing / native spawn arguments.
        item.settings[column][opts && opts._key] = Number.isFinite(n) ? n : val;
        inp.value = String(item.settings[column][opts && opts._key]);
        PipelineBoard.save();
      });
      grid.append(el('label', {}, [label, inp]));
      return inp;
    }
    function selInput(label, val, options, key) {
      const sel = el('select', {});
      for (const [v, lbl] of options) sel.appendChild(el('option', { value: v }, lbl));
      sel.value = val;
      sel.addEventListener('change', () => {
        item.settings[column] = item.settings[column] || {};
        item.settings[column][key] = sel.value;
        PipelineBoard.save();
      });
      grid.append(el('label', {}, [label, sel]));
      return sel;
    }

    if (column === 'upscale') {
      numInput('×', resolved.multiplier, { min: 1, max: 8, step: 1, _key: 'multiplier' });
      const models = (window.PipelineModel && window.PipelineModel.REALESRGAN_MODEL_DETAILS) || [];
      selInput('Model', resolved.model, models.map((m) => [m.value, m.label]), 'model');
      const cb = el('input', { type: 'checkbox' }); cb.checked = !!resolved.useCanvasFallback;
      cb.addEventListener('change', () => { item.settings.upscale = item.settings.upscale || {}; item.settings.upscale.useCanvasFallback = cb.checked; PipelineBoard.save(); });
      grid.append(el('label', {}, [el('span', {}, 'Canvas fallback'), cb]));
    } else if (column === 'removebg') {
      selInput('Model', resolved.model, [
        ['isnet-general-use', 'IS-Net (fast)'],
        ['birefnet-general-lite', 'BiRefNet Lite (clean)'],
        ['birefnet-general', 'BiRefNet (best)'],
        ['birefnet-portrait', 'BiRefNet Portrait'],
      ], 'model');
      const gpu = el('input', { type: 'checkbox' }); gpu.checked = resolved.useGpu !== false;
      gpu.addEventListener('change', () => { item.settings.removebg = item.settings.removebg || {}; item.settings.removebg.useGpu = gpu.checked; PipelineBoard.save(); });
      grid.append(el('label', {}, [el('span', {}, 'GPU'), gpu]));
      if (['birefnet-general', 'birefnet-portrait'].includes(resolved.model)) {
        grid.append(el('div', { class: 'pipeline-setting-full meta', style: 'font-size:11px; color:var(--warn, #f0b35a);' },
          'Large BiRefNet model: uses substantial VRAM. If GPU memory is exhausted, the operation retries on CPU.'));
      }
    } else if (column === 'crop') {
      numInput('W', resolved.w, { min: 0, step: 1, _key: 'w' });
      numInput('H', resolved.h, { min: 0, step: 1, _key: 'h' });
      selInput('X', resolved.anchorX, [['left', 'L'], ['center', 'C'], ['right', 'R']], 'anchorX');
      selInput('Y', resolved.anchorY, [['top', 'T'], ['center', 'C'], ['bottom', 'B']], 'anchorY');
      // The "Drag frame" button lives beside the ⚙ Settings toggle (see the
      // settings-row assembly below + pipelineCardDragFrame.js), not in here.
    } else if (column === 'resize') {
      // Free-target-resolution resize with a GIMP/Photoshop chain-link.
      // Source dims are cached on item._dims by the info panel (buildInfoPanel).
      const srcDims = () => item._dims || { w: 0, h: 0 };
      const set = item.settings.resize = item.settings.resize || {};
      const wInput = el('input', { type: 'number', min: '0', step: '1', value: set.width || '' });
      const hInput = el('input', { type: 'number', min: '0', step: '1', value: set.height || '' });
      wInput.style.width = hInput.style.width = '70px';
      const AL = window.AspectLink;
      // When linked, editing one axis recomputes the other from the source AR.
      const chain = AL.buildChainToggle(set.keepAspect !== false, (linked) => {
        set.keepAspect = linked;
        if (linked && (Number(wInput.value) > 0)) {
          const p = AL.linkedPair(srcDims(), 'w', Number(wInput.value));
          hInput.value = p.height || '';
        }
        PipelineBoard.save();
      });
      wInput.addEventListener('input', () => {
        set.width = Math.max(0, Math.floor(Number(wInput.value) || 0));
        if (chain.linked) { const p = AL.linkedPair(srcDims(), 'w', set.width); set.height = p.height; hInput.value = p.height || ''; }
        PipelineBoard.save();
      });
      hInput.addEventListener('input', () => {
        set.height = Math.max(0, Math.floor(Number(hInput.value) || 0));
        if (chain.linked) { const p = AL.linkedPair(srcDims(), 'h', set.height); set.width = p.width; wInput.value = p.width || ''; }
        PipelineBoard.save();
      });
      // W + chain + H on one row so it reads like "W 🔗 H".
      const dimsRow = el('div', { class: 'pipeline-resize-dims', style: 'display:flex; align-items:center; gap:4px;' },
        [el('span', {}, 'W'), wInput, chain, el('span', {}, 'H'), hInput]);
      grid.append(el('div', { class: 'pipeline-setting-full' }, [dimsRow]));
      // Sharpen-on-downscale toggle (engine applies it only when downscaling).
      const sh = el('input', { type: 'checkbox' }); sh.checked = set.sharpen !== false;
      sh.addEventListener('change', () => { set.sharpen = sh.checked; PipelineBoard.save(); });
      grid.append(el('label', {}, [el('span', {}, 'Sharpen (downscale)'), sh]));
      // Hint: 0 = no resize (the op no-ops like crop W=H=0).
      grid.append(el('div', { class: 'pipeline-setting-full meta', style: 'font-size:11px; color:var(--fg-3);' },
        'Set W×H (0 = skip resize). Link 🔗 keeps the source aspect ratio.'));
    } else if (column === 'optimize') {
      selInput('Format', resolved.format, [
        ['keep', 'keep'], ['jpeg', 'jpeg'], ['png', 'png'], ['webp', 'webp'], ['avif', 'avif'],
      ], 'format');
      const qInput = numInput('Quality', resolved.quality, { min: 1, max: 100, step: 1, _key: 'quality' });
      const presetRow = el('div', { class: 'pipeline-setting-full', style: 'margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px;' });
      for (const [q, lbl] of [[60, 'small (60)'], [75, 'balanced (75)'], [82, 'high (82)'], [95, 'lossless (95)']]) {
        const b = el('button', { class: 'btn-mini', type: 'button', style: 'padding: 1px 4px; font-size: 9px;' }, lbl);
        b.addEventListener('click', () => {
          qInput.value = String(q);
          item.settings.optimize = item.settings.optimize || {};
          item.settings.optimize.quality = q;
          PipelineBoard.save();
        });
        presetRow.appendChild(b);
      }
      grid.append(presetRow);
      grid.append(el('div', { class: 'pipeline-setting-full meta', style: 'font-size:11px; color:var(--fg-3);' },
        '60: smallest files · 75: balanced · 82: perceptually lossless sweet spot · 95: near-lossless.'));
      const sm = el('input', { type: 'checkbox' }); sm.checked = resolved.stripMetadata !== false;
      sm.addEventListener('change', () => { item.settings.optimize = item.settings.optimize || {}; item.settings.optimize.stripMetadata = sm.checked; PipelineBoard.save(); });
      grid.append(el('label', {}, [el('span', {}, 'Strip meta'), sm]));
    }

    details.appendChild(grid);
    // Issue 5: wrap the expander in a header row so the crop column's
    // "Drag frame" button sits beside the ⚙ Settings toggle (right side)
    // instead of inside the collapsible panel.
    const row = el('div', { class: 'pipeline-card-settings-row' }, [details]);
    if (column === 'crop' && window.PipelineCardDragFrame) {
      row.appendChild(window.PipelineCardDragFrame.buildDragFrameBtn(item, column, resolved));
    }
    return row;
  }

  // ---- Action handlers ----
  // P3.5 (DA-H-008/012): the structural mutations (Back, Finalize) and their
  // per-item operationId lock live in pipelineCardMutations.js so this file
  // stays inside its frozen size budget.
  const moveBack = (item) => window.PipelineCardMutations.moveBack(item);
  const finalize = (item) => window.PipelineCardMutations.finalize(item);
  // Before running the Resize column, check whether the target is a large
  // enlargement (>120% on either axis). If so, offer the dedicated Upscale
  // instead via the warning popup. For non-resize columns or small
  // enlargements this calls PipelineOps.run(item) immediately.
  // H10-5: the resize → upscale-warning gate is extracted into
  // pipelineCardResizeCheck.js (window.PipelineCardResizeCheck) so this file
  // stays within its frozen size budget. It writes the upscaled result back
  // into the pipeline item + advances the column, fixing the "too big" flows.
  function runWithResizeCheck(item) {
    if (window.PipelineCardResizeCheck && typeof window.PipelineCardResizeCheck.runWithResizeCheck === 'function') {
      window.PipelineCardResizeCheck.runWithResizeCheck(item);
    } else if (window.PipelineOps && typeof window.PipelineOps.run === 'function') {
      window.PipelineOps.run(item);
    }
  }
  function skip(item) {
    const next = PipelineModel.nextColumn(item.column);
    if (!next) return;
    // Skip writes files[next] = files[current] (same path, recorded under new key).
    item.files[next] = item.files[item.column];
    item.column = next;
    item.history.push({ action: 'skip', column: next, ts: Date.now() });
    PipelineBoard.save();
    PipelineBoard.render();
  }
  function advanceOriginal(item) {
    // From original → upscale (first active column).
    item.column = 'upscale';
    item.files.upscale = item.files.original;
    item.history.push({ action: 'advance', column: 'upscale', ts: Date.now() });
    PipelineBoard.save();
    PipelineBoard.render();
  }
  async function replaceFromDisc(item) {
    try {
      // pickFile returns { ok, path } (a single path field).
      const r = await window.api.pickFile();
      const src = r && r.ok && r.path ? r.path : null;
      if (!src) return;
      const board = window.state.pipeline.image;
      const name = src.split(/[\\/]/).pop();
      const res = await window.api.pipelineReplace({
        srcAbsPath: src, workspaceId: board.workspaceId, column: item.column,
        imageId: item.id, displayName: name,
      });
      if (res && res.ok && res.dst) {
        item.files[item.column] = res.dst;
        item.history.push({ action: 'replace', column: item.column, file: res.dst, ts: Date.now() });
        PipelineBoard.save();
        PipelineBoard.updateCard(item);
        PipelineBoard.toast('Replaced with corrected file.', 'ok');
      } else {
        PipelineBoard.toast('Replace failed: ' + ((res && res.error) || 'unknown'), 'err');
      }
    } catch (e) { PipelineBoard.toast('Replace failed: ' + ((e && e.message) || e), 'err'); }
  }
  function openExternal(item, column) {
    const tools = (window.state.config && Array.isArray(window.state.config.external_tools)) ? window.state.config.external_tools : [];
    if (tools.length === 0) {
      PipelineBoard.toast('No external tools configured. Add some in ⚙ Settings → External tools.', 'warn', 4000);
      return;
    }
    // Simple pick: use the first tool. The "Manage tools" path covers the rest.
    const file = item.files[column];
    // R1.5b.2: mint a read grant for the file before handing off.
    const grantP = (window.GrantHelper && file) ? window.GrantHelper.ensureExternalToolRead([file]) : Promise.resolve(undefined);
    grantP.then((grantId) => {
      if (grantId && grantId.ok === false) {
        PipelineBoard.toast('Open failed: ' + (grantId.error || 'grant error'), 'err');
        return;
      }
      return window.api.externalToolsRun({ name: tools[0].name, paths: [file] }, grantId);
    }).then((r) => {
      if (!r) return;
      if (r && r.ok) PipelineBoard.toast(`Opened in ${tools[0].name}.`, 'ok');
      else PipelineBoard.toast('Open failed: ' + ((r && r.error) || 'unknown'), 'err');
    });
  }
  async function removeItem(item) {
    const board = window.state.pipeline.image;
    // Soft-delete: move all the item's files to .trash via the IPC, then drop from board.
    const files = Object.values(item.files).filter(Boolean);
    let trashOk = true;
    if (files.length) {
      try {
        const res = await window.api.pipelineTrash({ imageId: item.id, files, workspaceId: board.workspaceId });
        // QA-011 fix: if ALL files failed to trash, keep the item on the board.
        if (res && res.ok === false) {
          PipelineBoard.toast('Remove failed: ' + ((res && res.error) || 'files could not be trashed.'), 'err');
          return;
        }
        if (res && Array.isArray(res.failed) && res.failed.length) {
          if (typeof window.logAction === 'function') window.logAction('pipeline-trash', 'partial-fail', { failed: res.failed });
          PipelineBoard.toast(res.failed.length + ' file(s) could not be trashed (locked?).', 'warn');
        }
      } catch (err) {
        if (typeof window.logAction === 'function') window.logAction('pipeline-trash', 'error', { error: String(err && err.message || err) });
        PipelineBoard.toast('Remove failed: ' + ((err && err.message) || err), 'err');
        return;
      }
    }
    board.trash.push({ item, ts: Date.now() });
    const idx = board.items.indexOf(item);
    if (idx >= 0) board.items.splice(idx, 1);
    if (window.PipelineCardProgress) window.PipelineCardProgress.clearProgressSetter(item.id); // EFH2-001
    PipelineBoard.save();
    PipelineBoard.render();
    PipelineBoard.refreshBadge();
    PipelineBoard.toast('Removed from board.', 'warn');
  }
  // Duplicate: copy the current file into the same column under a fresh id and
  // insert a new board item below the original (createdAt = original's + 1ms
  // so it sorts right after it, not at the end of the column). Delegated to
  // pipelineCardExtras.js for the heavy lifting; this is a thin wrapper so the
  // button can stay next to the other actions.
  function duplicateItem(item) {
    if (window.PipelineCardExtras && window.PipelineCardExtras.duplicateItem) {
      window.PipelineCardExtras.duplicateItem(item);
    } else {
      PipelineBoard.toast('Duplicate not available (module missing).', 'err');
    }
  }
  // Save & Remove: export the final file to a chosen folder, then remove the
  // item (one-step "done with this asset"). A per-item command alongside the
  // other actions in the final column.
  function saveAndRemove(item, column) {
    if (window.PipelineCardExtras && window.PipelineCardExtras.saveAndRemove) {
      window.PipelineCardExtras.saveAndRemove(item, column);
    } else {
      PipelineBoard.toast('Save & Remove not available (module missing).', 'err');
    }
  }
  function openItem(item, column) {
    const board = window.state.pipeline.image;
    const colFiles = board.items.filter((i) => i.column === column).map((i) => i.files[column]).filter(Boolean);
    window.Pipeline.openImage(item.files[column], colFiles);
  }
  function revealItem(item, column) {
    const f = item.files[column];
    if (f) window.api.fbReveal(f);
  }
  async function exportCopy(item, column) {
    const f = item.files[column];
    if (!f) return;
    try {
      // pickFolder returns a bare string (the chosen dir).
      const destDir = await window.api.pickFolder();
      if (!destDir || typeof destDir !== 'string') return;
      const base = f.split(/[\\/]/).pop();
      // BGR-009 fix: mint copy grant (R1.3 gate).
      // gewv2 GEW-002 fix: ensureCopy returns { ok, srcGrant, destGrant }.
      const cp = (window.GrantHelper) ? await window.GrantHelper.ensureCopy(f, destDir) : undefined;
      const cr = await window.api.fbCopy(f, destDir, cp && cp.srcGrant, cp && cp.destGrant); if (!cr || !cr.ok) throw new Error((cr && cr.error) || 'copy failed'); // R7: fb:copy RESOLVES {ok:false} (never rejects) — unchecked it toasted a false "Copied" on grant/copy failure.
      PipelineBoard.toast(`Copied ${base} to ${destDir}.`, 'ok');
    } catch (e) { PipelineBoard.toast('Export failed: ' + ((e && e.message) || e), 'err'); }
  }

  window.PipelineCard = { build };
})();
