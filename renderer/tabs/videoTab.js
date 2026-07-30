// renderer/tabs/videoTab.js
// Video tab UI logic. Each <script> tag in index.html has its own
// scope, so window.TABS is used to ensure the assignment reaches the
// global TABS container that the other tab files write into.

window.TABS = window.TABS || {};
// ----------------- VIDEO TAB -----------------
window.TABS.video = {
  prefilled: 'A serene mountain landscape at golden hour, drone shot slowly panning over the valley',
  build() {
    const root = $('#tab-video');
    root.innerHTML = '';

    // Prompt
    const prompt = buildParamRow('Video prompt (prefilled, editable)',
      { kind: 'textarea', value: this.prefilled, help: 'Describe the scene + motion. Up to 2000 chars. Use [Push in], [Pan left], [Static shot] etc. to control camera (15 commands supported).' });
    const styleRow = buildStyleRow('video', 'Select a style preset. Its value is prepended (with a comma) to your video prompt before being sent to mmx.');
    // buildStylePreviewBlock() is intentionally NOT mounted here. The
    // helper stays exported so other callers don't break.
    const counter = buildPromptCounter({ selEl: styleRow.sel, manualEl: prompt.input, id: 'video' });
    const variants = buildVariantsRow({ id: 'variants-video' });
    root.appendChild(el('div', { class: 'section' }, [
      el('h3', {}, 'Prompt'),
      styleRow.row,
      prompt.row,
      counter.wrap,
    ]));

    // Parameters
    const model = buildParamRow('--model', {
      kind: 'enum', default: 'MiniMax-Hailuo-2.3',
      options: [
        { value: 'MiniMax-Hailuo-2.3', label: 'MiniMax-Hailuo-2.3 (T2V + I2V, default, best quality)' },
        { value: 'MiniMax-Hailuo-2.3-Fast', label: 'MiniMax-Hailuo-2.3-Fast (faster, I2V only — needs --first-frame)' },
        { value: 'MiniMax-Hailuo-02', label: 'MiniMax-Hailuo-02 (SEF: needs --first-frame + --last-frame)' },
        { value: 'S2V-01', label: 'S2V-01 (subject reference — needs --subject-image)' },
      ],
      help: 'Video generation model.\n\nMiniMax-Hailuo-2.3 (default): Newest + best quality.\n  • T2V (text-to-video) and I2V (image-to-video)\n  • Resolutions: 768P (default), 1080P (6s only)\n  • Durations: 6s, 10s\n  • Supports --prompt-optimizer, --fast-pretreatment, 15 camera commands\n\nMiniMax-Hailuo-2.3-Fast: Faster variant, I2V only.\n  REQUIRES --first-frame. Use for quick iterations.\n\nMiniMax-Hailuo-02: Used for first+last frame interpolation (SEF).\n  REQUIRES both --first-frame and --last-frame.\n  Resolutions: 512P, 768P, 1080P.\n\nS2V-01: Subject reference (face consistency across video).\n  REQUIRES --subject-image.',
    });
    const firstFrame = buildParamRow('--first-frame (I2V/SEF)', {
      kind: 'text', default: '',
      placeholder: 'Path or URL to first-frame image',
      fileFilters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: 'All files', extensions: ['*'] },
      ],
      browseTitle: 'Select first-frame image',
      help: 'Path or URL to a starting image. Triggers I2V (image-to-video).\nFor MiniMax-Hailuo-2.3-Fast this is required.\nSupported formats: JPG, JPEG, PNG, WebP.\nMax 20MB. Aspect 2:5 to 5:2. Short edge > 300px.\nYou can also paste a public URL (https://...).',
    });
    const lastFrame = buildParamRow('--last-frame (SEF only)', {
      kind: 'text', default: '',
      placeholder: 'Path or URL to last-frame image',
      fileFilters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: 'All files', extensions: ['*'] },
      ],
      browseTitle: 'Select last-frame image',
      help: 'Path or URL to an ending image. Combined with --first-frame,\nswitches to Hailuo-02 in start-end-frame (SEF) interpolation mode.\nSupported formats: JPG, JPEG, PNG, WebP. Max 20MB.',
    });
    const subjectImage = buildParamRow('--subject-image (S2V-01)', {
      kind: 'text', default: '',
      placeholder: 'Path or URL to subject reference photo',
      fileFilters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: 'All files', extensions: ['*'] },
      ],
      browseTitle: 'Select subject reference photo',
      help: 'Path or URL to a character reference photo. Switches to S2V-01 model\nfor face consistency across the video.\nSupported formats: JPG, JPEG, PNG, WebP.',
    });
    const duration = buildParamRow('--duration (seconds)', {
      kind: 'number', default: 6, min: 6, max: 10, step: 1,
      options: [{ value: 6, label: '6s' }, { value: 10, label: '10s' }],
      help: 'Video length in seconds. 6s is the default; 10s is supported only on certain models and resolutions (Hailuo-2.3 at 768P and 1080P; Hailuo-02 at 512P and 768P — not at 1080P).\n\nEach extra second roughly doubles the render time and the quota cost. 6s is the sweet spot for most use cases — long enough to show motion, short enough to iterate quickly. Use 10s when you have a specific shot in mind and don\'t mind the extra cost.',
    });
    const resolution = buildParamRow('--resolution', {
      kind: 'enum', default: '768P',
      options: [
        { value: '512P', label: '512P (Hailuo-02 only)' },
        { value: '768P', label: '768P (recommended, default)' },
        { value: '1080P', label: '1080P (6s only on 2.3 / 2.3-Fast)' },
      ],
      help: 'Output resolution (vertical pixel count).\n\n  • 512P — Hailuo-02 only (for first+last-frame interpolation mode). Lowest quality, fastest render.\n  • 768P (default) — current recommendation; best quality-vs-cost balance.\n  • 1080P — full HD, but only works for 6s videos on Hailuo-2.3 / 2.3-Fast (NOT Hailuo-02, NOT 10s videos). Expect 2× the cost of 768P.\n\nLower resolution = faster render + less quota, but less sharp on big screens. Most social-media platforms compress video anyway, so 768P is usually enough.',
    });
    // H7-020: the resolution dropdown must only offer values the SELECTED model
    // actually supports, and every offered value must pass validateValues.
    // The dropdown now rebuilds its option list whenever the model changes,
    // sourced from the canonical VIDEO_RESOLUTIONS_BY_MODEL registry in
    // modelSpecs.js (the same table validateValues checks against).
    function rebuildResolutionOptions() {
      try {
        const sel = resolution.el || resolution.input;
        if (!sel || typeof window.resolutionsForVideoModel !== 'function') return;
        const currentModel = (model.el || model.input).value;
        const allowed = window.resolutionsForVideoModel(currentModel);
        const prevValue = sel.value;
        // Friendly labels per resolution (kept in sync with the static list above).
        const labelFor = { '512P': '512P (Hailuo-02 only)', '768P': '768P (recommended, default)', '1080P': '1080P (6s only)' };
        sel.innerHTML = '';
        for (const r of allowed) {
          const opt = el('option', { value: r }, labelFor[r] || r);
          sel.appendChild(opt);
        }
        // Keep the current value if it's still allowed; otherwise fall back to
        // the canonical default so the dropdown never shows an invalid selection.
        if (allowed.includes(prevValue)) {
          sel.value = prevValue;
        } else {
          sel.value = window.VIDEO_DEFAULT_RESOLUTION || '768P';
        }
      } catch (_) { /* best-effort — never break the tab build */ }
    }
    // Rebuild on model change and once at build time so the initial option
    // list matches the default model (MiniMax-Hailuo-2.3 → 768P/1080P).
    (model.el || model.input).addEventListener('change', rebuildResolutionOptions);
    rebuildResolutionOptions();
    const promptOpt = buildParamRow('--prompt-optimizer', {
      kind: 'boolean', default: true,
      help: 'Auto-rewrite your prompt before sending it to the API (default ON).\n\nON: the model adds extra descriptive detail (lighting, motion, composition). Recommended for short or vague prompts — usually produces a noticeably better video.\n\nOFF: the tool sends your exact prompt. Use this when you have a carefully crafted prompt with exact motion cues ([Push in], [Pan left], etc.) and don\'t want the model to second-guess you.',
    });
    const fastPretreat = buildParamRow('--fast-pretreatment', {
      kind: 'boolean', default: false,
      help: 'Speed up the prompt-optimizer step. Only supported on Hailuo-2.3, 2.3-Fast, and Hailuo-02.\n\nTrade-off: the optimizer runs faster (saves ~10-15s of pre-processing time) but the rewritten prompt is slightly less polished. Recommended for fast iteration loops (preview many ideas, then re-render the best ones with prompt-optimizer ON + fast-pretreatment OFF for the final cut).',
    });
    const pollInterval = buildParamRow('--poll-interval (seconds)', {
      kind: 'number', default: 5, min: 2, max: 60, step: 1,
      options: [3, 5, 10, 15, 30, 60].map((v) => ({ value: v, label: String(v) })),
      help: 'How often the tool polls the API while waiting for the video to finish.\n\n  • Lower (2-3s) — ETA counter updates faster, but you make more API calls (each poll counts against your rate limit).\n  • Higher (15-60s) — fewer API calls, but the ETA jumps in bigger chunks.\n  • Default 5s is a good balance.\n\nOnly matters for the "waiting" phase — does NOT affect render time or output quality.',
    });

    root.appendChild(el('div', { class: 'section' }, [
      el('h3', {}, 'Parameters'),
      // Video tab includes the "Target file prefix" row so the
      // prefix + force-prefix-only behaviour is consistent across
      // every tab that generates assets.
      buildFilePrefixRow(),
      el('div', { class: 'grid' }, [
        model.row, firstFrame.row,
        lastFrame.row, subjectImage.row,
        duration.row, resolution.row,
        promptOpt.row, fastPretreat.row,
        pollInterval.row, variants.row,
      ]),
    ]));

    // Actions
    const actions = el('div', { class: 'actions' });
    const genBtn = el('button', { class: 'primary' }, 'Generate');
    const batchControls = el('span', { 'data-batch-controls': 'video', class: 'batch-controls' });
    actions.append(buildAddToBatchBtn('video'), genBtn, batchControls);
    // F4: Tab footer — no preview element anymore, just the actions row.
    // Progress/success/error now route to the status bar (top) + toast + log.
    const tabFooter = el('div', { class: 'tab-footer' }, [actions]);
    root.appendChild(tabFooter);

    // GEN-001: disable controls for flags the installed CLI doesn't support.
    if (window.CapabilityGuard && window.CapabilityGuard.isLoaded()) {
      const _dis = (flag, r) => {
        if (!window.CapabilityGuard.isFlagSupported('video', flag)) {
          r.row.classList.add('disabled'); r.row.title = 'Not supported by the installed mmx-cli';
          r.row.querySelectorAll('select, input, textarea, button').forEach((inp) => { inp.disabled = true; });
          r.row.appendChild(el('span', { class: 'capability-note' }, 'Needs a newer mmx-cli'));
        }
      };
      _dis('--duration', duration);
      _dis('--resolution', resolution);
      _dis('--prompt-optimizer', promptOpt);
      _dis('--fast-pretreatment', fastPretreat);
    }

    genBtn.addEventListener('click', async () => {
      // Breadcrumb the click BEFORE guards.
      if (typeof window.logAction === 'function') {
        window.logAction('generate', 'click-generate', { tab: 'video', has_api_key: !!state.config.hasApiKey });
      }
      // Wrap the WHOLE click handler in a try/catch so an unexpected
      // throw during pre-flight (e.g. a missing helper) surfaces as a
      // toast instead of silently rejecting the async handler. The
      // button is reset by the re-entrancy guard because
      // state.generating is never set on a pre-flight failure.
      try {
      // Re-entrancy guard: another generation is in progress.
      // Per-tab gate so a job on a different tab does NOT block video.
      // window.JobRunner always exists but never has jobs in
      // production, so the check is a single condition:
      // JobRunner.isTabRunning (when populated) OR
      // state.generating === 'video' (the legacy guard, set/cleared
      // by armGenBtnWithCancel in app.js). Comparing to 'video' (not
      // just truthiness) keeps the per-tab gate intact — a job on
      // image/speech/music must NOT block video.
      if ((window.JobRunner && window.JobRunner.isTabRunning('video')) || state.generating === 'video') {
        if (typeof window.logAction === 'function') {
          window.logAction('generate', 'guard-blocked', { reason: 'already-running', tab: 'video' });
        }
        return;
      }
      if (!state.config.hasApiKey) {
        if (typeof window.logAction === 'function') {
          window.logAction('generate', 'guard-blocked', { reason: 'no-api-key', tab: 'video' });
        }
        toast('No API key configured. Click ⚙ to open Settings.', 'err'); return;
      }
      // R7.2b (R7-Gate): block generation when the installed mmx CLI does not advertise the `video` subcommand (permissive when capability data isn't loaded, so a failed/absent probe never locks the UI). Compact one-liner to stay within videoTab's frozen SIZE-BUDGET.
      if (window.CapabilityGuard && !window.CapabilityGuard.isSubcommandAvailable('video')) { if (typeof window.logAction === 'function') window.logAction('generate', 'guard-blocked', { reason: 'subcommand-unavailable', tab: 'video' }); toast('The installed mmx CLI does not support video generation. Update it (npm install -g mmx-cli).', 'err', 8000); return; }
      const promptText = buildFinalPrompt(styleRow.sel, prompt.input);
      if (!promptText) {
        if (typeof window.logAction === 'function') {
          window.logAction('generate', 'guard-blocked', { reason: 'no-prompt', tab: 'video' });
        }
        toast('Prompt is required (style or manual input).', 'warn'); return;
      }
      // Authoritative combination check (warn + proceed). Catches e.g.
      // the Fast model without a first-frame, or a last-frame without a
      // first-frame — both of which the API rejects.
      // Forward `duration` and `resolution` to the pre-flight so
      // validateValues() can enforce their dependency (the API caps
      // duration at 6s for 1080p). Without them, an invalid combo
      // slips through the renderer and gets rejected by mmx with a
      // generic 400.
      if (typeof mmxPreflightConfirm === 'function' && !(await mmxPreflightConfirm('video', {
        model: model.input.getValue(), prompt: promptText,
        'first-frame': firstFrame.input.getValue(),
        'last-frame': lastFrame.input.getValue(),
        'subject-image': subjectImage.input.getValue(),
        duration: duration.input.getValue(),
        resolution: resolution.input.getValue(),
      }))) return;
      const variantsCount = Math.max(1, Math.min(5, parseInt(variants.sel.value, 10) || 1));
      let outDir;
      try { outDir = await ensureSubDir('video'); }
      catch (e) {
        const msg = (e && e.message) || String(e);
        toast('Cannot resolve output folder: ' + msg, 'err', 6000);
        return;
      }
      // R7.5 (S1 §6 R1.5b): mmx:run:job is grant-gated — capture the output
      // grant ensureSubDir stashed in state._fbGrantId and thread it into the
      // mmxRunJob call so the --out path is authorised.
      const mmxGrant = state._fbGrantId;
      const slug = slugify(promptText).slice(0, 60) || 'video';
      // Wrap the existing generation flow in JobRunner.run() so
      // ActiveJobsWidget shows it during the run and its inline ✕ can
      // cancel just this job. suppressLogRow:true keeps every existing
      // addLogEvent call below unchanged — JobRunner is purely a
      // tracking/cancellation layer here. `ctrl` is assigned by the
      // run() call itself; runFn only executes in a later microtask,
      // by which time the assignment has completed, so it can safely
      // read ctrl.jobId via closure.
      const pShort0 = (promptText || '').replace(/\s+/g, ' ').slice(0, 120);
      let ctrl;
      ctrl = window.JobRunner.run({
        tabKey: 'video',
        type: 'video',
        title: `Video generation: ${pShort0}${promptText && promptText.length > 120 ? '…' : ''}`,
        subtitle: `Variants: ${variantsCount}`,
        suppressLogRow: true,
        runFn: async (ctx) => {
      const cancel = armGenBtnWithCancel(genBtn, 'Generate', ctrl.jobId);
      ctx.signal.addEventListener('abort', () => cancel.cancel());
      // The "force prefix only" counter is per-run (NOT per-prefix)
      // so the first variant of the first item is 000001. Allocate
      // the counter object here (before the variant loop) and bump
      // it on every variant so the file numbering is stable across
      // retries / cancellations.
      const forceCounter = { n: 0 };
      // Log the video generation start so the structured log pane
      // shows the run.
      const runGroupId = 'video-' + Date.now();
      // Link the (suppressLogRow) job to this run's log group so the
      // ActiveJobsWidget row-click (LogService.scrollToJob) can find the run.
      try { const _lj = window.state && window.state.jobs && window.state.jobs.get(ctrl.jobId); if (_lj) _lj.logGroupId = runGroupId; } catch (_) { /* ignore */ }
      const pShort = (promptText || '').replace(/\s+/g, ' ').slice(0, 120);
      addLogEvent({
        category: 'gen',
        groupId: runGroupId,
        headline: `Video generation started: ${pShort}${promptText && promptText.length > 120 ? '…' : ''}`,
        fullText: promptText,
        details: [
          `Variants: ${variantsCount}`,
          `Model: ${model.input.getValue() || '(default)'}`,
          `Resolution: ${resolution.input.getValue() || '(default)'}`,
          `Duration: ${duration.input.getValue() || '(default)'}`,
        ],
      });
      let allOk = true;
      let lastPreview = null;
      let lastOutFile = null;
      // Track every successful output file so a partial-success run
      // routes through the success path.
      const outFiles = [];
      let threw = null;
      // R5 (#2): feed the per-tab ETA timer — without these, genQueueSize.video stays 0 and the video ETA pins at 0:05.
      if (!state.genQueueSize) state.genQueueSize = { image: 0, speech: 0, music: 0, video: 0 }; if (!state.genQueueDone) state.genQueueDone = { image: 0, speech: 0, music: 0, video: 0 };
      state.genQueueSize.video = variantsCount; state.genQueueDone.video = 0;
      try {
        for (let v = 1; v <= variantsCount; v++) {
          if (cancel.wasCancelled()) break;
          const args = ['video', 'generate'];
          args.push('--prompt', promptText);
          // GEN-002: auto-resolve the model based on the generation mode.
          // SEF (first+last frame) requires Hailuo-02; Subject requires S2V-01.
          // If the user left the model at its default (Hailuo-2.3), switch to
          // the mode-compatible model. An explicit user override is respected.
          const firstFrameVal = firstFrame.input.getValue().trim();
          const lastFrameVal = lastFrame.input.getValue().trim();
          const subjectImageVal = subjectImage.input.getValue().trim();
          let effectiveModel = model.input.getValue();
          const isDefaultModel = !effectiveModel || effectiveModel === 'MiniMax-Hailuo-2.3';
          if (firstFrameVal && lastFrameVal && isDefaultModel) effectiveModel = 'MiniMax-Hailuo-02';
          else if (subjectImageVal && isDefaultModel) effectiveModel = 'S2V-01';
          if (effectiveModel) args.push('--model', effectiveModel);
          // firstFrame / lastFrame / subjectImage are `text` rows
          // with a Browse button, so `firstFrame.input` is a div
          // wrapper, not the inner <input>. Reading `.value` on the
          // div returns `undefined`, so use .getValue() which
          // ParamRow attaches to the wrapper for exactly this case.
          if (firstFrameVal) args.push('--first-frame', firstFrameVal);
          if (lastFrameVal) args.push('--last-frame', lastFrameVal);
          if (subjectImageVal) args.push('--subject-image', subjectImageVal);
          const ts = timestamp();
          const variantTag = variantsCount > 1 ? `_v${v}` : '';
          const prefix = (state.filePrefix || '').trim();
          // "force prefix only" mode overrides the slug+timestamp
          // naming scheme with `<prefix><6-digit counter>.<ext>`,
          // counter starting at 000001 per Generate click.
          const outFile = state.filePrefixForceOnly
            ? await nextFreeForcePrefixPath(outDir, forceCounter, prefix, 'mp4')
            : uniquePath(outDir, `${prefix}${ts}_${slug}${variantTag}.mp4`);
          // BGR-001/003 fix: push --download BEFORE duration/resolution/prompt-optimizer/
          // fast-pretreatment. mmx-cli 1.0.16 doesn't declare those flags for
          // `video generate`; an unknown boolean flag swallows the next token,
          // which was --download, causing the output path to be lost.
          args.push('--download', outFile);
          appendFlag(args, duration.input);
          appendFlag(args, resolution.input);
          appendBoolFlag(args, promptOpt.input, '--prompt-optimizer');
          appendBoolFlag(args, fastPretreat.input, '--fast-pretreatment');
          appendFlag(args, pollInterval.input);
          // H3-B9: log the command to the structured log (replaces .lastcmd).
          const maskedCmd = maskLine(`mmx ${args.join(' ')}`);
          if (ctx && ctx.onSecondary) ctx.onSecondary(maskedCmd);
          const statusMsg = variantsCount > 1
            ? `Submitting video job… variant ${v}/${variantsCount} (each takes 1-3 min)`
            : 'Submitting video job…';
          setStatus(statusMsg, true);
          let elapsedTimer = null;
          // F4: progress routes to status bar only (no preview element).
          const updateStatus = (msg) => { setStatus(msg, true); };
          updateStatus(variantsCount > 1
            ? `Submitting video job ${v}/${variantsCount}…`
            : 'Submitting video job (may take a few seconds)…');
          const start = Date.now();
          elapsedTimer = setInterval(() => { const s = Math.round((Date.now() - start) / 1000); updateStatus(`Generating video ${v}/${variantsCount}… elapsed ${s}s (typical: 60-180s)`); }, 1000);
          // try/finally so the 1s interval is ALWAYS cleared — even if mmxRunJob rejects (IPC failure / crash);
          // clearing only on the happy path would leave it firing forever against a stale preview.
          try {
            const r = await window.api.mmxRunJob({ args, jobId: ctrl.jobId }, mmxGrant);
            if (cancel.wasCancelled()) { allOk = false; break; }
            if (!r.ok) {
              const msg = formatMmxError(r);
              // F4: error routes to toast + log (status bar shows final result).
              toast('Video generation failed: ' + msg, 'err', 6000);
              allOk = false;
              // Continue with remaining variants (mirrors imageTab +
              // speechTab + musicTab). The finally clears elapsedTimer
              // either way.
              continue;
            }
            // Verify the file actually landed on disk. mmx returns
            // success (exit 0) even when something downstream (e.g.
            // the download step) fails silently, which would otherwise
            // leave an empty folder with the tool claiming the video
            // was generated. After a "successful" mmxRun, probe the
            // output path via fbExists; if missing, surface a clear
            // "file not on disk" error.
            // BGR-004 fix: mint a read grant before fbExists (R1.3 gate).
            const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(outFile) : undefined;
            // R5: don't forward a failed grant envelope ({ok:false}) as grantId — fbExists would reject and we'd falsely report "output missing"; trust mmx when we can't mint the read grant.
            const existsRes = (existsGrant && existsGrant.ok === false) ? { exists: true } : await window.api.fbExists(outFile, existsGrant);
            // R7: also treat a server-side {ok:false} (e.g. grant revoked between mint and use) as "exists" — else an auth failure is misread as "output missing".
            const fileExists = (existsRes && existsRes.ok === false) ? true : !!(existsRes && existsRes.exists);
            if (!fileExists) {
              const msg = `mmx reported success but the expected output file is missing on disk.\n\n` +
                `Expected: ${outFile}\n\n` +
                `This usually means the API call succeeded but the download step failed silently (quota / network / etc.). ` +
                `Try Generate again, or check ⚙ Settings → Output folder.`;
              // F4: error routes to toast + log.
              toast('Video generation failed: output file missing on disk.', 'err', 6000);
              allOk = false;
              // Continue — the next variant may land cleanly even
              // if this one's download failed.
              continue;
            }
            lastPreview = r.parsed;
            lastOutFile = outFile;
            outFiles.push(outFile);
          } finally {
            clearInterval(elapsedTimer);
            state.genQueueDone.video = (state.genQueueDone.video || 0) + 1; refreshTabEtas(); // R5 (#2): advance the ETA per completed variant.
          }
        }
      } catch (e) {
        threw = e;
        allOk = false;
        console.error('Video generation threw:', e);
        toast('Generation error: ' + (e && e.message || String(e)), 'err', 6000);
      } finally {
        // Record outcome BEFORE cleanup() clears state.generating so the
        // BatchGen runner (which polls state.generating) always reads the
        // final result, never a stale value left over from a prior item.
        state.genLastResult = state.genLastResult || { image: null, speech: null, music: null, video: null };
        // Mirror the image-tab partial-success gate.
        state.genLastResult.video = (outFiles.length > 0 && !threw) ? 'ok' : 'err';
        cancel.cleanup();
        setStatus('Ready', false);
        try { await refreshBrowser(); } catch {}
        try { await refreshQuota(); } catch {}
      }
      if (threw) {
        setStatusError('Generation failed (see log for details)', [{ label: 'Retry', onClick: () => genBtn.click() }, { label: 'Diagnose', onClick: () => { try { showDiagnose(); } catch (_) {} } }]);
        return { status: 'err', error: (threw && threw.message) || String(threw), outputPaths: outFiles };
      }
      if (cancel.wasCancelled()) {
        // F4: cancel routes to status bar.
        setStatus('Generation cancelled.', false);
        toast('Cancelled.', 'warn');
        // A cancel after partial success must return EVERY
        // successful file (not only the last).
        return { status: outFiles.length > 0 ? 'ok' : 'cancel', outputPaths: outFiles };
      }
      if (allOk && lastOutFile) {
        // F4: video success routes to status bar (no preview element).
        bumpGenerationCounter('video', variantsCount);
        setStatus(`✅ ${variantsCount} video(s) generated — see Assets folder`, false);
        // Log the success of the video run.
        addLogEvent({
          category: 'gen',
          groupId: runGroupId,
          result: 'ok',
          headline: `Generated ${variantsCount} video file${variantsCount === 1 ? '' : 's'}`,
          details: [`• ${lastOutFile}`],
        });
      } else if (outFiles.length > 0 && lastOutFile) {
        // Partial-success path.
        bumpGenerationCounter('video', outFiles.length);
        setStatus(`✅ ${outFiles.length}/${variantsCount} video(s) generated — see Assets folder`, false);
        addLogEvent({
          category: 'gen',
          groupId: runGroupId,
          result: 'warn',
          headline: `Generated ${outFiles.length}/${variantsCount} video file${outFiles.length === 1 ? '' : 's'} (${variantsCount - outFiles.length} failed)`,
          details: outFiles.map((p) => '• ' + p),
        });
      }
      // Partial-success gate — a run with ANY successful variant
      // returns 'ok'.
      if (outFiles.length > 0) {
        const failCount = variantsCount - outFiles.length;
        toast(failCount > 0
          ? `Video generated. ${outFiles.length}/${variantsCount} variants saved (${failCount} failed — see log).`
          : (variantsCount > 1 ? `Video generated. ${variantsCount} variants saved.` : 'Video generated.'),
          failCount > 0 ? 'warn' : 'ok');
        return { status: 'ok', outputPaths: outFiles };
      }
      setStatusError('Generation failed (see log for details)', [{ label: 'Retry', onClick: () => genBtn.click() }, { label: 'Diagnose', onClick: () => { try { showDiagnose(); } catch (_) {} } }]);
      return { status: 'err', outputPaths: [] };
        },
      });
      if (ctrl && typeof ctrl.catch === 'function') {
        ctrl.catch(() => {});
      } else {
        await ctrl.done;
      }
      } catch (e) {
        // Outer guard: any error thrown by pre-flight (state lookups,
        // helpers that weren't loaded yet, etc.) lands here as a
        // visible toast instead of a silent async-reject. The
        // re-entrancy guard above is unaffected because state.generating
        // is only set inside armGenBtnWithCancel (which may not
        // have been reached).
        console.error('Video generation pre-flight failed:', e);
        toast('Generation failed before starting: ' + (e && e.message || String(e)), 'err', 6000);
      }
    });
  },
};

function showVideoPreview(rootEl, file, parsed) {
  const url = fileUrl(file) + '?t=' + Date.now();
  rootEl.innerHTML = '';
  const vid = el('video', { controls: '', src: url, style: 'max-width: 100%; max-height: 60vh; display: block; margin: 0 auto;' });
  vid.preload = 'metadata';
  rootEl.appendChild(vid);
  const meta = el('div', { class: 'meta' });
  meta.appendChild(document.createTextNode(file));
  if (parsed) meta.appendChild(el('div', {}, '[mmx] ' + safeStringify(parsed)));
  rootEl.appendChild(meta);
}


window.VideoTab = window.TABS.video;
