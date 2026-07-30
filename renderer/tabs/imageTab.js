// renderer/tabs/imageTab.js
// ----------------- IMAGE TAB -----------------
window.TABS = window.TABS || {};
window.TABS.image = {
  prefilled: 'a cyberpunk city night scene in 16:9',
  build() {
    const root = $('#tab-image');
    root.innerHTML = '';

    // Prompt
    const prompt = buildParamRow('Prompt (prefilled, editable)',
      { kind: 'textarea', value: this.prefilled, maxLength: 1500, help: 'The description of the image you want. This text is sent to the API as the --prompt flag.\n\nTips for best results:\n  • Be specific — include subject, setting, lighting, mood, camera angle, artistic style.\n  • Avoid negative instructions ("no cats"); use the model\'s --negative-prompt if available, or rephrase positively ("dogs playing in a sunny park").\n  • For style consistency across a series, set a Style preset (the dropdown above) — it prepends a fixed prefix to every prompt.\n  • Max 1500 characters. The counter below the textarea shows the remaining quota.' });
    const styleRow = buildStyleRow('image', 'Select a style preset. Its value is prepended (with a comma) to your manual prompt before the request is sent.');
    // buildStylePreviewBlock() is intentionally NOT mounted here (stays exported).
    const tabState = { selEl: styleRow.sel, manualEl: prompt.input };
    // Read the prompt-character limit from ModelSpecs so image=1500 /
    // speech=10000 / music=2000 / video=2000 stay in sync with the
    // spec in one place. The image API rejects prompts over 1500
    // characters; the counter must enforce that limit up-front.
    const imageMax = (window.ModelSpecs && window.ModelSpecs.MODEL_SPECS
      && window.ModelSpecs.MODEL_SPECS.image
      && window.ModelSpecs.MODEL_SPECS.image.prompt
      && window.ModelSpecs.MODEL_SPECS.image.prompt.max) || 1500;
    const counter = buildPromptCounter({ selEl: styleRow.sel, manualEl: prompt.input, max: imageMax, id: 'image' });
    root.appendChild(el('div', { class: 'section' }, [
      el('h3', {}, 'Prompt'),
      styleRow.row,
      prompt.row,
      counter.wrap,
    ]));

    // Parameters. The installed mmx CLI does not support an image --model
    // flag, so the image model selector is intentionally not rendered.
    const aspect = buildParamRow('--aspect-ratio', {
      kind: 'enum', default: '',
      options: [
        { value: '', label: '(default — let the model pick)' },
        { value: '1:1', label: '1:1 — square' },
        { value: '16:9', label: '16:9 — widescreen' },
        { value: '9:16', label: '9:16 — portrait / phone' },
        { value: '4:3', label: '4:3 — classic' },
        { value: '3:4', label: '3:4 — portrait classic' },
        { value: '2:3', label: '2:3 — photo portrait' },
        { value: '3:2', label: '3:2 — photo landscape' },
        { value: '21:9', label: '21:9 — ultrawide / cinematic' },
      ],
      help: 'Output aspect ratio. The default (empty) lets the model pick its own ratio (image-01 falls back to 1:1). Ignored if you set both --width and --height. The 21:9 ultrawide option is image-01 only.',
    });
    const n = buildParamRow('--n (count)', {
      kind: 'number', default: 1, min: 1, max: 4, customDefault: 1, step: 1,
      options: [1, 2, 3, 4].map((v) => ({ value: v, label: String(v) })),
      help: 'How many images to generate in ONE mmx call. Each unit counts as one generation against your quota.\n\nFor --n > 1, the tool uses --out-dir instead of --out (the mmx CLI rejects the per-file --out when --n > 1). You can also use the "Variants" dropdown (further down) for an alternative multi-generation workflow that re-spawns mmx N times with the same prompt — useful when you want each variant in its own file with its own seed.',
    });
    const width = buildParamRow('--width (px)', {
      kind: 'number', default: '', min: 512, max: 2048, step: 8,
      options: [
        { value: '', label: '(unset)' },
        { value: 512, label: '512' },
        { value: 768, label: '768' },
        { value: 1024, label: '1024' },
        { value: 1280, label: '1280' },
        { value: 1536, label: '1536' },
        { value: 1792, label: '1792' },
        { value: 1920, label: '1920' },
        { value: 2048, label: '2048' },
      ],
      help: 'Pixel width (512–2048, multiple of 8). Overrides --aspect-ratio when paired with --height. image-01 only.',
    });
    const height = buildParamRow('--height (px)', {
      kind: 'number', default: '', min: 512, max: 2048, step: 8,
      options: [
        { value: '', label: '(unset)' },
        { value: 512, label: '512' },
        { value: 768, label: '768' },
        { value: 1024, label: '1024' },
        { value: 1080, label: '1080' },
        { value: 1280, label: '1280' },
        { value: 1536, label: '1536' },
        { value: 1792, label: '1792' },
        { value: 2048, label: '2048' },
      ],
      help: 'Pixel height (512–2048, multiple of 8). Overrides --aspect-ratio when paired with --width. image-01 only.',
    });
    const seed = buildParamRow('--seed', {
      kind: 'number', default: '', min: 0, max: 2_147_483_647, step: 1,
      options: [
        { value: '', label: 'Random' },
        { value: 0, label: '0' },
        { value: 1, label: '1' },
        { value: 42, label: '42' },
        { value: 12345, label: '12345' },
        { value: 1337, label: '1337' },
        { value: 9999, label: '9999' },
      ],
      help: 'Random seed for reproducible generation. Same prompt + same seed always produces (approximately) the same image. Useful when you want to iterate on a prompt — change one word, keep the seed, and the result changes in a predictable way.\n\nBest practices:\n  • Pick a memorable seed (e.g. 42, 1337, your birthday) so you can recreate the look later.\n  • When "Variants" is set > 1 the seed field is locked (variants + seed would defeat the purpose — you\'d get N copies of the same image).\n  • Different models / aspect ratios / resolutions produce DIFFERENT images from the same (prompt, seed) pair. The seed pins the random pattern, not the image itself.',
    });
    const variants = buildVariantsRow({ id: 'variants-image', seedInput: seed });
    const promptOpt = buildParamRow('--prompt-optimizer', {
      kind: 'boolean', default: false,
      help: 'Let the model rewrite your prompt before sending it to the API.\n\nON (recommended for short or vague prompts): the model expands your prompt with extra descriptive detail (lighting, composition, style) — usually produces a noticeably better image, costs one extra API step.\n\nOFF (use for precise control): the tool sends your exact prompt text. Recommended when you have a carefully crafted prompt and don\'t want the model to second-guess you, or when you\'re testing exact prompt wording.',
    });
    const watermark = buildParamRow('--aigc-watermark', {
      kind: 'boolean', default: false,
      help: 'Embed an invisible AI-generated content watermark in the output image.\n\nThe watermark is metadata-only — invisible to the human eye, no visual quality change, no extra file size. Used by content moderation systems to identify AI-generated images.\n\nRecommended ON for public-facing content (the watermark helps with platform compliance in the EU, China, and other jurisdictions that require AI disclosure). OFF for private / personal use where the metadata isn\'t needed.',
    });
    const subjRef = buildParamRow('--subject-ref', {
      kind: 'text', default: '',
      placeholder: 'Path or URL to character image',
      fileFilters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: 'All files', extensions: ['*'] },
      ],
      browseTitle: 'Select character reference image',
      help: 'Character consistency reference.\nFormat: type=character,image=<value>\nYou can also paste a public URL (https://...).\nSupported formats: PNG, JPG, JPEG, WebP.',
    });
    const respFmt = buildParamRow('--response-format', {
      kind: 'enum', default: 'url',
      options: [
        { value: 'url', label: 'url (CDN, downloaded to disk)' },
        { value: 'base64', label: 'base64 (no CDN)' },
      ],
      help: 'How the image bytes come back from the API.\n\nurl (default): the API uploads the image to a CDN and returns a URL. The tool then downloads it to your output folder. Faster (the model finishes sooner), works behind corporate firewalls that block arbitrary CDN domains.\n\nbase64: the API embeds the image bytes directly in the JSON response (no CDN round-trip). Slower end-to-end (the response is bigger), but no external CDN dependency. Useful when debugging CDN-blocked networks, or for offline workflows.',
    });

    root.appendChild(el('div', { class: 'section' }, [
      el('h3', {}, 'Parameters'),
      buildFilePrefixRow(),
      // H10-10.1: variants moved to END of the parameters grid (matches the other tabs).
      el('div', { class: 'grid' }, [aspect.row, width.row, height.row, n.row, seed.row, respFmt.row, promptOpt.row, watermark.row, subjRef.row, variants.row]),
      // Live validity warnings for the W × H combo and the subject
      // ref field. attachImageDimGuards wires the aspect/W/H
      // listeners (auto-fill on aspect change, ratio-mismatch
      // warning, div-by-8 warning) and returns the warning div
      // for the .section. attachSubjectRefGuard does the same for
      // the --subject-ref field (must be a path or http(s) URL
      // with a recognised image extension). Both are hidden when
      // the inputs are valid.
      attachImageDimGuards(aspect, width, height),
      attachSubjectRefGuard(subjRef),
    ]));

    // Action bar + preview
    const actions = el('div', { class: 'actions' });
    const genBtn = el('button', { class: 'primary' }, 'Generate');
    // Upscale checkbox: when on, every generated image is upscaled locally
    // after generation using the saved settings. Clicking the label
    // (or the box) opens the settings overlay.
    const upscaleCb = el('input', { type: 'checkbox', title: 'Upscale the generated image after creation' });
    const upscaleLabel = el('label', { class: 'upscale-checkbox', title: 'Click to configure upscale settings' });
    const upscaleMult = el('span', { class: 'upscale-mult' }, '');
    upscaleLabel.append(upscaleCb, 'Upscale', upscaleMult);
    // Reflect persisted state
    if (state.upscaleEnabled) upscaleCb.checked = true;
    function refreshUpscaleCheckboxUI() {
      const m = (state.upscaleSettings && state.upscaleSettings.multiplier) || 2;
      upscaleMult.textContent = state.upscaleEnabled ? ` (${m}×)` : '';
      upscaleLabel.classList.toggle('active', !!state.upscaleEnabled);
    }
    refreshUpscaleCheckboxUI();
    upscaleLabel.addEventListener('click', (e) => {
      // Only open the settings overlay when the user clicks the label
      // text (not the input itself — clicking the input toggles it).
      if (e.target === upscaleCb) return; // let the input toggle
      e.preventDefault();
      showUpscaleSettings();
    });
    upscaleCb.addEventListener('change', async () => {
      state.upscaleEnabled = !!upscaleCb.checked;
      if (state.upscaleEnabled && !state.upscaleSettings) {
        state.upscaleSettings = { multiplier: 2 };
      }
      refreshUpscaleCheckboxUI();
      await scheduleStateSave();
    });
    const batchControls = el('span', { 'data-batch-controls': 'image', class: 'batch-controls' });
    // Pipeline button opens the column-based image workflow.
    // The badge shows the current number of items on the board.
    const pipelineBtn = el('button', { class: 'pipeline-btn', type: 'button', title: 'Open the Pipeline workflow' }, 'Pipeline');
    const pipelineBadge = el('span', { class: 'pipeline-badge', id: 'pipeline-badge', style: 'display:none;' }, '');
    pipelineBtn.appendChild(pipelineBadge);
    pipelineBtn.addEventListener('click', () => { try { window.Pipeline.open(); } catch (e) { toast('Pipeline failed to open: ' + ((e && e.message) || e), 'err'); } });
    
    const autoPipeCb = el('input', { type: 'checkbox', class: 'auto-pipeline-input', title: 'Automatically enqueue generated images into the Pipeline (you still run each stage by clicking its card)' });
    const autoPipeLabel = el('label', { class: 'auto-pipeline-checkbox', style: 'margin-left: 8px;' });
    if (state.autoPipelineEnabled) autoPipeCb.checked = true;
    // H9-006: the label is "auto-pipeline", not "Auto-run" — the Pipeline is a
    // click-driven board; this toggle only adds generated images to it.
    autoPipeLabel.append(autoPipeCb, ' auto-pipeline');
    autoPipeCb.addEventListener('change', () => {
      if (typeof window.updateAutoPipelineCheckboxes === 'function') {
        window.updateAutoPipelineCheckboxes(autoPipeCb.checked);
      } else {
        state.autoPipelineEnabled = !!autoPipeCb.checked;
        if (typeof scheduleStateSave === 'function') scheduleStateSave();
      }
    });

    // F4: Send to Pipeline button — between Generate and Pipeline. Hidden
    // until a generation completes; the gen success path calls armSendToPipeline(files)
    // to show it. Consumed (hidden) after a click; re-shown on next generation.
    // KGO-017 fix: use display:none instead of just disabled so the button is
    // not visible (and not a silent no-op) before anything has been generated.
    const sendPipelineBtn = el('button', {
      class: 'btn-mini', type: 'button', style: 'display:none;',
      title: 'Send the last generated image(s) to the Pipeline',
    }, 'Send to Pipeline');
    sendPipelineBtn.addEventListener('click', async () => {
      const files = (state._sendToPipelineFiles || []).slice();
      if (!files.length) return;
      sendPipelineBtn.style.display = 'none';   // consumed
      state._sendToPipelineFiles = null;
      try {
        if (window.Pipeline && window.Pipeline.enqueueFromPaths) {
          const r = await window.Pipeline.enqueueFromPaths(files);
          if (r && r.ok) toast(`Sent ${r.added} image(s) to Pipeline.`, 'ok');
          else toast('Send to Pipeline failed: ' + ((r && r.error) || 'unknown'), 'err');
        }
      } catch (e) { toast('Send to Pipeline failed: ' + ((e && e.message) || e), 'err', 5000); }
    });
    // Called by the generation success block. The LATEST generation
    // replaces the previous target list, so the previous option becomes useless.
    function armSendToPipeline(files) {
      if (!files || !files.length) return;
      state._sendToPipelineFiles = files.slice();
      sendPipelineBtn.style.display = '';  // KGO-017: show the button
    }

    // Order: Batch, Generate, Send to Pipeline, Pipeline, auto-pipeline, Upscale, batchControls.
    actions.append(buildAddToBatchBtn('image'), genBtn, sendPipelineBtn, pipelineBtn, autoPipeLabel, upscaleLabel, batchControls);
    // Refresh the badge when the image tab builds.
    try { const n = (window.state && window.state.pipeline && window.state.pipeline.image && window.state.pipeline.image.items || []).length; if (n) { pipelineBadge.textContent = String(n); pipelineBadge.style.display = ''; } } catch (_) {}

    // F4: Tab footer — no preview element anymore, just the actions row.
    // Progress/success/error now route to the status bar (top) + toast + log.
    const tabFooter = el('div', { class: 'tab-footer' }, [actions]);
    root.appendChild(tabFooter);

    // ---- Generate handler ----
    genBtn.addEventListener('click', async () => {
      // Log the click as soon as the user presses Generate, BEFORE
      // the guards (re-entrancy / api_key). A guarded-out click is
      // still real user intent and should appear in the breadcrumb
      // so "I clicked Generate and nothing happened" leaves a trail.
      if (typeof window.logAction === 'function') {
        window.logAction('generate', 'click-generate', {
          tab: 'image',
          has_api_key: !!state.config.hasApiKey,
          upscale_enabled: !!state.upscaleEnabled,
        });
      }
      // Re-entrancy guard: another generation is in progress. The
      // cancel click handler (added by armGenBtnWithCancel) runs for
      // clicks that should cancel instead. The gate is per-tab so a
      // job on the music / speech / video tab does NOT block the
      // image tab. window.JobRunner always exists but never has jobs
      // in production (only unit tests populate it), so the check is
      // a single condition: JobRunner.isTabRunning (when populated)
      // OR state.generating === 'image' (the legacy guard, set/cleared
      // by armGenBtnWithCancel in app.js). Comparing to 'image' (not
      // just truthiness) keeps the per-tab gate intact.
      if ((window.JobRunner && window.JobRunner.isTabRunning('image')) || state.generating === 'image') {
        if (typeof window.logAction === 'function') {
          window.logAction('generate', 'guard-blocked', { reason: 'already-running', tab: 'image' });
        }
        return;
      }
      if (!state.config.hasApiKey) {
        if (typeof window.logAction === 'function') {
          window.logAction('generate', 'guard-blocked', { reason: 'no-api-key', tab: 'image' });
        }
        toast('No API key configured. Click ⚙ to open Settings.', 'err'); return;
      }
      // R7.2b (R7-Gate): block generation when the installed mmx CLI does not
      // advertise the `image` subcommand. Permissive when capability data isn't
      // loaded (isSubcommandAvailable returns true), so a failed/absent probe
      // never locks the UI — this only fires on a CLI that genuinely lacks the
      // subcommand, sparing a wasted click.
      if (window.CapabilityGuard && !window.CapabilityGuard.isSubcommandAvailable('image')) {
        if (typeof window.logAction === 'function') {
          window.logAction('generate', 'guard-blocked', { reason: 'subcommand-unavailable', tab: 'image' });
        }
        toast('The installed mmx CLI does not support image generation. Update it (npm install -g mmx-cli).', 'err', 8000); return;
      }
      const promptText = buildFinalPrompt(styleRow.sel, prompt.input);
      if (!promptText) { toast('Prompt is required (style or manual input).', 'warn'); return; }
      // Block Generate when the prompt exceeds the API limit. The
      // counter goes red at this point (via the existing section12
      // hook), but reject up-front anyway with the precise count so
      // the exact excess is known instead of wasting a request.
      // imageMax was computed earlier (read from ModelSpecs at build
      // time); fall back to 1500 if it's somehow undefined.
      const promptMax = imageMax || 1500;
      if (promptText.length > promptMax) {
        const overBy = promptText.length - promptMax;
        if (typeof window.logAction === 'function') {
          window.logAction('generate', 'guard-blocked', { reason: 'prompt-too-long', tab: 'image', promptLength: promptText.length, promptMax });
        }
        toast(`Prompt is ${promptText.length} chars; the image API accepts at most ${promptMax} (over by ${overBy}). Trim the prompt and try again.`, 'err', 7000);
        return;
      }
      // Pre-flight: validate every visible parameter against the
      // MODEL_SPECS registry. We do this BEFORE building argv so
      // the user sees a precise "X exceeds max Y" toast instead of
      // a cryptic 400 from the API. The registry also tells us
      // which rows are supported on the selected model — a flag
      // that's been left over from a different model would otherwise
      // be sent verbatim and rejected by the backend.
      const imageParams = {
        '--prompt': prompt.input,
        '--aspect-ratio': aspect.input,
        '--n': n.input,
        '--width': width.input,
        '--height': height.input,
        '--seed': seed.input,
        '--prompt-optimizer': promptOpt.input,
        '--aigc-watermark': watermark.input,
        '--subject-reference-file': subjRef.input,
      };
      const preErrs = validateTabAgainstSpec('image', imageParams, null, null, isFlagVisibleForCurrentModel);
      if (preErrs.length) {
        for (const e of preErrs) toast(e, 'err', 6000);
        return;
      }
      // Compute variantsCount UP-FRONT so the preflight can warn about
      // --n × Variants combos (validateToolCombos reads it from toolCtx).
      // The hard cap [1..5] is enforced here, mirroring the dropdown's
      // own options, so validateToolCombos can safely multiply without
      // re-checking bounds.
      const variantsCount = Math.max(1, Math.min(5, parseInt(variants.sel.value, 10) || 1));
      // Authoritative allowed-value / combination check (warn + proceed).
      if (typeof mmxPreflightConfirm === 'function' && !(await mmxPreflightConfirm('image', {
        'aspect-ratio': aspect.input.getValue(),
        n: n.input.getValue(), width: width.input.getValue(), height: height.input.getValue(),
        'response-format': respFmt.input.getValue(),
        prompt: promptText,
      }, { variantsCount }))) return;
      const seedVal = seed.input.getValue();
      const seedLocked = String(seedVal) !== '' && variantsCount > 1;
      if (seedLocked) {
        // Defensive: shouldn't happen since the dropdown is disabled, but just in case
        toast('Variants are disabled while a fixed seed is set (would produce identical images).', 'warn');
        return;
      }
      let outDir;
      try { outDir = await ensureSubDir('image'); }
      catch (e) {
        // Surface the real reason rather than a generic
        // "No output directory set" message, which is misleading
        // when the actual cause is an fs/allow-list error.
        const msg = (e && e.message) || String(e);
        toast('Cannot resolve output folder: ' + msg, 'err', 6000);
        return;
      }
      // R7.5 (S1 §6 R1.5b): mmx:run:job is grant-gated — the --out/--out-dir
      // path must be covered by a Main-minted grant. ensureSubDir just minted
      // a directory-root grant on the output root and stashed it in
      // state._fbGrantId; capture it now (before any further await can let a
      // concurrent tab overwrite the shared slot) and thread it into every
      // mmxRunJob call below.
      const mmxGrant = state._fbGrantId;
      // Pre-flight the --subject-ref reference image. A stale/missing
      // path would otherwise reach the mmx subprocess and fail with a
      // cryptic "File system error: ENOENT … reference.jpeg" that gets
      // retried 4×. Catch it here with a clear, actionable message and
      // never spawn a doomed run. http(s) URLs are validated server-
      // side, so refImageExists reports them as present.
      const subjRefPreflight = (subjRef.input.getValue() || '').trim();
      if (subjRefPreflight && window.api && typeof window.api.refImageExists === 'function') {
        try {
          const ex = await window.api.refImageExists(subjRefPreflight);
          if (ex && ex.ok && !ex.exists) {
            toast(`Reference image not found:\n${subjRefPreflight}\nPick a new file (Browse…) or clear the field, then Generate again.`, 'err', 8000);
            return;
          }
        } catch (_) { /* probe unavailable — fall through and let mmx report */ }
      }
      const slug = slugify(promptText).slice(0, 60) || 'image';
      const promptShort = (promptText || '').replace(/\s+/g, ' ').slice(0, 120);
      // Wrap the generation flow in JobRunner.run() so ActiveJobsWidget
      // shows it during the run and its inline ✕ can cancel just this
      // job (not every in-flight generation on every tab).
      // suppressLogRow:true keeps every existing addLogEvent call below
      // completely unchanged — no duplicate primary row is created;
      // JobRunner is purely a tracking/cancellation layer here, not a
      // logging one. `ctrl` is declared with `let` and assigned by the
      // JobRunner.run() call itself, but runFn (below) only executes
      // in a later microtask, by which time the assignment has already
      // completed — so runFn can safely read ctrl.jobId via closure.
      let ctrl;
      ctrl = window.JobRunner.run({
        tabKey: 'image',
        type: 'image',
        title: `Image generation: ${promptShort}${promptText && promptText.length > 120 ? '…' : ''}`,
        subtitle: `Variants: ${variantsCount}`,
        suppressLogRow: true,
        runFn: async (ctx) => {
      const cancel = armGenBtnWithCancel(genBtn, 'Generate', ctrl.jobId);
      // External cancellation (ActiveJobsWidget ✕, or the Cancel button
      // which now routes through armGenBtnWithCancel -> JobRunner.cancel)
      // aborts ctx.signal — bridge that into the legacy `cancel` token so
      // every existing cancel.wasCancelled() check below keeps working
      // unchanged.
      ctx.signal.addEventListener('abort', () => cancel.cancel());
      // Log a "generation started" event up front so the user
      // sees one row per click in the new structured log pane,
      // and so the "completed" / "failed" events below can be
      // read as part of the same group. We use the prompt text
      // (truncated) as the headline; the full prompt stays
      // available in the expand-on-click details.
      // Pin all log events for this run to the same group id so the
      // renderer tints "started" / "completed" / "failed" with the same
      // colour and the lines can be visually traced per generation. The
      // id is the run's start timestamp (ms) — unique per click, stable
      // across all events of that one run.
      const runGroupId = 'img-' + Date.now();
      // Link the (suppressLogRow) job to this run's log group so the
      // ActiveJobsWidget row-click (LogService.scrollToJob) can find the
      // run's "… started" row even though job.logEventId stays null.
      try { const _lj = window.state && window.state.jobs && window.state.jobs.get(ctrl.jobId); if (_lj) _lj.logGroupId = runGroupId; } catch (_) { /* ignore */ }
      const genStartEvId = addLogEvent({
        category: 'gen',
        groupId: runGroupId,
        headline: `Image generation started: ${promptShort}${promptText && promptText.length > 120 ? '…' : ''}`,
        fullText: promptText,
        details: [
          `Variants: ${variantsCount}`,
          `Seed: ${seedVal === '' ? '(random)' : String(seedVal)}`,
          `Aspect: ${aspect.input.getValue() || '(default)'}`,
          `Reference: ${(() => { const v = subjRef.input.getValue(); return v && v.trim() ? v.trim() : '(none)'; })()}`,
        ],
      });
      let allOk = true;
      let lastPreview = null;
      let lastOutFile = null;
      // --n > 1 runs (`useOutDir`) never push anything to outFiles in
      // the variant loop, so the success gate below
      // (`outFiles.length > 0`) would be structurally false for every
      // successful multi-image run. Track a parallel succeededCount
      // that increments on every variant call that returned ok,
      // regardless of mode. The post-loop success gate keys off
      // succeededCount so both single-image and multi-image runs reach
      // the preview / post-process / quota / notifyImageGenerated path
      // on success.
      let succeededCount = 0;
      // Carries the final file list out of the
      // `if (allOk && lastOutFile...)` block below (where displayFiles
      // is declared) so the JobRunner runFn wrapper can return it as
      // the job's outputPaths after the block closes. Seed
      // finalOutputPaths from outFiles as soon as the variants
      // complete, so a cancel after partial success returns the real
      // file list (not empty) as the job's outputPaths. The
      // post-process block may later OVERWRITE this with its
      // post-processed list — that's correct (upscaled / no-bg /
      // optimised paths are more useful than the raw generated
      // paths).
      let finalOutputPaths = [];
      // outFiles tracks every image file we know about after generation
      // completes. For variants without --out-dir, each variant produces
      // one known file we push here. For --out-dir, the per-call output
      // files are unknown at gen time, so we scan the directory at the
      // end of the loop (see resolveOutDirFiles). After the upscale +
      // crop step, the original file is replaced by the upscaled (and
      // optionally cropped) one — we update the list in place.
      const outFiles = [];
      // lastFailedR captures the most recent failed mmxRun result so the
      // error UI (preview + toast) can surface its full details, including
      // the classified type and a copy-paste blob for support.
      let lastFailedR = null;
      let threw = null;
      // The mmx CLI rejects `--out` when `--n > 1` — for multi-image runs we
      // omit --out and let mmx write numbered files into the run dir.
      const nRaw = n.input.getValue();
      const nCount = nRaw === '' || nRaw == null ? 1 : Math.max(1, parseInt(String(nRaw), 10) || 1);
      const useOutDir = nCount > 1;
      // P4.2 (DB-H-001): --n>1 writes into a private Main-created run_<id>
      // subdir; results are read ONLY from it (no mtime discovery). A failed
      // mint ABORTS — the shared folder would race concurrent runs' files.
      let runDir = outDir;
      if (useOutDir) {
        const BDR = window.BatchDirectRunner || {};
        const minted = BDR.mintRunSubdir ? BDR.mintRunSubdir(outDir) : { ok: false, error: 'BatchDirectRunner not loaded' };
        const ensured = (minted.ok && BDR.ensureRunSubdir) ? await BDR.ensureRunSubdir(minted.runSubdir, mmxGrant) : minted;
        if (!ensured.ok) {
          toast('Cannot create the private run folder: ' + (ensured.error || 'unknown'), 'err', 6000);
          cancel.cleanup();
          return { status: 'err', error: 'run-dir creation failed', outputPaths: [] };
        }
        runDir = ensured.path;
      }
      // Total images this run will produce. The per-tab ETA timer reads
      // this from state.genQueueSize[tabKey] to compute a "remaining
      // time for the whole batch" estimate that ticks down as each
      // variant completes.
      const totalImages = variantsCount * nCount;
      if (!state.genQueueSize) state.genQueueSize = { image: 0, speech: 0, music: 0, video: 0 };
      if (!state.genQueueDone) state.genQueueDone = { image: 0, speech: 0, music: 0, video: 0 };
      state.genQueueSize.image = totalImages;
      state.genQueueDone.image = 0;
      // Validate width/height pairing once (would otherwise warn on every variant).
      const wv0 = width.input.getValue();
      const hv0 = height.input.getValue();
      if ((wv0 && !hv0) || (!wv0 && hv0)) {
        toast('Width and height must both be set (or both unset). Width/height ignored.', 'warn');
      }
      // Build the argv once and reuse it across variant attempts — the prompt
      // and parameters don't change between retries.
      function buildImageArgs() {
        const args = ['image', 'generate'];
        args.push('--prompt', promptText);
        appendFlag(args, aspect.input);
        appendFlag(args, n.input);
        if (wv0 && hv0) { args.push('--width', String(wv0)); args.push('--height', String(hv0)); }
        if (String(seedVal) !== '') args.push('--seed', String(seedVal));
        appendBoolFlag(args, promptOpt.input, '--prompt-optimizer');
        appendBoolFlag(args, watermark.input, '--aigc-watermark');
        // subjRef is a `text` row with a Browse button, so
        // `subjRef.input` is a div wrapper, not the inner <input>.
        // Reading `.value` on the div returns `undefined`, so use
        // .getValue() which ParamRow attaches to the wrapper for
        // exactly this case.
        const subjRefVal = subjRef.input.getValue().trim();
        if (subjRefVal) {
          args.push('--subject-ref', `type=character,image=${subjRefVal}`);
        }
        appendFlag(args, respFmt.input);
        if (useOutDir) {
          args.push('--out-dir', runDir);
        }
        return args;
      }
      // Returns the resolved outFile for this variant (or outDir when --out-dir).
      // When the "force prefix only" checkbox is on, every generated
      // file is named `<prefix><6-digit counter>.png` (e.g.
      // `temp000001.png`). The counter is per-run (NOT per-prefix)
      // and resets to 0 at the start of every Generate click so the
      // first file is `<prefix>000001.<ext>`, the second is
      // `<prefix>000002.<ext>`, and so on.
      const forceCounter = { n: 0 };
      async function makeOutPath(v) {
        if (useOutDir) return runDir;
        const ts = timestamp();
        const variantTag = variantsCount > 1 ? `_v${v}` : '';
        const prefix = (state.filePrefix || '').trim();
        if (state.filePrefixForceOnly) {
          // Force-prefix-only: counter is per-run, so the first
          // variant of the first item is 000001. The _v tag is
          // dropped because the counter alone is the requested
          // name (no slug, no timestamp, no variant tag). Use the
          // exact name (no random uniquePath suffix); collision
          // safety comes from bumping the counter past existing
          // files. Also check sibling extensions at the same
          // counter value, since fixImageExtension() may have
          // renamed an earlier file from .png to its real format.
          return nextFreeForcePrefixPath(outDir, forceCounter, prefix, 'png', ['jpg', 'jpeg', 'webp', 'gif', 'bmp']);
        }
        return uniquePath(outDir, `${prefix}${ts}_${slug}${variantTag}.png`);
      }
      // P4.2 (DB-H-001): list the PRIVATE run dir an --out-dir (--n > 1) run
      // wrote into — mmx picks its own filenames, and the dir by construction
      // only holds THIS run's files, so no mtime windowing is needed. Shared
      // by the success block and the cancel path (partial outputs).
      async function resolveOutDirFiles() {
        try {
          const _g = (window.GrantHelper && window.GrantHelper.ensureDirList) ? await window.GrantHelper.ensureDirList(runDir) : undefined;
          const dirList = (_g && _g.ok === false) ? _g : await window.api.fbList(runDir, _g);
          if (dirList && dirList.ok && Array.isArray(dirList.items)) {
            const matches = dirList.items
              .filter((it) => !it.isDir && ['.png', '.jpg', '.jpeg', '.webp'].includes(it.ext))
              .sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));
            if (matches.length) return matches.map((m) => m.path);
          }
        } catch (_) { /* fall back to whatever we have */ }
        return [];
      }
      try {
        for (let v = 1; v <= variantsCount; v++) {
          if (cancel.wasCancelled()) break;
          // Small breather between variants to avoid hitting the mmx rate
          // limiter (especially right after a failed call).
          if (v > 1) await new Promise((r) => setTimeout(r, 800));
          if (cancel.wasCancelled()) break;

          // Build the per-variant argv. The base args are identical except
          // for --out, which gets a unique filename per variant.
          const baseArgs = buildImageArgs();
          let outFile = await makeOutPath(v);
          const args = baseArgs.slice();
          if (!useOutDir) args.push('--out', outFile);
          // H3-B9: log the command to the structured log (replaces the
          // removed .lastcmd span). The command is masked to hide the API key.
          const maskedCmd = maskLine(`mmx ${args.join(' ')}`);
          if (ctx && ctx.onSecondary) ctx.onSecondary(maskedCmd);

          // Per-variant start time. We use this (not the whole-run start
          // time) to update the per-item average as each item finishes,
          // so the ETA ticks down more accurately as the run progresses.
          const itemStart = Date.now();
          const statusMsg = variantsCount > 1
            ? `Generating image… variant ${v}/${variantsCount}`
            : (useOutDir ? `Generating image… (${nCount} images to ${runDir})` : 'Generating image…');
          setStatus(statusMsg, true);
          // F4: progress now routes to status bar only (no preview element).

          // Try the call, then retry up to 3 times with exponential backoff
          // on transient errors. The "API error: system error (HTTP 200)"
          // pattern we see in the field is almost always a backend hiccup
          // that succeeds on retry. We also detect rate-limit messages and
          // wait longer for those.
          let r = await window.api.mmxRunJob({ args, jobId: ctrl.jobId }, mmxGrant);
          if (!r.ok && !cancel.wasCancelled() && !isRetryableMmxError(r, formatMmxError(r))) {
            // Permanent errors (a missing --subject-ref image, or any
            // permanent input/auth/quota error) can't succeed on retry —
            // surface the real reason once, immediately, instead of
            // turning one clear "File or directory not found" into a
            // 4×-repeated, confusing failure. The reference-image path
            // is pre-flighted before we even get here (see the existence
            // check above buildImageArgs), so this mainly catches
            // server-side input rejections.
            const permMsg = formatMmxError(r);
            toast(`Image variant ${v}/${variantsCount} failed: ${permMsg}`, 'err', 7000);
          } else if (!r.ok && !cancel.wasCancelled()) {
            const firstMsg = formatMmxError(r);
            const isRateLimit = /rate|limit|throttl|too many|429/i.test(firstMsg);
            const maxRetries = 3;
            // FUNC-017: attempt isolation — each retry writes to a unique
            // output path so a partial/corrupt file from attempt N doesn't
            // pollute attempt N+1. Only the successful attempt's file is
            // promoted to the canonical outFile; failed attempt files remain
            // on disk (with _attempt_N suffix) as an inventory of failures.
            const failedAttemptPaths = [];
            for (let attempt = 1; attempt <= maxRetries && !cancel.wasCancelled(); attempt++) {
              // Exponential backoff: 1.5s, 3s, 6s (×2 if rate-limited)
              const baseDelay = 1500 * Math.pow(2, attempt - 1);
              const delay = isRateLimit ? baseDelay * 2 : baseDelay;
              await new Promise((res) => setTimeout(res, delay));
              if (cancel.wasCancelled()) break;
              setStatus(`Retrying image variant ${v}/${variantsCount} (attempt ${attempt + 1}/${maxRetries + 1})…`, true);
              // FUNC-017: derive an attempt-isolated output path.
              const attemptOutFile = useOutDir ? runDir : outFile.replace(/(\.\w+)$/, `_attempt_${attempt}$1`);
              const retryArgs = args.slice();
              if (!useOutDir) {
                const outIdx = retryArgs.indexOf('--out');
                if (outIdx !== -1) retryArgs[outIdx + 1] = attemptOutFile;
              }
              r = await window.api.mmxRunJob({ args: retryArgs, jobId: ctrl.jobId }, mmxGrant);
              if (r.ok) {
                // Promote: the successful attempt's file becomes the canonical output.
                if (!useOutDir) outFile = attemptOutFile;
                toast(`Image variant ${v}/${variantsCount} succeeded on retry ${attempt}.`, 'ok', 2500);
                break;
              }
              // Inventory the failed attempt's partial file (best-effort).
              if (!useOutDir) failedAttemptPaths.push(attemptOutFile);
            }
            if (!r.ok) toast(`Image variant ${v}/${variantsCount} failed after ${maxRetries + 1} attempts: ${firstMsg}`, 'err', 6000);
          }
          if (cancel.wasCancelled()) { allOk = false; break; }
          if (!r.ok) {
            // Mark this variant as failed but continue with the next one so
            // the user gets the remaining variants (e.g. 1, 2 OK, 3 failed,
            // 4, 5 still attempted). We also expose a "Retry" button so the
            // user can manually re-attempt this exact variant.
            allOk = false;
            lastFailedR = r;
            // F4: per-variant failure logged + toast; status bar shows final result.
            // Advance the queue counter even on failure so the ETA
            // doesn't keep counting this variant as "still in flight"
            // for the rest of the run. Failed variants still consume
            // wall-clock time, so their elapsed time is added to the
            // per-item average (so the ETA reflects the real pace of
            // the call, not just the successful ones — otherwise a
            // string of slow failures would under-estimate the time
            // for the remaining variants).
            const failDur = (Date.now() - itemStart) / 1000;
            if (!state.genAvgSec) state.genAvgSec = {};
            const prevAvgFail = state.genAvgSec.image || 0;
            state.genAvgSec.image = prevAvgFail === 0 ? failDur : (prevAvgFail * 0.6 + failDur * 0.4);
            state.genQueueDone.image = (state.genQueueDone.image || 0) + nCount;
            refreshTabEtas();
            continue;
          }
          // Update the per-item average so the ETA improves with each
          // completion. Updating only at the end of the whole run (in
          // armGenBtnWithCancel's cleanup) would keep the ETA pinned to
          // the default for all but the last item of a multi-variant
          // batch.
          const itemDur = (Date.now() - itemStart) / 1000;
          if (!state.genAvgSec) state.genAvgSec = {};
          const prevAvg = state.genAvgSec.image || 0;
          state.genAvgSec.image = prevAvg === 0 ? itemDur : (prevAvg * 0.6 + itemDur * 0.4);
          // Each mmx call with --n > 1 produces nCount images, so
          // queueDone advances by nCount for those calls. For single
          // images (useOutDir=false) it's 1.
          state.genQueueDone.image = (state.genQueueDone.image || 0) + nCount;
          refreshTabEtas();
          // mmx wrote whatever bytes the CDN returned to outFile — the
          // image API has no output-format parameter, so the CDN
          // sometimes returns JPEG even though makeOutPath() always
          // asks for ".png". Sniff the real format and rename before
          // any downstream code (preview, notifyImageGenerated, the
          // post-process chain) captures the old name.
          if (!useOutDir) {
            try {
              // R1.5a.follow-up Phase 6: write-only rename — file-grant with 'write' capability.
              const fixGrant = (window.api && window.api.mintGrant) ? await window.GrantCache.ensurePathGrant(outFile, 'write') : undefined;
              if (fixGrant && fixGrant.ok === false) throw new Error('fixExtension grant: ' + (fixGrant.error || 'mintGrant failed'));
              const fix = await window.api.fixImageExtension(outFile, fixGrant);
              if (fix && fix.ok && fix.renamed && fix.path) outFile = fix.path;
            } catch (_) { /* best-effort; keep the original name on failure */ }
          }
          lastPreview = r.parsed;
          lastOutFile = outFile;
          if (!useOutDir) outFiles.push(outFile);
          // Increment succeededCount for every variant call that
          // returned ok, regardless of mode. outFiles is empty for
          // useOutDir runs by design (mmx picks its own filenames,
          // scanned later in the post-process block), but a
          // successful variant call IS a successful generation,
          // and must NOT route to the failure UI. See the
          // succeededCount declaration above.
          succeededCount++;
          // Live-update the folder explorer + preview pane. The
          // gen handler knows the output path for non-(--out-dir)
          // runs, so there's no need to wait for the 1s polling
          // to discover the file — the UI reacts on the same
          // tick the file is written. The polling is still
          // running in the background as a safety net for the
          // --out-dir case (and for the post-processed upscaled
          // / cropped / no-bg / optimised files the gen handler
          // creates after the raw mmx call returns). Idempotent
          // — calling it with the same path twice is a no-op.
          if (!useOutDir) {
            try { notifyImageGenerated(outFile); } catch (_) {}
            // Add the blink class to the row for the CSS animation.
            // A microtask is used so the row exists in the DOM
            // (the folder explorer was re-rendered by
            // startGenPolling's tick on the previous second, or
            // by the most recent refresh). If the row isn't there
            // yet, the next polling tick will add the class.
            queueMicrotask(() => {
              const row = document.querySelector(`.fb-item[data-path="${CSS.escape(outFile)}"]`);
              if (row) row.classList.add('fb-item-new');
            });
          }
        }
        // Post-processing runs INSIDE the try block so the button stays
        // as "Cancel" and state.generating stays set until every post-
        // processing step has completed. Running it AFTER the finally
        // would let cancel.cleanup() restore the Generate button to its
        // idle state and clear state.generating while the upscale is
        // still running — a re-click would then arm another cancel
        // handler while the prior run's pending promises leaked.
        // Gate on "at least one output file", NOT on allOk: a single
        // failed variant (out of 5) must NOT skip post-processing for
        // every successful variant or route to the full-failure UI.
        // Partial success is still success — generated files
        // should be kept, not routed to the full-failure UI.
        // Seed finalOutputPaths from outFiles BEFORE the post-process
        // block so a cancel AFTER the variants loop but BEFORE
        // post-processing still has the real file list to return. The
        // post-process block below may overwrite this with its post-
        // processed list (the better outcome when it runs to
        // completion).
        // The gate is `succeededCount > 0`, NOT `outFiles.length > 0`:
        // outFiles is only pushed to in the non-(--out-dir) branch of
        // the variant loop, so for `--n > 1` runs outFiles is empty
        // even when every variant succeeded. The directory scan that
        // discovers useOutDir files lives INSIDE this success-block,
        // so an `outFiles.length > 0` gate never runs for --n > 1.
        // outFiles seeding still happens for the single-image path —
        // it remains the best list to return when present — but is no
        // longer the structural gate.
        if (outFiles.length > 0) finalOutputPaths = outFiles.slice();
        if (succeededCount > 0 && !cancel.wasCancelled()) {
        // Resolve the output list: --out-dir runs list the private run dir
        // (mmx names the files); single-file runs already have `outFiles`.
        let sourceFiles = outFiles.slice();
        if (useOutDir) {
          // The discovery scan lives in resolveOutDirFiles() so the
          // cancel path can reuse it.
          const scanned = await resolveOutDirFiles();
          if (scanned.length) sourceFiles = scanned;
          // --out-dir runs let mmx pick its own filenames per image,
          // so the same hardcoded-extension mismatch can apply here
          // too — fix each one up front, before the post-process
          // chain runs on them.
          try {
            sourceFiles = await Promise.all(sourceFiles.map(async (f) => {
              try {
                // R1.5a.follow-up Phase 6: write-only rename — file-grant with 'write' capability.
                const fixGrant = (window.api && window.api.mintGrant) ? await window.GrantCache.ensurePathGrant(f, 'write') : undefined;
                if (fixGrant && fixGrant.ok === false) return f;
                const fix = await window.api.fixImageExtension(f, fixGrant);
                return (fix && fix.ok && fix.renamed && fix.path) ? fix.path : f;
              } catch (_) { return f; }
            }));
          } catch (_) { /* best-effort */ }
        }
        // Post-processing chain: for EVERY generated file (not just
        // the last one — that was the bug fixed in this revision),
        // run the upscale → crop → remove-background → optimize chain
        // and collect the final paths. Each step is independently
        // non-fatal: a failure on variant N keeps the original file
        // for variant N and continues with the next one, so the user
        // never loses an image they paid API credits to generate.
        let displayFiles = [];
        const postProcessEach = state.upscaleEnabled
          || state.removeBackgroundEnabled
          || (state.optimizeSettings && state.optimizeSettings.enabled);
        const lastIdx = sourceFiles.length - 1;
        for (let i = 0; i < sourceFiles.length; i++) {
          if (cancel.wasCancelled()) {
            // Cancel mid-chain: any files we haven't processed yet
            // stay as their raw generated path. The files we have
            // processed stay as their processed paths.
            for (let j = i; j < sourceFiles.length; j++) {
              if (!displayFiles.includes(sourceFiles[j])) displayFiles.push(sourceFiles[j]);
            }
            break;
          }
          const src = sourceFiles[i];
          const tag = sourceFiles.length > 1 ? ` (${i + 1}/${sourceFiles.length})` : '';
          try {
            if (postProcessEach) {
              const finalPath = await runPostProcessChain(src, {
                label: tag,
                onStatus: (msg) => {
                  setStatus(msg, true);
                  // F4: post-process progress routes to status bar only.
                },
                onRefresh: () => { try { refreshBrowser(); } catch (_) {} },
              });
              displayFiles.push(finalPath);
            } else {
              displayFiles.push(src);
            }
          } catch (e) {
            // runPostProcessChain is supposed to swallow per-step
            // errors and return the best-available path, so this
            // only runs on a truly unexpected throw. Be defensive:
            // fall back to the source file so the raw generated
            // image still appears in the preview pane.
            console.error('Post-process failed for', src, e);
            displayFiles.push(src);
          }
          // Refresh the folder browser once per processed file so
          // the new (upscaled / no-bg / optimised) files appear in
          // the right-hand file list as soon as they're written.
          if (i === lastIdx) {
            try { await refreshBrowser(); } catch (_) {}
          }
        }
        // R6.4: postprocess FINALIZES first, THEN pipeline enqueue gets the
        // final deliverables (pre-R6.4 the order was reversed — pipeline
        // received raw files). H9-005: per-row deterministic postprocess.
        if (state._batchRowPostprocess && displayFiles.length > 0 &&
            window.BatchPostprocess && typeof window.BatchPostprocess.runRowPostprocess === 'function') {
          try {
            const pp = await window.BatchPostprocess.runRowPostprocess(displayFiles, state._batchRowPostprocess);
            // R6.3: outputs is 1:1 with inputs; replace displayFiles.
            if (pp.outputs && pp.outputs.length) displayFiles = pp.outputs.slice();
            if (pp.applied.length) toast('Post-processed: ' + pp.applied.join(', '), 'ok', 4000);
            if (pp.errors.length) toast('Post-process: ' + pp.errors.join('; '), 'warn', 6000);
          } catch (e) {
            console.error('Batch row postprocess failed', e);
          }
        }
        // R6.4: pipeline enqueue AFTER postprocess.
        if (state.autoPipelineEnabled && displayFiles.length > 0) {
          try {
            const pp = state._batchRowPostprocess || null;
            if (window.Pipeline && window.Pipeline.enqueueFromPaths) {
              await window.Pipeline.enqueueFromPaths(displayFiles, { settings: pp });
              toast(`Sent ${displayFiles.length} image(s) to Pipeline`);
            }
          } catch (e) {
            console.error('Auto-pipeline enqueue failed', e);
          }
        }
        finalOutputPaths = displayFiles.slice();
        // The last entry of displayFiles is the most recently
        // processed path — treat it as the canonical "last preview"
        // for legacy callers (toast messages that reference it, the
        // preview-ready message at the end, etc.). For a single-
        // file run, this is the same file as the raw generated
        // output (or its post-processed replacement).
        const displayFile = displayFiles.length ? displayFiles[displayFiles.length - 1] : lastOutFile;
        // F4: No preview element anymore — success routes to status bar + Assets pane.
        // Arm the "Send to Pipeline" button with the generated files.
        armSendToPipeline(displayFiles);
        try { previewImagesFromFiles(displayFiles); } catch (_) {}
        bumpGenerationCounter('image', totalImages);
        // Log a "generation completed" event so there is
        // a single row to copy / expand that summarises the
        // run. The full file list is in the details (one per
        // line) for easy pasting into a support ticket.
        addLogEvent({
          category: 'gen',
          groupId: runGroupId,
          result: 'ok',
          headline: `Generated ${displayFiles.length} image${displayFiles.length === 1 ? '' : 's'}`,
          details: displayFiles.map((p) => '• ' + p),
        });
      } else if (succeededCount === 0 && !cancel.wasCancelled()) {
        // Pure failure: NO variant succeeded. Partial-success runs
        // (succeededCount > 0 but not allOk) now go through the success
        // branch above with their post-process chain applied, so the
        // user keeps the images they paid API credits for.
        // Mirror the success-gate change here: key off succeededCount,
        // not outFiles.length === 0 (which is structurally true for
        // every successful --n > 1 run, since outFiles is only pushed
        // to in the non-(--out-dir) branch). A successful --n run
        // takes the success branch above; only a truly-zero-success
        // run lands here.
        // Log a "generation failed" event so the structured
        // error can be copied from the log pane (e.g. into a
        // support ticket). The full classified error message +
        // stderr / stdout are included in the details so the
        // helper doesn't have to ask "what did it
        // say?".
        try {
          const failedMsg = formatMmxError(lastFailedR || { stderr: '', stdout: '', code: -1 });
          const failedClass = classifyMmxError(lastFailedR || {}, failedMsg);
          addLogEvent({
            category: 'error',
            groupId: runGroupId,
            result: 'err',
            headline: `Image generation failed: ${failedMsg}`,
            details: [
              `Classification: ${failedClass}`,
              `Stderr: ${(lastFailedR && lastFailedR.stderr) || '(empty)'}`,
              `Stdout: ${(lastFailedR && lastFailedR.stdout) || '(empty)'}`,
              `Exit code: ${(lastFailedR && lastFailedR.code) != null ? String(lastFailedR.code) : '(unknown)'}`,
            ],
          });
        } catch (_) { /* never block the rest of the error UI on log */ }
        // Build a detailed, actionable error block. The user has been
        // hitting "API error: system error (HTTP 200)" which is opaque —
        // we now classify the error (auth, rate, quota, network, server,
        // unknown) and show targeted tips + buttons to diagnose / retry /
        // copy the raw error for support.
        const lastErrMsg = formatMmxError(lastFailedR || { stderr: '', stdout: '', code: -1 });
        const classification = classifyMmxError(lastFailedR || {}, lastErrMsg);
        const tips = {
          auth: [
            'Your API key may be invalid, expired, or revoked.',
            'Click "Test connection" below to verify.',
            'Re-paste your key in ⚙ Settings if needed.',
          ],
          rate: [
            'The service is rate-limiting your account.',
            'Wait 30–60 seconds, then click Retry.',
            'Avoid running many batches back-to-back.',
          ],
          quota: [
            'Your Token Plan quota is exhausted for this model.',
            'Wait for the rolling window to reset, or upgrade your plan.',
            'Check the ⚡ quota display in the top bar.',
          ],
          network: [
            'Could not reach the service (DNS / firewall / offline).',
            'Verify your internet connection and any VPN / proxy settings.',
            'Click "Diagnose" below to check the installation.',
          ],
          server: [
            'The service returned a server-side error. Usually transient.',
            'Wait a few seconds and click Retry.',
            'If it persists, the service may be degraded — try again later.',
          ],
          // 'silent': mmx exited with code -1 and produced NO
          // stderr/stdout. The main process's `proc.on('error')` path
          // fires when the Node child cannot be spawned OR dies before
          // reaching mmx's own error handler. mmx normally prints
          // "Error: <msg>" to stderr before exit, so a truly empty
          // stderr is the smoking gun for "mmx crashed before it could
          // print anything". Commonly seen as a rate-limit crash on a
          // rapid 2nd variant when running --n × Variants.
          silent: [
            'mmx exited silently with no error output (code -1).',
            'This commonly happens after rapid back-to-back mmx calls (e.g. Variants + --n).',
            'Wait 30–60 seconds, then retry with one variant at a time.',
            'Reduce Variants or --n to avoid hitting rate limits.',
            'Click "Diagnose" to verify the mmx-cli installation.',
          ],
          unknown: [
            'The service returned an unrecognised error.',
            'Click "Copy error" to share the details with support.',
            'Click "Diagnose" to verify the mmx installation.',
          ],
        };
        const tipList = tips[classification] || tips.unknown;
        // F4: the big in-preview error UI is removed. Full error detail is in
        // the log pane (addLogEvent above). Status bar + toast carry the short
        // message (applied post-finally via setStatusError). Keep the toast here.
        const shortMsg = classification === 'auth'
          ? 'Auth failed. Click Test connection in Diagnose.'
          : classification === 'rate'
            ? 'Rate limited. Wait 30s and Retry.'
            : classification === 'quota'
              ? 'Quota exhausted.'
              : classification === 'silent'
                ? 'mmx exited silently. Wait 30s and retry with fewer variants.'
                : 'Generation failed. See log for details.';
        toast(shortMsg, 'warn', 4000);
      }
      } catch (e) {
        threw = e;
        allOk = false;
        console.error('Image generation threw:', e);
        toast('Generation error: ' + (e && e.message || String(e)), 'err', 6000);
      } finally {
        // Record the run outcome on state BEFORE cleanup() clears
        // state.generating. The BatchGen runner detects the end of a run
        // by polling state.generating, so the outcome must be set first
        // or the runner reads a stale value. The preview DOM can't be
        // scraped instead: the image tab deliberately no longer renders an
        // <img> in .preview (the picture lives in the right-hand preview
        // pane), so a preview.querySelector check reports every image
        // batch item as "failed".
        state.genLastResult = state.genLastResult || { image: null, speech: null, music: null, video: null };
        // Mark the run as 'ok' when ANY variant succeeded, so BatchGen
        // does NOT auto-retry a partial-success run (which would waste
        // API quota re-generating the variants that already landed). A
        // cancel AFTER partial success still leaves real files on disk,
        // so treat that as 'ok' too — the cancel flag only matters for
        // runs that produced nothing.
        // Gate on succeededCount, not outFiles.length. outFiles is
        // empty by design for --n > 1 runs (they're filled later by
        // the directory scan inside the post-process block, which is
        // unreachable from this finally). Counting variant calls that
        // returned ok is structurally correct for both modes.
        state.genLastResult.image = (succeededCount > 0 && !threw) ? 'ok' : 'err';
        cancel.cleanup();
        setStatus('Ready', false);
        // Always refresh — even on cancel/failure, partial files may exist
        // on disk and the user should see them.
        try { await refreshBrowser(); } catch {}
        try { await refreshQuota(); } catch {}
      }
      if (threw) return { status: 'err', error: (threw && threw.message) || String(threw), outputPaths: finalOutputPaths };
      if (cancel.wasCancelled()) {
        // F4: cancel message routes to status bar (no preview element).
        setStatus('Generation cancelled.', false);
        toast('Cancelled.', 'warn');
        // A cancelled --n > 1 run may have already written files to
        // the run dir before the cancel landed. The run-dir discovery scan
        // normally runs inside the success branch (skipped on cancel),
        // so finalOutputPaths would be [] and the job history /
        // ActiveJobsWidget / Archive would orphan the produced files.
        // Recover them here so the job records its real outputs even
        // on cancel (R9: scan even at succeededCount 0 — a killed in-flight call may already have written files).
        if (useOutDir && finalOutputPaths.length === 0) {
          finalOutputPaths = await resolveOutDirFiles();
        }
        return { status: finalOutputPaths.length > 0 ? 'ok' : 'cancel', outputPaths: finalOutputPaths }; // R8: a cancel with partial outputs is a partial SUCCESS — return 'ok' like the sibling tabs so BatchGen doesn't re-spawn the item
      }
      // Same partial-success gate as the post-process block — a
      // 4/5-success run returns 'ok' (with a toast that names the
      // partial outcome) so the BatchGen runner does NOT re-spawn it.
      // Gate on succeededCount, not outFiles.length. outFiles is empty
      // by design for --n > 1 runs (the produced files are discovered
      // by the directory scan inside the post-process block, which
      // doesn't run when outFiles.length is 0). For --n > 1 runs the
      // toast's "variants saved" wording is wrong anyway — there's
      // only one Variant call but it produces nCount images — so use
      // the total image count from finalOutputPaths (or totalImages
      // as the fallback) and only show the "X/N variants failed"
      // wording when Variants > 1.
      if (succeededCount > 0) {
        const savedCount = finalOutputPaths.length || totalImages;
        const failedVariants = variantsCount - succeededCount;
        let toastMsg;
        if (variantsCount > 1 && failedVariants > 0) {
          toastMsg = `Image generated. ${succeededCount}/${variantsCount} variants saved (${failedVariants} failed — see log).`;
        } else if (variantsCount > 1) {
          toastMsg = `Image generated. ${variantsCount} variants saved.`;
        } else if (nCount > 1) {
          toastMsg = `Image generated. ${savedCount} images saved.`;
        } else {
          toastMsg = 'Image generated.';
        }
        toast(toastMsg, failedVariants > 0 ? 'warn' : 'ok');
        // F4: success message in the status bar (post-finally so it isn't overwritten).
        setStatus(`✅ ${finalOutputPaths.length || totalImages} image(s) generated — see Assets preview`, false);
        return { status: 'ok', outputPaths: finalOutputPaths };
      }
      // F4: pure failure — show error in status bar with Retry/Diagnose actions.
      setStatusError('Generation failed (see log for details)', [
        { label: 'Retry', onClick: () => genBtn.click() },
        { label: 'Diagnose', onClick: () => { try { showDiagnose(); } catch (_) {} } },
      ]);
      return { status: 'err', outputPaths: finalOutputPaths };
        },
      });
      if (ctrl && typeof ctrl.catch === 'function') {
        // JobRunner.run() rejected synchronously (hard cap, or the same
        // tab somehow started a second job in the gap since the guard
        // above ran) — there is no job and runFn above never executes.
        // Swallow it here so it doesn't surface as an unhandled
        // rejection; JobRunner.run() already shows its own toast.
        ctrl.catch(() => {});
      } else {
        await ctrl.done;
      }
    });
  },
};

window.ImageTab = window.TABS.image;
