// scripts/lint.js
// Atomic Architecture Linter: checks file sizes, "god words", and the dependency DAG.
// Complements scripts/check.js (binary preflight) — no conflict, since this
// linter inspects code structure, not binaries.
//
// Run with:
//   node scripts/lint.js
//
// Exit codes:
//   0 — all lint rules satisfied (or only warnings)
//   1 — at least one hard rule violated
//
// Rules:
//   HARD — file > 500 lines   → error
//   HARD — god word (Manager|Controller) in filename → error
//   HARD — cross-tier import (e.g. src/ → main/) → error
//   WARN — file > 300 lines   → warning (split recommended)
//   INFO — module count, largest file, average lines (metrics)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Directories to lint (source code, not build/dependencies)
const SCAN_DIRS = ['main', 'renderer', 'src'];

// Legacy files not yet refactored. They may exceed the 500-line limit but
// still emit a warning so the overhang stays visible.
const LEGACY_OVERSIZE = new Set([
  'app.js',              // Bootstrap + helpers (init + style + batch + keyboard)
  'imageTab.js',         // ImageTab build() (god-function, not meaningfully splittable)
  'imageEditorOverlay.js', // R4.4: persistent hosts per slot (PE-002) bumped it to 540 lines. R4.4.AuditFix: mintSlotId counter declaration (+18 LOC) bumped to 558 lines. R4.5 (PE-027+PE-035): setupSourceThumbDropZone call + activateSlot disposer + close-hook bumped to 616 lines. R4.6.AuditFix: zoomBtn doc-comment (+5 LOC) bumped to 625 lines.
  'musicTab.js',         // MusicTab build() + previews (god-function)
  'section07_Image_optimisation___compression.js',  // showUpscaleSettings (god-function)
  'fileBrowser1.js',     // list + render + multi-select + bulk-action worker
  'fileBrowser2b.js',    // preview pane (image / video / audio) + text preview
  'section03_Settings_tab_panes.js',  // General + Image + BatchGen + Styles + Popups + Shortcuts panes
  'section08_Image_pipeline__Upscale___Crop___Convert_.js',  // R1.5a.follow-up Phase 6: directory-grant for isnetbg + realesrgan (2 callsites) pushed it past 500; the pipeline form is a single intertwined render+IPC flow that's hard to split.
  'LogService.js',       // row layout + selection + keyboard + autoscroll + JobRunner integration (planned split target)
  'batchManager.js',     // per-tab re-entrancy check via _isTabRunningNow (no behaviour change); underlying god-function unchanged
  'batchImportHelper.js', // combo-select-enum branch in getTabInputValue/setTabInputValue pushed it past the 500-line limit. Mirrors the existing combo-select-number branch; decomposition deferred.
  'speechTab.js',         // --model change listener repopulates the voice dropdown. Module-scope to keep build() under 500 lines; file is still a god-function (variant loop + audio pipeline + 5 row kinds).
  'videoTab.js',          // Capability status notes and status-bar recovery actions are part of the tab's tightly-coupled generation flow.
  'JobRunner.js',         // _addLogSecondary grew with the primary-row vs suppressLogRow branching (appendLogDetails vs addLogEvent fallback). The branching routes mmx stderr lines into the correct log row instead of duplicating them.
  'modelSpecs.js',        // validateToolCombos + extended mmxPreflightConfirm signature pushed past 300 lines. Pure validation with no DOM/log side effects, kept co-located with the API spec data it validates.
  'audioCutter.js',       // Auto-cut SFX UI (config panel + detect/export handlers, ~300 lines) lives inside showAudioCutter's closure scope (deeply interleaved with el/state/srcPath/duration/redraw/secToX/fmtTime/addLog), so extraction is non-trivial and deferred.
  'mmx.js',               // H9-003: mmx-cli wrapper + version probe. The spawn/run/cancel/redaction logic is deeply interleaved (runMmx touches resolve, the arg allowlist, env-key handling, log redaction, and the proc table); splitting the version probe out would create a circular dep on findMmxEntry/findNodeExe.
  'imageEditorActions.js', // PE-030+PE-032: open-in scene bake + tool picker + save collision policy pushed past 500. Save/bake/heal/removeBg/external share activeSlot/activeSession/toast helpers; splitting would create a circular dep on the shared closure.
  'imageEditorTools.js', // kkkook1: tool-panel enhancements pushed past 500. Tools share the activeSlot/ctrl closure; splitting would create circular deps.
  'pipelineCard.js',     // KGO-003: pipelineTrash result handling pushed past 500. Card actions share the board/item closure; splitting would create circular deps.
]);

// "God words" — filenames with these suffixes are rejected.
const GOD_WORDS = [
  /\bManager\.js$/i,
  /\bController\.js$/i,
];

// Cross-tier import ban. Each tier may import only its allowed tiers
// (DAG requirement). Renderer files run in the browser and may NOT import
// any Node module. This does not statically check whether imports touch
// Node APIs (require('child_process') etc.) — Electron enforces that at
// runtime. It only verifies no renderer file `require()`s a path into
// main/ (a clear violation).
const ALLOWED_TIER_EDGES = {
  'main':     new Set(['main', 'src', 'node:built-in']),
  'renderer': new Set(['renderer']),
  'src':      new Set(['src', 'node:built-in']),
};

const HARD_LIMIT = 500;
const WARN_LIMIT = 300;

// Existing oversized modules are frozen at this baseline. They remain visible
// as warnings, but any growth is a hard failure until the module is split.
// This prevents the known regression hotspots from silently accumulating more
// responsibilities while allowing behavior-preserving refactors to land in
// small, reviewable changes.
//
// Ratchet policy (harness finding size-budget-ratchet-eroding):
//   1. Budgets only move DOWN. When a file shrinks more than RATCHET_SLACK
//      lines below its frozen baseline, lint fails until the baseline is
//      lowered to the new actual size (ratchet-down).
//   2. Every SIZE_BUDGETS entry must carry an inline `//` justification
//      comment naming the decision that set the number. lint checks its own
//      source for this, so a budget bump can never land silently.
//   Policy is documented in docs/DECISIONS_AND_RULES.md §2 (file-size limits).
const RATCHET_SLACK = 40;
const SIZE_BUDGETS = new Map([
  ['main/ipc/registerConfigIpc.js', 370], // baseline at ratchet freeze (config get/set + grant capture flow)
  ['main/ipc/registerFileBrowserIpc.js', 337], // baseline at ratchet freeze (fb IPC surface)
  ['main/ipc/registerMmxIpc.js', 384], // H9-003: cliVersion in diagnose + block-on-incompatible in mmx:run:job
  ['renderer/app.js', 2060], // DECOMPOSITION TARGET — do NOT bump further. Planned split: shortcut/keydown handling → renderer/services/shortcutRegistry.js, gen-poller + batch wiring → renderer/jobs/, style/import helpers → renderer/sections/. History: PE-018 shortcut-scope guard. BGR-002 CapabilityGuard boot order (+13). BUG #3 gen-poller wiring (+18). BUG #5 Ctrl+Enter scoping (+3). GEW-002 fbMove/fbCopy dual-grant (+5). kkkook1 M3 chat + reset/relaunch + import (+80). h7-fixes cancelPendingStateSave (+9). Premade styles import (+35).
  ['renderer/audioCutter.js', 851], // R7.5: mint a directory grant on the source folder + thread grantId through the 6 grant-gated audio IPC callsites (+20 LOC). BGR-009: fbExists grant (+2). BUG #13: fsExists unwraps the {ok,exists} envelope (infinite-loop fix, +7).
  ['renderer/components/ParamRow.js', 322], // baseline at ratchet freeze (param row builder variants)
  ['renderer/jobs/JobRunner.js', 502], // baseline at ratchet freeze (job lifecycle + log routing)
  ['renderer/overlays/imageEditorActions.js', 618], // PE-021: full RGBA alpha scan (replaced coarse step-15 sampling). PE-030: open-in sends current scene (baked temp PNG) + tool picker + {ok:false} check. PE-032: save collision policy (fbExists + overwrite confirm + nextFreeVersion auto-versioning). BGR-009: fbDelete grants (+8). R1.5b.2: externalToolsRun grant minting (+7). BUG #9: runRemoveBg natural-size bake (renderSceneAtNaturalSize + dispose-in-finally, +12). gewv2: GEW-003 outputPath/stderr fix, GEW-004 doSave {ok,path} contract, GEW-005/jpeg fabric-format-string bug (Fabric toDataURL({format}) silently falls back to PNG for full MIME strings — route all 3 formats through native toCanvasElement().toDataURL instead), GEW-007 outside-root save-as fallback, GEW-008 catch-path tmpOut cleanup (+57). Issue 6: refine opt-out pass-through in the removeBg postOpts (+1).
  ['renderer/overlays/imageEditorOverlay.js', 1139], // R4.4 (PE-002)...
  ['renderer/overlays/imageEditorTools.js', 508], // kkkook1: tool-panel enhancements (+8). Shares activeSlot/ctrl closure with overlay.
  ['renderer/pipeline/pipelineCard.js', 531], // KGO-003: pipelineTrash result handling pushed past 500. Card actions share the board/item closure; splitting would create circular deps.
  ['renderer/pipeline/pipelineOps.js', 485], // KGO2-019/020: stage completion toasts + pass-through warnings (+9).
  ['renderer/sections/section03_Settings_tab_panes.js', 930], // R1.2a: pickFolderFull + grant capture for config:set (+10). kkkook1: M3 chat settings pane + reset/relaunch controls (+33). h7-fixes issues 2+3: success toast + in-memory config wipe + relaunch delay on "Delete all local data" (+9). KGO-022: shortcut fallback list (+3). Premade styles import (+35).
  ['renderer/sections/section07_Image_optimisation___compression.js', 1191], // R1.5a.follow-up Phase 6: directory-grant on parent (read+write for source + sibling output) — was file-grant with 'read' which the handler's write-check rejected. BGR-009: 5 fbDelete grants (+8). BUG #7: auto-crop own try/catch (keep upscaled on crop failure, +12). cosm1: sub-1% optimize toast tone (+4). gewv2 GEW-010: rembg default-model fallback comment (+1).
  ['renderer/sections/section08_Image_pipeline__Upscale___Crop___Convert_.js', 535], // QA-018: try/finally RealESRGAN partial-output cleanup (+13).
  ['renderer/sections/section15_Optional_add_ons_popup__unified_.js', 339], // baseline at ratchet freeze (unified add-ons popup)
  ['renderer/sections/section23_Centralized_help_system.js', 329], // H8-F2-P4: +1 LOC for the editor.asset help topic (Asset Composer panel) + Asset-panel wording in editor.composite/editor.queue.
  ['renderer/sections/section24_State.js', 379], // H11-3: batchDirectMode persist key + default (inherent to the state module). PE-031: imageEditorPrefs persist key + default. gewv2 GEW-010: removeBackgroundModel default changed to birefnet-general-lite, +comment (+4).
  ['renderer/services/fileBrowser1.js', 980], // KGO2-012/018: container contextmenu + image viewer double-click (+15). // KGO2-012/018: container contextmenu + image viewer double-click (+15).
  ['renderer/services/fileBrowser2a.js', 347], // baseline at ratchet freeze (fb toolbar + sorting)
  ['renderer/services/fileBrowser2b.js', 845], // KGO2-012: showContainerContextMenu + fbClipboardPaste export (+27).
  ['renderer/services/LogService.js', 1044], // H10-4: Ctrl+C text-selection bailout (inherent to the keydown handler). BUG #4: primary-row routing guard (logEventId != null) + _findFirstSecondaryId _internal fix (+16). kkkook1: structured event log enhancements (+26). h7-fixes issue 4: convention-independent column-reverse scroll so autoscroll pins the newest row to the top (+12).
  ['renderer/specs/modelSpecs.js', 527], // baseline at ratchet freeze; validateToolCombos + mmxPreflightConfirm live here with the spec data they validate
  ['renderer/tabs/batchImportHelper.js', 1289], // KGO2-004: fenced batch-json import count calculation (+14). T3/T4/T6 (batchgen-ux): combined all-types confirmation modal (per-type paid-call counts, output-folder picker, subfolder opt-out checkbox) replaces the plain asyncConfirm in startAllBatchGen (+64).
  ['renderer/tabs/batchManager.js', 837], // H9-004/005/013/016/017/018 + H11-1C/3 + X3-01 + B.1: batch-owned grant minting for pure-batch flows. BGR-011/017/023: pipeline spellings + concurrent globals + stale grant (+7). BUG #5: `.actions` selector scoping (+5). gewv2 GEW-009/011: upscaleModel + removeBackgroundUseGpu rowPostprocess fields (+7). T3-T7 (batchgen-ux): startBatchGen opts (skipConfirm/outputDirBase/noTypeSubfolders), computeExpectedCalls extraction, per-type subfolder routing, preview notify on success, auto-close overlay on clean finish (+59). batchgen-ux review fixes: subfolder creation gated to direct mode + skipped-defective runs keep the overlay/log open (+5).
  ['renderer/tabs/imageTab.js', 1096], // Ratcheted down from 1164 (file shrank after refactors). GEN-003: model transparency note. R7.2b.J: isSubcommandAvailable('image') subcommand guard in Generate handler (+11).
  ['renderer/tabs/musicTab.js', 676], // H9-018 + R7.4: lyrics/instrumental/lyrics-optimizer controls + model-change disable + preflight fix. H3-B7: image viewer overlay extracted to overlays/imageViewerOverlay.js (-285 lines). Budget realigned to the actual post-refactor size. R7.2b.J: isSubcommandAvailable('music') subcommand guard in Generate handler (+9). kkkook1: minor UI tweaks (+7).
  ['renderer/tabs/speechTab.js', 576], // GEN-001: capability guard disables unsupported controls. R7.5: mmx grant threading + language-help reflow. Budget realigned to the actual size. R7.2b.J: isSubcommandAvailable('speech') subcommand guard in Generate handler (+7). kkkook1: minor UI tweaks (+7).
  ['renderer/tabs/videoTab.js', 501], // GEN-001/002: capability guard + model auto-resolution. BGR-001/003/004: flag ordering + fbExists grant (+6). R7.2b.J: isSubcommandAvailable('video') subcommand guard in Generate handler, kept to one compact line to minimise the bump (+2). kkkook1: footer layout change (+4).
  ['src/imageOptimizer.js', 320], // SYS-007: per-destination mutex
  ['src/isnetbg_node.js', 396], // H8-008 + H11-1A: CPU EP thread cap (cores−2) to stop the host freeze (inherent to the session-opts setup). Issue 6: --refine CLI flag parse + postOpts forwarding (+5).
  ['src/mmx.js', 542], // H9-003: probeMmxVersion + compareSemver + SUPPORTED_MMX
  ['src/state.js', 430], // PE-014: resolveAutoBestModel require for auto-best fallback. PE-031: imageEditorPrefs persistence whitelist with sanitization.
  ['src/stateSanitizers.js', 406], // PE-015: postprocess opts in removebg column + isnetbg advanced settings. Issue 6: refine flag in both isnetbg advanced + removebg column (+4).
]);

const errors = [];
const warnings = [];
const fileCount = { main: 0, renderer: 0, src: 0 };
const lineCount = { main: 0, renderer: 0, src: 0 };
const largest = { main: { rel: '', n: 0 }, renderer: { rel: '', n: 0 }, src: { rel: '', n: 0 } };

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (entry.isFile() && full.endsWith('.js')) {
      yield full;
    }
  }
}

function detectTier(rel) {
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('main/')) return 'main';
  if (norm.startsWith('renderer/')) return 'renderer';
  if (norm.startsWith('src/')) return 'src';
  return null;
}

function checkCrossTier(file, rel) {
  const tier = detectTier(rel);
  if (!tier) return;
  const allowed = ALLOWED_TIER_EDGES[tier];
  const src = fs.readFileSync(file, 'utf8');
  // Match require('./...') or require('../...') with relative paths.
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = requireRe.exec(src)) !== null) {
    const target = m[1];
    if (target.startsWith('node:') || target.startsWith('electron') || !target.startsWith('.')) continue;
    // Resolve the import relative to the file's directory.
    const fileDir = path.dirname(rel);
    const resolved = path.normalize(path.join(fileDir, target)).replace(/\\/g, '/');
    const targetTier = detectTier(resolved);
    if (targetTier && !allowed.has(targetTier)) {
      errors.push(`[DAG] ${rel} → ${resolved} — cross-tier import forbidden (${tier} → ${targetTier}).`);
    }
  }
}

function lint() {
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const base = path.basename(file);
      const lines = fs.readFileSync(file, 'utf8').split('\n').length;

      // Metrics
      const tier = detectTier(rel);
      if (tier) {
        fileCount[tier]++;
        lineCount[tier] += lines;
        if (lines > largest[tier].n) largest[tier] = { rel, n: lines };
      }

      // 1) God-word check
      for (const pat of GOD_WORDS) {
        if (pat.test(base)) {
          errors.push(`[GOD-WORD] ${rel} — filenames with "${pat.source}" are forbidden (SRP).`);
        }
      }

      // 2) Size limit. Existing oversized files cannot grow past their
      // recorded baseline; all other files use the normal hard limit.
      // Ratchet-down: when a budgeted file shrinks well below its baseline,
      // the baseline must be lowered so the reclaimed headroom cannot be
      // silently refilled.
      const budget = SIZE_BUDGETS.get(rel);
      if (budget != null && lines > budget) {
        errors.push(`[SIZE-BUDGET] ${rel} — ${lines} lines > frozen baseline ${budget}. Split the new code out.`);
      } else if (budget != null && lines <= budget - RATCHET_SLACK) {
        errors.push(`[RATCHET-DOWN] ${rel} — ${lines} lines is ${budget - lines} below baseline ${budget}. Lower the SIZE_BUDGETS entry to ${lines} (budgets only move down).`);
      } else if (lines > HARD_LIMIT && !LEGACY_OVERSIZE.has(base)) {
        errors.push(`[SIZE] ${rel} — ${lines} lines > ${HARD_LIMIT} (hard limit). Split the file.`);
      } else if (lines > WARN_LIMIT && LEGACY_OVERSIZE.has(base)) {
        warnings.push(`[SIZE] ${rel} — ${lines} lines > ${WARN_LIMIT} (legacy god-file).`);
      } else if (lines > WARN_LIMIT) {
        warnings.push(`[SIZE] ${rel} — ${lines} lines > ${WARN_LIMIT} (split recommended).`);
      }

      // 3) Cross-tier import check (DAG requirement)
      checkCrossTier(file, rel);
    }
  }

  // 4) Ratchet self-check: every SIZE_BUDGETS entry in this file must carry
  // an inline justification comment, so budget bumps are always explicit,
  // named decisions (ratchet policy rule 2).
  const selfSrc = fs.readFileSync(__filename, 'utf8');
  const entryRe = /^\s*\['([^']+)',\s*\d+\](?:,)?\s*(\/\/.*)?$/;
  for (const line of selfSrc.split('\n')) {
    const m = entryRe.exec(line);
    if (!m || !SIZE_BUDGETS.has(m[1])) continue;
    if (!m[2] || m[2].replace(/^\/\/\s*/, '').length < 10) {
      errors.push(`[RATCHET-POLICY] SIZE_BUDGETS entry for ${m[1]} has no justification comment. Every budget needs an inline // comment naming the decision that set it.`);
    }
  }

  // 5) Stale-budget check: a SIZE_BUDGETS entry for a file that no longer
  // exists is dead weight and hides renames — remove it.
  for (const rel of SIZE_BUDGETS.keys()) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      errors.push(`[RATCHET-POLICY] SIZE_BUDGETS entry for ${rel} points to a missing file. Remove or update the entry.`);
    }
  }
}

console.log('Atomic Architecture Linter');
console.log('===========================');
console.log('');

lint();

// Metrics
console.log('Module metrics:');
for (const tier of ['main', 'renderer', 'src']) {
  const avg = fileCount[tier] > 0 ? (lineCount[tier] / fileCount[tier]).toFixed(1) : '0';
  console.log(`  ${tier.padEnd(8)}  ${String(fileCount[tier]).padStart(3)} files, ` +
              `${String(lineCount[tier]).padStart(5)} lines total, ` +
              `avg ${avg} lines, largest: ${largest[tier].rel || '-'} (${largest[tier].n})`);
}
console.log('');

if (warnings.length) {
  console.log(`WARNINGS (${warnings.length}):`);
  for (const w of warnings) console.log(`  ⚠  ${w}`);
  console.log('');
}
if (errors.length) {
  console.log(`ERRORS (${errors.length}):`);
  for (const e of errors) console.log(`  ✗  ${e}`);
  console.log('');
  process.exit(1);
}
console.log('OK — all hard lint rules satisfied.');
process.exit(0);
