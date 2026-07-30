// renderer/sections/section24_State.js
// State

// ----------------- State -----------------
// state is exposed on window. const at the top level of a <script> tag is NOT
// global, so imageTab/musicTab/section05 etc. that reference `state.config`
// would get a ReferenceError. Exposing state on window fixes that.
//
// Single source of truth for the persistent keys
// (window.STATE_PERSIST_KEYS). The keys below MUST stay in sync with the shape
// produced by src/state.js write(). `tabs` is special-cased (the renderer
// holds it as state.tabSettings) and is added to the snapshot before sending.
window.STATE_PERSIST_KEYS = [
  'currentTab', 'fbDirs', 'filePrefix', 'filePrefixForceOnly',
  'realesrganModel',
  'realesrganFirstRunDismissed', 'upscaleEnabled', 'upscaleSettings',
  'removeBackgroundEnabled', 'removeBackgroundUseGpu', 'removeBackgroundModel',
  'optimizeSettings', 'layoutSettings', 'fbSort', 'fbColumns',
  'fbThumbnails', 'fbShowAllFiles', 'lastSeenVersion', 'popupPolicy', 'seenPopups',
  // The finished-job summaries snapshot + its cap MUST be in the persist list,
  // otherwise saveAllStates() never sends them and init()'s load loop never
  // reads them back — so the "previous session" log rows + the L3 JSONL
  // archive + the History pane's cap input silently reset on every restart.
  'jobsSnapshot', 'jobsArchiveCap',
  // Four settings documented as "persisted to state.json" MUST be in this list
  // AND in src/state.js write()'s whitelist, otherwise they reset to default on
  // every restart.
  'apiKeyNoSave', 'fbTypeFilter', 'batchesAutoRemove', 'batchesExportFormat',
  // The per-feature advanced parameter object (Real-ESRGAN tile/tta/gpu,
  // IS-Net threads, Sharp encoder knobs, ffmpeg silence threshold + codec
  // bitrate). Sanitised at the src/state.js write() boundary; the renderer
  // treats it as opaque  // tuning of the underlying CLI flags + API parameters.
  'pipelineAdvancedSettings',
  'autoPipelineEnabled',
  'autoCutSettings',
  'batchDirectMode',
  // PE-031: image-editor preferences (tool, brush size/opacity, colours,
  // output format, asset-panel collapsed). Sanitised field-by-field in
  // src/state.js write() with whitelists + clamps.
  'imageEditorPrefs',
  // The column-based Pipeline board. Sanitised field-by-field in src/state.js
  // write()/read() (model keys whitelisted against the existing realesrgan +
  // isnetbg registries so a corrupted state.json can't inject a spawn arg). The
  // renderer treats it as the source of truth for the board.
  'pipeline',
];
window.state = {
  config: { hasApiKey: false, apiKeyLast4: '', output_dir: '', region: 'global', theme: 'dark', styles: [] },
  // When the user enables "Don't save" on the API-key row in ⚙ Settings, the
  // entered key is NOT written to config.txt and is NOT loaded from config.txt
  // on the next launch (the user has to re-enter it). SEC-001: the raw key
  // never crosses the IPC boundary; only hasApiKey/apiKeyLast4 are exposed.
  // Persisted to state.json so the checkbox state survives a restart.
  apiKeyNoSave: false,
  voices: [],
  voicesLoaded: false,
  fbDir: '',
  currentTab: 'image',
  theme: 'dark',
  batches: { image: [], speech: [], music: [], video: [] },
  // Per-tab last visited folder (for per-tab folder persistence, see showTab)
  fbDirs: { image: '', speech: '', music: '', video: '' },
  // Global "Target file prefix" — prepended to every generated file's
  // name. Mirrored on all 4 tabs (one input on each) so the user can
  // tweak it without switching tabs. Persisted to state.json.
  filePrefix: '',
  // When true, every generated file is named ONLY `<prefix><6-digit number>.<ext>`
  // (e.g. `temp000001.jpg`, `temp000002.png`, …). The counter is per-run, NOT
  // per-prefix, so a user who switches from "temp" to "out" gets
  // `out000001.jpg`, not `out000006.jpg`. The counter is reset to 0 at the
  // start of every Generate click (the FIRST click of a new run starts at
  // 000001) so the next filename is predictable without counting by hand.
  // Persisted to state.json so the "force prefix only" preference survives a
  // restart.
  filePrefixForceOnly: false,
  // Real-ESRGAN model name (passed to the ncnn-vulkan binary via
  // `-n <model>`). The default is the general-purpose 4× BSD-3 model.
  // Users pick a different one in ⚙ Settings → Image upscaling →
  // Model. The actual spawn is whitelisted in src/realesrgan.js to a
  // short known set so a corrupted state.json can't inject an
  // arbitrary model name (or argv flag) into the binary.
  realesrganModel: 'realesrgan-x4plus',
  // First-run dismissal for the optional Real-ESRGAN install
  // popup. Set to true by the popup's "Don't ask again" / "Skip"
  // / successful install paths. Persisted to state.json so a user
  // who already saw the popup on a previous launch isn't
  // re-prompted. Initialised here so the first read isn't
  // `undefined` (the truthy check would still work, but the
  // implicit shape change is harder to grep for).
  realesrganFirstRunDismissed: false,
  // Upscale-on-Generate: when true, every newly generated image is
  // upscaled locally (Canvas API) after the mmx call returns, using the
  // settings below. Persisted to state.json so it survives restarts.
  upscaleEnabled: false,
  autoPipelineEnabled: false,
  pipelineAdvancedSettings: {
    realesrgan: { tileSize: 0, ttaMode: false, gpuId: 'auto' },
    isnetbg: { intraOpNumThreads: 0, interOpNumThreads: 0, executionMode: 'sequential', postClean: true, featherPx: 1, defringe: true, refine: true },
    optimize: {
      jpegChromaSubsampling: '4:2:0', jpegMozjpeg: true, pngCompressionLevel: 9, pngPalette: false,
      webpMode: 'lossy', webpEffort: 6, avifEffort: 9, avifChromaSubsampling: '4:4:4'
    },
    audio: {
      silenceThresholdDb: -50, minSilenceMs: 50,
      mp3Quality: 2, oggQuality: 6, opusBitrate: '128k', m4aBitrate: '192k'
    }
  },
  // The auto-crop options are now part of the upscale settings — they
  // live here so the Add button in the image tab can capture them as
  // part of the batch entry snapshot, and the image tab's generate
  // handler can apply them after the upscale. The ⚙ Settings →
  // Upscale Settings popup exposes all five fields (multiplier,
  // autoCrop, cropWidth, cropHeight, cropAnchorX/Y) so the user can
  // configure everything in one place.
  upscaleSettings: { multiplier: 2, autoCrop: false, cropWidth: 0, cropHeight: 0, cropAnchorX: 'center', cropAnchorY: 'center' },
  // When the upscale is on, also remove the background from the
  // (optionally upscaled + cropped) output via the optional isnetbg
  // binary. Persisted to state.json so the user's "yes, always
  // free up my generated assets" choice survives restarts. The
  // standalone right-click "Remove background" action does NOT
  // depend on this flag — it's an explicit user gesture every
  // time, so accidental turn-on here is contained to the
  // generation pipeline.
  removeBackgroundEnabled: false,
  // Whether to ask the isnetbg binary to use GPU acceleration.
  // Default to true (DirectML / CUDA / Vulkan whatever the
  // binary supports) because IS-Net on a CPU is slow; the user
  // can opt out if the GPU path is misbehaving on their box.
  removeBackgroundUseGpu: true,
  // gewv2 GEW-010 fix: default to the higher-quality bundled model
  // (cleaner edges) instead of the fast/lower-quality one. Both
  // onnxruntime-node and the birefnet-general-lite model file are always
  // bundled, so this default is safe.
  removeBackgroundModel: 'birefnet-general-lite',
  // Image-optimisation settings. When `enabled` is true, every
  // generated image is run through the Sharp-based
  // image-optimizer IPC after upscale (and after the optional
  // auto-crop + background-removal stages). Persisted to
  // state.json. The right-click "Optimize / Compress" entry in
  // the folder browser always opens the dialog regardless of
  // this toggle (it's an explicit user gesture every time).
  //
  // Defaults match the spec's "sweet spot" for perceptually
  // lossless compression: quality 82, keep the source format
  // (so a PNG round-trip doesn't silently re-encode to JPEG),
  // strip EXIF (camera model / GPS / etc.) but keep the ICC
  // profile so colours still render correctly on colour-
  // managed displays.
  optimizeSettings: { enabled: false, quality: 82, format: 'keep', stripMetadata: true },
  autoCutSettings: {
    thresholdDb: -35,
    minSilenceMs: 250,
    minSegmentSec: 0.15,
    maxSegmentSec: 3.0,
    longSegmentPolicy: 'truncate',
    padMs: 25,
    maxSegments: 20,
    fade: true,
    format: 'wav',
  },
  // The Pipeline board default. Empty on first launch — the workspace path is
  // resolved lazily on first open() and cached back here. Per-column defaults
  // live in src/pipeline/pipelineModel.COLUMN_DEFAULTS and are mirrored by the
  // sanitiser; the renderer deep-merges per-item settings over them.
  pipeline: {
    image: {
      workspace: '',
      columns: Object.assign({}, (window.PipelineModel && window.PipelineModel.COLUMN_DEFAULTS) || {}),
      hiddenColumns: [],
      items: [],
      trash: [],
      counter: 0,
    },
  },
  // Resizable-layout sizes (folder-browser column width,
  // log/preview row height, picture-preview column width).
  // Persisted to state.json via the splitter drag handlers so
  // the user only has to set their preferred sizes once. The
  // sidebar + logbar defaults match the CSS `:root` block in
  // styles.css; the previewW default is recomputed at startup
  // to half the available row width (see applyLayoutSettings)
  // so a fresh install opens with a balanced 50/50 split.
  layoutSettings: { sidebarW: 360, logbarH: 280, previewW: 480 },
  // Per-tab generation state used for status dots and the batch runner.
  // "running" while mmx is in flight, "done" after success, "idle" otherwise.
  // Green dot is only shown when the tab is not the active one.
  genStatus: { image: 'idle', speech: 'idle', music: 'idle', video: 'idle' },
  // Set to the tab key while a generation is in progress. Cleared by
  // armGenBtnWithCancel's cleanup. Used by startBatchGen to wait for
  // completion between batch entries.
  generating: null,
  // Per-tab generation queue progress. genQueueSize is the total number
  // of items the current run will produce (variants × --n). genQueueDone
  // is how many items have finished. The tab's ETA timer reads both
  // values to compute a "remaining time for the whole queue" estimate.
  // Cleared by armGenBtnWithCancel's cleanup. Without these, the ETA
  // only ever showed the time for the CURRENT item — useless when the
  // user is running a 5-variant batch and wants to know when the whole
  // batch will be done.
  genQueueSize: { image: 0, speech: 0, music: 0, video: 0 },
  genQueueDone: { image: 0, speech: 0, music: 0, video: 0 },
  // Wall-clock start time (Date.now()) of the in-flight generation, per tab.
  // armGenBtnWithCancel sets this on entry; cleanup() reads it to update
  // genAvgSec. Declared explicitly so a corrupted state.json with a non-object
  // value can't crash the gen handler.
  genStartMs: { image: null, speech: null, music: null, video: null },
  // Per-tab exponential moving average of successful generation
  // durations (seconds, alpha=0.4). Drives the per-tab ETA timer in
  // section10. Same shape as genStartMs above.
  genAvgSec: { image: 0, speech: 0, music: 0, video: 0 },
  // How many BatchGen items are still in flight for each tab. The per-tab ETA
  // timer (section10) reads this so the user sees the total remaining time for
  // the whole batch, not just the current single Generate. The batchManager
  // updates it on entry (== items.length - i) and decrements on every completed
  // item. 0 = no batch in flight.
  batchQueueLeft: { image: 0, speech: 0, music: 0, video: 0 },
  // H11-3: direct (snapshot) batch mode (default on). Builds argv from row params, calls mmxRunJob directly — no DOM inheritance.
  batchDirectMode: true,
  // PE-031: persisted image-editor preferences. Defaults match
  // src/state.js write() so first-run is consistent.
  imageEditorPrefs: { tool: 'pen', brushSize: 12, brushOpacity: 1, fg: '#000000', bg: '#ffffff', outFormat: 'png', assetPanelCollapsed: false },
  // The path of the image currently shown in the right-side preview
  // pane. Used by previewImageFromFile to short-circuit "click the
  // same file twice" and avoid a re-decode + flicker. Cleared when
  // the preview is reset to the empty state (e.g. after a file is
  // deleted or moved out from under the pane). Initialized here so
  // the first read doesn't see "undefined" — the comparison would
  // still work, but writing to it via a property assignment on
  // `state` would silently create the key on first use, which is
  // the kind of implicit shape change that's hard to grep for.
  _lastPreviewPath: null,
  // Snapshot of the file-browser list (the items returned by
  // window.api.fbList and rendered into #fb-list). Used by helpers
  // that need to look up a full fs-item record by path (size, ext,
  // mtimeMs, isDir) without re-issuing an IPC call. Populated by
  // renderFbList on every refresh.
  _fbItems: [],
  // Set of file paths the user has ticked in the checkbox column. Persisted
  // across refreshes (a refresh re-checks the boxes that are still in the
  // visible list). Cleared on navigation, on Refresh, and on bulk-action
  // success. The bulk-action menu reads this to know which items to operate on.
  // Set lives in plain JS (not in the state.json snapshot) because it's
  // transient UI state.
  fbSelected: new Set(),
  // The current multi-image preview batch, when one is shown. Set
  // by previewImagesFromFiles to { paths: string[], index: number }.
  // Cleared by previewImageFromFile when a single-image preview
  // replaces the multi-image grid. The image-overlay arrow-key
  // handler (added in a later feature) reads from this to navigate
  // to the previous / next image in the batch. Cleared to `null`
  // (not undefined) so the first read returns a known value.
  _previewBatch: null,
  // Sort mode for the file-browser list. One of:
  //   'name-asc' (default), 'name-desc',
  //   'size-desc', 'size-asc',
  //   'mtime-desc' (newest first), 'mtime-asc' (oldest first),
  //   'created-desc' (newest first), 'created-asc' (oldest first),
  //   'type-asc' (by file extension)
  // Persisted to state.json so the user's preferred sort survives a
  // restart. The renderer re-sorts the items in memory; the main
  // process still returns them in its default (name-asc, dirs-first)
  // order so a corrupted state.json value just falls back to the
  // server-side default.
  fbSort: 'name-asc',
  // The asset-type filter value (the comma-separated extension list the
  // #fb-type-filter dropdown uses). Empty string = "All types". Persisted so a
  // user who prefers to browse only generated images (or only audio) sees the
  // same filter on the next launch.
  fbTypeFilter: '',
  // The BatchGen "example export" format the user picked in ⚙ Settings →
  // BatchGen. One of 'md' | 'txt'. Default 'md' (the AI-readable format most
  // users use). Persisted to state.json.
  batchesExportFormat: 'md',
  // When true (the default), each batched item is removed from
  // state.batches[tabKey] once it finishes generating successfully, so the list
  // always reflects only upcoming work. Failed items are NOT removed — the user
  // has to decide whether to retry or skip them. The user can opt out in ⚙
  // Settings → BatchGen ("Keep completed items in list"). Persisted to
  // state.json.
  batchesAutoRemove: true,
  // Which file-browser columns are visible. An object keyed by
  // column id (see FB_COLUMNS) with boolean values. The "name"
  // column is mandatory and is always rendered, regardless of
  // this object; the option-overlay reflects that by disabling
  // its checkbox. The default set is the smallest reasonable
  // view (name + size). Persisted to state.json so the user's
  // choice survives a restart.
  fbColumns: {
    size: true,
    type: false,
    mtime: false,
    created: false,
    path: false,
  },
  // File-browser image thumbnail toggle. When true, image rows in the folder
  // explorer render a small centered thumbnail of the actual image file
  // (instead of the generic 🖼 icon). The row height grows to fit the
  // thumbnail; non-image rows are unaffected. When false, the regular icon is
  // shown and is left-aligned so a plain list reads like a normal Explorer
  // view. Persisted to state.json.
  fbThumbnails: false,
  // When false (the default), the renderer filters the list down to image /
  // audio / video / text assets + folders (see SUPPORTED_FILE_EXTS in
  // fileBrowser1.js) so .exe, .md, .json helpers, temp files etc. don't clutter
  // the list. The user can flip this off in the Folder options dialog to see
  // every file (useful for debugging / inspecting the folder). Persisted to
  // state.json so the choice survives a restart.
  fbShowAllFiles: false,
  // Structured event log. Each entry is one line in the
  // bottom-left log pane. Replaces the old <pre id="log">
  // raw-text approach (which didn't support selection / expand
  // / structured copy). The new pane renders each event as a
  // row with a time stamp, a category icon, a result icon,
  // and a one-line headline; clicking the row toggles its
  // selection, and clicking the small chevron toggles the
  // expanded details. Capped at LOG_MAX_EVENTS to keep memory
  // usage bounded over a long session.
  _logEvents: [],
  // The id of the most recently clicked event row. Used by
  // the shift-click range-select (shift-click selects every
  // event between this id and the clicked one).
  _logLastClickedId: null,
  // Popup display policy. Controls how the optional "first run"
  // / "tab intro" popups behave. One of:
  //   'never'        — default. Never show these popups.
  //   'once-fresh'   — Show each popup until the user
  //                    dismisses it; then never show it again
  //                    (across restarts).
  //   'per-session'  — Show each popup the first time it's
  //                    triggered after each app start; reset on
  //                    every launch.
  //   'always'       — Always show these popups (ignoring any
  //                    prior dismissal).
  // The user can change this in ⚙ Settings → Popups. The welcome popup is
  // intentionally shown on every launch; this policy controls optional
  // follow-up and tab-intro popups.
  popupPolicy: 'never',
  // Map of popup-id → ISO timestamp of the user's last dismissal.
  // Used by the 'once-fresh' policy to decide whether the popup
  // should still fire. An in-memory per-session set is also kept
  // for the 'per-session' policy so popups don't re-show inside
  // the same launch. see _popupSeenThisSession below.
  seenPopups: {},
  // Declare this so the first read isn't `undefined`. The startup popup logic
  // checks this to decide whether to show the "what's new" toast on a version
  // bump.
  lastSeenVersion: '',
  // L2 list of finished-job summaries. `null` (not `[]`) until the first job
  // finishes so a fresh state.json doesn't carry an empty array. Declared here
  // so the shape is greppable and the first read isn't `undefined` (which would
  // make the `Array.isArray` guard in bootstrap/init silently skip the
  // persisted-row render).
  jobsSnapshot: null,
  // Cap on the L2 list (20..1000, default 200). The cap is enforced on every
  // write in src/state.js write(); overflow entries are appended to the L3
  // JSONL archive. Declared here so the History pane's cap input has a known
  // initial value even before the disk state loads.
  jobsArchiveCap: 200,
};
// Backward-compat alias. const at the top level of a <script> tag is NOT
// global. Older files (imageTab, musicTab, sections/section05, ...) reference
// `state` directly. `var` at the top level of a <script> tag IS global, so we
// alias `var state = window.state` here rather than rewriting every call site.
var state = window.state;
// Per-session set of popup ids that have already been shown during
// this app launch. Used by the 'per-session' popup policy so a
// popup that was dismissed earlier in this session doesn't re-fire.
// Cleared at app start; the on-disk seenPopups (state.seenPopups)
// is preserved across launches and used by the 'once-fresh' policy.
const _popupSeenThisSession = new Set();

