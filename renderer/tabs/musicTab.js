// renderer/tabs/musicTab.js
// ----------------- MUSIC TAB -----------------
window.TABS = window.TABS || {};
window.TABS.music = {
  prefilled: 'calm piano melody, 15 seconds',
  build() {
    const root = $('#tab-music');
    root.innerHTML = '';
      // The menu is appended before measuring it for viewport clamping.
    const prompt = buildParamRow('Music prompt (prefilled, editable)',
      { kind: 'textarea', value: this.prefilled, help: 'Describe the music: genre, mood, instruments, tempo, length (e.g. "30 seconds", "2 minutes"). The most up-to-date model (music-2.6) supports up to about 6 minutes. Max 2 000 characters.' });
    const styleRow = buildStyleRow('music', 'Select a style preset. Its value is prepended (with a comma) to your music prompt before the request is sent. Use it for repeated genre/mood tags.');
    // buildStylePreviewBlock() is intentionally NOT mounted here. The
    // helper stays exported so other callers don't break. The
    // extra-prefix state (set by the "Instrumental" toggle below) is
    // still applied to the character counter via the same
    // getExtraPrefix callback as before.
    let extraPrefix = () => '';
    // Character counter for the --prompt argument value.
    // extraPrefix is a `let` that gets REASSIGNED below (after `mode`
    // and `instrumental` are defined). Passing it directly would freeze the
    // counter to the initial empty function. Wrap it so the counter always
    // reads the current extraPrefix value.
    const counter = buildPromptCounter({
      selEl: styleRow.sel,
      manualEl: prompt.input,
      getExtraPrefix: () => extraPrefix(),
      id: 'music',
    });
    // Placeholder for the mode listener, attached after `mode` is built below.
    const variants = buildVariantsRow({ id: 'variants-music' });
    root.appendChild(el('div', { class: 'section' }, [
      el('h3', {}, 'Prompt'),
      styleRow.row,
      prompt.row,
      counter.wrap,
    ]));

    counter.update();
    const model = buildParamRow('--model', {
      kind: 'enum', default: 'music-2.6',
      options: [
        { value: 'music-2.6', label: 'music-2.6 (newest — cover, instrumental, lyrics-optimizer, default)' },
        { value: 'music-2.5+', label: 'music-2.5+ (instrumental unlocked, richer arrangements)' },
        { value: 'music-2.5', label: 'music-2.5 (paragraph-level precision, 14+ structure tags)' },
      ],
      help: 'Music generation model.\n\nmusic-2.6 (default): Newest. Supports --lyrics-optimizer, --instrumental,\n  --lyrics, --cover. Best for full-length songs with vocals.\n\nmusic-2.5+: Instrumental mode unlocked natively, richer multi-instrument\n  arrangements. Use when music-2.6 instrumental sounds too thin.\n\nmusic-2.5: 14+ structure tags with paragraph-level precision. Good\n  when you need fine-grained control over song structure.\n\nmusic-2.0: Legacy. May not support --lyrics or --instrumental.',
    });
    const genre = buildParamRow('--genre', {
      kind: 'enum-text', default: '',
      options: [
        { value: '', label: '(any)' },
        { value: 'pop', label: 'pop' },
        { value: 'rock', label: 'rock' },
        { value: 'jazz', label: 'jazz' },
        { value: 'classical', label: 'classical' },
        { value: 'hip-hop', label: 'hip-hop' },
        { value: 'electronic', label: 'electronic' },
        { value: 'folk', label: 'folk' },
        { value: 'cinematic', label: 'cinematic' },
        { value: 'lo-fi', label: 'lo-fi' },
        { value: 'ambient', label: 'ambient' },
        { value: 'country', label: 'country' },
        { value: 'r&b', label: 'r&b' },
        { value: 'metal', label: 'metal' },
        { value: 'indie', label: 'indie' },
      ],
      help: 'Music genre tag — the overall style of the track. The dropdown lists the genres the model handles best; pick "Custom…" to type your own (e.g. "drum and bass", "shoegaze", "K-pop").\n\nBest practices:\n  • Pick the closest genre; the model cross-pollinates adjacent genres naturally.\n  • Combine with the --mood dropdown for finer control (e.g. "jazz" + "melancholic" → sad jazz).\n  • Genre affects instrumentation AND arrangement — "techno" gets synthesizers + steady beat, "folk" gets acoustic guitar + strummed rhythm.',
    });
    const mood = buildParamRow('--mood', {
      kind: 'enum-text', default: '',
      options: [
        { value: '', label: '(any)' },
        { value: 'happy', label: 'happy' },
        { value: 'sad', label: 'sad' },
        { value: 'energetic', label: 'energetic' },
        { value: 'calm', label: 'calm' },
        { value: 'melancholic', label: 'melancholic' },
        { value: 'aggressive', label: 'aggressive' },
        { value: 'romantic', label: 'romantic' },
        { value: 'dark', label: 'dark' },
        { value: 'uplifting', label: 'uplifting' },
        { value: 'dreamy', label: 'dreamy' },
      ],
      help: 'Mood or emotion of the track — the FEELING the listener should get, independent of the genre.\n\n"happy" + "energetic" is upbeat dance music; "happy" + "calm" is light acoustic. Genre tells the model what instruments + structure to use; mood tells it what chord progressions + tempo feel to use. Combine for precision.',
    });
    const vocals = buildParamRow('--vocals', {
      kind: 'enum-text', default: '',
      options: [
        { value: '', label: '(any)' },
        { value: 'warm male baritone', label: 'warm male baritone' },
        { value: 'bright female soprano', label: 'bright female soprano' },
        { value: 'duet with harmonies', label: 'duet with harmonies' },
        { value: 'choir', label: 'choir' },
      ],
      help: 'Vocal style descriptor — only relevant if the track has vocals.\n\nThe dropdown gives quick picks (baritone, soprano, choir, …). Pick "Custom…" to type any voice description (e.g. "raspy male alto", "ethereal female with reverb"). The model matches voice characteristics (range, timbre) to the genre + mood.',
    });
    const instruments = buildParamRow('--instruments', {
      kind: 'enum-text', default: '',
      options: [
        { value: '', label: '(any)' },
        { value: 'piano', label: 'piano' },
        { value: 'acoustic guitar', label: 'acoustic guitar' },
        { value: 'electric guitar', label: 'electric guitar' },
        { value: 'drums', label: 'drums' },
        { value: 'strings', label: 'strings' },
        { value: 'synth', label: 'synth' },
        { value: 'orchestral', label: 'orchestral' },
      ],
      help: 'Featured instruments — the "sound palette" of the track. The model picks supporting instruments to match, so picking just "piano" gets a piano-led track with light strings + bass, while picking "orchestral" gets a full 30-piece ensemble.\n\nFor most use cases the dropdown is enough; pick "Custom…" to type any combination ("ukulele, glockenspiel, marching snare").',
    });
    const bpm = buildParamRow('--bpm', {
      kind: 'number', default: '', min: 40, max: 220, step: 1,
      options: [
        { value: '', label: '(unset)' },
        { value: 60, label: '60' }, { value: 80, label: '80' }, { value: 90, label: '90' },
        { value: 100, label: '100' }, { value: 110, label: '110' }, { value: 120, label: '120' },
        { value: 128, label: '128' }, { value: 140, label: '140' }, { value: 160, label: '160' },
      ],
      help: 'Exact tempo in beats per minute.\n\n  • 60-80 BPM — slow (ballads, ambient).\n  • 90-110 BPM — medium (most pop, hip-hop, R&B).\n  • 120-128 BPM — dance / house / disco standard.\n  • 140-160 BPM — drum & bass, punk, fast EDM.\n  • 180+ BPM — speedcore / metal.\n\nLeave "(unset)" to let the model pick based on the genre + mood. The dropdown is curated; pick "Custom…" (type a number) for any value 40-220 BPM.',
    });
    const key = buildParamRow('--key', {
      kind: 'enum-text', default: '',
      options: [
        { value: '', label: '(any)' },
        { value: 'C major', label: 'C major' },
        { value: 'C minor', label: 'C minor' },
        { value: 'D major', label: 'D major' },
        { value: 'D minor', label: 'D minor' },
        { value: 'E major', label: 'E major' },
        { value: 'E minor', label: 'E minor' },
        { value: 'F major', label: 'F major' },
        { value: 'F minor', label: 'F minor' },
        { value: 'G major', label: 'G major' },
        { value: 'G minor', label: 'G minor' },
        { value: 'A major', label: 'A major' },
        { value: 'A minor', label: 'A minor' },
        { value: 'B major', label: 'B major' },
      ],
      help: 'Musical key — the root note + scale the track is written in.\n\nMajor keys (C major, D major, …) sound bright / happy. Minor keys (C minor, D minor, …) sound sad / introspective. Leave "(any)" to let the model pick. Combine with --mood for precision (e.g. "happy" + "D minor" can produce a bittersweet major-vibe track in D minor).',
    });
    const tempo = buildParamRow('--tempo', {
      kind: 'enum-text', default: '',
      options: [
        { value: '', label: '(any)' },
        { value: 'slow', label: 'slow' },
        { value: 'moderate', label: 'moderate' },
        { value: 'fast', label: 'fast' },
      ],
      help: 'Coarse tempo hint — alternative to the exact --bpm value above.\n\n  • "slow" = ballads, ambient, slow jams (~60-80 BPM).\n  • "moderate" = most pop, R&B, rock (~90-120 BPM).\n  • "fast" = punk, EDM, drum & bass (~130+ BPM).\n\nIf you set both --bpm AND --tempo, --bpm wins. Use --bpm for exact control, --tempo when you just want "fast" without thinking about numbers.',
    });
    const structure = buildParamRow('--structure', {
      kind: 'enum-text', default: '',
      options: [
        { value: '', label: '(any)' },
        { value: 'verse-chorus-verse-chorus', label: 'verse-chorus-verse-chorus' },
        { value: 'verse-chorus-bridge-chorus', label: 'verse-chorus-bridge-chorus' },
        { value: 'intro-verse-chorus', label: 'intro-verse-chorus' },
      ],
      help: 'Song structure — the high-level arrangement of sections.\n\nThe dropdown covers the most common pop structures; pick "Custom…" to type any (e.g. "intro-verse-prechorus-chorus-verse-chorus-bridge-chorus-outro"). For instrumental tracks structure mainly affects dynamic build-ups and drops; for vocal tracks it determines where the lyrics go.',
    });
    const references = buildParamRow('--references', {
      kind: 'text', default: '',
      help: 'Reference tracks or artists the model should aim for. Free-form text — comma-separated, no quotes needed.\n\nExamples:\n  • "similar to Ed Sheeran, Jason Mraz" — same vibe / genre / vocal style.\n  • "in the style of 80s synthwave" — era-specific reference.\n  • "Bohemian Rhapsody-like, dramatic structure" — single-song reference with structural hint.\n\nThe model uses these as STYLE references only — it does not copy melodies or lyrics (output is always original).',
    });
    const avoid = buildParamRow('--avoid', {
      kind: 'text', default: '',
      help: 'Elements to keep OUT of the generated music. The model steers AWAY from these.\n\nExamples:\n  • "no brass, no saxophone"\n  • "no heavy drums, no screaming vocals"\n  • "avoid EDM drops, no trap hi-hats"\n\nUseful when the random-seed generation keeps producing something you don\'t like. Combine with --references to nail down the style: "similar to Norah Jones" + "avoid electric guitar" = clean piano-vocal track.',
    });
    const useCase = buildParamRow('--use-case', {
      kind: 'enum-text', default: '',
      options: [
        { value: '', label: '(any)' },
        { value: 'background music for video', label: 'background music for video' },
        { value: 'theme song', label: 'theme song' },
        { value: 'jingle', label: 'jingle' },
        { value: 'podcast intro', label: 'podcast intro' },
      ],
      help: 'Use-case context — helps the model pick the right structure + length + energy level.\n\n  • "background music for video" — understated, repeats cleanly, doesn\'t fight narration.\n  • "theme song" — distinctive hook, builds energy.\n  • "jingle" — short (10-15s), catchy, memorable.\n  • "podcast intro" — sets the tone, usually 5-10s.\n\nFor YouTube / podcast use, "background music" gives the cleanest result.',
    });
    const extra = buildParamRow('--extra', {
      kind: 'text', default: '',
      help: 'Additional fine-grained requirements not covered by the other fields. Appended to the prompt verbatim.\n\nExamples:\n  • "tempo shifts from 90 to 130 BPM in the second half"\n  • "ends with a fade-out over 5 seconds"\n  • "no reverb on vocals, heavy reverb on drums"\n\nUse this for one-off tweaks. For things covered by a dedicated dropdown above, prefer that dropdown (it\'s whitelisted and won\'t be rejected by the API).',
    });
    const audioFormat = buildParamRow('--format', {
      kind: 'enum', default: 'mp3',
      options: [
        { value: 'mp3', label: 'mp3 (default)' },
        { value: 'wav', label: 'wav' },
        { value: 'pcm', label: 'pcm' },
      ],
      help: 'Output audio file container / codec.\n\n  • mp3 (default) — most compatible, smallest lossy file.\n  • wav — uncompressed, largest file, no quality loss. Best for further editing.\n  • pcm — raw PCM (no header). Most players can\'t open it directly.\n\nMusic APIs don\'t accept FLAC or Opus; pick WAV if you want lossless.',
    });
    const sampleRate = buildParamRow('--sample-rate', {
      // Allowed by the music API: 16000/24000/32000/44100. 22050 and 48000
      // (previously offered) are rejected with "sample rate ... not allowed".
      kind: 'number', default: 44100, step: 1000,
      options: [16000, 24000, 32000, 44100].map((v) => ({ value: v, label: String(v) })),
      help: 'Audio sample rate in Hz.\n\n  • 16000 — telephone quality (muffled, small file).\n  • 24000 — AM-radio quality.\n  • 32000 — good for most music.\n  • 44100 (default) — CD quality. The full frequency range of human hearing.\n\nThe music API rejects 22050 and 48000 with an error — pick from the four listed values.',
    });
    const bitrate = buildParamRow('--bitrate', {
      kind: 'number', default: 128000, step: 1000,
      // The MiniMax music API only accepts these four bitrates. Any
      // other value returns "audio bitrate: N is not allowed" and no
      // music is generated. Restrict the dropdown to the allowed set
      // and default to 128000.
      options: [32000, 64000, 128000, 256000].map((v) => ({ value: v, label: String(v) })),
      help: 'Bitrate in bits per second — only meaningful for lossy formats (mp3).\n\n  • 32000 — low (smallest file, slight quality loss on complex music).\n  • 64000 — medium (good for most music).\n  • 128000 (default) — high (transparent for most listeners).\n  • 256000 — maximum (overkill for most music).\n\nThe API rejects any value outside this set with "audio bitrate: N is not allowed". For WAV / PCM the value is ignored.',
    });
    const watermark = buildParamRow('--aigc-watermark', {
      kind: 'boolean', default: true,
      help: 'Embed an invisible AI-generated content watermark in the audio metadata.\n\nNo audible change, no file size change. Used by content moderation systems to identify AI-generated audio. Recommended ON for public-facing content (compliance with EU AI Act, China deep-synthesis rules, etc.). OFF for personal / private use.',
    });
    const outputFormat = buildParamRow('--output-format', {
      kind: 'enum', default: 'hex',
      options: [
        { value: 'hex', label: 'hex (default, saved to file)' },
        { value: 'url', label: 'url (24h expiry — download promptly)' },
      ],
      help: 'How the audio bytes come back from the API.\n\n  • hex (default) — the API returns the audio bytes inline (hex-encoded in the JSON). The tool decodes them and writes the file directly. Recommended; no expiry.\n  • url — the API uploads the audio to a temporary CDN and returns a URL. The tool downloads it. Faster initial response, but the URL EXPIRES after 24 hours — download promptly.',
    });
    // R7.4: lyrics / instrumental / lyrics-optimizer controls.
    const lyrics = buildParamRow('--lyrics', {
      kind: 'textarea', default: '', maxLength: 3500, max: 3500,
      help: 'Custom song lyrics (max 3500 chars). Provide your own lyrics text. Cannot be combined with --instrumental or --lyrics-optimizer.',
    });
    const instrumental = buildParamRow('--instrumental', {
      kind: 'boolean', default: false,
      help: 'Generate an instrumental track (no vocals). Supported on music-2.5 / 2.5+ / 2.6. Cannot be combined with --lyrics or --lyrics-optimizer.',
    });
    const lyricsOptimizer = buildParamRow('--lyrics-optimizer', {
      kind: 'boolean', default: false,
      help: 'Auto-generate optimized lyrics from the prompt (music-2.6 only). Cannot be combined with --lyrics or --instrumental.',
    });
    // R7.4: disable unsupported controls on model change.
    const musicModelRows = { '--instrumental': instrumental, '--lyrics-optimizer': lyricsOptimizer };
    (model.el || model.input).addEventListener('change', () => {
      if (window.MusicOptions) window.MusicOptions.syncRowDisable(model.input.getValue(), musicModelRows);
    });
    if (window.MusicOptions) window.MusicOptions.syncRowDisable(model.input.getValue(), musicModelRows);

    root.appendChild(el('div', { class: 'section' }, [
      el('h3', {}, 'Parameters'),
      buildFilePrefixRow(),
      el('div', { class: 'grid' }, [
        model.row,
        genre.row, mood.row,
        vocals.row, instruments.row,
        bpm.row, key.row,
        tempo.row, structure.row,
        references.row, avoid.row,
        useCase.row, extra.row,
        audioFormat.row, sampleRate.row,
        bitrate.row, watermark.row,
        outputFormat.row, variants.row,
        lyrics.row, instrumental.row, lyricsOptimizer.row,
      ]),
    ]));

    const actions = el('div', { class: 'actions' });
    const genBtn = el('button', { class: 'primary' }, 'Generate');
    const batchControls = el('span', { 'data-batch-controls': 'music', class: 'batch-controls' });
    actions.append(buildAddToBatchBtn('music'), genBtn, batchControls);
    const preview = el('div', { class: 'preview' }, el('div', { class: 'empty' }, 'No audio generated yet.'));
    // Preview ABOVE the actions row so the Generate / +Add buttons
    // sit at the very bottom of the tab. See the image tab's
    // tabFooter comment for the rationale.
    const tabFooter = el('div', { class: 'tab-footer' }, [preview, actions]);
    root.appendChild(tabFooter);

    genBtn.addEventListener('click', async () => {
      // Breadcrumb the click BEFORE guards.
      if (typeof window.logAction === 'function') {
        window.logAction('generate', 'click-generate', { tab: 'music', has_api_key: !!state.config.hasApiKey });
      }
      // Wrap the WHOLE click handler in a try/catch so an unexpected
      // throw during pre-flight (e.g. a missing helper or undefined
      // state key) surfaces as a toast instead of silently rejecting
      // the async handler. The button is reset by the re-entrancy
      // guard because state.generating is never set on a pre-flight
      // failure.
      try {
      // Re-entrancy guard: another generation is in progress.
      // Per-tab gate so a job on a different tab does NOT block music.
      // window.JobRunner always exists but never has jobs in
      // production, so the check is a single condition:
      // JobRunner.isTabRunning (when populated) OR
      // state.generating === 'music' (the legacy guard, set/cleared
      // by armGenBtnWithCancel in app.js). Comparing to 'music' (not
      // just truthiness) keeps the per-tab gate intact — a job on
      // image/speech/video must NOT block music.
      if ((window.JobRunner && window.JobRunner.isTabRunning('music')) || state.generating === 'music') {
        if (typeof window.logAction === 'function') {
          window.logAction('generate', 'guard-blocked', { reason: 'already-running', tab: 'music' });
        }
        return;
      }
      if (!state.config.hasApiKey) {
        if (typeof window.logAction === 'function') {
          window.logAction('generate', 'guard-blocked', { reason: 'no-api-key', tab: 'music' });
        }
        toast('No API key configured. Click ⚙ to open Settings.', 'err'); return;
      }
      // R7.2b (R7-Gate): block generation when the installed mmx CLI does not
      // advertise the `music` subcommand. Permissive when capability data isn't
      // loaded, so a failed/absent probe never locks the UI.
      if (window.CapabilityGuard && !window.CapabilityGuard.isSubcommandAvailable('music')) {
        if (typeof window.logAction === 'function') {
          window.logAction('generate', 'guard-blocked', { reason: 'subcommand-unavailable', tab: 'music' });
        }
        toast('The installed mmx CLI does not support music generation. Update it (npm install -g mmx-cli).', 'err', 8000); return;
      }
      const promptText = buildFinalPrompt(styleRow.sel, prompt.input, extraPrefix());
      if (!promptText) {
        if (typeof window.logAction === 'function') {
          window.logAction('generate', 'guard-blocked', { reason: 'no-prompt', tab: 'music' });
        }
        toast('Prompt is required (style or manual input).', 'warn'); return;
      }
      const musicModel = model.input.getValue();
      const musicParams = {
        '--model': model.input,
        '--prompt': prompt.input,
        '--sample-rate': sampleRate.input,
        // The variable is `bitrate` (declared by the
        // buildParamRow('--bitrate', ...) call a few lines above).
        '--bitrate': bitrate.input,
        '--format': audioFormat.input,
      };
      const preErrs = validateTabAgainstSpec('music', musicParams, musicModel, null, isFlagVisibleForCurrentModel);
      if (preErrs.length) {
        for (const e of preErrs) toast(e, 'err', 6000);
        return;
      }
      // Authoritative allowed-value / combination check (warn + proceed).
      if (typeof mmxPreflightConfirm === 'function') {
        if (!(await mmxPreflightConfirm('music', {
          model: musicModel, format: audioFormat.input.getValue(),
          'sample-rate': sampleRate.input.getValue(), bitrate: bitrate.input.getValue(),
          'output-format': outputFormat.input.getValue(), prompt: promptText,
          instrumental: instrumental.input.getValue(),
          'lyrics-optimizer': lyricsOptimizer.input.getValue(),
          lyrics: lyrics.input.value || '',
        }))) return;
      }
      // music-2.0 doesn't have --sample-rate 8000 in its accepted
      // set, so that is already validated. For safety: if music-2.0
      // is picked with an 8000Hz sample rate, the API
      // returns the closest supported rate. It is not blocked.
      // Lyrics length: 3500 chars max for music-2.6; shorter for
      // older models. The spec table's lyrics.max covers all
      // models in one number (3500).

      const variantsCount = Math.max(1, Math.min(5, parseInt(variants.sel.value, 10) || 1));
      let outDir;
      try { outDir = await ensureSubDir('music'); }
      catch (e) {
        const msg = (e && e.message) || String(e);
        toast('Cannot resolve output folder: ' + msg, 'err', 6000);
        return;
      }
      // R7.5 (S1 §6 R1.5b): mmx:run:job is grant-gated — capture the output
      // grant ensureSubDir stashed in state._fbGrantId and thread it into the
      // mmxRunJob call so the --out path is authorised.
      const mmxGrant = state._fbGrantId;
      const slug = slugify(promptText).slice(0, 60) || 'music';
      const ext = (audioFormat.input.getValue() || 'mp3');
      // Total assets this run will produce. The per-tab ETA timer reads
      // this from state.genQueueSize[tabKey] to compute a "remaining
      // time for the whole batch" estimate that ticks down as each
      // variant completes.
      if (!state.genQueueSize) state.genQueueSize = { image: 0, speech: 0, music: 0, video: 0 };
      if (!state.genQueueDone) state.genQueueDone = { image: 0, speech: 0, music: 0, video: 0 };
      state.genQueueSize.music = variantsCount;
      state.genQueueDone.music = 0;
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
        tabKey: 'music',
        type: 'music',
        title: `Music generation: ${pShort0}${promptText && promptText.length > 120 ? '…' : ''}`,
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
      // Log the music generation start so the structured log pane
      // shows the run (otherwise only the raw mmx stderr stream is
      // visible, making it hard to tell runs apart at a glance).
      const runGroupId = 'music-' + Date.now();
      // Link the (suppressLogRow) job to this run's log group so the
      // ActiveJobsWidget row-click (LogService.scrollToJob) can find the run.
      try { const _lj = window.state && window.state.jobs && window.state.jobs.get(ctrl.jobId); if (_lj) _lj.logGroupId = runGroupId; } catch (_) { /* ignore */ }
      const pShort = (promptText || '').replace(/\s+/g, ' ').slice(0, 120);
      addLogEvent({
        category: 'gen',
        groupId: runGroupId,
        headline: `Music generation started: ${pShort}${promptText && promptText.length > 120 ? '…' : ''}`,
        fullText: promptText,
        details: [
          `Variants: ${variantsCount}`,
          `Model: ${model.input.getValue() || '(default)'}`,
          `Format: ${audioFormat.input.getValue() || '(default)'}`,
        ],
      });
      let allOk = true;
      let lastPreview = null;
      let lastOutFile = null;
      // Track every successful output file so a partial-success run
      // routes through the success path instead of the failure path
      // (mirrors imageTab + speechTab).
      const outFiles = [];
      let threw = null;
      try {
        for (let v = 1; v <= variantsCount; v++) {
          if (cancel.wasCancelled()) break;
          const itemStart = Date.now();
          const args = ['music', 'generate'];
          args.push('--prompt', promptText);

          appendFlag(args, model.input);
          appendFlag(args, genre.input);
          appendFlag(args, mood.input);
          appendFlag(args, vocals.input);
          appendFlag(args, instruments.input);
          if (bpm.input.getValue() !== '') args.push('--bpm', String(bpm.input.getValue()));
          appendFlag(args, key.input);
          appendFlag(args, tempo.input);
          appendFlag(args, structure.input);
          if (references.input.value.trim()) args.push('--references', references.input.value.trim());
          if (avoid.input.value.trim()) args.push('--avoid', avoid.input.value.trim());
          appendFlag(args, useCase.input);
          if (extra.input.value.trim()) args.push('--extra', extra.input.value.trim());
          appendFlag(args, audioFormat.input);
          appendFlag(args, sampleRate.input);
          // Gate --bitrate for lossless formats (wav / pcm): sending
          // it is either silently ignored or rejected by the API. Gate
          // at the call site (not by mutating the select's value) so
          // the chosen value survives a round trip when switching
          // back to mp3.
          {
            const fmt = (audioFormat.input.getValue() || 'mp3').split('_')[0];
            if (['mp3'].includes(fmt)) appendFlag(args, bitrate.input);
          }
          appendBoolFlag(args, watermark.input, '--aigc-watermark');
          if (outputFormat.input.getValue() && outputFormat.input.getValue() !== 'hex') {
            args.push('--output-format', outputFormat.input.getValue());
          }
          // R7.4: emit lyrics / instrumental / lyrics-optimizer.
          if (lyrics.input.value.trim()) args.push('--lyrics', lyrics.input.value.trim());
          appendBoolFlag(args, instrumental.input, '--instrumental');
          appendBoolFlag(args, lyricsOptimizer.input, '--lyrics-optimizer');
          // Unique output file per variant
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
            ? `Generating music… variant ${v}/${variantsCount} (may take 30s–2min each)`
            : 'Generating music… (may take 30s–2min)';
          setStatus(statusMsg, true);
          preview.innerHTML = `<div class="empty"><span class="spinner"></span> ${escapeHtml(statusMsg)}</div>`;
          const r = await window.api.mmxRunJob({ args, jobId: ctrl.jobId }, mmxGrant);
          if (cancel.wasCancelled()) { allOk = false; break; }
          if (!r.ok) {
            const msg = formatMmxError(r);
            preview.innerHTML = `<div class="empty">Generation failed (variant ${v}/${variantsCount}).</div><div class="meta">${escapeHtml(msg)}</div>`;
            toast(`Music generation failed: ${msg}`, 'err', 6000);
            allOk = false;
            // Continue with remaining variants instead of aborting
            // (mirrors imageTab + speechTab).
            continue;
          }
          // Update the per-item average + advance the queue counter so
          // the ETA ticks down per item. See the image-tab comment
          // for the full rationale.
          const itemDur = (Date.now() - itemStart) / 1000;
          if (!state.genAvgSec) state.genAvgSec = {};
          const prevAvg = state.genAvgSec.music || 0;
          state.genAvgSec.music = prevAvg === 0 ? itemDur : (prevAvg * 0.6 + itemDur * 0.4);
          state.genQueueDone.music = (state.genQueueDone.music || 0) + 1;
          refreshTabEtas();
          lastPreview = r.parsed;
          lastOutFile = outFile;
          outFiles.push(outFile);
        }
      } catch (e) {
        threw = e;
        allOk = false;
        console.error('Music generation threw:', e);
        toast('Generation error: ' + (e && e.message || String(e)), 'err', 6000);
      } finally {
        // Record outcome BEFORE cleanup() clears state.generating (BatchGen polls it).
        state.genLastResult = state.genLastResult || { image: null, speech: null, music: null, video: null };
        // Mirror the image-tab partial-success gate.
        state.genLastResult.music = (outFiles.length > 0 && !threw) ? 'ok' : 'err';
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
        // A cancel after partial success must return EVERY
        // successful file (not only the last).
        return { status: outFiles.length > 0 ? 'ok' : 'cancel', outputPaths: outFiles };
      }
      if (allOk && lastOutFile) {
        // F5: route audio to Assets preview pane + status bar.
        notifyAudioGenerated(lastOutFile);
        bumpGenerationCounter('music', variantsCount);
        setStatus('✅ Audio generated — see Assets preview', false);
        // Log the success of the music run so the structured log
        // pane shows the "Generated N audio" row.
        addLogEvent({
          category: 'gen',
          groupId: runGroupId,
          result: 'ok',
          headline: `Generated ${variantsCount} music file${variantsCount === 1 ? '' : 's'}`,
          details: [`• ${lastOutFile}`],
        });
      } else if (outFiles.length > 0 && lastOutFile) {
        // Partial-success path.
        notifyAudioGenerated(lastOutFile);
        bumpGenerationCounter('music', outFiles.length);
        setStatus(`✅ ${outFiles.length}/${variantsCount} audio generated — see Assets preview`, false);
        addLogEvent({
          category: 'gen',
          groupId: runGroupId,
          result: 'warn',
          headline: `Generated ${outFiles.length}/${variantsCount} music file${outFiles.length === 1 ? '' : 's'} (${variantsCount - outFiles.length} failed)`,
          details: outFiles.map((p) => '• ' + p),
        });
      }
      // Same partial-success gate as imageTab + speechTab — a run
      // with ANY successful variant returns 'ok'.
      if (outFiles.length > 0) {
        const failCount = variantsCount - outFiles.length;
        toast(failCount > 0
          ? `Music generated. ${outFiles.length}/${variantsCount} variants saved (${failCount} failed — see log).`
          : (variantsCount > 1 ? `Music generated. ${variantsCount} variants saved.` : 'Music generated.'),
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
            if (pp.errors.length) toast('Post-process: ' + pp.errors.join('; '), 'warn', 6000);
          } catch (e) { console.error('Music batch postprocess failed', e); }
        }
        return { status: 'ok', outputPaths: finalOutFiles };
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
        // is only set inside armGenBtnWithCancel (which we may not
        // have reached).
        console.error('Music generation pre-flight failed:', e);
        toast('Generation failed before starting: ' + (e && e.message || String(e)), 'err', 6000);
      }
    });
  },
};

// fileUrl() lives in renderer/utils/fileUrl.js (pure function, no
// app coupling).
var { fileUrl } = window.FileUrl;

function showImagePreview(rootEl, file, parsed) {
  // Use file:// to let the renderer display the local file.
  // A cache-busting query string is added in case the same path is regenerated.
  // Renders a 400×400 thumbnail instead of the full image (the preview
  // pane would lock the screen when generation produces a large image).
  // Clicking the thumbnail opens the image overlay at 1:1 pixel mode
  // with a zoom dropdown.
  const url = fileUrl(file) + '?t=' + Date.now();
  const filename = (file || '').split(/[\\/]/).pop() || 'image';
  const preLoad = new Image();
  preLoad.onload = () => {
    rootEl.innerHTML = '';
    const thumb = el('img', {
      src: url,
      alt: filename,
      class: 'preview-thumb',
      title: `${preLoad.naturalWidth}×${preLoad.naturalHeight} — click to view full size`,
    });
    thumb.addEventListener('click', () => {
      openImageOverlay(url, filename, preLoad.naturalWidth, preLoad.naturalHeight, file);
    });
    rootEl.appendChild(thumb);
    const meta = el('div', { class: 'meta' });
    meta.appendChild(document.createTextNode(file));
    meta.appendChild(el('div', { class: 'preview-thumb-size' },
      `${preLoad.naturalWidth}×${preLoad.naturalHeight} — click for 1:1 view`));
    if (parsed) meta.appendChild(el('div', {}, '[mmx] ' + safeStringify(parsed)));
    rootEl.appendChild(meta);
  };
  preLoad.onerror = () => {
    // Fallback when pre-loading fails (e.g. file still being written to disk).
    rootEl.innerHTML = '';
    const thumb = el('img', { src: url, alt: filename, class: 'preview-thumb' });
    thumb.addEventListener('click', () => openImageOverlay(url, filename, 0, 0, file));
    rootEl.appendChild(thumb);
    const meta = el('div', { class: 'meta' }, file);
    rootEl.appendChild(meta);
  };
  preLoad.src = url;
}

function showAudioPreview(rootEl, file, parsed) {
  rootEl.innerHTML = '<div class="empty" style="padding: 16px;">Audio generated. View it in the Assets preview pane.</div>';
  const meta = el('div', { class: 'meta' });
  meta.appendChild(document.createTextNode(file));
  if (parsed) meta.appendChild(el('div', {}, '[mmx] ' + safeStringify(parsed)));
  rootEl.appendChild(meta);
}

// H3 Batch 7: The image viewer overlay (openImageOverlay, navigateToOverlayImage,
// buildOverlayNavList, IMAGE_EXTS) has been extracted to
// overlays/imageViewerOverlay.js. The functions are available as
// window.openImageOverlay, window.navigateToOverlayImage, etc.

// escapeHtml() is already available in DomHelpers.js. Drop-in alias
// below.
var { escapeHtml } = window;

window.MusicTab = window.TABS.music;
