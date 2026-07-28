// renderer/overlays/removeBgOverlay.js
// Overlay for background removal containing model selection, GPU toggle, and advanced ONNX settings.

function showRemoveBgOverlay(srcPath, targets) {
  const batch = Array.isArray(targets) && targets.length > 1 ? targets.slice() : null;
  // gewv2 GEW-010 fix: default to the higher-quality bundled model.
  const initialModel = state.removeBackgroundModel || 'birefnet-general-lite';
  const initialGpu = state.removeBackgroundUseGpu !== false;
  
  if (!state.pipelineAdvancedSettings) state.pipelineAdvancedSettings = {};
  if (!state.pipelineAdvancedSettings.isnetbg) state.pipelineAdvancedSettings.isnetbg = {};
  const adv = state.pipelineAdvancedSettings.isnetbg;

  showModal((m, close) => {
    m.appendChild(el('h2', {}, '✨ Remove Background'));
    m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px;' },
      batch ? `Removing background from ${batch.length} selected images` : 'Source: ' + srcPath));

    const modelSel = el('select', {});
    for (const [v, lbl] of [
      ['isnet-general-use', 'IS-Net (fast)'],
      ['birefnet-general-lite', 'BiRefNet Lite (clean)'],
      ['birefnet-general', 'BiRefNet (best)'],
      ['birefnet-portrait', 'BiRefNet Portrait'],
    ]) {
      const opt = el('option', { value: v }, lbl);
      if (v === initialModel) opt.selected = true;
      modelSel.appendChild(opt);
    }

    const gpuCb = el('input', { type: 'checkbox' });
    gpuCb.checked = initialGpu;

    // Issue 6: guided-filter matte refinement toggle (default ON).
    const refineCb = el('input', { type: 'checkbox' });
    refineCb.checked = adv.refine !== false;

    const intraInp = el('input', { type: 'number', min: '0', max: '64', value: adv.intraOpNumThreads || 0 });
    const interInp = el('input', { type: 'number', min: '0', max: '64', value: adv.interOpNumThreads || 0 });
    const execModeSel = el('select', {});
    for (const v of ['sequential', 'parallel']) {
      const opt = el('option', { value: v }, v);
      if (v === (adv.executionMode || 'sequential')) opt.selected = true;
      execModeSel.appendChild(opt);
    }

    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Model'), modelSel]));
    m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Use GPU'), gpuCb]));
    m.appendChild(el('div', { class: 'row' }, [
      el('label', { title: 'Guided-filter matte refinement + foreground color estimation. Sharper edges, no halos. Disable for the legacy feather/dilate path.' }, 'Edge refine'), refineCb
    ]));
    
    // Advanced options in a details block
    const advDetails = el('details', {});
    advDetails.appendChild(el('summary', {}, 'Advanced ONNX Runtime Thread Settings'));
    advDetails.appendChild(el('div', { class: 'row', style: 'margin-top: 8px;' }, [
      el('label', { title: '0 = let runtime decide' }, 'Intra-op threads (0-64)'), intraInp
    ]));
    advDetails.appendChild(el('div', { class: 'row' }, [
      el('label', { title: '0 = let runtime decide' }, 'Inter-op threads (0-64)'), interInp
    ]));
    advDetails.appendChild(el('div', { class: 'row' }, [
      el('label', {}, 'Execution mode'), execModeSel
    ]));
    m.appendChild(advDetails);

    const runBtn = el('button', { class: 'primary' }, 'Remove Background');
    const cancelBtn = el('button', { onclick: close }, 'Cancel');

    runBtn.addEventListener('click', async () => {
      // Save state
      state.removeBackgroundModel = modelSel.value;
      state.removeBackgroundUseGpu = gpuCb.checked;
      state.pipelineAdvancedSettings.isnetbg.intraOpNumThreads = parseInt(intraInp.value, 10) || 0;
      state.pipelineAdvancedSettings.isnetbg.interOpNumThreads = parseInt(interInp.value, 10) || 0;
      state.pipelineAdvancedSettings.isnetbg.executionMode = execModeSel.value;
      state.pipelineAdvancedSettings.isnetbg.refine = refineCb.checked;
      if (typeof scheduleStateSave === 'function') scheduleStateSave();

      runBtn.disabled = true; runBtn.textContent = 'Processing…';
      try {
        if (batch) {
          await runImagePipelineBatch('Remove Background', batch, (p) => {
            return removeBackgroundFile(p, { model: modelSel.value, useGpu: gpuCb.checked });
          });
          close();
          return;
        }
        
        const out = await removeBackgroundFile(srcPath, { model: modelSel.value, useGpu: gpuCb.checked });
        toast(`Background removed → ${out}`, 'ok', 4000);
        await refreshBrowser();
        if (typeof previewImageFromFile === 'function') {
          try { previewImageFromFile(out); } catch (_) {}
        }
        close();
      } catch (e) {
        toast('Background removal failed: ' + (e && e.message || e), 'err', 6000);
        runBtn.disabled = false; runBtn.textContent = 'Remove Background';
      }
    });

    m.appendChild(el('div', { class: 'footer' }, [cancelBtn, runBtn]));
  }, { id: 'remove-bg' });
}
window.showRemoveBgOverlay = showRemoveBgOverlay;
