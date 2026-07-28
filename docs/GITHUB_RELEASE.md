# GitHub text

## Repository description

Windows batch asset production for MiniMax: turn a GDD or story into image, speech, music, and video jobs, process images locally, and export organized files with reports.

## Suggested topics

`minimax` · `asset-generation` · `batch-processing` · `electron` · `image-processing` · `game-development` · `windows`

## Release title

MiniMax Asset Tool v1.0.0 — first clean public release

## Release body

MiniMax Asset Tool helps you produce a full set of project assets without setting up every request by hand.

Start with a game design document, book, script, lore guide, or other source text. The document workflow turns it into a structured asset plan, BatchGen queues the image, speech, music, and video jobs, and the local image pipeline handles upscale, background removal, crop, resize, optimization, and format conversion. Final files are saved in a predictable folder structure, and optional export reports help you keep a record of what was processed and where it was saved.

Highlights:

- Document → structured batch → generation queue → local pipeline → organized export.
- Image, speech, music, and video generation in one Windows app.
- Batch settings, variants, retries, progress, and cancellation.
- Local image post-processing and an in-app image editor.
- Audio cutting with waveform, silence trim, zero-crossing snap, and common export formats.
- Optional session-only API keys and a sandboxed renderer.
- Portable release: extract the ZIP and run `MiniMaxAssetTool.exe`.

The app is MIT licensed and designed for commercial workflows without an extra software-license fee. The selected local components allow commercial use under their own licenses. MiniMax and other API providers may still charge for generation and apply separate terms. Reports support your production records but do not replace a rights or legal review.

### Download

Download `MiniMaxAssetTool-1.0.0-x64.zip` and the matching `.sha256` file. Extract the ZIP, run `MiniMaxAssetTool.exe`, add your API key, and choose an output folder.

If the release uses numbered archive parts, download every part into the same folder and extract from `.001` with 7-Zip.

### Requirements

- Windows 11 x64.
- A MiniMax account and API access for generation.
- Enough free disk space for the app, local models, and generated assets.

This build is not code-signed, so Windows may show a reputation warning. Use the published SHA-256 file to verify the download.
