// main/services/importDocManual.js
// Generates the AI-readable import instruction document (Markdown + plain text)
// written to the user's output folder by the `batches:generateExamples` IPC.
//
// The document is consumed by an external writing assistant that converts a user's
// unstructured asset-request description (e.g. a Game Design Document) into the
// structured import table this tool parses. It therefore must tell that agent:
//   1. The exact output format (the import table).
//   2. EVERY generation option (per type — pulled from modelSpecs.js at runtime).
//   3. EVERY follow-up feature the tool offers AFTER generation (Pipeline,
//      pixel editor, heal/inpaint, batch ops) — so the agent can advise the user
//      and encode decisions in the table (--upscale etc.).
//   4. A STRUCTURED workflow flow: what to do, in what order, and when to STOP
//      and ASK THE USER a decision question (folder, pipeline-on/off, naming,
//      style header, format) before producing the final table.
//
// Kept in its own module so registerBatchesIpc.js stays under the 500-line lint
// cap and the content can be unit-tested directly.

'use strict';

const fs = require('fs');
const path = require('path');
const registry = require('./importCapabilityRegistry');
const { PHASES_MD, PHASES_TXT, KICKOFF_PROMPT, CHECKPASS_PROMPT } = require('./importDocWorkflow');

// Build the Markdown manual.
//
// H9-001: descriptions previously came from scraping inline `//` comments out of
// renderer/specs/modelSpecs.js, but the scraper mistook nested `prompt:` /
// `lyrics:` object keys for asset-type switches, so currentType was clobbered
// and ~every flag description rendered BLANK. Descriptions now come from the
// structured, validated importCapabilityRegistry.
//
// H9-019: if the registry cannot be loaded or validated we THROW (rather than
// return literal error text that a save handler would happily write to disk and
// report as success).
function generateManual() {
  // Fail-closed: a broken registry must never produce a plausible-looking but
  // wrong manual.
  registry.validate();
  const CAP = registry.CAPABILITIES;

  const specsPath = path.join(__dirname, '..', '..', 'renderer', 'specs', 'modelSpecs.js');
  let specsCode = '';
  try {
    specsCode = fs.readFileSync(specsPath, 'utf8');
  } catch (e) {
    throw new Error('Cannot read renderer/specs/modelSpecs.js: ' + (e && e.message));
  }

  // Evaluate MODEL_SPECS only for the per-type prompt/label metadata (the
  // registry owns the flag descriptions now).
  const context = {};
  try {
    new Function('window', 'module', 'exports', specsCode + '\nif(typeof MODEL_SPECS !== "undefined") window.MODEL_SPECS = MODEL_SPECS;')(context, {}, {});
  } catch (e) {
    throw new Error('Cannot evaluate renderer/specs/modelSpecs.js: ' + (e && e.message));
  }
  const specs = context.MODEL_SPECS;
  if (!specs) throw new Error('modelSpecs.js did not export MODEL_SPECS');

  // ---- Header + format ----
  let md = '';
  md += '# MiniMax Asset Tool — Import Instruction Manual (for AI assistants)\n\n';
  // ---- Issue-4: human-facing intro — what this document is, the exact
  // workflow (GDD + this template → AI produces the import file → import
  // into the tool), a paste-ready kick-off prompt, and a check/correction
  // second-pass prompt. Written for beginners in natural language. ----
  md += '## 👋 How to use this document (for humans — start here)\n\n';
  md += 'This file gives a writing assistant the instructions it needs to create **batch import files** for the MiniMax Asset Tool. You do not need any technical knowledge — everything happens in natural language.\n\n';
  md += '**The workflow:**\n\n';
  md += '1. **Keep this file** — the "Examples" button in the tool just saved it for you.\n';
  md += '2. **Open any AI chatbot** and paste the kick-off prompt below into the chat.\n';
  md += '3. **Add your game design document (GDD)** — paste its text or attach the file to the same chat. A feature list or any plain description of the assets you need works too.\n';
  md += '4. The AI reads this instruction sheet plus your GDD, asks you a few short decision questions, and then produces a ready-to-import asset table.\n';
  md += '5. **Run the check pass** — paste the second prompt below so the AI verifies the structure of its own output and fixes any mistakes.\n';
  md += '6. **Import the result into the tool**: open BatchGen (Ctrl+B) → Import → pick the AI\'s file → review → import. Then press Generate.\n\n';
  md += '### Kick-off prompt (copy & paste this into your AI chat)\n\n';
  md += '```\n';
  md += KICKOFF_PROMPT + '\n';
  md += '```\n\n';
  md += '### Check pass prompt (paste this after the AI produced the import file)\n\n';
  md += '```\n';
  md += CHECKPASS_PROMPT + '\n';
  md += '```\n\n';
  md += '---\n\n';
  md += '> **Audience (everything below this line):** written for an AI assistant (you) whose job is to read a user\'s unstructured asset request — typically a Game Design Document (GDD), a feature list, or a natural-language brief — and convert it into the structured **import table** this tool consumes. Read this document completely before producing any table.\n\n';
  md += '---\n\n';

  // ---- STRUCTURED WORKFLOW (catalogue-then-compose, from shared module) ----
  md += PHASES_MD + '\n\n';

  // ---- §1 FORMAT ----
  md += '## 1. Expected output format\n\n';
  md += 'Your final output must be a **single markdown table** with exactly these columns:\n\n';
  md += '| Type | Prompt / Text | Parameters |\n|---|---|---|\n\n';
  md += '- **Type**: exactly one of `image`, `speech`, `music`, `video`.\n';
  md += '- **Prompt / Text**: the main prompt (image/music/video) or the text to speak (speech). Keep it under the type\'s HARD limit (below).\n';
  md += '- **Parameters**: a space-separated list of `--flag value` settings. Do NOT put the prompt text here.\n\n';
  md += '> [!IMPORTANT]\n> **HARD character limits per type (enforced by the MiniMax API)**. The tool marks over-limit entries **defective** and skips them. Rephrase (don\'t truncate mid-sentence) to stay under:\n>\n';
  md += '| Type | Prompt / Text limit |\n|---|---|\n';
  for (const [type, spec] of Object.entries(specs)) {
    let limitStr = '**' + spec.prompt.max + ' characters**';
    if (type === 'music') limitStr += ' (prompt only — `--lyrics` has its own 3500 limit, see below)';
    md += '| `' + type + '` | ' + limitStr + ' |\n';
  }
  md += '\n---\n\n';

  // ---- §2 STYLE HEADER ----
  md += '## 2. Optional style preset header (recommended for consistency)\n\n';
  md += 'If every row should share the same style prefix, add ONE header line as the FIRST non-empty line of the file (before the table). The tool auto-detects it and prepends the value (with a comma) to every prompt — useful for a consistent look/mood/genre across the whole batch. The user can opt out in the import dialog.\n\n';
  md += 'Recognised shapes (any of these work):\n';
  md += '- `style: MyStyleName = "cinematic, 35mm film, neon lights"`\n';
  md += '- `## style: MyStyleName — cinematic, 35mm film, neon lights`\n';
  md += '- `<!-- style: MyStyleName = cinematic, 35mm film, neon lights -->`\n\n';
  md += '---\n\n';

  // ---- §3 FOLLOW-UP FEATURES (NEW — the agent must know these exist) ----
  md += '## 3. Follow-up features the tool offers AFTER generation\n\n';
  md += 'The agent does not operate these, but **must know they exist** so it can (a) advise the user, and (b) decide whether to set generation-time flags like `--upscale`. Tell the user these are available once assets are generated:\n\n';
  md += '### 3.1 Image Pipeline (post-generation, per asset)\n';
  md += 'A column-based workflow the user runs after images are generated. Each asset moves left → right through the enabled columns:\n';
  md += '1. **Upscale** — 2×/3×/4× via the bundled Real-ESRGAN binary (or a canvas fallback). Produces a higher-resolution sibling file.\n';
  md += '2. **Remove Background** — replaces the background with transparency using the bundled IS-Net / BiRefNet models (local, no upload). Output is a transparent PNG.\n';
  md += '3. **Crop** — crop to an exact W×H rectangle.\n';
  md += '4. **Optimize / Convert** — re-encode to PNG / JPEG / WebP / AVIF with quality + EXIF control (sharp/libvips).\n';
  md += '5. **Final** — finalize; export-ready.\n';
  md += 'Per-asset the user can also **Duplicate** (keep a low-res copy while upscaling another), **Skip** steps, **Back**, **Replace** the file, **Open in** an external editor (GIMP/Photoshop), and **batch-export all finals** to a folder.\n';
  md += '> Decision hint for the agent: if the user wants large images (>2048px), use `--upscale true --upscale-multiplier 2` at GENERATION time (§4.1). The Pipeline\'s Upscale column is the same engine, applied manually afterward.\n\n';
  md += '### 3.2 In-app pixel editor (per image)\n';
  md += 'Right-click any image → **✏ Edit** (also a header ✏ button, every Pipeline card, and the full-size viewer). A mini-editor with: brush, spray, **eraser-to-transparency** (works even on a JPEG — it auto-adds an alpha channel), color picker, zoom/pan, undo/redo. Plus:\n';
  md += '- **Composite a 2nd image**: load another image, place/rotate/scale/flip it onto the canvas, then **bake** together.\n';
  md += '- **Heal / Inpaint** (the GIMP \"Resynthesizer\" trio, commercially-safe): **Heal Selection** (fill a region from surroundings), **Heal Transparency** (fill alpha holes left by background removal), **Resynthesize** (stronger AI fill via bundled LaMa + MI-GAN models). Best for fixing small background-removal artifacts and seams.\n';
  md += '- Saves as a sibling `<name>_edited.png/jpg/webp`.\n\n';
  md += '### 3.3 Audio tools\n';
  md += '- **Audio cutter**: manual trim + **auto-silence-trim** (detects leading/trailing silence via ffmpeg and removes it). Right-click any audio → ✂ Audio cut.\n';
  md += '- Format/quality are set at generation time (§5 speech / §6 music).\n\n';
  md += '### 3.4 Batch operations\n';
  md += '- The import dialog applies a style preset to the whole batch at once.\n';
  md += '- Each tab (image/speech/music/video) runs its batch independently with per-row variants.\n';
  md += '- The Pipeline supports the batch-export-final-column flow (§3.1).\n\n';
  md += '### 3.5 External-tool hand-off\n';
  md += 'Configured 3rd-party editors (GIMP, Photoshop, …) can be launched with a generated asset via right-click → \"Open in…\".\n\n';
  md += '---\n\n';

  // ---- §4+ DETAILED PARAMS (per type) ----
  md += '## 4. Detailed generation parameters (every option)\n\n';
  let i = 1;
  for (const [type, spec] of Object.entries(specs)) {
    md += '\n### ' + (i++) + '. ' + (spec.label || type) + ' (`type: ' + type + '`)\n';
    // H9-001: render descriptions from the structured capability registry, NOT
    // from scraped source comments (which produced blank descriptions).
    const cap = CAP[type];
    if (cap && Array.isArray(cap.flags)) {
      for (const f of cap.flags) {
        // Skip the prompt/text fields — they have their own HARD-limit line.
        if (f.flag === '--prompt' || f.flag === '--text') continue;
        let line = '- `' + f.flag + '`: ' + f.desc;
        if (f.allowed) {
          const allowedStr = Array.isArray(f.allowed) ? f.allowed.join(' / ') : f.allowed;
          line += ' **Allowed:** ' + allowedStr + '.';
        }
        if (f.default != null) line += ' **Default:** `' + f.default + '`.';
        if (f.note) line += ' (' + f.note + ')';
        md += line + '\n';
      }
    } else {
      // Fallback: the live spec's supportedFlags (no descriptions). This branch
      // should never trigger if the registry is kept in sync; the validate()
      // call at the top guards it.
      for (const flag of (spec.supportedFlags || [])) {
        if (flag === '--prompt' || flag === '--text') continue;
        md += '- `' + flag + '`: (see the tool UI for details)\n';
      }
    }
    if (type === 'speech') {
      md += '- **Text length limit: ' + spec.prompt.max + ' characters (HARD).**\n';
    } else {
      md += '- **Prompt length limit: ' + spec.prompt.max + ' characters (HARD).**\n';
      if (type === 'music') {
        md += '- `--lyrics`: the song lyrics with structure tags ([Verse], [Chorus], …). **Max 3500 chars (HARD)**. Required unless --instrumental or --lyrics-optimizer is set.\n';
      }
    }
    if (type === 'image') {
      md += '\n> [!IMPORTANT]\n> **Resolution > 2048px**: the model caps at 2048×2048 native. If the user wants larger (e.g. 3840×2160), compute a same-aspect base ≤2048 (e.g. 1920×1080), set `--width/--height` to it, and add `--upscale true --upscale-multiplier 2`.\n\n';
      md += '> [!IMPORTANT]\n> **`--n` + `--variants`**: `--n=2 --variants=2` = 2 calls × 2 images = 4 images, and rapid back-to-back calls can hit API rate limits. Prefer just one of `--n` or `--variants`.\n\n';
    }
  }

  // ---- EXAMPLE ----
  md += '---\n\n## 5. Example import table\n\n';
  md += '| Type | Prompt / Text | Parameters |\n|---|---|---|\n';
  md += '| image | A futuristic cityscape with glowing neon lights | --aspect-ratio 16:9 --variants 3 --upscale true --upscale-multiplier 2 |\n';
  md += '| speech | Hello, this is a batch voice recording | --model speech-2.8-hd --voice English_expressive_narrator --speed 1.05 |\n';
  md += '| music | Upbeat 80s style retro arcade theme | --model music-2.6 --instrumental true |\n';
  md += '| video | A drone shot flying through a forest valley | --model MiniMax-Hailuo-2.3 --duration 6 --resolution 768P |\n';
  md += '\n---\n\n';
  md += '**Reminder:** complete Phases 1–6 (inventory, scene bible, character bible, shot map, compose, decision questions) BEFORE emitting the table. Only emit the table + a short follow-up-features note (§3). Keep every prompt under its HARD limit. Use the Scene/Character Bible verbatim-concatenation rule (Phase 5).\n';
  return md;
}

module.exports = { generateManual, generateTxtManual };

// ---- H9-020: TXT manual rendered from the SAME registry as the MD ----
// The previous buildTxtManual (in registerBatchesIpc.js) was a hand-coded
// template that had already drifted from the registry: it offered
// --upscale-multiplier "2 or 4" while the registry offers 2/3/4, and it
// documented music --genre/--bpm and other capability-registry flags the
// registry deliberately omits as silent no-ops. Rendering from CAPABILITIES
// keeps the two formats in lock-step. The static workflow preamble below is
// the only hand-maintained part (it matches the MD's structured-workflow
// section).
function generateTxtManual() {
  registry.validate();
  const CAP = registry.CAPABILITIES;
  const specsPath = path.join(__dirname, '..', '..', 'renderer', 'specs', 'modelSpecs.js');
  let specsCode = '';
  try { specsCode = fs.readFileSync(specsPath, 'utf8'); } catch (e) { throw new Error('Cannot read modelSpecs.js: ' + (e && e.message)); }
  const context = {};
  try {
    new Function('window', 'module', 'exports', specsCode + '\nif(typeof MODEL_SPECS !== "undefined") window.MODEL_SPECS = MODEL_SPECS;')(context, {}, {});
  } catch (e) { throw new Error('Cannot evaluate modelSpecs.js: ' + (e && e.message)); }
  const specs = context.MODEL_SPECS;
  if (!specs) throw new Error('modelSpecs.js did not export MODEL_SPECS');

  let t = '';
  t += 'MiniMax Asset Tool — Import Instruction Manual (for AI assistants)\n\n';
  // ---- Issue-4: human-facing intro (plain-text mirror of the Markdown
  // section) — what this document is, the exact workflow, a paste-ready
  // kick-off prompt, and a check/correction second-pass prompt. ----
  t += '============================================================\n';
  t += 'HOW TO USE THIS DOCUMENT (for humans - start here)\n';
  t += '============================================================\n\n';
  t += 'This file gives a writing assistant the instructions it needs to create batch import files for the MiniMax Asset Tool. You do not need any technical knowledge - everything happens in natural language.\n\n';
  t += 'THE WORKFLOW:\n';
  t += '  1. Keep this file - the "Examples" button in the tool just saved it for you.\n';
  t += '  2. Open any AI chatbot and paste the KICK-OFF PROMPT below into the chat.\n';
  t += '  3. Add your game design document (GDD) - paste its text or attach the file to the same chat. A feature list or any plain description of the assets you need works too.\n';
  t += '  4. The AI reads this instruction sheet plus your GDD, asks you a few short decision questions, and then produces a ready-to-import asset table.\n';
  t += '  5. Run the CHECK PASS - paste the second prompt below so the AI verifies the structure of its own output and fixes any mistakes.\n';
  t += '  6. Import the result into the tool: open BatchGen (Ctrl+B) -> Import -> pick the AI\'s file -> review -> import. Then press Generate.\n\n';
  t += '------------------------------------------------------------\n';
  t += 'KICK-OFF PROMPT (copy & paste this into your AI chat)\n';
  t += '------------------------------------------------------------\n';
  t += KICKOFF_PROMPT + '\n\n';
  t += '------------------------------------------------------------\n';
  t += 'CHECK PASS PROMPT (paste this after the AI produced the import file)\n';
  t += '------------------------------------------------------------\n';
  t += CHECKPASS_PROMPT + '\n\n';
  t += '============================================================\n\n';
  t += 'AUDIENCE: everything below this line is written for an AI assistant that converts a user\'s unstructured asset request (e.g. a Game Design Document) into the structured import table this tool consumes. Read it completely before producing any table.\n\n';
  // ---- STRUCTURED WORKFLOW (catalogue-then-compose, from shared module) ----
  t += PHASES_TXT + '\n\n';
  t += '============================================================\n';
  t += '1. EXPECTED FORMAT — pipe-separated rows (or fenced ```batch-json blocks for lossless import)\n';
  t += '============================================================\n';
  t += 'Each data line: Type | Prompt / Text | Parameters\n';
  t += 'Type must be one of: image, speech, music, video.\n';
  t += 'Prompt / Text is the main prompt or speech text.\n';
  t += 'Parameters is a space-separated list of flags (e.g., --aspect-ratio 1:1 --width 1024 --height 1024).\n\n';
  t += 'For lossless import of pipes-in-prose, multiline speech/lyrics, or Unicode, prefer a fenced block:\n';
  t += '  ```batch-json\n';
  t += '  [ { "type": "speech", "prompt": "Hello | world", "params": { "--model": "speech-2.8-hd" } } ]\n';
  t += '  ```\n\n';
  t += '* HARD CHARACTER LIMITS PER TYPE (enforced by the MiniMax API) *\n';
  for (const [type, spec] of Object.entries(specs)) {
    let limitStr = spec.prompt.max + ' characters';
    if (type === 'music') limitStr += ' (prompt only; --lyrics has its own 3500 limit)';
    t += '  ' + type + ' = ' + limitStr + '\n';
  }
  t += '\nIf a request would exceed the limit, rephrase (do NOT silently truncate mid-sentence).\n\n';
  t += 'OPTIONAL STYLE PRESET HEADER (RECOMMENDED)\n';
  t += 'If every row should share the same style prefix, add a single header line at the top of the file (BEFORE the first data row). Recognised shapes:\n';
  t += '  style: MyStyleName = "cinematic, 35mm film, neon lights"\n';
  t += '  style: MyStyleName — cinematic, 35mm film, neon lights\n';
  t += '  <!-- style: MyStyleName = cinematic, 35mm film, neon lights -->\n\n';
  t += '---\n';
  t += 'DETAILED PARAMETERS REFERENCE (rendered from the same capability registry as the Markdown manual):\n\n';

  let i = 1;
  for (const [type, spec] of Object.entries(specs)) {
    t += '\n' + (i++) + '. ' + (spec.label || type).toUpperCase() + ' (type: ' + type + ')\n';
    const cap = CAP[type];
    if (cap && Array.isArray(cap.flags)) {
      for (const f of cap.flags) {
        if (f.flag === '--prompt' || f.flag === '--text') continue;
        let line = '- ' + f.flag + ': ' + f.desc;
        if (f.allowed) {
          const allowedStr = Array.isArray(f.allowed) ? f.allowed.join(', ') : f.allowed;
          line += ' Allowed: ' + allowedStr + '.';
        }
        if (f.default != null) line += ' Default: ' + f.default + '.';
        if (f.note) line += ' (' + f.note + ')';
        t += line + '\n';
      }
    }
    if (type === 'speech') {
      t += '- Text length limit: ' + spec.prompt.max + ' characters (HARD).\n';
    } else {
      t += '- Prompt length limit: ' + spec.prompt.max + ' characters (HARD).\n';
      if (type === 'music') {
        t += '- --lyrics: song lyrics with structure tags ([Verse], [Chorus], ...). Max 3500 chars (HARD). Required unless --instrumental or --lyrics-optimizer is set.\n';
      }
    }
    if (type === 'image') {
      t += '\n* IMPORTANT: RESOLUTION LIMITS — native max is 2048x2048. For larger, scale to a <=2048 base of the same aspect ratio and add --upscale true --upscale-multiplier 2.\n';
      t += '* IMPORTANT: --n COMBINED WITH --variants multiplies the call AND image count. Prefer one or the other.\n';
    }
  }

  t += '\n---\n';
  t += 'EXAMPLE IMPORT ROWS:\n';
  t += 'image | A futuristic cityscape with glowing neon lights | --aspect-ratio 16:9 --variants 3 --upscale true --upscale-multiplier 2\n';
  t += 'speech | Hello, this is a batch voice recording | --model speech-2.8-hd --voice English_expressive_narrator --speed 1.05\n';
  t += 'music | Upbeat 80s style retro arcade theme | --model music-2.6 --instrumental true\n';
  t += 'video | A drone shot flying through a forest valley | --model MiniMax-Hailuo-2.3 --duration 6 --resolution 768P\n\n';
  t += '============================================================\n';
  t += 'FOLLOW-UP FEATURES (the tool offers these AFTER generation — tell the user)\n';
  t += '============================================================\n';
  t += 'The agent does NOT perform these, but must know they exist so it can advise the user:\n\n';
  t += 'IMAGE PIPELINE (per asset, post-generation, click-driven columns left to right):\n';
  t += '  Upscale (2x/3x/4x, Real-ESRGAN) -> Remove Background (IS-Net/BiRefNet, transparent PNG) -> Crop (exact WxH) -> Resize -> Optimize/Convert (PNG/JPEG/WebP/AVIF) -> Final.\n';
  t += 'IN-APP PIXEL EDITOR (right-click -> Edit): brush, spray, eraser-to-transparency, color picker, zoom/pan, undo/redo, composite a 2nd image, Heal/Inpaint (Telea + LaMa/MI-GAN), bar/line tool, marquee selection, one-click Remove BG.\n';
  t += 'AUDIO TOOLS: audio cutter with manual trim + auto-silence-trim (ffmpeg).\n';
  t += 'BATCH OPS: style preset applied to whole batch at import; each tab runs its batch independently; Pipeline clear/export-final-column flow.\n';
  t += 'EXTERNAL HAND-OFF: configured 3rd-party editors (GIMP/Photoshop) via right-click "Open in...".\n\n';
  t += 'REMINDER: complete Phases 1-6 (inventory, scene bible, character bible, shot map, compose, decision questions) BEFORE emitting the table. Only emit the table + a short follow-up-features note. Keep every prompt under its HARD limit. Use the Scene/Character Bible verbatim-concatenation rule (Phase 5).\n';
  return t;
}
