# Decisions & Rules — MiniMax Asset Generation Pipeline Tool

> Durable architecture, security, and convention rules extracted from the
> planning/history docs before they were archived. Read this before touching
> the code. **5-minute reference for contributors.**
>
> Stack: Electron 43 (`electron ^43.1.0` in package.json) + Node main +
> vanilla-JS renderer. **Windows-only.**

---

## 1. Architecture & file-layout rules

### Build-free renderer (non-negotiable)
- **No bundler, no build step, no framework, no TypeScript compilation.** All
  renderer code is plain JS loaded via `<script>` tags in `renderer/index.html`.
- Type help comes from JSDoc `.d.ts` interfaces in `main/interfaces/`, never a
  real compile.
- This rules out ESM `import`, top-level `await`, and anything that needs
  transpilation.

### File-size limits (enforced by `scripts/lint.js` — in CI and in the opt-in pre-commit hook)
- **> 500 lines = HARD FAIL.** 301–500 = WARN (must file an issue + name the
  planned split). Target average ≈ 245 lines.
- `main/index.js` (Composition Root) and `renderer/bootstrap.js` are the only
  intentionally larger modules (in the LEGACY_OVERSIZE allowlist in lint.js).
- **Budget ratchet policy** (`SIZE_BUDGETS` in lint.js): budgets only move
  **down**. Every entry needs an inline justification comment naming the
  decision that set it (lint self-checks this), and when a file shrinks more
  than 40 lines below its baseline, lint fails until the baseline is lowered.
  A budget increase is an explicit, reviewed decision — the default answer to
  "file grew past budget" is *split the file*, not *bump the number*.
- Enforcement triggers: the `Architecture lint` step in
  `.github/workflows/ci.yml` (every push/PR) and `.githooks/pre-commit`
  (opt-in once per clone: `git config core.hooksPath .githooks`).

### Naming bans ("God words")
- **Forbidden suffixes:** `*Manager*`, `*Controller*`, `*System*` (except real
  platform names like `FileSystem`), `*Helper*` (too generic — pick a specific
  noun).
- Required suffixes by tier: `register*` (IPC), `*Service`, `*Tab`, `*Panel`,
  `*Dialog`, descriptive nouns for pure modules.

### Dependency DAG (no cycles, enforced by tier)
```
main/utils   → (no outward calls)
main/models  → main/utils only
main/services→ main/utils + main/models
main/window  → main/services
main/ipc     → main/services + main/models + main/utils
main/index.js= Composition Root (wires everything)
```
Renderer mirrors: `utils → services → components → panels/tabs/dialogs → bootstrap`.
- **Lint cross-tier rule:** `main/↔renderer/` is an error; `main/→src/` is OK;
  `src/→main/` and `renderer/→main/` are errors. Cycles caught by lint.
- **DI convention:** `register*Ipc.js` exports `function register(deps)`. No
  `new OtherService()` inside a service file — the caller (Composition Root)
  injects.

### Process model / contextIsolation
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
  (set in `main/window/createMainWindow.js`; R7.5 flipped `sandbox` from
  `false` to `true` — the preload is sandbox-safe). Renderer has **no direct
  Node access** — every privileged op goes through `window.api.*` from
  `preload.js`.

---

## 2. IPC contract conventions (`docs/ipc-contracts.md` is the SSOT)

- **Channel name:** `<domain>:<action>` (e.g. `mmx:run`, `fb:list`).
- **Renderer bridge:** `window.api.<camelCase>(...)`. The preload mapping is
  **1:1 and must survive refactors** — preload changes require updating
  `ipc-contracts.md` AND `tests/unit/main/ipc/fullToolSweep.test.js`.
- **Envelope (every request/response handler):** `{ ok: true, … }` or
  `{ ok: false, error: '…' }`. Main catches all exceptions and converts to
  `{ ok: false, error: String(e.message) }`.
- **One handler file per domain** under `main/ipc/register*Ipc.js`.
- **`mmx:run` arg validation:** parse `--out` / `--download` (parent must be
  under an allowed root via `isParentUnderAny`) and `--out-dir` (itself under a
  root via `isPathUnderAny`) **before** spawning mmx. Out-of-root → reject.

---

## 3. Security rules

### Path allow-list (`main/services/PathSecurityService.js`)
- `getAllowedRoots()` = **effective** `output_dir` **+ `trustedPickPaths`**
  (paths the user explicitly picked via `file:pick`, auto-added).
- **Every** IPC handler that takes a path argument MUST route it through
  `isPathUnderAny()` / `isParentUnderAny()`. Handlers with no path arg are
  explicitly marked in `ipc-contracts.md`.
- **Symlink closure:** `isPathUnder` should be realpath-aware — resolve symlinks
  before comparison, so a symlink inside a root pointing outside is rejected.

### Content Security Policy
- Renderer makes **no direct network calls** — everything is IPC to main / mmx.
  `connect-src 'self'` (tightened from `'self' https:`). Keep `img-src 'self' data: blob:`.
- **No `wasm-unsafe-eval`** — this is why the editor's inpaint is pure-JS in the
  main process, not OpenCV.js WASM in the renderer.

### Other hardening rules
- **`shell.openExternal`** must go through `main/utils/UrlSanitizer.js` —
  http(s) only, reject control chars + embedded credentials.
- **PowerShell `Expand-Archive`** must pass paths via **env vars**, never string
  interpolation.
- **Real-ESRGAN / model downloads** must checksum-verify between download and
  use; mismatch → delete, do not use.
- **mmx subcommand allowlist** (`main/models/MmxSubcommandAllowlist.js`):
  `image | speech | music | video | quota | voices` only.
- **`config:set`** is sanitised by `main/models/ConfigSchema.js` before write.
- **`config.txt` is the only file containing anything sensitive** (the API key).

---

## 4. State management conventions

### Single source of truth
- **`window.state` is the live state object** (defined in
  `renderer/sections/section24_State.js`). Do **not** use the parallel
  `window.AppState` loaded by `bootstrap.js` — nothing reads it (documented dead
  code / footgun). Do not introduce a second state owner.
- Locally-aliased `var state` inside a `<script>` tag is a **separate object**
  from `window.state` — writes don't propagate. Always touch `window.state`.

### Persistence (the sanitiser pattern)
- **`window.STATE_PERSIST_KEYS`** (in `section24_State.js`) is the canonical key
  list and **MUST exactly match** the shape written by `src/state.js write()`.
- `src/state.js` **deep-sanitises every field on write AND on read** (the
  read-side sanitiser was added to close a security gap where a hand-edited
  state.json landed malicious values before the first save).
- All state writes are **atomic** (`tmp` + `rename`) — preserve this for
  `state.json`, `batches.json`, and any new persisted file.
- `scheduleStateSave()` is debounced.

### Config directory resolution
- `src/config.js` honours `MINIMAX_CONFIG_DIR` (and an exe/cwd fallback chain).
  `src/state.js` and `src/batches.js` **must** reuse `config.js`'s `configDir`
  — never re-derive the path independently.

---

## 5. Pipeline model decisions

### Image pipeline (the column board)
- Image **pixel work is renderer-side via Canvas API** (crop/convert/canvas-upscale);
  the heavy ML ops (Real-ESRGAN upscale, IS-Net/BiRefNet bg-removal) run in the
  **main process** (spawned child or in-process onnxruntime-node), keeping the
  renderer CSP-tight.
- Pipeline output files live in `<output_dir>/pipeline/image/<column>/img_<id>_<name><suffix>.<ext>`.
- The board is `window.state.pipeline.image` (items[], trash[], workspace,
  per-column defaults). Items cap at 1000, trash at 200.
- New pipeline features (v1.5): per-card info panel, Duplicate (insert below
  original via `pipeline:import`), batch-export-final-column, per-item
  Save&Remove. See `pipelineCardExtras.js`.

### Audio pipeline (ffmpeg)
- **All heavy work in main** (decode/encode) because ffmpeg is bundled.
- **Pure audio math (e.g. `findZeroCrossing`) is unit-testable** — keep new
  audio math pure where possible.
- Click prevention: zero-crossing snap **plus** a 5 ms `afade` at both cut edges.

---

## 6. Build / release workflow

- The project ships as a **portable zip** via `scripts/zip-portable.js`
  (electron-builder `dir` target, not a signed installer).
- `bin/` (models + binaries) is **gitignored** and populated by `npm run setup`
  (downloads Real-ESRGAN, IS-Net/BiRefNet, and v1.5 LaMa/MI-GAN models).
- **Workflow after any source change for a release:** `npm test` (gate) →
  `npm run build` → ship the zip. There is no fixed-hash signed `.exe` in this
  repo (the old `dist-stable` stable-exe workflow was for an earlier release
  strategy and is archived).
- Consequence: wire-format changes are safe to make (no backwards-compat anchor
  to an old binary).

---

## 7. Known gotchas / foot-guns

| # | Trap | Rule |
|---|---|---|
| G1 | `const`/`let` at top level of a `<script>` tag is **not** global | Use `var` or explicit `window.X = …` for cross-file renderer globals. |
| G2 | `<script>` load order matters (no modules) | Dependencies must appear **before** consumers in `index.html`. |
| G3 | Case-mismatched includes (e.g. `logService.js` vs tracked `LogService.js`) | Work on Windows, break on case-sensitive FS. Match git casing exactly. |
| G4 | Dead parallel state system | `window.AppState`, several `*Service` modules have **no live consumers**. Re-grep before deleting; do not add new subscribers assuming they work. |
| G5 | `npm test` glob needs Node ≥21 | Use `node --test` (recurses on modern Node). `engines.node` floor is `>=22.12.0` (see package.json). |
| G6 | `fb:mkdir` always requires a named subfolder | Use `fb:ensureDir` to create `dir` itself recursively. |
| G7 | Renderer error logging via `window.api.logToFile` can silently no-op | If the preload bridge is off, `window.api` is undefined in renderer. Verify the bridge before relying on renderer-side logging. |
| G8 | `deepStrictEqual` on objects from a `vm` sandbox | Cross-realm objects fail `deepStrictEqual` even when structurally equal — compare field-by-field in vm-sandbox tests. |

---

## 8. Quality gates

- **Lint** (`npm run lint` → `scripts/lint.js`): file-size cap + budget
  ratchet, God-word ban, cross-tier DAG check. Runs in CI
  (`.github/workflows/ci.yml`, first step of the `test` job) and in the
  opt-in pre-commit hook (`git config core.hooksPath .githooks`).
- **Tests** (`npm test` → `node --test`): pure-module unit tests using Node's
  built-in `node:test` + `assert` (no extra framework, no build).
- **Affected tests** (`npm run test:affected`): inner-loop shortcut — maps
  files changed vs HEAD to their unit tests and runs only those; falls back
  to the full suite when a change has no mapped test. `npm test` remains the
  commit/CI gate.
- **Smoke** (`npm run test:smoke`): loads the full renderer in Electron,
  asserts zero console/main-process errors. The real integration gate.
- One logical change per commit so each fix is revertable in isolation.

---

## 9. Persistent files (what lives where)

| File | Location | Contents |
|---|---|---|
| `config.txt` | next to `.exe` (or `MINIMAX_CONFIG_DIR`) | API key, output dir, region (**only sensitive file**) |
| `state.json` | next to `.exe` (or `MINIMAX_CONFIG_DIR`) | per-tab form values, current tab, fb dirs, prefix, upscale/optimize/layout/pipeline settings, popup policy |
| `batches.json` | next to `.exe` (or `MINIMAX_CONFIG_DIR`) | BatchGen lists (per tab, ≤100 prompts) |
| `<output_dir>/<tab>/…` | user-chosen | generated assets |
| `<output_dir>/pipeline/image/…` | user-chosen | pipeline workspace (per-column folders + `.thumbs/` + `.trash/`) |

---

## Related documentation

- `docs/ARCHITECTURE.md`
- `docs/ipc-contracts.md`
- `docs/RELEASE.md`
