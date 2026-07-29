# Changelog

Notable user-facing changes are recorded here.

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
