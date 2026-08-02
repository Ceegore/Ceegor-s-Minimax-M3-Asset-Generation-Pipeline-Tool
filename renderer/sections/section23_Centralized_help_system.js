// renderer/sections/section23_Centralized_help_system.js
// Centralized help system

// ----------------- Centralized help system -----------------
// Every option in the app (form field, button, settings toggle,
// context-menu action) has a help topic. Topics are keyed by a
// stable string ID; the help text is intentionally written in
// plain, non-technical English so a first-time user can
// understand it without prior experience with image / audio
// generation tooling.
//
// Two ways to wire a topic into the UI:
//   1. Inline `?` icon: pass the topic ID to `helpButton(id)`.
//      Clicking the icon opens the help modal.
//   2. Inline text only: pass an object with `{ text, topic }`
//      to `helpButton()`. The icon shows a 1-line hover
//      summary; click opens the same modal for the full text.
//
// The help modal is the same `showModal` primitive used for
// every other dialog in the app, so it gets the standard
// Esc-to-close + click-outside-to-close + focus-management
// behaviour for free. The "Got it" button is just the default
// `Close` action — the user can also press Esc.
//
// Why a central map (and not inline text everywhere)?
//   - One place to update wording when the user reports
//     something is unclear.
//   - Searchable: `grep '"topic\\.image\\.prompt"'` finds every
//     place in the renderer that references the image-prompt
//     help topic, even after the help text is rewritten.
//   - The `helpButton` factory always renders the same DOM shape
//     (consistent styling, consistent a11y title, consistent
//     click target).
const helpTopics = {
  // -- Topbar --
  'topbar.tabImage':       { title: 'Image tab',                text: 'Generate still images from a text prompt using the MiniMax AI service (works with both Token Plan and pay-as-you-go / PAYG API keys). You can also enable local post-processing (upscale, crop, background removal, file-size optimization) that runs after the API returns the image.' },
  'topbar.tabSpeech':      { title: 'Speech tab',               text: 'Convert text into spoken audio. Pick a voice, paste or type the text, and click Generate. The result is written to the folder browser (right side) as an MP3 file.' },
  'topbar.tabMusic':       { title: 'Music tab',                text: 'Generate music from a description (genre, mood, instruments). The result is a short instrumental track — lyrics are not supported.' },
  'topbar.tabVideo':       { title: 'Video tab',                text: 'Generate short videos from a text prompt. Note: video generations are expensive and subject to plan quota limits (daily and/or weekly caps depending on your plan tier). Check the quota indicator in the top bar for your current allowance. Pay-as-you-go (PAYG) keys are billed per video. Each video takes a few minutes to render.' },
  'topbar.quota':          { title: 'Quota display',            text: 'Shows how many generations you have left on your MiniMax plan for the current day and the current week. Token Plan keys have daily and/or weekly caps; pay-as-you-go (PAYG) keys instead deduct credits per generation. Some models have daily limits, some have weekly limits, and a few have both. Click the round arrow to refresh.' },
  'topbar.styleBtn':       { title: 'Style Settings',           text: 'Manage your saved "style presets" — short text snippets that are automatically prepended to every prompt. For example, a "Cinematic" style might prepend "Cinematic lighting, shallow depth of field, 35mm film" to every image prompt. Use them to keep the same look across many generations without retyping.\n\nTip: the same style presets are also available in ⚙ Settings → Style presets. Manage them from whichever place is more convenient; both edit the same saved list.' },
  'topbar.themeBtn':       { title: 'Theme toggle',             text: 'Switch between the dark and light UI themes. The choice is remembered for your next launch.' },
  'topbar.settingsBtn':    { title: 'Settings',                 text: 'Open the main Settings dialog: API key, output folder, region, theme, style presets, image upscaling, image optimization, and the optional add-ons manager (Real-ESRGAN, IS-Net background-removal).' },

  // -- Folder browser --
  'sidebar.upBtn':         { title: 'Up one level',             text: 'Go to the parent folder of the current folder browser location.\n\nThe button has four distinct states:\n  1) Mid-tree folder — climbs one parent level.\n  2) The output_dir root — climbs one parent (or jumps to the drives list if output_dir IS a drive root).\n  3) A drive root (e.g. D:\\) — jumps to the drives list.\n  4) The drives list — DISABLED (you\'re already at the top; pick a drive to continue).\n\nThe current level is shown as a tooltip on the button. The Up button is also disabled when the folder browser is empty (no folder has been opened yet) — clicking it lands on the configured output_dir or the drives list.' },
  'sidebar.refreshBtn':    { title: 'Refresh',                  text: 'Re-scan the current folder and re-render the file list. Use this if you added or removed files in another program (e.g. Windows Explorer) and the browser is out of date.' },
  'sidebar.filter':        { title: 'Filter',                   text: 'Type to filter the file list by name. Only files whose name contains the typed text are shown. Clear the field to show everything again.' },
  'sidebar.sort':          { title: 'Sort',                     text: 'Sort the file browser. The available modes are: Name ↑/↓ (alphabetical, with "natural" number ordering so file_2.png sorts before file_10.png), Size ↑/↓ (by file size; directories always come first regardless of the chosen mode), Newest / Oldest (by last-modified date), Created ↑/↓ (by creation date — falls back to last-modified on filesystems that don\'t track creation, e.g. FAT32), and Type (by file extension). The selected sort is remembered across restarts.' },
  'sidebar.pickBtn':       { title: 'Open folder',              text: 'Open the Windows folder-selection dialog and switch the file browser to any folder on your computer. The folder is added to the list of folders the tool is allowed to read and write to.' },
  'sidebar.newFolderBtn':  { title: 'New folder',               text: 'Create a new empty folder inside the current folder.' },
  'sidebar.openExplorerBtn': { title: 'Open in Explorer',       text: 'Open the current folder in Windows File Explorer so you can use your normal file-management tools (copy, paste, rename, share) on the generated files.' },
  'sidebar.options':       { title: 'Folder options',          text: 'Open the folder-options overlay: pick which columns the folder explorer shows (Size, Type, Modified, Created, Path) and toggle image thumbnails in the list. The File-name column is always visible — turning it off would make the list unscannable. Toggle a column and the change is applied live (you can see the row get wider / narrower immediately). Enable image thumbnails to replace the generic 🖼 icon with a centered preview of the actual image file (image rows only — folder rows and non-image files are unaffected). The selections are remembered across restarts. When the columns don\'t fit the available width, a horizontal scroll bar appears at the bottom of the list automatically.' },
  'sidebar.thumbnails':    { title: 'Image thumbnails',        text: 'Replace the generic 🖼 icon on image rows with a centered preview of the actual image file (folder rows and non-image files are unaffected). The row height grows automatically so the thumbnail is fully visible — even when every column is enabled at once. When the toggle is off, the regular emoji icon is shown and is left-aligned (instead of the previous centred style), so a plain list reads like a normal Explorer view. The choice is remembered across restarts.' },

  // -- Image tab --
  'image.prompt':          { title: 'Prompt',                   text: 'Describe the image you want. Be as specific as you can — include the subject, the setting, the lighting, the mood, the camera angle, the artistic style. For example, instead of "a cat", try "a fluffy ginger cat sitting on a sunlit windowsill, soft afternoon light, photographic style". The more detail, the closer the result matches what you had in mind.' },
  'image.style':           { title: 'Style preset',             text: 'A saved prefix that is automatically added to your prompt. Use a style to keep the same look across many images (for example, all images in a comic-strip project share the same "ink illustration" style prefix). Manage your styles via the 🎨 button in the top bar.' },
  'image.negativePrompt':  { title: 'Negative prompt',         text: 'A list of things you do NOT want in the image. For example, "blurry, low quality, extra fingers" steers the model away from those problems. Leave empty for the default.' },
  'image.model':           { title: 'Model',                    text: 'Which image-generation model to use. Different models have different strengths: some are photorealistic, some are better for illustrations, some are optimised for text rendering, etc. If you are not sure, start with the default.' },
  'image.aspect':          { title: 'Aspect ratio',             text: 'The shape of the output image. "1:1" is a square. "16:9" is a wide landscape (good for desktop wallpapers). "9:16" is a tall portrait (good for phone wallpapers). "4:3" is the classic monitor shape.' },
  'image.resolution':      { title: 'Resolution',               text: 'The pixel size of the output image. Higher = more detail but slower to generate and uses more of your quota. The default (1024×1024 for 1:1) is a good balance for most uses.' },
  'image.variants':        { title: 'Variants',                 text: 'How many different images to generate from the same prompt in a single click. Each variant uses one quota unit. Use 2-3 to compare options; use 4-5 if you want a wider selection to pick from.' },
  'image.seed':            { title: 'Seed',                     text: 'A number that controls the random pattern used by the model. The same prompt + the same seed always produces (roughly) the same image. Useful when you want to re-generate with one small change and keep everything else the same. Leave "-1" (default) for a fresh random seed each time.' },
  'image.referenceImage':  { title: 'Reference image',          text: 'An optional local image file the model should "look at" while generating. The model tries to match the style, the colour palette, the composition, or the subject of the reference. Not all models support this.' },
  'image.filePrefix':      { title: 'File-name prefix',         text: 'A short text prepended to every generated file name. For example, a prefix of "project42_" produces files like "project42_2024-01-15_…". Useful for grouping related generations in a single project folder.' },
  'image.upscaleCheckbox': { title: 'Upscale after generation', text: 'When checked, every generated image is upscaled locally after the API returns it. Pure browser / Sharp pipeline, no extra network call. Click the label to open the settings dialog (multiplier, auto-crop, background-removal, optimization).' },
  'image.upscaleSettings': { title: 'Upscale settings',         text: 'Configure the local post-processing pipeline: how much to upscale (2× / 3× / 4×), whether to auto-crop to a target resolution, and whether to remove the background or optimize the file size after upscale. Click the 🔍 Upscale label to open this dialog.' },
  'image.addToBatch':      { title: 'Add to BatchGen',          text: 'Save the current prompt + settings as one entry in the BatchGen queue for this tab. You can then click "Start BatchGen" to run all queued entries one after another — useful for variations on a theme (same character, different poses / outfits / settings).' },
  'image.generateBtn':     { title: 'Generate',                 text: 'Send the current prompt to the MiniMax API. While the generation is in progress the button becomes "Cancel" — click it to abort. After the API returns, any enabled post-processing (upscale, crop, background removal, optimization) runs automatically before the image is shown in the preview pane. Works with both Token Plan and pay-as-you-go (PAYG) keys.' },
  'image.batchStart':      { title: 'Start BatchGen',           text: 'Run every prompt in the batch queue, one after another, using the prompt + settings of each entry. While a generation is running on this tab, the button is locked (greyed out) — wait for the current one to finish first.' },
  'image.batchEdit':       { title: 'Edit batch entries',       text: 'Open the BatchGen manager for this tab: add, remove, reorder, or edit the saved prompts. You can also paste a list of prompts (one per line) for bulk entry.' },

  // -- Speech tab --
  'speech.prompt':         { title: 'Text to speak',            text: 'The text the voice will read out. Plain text, no special formatting. Newlines are spoken as short pauses. Use punctuation (commas, periods, question marks) to control the pacing — they really do change how the voice sounds.' },
  'speech.voice':          { title: 'Voice',                    text: 'Which voice to use. The list is loaded from the API and contains dozens of voices in many languages. Each voice has a different age, gender, accent, and personality — click around to find the one you like. The "preview" button (▶) plays a sample.' },
  'speech.speed':          { title: 'Speed',                    text: 'How fast the voice speaks. 1.0 is the default. 0.5 is half-speed (slower, more deliberate). 2.0 is double-speed (chipmunk territory — usually too fast). Most use cases want 0.9-1.1.' },
  'speech.pitch':          { title: 'Pitch',                    text: 'How high or low the voice sounds. 0 is the default. Positive values make it higher, negative values make it lower. Small changes (±2) are usually all you need; large changes (±10+) start to sound unnatural.' },
  'speech.volume':         { title: 'Volume',                   text: 'Output loudness in decibels. 0 is the default. Positive values are louder, negative values are quieter. Useful for matching the level of multiple generated clips without re-encoding them.' },
  'speech.emotion':        { title: 'Emotion',                  text: 'Optional emotional tone: happy, sad, angry, surprised, fearful, disgusted, neutral. Leave at "Auto" for the model to pick based on the text. Not all voices support all emotions — the dropdown only shows what is available for the selected voice.' },
  'speech.language':       { title: 'Language',                 text: 'The spoken language. Most voices speak multiple languages — pick the one closest to the text you are feeding in. "Auto" lets the model detect the language from the text.' },
  'speech.format':         { title: 'Output format',            text: 'Audio file format. MP3 is the most compatible (plays on every device). PCM is raw audio (larger file, no quality loss). FLAC is lossless compression (smaller than PCM, same quality).' },
  'speech.sampleRate':     { title: 'Sample rate',              text: 'Audio quality, measured in samples per second. 32 kHz is good for speech. 44.1 kHz is CD quality. 48 kHz is studio quality — usually overkill for speech but fine for music. Higher = bigger file.' },

  // -- Music tab --
  'music.prompt':          { title: 'Music description',        text: 'Describe the music you want: genre (jazz, classical, electronic…), mood (energetic, melancholic, calm…), instruments (piano, drums, synth…), tempo (slow, mid-tempo, fast…), any reference (e.g. "in the style of 80s synthwave"). The more specific you are, the closer the result matches.' },
  'music.model':           { title: 'Model',                    text: 'Which music-generation model to use. Different models produce different lengths and styles. The default is a good starting point.' },
  'music.duration':        { title: 'Duration',                 text: 'How long the generated track should be, in seconds. Most models produce tracks between 10 and 60 seconds. Longer tracks use more quota.' },
  // 'music.instrumental' was removed when the dedicated Instrumental toggle was
  // consolidated into the "Vocal mode" dropdown. The instrumental option is now
  // documented by the Vocal-mode row's own inline help text, so this topic had
  // no remaining caller and would be dead documentation.

  // -- Video tab --
  'video.prompt':          { title: 'Prompt',                   text: 'Describe the short video you want. The model is best at clear, concrete subjects and actions (a dog running on a beach, a car driving through a city). Abstract or surreal prompts produce less reliable results.' },
  'video.model':           { title: 'Model',                    text: 'Which video-generation model to use. Different models have different resolution, length, and motion characteristics. The default is a good starting point.' },
  'video.resolution':     { title: 'Resolution',               text: 'The pixel size of the video. Higher = more detail but slower to render and uses more quota. 720p is a good default.' },
  'video.duration':        { title: 'Duration',                 text: 'How long the video should be, in seconds. Most models produce 5-10 second clips. Each extra second roughly doubles the render time and quota cost.' },
  'video.fps':             { title: 'Frames per second',        text: 'How smooth the video motion looks. 24 fps is the cinema standard. 30 fps is the TV standard. 60 fps is very smooth (used for sports / games). Higher = bigger file and more quota.' },
  'video.camera':          { title: 'Camera motion',            text: 'Optional camera movement (pan, zoom, dolly, etc.). Leave at "Static" for a fixed shot. Not all models support camera motion — the dropdown only shows what is available for the selected model.' },

  // -- Settings dialog --
  'settings.apiKey':       { title: 'API key',                  text: 'Your MiniMax API key. Works with both Token Plan keys (which look like "sk-cp-xxxxxxxx") and pay-as-you-go (PAYG) keys. Get a Token Plan key from the MiniMax dashboard, or create a PAYG key at the developer portal under "Interface Keys". Paste it here. The key is stored in config.txt next to the executable — never in the cloud, never embedded in the tool. You can use the "Show" / "Hide" toggle to confirm you pasted it correctly; the field is masked by default to prevent shoulder-surfing.' },
  // The "Don't save" checkbox on the API-key row keeps the entered key in
  // memory only — config.txt is NOT updated and the next launch starts empty.
  // Useful on shared / kiosk machines.
  'settings.apiKeyNoSave': { title: 'Don\'t save the API key', text: 'When this is checked, the entered API key is kept in memory for this session only — it is never written to config.txt and never written to mmx-cli\'s ~/.mmx/config.json. The key is passed to the mmx child process via an ephemeral, process-local environment variable that disappears when the process exits, and the next launch starts with an empty key. Use this on shared / kiosk machines where you don\'t want the next user to find your key. When unchecked, behaviour is unchanged: the key is written to config.txt and re-loaded on every launch.' },
  'settings.firstTimeSetup': { title: 'Guided setup',            text: 'Re-opens the first-run form (API key + output folder). Use this if you skipped the initial setup, want to walk through both fields together, or are handing the tool to someone else and want to start from a clean slate. The form is identical to the one a brand-new install sees — your current values are pre-filled so you only have to fix what\'s missing.' },
  'settings.outputDir':    { title: 'Output folder',            text: 'Where every generated file (image, audio, music, video) is written. Pick a folder with enough free space — videos and high-resolution images can be hundreds of megabytes each. The default is a "generated" folder next to the executable.' },
  'settings.configFile':   { title: 'Config file location',     text: 'Where config.txt lives on disk (read-only display). This is the file the tool reads at launch to load your API key, output folder, region, theme, and styles. You can back it up here, or move it manually if you want the tool to start fresh on the next launch.' },
  'settings.reportDir':    { title: 'Report folder',            text: 'Where the Pipeline writes the small Markdown report (.md) when you use "Clear with report" or "Export with report" on the Final column. Leave blank to write the report next to the exported assets (their destination folder). The folder must be writable; it is auto-trusted for writes while it is set.' },
  // The export format the user picked in the BatchGen settings, so the "Examples"
  // button writes only the file the user actually wants.
  'settings.batchesExportFormat': { title: 'Example export format', text: 'The format the "Examples" button writes when you click it from the BatchGen controls. Pick ONE — only the chosen file is left in your output folder. The .md format (default) is the AI-friendly markdown table; the .txt format is the plain-text pipe-separated version.' },
  // The auto-remove switch in the BatchGen settings. The default is to remove
  // successful items from the queue immediately; failed items stay.
  'settings.batchesAutoRemove': { title: 'Auto-remove completed items', text: 'When this is checked (the default), each batched item is removed from the BatchGen queue the moment it generates successfully. The list always reflects only upcoming work. Failed items are NEVER removed — you decide whether to retry or skip them. When unchecked, every item stays in the queue until you manually clear or edit it.' },
  'settings.region':       { title: 'Region',                   text: 'Which MiniMax API region to talk to. Most users want "global". Pick the regional endpoint only if you are inside a regulated network that blocks the global one. The region setting applies to both Token Plan and pay-as-you-go (PAYG) keys.' },
  'settings.theme':        { title: 'Theme',                    text: 'Pick the UI theme. "Dark" is easier on the eyes for long sessions. "Light" is better for screenshots / screen sharing in a bright room.' },
  'settings.upscale':      { title: 'Image upscaling',          text: 'Configure the local post-processing pipeline. The default works without any extra software, but you can install Real-ESRGAN (BSD-3-Clause) for noticeably higher-quality 4× upscale, and IS-Net for one-click background removal. Both are optional.' },
  'settings.optionalAddons': { title: 'Optional add-ons',      text: 'One-click installers for the optional quality tools: Real-ESRGAN binary, IS-Net binary, IS-Net ONNX model. The tool works without them; they are quality upgrades, not requirements.' },
  'settings.popupPolicy':    { title: 'Popup behaviour',        text: 'Controls how often the optional popups appear: the welcome screen on every fresh launch, the first-time setup, the optional add-ons installer, and the per-tab intro messages. "Show once to fresh users, then never" is the default — each popup fires once and remembers your dismissal across restarts. "Show first time each app start" re-triggers every popup on the next launch (useful while you\'re still learning the tool). "Never show these popups" silences all of them at once. "Always show (even after dismissal)" re-fires them on every trigger — useful for demos and training. The "Reset popup history" button below wipes the dismissal record so every popup fires again on its next trigger.' },
  'settings.popupsBtn':      { title: 'Popups settings',        text: 'Open the popup behaviour settings: pick how often the welcome / first-time / add-on / tab-intro popups appear, or reset the seen-popups history so every popup fires again the next time it is triggered.' },

  // -- Image pipeline (right-click context menu) --
  'ctx.upscale':           { title: 'Upscale',                  text: 'Make the image bigger (2×, 3×, or 4×) using the built-in canvas pipeline, or the higher-quality Real-ESRGAN binary if installed. The new file is written next to the original with a "_2x" / "_3x" / "_4x" suffix in the filename.' },
  'ctx.crop':              { title: 'Crop',                     text: 'Crop the image to a specific rectangle. Drag the crop frame with the mouse, or type exact W × H values. The cropped file is written next to the original with a "_cropped_WxH" suffix.' },
  'ctx.resize':            { title: 'Resize',                   text: 'Resize the image to an exact target resolution (W × H in pixels) with best-quality Lanczos3 resampling. A 🔗 chain link keeps the source aspect ratio (default, like GIMP/Photoshop); unlock it to set W and H independently (may distort). A subtle sharpen is applied automatically when downscaling to recover softness. For a large enlargement (more than 120% on either axis) the tool offers the dedicated Upscale feature (Real-ESRGAN AI) instead, which adds real detail rather than just stretching pixels — plain resizing softens enlargements.' },
  'ctx.convert':           { title: 'Convert format',           text: 'Re-encode the image to a different format. PNG is lossless (good for screenshots / illustrations, supports transparency). JPEG is much smaller (good for photos, no transparency). WebP is a modern middle ground (smaller than JPEG, supports transparency, but less universal).' },
  'ctx.optimize':          { title: 'Optimize / Compress',      text: 'Shrink the file size while keeping the image looking (almost) the same. The default quality of 82 is the "perceptually lossless" sweet spot for photos. You can also re-encode to WebP / AVIF for further size savings, and strip non-essential EXIF data (camera model, GPS, software tag) while keeping the colour profile.' },
  'ctx.removeBackground':  { title: 'Remove background',        text: 'Replace the background of the image with transparency. Uses the optional IS-Net model (a state-of-the-art segmentation model) — the tool walks you through the one-time install on first use. The result is a transparent PNG written next to the original. The background removal model can be changed in Settings; higher-quality BiRefNet models can be downloaded to provide cleaner edges at the cost of processing speed.' },

  // -- Audio pipeline (right-click context menu) --
  'ctx.audioCut':          { title: 'Audio cut',                text: 'Open the audio in a waveform editor. Drag the two markers to set the selection, or use the time inputs for millisecond precision. Quality-of-life helpers: "Auto-trim silence" removes leading/trailing silence, "Snap to zero-crossing" prevents clicks at the cut edges, and a configurable micro-fade (5 ms by default) buries any residual click. Pick a different output format (MP3 / WAV / OGG / Opus / FLAC / M4A) from the dropdown, then "Export" writes the trimmed file next to the original. Keyboard: Space = play/stop, I/O = set start/end at the playhead, Z = zoom to selection, F = fit, A = amplify view, S = toggle snap, L = toggle loop.' },
  'ctx.audioAutoCut':      { title: 'Auto-cut SFX',             text: 'Automatically slices a music track or audio clip into distinct sound events (SFX) using silence detection. Configure the silence threshold (in dB) and gap length (in ms), then click "Detect segments" to preview the planned slices. Exclude unwanted segments by checking/unchecking rows, then export them all in one go. Each exported segment is named <stem>_sfx01.<ext>, _sfx02, _sfx03, … written next to the original, so the numbering stays sequential even if you uncheck some segments.' },
  'ctx.pipeline':          { title: 'Pipeline',                 text: 'A column-based visual workflow for images. Import images (drag from Windows Explorer, "Load from disc", paste, or "Add to Pipeline" from the file-browser right-click), then walk each image column by column — Upscale, Remove BG, Crop, Optimize/Convert — to Final. In each column you can Run the operation, Skip it, go Back, Finalize early, Replace the file with a corrected version from disc (e.g. after fixing pixels in GIMP), or hand it to an external tool. Everything is saved between sessions; nothing is lost except by explicit delete.' },

  // -- Splitters --
  'layout.splitter':       { title: 'Drag to resize',           text: 'Click and drag this bar to resize the two areas on either side. The new size is remembered for your next launch. Three splitters exist: between the main content and the folder browser (vertical), between the content row and the log row (horizontal), and between the log and the picture preview (vertical).' },

  // -- Log + preview pane --
  'log.copy':              { title: 'Copy log',                 text: 'Copy the entire log to the clipboard. Useful for sharing an error with support or a friend. The API key is automatically masked in the copy (only the first 5 characters + "***" are shown) so a full key never accidentally leaves your machine.' },
  'log.clear':             { title: 'Clear log',                text: 'Erase the log. This is purely cosmetic — the next generation will start a fresh log. Useful when you are about to do a deliberate test and want a clean log of the test run only.' },
  'log.toggle':            { title: 'Collapse / expand the log', text: 'Collapse the log pane to a small button bar on the LEFT side so the picture preview can use the rest of the row. Click again to expand. The picture preview is locked to the RIGHT side of the window — there is never empty space to its right.' },
  'log.structured':        { title: 'Log events',               text: 'Each row in the log pane is one event. The columns are: time stamp, category icon (✎ generate, ⤴ upscale, ◐ background, ∇ optimize, ▤ batch, ! error, × cancel, · info), result icon (✓ for success, ✕ for error), and a one-line headline. Click anywhere on a row to select it; click the small ▸ chevron to expand and see the full details. Use Ctrl+click and Shift+click to multi-select multiple rows. The Copy button copies the selected rows (or all rows if nothing is selected) in a plain-text format that includes both the headline and the expanded details, so a support ticket gets the full picture.' },
  // These six log-bar buttons each have a proper title + useful description.
  'log.jumpNewest':        { title: 'Jump to newest log row',   text: 'Scroll the log pane to the most recent row. The log auto-scrolls by default while a generation is running — this button is the manual shortcut (same as the Home key).' },
  'log.jumpOldest':        { title: 'Jump to oldest log row',   text: 'Scroll the log pane to the first (oldest) row. Useful when you want to inspect the start of a long run. Same as the End key.' },
  'log.collapseAll':       { title: 'Collapse every log row',   text: 'Fold every expanded log row back to its one-line headline. The expanded details stay in memory — clicking the ▸ chevron on a row re-expands it. Handy when you want to skim a long log.' },
  'log.expandAll':         { title: 'Expand every log row',     text: 'Show the full details of every log row (every ▸ chevron flips to ▾). Useful when you want to copy the whole log — the Copy button copies the expanded details, so expanding first gets you the full picture.' },
  'sidebar.typeFilter':    { title: 'Asset-type filter',        text: 'Filter the file browser by asset type. The dropdown options are: All types (default, no filter), 🖼 Images (PNG/JPG/JPEG/WebP/GIF/BMP), 🎵 Audio (MP3/WAV/FLAC/Opus/OGG/M4A/PCM), 🎬 Video (MP4/WebM/MOV), and 📄 Text (TXT, LRC, JSON, MD, SRT). The selected type is remembered across restarts. Combine with the name filter (above) to narrow further (e.g. "type=Images + name=cat" shows only image files whose name contains "cat").' },
  'sidebar.bulkTrim':      { title: 'Open the audio cutter', text: 'Opens the interactive audio cutter on the single selected audio file so you can trim leading/trailing silence on a waveform. The cutter edits ONE file at a time — if more than one file is selected the action is blocked with a hint to narrow the selection to exactly one audio file (a true batch trim with a shared settings dialog is not implemented yet). Audio files only (.mp3/.wav/.flac/etc.); non-audio selections are rejected.' },
  'preview.clear':         { title: 'Clear picture preview',    text: 'Reset the picture preview pane to its empty state. The file in the file browser is not touched — only the preview pane is cleared.' },
  'preview.pane':          { title: 'Picture preview pane',     text: 'When you click an image in the folder browser, it is shown here. The image is fit to the pane (no cropping, no zoom). For multi-image runs (a batch of 4 variants), the pane splits into a grid of thumbnails — click any thumbnail to open it at 1:1 size.' },
  'preview.overlayNav':    { title: 'Image overlay navigation', text: 'When the image overlay is open (1:1 view from a thumbnail click), use the left and right arrow keys to switch to the previous / next image. If the overlay was opened from a multi-image batch (e.g. 4 variants from a single Generate click), the arrow keys step through the batch in order. If it was opened from a single image in the file browser, the arrow keys step through all the images in the current folder, in the same order the folder explorer shows them. The position counter ("(3 / 12)") in the overlay header tells you where you are in the sequence. The "‹" and "›" buttons in the overlay header do the same thing with the mouse.' },
  'preview.liveUpdates':   { title: 'Live batchgen updates',    text: 'While a generation is in progress (including a multi-variant BatchGen run), the folder explorer and the picture preview pane update live as each new image is written to disk: a 1-second poll scans the output folder, every newly-discovered image is added to the multi-image preview grid as a thumbnail, the matching row in the folder explorer is marked active, and the new row + thumbnail briefly blink so you can see the progress at a glance. The polling stops automatically when the generation ends (or is cancelled).' },
  // In-app pixel/image editor help topics.
  'editor.intro':          { title: 'Image editor',             text: 'A mini pixel editor for fixing small mistakes (background-removal seams, stray pixels, asset borders) and for compositing a second image onto the canvas. Tools: brush (B), spray (A), eraser (E), color picker (I), move (V), heal-select (H). Erasing writes real transparency (works even on a JPEG — it is auto-promoted to RGBA). Output is a sibling file <name>_edited.png/.jpg/.webp.' },
  'editor.brush':          { title: 'Brush / spray',            text: 'B = pen brush, A = airbrush/spray. Set size with the slider or [ and ], opacity with the slider. The brush paints with the foreground color. A live circle shows the brush size at the cursor.' },
  'editor.eraser':         { title: 'Eraser (to transparency)', text: 'E = eraser. It carves transparency (alpha=0), never fills with a colour — so it works on a JPEG too (the canvas is always RGBA). Hold E to temporarily erase with the current size, release to return to the previous tool (Krita-style). The result keeps transparency if you save as PNG or WebP.' },
  'editor.pipette':        { title: 'Color picker (pipette)',   text: 'I = pipette. Click anywhere to sample that pixel and set it as the foreground color. Hold Alt while using the brush to sample on the fly (Photoshop-style). The sampled color is the composited pixel (base + painted + placed objects).' },
  'editor.composite':      { title: 'Composite a 2nd image',    text: 'Load a second image into the right-hand Asset panel (📂 Load…), then → Send to canvas drops it onto the canvas centered and selected. Drag to move; corner handles to scale (constrain proportions by default); the rotation stalk to rotate (hold Shift to snap to 15°). Flip H/V, bring forward/back, and delete are in the Objects list. Press Enter to apply, Esc to cancel the transform. Rotate the source before placing it using the same handles.' },
  'editor.asset':          { title: 'Asset panel (composer)',   text: 'The right-hand panel is a second live canvas for preparing assets. 📂 Load… an image, ✨ Generate… one with the image model (prompt + style + size + seed), or drag a queue thumbnail onto it. Paint and erase directly on the asset canvas (click it first — the focused canvas has an accent outline and receives all tools/shortcuts). ✂ Remove BG cuts the asset out (keeps transparency), → Send to canvas places the composited asset onto the main image. The History strip keeps the last 8 generated/loaded assets (click to reload). » collapses the panel.' },
  'editor.bake':           { title: 'Bake / flatten',           text: '↻ Bake rasterizes all placed objects into the base image so the brush/eraser/heal can paint over the composited result. It is a single undo step (you can undo it). Healing always bakes first since it operates on pixels.' },
  'editor.heal':           { title: 'Heal / inpaint',           text: '🩹 Heal fixes a region by synthesizing it from the surrounding texture. Pick the region first with the heal tool (H, drag a rectangle), then choose: Heal Selection (fast, local), Heal Transparency (fills the alpha holes left after background removal), or Resynthesize (stronger AI fill). The best engine per task is default-selected.' },
  'editor.formats':        { title: 'Output format',            text: 'Save as PNG (keeps transparency), JPEG (smaller, no transparency), or WebP (modern, smaller). PNG is the default when the canvas has any transparency. Saving a transparent image as JPEG warns you and offers to fill the transparent areas with a matte color.' },
  'editor.queue':          { title: 'Batch queue',              text: 'When you edit multiple selected images at once, a filmstrip bar appears above the canvas. Click a thumbnail to switch the canvas to that image (each keeps its own edits). Drag a thumbnail onto the Asset panel to composite that image into the current one.' },
  'editor.shortcuts':      { title: 'Keyboard shortcuts',       text: 'B brush · A spray · E eraser · I pipette · V move · H heal · Space (hold) pan · wheel zoom (to cursor) · [ ] brush size · X swap colors · D reset colors · Ctrl+Z undo · Ctrl+Y / Ctrl+Shift+Z redo · Ctrl+S save · Ctrl+0 fit · Ctrl+1 100% · Enter apply transform · Esc cancel/close.' },
};

function helpButton(topic) {
  // Build a HOVER-ONLY `?` icon that shows the help text for the given topic on
  // mouseover (via the HelpTooltip system). The click handler is removed
  // entirely; the `data-help` attribute carries the text (topic-keyed or
  // inline-summary), and the HelpTooltip shows it on hover.
  //
  // `topic` can be either:
  //   - a string (treated as a key into helpTopics), or
  //   - an object with `{ text, topic }` for an inline 1-line summary that ALSO
  //     links to the full topic.
  // Resolve the topic key to its full help text (when available) and use that
  // as the hover tooltip body.
  let helpKey = null;
  let inlineText = null;
  if (typeof topic === 'string') {
    inlineText = topic;
    helpKey = topic;
  } else if (topic && typeof topic === 'object') {
    inlineText = topic.text || '';
    helpKey = topic.topic || null;
  }
  // Prefer the topic-keyed version (richer text) when
  // available; fall back to the inline summary. HelpTooltip
  // shows the text on hover.
  const fullText = (helpKey && helpTopics[helpKey] && helpTopics[helpKey].text)
    || inlineText
    || '';
  const b = el('button', {
    type: 'button',
    class: 'help-btn',
    'aria-label': 'Show help',
    'data-help': fullText,
    // No click handler. Hover-only.
  }, '?');
  return b;
}

function showHelp(topicKey, fallbackText) {
  // Open a modal that displays the help text for the given topic key. If the
  // key is not in the registry, fall back to whatever inline text the caller
  // supplied.
  //
  // When an inline string is passed as topicKey (the common case for
  // `buildParamRow({ help: '...' })`), derive a proper title from the parent
  // <label> of the ? button (i.e. the row label like "--voice" or "Sample
  // rate") so the modal title tells the user WHICH setting this help text is
  // for, rather than a generic "Help" placeholder.
  let topic = null;
  if (topicKey && helpTopics[topicKey]) {
    topic = helpTopics[topicKey];
  } else if (topicKey) {
    // Inline help string. Synthesize a title from the parent row label so the
    // modal isn't titled just "Help".
    const title = deriveTitleFromDom() || 'Help';
    topic = { title, text: topicKey };
  } else if (fallbackText) {
    const title = deriveTitleFromDom() || 'Help';
    topic = { title, text: fallbackText };
  } else {
    topic = { title: 'Help', text: 'No help text available for this option.' };
  }
  // Derive the modal title BEFORE blurring (blur moves activeElement to body,
  // which would lose the parent-row info) so the synthesized topic already has
  // the right title.
  if (!topic.title || topic.title === 'Help') {
    const derived = deriveTitleFromDom();
    if (derived) topic.title = derived;
  }
  // Detach focus from the trigger element right before the modal opens so the
  // CSS :focus state no longer applies (the ? help button keeps its blue
  // background while focused until the user clicks elsewhere). Blur
  // synchronously — showModal() moves focus to the modal's primary button
  // immediately after, so there's no race where the user is left without
  // keyboard focus.
  try {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  } catch (_) { /* ignore */ }
  // Pass an id derived from the topic key so the modal-stack
  // dedup catches repeated clicks on the same help button.
  // Without this, mashing the ? icon on a glitchy trackpad
  // could pile up five identical help modals on top of each
  // other (each with its own backdrop and Esc listener).
  const modalId = topicKey ? ('help:' + topicKey) : 'help:inline';
  showModal((m, close) => {
    m.classList.add('help-modal');
    m.appendChild(el('h2', {}, '❓ ' + topic.title));
    // The help text can contain short paragraphs separated by
    // blank lines — render as multiple <p> elements so the
    // typography is consistent with the rest of the app.
    const paragraphs = String(topic.text).split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    const body = el('div', { class: 'help-modal-body' });
    for (const p of paragraphs) {
      body.appendChild(el('p', {}, p));
    }
    m.appendChild(body);
    // Footer with a single "Got it" close button so the
    // user has an obvious "I'm done" action. Esc also
    // closes (handled by the global keydown listener in
    // showModal).
    m.appendChild(el('div', { class: 'footer' }, [
      el('button', { class: 'primary', onclick: close }, 'Got it'),
    ]));
  }, { id: modalId });
  // Log every help-modal open + the resolved topic so the file log captures
  // which ? the user clicked.
  if (typeof window.logAction === 'function') {
    window.logAction('help', 'show', {
      topic: topicKey || '(inline)',
      title: topic.title,
      text_len: (topic.text || '').length,
    });
  }
}
// setupHelpDelegation() lives in renderer/components/HelpDelegation.js and uses
// window.showHelp (set by app.js at file-end).


// Derive a sensible modal title from the DOM at click-time.
// Walk up from the active (focused / hovered) element to the nearest .row >
// label and use its first line of text (minus the trailing "?" just clicked).
// Falls back to document.title when nothing useful is found.
function deriveTitleFromDom() {
  try {
    // The clicked button is still focused right before blurring
    // it (see the blur() block in showHelp). Walk up to the
    // closest .row and read the <label>.
    let node = document.activeElement;
    // activeElement may already be the body if the click
    // originated from a non-focusable element. Try the
    // hovered element next (mouseover leaves it as relatedTarget).
    if ((!node || node === document.body) && typeof document.querySelector === 'function') {
      node = document.querySelector('.help-btn:hover') || document.querySelector('.help-btn');
    }
    if (!node || typeof node.closest !== 'function') return null;
    const row = node.closest('.row');
    if (!row) return null;
    const label = row.querySelector('label');
    if (!label) return null;
    // Strip the trailing "?" the helpButton adds and trim.
    const text = (label.textContent || '').replace(/\?\s*$/, '').trim();
    if (!text) return null;
    return text;
  } catch (_) {
    return null;
  }
}

// setupHoverHelpTooltips() lives in renderer/components/HelpTooltip.js. The
// shim alias is set there.

// Export showHelp on window for HelpButton.js (and any other component that
// needs to invoke the help modal). Exporting here — where the function is
// actually defined — avoids a ReferenceError at load time that would occur if
// the export ran from a section loaded earlier in index.html.
window.showHelp = showHelp;

