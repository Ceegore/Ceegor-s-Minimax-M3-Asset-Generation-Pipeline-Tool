# Changelog

Notable user-facing changes are recorded here.

## 1.0.4 - 2026-08-03

### Fixed

- Release-gate workflow YAML parse error: an unquoted ": " in a step name made GitHub reject every run of the workflow with no diagnostics (this invalidated the v1.0.3 tag run). The step name is now quoted.

### Added

- Workflow contract test now parses every workflow file as YAML and rejects unquoted names containing ": ", so a workflow that GitHub cannot parse can never reach a tag again.

## 1.0.3 - 2026-08-03

### Added

- Release gate workflow: every mandatory gate is now an explicit job — qualification (lint, unit, coverage gate, contract, IPC coverage), packaged E2E + smoke, flakiness qualification (10× full suite), directed mutation testing, build/sign/verify, and clean-VM acceptance — with publication depending on all of them.
- Flakiness qualification runner (`test:flaky`) with evidence report.
- Directed mutation-testing gate (`test:mutation`) for the credential/security modules, with evidence report.
- Regression suites pinning the credential keep-save, corrupt-key reporting, typed save outcomes, and the release-gate job inventory.

### Fixed

- Provider settings save with "keep existing key" no longer drops the stored credential reference (the encrypted key blob was orphaned).
- A corrupt or unreadable stored provider key now reports `hasKey=false` with actionable repair guidance instead of claiming a usable key; generation and model listing fail fast before spending money.
- Provider settings save now returns typed `committed`/`partial`/`failed` outcomes; partial key failures are surfaced as errors and the dialog stays open for repair instead of showing false success.
- Signed release workflow no longer writes signing material into the repository worktree (which dirtied build provenance); the clean tree and exact commit SHA are re-asserted before the build and provenance is verified afterwards.
- Release documentation now describes the signed-release verification path (Authenticode + Minisign + checksums) instead of the outdated unsigned/checksum-only guidance.

## 1.0.2 - 2026-07-30

### Added

- Secure IPC wrapper (`secureHandle`) with sender-frame and origin validation on every registered channel.
- Artifact finalization service: validates output files (size, magic bytes) before reporting success to the renderer.
- SSRF protection (`urlPolicy`) for all provider HTTP calls (blocks loopback, link-local, private ranges).
- Payload limits service: enforces maximum argument sizes on IPC mutations.
- Cloud job gate and confirmation token service for paid API call authorization.
- Feature flags service for staged rollout of experimental capabilities.
- Secret store with OS-credential-backend abstraction (no secrets in argv or localStorage).
- Image admission policy: validates type, dimensions, and file size before pipeline entry.
- Capped process runner: bounds concurrent backend spawns (prevents resource exhaustion).
- Corrupt-state backup: automatic `.corrupt` snapshot before overwriting a damaged state file.
- Image editor exit guard: unsaved-changes confirmation before discarding edits.
- Electron fuse configuration script (`set-fuses`) and SBOM generation (`generate-sbom`).
- Release signing scaffold (`sign-release`) for future Authenticode integration.
- Dependabot configuration for automated dependency updates.
- SECURITY.md vulnerability reporting policy.
- Security, stress, and release test suites.

### Improved

- All 30 IPC handler modules migrated to `secureHandle` with consistent error envelopes.
- PathGrantService: hardened canonicalization (ancestor-walk for non-existent paths), case-insensitive comparison, single-use grant consumption, and TTL eviction.
- Pipeline ops refactored: extracted `pipelineFileOps` and `pipelineCardMutations` for testability.
- `mmxArgSanitizer` expanded with comprehensive argument allow-lists and type coercion.
- Audio trim/cut: added duration guards and format validation.
- Archive service: hardened zip extraction with path-traversal protection.
- File browser: improved serialization and race-condition handling.
- Batch direct runner: normalized parameter shapes and improved partial-cancel recovery.
- Provider IPC: added URL validation, timeout enforcement, and response-size caps.
- Reset IPC: added confirmation gate and state backup before destructive operations.
- Window creation: added CSP hardening and devtools policy.

### Fixed

- Falsy-zero bugs: `webpEffort=0`, `padMs=0`, and optimizer quality parameters no longer collapse to defaults via `|| fallback`.
- Batch cancel path now recovers output-dir files so the job records its outputs.
- State sanitizer bounds: `tileSize` and `gpuId` correctly clamped (no out-of-range passthrough).
- Image editor heal: proper grant forwarding for inpaint IPC calls.
- Pipeline grant resolution: consistent `ensurePathGrant` usage across all card operations.
- External tools IPC: corrected parameter forwarding for Real-ESRGAN and ISNetBG.

## 1.0.1 - 2026-07-29

### Added

- BatchGen combined all-types confirmation overlay with per-type paid-call counts, output folder picker, and per-asset-type subfolder opt-out.
- BatchGen per-entry parameter editor with live defective-entry validation and repair in the queue editor.
- Fenced ```batch-json lossless import format for pipes-in-prose, multiline speech, and structured lyrics.
- Style header auto-detection in import files with one-click preset creation.
- Per-row post-processing flags in batch entries (upscale, crop, resize, optimize, remove-bg, trim).
- Batch auto-remove now persists queue state after each successful item.
- Release split-archive packaging with independent part zips (no join step needed).

### Improved

- BatchGen progress overlay with per-item log, elapsed timer, progress bar, and stop button.
- Partial-success handling: a batch item with some failed variants no longer drops the successful ones.
- Direct-mode batch execution (snapshot-based) eliminates DOM inheritance bugs.
- Import capacity overflow detection with clear truncation warnings.
- Release installer verifies and extracts multipart zips using built-in Windows tools.

### Fixed

- BatchGen per-tab run lock preventing concurrent starts of the same queue.
- Auto-remove firing on partial variant success (now requires ALL variants to succeed).
- Per-item field restore in batch runner (style, prefix, upscale, auto-pipeline).
- Import param tokenizer handling of colon-separated values, negative numbers, and URL schemes.
- Release packaging: correct top-level folder name, provenance record, and checksum manifest.

## 1.0.0 - 2026-07-28

### Added

- Document-to-batch workflow for turning a GDD, story, script, or other source text into a structured multi-asset plan.
- Batch import and generation across image, speech, music, and video, with per-row settings and variants.
- Column-based local image pipeline with upscale, background removal, crop, resize, optimization, conversion, and final export.
- Pipeline export and clear reports for production records.
- Image editor with compositing, paint, selection, transform, and heal/inpaint tools.
- Audio cutter with waveform navigation, silence trimming, zero-crossing snap, micro-fades, and multiple output formats.
- Optional provider connections for OpenAI-compatible APIs and Replicate.
- Packaged-build, contract, unit, E2E, IPC-coverage, UI-coverage, and visual-regression checks.
- No-admin per-user Windows installer with Desktop and Start menu shortcuts. It can verify, join, and extract multipart release downloads without a separate archive program.

### Improved

- Safer file access through scoped path grants and a sandboxed renderer.
- Session-only API-key handling and credential redaction.
- Job cancellation, retry handling, progress reporting, and recovery from partial failures.
- Batch and pipeline output naming, folder organization, duplicate handling, and collision-safe saves.
- Model availability checks, download validation, and clearer fallback warnings.
- Windows release verification with checksums and build provenance.
- Runtime dependencies and lockfile updated for current security fixes.
- Full offline runtime checks with pinned sizes and SHA-256 hashes for every bundled model and native processing asset.

### Fixed

- Generation parameter, batch import, and per-model compatibility errors.
- File-browser navigation, move/copy/delete, and stale-path edge cases.
- Pipeline state, card ordering, clear/export, and post-processing failures.
- Image editor history, selection, resize, background removal, and inpaint failures.
- Audio trimming, waveform, format, and packaged FFmpeg path issues.
- Startup, shutdown, modal, renderer, and packaged-build regressions found during pre-release testing.
- GitHub Actions validation and the downloadable installer filename used by the release page.
