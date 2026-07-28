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
- Easy no-admin installer plus a portable option.
- Complete offline local runtime: no separate Node.js, Python, .NET, FFmpeg, model, or image-tool install.

The app is MIT licensed and designed for commercial workflows without an extra software-license fee. The selected local components allow commercial use under their own licenses. MiniMax and other API providers may still charge for generation and apply separate terms. Reports support your production records but do not replace a rights or legal review.

### Download

#### Easy installation (recommended)

1. Download `Install-MiniMax-Asset-Tool.cmd`, `MiniMaxAssetTool-1.0.0-x64.zip.sha256`, and every numbered `.zip.001`, `.zip.002`, and later part. Keep them in the same folder.
2. Double-click `Install-MiniMax-Asset-Tool.cmd`. It verifies every part, extracts the release with built-in Windows tools, installs the app for your account, and creates Desktop and Start menu shortcuts.
3. When the app opens, add your API key and choose an output folder.

No archive program, administrator access, or separate dependency download is needed. Allow roughly 9 GB of free space during installation. The complete app runtime, FFmpeg, local processing tools, and supported local models are included. An internet connection is only needed for cloud generation requests.

The installer makes no network requests and does not weaken Windows security settings.

#### Portable use

Experienced users can join/extract the parts with 7-Zip, keep the extracted folder together, and run `MiniMaxAssetTool.exe` directly.

### Requirements

- Windows 11 x64.
- A MiniMax account and API access for generation.
- Enough free disk space for the app, local models, and generated assets.

This build is not code-signed, so Windows may show an unknown-publisher or SmartScreen reputation warning. Download only from this repository and use the published SHA-256 file to verify it. If the checksum matches, choose **More info → Run anyway**. Do not disable Defender or add an antivirus exclusion. Managed computers may require administrator approval.
