# Changelog

Notable user-facing changes are recorded here. The next public release is being prepared from a clean repository history, so the current work is listed under **Unreleased**.

## Unreleased

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
