# GitHub text

## Repository description

Windows batch asset production for MiniMax: turn a GDD or story into image, speech, music, and video jobs, process images locally, and export organized files with reports.

## Suggested topics

`minimax` · `asset-generation` · `batch-processing` · `electron` · `image-processing` · `game-development` · `windows`

## Release title

MiniMax Asset Tool v1.0.6 — Release integrity hardening

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

1. Download **every** release file and keep them all in the same folder. The mandatory set is: `Install-MiniMax-Asset-Tool.cmd`, `MiniMaxAssetTool-1.0.6-x64.sha256` (inventory manifest), `MiniMaxAssetTool-1.0.6-x64.sha256.minisig` (detached signature), `minisign.pub` (pinned public key), `minisign.exe` (pinned verifier), and every `MiniMaxAssetTool-1.0.6-x64.part1.zip`, `.part2.zip`, and later part. The installer checks fail-closed and refuse to start if any of these files is missing.
2. Double-click `Install-MiniMax-Asset-Tool.cmd`. It verifies the manifest signature and every part, extracts the release with built-in Windows tools, installs the app for your account, and creates Desktop and Start menu shortcuts.
3. When the app opens, add your API key and choose an output folder.

No archive program, administrator access, or separate dependency download is needed. Allow roughly 9 GB of free space during installation. The complete app runtime, FFmpeg, local processing tools, and supported local models are included. An internet connection is only needed for cloud generation requests.

The installer makes no network requests and does not weaken Windows security settings.

#### Portable use

Experienced users can extract every part into the same folder with any archiver (the parts merge into one `MiniMaxAssetTool-1.0.6-x64` folder), keep that folder together, and run `MiniMaxAssetTool.exe` directly.

### Requirements

- Windows 11 x64.
- A MiniMax account and API access for generation.
- Enough free disk space for the app, local models, and generated assets.

This release does not yet carry a new project Authenticode signature. Release integrity is protected by the published `.sha256` inventory manifest covering every shipped file (archives, installer, provenance, SBOM, signing key, and the pinned Minisign verifier) with a detached Minisign signature (`.sha256.minisig`). Download only from this repository and verify the files against the published SHA-256 manifest and the Minisign signature before running. The final legacy-compatible 1.0.x release keeps the previously validated Windows runtime binaries byte-identical and updates the application content through Electron's app.asar package; future 1.1.x releases are being prepared for managed Authenticode signing. Do not disable Defender, SmartScreen or Smart App Control, do not add an antivirus exclusion, and never run files whose signature or checksums do not match. Managed computers may require administrator approval.
