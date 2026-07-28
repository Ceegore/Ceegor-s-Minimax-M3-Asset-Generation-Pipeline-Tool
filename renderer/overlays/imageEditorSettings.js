// renderer/overlays/imageEditorSettings.js (pixel editor)
// Inpaint models status + swap overlay: shows each bundled AI heal model
// (MI-GAN, LaMa) with its license/size/presence, a "Replace file…" button to
// swap in a newer ONNX (writes to <userData>/assets/models/, which shadows the
// bundled file transparently), and "Restore bundled" to revert.
//
// Opened from the editor's Heal menu ("🧠 Manage models…") so the user can
// update a model without leaving the editor. The bundled files ship via
// bin/models/ (extraResources).

(function () {
  'use strict';

  function openModelsOverlay() {
    if (!window.api || !window.api.inpaintModelsAvailable) {
      toast('Inpaint API not available.', 'err', 3000); return;
    }
    let capturedClose = null;
    showModal((m, close) => {
      capturedClose = close;
      m.style.width = 'min(560px, 92vw)';
      m.appendChild(el('h2', {}, '🧠 Heal Models'));
      m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px;' },
        'AI inpainting models for the editor\'s Resynthesize. Both ship bundled and work out of the box. You can replace either with a newer ONNX file you obtain yourself.'));
      const list = el('div', {});
      m.appendChild(list);
      const loading = el('p', { class: 'meta', style: 'color: var(--fg-2);' }, 'Loading model status…');
      list.appendChild(loading);

      // Render a failure row with a Retry button into `list`.
      function renderFailure(msg) {
        const row = el('p', { style: 'color: var(--accent); margin-bottom:8px;' }, 'Failed to load model status: ' + msg);
        const retry = el('button', { class: 'btn-mini' }, 'Retry');
        retry.addEventListener('click', () => {
          row.remove();
          list.appendChild(loading);
          load();
        });
        list.appendChild(row);
        list.appendChild(retry);
      }
      function renderModels(r) {
        const models = (r && r.models) || {};
        const keys = Object.keys(models);
        if (!keys.length) { list.appendChild(el('p', {}, 'No models registered.')); }
        keys.forEach((key) => {
          const info = models[key];
          list.appendChild(buildModelRow(key, info, close));
        });
      }

      // Single load attempt with .catch (rejection surfaces) + .finally
      // (loading always removed) + a 10s timeout guard so a never-settling
      // invoke can't leave the overlay stuck on "Loading model status…".
      function load() {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out loading model status.')), 10000));
        Promise.race([window.api.inpaintModelsAvailable(), timeout])
          .then((r) => {
            if (!r || !r.ok) { renderFailure((r && r.error) || 'unknown'); return; }
            renderModels(r);
          })
          .catch((err) => {
            renderFailure(String((err && err.message) || err || 'unknown'));
          })
          .finally(() => { try { loading.remove(); } catch (_) {} });
      }
      load();

      m.appendChild(el('div', { class: 'footer' }, [el('button', { onclick: close }, 'Close')]));
    }, { id: 'ie-heal-models' });
  }

  function buildModelRow(key, info, closeFn) {
    const row = el('div', { class: 'row', style: 'border:1px solid var(--border-2);border-radius:var(--radius);padding:10px;margin-bottom:8px;' });
    row.appendChild(el('div', { style: 'font-weight:600;' }, info.label));
    const meta = el('div', { class: 'meta', style: 'color: var(--fg-2); font-size: 11px; margin: 4px 0 8px;' },
      (info.license || '?') + ' · ' + (info.sizeMB || '?') + ' MB · best for: ' + ({ mid: 'mid-size regions', large: 'large regions' }[info.bestFor] || info.bestFor || 'general'));
    row.appendChild(meta);

    // presence + override indicator
    const status = el('div', { class: 'meta', style: 'font-size: 11px; margin-bottom: 6px;' },
      info.present ? ('✓ ' + (info.isOverride ? 'user-replaced file active' : 'bundled file active')) : '✗ not installed (run npm run setup)');
    if (info.present) status.style.color = 'var(--fg-2)';
    else status.style.color = 'var(--accent)';
    row.appendChild(status);

    // actions
    const actions = el('div', { style: 'display:flex; gap:6px; flex-wrap:wrap;' });
    const replaceBtn = el('button', { class: 'btn-mini' }, 'Replace file…');
    replaceBtn.addEventListener('click', () => onReplace(key, replaceBtn, closeFn));
    actions.appendChild(replaceBtn);

    if (info.isOverride) {
      const restoreBtn = el('button', { class: 'btn-mini' }, 'Restore bundled');
      restoreBtn.addEventListener('click', () => onRestore(key, restoreBtn, closeFn));
      actions.appendChild(restoreBtn);
    }
    row.appendChild(actions);
    return row;
  }

  function onReplace(key, btn, closeFn) {
    btn.disabled = true; btn.textContent = 'Replacing…';
    window.api.inpaintReplaceModel(key).then((r) => {
      btn.disabled = false; btn.textContent = 'Replace file…';
      if (r && r.canceled) return;
      if (r && r.ok) {
        toast('Replaced ' + key + '. The new model is used on the next Resynthesize.', 'ok', 4000);
        reopen(closeFn);
      } else {
        toast('Replace failed: ' + ((r && r.error) || 'unknown'), 'err', 5000);
      }
    }).catch((err) => {
      btn.disabled = false; btn.textContent = 'Replace file…';
      toast('Replace failed: ' + ((err && err.message) || err || 'unknown'), 'err', 5000);
    });
  }
  function onRestore(key, btn, closeFn) {
    btn.disabled = true;
    window.api.inpaintRestoreModel(key).then((r) => {
      if (r && r.ok) { toast('Restored bundled ' + key + '.', 'ok', 2500); reopen(closeFn); }
      else { btn.disabled = false; toast('Restore failed: ' + ((r && r.error) || 'unknown'), 'err', 5000); }
    }).catch((err) => {
      btn.disabled = false;
      toast('Restore failed: ' + ((err && err.message) || err || 'unknown'), 'err', 5000);
    });
  }

  // Close the current models modal, then reopen it to reflect the new state.
  function reopen(closeFn) {
    try { if (closeFn) closeFn(); } catch (_) {}
    setTimeout(() => openModelsOverlay(), 0);
  }

  window.ImageEditorSettings = { openModelsOverlay };
})();
