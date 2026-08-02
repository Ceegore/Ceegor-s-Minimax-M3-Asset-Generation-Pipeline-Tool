// renderer/tabs/speechTab.js
// ----------------- SPEECH TAB -----------------

// FUNC-027: Per-model voice memory. Stores the last selected voice for
// each model so switching back restores the user's choice.
const _voiceMemoryByModel = new Map();

// Re-populate voice dropdown when --model changes. Switching --model
// drops the old model's voices and reloads the new list. The previous
// voice is preserved if the new model has it; otherwise fall back to
// the first option + toast. Module-scope (not inside build()) to keep
// build() under the 500-line lint limit.
// FUNC-027: also remembers the voice per model and restores it on switch.
function attachModelChangeVoiceRepopulate(tab, modelInput, voiceInput) {
  let previousVoice = voiceInput.getValue ? voiceInput.getValue() : (voiceInput.value || '');
  let previousModel = modelInput.getValue ? modelInput.getValue() : (modelInput.value || '');
  // FUNC-027: store initial voice for the initial model.
  if (previousModel && previousVoice) {
    _voiceMemoryByModel.set(previousModel, previousVoice);
  }
  modelInput.addEventListener('change', () => {
    const newModel = modelInput.getValue ? modelInput.getValue() : (modelInput.value || '');
    // FUNC-027: save the current voice for the old model before switching.
    if (previousModel && previousVoice) {
      _voiceMemoryByModel.set(previousModel, previousVoice);
    }
    tab.populateVoices(voiceInput.el || voiceInput).then(() => {
      try {
        const sel = voiceInput.el || voiceInput;
        if (!sel || !sel.options || !sel.options.length) return;
        // FUNC-027: try to restore the remembered voice for this model.
        const rememberedVoice = _voiceMemoryByModel.get(newModel);
        let targetVoice = rememberedVoice || previousVoice;
        let hasTarget = false;
        for (const opt of sel.options) if (opt.value === targetVoice) { hasTarget = true; break; }
        if (!hasTarget) {
          // Remembered voice not available; fall back to first option.
          targetVoice = sel.options[0].value;
          if (typeof toast === 'function') toast(`Voice "${rememberedVoice || previousVoice}" is not available for ${newModel} — switched to "${targetVoice}".`, 'warn', 4000);
        }
        sel.value = targetVoice;
        if (typeof sel.dispatchEvent === 'function') sel.dispatchEvent(new Event('change', { bubbles: true }));
        previousVoice = targetVoice;
        previousModel = newModel;
        // FUNC-027: update memory for the new model.
        _voiceMemoryByModel.set(newModel, targetVoice);
      } catch (_) {}
    }).catch(() => {});
  });
}

window.TABS = window.TABS || {};
window.TABS.speech = {
  prefilled: 'Welcome to MiniMax — Token Plan or PAYG, both work here.',
  build() {
    const root = $('#tab-speech');
    root.innerHTML = '';

    const text = buildParamRow('Text to read (prefilled, editable)',
      { kind: 'textarea', value: this.prefilled, maxLength: 10000, max: 10000,
        help: 'The text the voice will read aloud. Plain text — no special formatting, no Markdown.\n\nTips:\n  • Punctuation controls pacing — commas = short pause, periods = longer pause, question marks = rising intonation. They really do change how the voice sounds.\n  • Newlines = ~0.5s pause.\n  • "double quotes" to emphasize, CAPS for shouting.\n  • Some models support sound tags like (laughter) inline.\n  • Max 10 000 characters. The counter below shows the remaining quota.' });
    const styleRow = buildStyleRow('speech', 'Select a style preset. Its value is prepended (with a comma) to your text before the request is sent. Useful for narration tone, language hints, etc.');
    // buildStylePreviewBlock() is intentionally NOT mounted here. The
    // helper stays exported so other callers don't break.
    const counter = buildPromptCounter({ selEl: styleRow.sel, manualEl: text.input, max: 10000, id: 'speech' });
    const variants = buildVariantsRow({ id: 'variants-speech' });
    root.appendChild(el('div', { class: 'section' }, [
      el('h3', {}, 'Text'),
      styleRow.row,
      text.row,
      counter.wrap,
    ]));

    const model = buildParamRow('--model', {
      kind: 'enum', default: 'speech-2.8-hd',
      options: [
        { value: 'speech-2.8-hd', label: 'speech-2.8-hd (newest, best quality — default)' },
        { value: 'speech-2.8-turbo', label: 'speech-2.8-turbo (faster, lower latency)' },
        { value: 'speech-2.6-hd', label: 'speech-2.6-hd' },
        { value: 'speech-2.6-turbo', label: 'speech-2.6-turbo' },
        { value: 'speech-02-hd', label: 'speech-02-hd' },
        { value: 'speech-02-turbo', label: 'speech-02-turbo' },
        { value: 'speech-01-hd', label: 'speech-01-hd (legacy)' },
        { value: 'speech-01-turbo', label: 'speech-01-turbo (legacy)' },
      ],
      help: 'Text-to-speech model.\n\nspeech-2.8-hd (default): Newest, best audio quality, supports sound tags.\nspeech-2.8-turbo: Same quality tier but lower latency.\nspeech-2.6-hd / 2.6-turbo: Previous generation, still high quality.\nspeech-02-hd / 02-turbo: Older generation, 24 languages.\nLegacy 2.6 / 02: Use only if you hit issues with 2.8.\n\nAll models: up to 10 000 chars input, --speed / --volume / --pitch supported.',
    });
    const voice = buildParamRow('--voice', {
      kind: 'enum', default: 'English_expressive_narrator',
      options: [{ value: 'English_expressive_narrator', label: 'English_expressive_narrator (default)' }],
      help: 'Which voice speaks the text. Populated from `mmx speech voices` (300+ voices across many languages — each voice has a different age, gender, accent, personality).\n\nTips:\n  • Click the ▶ button next to the dropdown to preview a voice without consuming quota.\n  • Narrative voices for long-form reading, energetic voices for ads, calm voices for meditation.\n  • Some voices support emotions / sound effects; the dropdown only lists what is available for the current model.\n  • Default is a good neutral narrator for most uses.',
    });
    const speed = buildParamRow('--speed', {
      kind: 'number', default: 1.0, step: 0.05,
      options: [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0].map((v) => ({ value: v, label: String(v) })),
      help: 'Playback speed multiplier. 1.0 = normal speed.\n\n  • 0.5 = half speed (slow, deliberate — audiobooks / meditation).\n  • 0.75 = conversational pace.\n  • 1.0 = default.\n  • 1.25 = slightly fast.\n  • 1.5 = clearly fast (podcast-style).\n  • 2.0 = double speed (chipmunk — only for skimming).\n\nFor most uses 0.9–1.1 is the natural range. Above 1.5 noticeably distorts the voice.',
    });
    const volume = buildParamRow('--volume', {
      // API range is (0, 10] — 0 is NOT accepted (the request errors), so
      // the dropdown starts at 1.
      kind: 'number', default: 1, min: 1, max: 10, step: 1,
      options: [1, 2, 3, 5, 7, 10].map((v) => ({ value: v, label: String(v) })),
      help: 'Output loudness gain, applied at generation time.\n\n  • 1 = normal (default).\n  • 2–3 = noticeably louder, good for noisy environments.\n  • 5–7 = very loud (use sparingly — clipping at peaks).\n  • 10 = maximum; expect audible distortion.\n\nNOT a final-stage normaliser — scales the model output. For precise loudness matching across clips, use the audio cutter\'s "Normalize" step after generation (LUFS-based true-peak limiting).',
    });
    const pitch = buildParamRow('--pitch', {
      kind: 'number', default: 0, min: -12, max: 12, step: 1,
      options: [-12, -6, -3, 0, 3, 6, 12].map((v) => ({ value: v, label: String(v) })),
      help: 'Pitch shift in semitones (each = one piano key). 0 = no change.\n\n  • -12 = one octave down (deep-voiced narrator).\n  • -6 = half-octave down.\n  • 0 = default.\n  • +6 = half-octave up.\n  • +12 = one octave up (chipmunk / child voice).\n\nStick to ±2 for subtle changes. Beyond ±6 sounds unnatural, beyond ±10 has artifacts.',
    });
    const format = buildParamRow('--format', {
      kind: 'enum', default: 'mp3',
      options: [
        { value: 'mp3', label: 'mp3 (default)' },
        { value: 'wav', label: 'wav' },
        { value: 'pcm', label: 'pcm' },
        { value: 'flac', label: 'flac' },
        { value: 'opus', label: 'opus' },
        { value: 'pcmu_raw', label: 'pcmu_raw' },
        { value: 'pcmu_wav', label: 'pcmu_wav' },
      ],
      help: 'Output audio file container / codec.\n\n  • mp3 (default) — most compatible, plays on every device, reasonable file size. Use this unless you have a specific reason not to.\n  • wav — uncompressed PCM, large file, no quality loss. Good for further editing.\n  • pcm — raw PCM (no WAV header). Most players can\'t open it directly.\n  • flac — lossless compression (~half the size of WAV, same quality).\n  • opus — modern codec, smaller than MP3 at the same quality. Less universal.\n  • pcmu_raw / pcmu_wav — narrow-band (8 kHz) telephony format. Only useful for IVR / phone-system work.',
    });
    const sampleRate = buildParamRow('--sample-rate', {
      // Allowed by the T2A API: 8000/16000/22050/24000/32000/44100.
      // 48000 is NOT accepted (was previously offered and would error).
      kind: 'number', default: 32000, step: 1000,
      options: [8000, 16000, 22050, 24000, 32000, 44100].map((v) => ({ value: v, label: String(v) })),
      help: 'Audio sample rate in Hz — samples per second of audio. Higher = captures higher frequencies, larger file.\n\n  • 8000 — telephone quality (muffled).\n  • 16000 — AM-radio quality.\n  • 22050 — FM-radio quality.\n  • 24000 — podcasts / audiobooks.\n  • 32000 (default) — high-quality speech.\n  • 44100 — CD quality (overkill for speech but fine).\n\nFor speech the default 32000 is the sweet spot. The API rejects 48000.',
    });
    const bitrate = buildParamRow('--bitrate', {
      kind: 'number', default: 128000, step: 1000,
      // The MiniMax audio API rejects bitrates outside this set with
      // "audio bitrate: N is not allowed". Restrict to the four
      // accepted values so a non-default pick can't silently break
      // generation.
      options: [32000, 64000, 128000, 256000].map((v) => ({ value: v, label: String(v) })),
      help: 'Bitrate in bits per second — average bits to encode one second of audio. Only meaningful for lossy formats (mp3, opus).\n\n  • 32000 — low (voice / podcast, smallest file).\n  • 64000 — medium (good for most speech).\n  • 128000 (default) — high (transparent for most listeners).\n  • 256000 — maximum (overkill for most music).\n\nAPI rejects other values with "audio bitrate: N is not allowed". For FLAC / WAV / PCM the value is ignored (lossless codecs).',
    });
    const channels = buildParamRow('--channels', {
      kind: 'enum', default: 1,
      options: [{ value: 1, label: '1 (mono)' }, { value: 2, label: '2 (stereo)' }],
      help: 'Number of audio channels.\n\n  • 1 (mono, default) — single channel, smallest file. Best for speech.\n  • 2 (stereo) — left + right channels, 2× the file size. Best for music.\n\nFor speech always use mono — stereo speech sounds identical but wastes half your quota and storage.',
    });
    const language = buildParamRow('--language (boost)', {
      kind: 'enum-text', default: '',
      options: [
        { value: '', label: '(none)' },
        { value: 'auto', label: 'auto' },
        { value: 'en', label: 'en' },
        { value: 'zh', label: 'zh' },
        { value: 'ja', label: 'ja' },
        { value: 'ko', label: 'ko' },
        { value: 'es', label: 'es' },
        { value: 'fr', label: 'fr' },
        { value: 'de', label: 'de' },
        { value: 'pt', label: 'pt' },
        { value: 'ru', label: 'ru' },
        { value: 'it', label: 'it' },
        { value: 'ar', label: 'ar' },
        { value: 'hi', label: 'hi' },
      ],
      help: `Boost the model's recognition of a specific language (BCP-47 code).

  • (none) — the model uses the text itself to guess the language.
  • auto — auto-detects from the first few words.
  • en / zh / ja / ko / es / fr / de / pt / ru / it / ar / hi — explicit codes.

The language hint mainly helps with mixed-language text (e.g. English narration that drops a French phrase) — without it, the model may switch pronunciation rules mid-sentence.`,
    });
    const subtitles = buildParamRow('--subtitles', {
      kind: 'boolean', default: false,
      help: 'Also save a .srt subtitle file alongside the audio. The .srt has the same base filename as the audio (e.g. speech_xxx.mp3 + speech_xxx.srt) and contains sentence-level timestamps.\n\nUseful for:\n  • Video projects (you can mux the .srt into an MP4 with ffmpeg).\n  • Accessibility (captioning for hearing-impaired viewers).\n  • Searchable transcripts (the .srt is plain text, easy to grep).',
    });
    const pronunciation = buildParamRow('--pronunciation (repeatable)', {
      kind: 'text', default: '',
      help: 'Custom pronunciation rule in the form "from=to". Tells the model to always read "from" as "to".\n\nExamples:\n  • "GIF=Gif" — say GIF as "gif" (not "jiff")\n  • "SQL=sequel" — say SQL as "sequel"\n  • "NGO=en-gee-oh" — spell out an acronym\n\nTo add multiple rules, separate them with a comma: "GIF=Gif,SQL=sequel". The "repeatable" in the label means the API accepts the flag multiple times for separate rules.',
    });

    root.appendChild(el('div', { class: 'section' }, [
      el('h3', {}, 'Parameters'),
      // Speech tab includes the "Target file prefix" row so the
      // prefix + force-prefix-only behaviour is consistent across
      // every tab that generates assets.
      buildFilePrefixRow(),
      el('div', { class: 'grid' }, [
        model.row, voice.row,
        speed.row, volume.row,
        pitch.row, format.row,
        sampleRate.row, bitrate.row,
        channels.row, language.row,
        subtitles.row, pronunciation.row,
        variants.row,
      ]),
    ]));

    const actions = el('div', { class: 'actions' });
    const genBtn = el('button', { class: 'primary' }, 'Generate');
    const batchControls = el('span', { 'data-batch-controls': 'speech', class: 'batch-controls' });
    actions.append(buildAddToBatchBtn('speech'), genBtn, batchControls);
    const preview = el('div', { class: 'preview' }, el('div', { class: 'empty' }, 'No audio generated yet.'));
    // Preview ABOVE the actions row so the Generate / +Add buttons
    // sit at the very bottom of the tab. See the image tab's
    // tabFooter comment for the rationale.
    const tabFooter = el('div', { class: 'tab-footer' }, [preview, actions]);
    root.appendChild(tabFooter);

    // Pass voice.input.el (the inner <select>); the wrapper would
    // no-op fillVoices' innerHTML/appendChild calls.
    this.populateVoices(voice.input.el || voice.input).catch(() => {});

    // Re-populate the voice dropdown when --model changes. Extracted
    // to a module-level helper to keep build() under the 500-line
    // lint limit.
    attachModelChangeVoiceRepopulate(this, model.input, voice.input);

    genBtn.addEventListener('click', async () => {
      // Breadcrumb the click BEFORE guards.
      if (typeof window.logAction === 'function') window.logAction('generate', 'click-generate', { tab: 'speech', has_api_key: !!state.config.hasApiKey });
      // Whole-handler try/catch so a pre-flight throw (e.g. missing
      // helper) surfaces instead of rejecting silently. Per-tab
      // re-entrancy guard via JobRunner + state.generating (see app.js).
      try {
      if ((window.JobRunner && window.JobRunner.isTabRunning('speech')) || state.generating === 'speech') {
        if (typeof window.logAction === 'function') window.logAction('generate', 'guard-blocked', { reason: 'already-running', tab: 'speech' });
        return;
      }
      if (!state.config.hasApiKey) {
        if (typeof window.logAction === 'function') window.logAction('generate', 'guard-blocked', { reason: 'no-api-key', tab: 'speech' });
        toast('No API key configured. Click ⚙ to open Settings.', 'err'); return;
      }
      // R7.2b (R7-Gate): block generation when the installed mmx CLI does not
      // advertise the `speech` subcommand. Permissive when capability data
      // isn't loaded, so a failed/absent probe never locks the UI.
      if (window.CapabilityGuard && !window.CapabilityGuard.isSubcommandAvailable('speech')) {
        if (typeof window.logAction === 'function') window.logAction('generate', 'guard-blocked', { reason: 'subcommand-unavailable', tab: 'speech' });
        toast('The installed mmx CLI does not support speech generation. Update it (npm install -g mmx-cli).', 'err', 8000); return;
      }
      const txt = text.input.value.trim();
      if (!txt) { toast('Text is required.', 'warn'); return; }
      // H9-010: speech used to send the RAW textarea text and never composed
      // the selected style preset into it (unlike image/music/video). The
      // status-bar counter showed the styled length, but the API got the
      // unstyled text — so an imported/selected style was silently dropped.
      // Compose via buildFinalPrompt (same helper the other tabs use) and
      // validate the COMPOSED string so a style can't push speech silently
      // over the 10 000-char limit.
      const composedText = (typeof buildFinalPrompt === 'function')
        ? buildFinalPrompt(styleRow.sel, text.input)
        : txt;
      // Pre-flight: validate visible parameters against MODEL_SPECS.
      // --emotion only exists on 2.6+ speech models; the row is
      // hidden in the form via isFlagVisibleForCurrentModel, but
      // a stale saved value could still be set when switching
      // models — it is stripped here so the API never
      // receives an unsupported flag.
      const speechParams = {
        // H9-010: validate the COMPOSED (style + text) string, not the raw
        // textarea, so a style can't push speech over the limit unnoticed.
        '--text': { getValue: () => composedText },
        '--model': model.input,
        '--voice': voice.input,
        '--speed': speed.input,
        '--volume': volume.input,
        '--pitch': pitch.input,
        '--format': format.input,
        '--sample-rate': sampleRate.input,
        '--bitrate': bitrate.input,
        '--channels': channels.input,
        '--language': language.input,
        '--subtitles': subtitles.input,
        '--pronunciation': pronunciation.input,
        // --emotion is part of the speech spec (model-2.6+ only,
        // hidden otherwise) but has no row on this tab. Pass it
        // through validateTabAgainstSpec as `null` so the pre-flight
        // sees it as unset and skips the visibility check.
        '--emotion': null,
      };
      const speechModel = model.input.getValue();
      for (const k of Object.keys(speechParams)) {
        if (!speechParams[k]) { delete speechParams[k]; continue; }
      }
      const preErrs = validateTabAgainstSpec('speech', speechParams, speechModel, null, isFlagVisibleForCurrentModel);
      if (preErrs.length) {
        for (const e of preErrs) toast(e, 'err', 6000);
        return;
      }
      // Authoritative allowed-value / range check (warns + lets the user
      // proceed) so an out-of-range value can't silently waste a request.
      if (typeof mmxPreflightConfirm === 'function' && !(await mmxPreflightConfirm('speech', {
        model: model.input.getValue(), format: format.input.getValue(),
        'sample-rate': sampleRate.input.getValue(), bitrate: bitrate.input.getValue(),
        channels: channels.input.getValue(), speed: speed.input.getValue(),
        volume: volume.input.getValue(), pitch: pitch.input.getValue(), text: composedText,
      }))) return;
      // Speech-specific gate: --bitrate only matters when the
      // output format is a lossy codec (mp3 / opus). The spec
      // table's perRowOverrides flags this so a useless --bitrate
      // send is suppressed when WAV / PCM / FLAC is selected,
      // otherwise the API may reject it or ignore it
      // silently.
      // `format` is `kind: 'enum'`, so `format.input` is the
      // `combo-select-enum` wrapper — `.value` is undefined. Use
      // .getValue() so the bitrate-suppression branch fires for
      // WAV/PCM/FLAC (otherwise --bitrate is sent for lossless
      // formats).
      const speechFormat = (format.input.getValue() || 'mp3').split('_')[0];
      // Gate --bitrate for lossless formats at the call site (not by
      // mutating the select). Captured at runFn start (UI is locked
      // during the run so the value can't change mid-loop).
      const lossyFormat = ['mp3', 'opus'].includes(speechFormat);
      const variantsCount = Math.max(1, Math.min(5, parseInt(variants.sel.value, 10) || 1));
      let outDir;
      try { outDir = await ensureSubDir('speech'); }
      catch (e) {
        const msg = (e && e.message) || String(e);
        toast('Cannot resolve output folder: ' + msg, 'err', 6000);
        return;
      }
      // R7.5 (S1 §6 R1.5b): mmx:run:job is grant-gated — capture the
      // directory-root output grant ensureSubDir just stashed in
      // state._fbGrantId (before any further await) and thread it into the
      // mmxRunJob call so the --out path is authorised.
      const mmxGrant = state._fbGrantId;
      const slug = slugify(txt).slice(0, 60) || 'speech';
      // `format.input` is the enum wrapper — use .getValue() so the
      // file extension matches the actual --format choice.
      const ext = (format.input.getValue() || 'mp3').split('_')[0];
      // Total assets this run will produce. The per-tab ETA timer reads
      // this from state.genQueueSize[tabKey] to compute a "remaining
      // time for the whole batch" estimate that ticks down as each
      // variant completes.
      if (!state.genQueueSize) state.genQueueSize = { image: 0, speech: 0, music: 0, video: 0 };
      if (!state.genQueueDone) state.genQueueDone = { image: 0, speech: 0, music: 0, video: 0 };
      state.genQueueSize.speech = variantsCount;
      state.genQueueDone.speech = 0;
      // Wrap the existing generation flow in JobRunner.run() so
      // ActiveJobsWidget shows it during the run and its inline ✕ can
      // cancel just this job. suppressLogRow:true keeps every existing
      // addLogEvent call below unchanged — JobRunner is purely a
      // tracking/cancellation layer here. `ctrl` is assigned by the
      // run() call itself; runFn only executes in a later microtask,
      // by which time the assignment has completed, so it can safely
      // read ctrl.jobId via closure.
      const txtShort0 = (txt || '').replace(/\s+/g, ' ').slice(0, 120);
      let ctrl;
      ctrl = window.JobRunner.run({
        tabKey: 'speech',
        type: 'speech',
        title: `Speech generation: ${txtShort0}${txt && txt.length > 120 ? '…' : ''}`,
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
      // Log the speech generation start so the structured log pane
      // shows the run (same pattern as the image tab — otherwise only
      // the raw mmx stderr stream is visible, making runs hard to
      // tell apart at a glance).
      const runGroupId = 'speech-' + Date.now();
      // Link the (suppressLogRow) job to this run's log group so the
      // ActiveJobsWidget row-click (LogService.scrollToJob) can find the run.
      try { const _lj = window.state && window.state.jobs && window.state.jobs.get(ctrl.jobId); if (_lj) _lj.logGroupId = runGroupId; } catch (_) { /* ignore */ }
      const txtShort = (txt || '').replace(/\s+/g, ' ').slice(0, 120);
      addLogEvent({
        category: 'gen',
        groupId: runGroupId,
        headline: `Speech generation started: ${txtShort}${txt && txt.length > 120 ? '…' : ''}`,
        fullText: txt,
        details: [
          `Variants: ${variantsCount}`,
          `Model: ${model.input.getValue() || '(default)'}`,
          `Voice: ${voice.input.getValue() || '(default)'}`,
          `Format: ${format.input.getValue() || '(default)'}`,
        ],
      });
      let allOk = true;
      let lastPreview = null;
      let lastOutFile = null;
      // Track every successful output file so a partial-success run
      // (some variants failed, some succeeded) routes through the
      // success path instead of the failure path.
      const outFiles = [];
      let threw = null;
      try {
        for (let v = 1; v <= variantsCount; v++) {
          if (cancel.wasCancelled()) break;
          const itemStart = Date.now();
          const args = ['speech', 'synthesize'];
          args.push('--text', composedText); // H9-010: send composed (style + text)
          appendFlag(args, model.input);
          appendFlag(args, voice.input);
          appendFlag(args, speed.input);
          appendFlag(args, volume.input);
          appendFlag(args, pitch.input);
          appendFlag(args, format.input);
          appendFlag(args, sampleRate.input);
          // Only append --bitrate for lossy codecs. WAV / PCM / FLAC
          // have fixed bitrates; sending --bitrate is either ignored
          // or rejected. Gate at the call site instead of by mutating
          // the select's value (which would leak state and drop the
          // chosen bitrate after a single format switch).
          if (lossyFormat) appendFlag(args, bitrate.input);
          appendFlag(args, channels.input);
          if (language.input.getValue()) args.push('--language', String(language.input.getValue()));
          appendBoolFlag(args, subtitles.input, '--subtitles');
          if (pronunciation.input.value && pronunciation.input.value.trim()) {
            for (const rule of pronunciation.input.value.split(',').map(s => s.trim()).filter(Boolean)) {
              args.push('--pronunciation', rule);
            }
          }
          const ts = timestamp();
          const variantTag = variantsCount > 1 ? `_v${v}` : '';
          const prefix = (state.filePrefix || '').trim();
          // "force prefix only" mode overrides the slug+timestamp
          // naming scheme with `<prefix><6-digit counter>.<ext>`,
          // counter starting at 000001 per Generate click.
          const outFile = state.filePrefixForceOnly
            ? await nextFreeForcePrefixPath(outDir, forceCounter, prefix, ext)
            : uniquePath(outDir, `${prefix}${ts}_${slug}${variantTag}.${ext}`);
          args.push('--out', outFile);
          // H3-B9: log the command to the structured log (replaces .lastcmd).
          const maskedCmd = maskLine(`mmx ${args.join(' ')}`);
          if (ctx && ctx.onSecondary) ctx.onSecondary(maskedCmd);
          const statusMsg = variantsCount > 1
            ? `Generating speech… variant ${v}/${variantsCount}`
            : 'Generating speech…';
          setStatus(statusMsg, true);
          preview.innerHTML = `<div class="empty"><span class="spinner"></span> ${escapeHtml(statusMsg)}</div>`;
          const r = await window.api.mmxRunJob({ args, jobId: ctrl.jobId }, mmxGrant);
          if (cancel.wasCancelled()) { allOk = false; break; }
          if (!r.ok) {
            const msg = formatMmxError(r);
            preview.innerHTML = `<div class="empty">Generation failed (variant ${v}/${variantsCount}).</div><div class="meta">${escapeHtml(msg)}</div>`;
            toast('Speech generation failed: ' + msg, 'err', 6000);
            allOk = false;
            // Continue with remaining variants instead of breaking
            // (image tab already does this).
            continue;
          }
          // Update the per-item average + advance the queue counter so
          // the ETA ticks down per item. See the image-tab comment
          // for the full rationale.
          const itemDur = (Date.now() - itemStart) / 1000;
          if (!state.genAvgSec) state.genAvgSec = {};
          const prevAvg = state.genAvgSec.speech || 0;
          state.genAvgSec.speech = prevAvg === 0 ? itemDur : (prevAvg * 0.6 + itemDur * 0.4);
          state.genQueueDone.speech = (state.genQueueDone.speech || 0) + 1;
          refreshTabEtas();
          lastPreview = r.parsed;
          lastOutFile = outFile;
          outFiles.push(outFile);
        }
      } catch (e) {
        threw = e;
        allOk = false;
        console.error('Speech generation threw:', e);
        toast('Generation error: ' + (e && e.message || String(e)), 'err', 6000);
      } finally {
        // Record outcome BEFORE cleanup() clears state.generating (BatchGen polls it).
        state.genLastResult = state.genLastResult || { image: null, speech: null, music: null, video: null };
        // Partial-success gate — a cancel after partial success still
        // leaves real files on disk, so mark 'ok'.
        state.genLastResult.speech = (outFiles.length > 0 && !threw) ? 'ok' : 'err';
        cancel.cleanup();
        setStatus('Ready', false);
        // R5: the per-variant spinner is only replaced on the FAILURE path; success / cancel / throw left it spinning — swap it for the terminal state.
        if (preview.querySelector('.spinner')) preview.innerHTML = `<div class="empty">${threw ? 'Generation failed.' : (cancel.wasCancelled() ? 'Generation cancelled.' : 'Audio generated — see Assets preview.')}</div>`;
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
        // Return EVERY successful file on cancel; status 'ok' when
        // partial success so BatchGen does not retry the variants
        // that already landed.
        return { status: outFiles.length > 0 ? 'ok' : 'cancel', outputPaths: outFiles };
      }
      if (allOk && lastOutFile) {
        // F5: route audio to Assets preview pane + status bar.
        notifyAudioGenerated(lastOutFile);
        bumpGenerationCounter('speech', variantsCount);
        setStatus('✅ Audio generated — see Assets preview', false);
        addLogEvent({
          category: 'gen', groupId: runGroupId, result: 'ok',
          headline: `Generated ${variantsCount} audio file${variantsCount === 1 ? '' : 's'}`,
          details: [`• ${lastOutFile}`],
        });
      } else if (outFiles.length > 0 && lastOutFile) {
        // Partial-success path.
        notifyAudioGenerated(lastOutFile);
        bumpGenerationCounter('speech', outFiles.length);
        setStatus(`✅ ${outFiles.length}/${variantsCount} audio generated — see Assets preview`, false);
        addLogEvent({
          category: 'gen', groupId: runGroupId, result: 'warn',
          headline: `Generated ${outFiles.length}/${variantsCount} audio file${outFiles.length === 1 ? '' : 's'} (${variantsCount - outFiles.length} failed)`,
          details: outFiles.map((p) => '• ' + p),
        });
      }
      // A run with ANY successful variant returns 'ok'.
      if (outFiles.length > 0) {
        const failCount = variantsCount - outFiles.length;
        toast(failCount > 0
          ? `Speech generated. ${outFiles.length}/${variantsCount} variants saved (${failCount} failed — see log).`
          : (variantsCount > 1 ? `Speech generated. ${variantsCount} variants saved.` : 'Speech generated.'),
          failCount > 0 ? 'warn' : 'ok');
        // H9-018: run per-row audio trim if the BatchGen runner set the flags.
        // R6.3: outputs is 1:1 with inputs — carry the post-processed list out
        // as the job's outputPaths so the job history / BatchGen reflect the
        // trimmed deliverables, not the raw generation (mirrors imageTab's
        // finalOutputPaths; without this the _trim files were orphaned).
        let finalOutFiles = outFiles;
        if (state._batchRowPostprocess && window.BatchPostprocess) {
          try {
            const pp = await window.BatchPostprocess.runRowPostprocess(outFiles, state._batchRowPostprocess);
            if (pp.outputs && pp.outputs.length) finalOutFiles = pp.outputs.slice();
            if (pp.applied.length) toast('Post-processed: ' + pp.applied.join(', '), 'ok', 4000);
            if (pp.errors.length) {
              toast('Post-process: ' + pp.errors.join('; '), 'warn', 6000);
              // H-056: record the failed requested ops so the BatchGen runner
              // (DOM-fallback path) reports this item as PARTIAL, not full success.
              state.genLastPostprocessErrors = state.genLastPostprocessErrors || {};
              state.genLastPostprocessErrors.speech = pp.errors.slice();
            }
          } catch (e) {
            console.error('Speech batch postprocess failed', e);
            // H-056: a throwing postprocess runner is also a failed requested step.
            state.genLastPostprocessErrors = state.genLastPostprocessErrors || {};
            state.genLastPostprocessErrors.speech = ['postprocess runner threw: ' + (e && e.message || e)];
          }
        }
        return { status: 'ok', outputPaths: finalOutFiles };
      }
      setStatusError('Generation failed (see log for details)', [{ label: 'Retry', onClick: () => genBtn.click() }, { label: 'Diagnose', onClick: () => { try { showDiagnose(); } catch (_) {} } }]);
      return { status: 'err', outputPaths: [] };
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
      } catch (e) {
        // Surface pre-flight errors as a visible toast instead of a silent async-reject.
        console.error('Speech generation pre-flight failed:', e);
        toast('Generation failed before starting: ' + (e && e.message || String(e)), 'err', 6000);
      }
    });
  },
  async populateVoices(sel) {
    // populateVoices + fillVoices live in speechTabVoices.js
    // (500-line HARD limit). Fallback below covers the case where
    // the helper script didn't load.
    if (window.speechVoices && typeof window.speechVoices.populateVoices === 'function') {
      return window.speechVoices.populateVoices(sel, state);
    }
    const v = await window.api.voices();
    if (Array.isArray(v) && v.length) {
      state.voices = v;
      state.voicesLoaded = true;
      const selInner = sel.querySelector('select') || sel;
      selInner.innerHTML = '';
      for (const voice of v) selInner.appendChild(el('option', { value: voice }, voice));
    }
  },
};
window.SpeechTab = window.TABS.speech;
