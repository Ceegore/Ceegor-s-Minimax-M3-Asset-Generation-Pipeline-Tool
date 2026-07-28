// main/services/importDocWorkflow.js
// Single source of truth for the structured workflow phases, the kick-off
// prompt, and the check-pass prompt. Imported by BOTH generateManual() (MD)
// and generateTxtManual() (TXT) in importDocManual.js so the two formats
// never drift (H9-020). Also reused verbatim by the Phase-6 M3 in-tool
// pipeline (m3DocPipeline.js) so the document and the automated passes
// stay identical.
//
// The workflow implements the "catalogue-then-compose" pattern: the AI
// first builds a SCENE BIBLE and a CHARACTER BIBLE (canonical descriptions
// written ONCE), then composes each image prompt by CONCATENATING the
// full canonical blocks verbatim + only the shot-specific action. This
// guarantees consistent backgrounds and character appearances across
// multiple images of the same scene/character.

'use strict';

// ---- The 7 workflow phases (Markdown formatted) ----
const PHASES_MD = `## 0. Structured workflow — follow this in order

Work through these phases **in sequence**. Do NOT jump to the table until you have completed the decision questions in Phase 6.

### Phase 1 — Inventory

Read the user's brief. List every distinct asset they want (each becomes ONE table row). Note its type (\`image\` / \`speech\` / \`music\` / \`video\`), its purpose, and any parameters mentioned (size, voice, genre, duration…).

### Phase 2 — SCENE BIBLE (single source of truth for backgrounds)

For every distinct location/setting that appears in the assets, write ONE canonical description block. Assign Scene IDs \`S1\`, \`S2\`, …. Each block contains:

- **Setting** — what the place is (interior/exterior, type of room or landscape).
- **Background** — the full background description (architecture, vegetation, sky, props, depth layers).
- **Time of day & lighting** — dawn/noon/dusk/night, light direction, colour temperature, shadows.
- **Palette** — dominant colours and mood.
- **Weather / atmosphere** — clear, foggy, rainy, dusty, etc.
- **Camera / lens hint** — wide-angle, telephoto, low-angle, bird's-eye (if relevant).

> Write each Scene block **ONCE**. It is the single source of truth. Every image set in that scene will reuse it VERBATIM.

### Phase 3 — CHARACTER BIBLE (single source of truth for characters)

For every recurring character or important object, write ONE canonical description block. Assign Character IDs \`C1\`, \`C2\`, …. Each block contains:

- **Silhouette** — body type, height, posture.
- **Clothing** — garments + exact colours (e.g. "crimson #DC143M hooded cloak, charcoal leather boots").
- **Features** — hair, eyes, skin, scars, accessories.
- **Age / build** — approximate age, muscular/slender/etc.
- **Default expression** — the resting face unless the shot overrides it.

> Write each Character block **ONCE**. Every image featuring that character will reuse it VERBATIM.

### Phase 4 — Map shots

For each image/video asset, note:
- Which **Scene ID** it uses.
- Which **Character IDs** appear in it.
- The **shot-specific action** only (what is happening in THIS particular frame — the unique part).

### Phase 5 — COMPOSE by concatenation (the key rule)

Each image prompt is built by CONCATENATION:

\`\`\`
[style header (if opted in)] + full Scene block (VERBATIM) + full Character block(s) (VERBATIM) + shot-specific action
\`\`\`

- **Verbatim copy = consistent backgrounds and characters.** Never paraphrase, shorten, or rewrite the canonical blocks.
- **Use remaining character budget to keep canonical blocks WHOLE.** If the total would exceed the HARD limit, *rephrase and trim the shot-action text LAST* — never the canonical blocks, never mid-sentence.
- For speech/music/video (no visual scene), the prompt is the text/lyrics/description directly (no scene/character concatenation needed).

### Phase 6 — ASK THE USER these decision questions (do not guess)

Before writing the table, confirm the following with the user. Their answers shape the whole batch. If they already answered a question in their brief, do not re-ask it.

1. **Output folder** — *Where should generated assets be saved?* (This tool writes to a configured output directory. Tell the user assets land there; they can change it in ⚙ Settings.)
2. **Pipeline usage** — *After generation, do you want assets to go through the tool's post-processing Pipeline automatically, or just be saved as-is?* The Pipeline can **upscale, remove background, crop, optimize/convert** (see §3). For images, asking for \`--upscale true\` at generation time is one option; the full Pipeline is a manual/semi-automatic step after generation.
3. **Style consistency** — *Should every asset share one visual/audio style prefix?* If yes, use the **style header** (§2) so the whole batch is consistent.
4. **Variants** — *How many variants of each asset do you want?* (1–5 per row via \`--variants\`; also \`--n\` for images.)
5. **Format & quality** — *Any required output format?* (PNG vs JPEG vs WebP for images; MP3/WAV/FLAC/Opus for audio; 768P vs 1080P for video.)
6. **Naming** — *Any naming convention?* (The tool keeps the prompt-derived name; a consistent style header helps grouping.)

### Phase 7 — Self-check passes (mechanical, do all five)

After producing the table, verify:

1. Every image tagged \`S{n}\` has **identical** scene wording (byte-for-byte from the Scene Bible).
2. Every image tagged \`C{n}\` has **identical** character wording (byte-for-byte from the Character Bible).
3. All prompts are ≤ the HARD limit; over-limit ones were *rephrased* (shot text trimmed first), never cut mid-sentence.
4. Nothing from the inventory (Phase 1) is missing or duplicated.
5. Style header is present if and only if the user opted in.

---

### Worked example (one scene, three images)

**Scene Bible:**
> **S1 — Forest clearing at dawn.** Ancient oak forest, a circular clearing carpeted with wildflowers (lavender, daisies). Background: moss-covered boulders, a narrow stream catching golden light. Time: dawn, warm golden rays from the east, long soft shadows. Palette: emerald green, gold, soft purple. Atmosphere: light morning mist at knee height. Camera: wide-angle, eye-level.

**Character Bible:**
> **C1 — Elara the ranger.** Athletic build, 170 cm, confident stance. Clothing: forest-green hooded cloak (#228B22), dark brown leather armour with silver buckles, knee-high black boots. Features: long auburn hair in a braid, hazel eyes, a thin scar across the left cheek. Age ~28, lean. Default expression: calm, alert gaze.

**Shot map:**
- Image 1: S1, C1 — "Elara steps into the clearing, bow drawn, scanning the tree line."
- Image 2: S1, C1 — "Elara kneels beside the stream, cupping water in her hands."
- Image 3: S1 (no character) — "The empty clearing at dawn, mist swirling, no one present."

**Composed prompts (note the verbatim repetition):**

| Type | Prompt / Text | Parameters |
|---|---|---|
| image | cinematic fantasy art. Ancient oak forest, a circular clearing carpeted with wildflowers (lavender, daisies). Background: moss-covered boulders, a narrow stream catching golden light. Time: dawn, warm golden rays from the east, long soft shadows. Palette: emerald green, gold, soft purple. Atmosphere: light morning mist at knee height. Camera: wide-angle, eye-level. Athletic build, 170 cm, confident stance. Clothing: forest-green hooded cloak (#228B22), dark brown leather armour with silver buckles, knee-high black boots. Features: long auburn hair in a braid, hazel eyes, a thin scar across the left cheek. Age ~28, lean. Default expression: calm, alert gaze. Elara steps into the clearing, bow drawn, scanning the tree line. | --model image-01 --aspect-ratio 16:9 |
| image | cinematic fantasy art. Ancient oak forest, a circular clearing carpeted with wildflowers (lavender, daisies). Background: moss-covered boulders, a narrow stream catching golden light. Time: dawn, warm golden rays from the east, long soft shadows. Palette: emerald green, gold, soft purple. Atmosphere: light morning mist at knee height. Camera: wide-angle, eye-level. Athletic build, 170 cm, confident stance. Clothing: forest-green hooded cloak (#228B22), dark brown leather armour with silver buckles, knee-high black boots. Features: long auburn hair in a braid, hazel eyes, a thin scar across the left cheek. Age ~28, lean. Default expression: calm, alert gaze. Elara kneels beside the stream, cupping water in her hands. | --model image-01 --aspect-ratio 16:9 |
| image | cinematic fantasy art. Ancient oak forest, a circular clearing carpeted with wildflowers (lavender, daisies). Background: moss-covered boulders, a narrow stream catching golden light. Time: dawn, warm golden rays from the east, long soft shadows. Palette: emerald green, gold, soft purple. Atmosphere: light morning mist at knee height. Camera: wide-angle, eye-level. The empty clearing at dawn, mist swirling, no one present. | --model image-01 --aspect-ratio 16:9 |

Notice: the Scene block is **identical** in all three rows. The Character block is identical in rows 1 and 2. Only the shot action (last sentence) differs. This is the verbatim-concatenation rule in action.

---`;

// ---- Plain-text mirror of the phases ----
const PHASES_TXT = `============================================================
0. STRUCTURED WORKFLOW — follow this in order (do not skip Phase 6)
============================================================

PHASE 1 — INVENTORY: read the user's brief. List every distinct asset (each = ONE table row), its type (image/speech/music/video), purpose, and any parameters mentioned.

PHASE 2 — SCENE BIBLE (single source of truth for backgrounds):
For every distinct location/setting, write ONE canonical description block. Assign Scene IDs S1, S2, ... Each block contains:
  - Setting (interior/exterior, type)
  - Background (architecture, vegetation, sky, props, depth layers)
  - Time of day & lighting (dawn/noon/dusk/night, direction, colour temp, shadows)
  - Palette (dominant colours, mood)
  - Weather / atmosphere
  - Camera / lens hint (if relevant)
Write each Scene block ONCE. Every image in that scene reuses it VERBATIM.

PHASE 3 — CHARACTER BIBLE (single source of truth for characters):
For every recurring character/object, write ONE canonical block. Assign IDs C1, C2, ... Each block contains:
  - Silhouette (body type, height, posture)
  - Clothing (garments + exact colours)
  - Features (hair, eyes, skin, scars, accessories)
  - Age / build
  - Default expression
Write each Character block ONCE. Every image with that character reuses it VERBATIM.

PHASE 4 — MAP SHOTS: for each image/video, note which Scene ID, which Character IDs, and the shot-specific action (the unique part of THIS frame).

PHASE 5 — COMPOSE BY CONCATENATION (the key rule):
Each image prompt = [style header] + full Scene block (VERBATIM) + full Character block(s) (VERBATIM) + shot-specific action.
  - Verbatim copy = consistent backgrounds/characters. NEVER paraphrase the canonical blocks.
  - Use remaining budget to keep canonical blocks WHOLE. If over the HARD limit, rephrase/trim the shot-action text LAST — never the canonical blocks, never mid-sentence.
  - Speech/music/video: prompt is the text/lyrics/description directly (no scene/character concatenation).

PHASE 6 — ASK THE USER these decision questions BEFORE writing the table (do not guess):
  1. Output folder — assets are saved to the tool's configured output dir (changeable in Settings).
  2. Pipeline usage — after generation, enqueue assets into the post-processing Pipeline (upscale / remove background / crop / resize / optimize-convert), or save as-is? For large images (>2048px), --upscale true at generation time is the inline option. NOTE: the Pipeline is a manual, click-driven board — "auto-pipeline" enqueues, it does not run unattended.
  3. Style consistency — one shared style prefix for the whole batch? If yes, use the STYLE HEADER (below).
  4. Variants — how many variants per asset? (1-5 via --variants; also --n for images.)
  5. Format & quality — required output format? (PNG/JPEG/WebP images; MP3/WAV/FLAC/Opus audio; 768P/1080P video.)
  6. Naming — any naming convention? (Tool keeps the prompt-derived name; a style header helps grouping.)

PHASE 7 — SELF-CHECK PASSES (mechanical, do all five):
  1. Every S{n} image has IDENTICAL scene wording (byte-for-byte from the Scene Bible).
  2. Every C{n} image has IDENTICAL character wording (byte-for-byte from the Character Bible).
  3. All prompts <= HARD limit; over-limit ones rephrased (shot text trimmed first), never cut mid-sentence.
  4. Nothing from the inventory (Phase 1) is missing or duplicated.
  5. Style header present if and only if the user opted in.

---

WORKED EXAMPLE (one scene, three images):

Scene Bible:
  S1 — Forest clearing at dawn. Ancient oak forest, a circular clearing carpeted with wildflowers (lavender, daisies). Background: moss-covered boulders, a narrow stream catching golden light. Time: dawn, warm golden rays from the east, long soft shadows. Palette: emerald green, gold, soft purple. Atmosphere: light morning mist at knee height. Camera: wide-angle, eye-level.

Character Bible:
  C1 — Elara the ranger. Athletic build, 170 cm, confident stance. Clothing: forest-green hooded cloak (#228B22), dark brown leather armour with silver buckles, knee-high black boots. Features: long auburn hair in a braid, hazel eyes, a thin scar across the left cheek. Age ~28, lean. Default expression: calm, alert gaze.

Composed prompts (note the verbatim repetition):
  image | cinematic fantasy art. Ancient oak forest, a circular clearing carpeted with wildflowers (lavender, daisies). Background: moss-covered boulders, a narrow stream catching golden light. [...] Elara steps into the clearing, bow drawn, scanning the tree line. | --model image-01 --aspect-ratio 16:9
  image | cinematic fantasy art. Ancient oak forest, a circular clearing carpeted with wildflowers (lavender, daisies). Background: moss-covered boulders, a narrow stream catching golden light. [...] Elara kneels beside the stream, cupping water in her hands. | --model image-01 --aspect-ratio 16:9
  image | cinematic fantasy art. Ancient oak forest, a circular clearing carpeted with wildflowers (lavender, daisies). Background: moss-covered boulders, a narrow stream catching golden light. [...] The empty clearing at dawn, mist swirling, no one present. | --model image-01 --aspect-ratio 16:9

The Scene block is IDENTICAL in all three rows. The Character block is identical in rows 1-2. Only the shot action (last sentence) differs.

============================================================`;

// ---- Kick-off prompt (shared between MD and TXT) ----
const KICKOFF_PROMPT = `Act as my asset producer for the MiniMax Asset Tool.
I am giving you two things: (1) the tool's official import instruction manual - the document this prompt came from - and (2) my game design document (GDD).

Your task:
1. Read the instruction manual completely. It defines the exact import-table format, every allowed --flag, and the HARD character limits.
2. Read my GDD and list every asset that should be generated (images, speech, music, video).
3. Follow the manual's "Structured workflow": build the Scene Bible (Phase 2) and Character Bible (Phase 3) FIRST, then map shots (Phase 4), then compose each prompt by concatenating the canonical blocks verbatim (Phase 5). THEN ask me the Phase 6 decision questions (output folder, pipeline usage, style consistency, variants, format, naming). Do not guess.
4. Produce the final import table exactly as the manual specifies: one row per asset, parameters as --flags, every prompt under its HARD limit, and a style header as the first line if we agreed on one. The Scene and Character blocks must be VERBATIM identical across all rows that share the same scene/character.

Here is my game design document:
[PASTE YOUR GDD HERE, or attach it as a file]`;

// ---- Check-pass prompt (shared between MD and TXT) ----
const CHECKPASS_PROMPT = `Do a second pass over the import file you just created. Act as a strict reviewer:
1. Verify every row matches the required format (Type | Prompt / Text | Parameters) and that Type is one of image / speech / music / video.
2. Verify every prompt respects the HARD character limits from the manual - rephrase (trim the shot-action text last), never cut mid-sentence.
3. Verify every --flag exists in the manual and uses an allowed value; fix or remove anything invalid.
4. SCENE/CHARACTER CONSISTENCY: verify that every image sharing a Scene ID has byte-for-byte identical scene wording, and every image sharing a Character ID has identical character wording. If any differ, copy the canonical block verbatim from the Scene/Character Bible.
5. Check for duplicate rows, assets missing from my GDD, and a missing or inconsistent style header.
6. Output the corrected import file in full, followed by a short list of what you fixed.`;

module.exports = { PHASES_MD, PHASES_TXT, KICKOFF_PROMPT, CHECKPASS_PROMPT };
