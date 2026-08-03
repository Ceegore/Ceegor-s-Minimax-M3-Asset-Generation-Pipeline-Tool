// renderer/tabs/providersTab.js
// ============================================================================
// "Other APIs" tab — generates all four asset types through non-MiniMax
// providers (OpenRouter, Replicate, custom OpenAI-compatible base URLs).
// Fully isolated from the mmx tabs: never joins the ['image','speech',
// 'music','video'] loops, never uses the mmx param-row builder / autosave /
// model-spec validation.
//
// Registers window.TABS.providers with a lazy build() (called on first
// tab activation — NOT in the app.js boot loop).
// ============================================================================
(function () {
  'use strict';

  const MODS = [
    ['image', 'Image'],
    ['speech', 'Speech'],
    ['music', 'Music'],
    ['video', 'Video'],
  ];

  // Which provider kinds support which modality (mirrors the adapter .supports sets).
  const KIND_SUPPORTS = {
    openrouter: new Set(['image', 'speech', 'video']),
    'custom-openai': new Set(['image', 'speech', 'video']),
    replicate: new Set(['image', 'speech', 'music', 'video']),
  };

  // Curated default models for Replicate (free-text also accepted).
  const REPLICATE_DEFAULTS = {
    music: 'meta/musicgen',
    image: 'stability-ai/stable-diffusion',
    video: 'minimax/video-01',
    speech: 'hexgrad/kokoro-82m',
  };

  let _cfg = null;   // cached providers.json content
  let _built = false;

  // ---- Helpers ----
  function toast(msg, kind, ms) {
    try { if (typeof window.toast === 'function') window.toast(msg, kind, ms); } catch (_) {}
  }

  function setStatus(text, busy) {
    try { if (typeof window.setStatus === 'function') window.setStatus(text, busy); } catch (_) {}
  }

  async function refreshBrowser() {
    try { if (typeof window.refreshBrowser === 'function') await window.refreshBrowser(); } catch (_) {}
  }

  // ---- Provider settings modal ----
  function openProviderSettings() {
    if (typeof showModal !== 'function') return;
    showModal((m, close) => {
      const wrap = el('div', { class: 'prov-settings' });
      wrap.appendChild(el('h3', {}, 'Provider Settings'));
      const inputs = [];
      for (const p of (_cfg.providers || [])) {
        const sec = el('div', { class: 'prov-settings-entry' });
        sec.appendChild(el('strong', {}, p.label + ' (' + p.kind + ')'));
        // SEC-002: renderer never sees raw apiKey. Show masked info
        // and allow entering a NEW key (write-only input).
        const keyIn = el('input', { type: 'password', placeholder: p.hasKey ? ('****' + (p.apiKeyLast4 || '****') + ' (enter new to replace)') : 'API key', value: '' });
        keyIn.style.width = '100%';
        const urlIn = el('input', { type: 'text', placeholder: 'Base URL (for custom)', value: p.baseUrl || '' });
        urlIn.style.width = '100%';
        if (p.kind !== 'custom-openai') urlIn.disabled = true;
        sec.append(el('label', {}, 'API Key:'), keyIn);
        // RQ-006: a corrupt stored key must be visible and repairable —
        // the settings dialog is the only path that can fix it.
        if (p.credentialState === 'corrupt') {
          sec.appendChild(el('div', { class: 'prov-key-corrupt', style: 'color:#e6a23c;font-size:12px;margin:2px 0;' },
            '⚠ Stored key is unreadable (corrupt). Enter a new key to repair it.'));
        }
        sec.append(el('label', {}, 'Base URL:'), urlIn);
        wrap.appendChild(sec);
        inputs.push({ p, keyIn, urlIn });
      }
      const saveBtn = el('button', { class: 'primary' }, 'Save');
      saveBtn.addEventListener('click', async () => {
        // SEC-002: only send apiKey if the user typed a new one.
        // Empty input means "keep existing key" (main preserves it).
        const updates = { providers: [], selections: _cfg.selections || {} };
        for (const { p, keyIn, urlIn } of inputs) {
          const entry = { id: p.id, label: p.label, kind: p.kind, baseUrl: p.baseUrl || '' };
          const newKey = keyIn.value.trim();
          if (newKey) entry.apiKey = newKey;
          if (p.kind === 'custom-openai') entry.baseUrl = urlIn.value.trim();
          updates.providers.push(entry);
        }
        const r = await window.api.providersSet(updates);
        if (r && r.ok) {
          // RQ-007: Main returns a typed status. Anything other than
          // 'committed' means at least one key operation failed AFTER the
          // metadata was saved — report it loudly and keep the dialog
          // open so the user can repair the key instead of seeing a
          // false success.
          if (r.status && r.status !== 'committed') {
            toast('Settings saved, but ' + (r.status === 'failed' ? 'the API key change failed' : 'some API key changes failed')
              + ': ' + (r.error || 'unknown'), 'err', 10000);
            return;
          }
          toast('Provider settings saved.', 'ok'); close();
        }
        else toast('Save failed: ' + (r && r.error || 'unknown'), 'err');
      });
      const cancelBtn = el('button', {}, 'Cancel');
      cancelBtn.addEventListener('click', close);
      wrap.append(saveBtn, ' ', cancelBtn);
      m.appendChild(wrap);
    }, { id: 'provider-settings' });
  }

  // ---- Build a single modality view ----
  function buildModalityView(modality, drafts) {
    const view = el('div', { class: 'prov-view' });

    // Provider select (filtered by modality support)
    const provSel = el('select', { class: 'prov-select' });
    for (const p of (_cfg.providers || [])) {
      const ks = KIND_SUPPORTS[p.kind];
      if (ks && ks.has(modality)) {
        provSel.appendChild(el('option', { value: p.id }, p.label));
      }
    }
    // Restore saved selection
    const savedSel = (_cfg.selections && _cfg.selections[modality]) || {};
    if (savedSel.providerId) provSel.value = savedSel.providerId;

    // Model input + Load Models button
    const modelRow = el('div', { class: 'prov-row' });
    const draft = drafts[modality] || {};
    const modelIn = el('input', { type: 'text', placeholder: 'Model (e.g. openai/gpt-image-1 or owner/name)', value: draft.model ?? savedSel.model ?? '' });
    modelIn.classList.add('prov-model-input');
    const loadBtn = el('button', { class: 'btn-mini', title: 'Load available models from provider' }, 'Load models');
    const modelList = el('datalist', { id: 'prov-models-' + modality });
    modelIn.setAttribute('list', 'prov-models-' + modality);
    loadBtn.addEventListener('click', async () => {
      loadBtn.disabled = true;
      loadBtn.textContent = '…';
      try {
        const r = await window.api.providersListModels({ providerId: provSel.value });
        if (r && r.ok && r.models) {
          while (modelList.firstChild) modelList.removeChild(modelList.firstChild);
          for (const m of r.models.slice(0, 200)) modelList.appendChild(el('option', { value: m }));
          toast(r.models.length + ' models loaded.', 'ok');
        } else toast('No models: ' + (r && r.error || 'empty'), 'err');
      } catch (e) { toast('Model load failed: ' + e.message, 'err'); }
      loadBtn.disabled = false;
      loadBtn.textContent = 'Load models';
    });
    modelRow.append(el('label', {}, 'Model:'), modelIn, loadBtn, modelList);

    // Pre-fill model hint when switching to Replicate (curated defaults).
    provSel.addEventListener('change', () => {
      const p = (_cfg.providers || []).find((x) => x.id === provSel.value);
      if (p && p.kind === 'replicate' && !modelIn.value.trim()) {
        modelIn.value = REPLICATE_DEFAULTS[modality] || '';
        modelIn.placeholder = 'Replicate model (owner/name or owner/name:version)';
      }
    });

    // Prompt / text
    const promptArea = el('textarea', { class: 'prov-prompt', rows: 4, placeholder: modality === 'speech' ? 'Text to speak…' : 'Prompt…' });
    promptArea.value = draft.prompt ?? savedSel.prompt ?? '';
    view._saveDraft = () => { drafts[modality] = { model: modelIn.value, prompt: promptArea.value }; };

    // Per-modality common params
    const paramsRow = el('div', { class: 'prov-row prov-params' });
    let voiceIn = null, formatSel = null, sizeIn = null, durIn = null;
    if (modality === 'speech') {
      voiceIn = el('input', { type: 'text', value: savedSel.voice || 'alloy', placeholder: 'Voice' });
      formatSel = el('select', {});
      for (const f of ['mp3', 'wav', 'pcm', 'opus']) formatSel.appendChild(el('option', { value: f }, f));
      if (savedSel.format) formatSel.value = savedSel.format;
      paramsRow.append(el('label', {}, 'Voice:'), voiceIn, el('label', {}, 'Format:'), formatSel);
    } else if (modality === 'image') {
      sizeIn = el('input', { type: 'text', placeholder: 'Size (e.g. 1024x1024)', value: '' });
      paramsRow.append(el('label', {}, 'Size:'), sizeIn);
    } else if (modality === 'video' || modality === 'music') {
      durIn = el('input', { type: 'text', placeholder: 'Duration (e.g. 5)', value: '' });
      paramsRow.append(el('label', {}, 'Duration:'), durIn);
    }

    // Freeform JSON params
    const jsonArea = el('textarea', { class: 'prov-json', rows: 2, placeholder: 'Extra params (JSON, merged over common params)' });

    // Generate + Cancel + Status
    const actionsRow = el('div', { class: 'prov-actions' });
    const genBtn = el('button', { class: 'primary' }, 'Generate');
    const cancelBtn = el('button', { disabled: true }, 'Cancel');
    const statusSpan = el('span', { class: 'prov-status' });
    actionsRow.append(genBtn, cancelBtn, statusSpan);

    // Send to Pipeline (images only)
    let pipelineFiles = null;
    const pipeBtn = el('button', { style: 'display:none;' }, 'Send to Pipeline');
    pipeBtn.addEventListener('click', async () => {
      if (pipelineFiles && window.Pipeline && window.Pipeline.enqueueFromPaths) {
        const res = await window.Pipeline.enqueueFromPaths(pipelineFiles);
        if (res && res.ok) {
          pipeBtn.style.display = 'none';
          toast(`Sent ${res.added || pipelineFiles.length} image(s) to Pipeline.`, 'ok');
        } else {
          toast('Failed to send to Pipeline: ' + ((res && res.error) || 'unknown'), 'err');
        }
      }
    });
    actionsRow.appendChild(pipeBtn);

    if (modality === 'image') {
      const autoPipeCb = el('input', { type: 'checkbox', class: 'auto-pipeline-input', title: 'Automatically enqueue generated images into the Pipeline (you still run each stage by clicking its card)' });
      const autoPipeLabel = el('label', { class: 'auto-pipeline-checkbox', style: 'margin-left: 8px;' });
      if (window.state && window.state.autoPipelineEnabled) autoPipeCb.checked = true;
      autoPipeLabel.append(autoPipeCb, ' auto-pipeline');
      autoPipeCb.addEventListener('change', () => {
        if (typeof window.updateAutoPipelineCheckboxes === 'function') {
          window.updateAutoPipelineCheckboxes(autoPipeCb.checked);
        } else if (window.state) {
          window.state.autoPipelineEnabled = !!autoPipeCb.checked;
          if (typeof scheduleStateSave === 'function') scheduleStateSave();
        }
      });
      actionsRow.appendChild(autoPipeLabel);
    }

    // Settings button
    const settingsBtn = el('button', { class: 'btn-mini', title: 'Provider settings (API keys)' }, '\u2699 Providers');
    settingsBtn.addEventListener('click', openProviderSettings);

    view.append(
      el('div', { class: 'prov-row' }, [el('label', {}, 'Provider:'), provSel, settingsBtn]),
      modelRow,
      el('label', {}, modality === 'speech' ? 'Text:' : 'Prompt:'),
      promptArea,
      paramsRow,
      el('label', {}, 'Extra params (JSON):'),
      jsonArea,
      actionsRow,
    );

    // ---- Generate handler ----
    let currentJobId = null;
    genBtn.addEventListener('click', async () => {
      const providerId = provSel.value;
      const model = modelIn.value.trim();
      const prompt = promptArea.value.trim();
      if (!providerId) { toast('Select a provider.', 'err'); return; }
      if (!model) { toast('Enter a model name.', 'err'); return; }
      if (!prompt && modality !== 'speech') { toast('Enter a prompt.', 'err'); return; }
      if (modality === 'speech' && !prompt) { toast('Enter text to speak.', 'err'); return; }

      // Parse extra JSON params
      let params = {};
      const jsonText = jsonArea.value.trim();
      if (jsonText) {
        try { params = JSON.parse(jsonText); }
        catch (e) { toast('Invalid JSON params: ' + e.message, 'err'); return; }
      }
      // Merge common params
      if (modality === 'image' && sizeIn && sizeIn.value.trim()) params.size = sizeIn.value.trim();
      if ((modality === 'video' || modality === 'music') && durIn && durIn.value.trim()) params.duration = durIn.value.trim();

      const voice = voiceIn ? voiceIn.value.trim() : undefined;
      const format = formatSel ? formatSel.value : undefined;

      // Resolve output dir + grant
      const base = (window.state && window.state.config && window.state.config.output_dir) || await window.api.defaultOutputDir();
      const outDir = await window.api.pathJoin(base, 'other-apis', modality);
      const grant = await window.api.mintGrant(outDir, 'write', { kind: 'directory', capabilities: ['write'] });
      if (!grant || !grant.ok) { toast('Grant failed: ' + (grant && grant.error || 'unknown'), 'err'); return; }
      await window.api.fbEnsureDir(outDir, grant.grantId);

      const jobId = 'prov-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      currentJobId = jobId;
      genBtn.disabled = true;
      cancelBtn.disabled = false;
      pipeBtn.style.display = 'none';
      pipelineFiles = null;
      statusSpan.textContent = 'Generating ' + modality + '…';

      const off = window.api.onProvidersProgress((p) => {
        if (p.jobId !== jobId) return;
        statusSpan.textContent = modality + ': ' + p.stage + (p.pct != null ? ' ' + Math.round(p.pct * 100) + '%' : '') + '…';
      });

      try {
        const r = await window.api.providersGenerate({
          jobId, modality, providerId, model,
          prompt: modality === 'speech' ? undefined : prompt,
          input: modality === 'speech' ? prompt : undefined,
          voice, format, params, outDir,
          grantId: grant.grantId,
        });
        if (!r.ok) {
          statusSpan.textContent = '';
          toast('Failed: ' + r.error, 'err', 6000);
          return;
        }
        // Route results into the EXISTING preview/browser layer (call-only reuse).
        await refreshBrowser();
        for (const f of r.files) {
          if (modality === 'image') { try { notifyImageGenerated(f); } catch (_) {} }
          else if (modality === 'video') { try { previewVideoFromFile(f); } catch (_) {} }
          else { try { previewAudioFromFile(f); } catch (_) {} }
        }
        statusSpan.textContent = modality + ' generated — see Assets preview';
        setStatus(modality + ' generated via ' + providerId, false);
        // Images: offer Send to Pipeline (or auto-enqueue if enabled)
        if (modality === 'image' && window.Pipeline && window.Pipeline.enqueueFromPaths) {
          pipelineFiles = Array.isArray(r.files) ? r.files.filter((f) => typeof f === 'string' && f.trim()) : [];
          if (pipelineFiles.length > 0) {
            if (window.state && window.state.autoPipelineEnabled) {
              window.Pipeline.enqueueFromPaths(pipelineFiles).then((res) => {
                if (res && res.ok) {
                  pipeBtn.style.display = 'none';
                  toast(`Enqueued ${res.added || pipelineFiles.length} image(s) to Pipeline.`, 'ok');
                } else {
                  pipeBtn.style.display = '';
                  toast('Auto-pipeline enqueue warning: ' + ((res && res.error) || 'unknown'), 'warn');
                }
              }).catch((err) => {
                pipeBtn.style.display = '';
                toast('Auto-pipeline failed: ' + ((err && err.message) || err), 'err');
              });
            } else {
              pipeBtn.style.display = '';
            }
          }
        }
        // Persist selection
        if (_cfg.selections) {
          _cfg.selections[modality] = Object.assign(_cfg.selections[modality] || {}, { providerId, model, prompt });
          if (voice) _cfg.selections[modality].voice = voice;
          if (format) _cfg.selections[modality].format = format;
          window.api.providersSet(_cfg).catch(() => {});
        }
      } catch (e) {
        statusSpan.textContent = '';
        const raw = (e && e.message) || String(e);
        let message = raw;
        try { const parsed = JSON.parse(raw); message = (parsed && parsed.error && parsed.error.message) || raw; } catch (_) {}
        toast('Error: ' + message, 'err', 6000);
        if (typeof window.setStatusError === 'function') window.setStatusError('Generation failed (see log for details)', [{ label: 'Retry', onClick: () => genBtn.click() }, { label: 'Diagnose', onClick: () => { try { showDiagnose(); } catch (_) {} } }]);
      } finally {
        off && off();
        genBtn.disabled = false;
        cancelBtn.disabled = true;
        currentJobId = null;
      }
    });

    cancelBtn.addEventListener('click', () => {
      if (currentJobId) window.api.providersCancel(currentJobId).catch(() => {});
    });

    return view;
  }

  // ---- Tab registration ----
  window.TABS = window.TABS || {};
  window.TABS.providers = {
    _built: false,
    async build() {
      if (_built) return;
      const root = document.getElementById('tab-providers');
      if (!root) return;
      while (root.firstChild) root.removeChild(root.firstChild);
      _cfg = await window.api.providersGetPublic();

      // Header row with settings button
      const header = el('div', { class: 'prov-header' });
      header.appendChild(el('span', { class: 'prov-title' }, 'Other APIs'));

      // Segmented selector
      const bar = el('div', { class: 'prov-modes' });
      const views = {};
      const drafts = {};
      let active = 'image';
      for (const [key, label] of MODS) {
        const btn = el('button', { class: 'prov-mode', 'data-mode': key }, label);
        btn.addEventListener('click', () => { if (views[active] && views[active]._saveDraft) views[active]._saveDraft(); active = key; refresh(); });
        bar.appendChild(btn);
        views[key] = buildModalityView(key, drafts);
      }
      const stage = el('div', { class: 'prov-stage' });

      function refresh() {
        bar.querySelectorAll('.prov-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === active));
        while (stage.firstChild) stage.removeChild(stage.firstChild);
        stage.appendChild(views[active]);
      }

      root.append(header, bar, stage);
      refresh();
      _built = true;
      this._built = true;
    },
  };
})();
