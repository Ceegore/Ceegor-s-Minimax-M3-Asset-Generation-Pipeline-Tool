// renderer/overlays/importBatchOverlay.js
// Unified entry point for the batch import workflow. Merges the old
// "📥 Import…" and "Examples" buttons into one guided overlay.
// Opened via window.ImportBatchOverlay.open() from the "Import Batch"
// button in each tab's batch controls area.
(function () {
  'use strict';

  function open() {
    showModal((m, close) => {
      m.appendChild(el('h2', { style: 'margin-top: 0;' }, 'Import Batch'));
      m.appendChild(el('p', { class: 'ib-intro', style: 'color: var(--fg-2); font-size: 13px; margin-bottom: 16px;' },
        'Turn a game design document (or any asset brief) into a ready-to-run ' +
        'batch, then import it. Two ways: hand the instruction file to any AI ' +
        'chat, or let the tool do it with M3 (Step 3).'));

      // Step 1 — get the instruction file.
      const step1 = el('div', { class: 'ib-step', style: 'margin-bottom: 14px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2);' });
      step1.appendChild(el('h3', { style: 'margin: 0 0 6px; font-size: 14px;' }, 'Step 1 · Get the AI instruction file'));
      step1.appendChild(el('p', { style: 'margin: 0 0 10px; font-size: 12px; color: var(--fg-2);' },
        'Saves the instruction document. Give it + your GDD to any AI chat; it returns a batch file.'));
      const examplesBtn = el('button', { class: 'btn-mini', style: 'font-weight: 600;' }, 'Save instruction file…');
      examplesBtn.addEventListener('click', () => { window.BatchManager.generateExampleFiles(); });
      step1.appendChild(examplesBtn);

      // Step 2 — import the completed file.
      const step2 = el('div', { class: 'ib-step', style: 'margin-bottom: 14px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2);' });
      step2.appendChild(el('h3', { style: 'margin: 0 0 6px; font-size: 14px;' }, 'Step 2 · Import the completed batch file'));
      step2.appendChild(el('p', { style: 'margin: 0 0 10px; font-size: 12px; color: var(--fg-2);' },
        'Pick the .md/.txt the AI produced. You can review before it is queued.'));
      const importBtn = el('button', { class: 'btn-mini', style: 'font-weight: 600;' }, 'Import batch file…');
      importBtn.addEventListener('click', () => { window.BatchManager.importBatchFileDialog(); });
      step2.appendChild(importBtn);

      m.append(step1, step2);

      // Step 3 — in-tool M3 generation (F3).
      const step3 = el('div', { class: 'ib-step', style: 'margin-bottom: 14px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2);' });
      step3.appendChild(el('h3', { style: 'margin: 0 0 6px; font-size: 14px;' }, 'Step 3 · Generate with M3 (no external AI)'));
      const m3Toggle = el('input', { type: 'checkbox', id: 'ib-m3-toggle' });
      const m3ToggleLabel = el('label', { for: 'ib-m3-toggle', style: 'font-size: 12.5px; cursor: pointer; user-select: none;' },
        ' Let the tool generate the batch using MiniMax M3 directly');
      const m3ToggleRow = el('div', { style: 'margin-bottom: 8px;' }, [m3Toggle, m3ToggleLabel]);
      step3.appendChild(m3ToggleRow);

      // Collapsible M3 form (hidden until toggle is checked).
      const m3Form = el('div', { id: 'ib-m3-form', style: 'display: none; margin-top: 8px;' });

      // GDD file picker.
      const gddRow = el('div', { style: 'margin-bottom: 8px;' });
      const gddLabel = el('label', { style: 'font-size: 12px; font-weight: 600; display: block; margin-bottom: 4px;' }, 'Game design document (.txt / .md):');
      const gddPathInput = el('input', { type: 'text', readonly: true, placeholder: 'No file selected', style: 'width: 70%; margin-right: 6px; font-size: 12px;' });
      const gddPickBtn = el('button', { class: 'btn-mini' }, 'Browse…');
      let _gddPath = null;
      let _gddGrant = null;
      gddPickBtn.addEventListener('click', async () => {
        const r = await window.api.pickFile({ title: 'Select GDD', filters: [{ name: 'Text files', extensions: ['txt', 'md'] }] });
        if (r && r.ok && !r.canceled) {
          _gddPath = r.path;
          _gddGrant = r.grantId || null;
          gddPathInput.value = r.path;
        }
      });
      gddRow.append(gddLabel, gddPathInput, gddPickBtn);
      m3Form.appendChild(gddRow);

      // Compact options form (F3.1).
      const optGrid = el('div', { style: 'display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin-bottom: 10px; font-size: 12px;' });
      // Style name + value.
      const styleNameIn = el('input', { type: 'text', placeholder: 'Style name (optional)', style: 'font-size: 12px;' });
      const styleValueIn = el('input', { type: 'text', placeholder: 'Style prefix (optional)', style: 'font-size: 12px;' });
      // Variants.
      const variantsIn = el('input', { type: 'number', min: '1', max: '5', value: '1', style: 'width: 50px; font-size: 12px;' });
      // Auto-pipeline checkbox.
      const pipeCb = el('input', { type: 'checkbox', id: 'ib-m3-pipeline' });
      const pipeLabel = el('label', { for: 'ib-m3-pipeline', style: 'font-size: 12px; cursor: pointer;' }, ' Auto-pipeline after generation');
      optGrid.append(
        el('div', {}, [el('span', { style: 'font-weight:600;' }, 'Style name:'), el('br'), styleNameIn]),
        el('div', {}, [el('span', { style: 'font-weight:600;' }, 'Style prefix:'), el('br'), styleValueIn]),
        el('div', {}, [el('span', { style: 'font-weight:600;' }, 'Variants:'), el('br'), variantsIn]),
        el('div', { style: 'display:flex;align-items:center;gap:6px;padding-top:14px;' }, [pipeCb, pipeLabel])
      );
      m3Form.appendChild(optGrid);

      // Start + Cancel + progress.
      const m3Actions = el('div', { style: 'display: flex; gap: 8px; align-items: center;' });
      const m3StartBtn = el('button', { class: 'primary', style: 'font-size: 12px;' }, 'Generate batch with M3');
      const m3CancelBtn = el('button', { class: 'btn-mini', style: 'display: none;' }, 'Cancel');
      const m3Progress = el('span', { style: 'font-size: 12px; color: var(--fg-2);' });
      m3Actions.append(m3StartBtn, m3CancelBtn, m3Progress);
      m3Form.appendChild(m3Actions);

      let _cancelFn = null;
      m3StartBtn.addEventListener('click', async () => {
        if (!_gddPath) { toast('Pick a GDD file first.', 'warn'); return; }
        m3StartBtn.disabled = true;
        m3CancelBtn.style.display = '';
        m3Progress.textContent = 'Reading GDD…';
        try {
          // Read the GDD file.
          const readGrant = _gddGrant || ((window.GrantHelper) ? await window.GrantHelper.ensureRead(_gddPath) : undefined);
          const rr = await window.api.fbRead(_gddPath, readGrant);
          if (!rr.ok) { toast('Failed to read GDD: ' + rr.error, 'err'); return; }
          const gddText = decodeURIComponent(escape(atob(rr.base64))).replace(/^\uFEFF/, '');
          if (!gddText.trim()) { toast('GDD file is empty.', 'warn'); return; }

          const opts = {
            styleName: styleNameIn.value.trim() || '',
            styleValue: styleValueIn.value.trim() || '',
            variants: parseInt(variantsIn.value, 10) || 1,
            sendToPipeline: pipeCb.checked,
            onProgress(step, total, label) {
              m3Progress.textContent = 'Step ' + step + '/' + total + ' — ' + label;
            },
          };

          // H-005: use start() so cancel is wired BEFORE the pipeline finishes.
          const handle = window.M3DocPipeline.start(gddText, opts);
          _cancelFn = handle.cancel;
          const result = await handle.promise;
          if (result.ok) {
            m3Progress.textContent = 'Done! Opening import review…';
            window.BatchManager.importBatchFromContent(result.doc);
            close();
          } else if (result.cancelled) {
            m3Progress.textContent = 'Cancelled.';
          } else {
            m3Progress.textContent = '';
            toast('M3 pipeline failed: ' + result.error, 'err', 8000);
          }
        } catch (e) {
          toast('M3 pipeline error: ' + (e.message || e), 'err', 8000);
        } finally {
          m3StartBtn.disabled = false;
          m3CancelBtn.style.display = 'none';
          _cancelFn = null;
        }
      });
      m3CancelBtn.addEventListener('click', () => { if (_cancelFn) _cancelFn(); });

      step3.appendChild(m3Form);
      m3Toggle.addEventListener('change', () => {
        m3Form.style.display = m3Toggle.checked ? '' : 'none';
      });

      m.appendChild(step3);

      // Footer with close button.
      const closeBtn = el('button', { class: 'btn-mini' }, 'Close');
      closeBtn.addEventListener('click', () => close());
      m.appendChild(el('div', { class: 'footer', style: 'display:flex;justify-content:flex-end;margin-top:12px;' }, [closeBtn]));
    }, { id: 'import-batch-overlay' });
  }

  window.ImportBatchOverlay = { open };
})();
