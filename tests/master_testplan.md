# Master Test Plan — MiniMax Assets Tool v1.0.0

> **100% Coverage · Real E2E Tests** · Window: 1400×900 @ (519, 0) · Screen: 1920×1080 · Theme: Dark
> API key: from environment variable (MINIMAX_API_KEY) · Element IDs: `tests/ui_map.json`
> Strategy: Combine multiple verification points per test to minimize screenshot/log reads.
> Video: limited to 3 generations/day → exactly 1 E2E video test (6s, 768P, single variant).

---

## Phase 1: Setup, Lifecycle & Navigation (Combined)

### TC_E2E_SETUP_001 — Cold Start + Welcome + Theme + Tab Navigation + Intro Popups
- **Goal:** Verify full app lifecycle, theme toggle, all 4 tabs, and tab intro popups in one pass
- **Pre-conditions:** App not running; config.txt has valid API key from env; popup policy = 'per-session' (or reset popup history first)
- **Steps:**
  1. Launch app (`npx electron .`)
  2. Verify window title contains "MiniMax Assets Tool"
  3. Move window to (519, 0), size 1400×900
  4. **Verify:** Welcome modal visible (BTN_OK present)
  5. Press `Escape` → verify modal closes, statusbar shows "Ready"
  6. Click `.brand` → verify welcome reopens → click BTN_OK
  7. Click `BTN_THEME` (🌓) → verify light theme → click again → verify dark restored
  8. Press `Ctrl+2` → verify Speech tab active → if tab intro popup appears, verify title "👋 Welcome to the Speech tab" + "Got it" button → click "Got it"
  9. Press `Ctrl+3` → verify Music tab active → dismiss intro if shown
  10. Press `Ctrl+4` → verify Video tab active → dismiss intro if shown
  11. Press `Ctrl+1` → verify Image tab active (prompt textarea visible)
  12. Verify "What's New" toast appears (if first launch of this version) → click headline to expand → click × to dismiss
- **Expected:** All tabs render, theme toggles, welcome modal works, intro popups fire once, What's New toast dismissable
- **Pass criteria:** Single screenshot after step 11 confirms Image tab + dark theme + Ready status

### TC_E2E_SETUP_002 — Quota + Settings + Connection Test + Add-ons
- **Goal:** Verify API connectivity, quota display, settings dialog, and add-ons popup in one pass
- **Steps:**
  1. Press `Ctrl+R` → verify quota value updates (not "No API key configured")
  2. Press `Ctrl+S` → verify settings modal opens with 9 tabs
  3. Click through all 9 tab buttons → verify each pane renders
  4. On General tab: click "Show" next to API key → verify key visible → click again → masked
  5. Click "Test connection" → verify success toast (green)
  6. Click "Diagnose" → verify diagnose dialog shows platform/electron/node/mmx info
  7. Close diagnose
  8. Navigate to Image tab in settings → click "🧩 Open add-ons installer" → verify add-ons popup opens with 3 cards (Real-ESRGAN, IS-Net binary, IS-Net model)
  9. Verify each card shows status ("Detected" green or "Not found")
  10. Click "🔄 Re-detect" → verify statuses refresh
  11. Click "Skip for now" → verify popup closes
  12. On General tab: click "🚀 Run first-time setup" → verify first-time setup wizard opens (API key input + output dir + region + Skip/Save)
  13. Click "Skip" → verify wizard closes
  14. Hover over a "?" help icon (e.g. next to API key) → wait 250ms → verify help tooltip appears → move mouse away → verify dismisses
  15. Press Escape → verify settings closes
- **Expected:** API key valid, quota shows real data, all settings panes render, add-ons popup functional, first-time setup wizard accessible, help tooltips work
- **Pass criteria:** Quota shows numeric value; test connection returns ok toast; add-ons statuses displayed; help tooltip appears on hover

### TC_E2E_SETUP_003 — File Browser + Sidebar + Layout
- **Goal:** Verify file browser navigation, filters, sort, splitters, folder options
- **Pre-conditions:** output_dir has at least 1 image file
- **Steps:**
  1. Verify `FB_PATH` shows configured output_dir
  2. Type "img" in `INPUT_FB_SEARCH` → verify list filters
  3. Clear filter → select "🖼 Images" in `SELECT_FB_TYPE` → verify only images
  4. Reset to "All types" → change sort to "Newest" → verify reorder
  5. Press `Ctrl+F` → verify focus jumps to search input
  6. Click `BTN_FB_OPTIONS` → check "Modified" column → close → verify column appears
  7. Drag `SPLITTER_SIDEBAR` left 50px → verify sidebar widens
  8. Click an image file → verify preview pane shows thumbnail
  9. Right-click the thumbnail in preview pane → verify context menu appears (same ops as fb-list: Open, Upscale, Edit, etc.) → close menu
  10. Double-click image → verify image viewer overlay opens (filename + zoom select visible)
  11. In viewer: change zoom to "Fit to window" → press `Escape` → verify overlay closes
- **Expected:** All file browser features functional, preview context menu works, viewer opens/closes
- **Pass criteria:** Final state shows fb-list with Modified column, preview has thumbnail, context menu rendered

---

## Phase 2: Image Generation E2E (Real API)

### TC_E2E_IMG_001 — Single Image Generation (Full Pipeline) + Tab Status Dots
- **Goal:** Generate a real image and verify the entire flow: prompt → generate → preview → log → file browser → viewer + tab status indicators
- **Steps:**
  1. On Image tab, clear prompt, type: "a red circle on white background, minimalist"
  2. Set `SELECT_ASPECT` = "1:1", `SELECT_N` = "1", `SELECT_VARIANTS` = "1×"
  3. Type "test_" in `INPUT_FILE_PREFIX` → click "+1" → verify changes to "test_1" (or increments rightmost digits)
  4. Verify char counter shows correct count
  5. Click `BTN_GENERATE` (or Ctrl+Enter)
  6. **Immediately verify:** Image tab shows red status dot; ETA timer appears (mm:ss); Active Jobs widget shows 🖼 job
  7. **Wait** for generation (statusbar shows busy → Ready)
  8. **Verify combined:**
     - Toast "Image generated." (green)
     - Red dot disappears (or green dot if on different tab)
     - Log panel has new entry with category "image" + result "ok"
     - File browser auto-refreshed → new .png file visible (filename starts with "test_1" prefix)
     - Preview pane shows generated image thumbnail
  9. Switch to Speech tab (Ctrl+2) → switch back (Ctrl+1) → verify green dot cleared
  10. Double-click the new file in fb-list → verify image viewer opens with correct dimensions
  11. In viewer: verify zoom dropdown works (switch to 50%) → press Escape
  12. Clear file prefix (set back to empty)
- **Expected:** Full generation pipeline works end-to-end, tab status dots + ETA functional, file prefix applied
- **Pass criteria:** New image file exists in output_dir with prefix, visible in viewer at correct dimensions
- **Cleanup:** None (file stays for pipeline tests)

### TC_E2E_IMG_002 — Multi-Image (--n 2) + Style Preset + Upscale + Style Preview
- **Goal:** Test --n generation, style prepending, style preview block, and post-generation upscale checkbox
- **Pre-conditions:** At least one style preset exists (create if needed via Ctrl+T)
- **Steps:**
  1. Open Style Settings (Ctrl+T) → create style "TestCircle" = "geometric, clean lines" → save → close
  2. On Image tab: select "TestCircle" from style dropdown
  3. Type prompt: "blue square" → verify counter includes style prefix length
  4. Expand style-preview-details (<details> below dropdown) → verify shows "geometric, clean lines, blue square" with prefix highlighted → collapse
  5. Set `SELECT_N` = "2", `SELECT_VARIANTS` = "1×"
  6. Check `CB_UPSCALE` checkbox → verify "(2×)" appears in label
  7. Click Generate → wait for completion
  8. **Verify combined:**
     - Toast mentions "2 images saved"
     - File browser shows 2 new files
     - Upscaled versions also created (larger dimensions)
  9. Reset: uncheck upscale, set N=1, style=(no style)
- **Expected:** --n produces multiple images, style prepends, style preview shows combined prompt, upscale chain runs
- **Pass criteria:** 2 base images + 2 upscaled images in output_dir

### TC_E2E_IMG_003 — Validation Guards + Error Panel
- **Goal:** Verify all generation guards and the error panel UI
- **Steps:**
  1. Clear prompt AND set style to "(no style)" → click Generate → verify warning toast "Prompt is required"
  2. Type 1501 characters → verify counter shows over-limit / input blocked
  3. Set `SELECT_VARIANTS` = "3×" → verify `SELECT_SEED` becomes disabled
  4. Set variants back to "1×" → verify seed re-enables
  5. Type "notafile.xyz" in subject-ref → verify validation warning
  6. Clear subject-ref → type valid path "C:\temp\test.png" → verify warning clears
  7. Set width=100 (not div by 8) → verify dimension guard warning appears
  8. Reset all to defaults
- **Expected:** All guards block invalid input with appropriate messages
- **Pass criteria:** No generation started, all warnings visible

### TC_E2E_IMG_004 — Import + Examples Buttons
- **Goal:** Verify Import dialog and Examples functionality
- **Steps:**
  1. Click `BTN_IMPORT` (📥 Import…) → verify import dialog/modal opens
  2. Close import dialog (Escape/Cancel)
  3. Click `BTN_EXAMPLES` → verify examples content appears (sample prompts)
  4. Click an example → verify prompt textarea populated
  5. Clear prompt
- **Expected:** Import and Examples UIs render and function

---

## Phase 3: Speech Generation E2E (Real API)

### TC_E2E_SPCH_001 — Speech Generation (Full Flow)
- **Goal:** Generate real speech audio and verify the complete flow
- **Steps:**
  1. Press `Ctrl+2` → Speech tab
  2. Type text: "Hello, this is a test of the MiniMax speech generation system."
  3. Verify model = "speech-2.8-hd", voice populated (300+ options)
  4. Set speed = "1", format = "mp3", sample-rate = "32000"
  5. Click Generate → wait for completion
  6. **Verify combined:**
     - Toast "Speech generated." or similar success
     - Log entry with category "speech" + result "ok"
     - File browser shows new .mp3 file
     - Preview pane shows audio player or file info
  7. Right-click the .mp3 file → verify context menu shows "✂ Audio cut…" (no image ops)
  8. Close context menu
- **Expected:** Speech generated, saved as mp3, context menu is audio-specific
- **Pass criteria:** .mp3 file exists in output_dir with non-zero size

### TC_E2E_SPCH_002 — Model Change + Voice Repopulation + Parameters
- **Goal:** Verify model switching repopulates voices and parameter ranges
- **Steps:**
  1. Change model to "speech-01-turbo" → verify voice dropdown repopulates
  2. Verify speed options: 0.5–2.0, volume: 1–10, pitch: -12 to +12
  3. Set language boost to "en" → verify accepted
  4. Set subtitles to "On" → verify accepted
  5. Verify sound-effect field is disabled
  6. Reset model to "speech-2.8-hd"
- **Expected:** Voice list updates per model, all parameter ranges correct

---

## Phase 4: Music Generation E2E (Real API)

### TC_E2E_MUS_001 — Music Generation (Full Flow)
- **Goal:** Generate real music and verify the complete flow
- **Steps:**
  1. Press `Ctrl+3` → Music tab
  2. Type prompt: "calm piano melody, 15 seconds, lo-fi ambient"
  3. Set model = "music-2.6", genre = "lo-fi", mood = "calm"
  4. Set instrumental = "On", format = "mp3"
  5. Click Generate → wait for completion (music takes longer)
  6. **Verify combined:**
     - Success toast
     - Log entry with category "music" + result "ok"
     - File browser shows new .mp3 file
  7. Verify file size > 0 in file browser
- **Expected:** Music generated and saved
- **Pass criteria:** .mp3 file in output_dir, non-zero size
- **Note:** Music generation may take 30-60s

### TC_E2E_MUS_002 — Custom Inputs + BPM Validation
- **Goal:** Verify custom genre/mood input and BPM constraints
- **Steps:**
  1. In genre dropdown, type custom value "shoegaze" → verify accepted
  2. Set BPM to 120 → verify accepted
  3. Attempt BPM = 30 (below 40) → verify rejected/clamped
  4. Set key = "C major", tempo = "slow", structure = "verse-chorus-verse-chorus"
  5. Verify lyrics-optimizer toggle works (Off → On)
  6. Reset all to defaults
- **Expected:** Custom inputs accepted, BPM constrained to 40-220

---

## Phase 5: Video Generation E2E (Limited — 1 Test Only)

### TC_E2E_VID_001 — Video Generation (Single, Conservative)
- **Goal:** Verify video generation works (uses 1 of 3 daily quota)
- **Pre-conditions:** Check quota allows video; use cheapest settings
- **Steps:**
  1. Press `Ctrl+4` → Video tab
  2. Type prompt: "a simple red ball bouncing on a flat surface"
  3. Set model = "MiniMax-Hailuo-2.3-Fast" (fastest)
  4. Set duration = "6s", resolution = "768P"
  5. Set poll-interval = "5"
  6. Verify first-frame / last-frame / subject-image inputs visible with "Browse…" buttons → click Browse on first-frame → verify file picker opens → cancel
  7. Verify CapabilityGuard state: note which controls are disabled
  8. Click Generate → wait for completion (may take 2-5 min)
  9. **Verify combined:**
     - Success toast
     - Log entry with category "video" + result "ok"
     - File browser shows new .mp4 file
  10. Verify model-resolution dependency: switch to "MiniMax-Hailuo-02" → verify resolution options change
- **Expected:** Video generated at 768P/6s
- **Pass criteria:** .mp4 file in output_dir
- **IMPORTANT:** This uses 1/3 daily video quota. Do NOT run more video tests.

---

## Phase 6: Pipeline Overlay E2E (Full Workflow)

### TC_E2E_PIPE_001 — Pipeline Load + Column Progression + Export
- **Goal:** Full pipeline workflow: load image → advance through columns → finalize → export
- **Pre-conditions:** At least 1 image in output_dir (from Phase 2)
- **Steps:**
  1. Click `BTN_PIPELINE` → verify overlay opens with 7 columns
  2. Verify summary shows "0 images"
  3. Click "📁 Load from disc…" → select the generated image → verify card appears in Original
  4. Verify summary updates to "1 image"
  5. Verify card shows: thumbnail, filename, dims in info panel
  6. Click "⏭ to Upscale" → verify card moves to Upscale column
  7. In Upscale card: open "⚙ Settings" → verify multiplier/model/canvas-fallback controls
  8. Set multiplier = 2 → click "⏭ Skip" → verify card moves to Remove BG (skips upscale)
  9. Click "⏭ Skip" → moves to Crop
  10. In Crop settings: set W=200, H=200, anchorX=center, anchorY=center
  11. Click "▶ Run" → wait → verify card advances to Resize column
  12. In Resize: set W=100, H=100 → click "▶ Run" → verify advances to Optimize
  13. In Optimize: set format=webp, quality=82 → click "▶ Run" → verify advances to Final
  14. Verify card in Final column shows: Back, Open, Reveal, Export copy, Save & Remove, Remove, Duplicate
  15. Click "📦 Final column ▾" → verify menu shows 6 options
  16. Choose "📥 Export all (keep on board)" → select a destination folder
  17. Verify success toast + file exported + card stays on board
  18. Press Escape → verify pipeline closes, file browser refreshes
- **Expected:** Full pipeline progression works, export successful
- **Pass criteria:** Exported .webp file in chosen folder, card still in Final column

### TC_E2E_PIPE_002 — Pipeline Card Operations (Rename, Duplicate, Replace, Delete, Finalize)
- **Goal:** Verify all card-level operations including Finalize shortcut
- **Steps:**
  1. Reopen pipeline → verify previous card still in Final
  2. Click card name → verify rename modal opens → type "test_renamed" → Save → verify name updates
  3. Click "⧉ Duplicate" → confirm → verify second card appears below
  4. On duplicate: click "⏪ Back" → verify moves to Optimize column
  5. Click "⏪ Back" again → verify moves to Resize column
  6. Click "✓ Finalize" → verify card jumps directly to Final column (skips remaining stages)
  7. Click "⏪ Back" → verify moves back to Optimize
  8. Click "↺ Replace…" → select a different image → verify thumbnail updates
  9. Click "🗑 Delete" → verify card removed + toast "Removed (Undo available…)"
  10. Verify badge count decreased
  11. On remaining Final card: click "👁 Open" → verify image viewer opens → Escape
  12. Click "📂 Reveal" → verify Explorer opens (or reveal attempted)
- **Expected:** All card operations functional, Finalize jumps to Final from any active column
- **Pass criteria:** Rename persists, duplicate creates new card, Finalize shortcuts to Final, delete removes

### TC_E2E_PIPE_003 — Filter + Drag-Drop + Clipboard Paste + Folder + Auto-Enqueue + Correct
- **Goal:** Verify filter, all import methods (drag-drop, clipboard paste, load from disc), workspace folder, auto-enqueue, and crop Correct button
- **Steps:**
  1. With pipeline open, type in `INPUT_FILTER` → verify non-matching cards hidden
  2. Clear filter → verify all cards return
  3. Click "📂 Folder…" → verify folder picker opens → select output_dir → verify toast "Workspace set to: …"
  4. Copy an image to clipboard (e.g. from viewer or external) → press `Ctrl+V` → verify new card appears in Original column (clipboard_<ts>_<rnd>.png)
  5. Close pipeline
  6. Check `CB_AUTO_PIPELINE` on Image tab
  7. Generate a quick image (short prompt) → verify pipeline badge increments
  8. Open pipeline → verify new card in Original column
  9. Advance the new card to Crop column (⏭ to Upscale → ⏭ Skip → now in Crop)
  10. In Crop column, verify "🩹 Correct" button visible → click it → verify image editor opens with "💾 Save to pipeline" label
  11. Close editor (Cancel) → verify returns to pipeline
  12. Uncheck `CB_AUTO_PIPELINE`
- **Expected:** Filter works, clipboard paste creates card, Folder sets workspace, auto-enqueue functional, Correct opens editor
- **Pass criteria:** Clipboard paste card in Original, Correct opens editor with pipeline save label

### TC_E2E_PIPE_004 — Pipeline Final Column Clear + Report
- **Goal:** Verify clear and report generation
- **Pre-conditions:** Report dir configured in settings (or use output_dir)
- **Steps:**
  1. With cards in Final column, click "📦 Final column ▾"
  2. Choose "📋 Clear with report" → confirm
  3. Verify cards removed from Final
  4. Verify toast mentions report path
  5. Verify .md report file exists in report folder
- **Expected:** Clear removes cards, report written
- **Pass criteria:** Report .md file exists with asset details

---

## Phase 7: Image Editor (Paint Editor) E2E

### TC_E2E_EDIT_001 — Editor Open + Load + Draw + Save
- **Goal:** Full paint editor workflow: open → load image → draw → save
- **Pre-conditions:** At least 1 image in output_dir
- **Steps:**
  1. Click `BTN_IMAGE_EDIT` (✏) → verify 3-pane layout (tool rail, canvas, collapsed asset panel)
  2. Verify empty state: "No image loaded" + "📂 Load image…" button
  3. Click "📂 Load image…" → select an image → verify rendered on canvas
  4. Verify zoom controls active (Fit, −, +, 100%)
  5. Press `B` → verify pen tool active (cursor changes)
  6. Draw a stroke on canvas (click-drag)
  7. Press `E` → verify eraser tool → erase part of stroke
  8. Press `[` → verify brush size decreases → press `]` → increases
  9. Press `X` → verify FG/BG colors swap → press `D` → reset to black/white
  10. Press `Ctrl+Z` → verify undo (stroke removed) → press `Ctrl+Y` → redo
  11. Select format = "PNG (transparency)" in footer
  12. Click "💾 Save" (Ctrl+S) → verify success toast + file saved
  13. Press Escape → verify editor closes
- **Expected:** Full draw/edit/save cycle works
- **Pass criteria:** Modified image saved to disk, undo/redo functional

### TC_E2E_EDIT_002 — All Tools + Zoom + Cheatsheet + Objects List + Resize Canvas
- **Goal:** Verify all 9 tools, zoom controls, help cheatsheet, objects list management, and resize canvas
- **Steps:**
  1. Reopen editor with loaded image
  2. Press each tool key: B, A, E, I, V, Z, H, M, L → verify each activates
  3. For `L` (bar tool): click once (anchor) → move → click again → verify bar placed
  4. For `I` (pipette): click on image → verify FG color changes to clicked pixel
  5. For `M` (select): drag a rectangle → verify selection marquee appears
  6. Click Fit (Ctrl+0) → verify zoom = fit → click 100% (Ctrl+1) → verify 100%
  7. Click + → verify zoom in → click − → verify zoom out
  8. Click "?" → verify cheatsheet modal with all shortcuts → close
  9. **Objects list:** Verify the bar appears in Objects list ("Bar 1") with ↑/↓/↔/↕/✖ buttons
  10. Click ↔ (flip H) on Bar 1 → verify bar flips → Ctrl+Z → verify undo
  11. Click ↑ (bring forward) → verify z-order changes
  12. **Resize canvas:** In right panel, locate "📐 Resize canvas" section → type W=400 → verify H auto-calculates (chain linked) → click Apply → verify canvas resizes → Ctrl+Z to undo
- **Expected:** All tools functional, zoom works, cheatsheet renders, objects list manages layers, resize canvas works
- **Pass criteria:** Each tool key changes active tool indicator; objects list buttons functional; resize applies + undoes

### TC_E2E_EDIT_003 — Asset Panel + Generate + Composite + Queue Bar
- **Goal:** Verify Asset Composer: expand, load, generate, send to canvas, blend, and multi-image queue bar
- **Steps:**
  1. In editor, click "«" to expand Asset panel
  2. Verify tabs 1/2/3, Load/Generate/Send/RemoveBG buttons visible
  3. Click "📂 Load…" → select an image → verify loaded in asset canvas
  4. Set blend mode = "multiply" → verify dropdown changes
  5. Set opacity slider to 50 → verify applied
  6. Click "→ Send to canvas" → verify asset appears as transformable object on main canvas
  7. Press `V` (move tool) → drag the placed object → verify it moves
  8. Click "✨ Generate…" → verify popover with prompt/W/H/count fields
  9. Type prompt "small green star" → click Generate → wait → verify result loaded in asset panel
  10. Verify history strip shows generated thumbnail
  11. **Queue bar:** Load a second image (📂 Load image…) → verify filmstrip/queue bar shows 2 thumbnails at bottom
  12. Click second thumbnail → verify canvas switches to second image
  13. Click first thumbnail → verify returns to first image (modified indicator visible)
  14. Right-click on asset canvas → verify context menu appears (📂 Load…, ✨ Generate…, ✂ Remove BG, → Send to canvas, 💾 Export as PNG, 🧹 Clear asset) → click elsewhere to dismiss
  15. Click "⇄ Swap" → verify main canvas and asset canvas contents swap
  16. Click "💾 Export…" → verify export dialog (Save As PNG)
  17. Close editor (Cancel)
- **Expected:** Full asset compositing workflow functional, queue bar switches between editing slots, right-click context menu + swap + export work
- **Pass criteria:** Asset placed on canvas, generation produces result in history, queue bar switches slots, context menu renders all 6 items

### TC_E2E_EDIT_004 — Heal / Inpaint + Remove BG + Bake
- **Goal:** Verify heal menu, inpaint operations, remove BG, and bake
- **Steps:**
  1. In editor with image loaded, click "🩹 Heal ▾" in footer
  2. Verify menu shows: Heal Selection, Heal Transparency, Resynthesize, Manage heal models
  3. Click "🩹 Heal Selection" → verify popover with engine/mode/Start
  4. Cancel popover
  5. Click "🧠 Manage heal models…" → verify models overlay (MI-GAN, LaMa status)
  6. Close models overlay
  7. Click "✂ Remove BG" in footer → verify remove BG runs (or overlay opens)
  8. Click "↻ Bake" → verify layers flattened (toast or visual change)
  9. Click "🔧 Open in…" → verify external tools menu (or "no tools" toast)
- **Expected:** Heal system accessible, Remove BG functional, Bake flattens
- **Pass criteria:** Each menu/operation opens without crash

### TC_E2E_EDIT_005 — Editor from Image Viewer + Context Menu Edit
- **Goal:** Verify editor opens from viewer ✏ button and from context menu
- **Steps:**
  1. In file browser, double-click an image → viewer opens
  2. Click "✏" button in viewer header → verify viewer closes, editor opens with that image
  3. Close editor (Escape)
  4. Right-click image in fb-list → click "✏ Edit" → verify editor opens with that image
  5. Close editor
- **Expected:** Both paths open editor with correct image loaded

---

## Phase 8: BatchGen E2E (Real API)

### TC_E2E_BATCH_001 — BatchGen Queue + Execution + Progress Overlay (Image Tab)
- **Goal:** Create a 2-prompt batch, execute sequentially, and verify the progress overlay UI
- **Steps:**
  1. On Image tab, verify batch controls bar shows "⚙ Batch Mode" (empty queue)
  2. Press `Ctrl+B` → verify "BatchGen — Image Tab" opens
  3. Click "+ Add prompt" → type "a green triangle"
  4. Click "+ Add prompt" → type "a yellow star"
  5. Verify Save counter shows (2)
  6. Click ↑ on row 2 → verify order swaps (star first)
  7. Click "Save (2)" → verify batch saved + dialog closes
  8. Verify batch controls bar now shows "▶ Start BatchGen (2)" + "✎" edit button
  9. Click "▶ Start BatchGen (2)" → verify confirm dialog ("2 paid API calls") → click OK
  10. **Verify batch progress overlay appears:**
      - Title "BatchGen — Image"
      - Counter "1 / 2" → updates to "2 / 2"
      - Progress bar advances
      - Current prompt text shown (truncated at 200 chars)
      - Elapsed timer ticking ("Elapsed: 0m Xs")
      - Log area shows ✓ lines per completed item
      - "■ Stop batch" button visible
  11. **Wait** for both to complete
  12. **Verify combined:**
      - Stop button changes to "Close"
      - 2 new image files in output_dir
      - Log has 2 "image" entries with result "ok"
      - Active Jobs widget disappears after completion
      - Toast "BatchGen done: 2 ok, 0 failed."
  13. Click "Close" on overlay → verify overlay removed
  14. Verify batch controls bar updates (items auto-removed if enabled)
- **Expected:** Sequential batch execution produces 2 images with full progress UI
- **Pass criteria:** Both files exist, log shows 2 successes, progress overlay rendered correctly

### TC_E2E_BATCH_002 — Bulk Paste + Clear All + Queue Management + Import from File
- **Goal:** Verify bulk paste, clear all confirmation, queue controls, and file import
- **Steps:**
  1. Open BatchGen (Ctrl+B)
  2. Click "Bulk paste…" → verify nested modal with textarea ("Bulk import" title)
  3. Paste 3 lines: "prompt A\nprompt B\nprompt C" → click "Import" → verify 3 rows created + toast "Imported 3 prompts."
  4. Click ✕ on row 2 → verify removed, counter shows (2)
  5. Click "Clear all" → verify confirm() dialog → click OK → verify all removed
  6. Click "Close" → verify dialog closes without saving
  7. On Image tab, click "📥 Import…" in batch controls → verify file picker opens (filters: .txt, .md)
  8. Cancel file picker → verify no crash
  9. Click "Examples" button → verify Save-As dialog opens → cancel
- **Expected:** Bulk paste creates rows, clear all confirms, close discards, import/examples buttons functional

### TC_E2E_BATCH_003 — BatGen All Types + Dashboard + Stop Mid-Run
- **Goal:** Verify cross-tab batch orchestration (BatGen All Types), the dashboard modal, and stopping a batch mid-run
- **Pre-conditions:** At least 1 prompt in Image batch queue AND 1 text in Speech batch queue (add via Ctrl+B on each tab)
- **Steps:**
  1. Add 2 prompts to Image batch (Ctrl+B → add "circle" + "square" → Save)
  2. Switch to Speech tab (Ctrl+2) → add 1 text to Speech batch (Ctrl+B → add "Hello world" → Save)
  3. Verify "▶ BatGen All Types (3)" button appears in batch controls bar (gold/amber styling)
  4. Verify "✎" edit button next to it
  5. Click "✎" → verify "🗂 BatchGen — All Types Dashboard" modal opens:
     - "▶ Currently running" section shows "No batch is currently running"
     - "📋 Upcoming items by tab" shows 🖼 Image (2 items) + 🗣 Speech (1 item)
     - Per-tab model + style + ETA displayed
     - Grand total ETA shown
  6. Close dashboard (✕ Close)
  7. Click "▶ BatGen All Types (3)" → verify confirm dialog → accept
  8. **Verify:** Batch starts on Image tab first (sequential across tabs)
     - Batch progress overlay appears
     - "⏱" ETA span visible next to BatGen All Types button
  9. **During first item generation:** Click "■ Stop batch" → verify:
     - Batch aborts (log shows "Aborted at item N")
     - Stop button changes to "Close"
     - Toast shows partial results
  10. Click "Close" → verify overlay removed
  11. Verify batch controls bar updates (remaining items still queued)
- **Expected:** BatGen All Types orchestrates across tabs, dashboard shows per-tab overview, stop aborts gracefully
- **Pass criteria:** Dashboard renders per-tab data, stop mid-run aborts without crash, remaining items preserved
- **Cleanup:** Clear remaining batch items (Ctrl+B → Clear all → Save)

### TC_E2E_BATCH_004 — Full AI Import/Export Flow: Template Export → Asset Identification → Import → Batch Generate All → Verify
- **Goal:** Exercise the complete "AI-assisted batch import" workflow end-to-end: export the instruction template, act as the AI that reads a creative document (`_testtext1.txt`), identify all assets, produce a valid import file, import it, batch-generate across all types, and verify every result.
- **Pre-conditions:** App running; API key valid; `_testtext1.txt` exists in project root; batch queues empty; NO video (conserve daily quota)
- **Source material:** `_testtext1.txt` — German screenplay "DIE LETZTE BOTSCHAFT" (2 scenes, 3 characters, 2 music cues, 5 visual descriptions)
- **Steps:**

  **Part A — Export the Import Template**
  1. On Image tab, click "Examples" button in batch controls bar
  2. Save-As dialog appears → save as `_test_template_export.md` in project root
  3. Verify success toast "Saved import document to …"
  4. Open the exported file → verify it contains:
     - "# MiniMax Asset Tool — Import Instruction Manual" heading
     - §1 Expected output format (pipe-table + fenced batch-json)
     - §2 Style preset header syntax
     - §4 Detailed parameters per type (image/speech/music/video)
     - HARD character limits (image=1500, speech=10000, music=2000)
     - Example import rows

  **Part B — AI Asset Identification (simulate external LLM using ONLY the template)**
  5. Read `_testtext1.txt` and identify all generatable assets per the template's Phase 1 rules:
     - **Images (5):** lighthouse exterior/storm, Mara character portrait, interior hall, radio device, the faceless entity
     - **Speech (4):** Mara line 1, Father radio message, Entity line, Mara line 2
     - **Music (2):** opening dark orchestra, tense entity appearance
  6. Following the template's Phase 2 (decision questions — pre-answered for this test):
     - Output folder: default configured dir
     - Pipeline: no auto-pipeline (save as-is)
     - Style: YES — shared cinematic style from the screenplay's BILDSTIMMUNG
     - Variants: 1 per asset (efficiency)
     - Format: default (PNG images, MP3 audio)
     - Naming: default prompt-derived
  7. Produce the import file `_testtext1_import.md` with this exact content:
     ```
     style: LetzteBotschaft = "realistic, cinematic, cold blue and grey tones, strong rain, wet surfaces, dramatic clouds, warm lighthouse light accents"

     | Type | Prompt / Text | Parameters |
     |---|---|---|
     | image | A massive old lighthouse on a narrow rocky headland at night during a violent storm, high waves crashing against black cliffs, white foam, moss-covered weathered walls, broken windows, irregular rotating light at the tower top, distant lightning illuminating a small drifting sailboat | --model image-01 --aspect-ratio 16:9 |
     | image | A young woman in her early thirties standing before a massive wooden door carved with a circular symbol of three stars above an open hand, she wears a long dark green coat, heavy boots, a leather backpack, wet black hair clinging to her face, holding a flickering brass lantern in her right hand | --model image-01 --aspect-ratio 9:16 |
     | image | Interior of a round narrow lighthouse entrance hall, iron spiral staircase leading up, yellowed nautical maps and old photographs and rusty tools on walls, water dripping through ceiling cracks, broken glass on the floor, a small wooden table with a mechanical radio device made of dark wood and brass knobs with a large round frequency dial, a green control lamp glowing | --model image-01 --aspect-ratio 4:3 |
     | image | Close-up of a vintage mechanical radio device on a wooden table, dark wood housing, polished brass knobs, large round frequency display, a single glowing green indicator lamp, dust particles in dim light, no electricity yet the lamp shines | --model image-01 --aspect-ratio 1:1 |
     | image | A tall unnaturally thin figure at the top of an iron spiral staircase, body hidden by a long wet coat, where the face should be there is only a smooth mirror-like reflective surface, long fingers made of black glass resting on the railing, dim lighthouse interior, horror atmosphere | --model image-01 --aspect-ratio 9:16 |
     | speech | Bitte lass mich nicht zu spät sein. | --model speech-2.8-hd --voice English_captivating_female1 --speed 0.95 --language de |
     | speech | Mara, wenn du diese Nachricht hörst, hat das Licht bereits begonnen zu erlöschen. Du kannst mich nicht erreichen. Diese Übertragung wurde vor sieben Jahren aufgenommen. Im oberen Raum findest du eine Linse aus schwarzem Glas. Sie darf niemals das erste Licht des Morgens sehen. Bring sie vor Sonnenaufgang zur Klippe und wirf sie ins Meer. Und Mara, vertraue nicht der Stimme, die wie meine klingt. | --model speech-2.8-hd --voice English_ManWithDeepVoice --speed 0.9 --language de |
     | speech | Er hat dich also doch gerufen. Ich bin der Grund, warum das Licht niemals erlöschen darf. | --model speech-2.8-hd --voice English_Deep-VoicedGentleman --speed 0.85 --language de |
     | speech | Dann muss ich wohl nach oben. | --model speech-2.8-hd --voice English_captivating_female1 --speed 0.9 --language de |
     | music | Slow dark orchestral piece, deep strings, single piano notes, a distant almost human-sounding choir, begins very quietly and gradually grows, cinematic film score, melancholic and foreboding atmosphere | --model music-2.6 --instrumental true --format mp3 |
     | music | Abrupt tense atmospheric shift, fast quiet strings, deep heartbeat drums, metallic sound surfaces, horror suspense, building dread, industrial textures mixed with orchestral elements | --model music-2.6 --instrumental true --format mp3 |
     ```
  8. Verify the file was written to `_testtext1_import.md` in project root

  **Part C — Import the File into the Tool**
  9. On Image tab, click "📥 Import…" in batch controls bar
  10. File picker opens → navigate to project root → select `_testtext1_import.md`
  11. **Verify import modal appears with:**
      - "Import Batch Requests" title
      - "Found 11 asset requests in the file:"
      - IMAGE: 5 item(s), SPEECH: 4 item(s), MUSIC: 2 item(s)
      - Style preset auto-detected: checkbox checked, name "LetzteBotschaft", value shows the cinematic prefix
      - No defective entries (no ⚠ warning)
  12. Click "Overwrite existing queues" → verify:
      - Success toast "Successfully imported batch requests!"
      - All Batch Dashboard opens automatically
      - Dashboard shows: 🖼 Image (5 items), 🗣 Speech (4 items), 🎵 Music (2 items)
      - Style "LetzteBotschaft" shown per tab
  13. Close dashboard
  14. Verify batch controls bar shows "▶ BatGen All Types (11)" (gold/amber button)
  15. Press Ctrl+B → verify Image queue has 5 entries, each with style "LetzteBotschaft" → Close
  16. Switch to Speech tab (Ctrl+2) → Ctrl+B → verify 4 entries → Close
  17. Switch to Music tab (Ctrl+3) → Ctrl+B → verify 2 entries → Close

  **Part D — Batch Generate All Assets**
  18. Switch to Image tab (Ctrl+1)
  19. Click "▶ BatGen All Types (11)" → verify confirm dialog lists:
      - IMAGE: 5 items
      - SPEECH: 4 items
      - MUSIC: 2 items
  20. Click OK → verify sequential execution begins:
      - Image tab activates first, batch progress overlay appears
      - Counter shows "1 / 5" advancing through images
      - Style prefix "LetzteBotschaft" prepended to each prompt (visible in log)
  21. **Wait for Image batch to complete** → verify:
      - 5 new image files in output_dir (non-zero size)
      - Log shows 5 "image" entries with result "ok"
      - Toast "BatchGen done: 5 ok, 0 failed."
  22. **Speech batch starts automatically** (tab switches to Speech):
      - Counter "1 / 4" → "4 / 4"
      - 4 new .mp3 files in output_dir
      - Toast "BatchGen done: 4 ok, 0 failed."
  23. **Music batch starts automatically** (tab switches to Music):
      - Counter "1 / 2" → "2 / 2"
      - 2 new .mp3 files in output_dir
      - Toast "BatchGen done: 2 ok, 0 failed."
  24. Verify final state:
      - All Batch Dashboard (if auto-opened) shows all tabs "Done"
      - Batch controls bar no longer shows BatGen All Types (queues empty if auto-remove enabled)
      - Total: 11 new files in output_dir (5 images + 4 speech + 2 music)

  **Part E — Verify Results**
  25. In file browser, verify 5 image files exist (PNG, non-zero, reasonable size >10KB each)
  26. Verify 4 speech .mp3 files exist (non-zero, >1KB each)
  27. Verify 2 music .mp3 files exist (non-zero, >50KB each — music tracks are longer)
  28. Double-click first image → viewer opens → verify image renders (not blank/corrupt) → close
  29. Right-click first speech .mp3 → "✂ Audio cut…" → verify waveform renders (non-silent) → close
  30. Check log panel: verify 11 total entries with status "ok" for this batch run
  31. Verify style "LetzteBotschaft" now appears in the style dropdown on Image tab (persisted to config.txt)

- **Expected:** Complete AI-assisted workflow produces 11 assets across 3 types from a screenplay document, all correctly formatted, imported with style preset, and generated successfully
- **Pass criteria:** 11 files generated (5 PNG + 4 speech MP3 + 2 music MP3), all non-zero, style preset persisted, no defective entries, no failures
- **API cost:** 5 image + 4 speech + 2 music = 11 API calls (NO video)
- **Cleanup:** Optionally remove "LetzteBotschaft" style from config; generated files remain as test artifacts

---

## Phase 9: File Operations + Processing Overlays E2E

### TC_E2E_FILE_001 — Context Menu Image Processing Chain
- **Goal:** Test image processing overlays via context menu on a real file
- **Pre-conditions:** At least 1 .png image in output_dir
- **Steps:**
  1. Right-click an image file → verify full context menu (all image ops visible)
  2. Click "🔍 Upscale" → verify overlay: multiplier/model/auto-crop controls → Cancel
  3. Right-click same file → "✂ Crop" → verify W/H prefilled → click Apply → verify crop frame → Cancel
  4. Right-click → "📐 Resize" → type W=500 → verify H auto-calculates (chain linked) → Cancel
  5. Right-click → "⇄ Convert" → verify default ≠ source format → Cancel
  6. Right-click → "🗜 Optimize" → click "small (60)" → verify slider=60 → Cancel
  7. Right-click → "✨ Remove BG" → verify 4 model options + GPU checkbox → Cancel
  8. Right-click → "🛤 Add to Pipeline" → verify pipeline badge increments
- **Expected:** All 6 processing overlays render correctly with proper defaults
- **Pass criteria:** Each overlay opens/cancels without error

### TC_E2E_FILE_002 — Real Optimize + Convert Execution
- **Goal:** Actually run optimize and convert on a file, verify output
- **Steps:**
  1. Right-click a .png image → "🗜 Optimize"
  2. Set quality=75, format="WebP", strip EXIF checked
  3. Click "🗜 Optimize" → wait → verify success toast
  4. Verify new .webp file in fb-list (smaller size)
  5. Right-click the .webp → "⇄ Convert" → set format="JPEG", quality=90
  6. Click "Convert" → verify success → new .jpg file appears
- **Expected:** Optimize produces .webp, Convert produces .jpg
- **Pass criteria:** Both output files exist with non-zero size

### TC_E2E_FILE_003 — Audio Cutter (Real Execution)
- **Goal:** Test audio cutter on the generated speech file
- **Pre-conditions:** .mp3 from Phase 3 exists
- **Steps:**
  1. Right-click the speech .mp3 → "✂ Audio cut…"
  2. Verify waveform renders on canvas (non-empty)
  3. Verify duration shown in time inputs
  4. Drag start marker to ~0.5s → verify start time updates
  5. Drag end marker to ~2.0s → verify end time updates
  6. Click "▶ Play selection" → verify audio plays → click "■ Stop"
  7. Click "✨ Auto-trim silence" → verify markers adjust
  8. Set format = "wav", filename = "speech_trim.wav"
  9. Check "Fade edges" with 5ms
  10. Click "✂ Export trimmed clip" → wait → verify success toast
  11. Verify new .wav file in fb-list
- **Expected:** Audio cut produces trimmed output file
- **Pass criteria:** speech_trim.wav exists, shorter duration than original

### TC_E2E_FILE_004 — Bulk Operations + New Folder + Rename + Delete + Copy/Cut/Paste/Move
- **Goal:** Verify bulk toolbar, folder creation, file rename, delete, clipboard operations, and move-to
- **Steps:**
  1. Check checkboxes on 2 files → verify bulk toolbar shows "2 selected"
  2. Click "✕" (clear) → verify toolbar hides
  3. Click "+ Folder" → type "test_folder" → verify created
  4. Right-click an image file → "📋 Copy" → verify toast "Copied 1 item to clipboard."
  5. Navigate into "test_folder" → right-click empty area → "📥 Paste here" → verify file copied into folder
  6. Right-click the pasted file → "✂ Cut" → verify toast "Cut 1 item to clipboard."
  7. Navigate back up (Ctrl+U) → right-click → "📥 Paste here" → verify file moved (gone from test_folder)
  8. Right-click another file → "➡ Move to…" → verify folder picker opens → select test_folder → verify file moved
  9. Right-click "test_folder" → "✎ Rename…" → type "renamed_folder" → verify renamed
  10. Right-click "renamed_folder" → "🗑 Delete" → confirm → verify removed
  11. Click "↗" (Open in Explorer) → verify Explorer opens at current path
- **Expected:** All file management operations work including clipboard copy/cut/paste and move-to
- **Pass criteria:** Folder created, renamed, deleted; copy/cut/paste/move functional; bulk toolbar shows/hides

### TC_E2E_FILE_005 — Image Viewer Navigation + Save Menu
- **Goal:** Verify viewer prev/next navigation and right-click save
- **Pre-conditions:** Multiple images in output_dir
- **Steps:**
  1. Double-click first image → viewer opens with position "(1 / N)"
  2. Press `→` → verify next image loads, position updates "(2 / N)"
  3. Press `←` → verify previous image loads
  4. Click "›" button → verify same as ArrowRight
  5. Ctrl+wheel up → verify zoom increases (100% → 125%)
  6. Right-click image → verify "Save to…" context menu appears
  7. Press Escape → verify viewer closes
- **Expected:** Navigation wraps around, zoom works, save menu accessible

---

## Phase 10: Settings Deep-Dive + Styles + History

### TC_E2E_SET_001 — Settings Save + Persistence + Output Dir Change
- **Goal:** Verify settings save persists to config.txt and affects app behavior
- **Steps:**
  1. Open Settings (Ctrl+S) → General tab
  2. Change theme to "Light" → click Save → verify app switches to light theme
  3. Reopen Settings → verify theme dropdown still shows "Light"
  4. Change theme back to "Dark" → Save
  5. Check "Don't save" checkbox → verify API key behavior (session-only)
  6. Uncheck "Don't save"
  7. Navigate to History tab → set cap to 50 → Save → reopen → verify 50 persists
  8. Click "Open archive…" → verify Archive Viewer modal opens with search + status filter
  9. Close archive viewer
- **Expected:** Settings persist across save/reopen cycle
- **Pass criteria:** config.txt reflects changes, archive viewer renders

### TC_E2E_SET_002 — Style Presets Full Cycle
- **Goal:** Create, use, and delete a style preset
- **Steps:**
  1. On Image tab, type prompt "cyberpunk city neon"
  2. Press Ctrl+T → Style Settings opens
  3. Click "Save current prompt as style…" → verify prompt pre-fills value
  4. Set name = "CyberCity" → click "Save style"
  5. Verify "CyberCity" appears in style list
  6. Close Style Settings
  7. On Image tab → verify "CyberCity" in style dropdown → select it
  8. Verify char counter includes style prefix
  9. Reopen Ctrl+T → select CyberCity → delete/remove → verify gone
  10. Verify dropdown no longer shows CyberCity
- **Expected:** Full style lifecycle works
- **Pass criteria:** Style created, usable, deletable

### TC_E2E_SET_003 — External Tools + Popup Settings + Shortcuts Tab
- **Goal:** Verify remaining settings tabs
- **Steps:**
  1. Settings → External tools tab → click "+ Add tool"
  2. Add tool: name="Paint", command="mspaint.exe", args="{file}" → Save
  3. Verify tool appears in list
  4. Right-click image in fb → verify "🔧 OPEN IN… (1)" shows "Paint"
  5. Settings → Popups tab → verify behaviour dropdown + reset button
  6. Click "🔄 Reset popup history" → verify status updates
  7. Settings → Shortcuts tab → verify all shortcuts listed (readonly table)
  8. Settings → Pipeline tab → verify audio format dropdown
  9. Settings → BatchGen tab → verify export format + auto-remove checkbox
- **Expected:** All settings tabs functional
- **Cleanup:** Remove the "Paint" external tool

---

## Phase 11: Edge Cases + Error Handling + Concurrency

### TC_E2E_EDGE_001 — Special Characters + XSS + Boundary
- **Goal:** Verify unicode handling and prompt boundary
- **Steps:**
  1. Type "日本語テスト 🎨 <script>alert('xss')</script>" in Image prompt
  2. Verify counter counts correctly (no crash)
  3. Generate with this prompt → verify no XSS execution (CSP blocks), generation proceeds or fails gracefully
  4. Verify special chars preserved in log entry
  5. Paste exactly 1500 chars → verify accepted
  6. Try 1501 → verify blocked/warned
- **Expected:** No crash, CSP blocks scripts, boundary enforced

### TC_E2E_EDGE_002 — Rapid Tab Switch + Modal Stack + Re-entrancy
- **Goal:** Verify stability under stress
- **Steps:**
  1. Rapidly press Ctrl+1/2/3/4 × 10 cycles → verify no crash, final tab stable
  2. Open Settings (Ctrl+S) → while open, press Ctrl+B → verify correct modal behavior
  3. Press Escape → verify only topmost closes
  4. On Image tab: start generation → immediately click Generate again → verify second click blocked (guard)
  5. Verify Active Jobs widget shows running job with ✕ cancel
- **Expected:** No crashes, modal stack correct, re-entrancy guarded

### TC_E2E_EDGE_003 — Empty Directory + Network Error + Error Panel
- **Goal:** Verify empty states, error recovery, and the generation error panel UI
- **Steps:**
  1. Navigate fb to an empty folder → verify empty state (no crash)
  2. Navigate back to output_dir
  3. In Settings → clear API key → Save
  4. Try to generate → verify error toast "No API key configured"
  5. Verify quota shows "No API key configured." (amber)
  6. Restore API key from env → Save → verify quota refreshes
  7. Set an invalid API key ("sk-invalid-test-123") → Save
  8. Type a prompt and click Generate → wait for failure
  9. **Verify generation error panel appears in preview area:**
     - Title "⚠ Generation failed"
     - Error message visible
     - Tips list shows relevant classification (auth)
     - Buttons visible: 🔄 Retry, 🔑 Test connection, 🩺 Diagnose, 📋 Copy error
  10. Click "📋 Copy error" → verify clipboard has error text
  11. Click "🩺 Diagnose" → verify diagnose dialog opens → close
  12. Restore correct API key from env → Save
- **Expected:** Empty states render, missing key blocks generation, error panel shows classified errors with action buttons
- **Cleanup:** Ensure API key restored

### TC_E2E_EDGE_004 — Upscale Settings + First-Time Popup + Add-ons
- **Goal:** Verify upscale settings modal and add-ons popup
- **Steps:**
  1. On Image tab, check Upscale checkbox → verify "(2×)" label
  2. Click the Upscale label text (not checkbox) → verify upscale settings modal
  3. Change multiplier to "3×" → check "Auto-crop" → Save
  4. Verify label shows "(3×)"
  5. Click "🧩 Re-open add-ons manager…" (if visible) → verify add-ons popup
  6. Close add-ons
  7. Uncheck upscale checkbox → verify multiplier text disappears
- **Expected:** Upscale settings persist, add-ons accessible

---

## Phase 12: Keyboard Shortcuts + Layout Persistence

### TC_E2E_KEY_001 — All Global Shortcuts
- **Goal:** Verify every documented shortcut in one pass
- **Steps:**
  1. Ctrl+Enter → verify Generate triggered (on active tab with prompt)
  2. Ctrl+1 → Image, Ctrl+2 → Speech, Ctrl+3 → Music, Ctrl+4 → Video
  3. Ctrl+B → BatchGen opens → Escape
  4. Ctrl+T → Style Settings opens → Escape
  5. Ctrl+S → Settings opens → Escape
  6. Ctrl+L → theme toggles → Ctrl+L → toggles back
  7. Ctrl+F → fb-search focused
  8. Ctrl+R → quota refreshes
  9. Ctrl+U → fb navigates up
- **Expected:** All 9+ shortcuts functional
- **Pass criteria:** Each shortcut produces its documented effect

### TC_E2E_LAYOUT_001 — Splitter Persistence Across Restart
- **Goal:** Verify layout saves and restores
- **Steps:**
  1. Drag sidebar splitter 80px left → note new width
  2. Drag log bar splitter 40px up → note new height
  3. Close app (window ✕) → verify clean exit
  4. Relaunch app → dismiss welcome
  5. Verify splitter positions match step 1/2 values
- **Expected:** state.json stores layoutSettings, restored on launch
- **Pass criteria:** Splitter positions identical after restart

---

## Phase 13: Active Jobs Widget + Log Panel Deep

### TC_E2E_JOBS_001 — Active Jobs Widget During Generation
- **Goal:** Verify floating jobs widget appears and functions during generation
- **Steps:**
  1. Start an image generation (any prompt)
  2. Verify Active Jobs widget appears (bottom-right) with:
     - 🖼 icon, title, tab label, age counter
  3. Click the job row → verify log scrolls to corresponding entry
  4. Wait for completion → verify widget disappears
  5. Start another generation → click ✕ cancel on the job row
  6. Verify generation cancelled, toast "Cancelled.", widget disappears
- **Expected:** Widget tracks running jobs, cancel works
- **Pass criteria:** Widget appears/disappears with job lifecycle

### TC_E2E_LOG_001 — Log Panel Full Operations
- **Goal:** Verify all log panel controls including jump pill and help
- **Pre-conditions:** Multiple log entries exist (from previous tests)
- **Steps:**
  1. Click "▲ Newest" (Home) → verify scrolls to newest
  2. Click "▼ Oldest" (End) → verify scrolls to oldest
  3. Click a log row → verify expands (shows details)
  4. Click "+ Expand all" → verify all expanded
  5. Click "− Collapse all" → verify all collapsed
  6. Click "Auto: ON" chip → verify changes to "Auto: OFF"
  7. Trigger a new log entry (e.g. Ctrl+R quota refresh) → verify "↓ N new" jump pill appears
  8. Click the jump pill → verify scrolls to new entry + pill disappears
  9. Click "📋 Copy" → verify clipboard has log text
  10. Click "?" (help button) → verify help tooltip/modal explains log categories
  11. Click "▲ Collapse" → verify log panel hides → click again → restores
  12. Re-enable autoscroll
- **Expected:** All log controls functional including jump pill and help
- **Pass criteria:** Copy produces text, collapse/expand works, jump pill navigates to new entries

---

## Summary Statistics

| Phase | Suite | Tests | Coverage Area |
|-------|-------|-------|---------------|
| 1 | Setup & Navigation | 3 | Lifecycle, tabs, intro popups, What's New, quota, settings, add-ons, fb, layout |
| 2 | Image Generation | 4 | Real API gen, tab dots/ETA, --n, style preview, guards, import/examples |
| 3 | Speech Generation | 2 | Real API TTS, model/voice, parameters |
| 4 | Music Generation | 2 | Real API music, custom inputs, BPM |
| 5 | Video Generation | 1 | Real API video (1/3 daily quota), CapabilityGuard |
| 6 | Pipeline | 4 | Load, progression, export, card ops, filter, clipboard paste, Folder, Correct, clear+report |
| 7 | Image Editor | 5 | Draw, tools, objects list, resize canvas, asset panel, generate, queue bar, heal, remove BG, bake |
| 8 | BatchGen | 4 | Queue execution, progress overlay, bulk paste, import, BatGen All Types, dashboard, stop mid-run, full AI import/export flow |
| 9 | File Operations | 5 | Processing overlays, audio cutter, bulk ops, viewer nav |
| 10 | Settings & Styles | 3 | Persistence, styles CRUD, external tools, archive |
| 11 | Edge Cases | 4 | XSS, boundaries, concurrency, empty states, add-ons |
| 12 | Shortcuts & Layout | 2 | All shortcuts, splitter persistence |
| 13 | Jobs & Log | 2 | Active jobs widget, log panel controls |
| **TOTAL** | | **41** | **100% UI surface + real E2E flows** |

---

## Execution Notes

1. **API Quota Management:** Image/Speech/Music use PAYG credits. Video is hard-limited to 3/day (1 test uses 1). TC_E2E_BATCH_004 uses 11 calls (5 image + 4 speech + 2 music).
2. **Efficiency:** Each test combines multiple verification points. Only take screenshots at the final verification step unless a failure requires debugging.
3. **Order Dependency:** Phases 1→2→3→4→5→6→7→8→9→10→11→12→13. Pipeline tests (Phase 6) depend on images from Phase 2. Audio cutter (Phase 9) depends on speech from Phase 3. TC_E2E_BATCH_004 requires `_testtext1.txt` in project root.
4. **Cleanup:** Tests are designed to leave the app in a usable state. Only TC_E2E_EDGE_003 temporarily removes the API key (restores immediately).
5. **Video Conservation:** TC_E2E_VID_001 uses the cheapest model (Hailuo-2.3-Fast, 6s, 768P). Do NOT add more video tests.
6. **Window Position:** All tests run at 1400×900 @ (519, 0). Never fullscreen. Verify position in Phase 1 only.
7. **AI Import/Export Test (TC_E2E_BATCH_004):** This test simulates the full external-LLM workflow. The import file content is pre-defined in the test steps. The test executor creates `_testtext1_import.md` exactly as specified, then imports it. No video is generated in this test.
