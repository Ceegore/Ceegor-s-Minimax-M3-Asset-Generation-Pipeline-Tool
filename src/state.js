// src/state.js
// Per-tab UI state autosave. Persists all form values across all 4 tabs
// to state.json next to config.txt.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
// state.json honours MINIMAX_CONFIG_DIR and the exe/cwd fallback chain.
const { configDir } = require('./config');
const { isKnownModel } = require('./isnetbg/modelRegistry');
const { resolveAutoBestModel } = require('./isnetbg/binaryDiscovery');
// State-field sanitisers run on both read and write paths.
const { sanitisePipelineAdvancedSettings, sanitiseAutoCutSettings, sanitisePipelineBoard, sanitiseScalarStateFields } = require('./stateSanitizers');
// Append-only archive for trimmed jobsSnapshot entries. Required lazily so
// this file remains usable from unit tests that don't have the ArchiveService
// on the classpath (the test harness uses a stub).
let _archiveService = null;
function _archive() {
  if (_archiveService) return _archiveService;
  try {
    // eslint-disable-next-line global-require
    _archiveService = require('./services/ArchiveService');
  } catch (_) {
    _archiveService = null;
  }
  return _archiveService;
}
// H-045: session-scoped ids of already-archived overflow entries. A save
// retried by the renderer (e.g. the previous round trip failed after the
// archive append succeeded) carries the same overflow again — without this
// set the same job would be appended to the JSONL archive twice.
const _archivedIds = new Set();

function statePath() {
  return path.join(configDir(), 'state.json');
}

// sanitisePipelineAdvancedSettings and sanitiseAutoCutSettings (in
// ./stateSanitizers.js) are required at the top of this file and used by
// both read() and write() so a hand-edited state.json can never land bogus
// values in the renderer.
// sanitiseScalarStateFields (also in ./stateSanitizers.js) applies the
// model-key + settings whitelists on the read path too, so a hand-edited
// state.json can't land a malicious model key in the renderer on first
// launch. See read() for usage.

// Legacy popupPolicy migration. KGO4-006 fix: 'once-fresh' is a valid,
// user-selectable policy (documented in section18_Startup_popup.js as the
// default). The old migration downgraded it to 'never' based on
// lastSeenVersion, which was never written (KGO4-007), so it ALWAYS
// fired. Now we simply normalise to the whitelist without downgrading.
const WL_POPUP = ['once-fresh', 'per-session', 'never', 'always'];
function _migrateLegacyPopupPolicy(raw) {
  const persisted = WL_POPUP.includes(raw?.popupPolicy) ? raw.popupPolicy : 'never';
  raw.popupPolicy = persisted;
}

function read() {
  const p = statePath();
  if (!fs.existsSync(p)) return { tabs: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object') return { tabs: {} };
    if (!raw.tabs) raw.tabs = {};
    _migrateLegacyPopupPolicy(raw);
    // Clamp the jobsSnapshot cap on read so a corrupted state.json never
    // lands in the renderer. The clamp runs on read AND write — the
    // write-side clamp is authoritative (it persists), the read-side clamp
    // is defensive. Any invalid value falls back to the default (200);
    // the range is clamped to [20, 1000].
    if (raw.jobsArchiveCap != null) {
      const n = Number(raw.jobsArchiveCap);
      if (Number.isFinite(n) && n > 0) {
        raw.jobsArchiveCap = Math.max(20, Math.min(1000, Math.round(n)));
      } else {
        raw.jobsArchiveCap = 200;
      }
    }
    // Read-side sanitisation of pipelineAdvancedSettings using the same
    // shared helper as write() so the two paths can never drift. Without
    // this, a hand-edited state.json (or a future writer that bypasses the
    // write-side sanitiser) could land bogus values in the renderer.
    if (raw.pipelineAdvancedSettings && typeof raw.pipelineAdvancedSettings === 'object') {
      raw.pipelineAdvancedSettings = sanitisePipelineAdvancedSettings(raw.pipelineAdvancedSettings);
    }
    // Read-side sanitisation of autoCutSettings, using the same shared
    // helper as write() so the two paths can never drift.
    if (raw.autoCutSettings && typeof raw.autoCutSettings === 'object') {
      raw.autoCutSettings = sanitiseAutoCutSettings(raw.autoCutSettings);
    }
    // Read-side sanitisation of the Pipeline board. A corrupted state.json
    // must never crash the app or carry a bad model key into a spawn argv,
    // so the same never-throwing sanitiser as write() runs here.
    if (raw.pipeline && typeof raw.pipeline === 'object') {
      raw.pipeline = {
        image: sanitisePipelineBoard(raw.pipeline.image),
      };
    }
    // Sanitise the scalar model-key + settings fields on read too (see ./stateSanitizers.js).
    sanitiseScalarStateFields(raw);
    // Apply the popupPolicy normalisation on read as well, so an
    // invalid or legacy value from an earlier install is clamped to
    // the whitelist immediately on first launch (the write-side
    // normalisation alone only takes effect after the first save).
    _migrateLegacyPopupPolicy(raw);
    return raw;
  } catch (e) {
    require('./stateCorruptBackup').backupCorruptState(p, e); // P5 (M-044): keep the corrupt file for recovery; renderer toasts on next state:get
    return { tabs: {}, _corruptRecovered: true };
  }
}

function write(s) {
  const p = statePath();
  // Preserve everything: tabs (per-tab form values), currentTab (last active
  // tab), fbDirs (per-tab output folder), and the upscale-on-Generate toggle
  // + settings. Persisting only `tabs` would silently drop the per-tab folder
  // map and the last-active-tab on every save.
  // Run the shared migration helper here too (mutates s.popupPolicy in
  // place) so the on-disk value is resolved on first save. read() applies the
  // same migration so the first launch already sees the resolved value.
  _migrateLegacyPopupPolicy(s);
  const clean = {
    tabs: (s && s.tabs && typeof s.tabs === 'object') ? s.tabs : {},
    currentTab: (s && typeof s.currentTab === 'string') ? s.currentTab : null,
    fbDirs: (s && s.fbDirs && typeof s.fbDirs === 'object') ? s.fbDirs : {},
    upscaleEnabled: !!(s && s.upscaleEnabled),
    // The upscale settings now include the auto-crop options. They're
    // surfaced in ⚙ Settings → Upscale Settings, captured by the
    // Image tab's "Add" button into the batch queue, and applied
    // by the image tab's generate handler when state.upscaleEnabled
    // is on. The renderer whitelists cropAnchorX/Y against the
    // anchor cell values; we double-check here too in case a
    // corrupted state.json tries to sneak an arbitrary string
    // through.
    upscaleSettings: (s && s.upscaleSettings && typeof s.upscaleSettings === 'object')
      ? {
          // KGO8-008: clamp 1..8 like the pipeline column; `parseInt(x) || 2` bounded nothing.
          multiplier: Math.max(1, Math.min(8, parseInt(s.upscaleSettings.multiplier, 10) || 2)),
          autoCrop: !!(s.upscaleSettings.autoCrop),
          cropWidth: Math.max(0, parseInt(s.upscaleSettings.cropWidth, 10) || 0),
          cropHeight: Math.max(0, parseInt(s.upscaleSettings.cropHeight, 10) || 0),
          cropAnchorX: ['left', 'center', 'right'].includes(s.upscaleSettings.cropAnchorX)
            ? s.upscaleSettings.cropAnchorX : 'center',
          cropAnchorY: ['top', 'center', 'bottom'].includes(s.upscaleSettings.cropAnchorY)
            ? s.upscaleSettings.cropAnchorY : 'center',
        }
      : { multiplier: 2, autoCrop: false, cropWidth: 0, cropHeight: 0, cropAnchorX: 'center', cropAnchorY: 'center' },
    // Real-ESRGAN model name (default: the general-purpose 4× BSD-3
    // model). Whitelisted in app.js to a known set so a corrupted
    // state.json can't inject a path-traversal arg into the spawn.
    realesrganModel: (() => {
      const value = typeof s?.realesrganModel === 'string' ? s.realesrganModel.trim() : '';
      // Migration for the typo used in pre-fix state files.
      if (value === 'realesrgan-animevideov3') return 'realesr-animevideov3';
      return ['realesrgan-x4plus', 'realesrgan-x4plus-anime', 'realesr-animevideov3'].includes(value)
        ? value : 'realesrgan-x4plus';
    })(),
    // IS-Net background removal toggle. When true, the image tab's
    // generation handler and the right-click "Upscale" dialog will
    // run the optional isnetbg binary on the output. The standalone
    // right-click "Remove background" action does NOT depend on this
    // flag — it's an explicit user gesture every time.
    removeBackgroundEnabled: !!(s && s.removeBackgroundEnabled),
    // True = ask the binary to use the GPU (DirectML / CUDA / Vulkan,
    // whatever the binary supports); false = CPU. We coerce to a
    // boolean so a corrupted state.json can't sneak a string that
    // would be passed to --use-gpu as-is.
    removeBackgroundUseGpu: s?.removeBackgroundUseGpu === false ? false : true,
    // Which background-removal model to run. Whitelisted against the
    // model registry so a corrupted state.json can't inject a spawn arg
    // (same pattern as realesrganModel above).
    removeBackgroundModel: isKnownModel(s?.removeBackgroundModel)
      ? s.removeBackgroundModel
      : resolveAutoBestModel(), // PE-014: auto-best-compatible (BiRefNet Lite when available)
    // Global "Target file prefix" — prepended to every generated file's
    // name on all four tabs. Capped at 64 chars so a corrupted state.json
    // can't inject a long prefix. The renderer mirrors this string into
    // four inputs (one per tab) on every change. Without this field, the
    // user's prefix silently reset to "" on every app restart.
    filePrefix: (typeof s?.filePrefix === 'string')
      ? s.filePrefix.slice(0, 64)
      : '',
    // When true, every generated file is named only
    // `<prefix><6-digit number>.<ext>`. The "6-digit number, starting at
    // 000001" is the user's spec; the counter is per-run, NOT per-prefix, so
    // switching from "temp" to "out" yields `out000001.jpg`, not
    // `out000006.jpg`. Default: false (legacy slugified filenames).
    filePrefixForceOnly: s?.filePrefixForceOnly === true,
    // First-run prompt for the optional Real-ESRGAN binary. The
    // built-in multi-step canvas pipeline is always available, so the
    // prompt is informational only — but if the user dismisses it
    // once, we honour that and don't re-ask on every launch. Stored
    // here so the dismissal survives restarts.
    realesrganFirstRunDismissed: s?.realesrganFirstRunDismissed === true,
    // Image optimisation settings (post-generation pipeline +
    // folder-browser right-click menu). Persisted across launches
    // so the user only has to pick their preferred quality /
    // format / metadata policy once.
    //
    //   enabled:        master toggle for the post-generation flow
    //                   (the right-click menu ignores this and
    //                   always shows the dialog).
    //   quality:        1..100, the Sharp quality slider. We
    //                   hard-clamp to [1,100] here so a corrupted
    //                   state.json can't inject a 0 or a
    //                   negative number that would otherwise be
    //                   silently passed to libvips.
    //   format:         'keep' (preserve source format) | 'jpeg'
    //                   | 'png' | 'webp' | 'avif'. Whitelisted
    //                   against the same set the Sharp wrapper
    //                   accepts.
    //   stripMetadata:  drop non-essential EXIF (camera model,
    //                   GPS, software tag, etc.) but keep the
    //                   ICC colour profile so the image still
    //                   renders correctly on colour-managed
    //                   displays. The renderer passes this
    //                   through to window.api.optimizeImage
    //                   unchanged.
    optimizeSettings: (s && s.optimizeSettings && typeof s.optimizeSettings === 'object')
      ? {
          enabled: !!s.optimizeSettings.enabled,
          quality: Math.max(1, Math.min(100, Math.round(Number(s.optimizeSettings.quality) || 82))),
          format: ['keep', 'jpeg', 'png', 'webp', 'avif'].includes(s.optimizeSettings.format)
            ? s.optimizeSettings.format
            : 'keep',
          stripMetadata: s.optimizeSettings.stripMetadata !== false,
        }
      : { enabled: false, quality: 82, format: 'keep', stripMetadata: true },
    // Layout / splitter sizes for the 4 main areas (content,
    // folder browser, log, picture preview). All four are
    // pixel values; the JS drag handler clamps them to a
    // sensible range (matching the CSS min/max in
    // styles.css) before writing here, so a corrupted
    // state.json with a -1 or 999999 can never break the
    // layout. Defaults here mirror the CSS `:root` block
    // (sidebar 360px, logbar 280px, preview 360px) so a
    // fresh install opens with the same sizes the CSS
    // expects. Persisted across restarts so the user only
    // has to set their preferred column widths once.
    layoutSettings: (s && s.layoutSettings && typeof s.layoutSettings === 'object')
      ? {
          sidebarW: Math.max(180, Math.min(2000, Math.round(Number(s.layoutSettings.sidebarW) || 360))),
          logbarH:  Math.max(60,  Math.min(2000, Math.round(Number(s.layoutSettings.logbarH)  || 280))),
          previewW: Math.max(160, Math.min(2000, Math.round(Number(s.layoutSettings.previewW) || 360))),
        }
      : { sidebarW: 360, logbarH: 280, previewW: 360 },
    // File-browser sort mode (Name ↑/↓, Size ↑/↓, Newest / Oldest,
    // Created ↑/↓, Type). Whitelisted to the same set the dropdown
    // offers so a corrupted state.json can't inject a value that
    // would later be used in a comparator. The renderer also
    // re-validates on read.
    fbSort: (typeof s?.fbSort === 'string' && [
      'name-asc', 'name-desc',
      'size-desc', 'size-asc',
      'mtime-desc', 'mtime-asc',
      'created-desc', 'created-asc',
      'type-asc',
    ].includes(s.fbSort)) ? s.fbSort : 'name-asc',
    // File-browser column visibility (size, type, mtime, created,
    // path). Object keyed by column id with boolean values. The
    // main process round-trips the object verbatim — the renderer
    // is the source of truth on what columns are valid, so a
    // future column id added in a newer renderer survives the
    // round trip. We only defend against the file being a
    // non-object so a corrupted write can't crash the JSON parse.
    fbColumns: (s && typeof s.fbColumns === 'object' && s.fbColumns !== null)
      ? s.fbColumns
      : { size: true, type: false, mtime: false, created: false, path: false },
    // File-browser image thumbnail toggle. When true, image rows
    // in the folder explorer render a small centered thumbnail
    // of the actual image file (instead of the generic 🖼 icon).
    // Folder rows are unchanged either way. The renderer is the
    // source of truth on which files are images; we just
    // round-trip the boolean here so a corrupted state.json can't
    // sneak a string through.
    fbThumbnails: !!(s && s.fbThumbnails),
    // The file browser filters down to image / audio / video / text assets +
    // folders by default; the user can opt out via the Folder options dialog
    // to see every file.
    fbShowAllFiles: s?.fbShowAllFiles === true,
    // The package.json version the user last dismissed the "What's new" toast
    // for. The renderer shows the toast only when the current version differs
    // from this string, so a returning user sees the changelog once per
    // upgrade. Whitelisted as a plain string with a sane length cap.
    lastSeenVersion: (typeof s?.lastSeenVersion === 'string')
      ? s.lastSeenVersion.slice(0, 32)
      : '',
    // Popup display policy. Controls how the optional "first run"
    // / "tab intro" popups behave:
    //   'once-fresh'   — Show each popup until the user dismisses it;
    //                    then never show it again (across restarts).
    //   'per-session'  — Show each popup the first time it's
    //                    triggered after each app start; reset on
    //                    every launch.
    //   'never'        — default. Never show these informational popups
    //                    (welcome / tab-intro / optional add-ons).
    //   'always'       — Always show these popups (ignoring any
    //                    prior dismissal).
    // The default is 'never' so a fresh install shows none of the
    // informational popups. The required first-time setup (API key + output
    // folder) is NOT one of these — it shows whenever the config is
    // incomplete, independent of this policy (see openFirstTimeSetup).
    // Whitelisted so a corrupted state.json can't inject an arbitrary value.
    // The legacy-default migration is applied at the top of write() (mutates
    // s.popupPolicy in place) AND on read(), so by this point popupPolicy is
    // already the resolved value.
    popupPolicy: s?.popupPolicy,
    // Map of popup-id → ISO timestamp of when the user dismissed
    // it. Used by the 'once-fresh' policy to decide whether the
    // popup should still fire. Capped to a small set (popups a
    // user has dismissed + a small ring buffer for transient
    // entries) so the file doesn't grow unbounded if the app
    // ever logs a lot of popup ids.
    seenPopups: (s && typeof s.seenPopups === 'object' && s.seenPopups !== null && !Array.isArray(s.seenPopups))
      ? Object.fromEntries(Object.entries(s.seenPopups)
          .filter(([k, v]) => typeof k === 'string' && k.length <= 64 && typeof v === 'string' && v.length <= 32)
          .slice(-64))
      : {},
    // List of finished jobs (recent summary). The renderer appends a job
    // summary every time a job finishes. The list is FIFO-capped at
    // `state.config.jobsArchiveCap` (default 200, configurable 20..1000 in
    // ⚙ Settings → History). The cap is enforced on every write; trimmed
    // entries are appended to the JSONL archive (state.jobs.archive.jsonl)
    // so the user can search / clear long-term history without bloating
    // state.json. The list is `null` (not `[]`) until the first job
    // finishes — saves a needless empty array in state.json.
    jobsSnapshot: (s && Array.isArray(s.jobsSnapshot) ? s.jobsSnapshot : null),
    // Cap for the jobs list. Clamped to [20, 1000] so a corrupted state.json
    // cannot make the cap insanely high.
    jobsArchiveCap: (() => {
      const n = Number(s && s.jobsArchiveCap);
      if (!Number.isFinite(n) || n <= 0) return 200;
      return Math.max(20, Math.min(1000, Math.round(n)));
    })(),
    // The four settings below are each sanitised the same way their
    // neighbours are (boolean coercion / string whitelist) so a corrupted
    // state.json can't sneak a bad value through.
    // "Don't save my API key" checkbox state.
    apiKeyNoSave: s?.apiKeyNoSave === true,
    // File-browser type filter. Empty string = "All types". Capped at 256
    // chars (the comma-separated extension list is short in practice) so a
    // corrupted write can't bloat state.json.
    fbTypeFilter: (typeof s?.fbTypeFilter === 'string')
      ? s.fbTypeFilter.slice(0, 256)
      : '',
    // BatchGen "keep completed items" toggle. Default true matches the
    // original behaviour.
    batchesAutoRemove: s?.batchesAutoRemove !== false,
    // BatchGen example-export format. Whitelisted to the two formats the
    // export button actually emits.
    batchesExportFormat: ['md', 'txt'].includes(s?.batchesExportFormat)
      ? s.batchesExportFormat
      : 'md',
    // Per-feature advanced parameters the user can tune in ⚙ Settings →
    // Image → "Advanced pipeline settings…". Each sub-object is sanitised
    // independently so a corrupted state.json can't inject an out-of-range
    // number / a non-whitelisted string into a CLI arg or a sharp encoder
    // option. The defaults match the hard-coded behaviour so existing flows
    // produce identical output until the user explicitly changes something.
    //
    // Sanitisation is delegated to the shared sanitisePipelineAdvancedSettings
    // helper so the read path uses the same logic. The shared helper avoids
    // the `Number(x) || default` falsy-fallback that silently rejected 0
    // (so a user could never select "highest quality mp3", "no filter", or
    // "fastest encode").
    pipelineAdvancedSettings: sanitisePipelineAdvancedSettings(s && s.pipelineAdvancedSettings),
    // Image tab's "Auto-pipeline" toggle (send every generated image straight
    // into the Pipeline board). In the renderer's STATE_PERSIST_KEYS but was
    // missing from this whitelist, so it silently reset to off on every
    // restart (same bug class as columnFolders in sanitisePipelineBoard).
    autoPipelineEnabled: !!(s && s.autoPipelineEnabled),
    autoCutSettings: sanitiseAutoCutSettings(s && s.autoCutSettings),
    batchDirectMode: s ? s.batchDirectMode !== false : true, // H11-3: direct (snapshot) batch mode, default on.
    // PE-031: editor prefs persistence. Tool, brush size/opacity, FG/BG colours,
    // output format, and asset-panel collapsed state survive restarts. Each
    // field is clamped/whitelisted so a corrupted state.json can't inject bad values.
    imageEditorPrefs: (() => {
      const p = (s && s.imageEditorPrefs && typeof s.imageEditorPrefs === 'object') ? s.imageEditorPrefs : {};
      // KGO8-006: must list every toolBtn(…) id in imageEditorOverlay.js — 'spray'/'pipette'
      // were missing and silently reset to 'pen'. Guard: tests/unit/src/imageEditorToolWhitelist.test.js.
      const WL_TOOLS = ['pen', 'spray', 'eraser', 'pipette', 'move', 'zoom', 'select', 'heal', 'bar'];
      const WL_FMTS = ['png', 'jpg', 'jpeg', 'webp'];
      const hexColor = (v, def) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : def;
      return {
        tool: WL_TOOLS.includes(p.tool) ? p.tool : 'pen',
        brushSize: (() => { const n = Number(p.brushSize); return Number.isFinite(n) ? Math.max(1, Math.min(200, Math.round(n))) : 12; })(),
        brushOpacity: (() => { const n = Number(p.brushOpacity); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1; })(),
        fg: hexColor(p.fg, '#000000'),
        bg: hexColor(p.bg, '#ffffff'),
        outFormat: WL_FMTS.includes(p.outFormat) ? p.outFormat : 'png',
        assetPanelCollapsed: p.assetPanelCollapsed === true,
      };
    })(),
    // The Pipeline board. Sanitised on write AND read so a hand-edited
    // state.json can never land a bad model key (which ends up in a spawn
    // argv) or a dangling item. See src/stateSanitizers.js.
    pipeline: { image: sanitisePipelineBoard(s && s.pipeline && s.pipeline.image) },
  };
  // H-045: archive-first transaction. Previously the list was trimmed
  // FIRST and the archive appends ran inside a swallowed try/catch — a
  // failing append (disk full, permission error, archive path blocked)
  // silently DESTROYED the overflow entries. Now each overflow entry is
  // appended to the L3 archive BEFORE it is dropped from L2; entries whose
  // append failed STAY in state.json (the list temporarily exceeds the cap
  // rather than losing data) and the failure is reported to the caller via
  // the non-persisted _archiveWarnings/_jobsArchived fields (attached
  // AFTER the JSON is serialised, so they never land on disk).
  const archiveWarnings = [];
  let jobsArchived = 0;
  if (Array.isArray(clean.jobsSnapshot) && clean.jobsSnapshot.length > clean.jobsArchiveCap) {
    const overflowCount = clean.jobsSnapshot.length - clean.jobsArchiveCap;
    const overflow = clean.jobsSnapshot.slice(0, overflowCount);
    const archive = _archive();
    if (archive) {
      for (const entry of overflow) {
        const id = (entry && typeof entry.id === 'string') ? entry.id : null;
        if (id && _archivedIds.has(id)) { jobsArchived++; continue; } // retried save: already in L3
        try {
          archive.append(configDir(), entry);
          if (id) {
            _archivedIds.add(id);
            if (_archivedIds.size > 4000) {
              // Bounded memory: keep the newest half (Set preserves insertion order).
              const keep = Array.from(_archivedIds).slice(-2000);
              _archivedIds.clear();
              for (const k of keep) _archivedIds.add(k);
            }
          }
          jobsArchived++;
        } catch (e) {
          archiveWarnings.push('jobs archive append failed after ' + jobsArchived + '/' + overflowCount
            + ' overflow entries: ' + String((e && e.message) || e)
            + ' — keeping the remaining entries in state.json.');
          break; // disk full / permission error: stop, keep the rest in L2
        }
      }
    } else {
      archiveWarnings.push('jobs archive service unavailable — keeping ' + overflowCount + ' overflow entries in state.json.');
    }
    // Drop ONLY the entries that made it into the archive (or were already
    // there). On a clean run this trims exactly to the cap; on failure the
    // unarchived tail stays in L2 until a later save can archive it.
    if (jobsArchived > 0) clean.jobsSnapshot = clean.jobsSnapshot.slice(jobsArchived);
  }
  // Atomic write (tmp + rename) — temp name uses crypto.randomUUID()
  // (R0.1-006.Audit-Fix) to avoid same-ms collisions. A corrupt
  // state.json must never appear if the process is killed mid-write.
  const tmp = p + '.tmp-' + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  // H-044/H-045: report the archive outcome to the caller (state:set IPC →
  // renderer). Attached AFTER the serialisation above so neither field is
  // ever persisted to state.json.
  if (jobsArchived > 0) clean._jobsArchived = jobsArchived;
  if (archiveWarnings.length) clean._archiveWarnings = archiveWarnings;
  return clean;
}

module.exports = { read, write, statePath, _migrateLegacyPopupPolicy };
