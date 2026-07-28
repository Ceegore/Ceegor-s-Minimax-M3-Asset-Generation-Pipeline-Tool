# MiniMax Asset Tool

[![CI](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/actions/workflows/ci.yml/badge.svg)](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/actions/workflows/ci.yml)
[![E2E Real](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/actions/workflows/e2e-real.yml/badge.svg)](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/actions/workflows/e2e-real.yml)

A Windows desktop app for producing large sets of images, speech, music, and video with MiniMax. It brings planning, batch generation, local image processing, file organization, and export reports into one workflow.

The tool is aimed at projects that need more than a few isolated assets. Start with a book, game design document, lore guide, script, or plain text; turn it into a structured batch; generate the assets; process the results; and save everything in a predictable folder structure.

## The workflow

### 1. Turn a document into an asset plan

Paste a GDD, story, script, or other source text into the document workflow. The built-in MiniMax M3 flow extracts recurring scenes and characters, builds an asset list, and produces a structured `batch-json` document. You can review the document before importing it.

Already have an asset list? BatchGen also accepts structured imports and plain prompt lists, so you can prepare the work in another writing tool if you prefer.

### 2. Generate the batch

BatchGen routes each row to the right generator—image, speech, music, or video—and keeps the row's model, prompt, format, variant count, and other settings together. The queue shows progress, retries temporary failures, and lets you stop individual jobs or the full run.

This removes most of the repetitive setup that normally comes with producing dozens or hundreds of related assets.

### 3. Process images locally

Generated images can move straight into the column-based pipeline:

**Import → Upscale → Remove background → Crop → Resize → Optimize/convert → Final**

Use per-item settings when one asset needs different treatment, duplicate a card to keep variants, or export the final column as a batch. Upscaling, background removal, resizing, conversion, optimization, and inpainting run on the local machine after the source image has been generated.

### 4. Save an organized result

Outputs are stored in folders by asset type and pipeline stage, with collision-safe filenames. The integrated file browser supports search, previews, multi-select, rename, copy, move, delete, and hand-off to external editors.

Pipeline export and clear reports can record the asset ID, dimensions, format, final path, export destination, and processing-history count. These reports are useful for production records and provenance notes—for example, when documenting which files were generated and processed for a commercial project. They support your records; they are not a legal certificate or a substitute for checking the terms that apply to your prompts, source material, provider, model, and output.

## Main features

- Image, speech, music, and video generation through MiniMax.
- Optional OpenAI-compatible and Replicate provider connections.
- Reusable style presets and per-row batch settings.
- Queue controls, variants, retries, cost preview, and cancellation.
- Local Real-ESRGAN upscaling and IS-Net/BiRefNet background removal.
- Crop, resize, optimize, and convert to PNG, JPEG, WebP, or AVIF.
- Image editor with paint, erase, selection, compositing, and heal/inpaint tools.
- Audio cutter with waveform view, silence trim, zero-crossing snap, micro-fades, and common export formats.
- Local state and batch persistence, plus an optional session-only API-key mode.
- Sandboxed Electron renderer with a restricted IPC bridge and path grants.

## Commercial use and cost

The application is MIT licensed. It is designed so that the app and the selected local processing components can be used in commercial projects without an additional software-license fee. The bundled components use licenses that allow commercial use, including MIT, Apache-2.0, BSD-3-Clause, and GPL licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the exact list and obligations.

This does not make cloud generation free. MiniMax and any optional provider may charge for API use and apply separate service and output terms. You are responsible for reviewing those terms and for making sure you have the necessary rights to the source material and final assets.

## Privacy

Project files, settings, and post-processing stay on your computer. Prompts and inputs used for generation are sent to the API provider you choose. API keys are stored locally unless you enable session-only mode, which keeps the key off disk for that session.

## Easy Windows installation

The full release is made for nontechnical users. It includes Electron, Node.js, the MiniMax command-line client, FFmpeg, Sharp, ONNX Runtime, Real-ESRGAN, and every supported local model. You do not need to install Python, .NET, Node.js, or any image tool, and the app does not download local components while you use it.

1. Open [Releases](../../releases). Download **Install-MiniMax-Asset-Tool.cmd**, the `.zip.sha256` file, and every numbered `.zip.001`, `.zip.002`, and later part listed under **Full offline Windows release**. Keep them together in one folder.
2. Double-click **Install-MiniMax-Asset-Tool.cmd**. It checks every download, joins and extracts the parts, installs the app for your Windows account, and creates Desktop and Start menu shortcuts.
3. When the app opens, enter your MiniMax API key and choose an output folder.

No archive program or administrator access is needed. Allow roughly 9 GB of free space during installation; the temporary extraction files are removed after a successful install. The installer makes no network requests.

The tool needs an internet connection when it sends generation requests to MiniMax or another cloud provider. All post-processing runs with the included local components.

### Portable option

Experienced users can instead join/extract the archive parts with 7-Zip and run `MiniMaxAssetTool.exe` directly from the extracted `win-unpacked` folder. Keep the entire folder together; the EXE needs the `resources` folder beside it.

### Windows security message

The current release is not code-signed, so Windows may identify it as an unknown publisher or show **Windows protected your PC**. Download it only from this repository and compare the files with the published `.sha256` manifest. If the checksum matches, choose **More info → Run anyway**. Do not disable Microsoft Defender or add an antivirus exclusion. A managed work or school computer may require approval from its administrator.

## Develop from source

Requirements: Windows 11, Node.js 22.12 or newer, and a MiniMax account for live generation tests.

```powershell
npm ci
npm run setup
npm start
```

Useful checks:

```powershell
npm run lint
npm test
npm run test:contract
npm run test:e2e
npm run check
npm run build
npm run verify:release
```

`npm run setup` downloads the local runtime models and binaries into the ignored `bin/` directory. `npm run build` creates the portable release ZIP under `dist-out/`.

See [docs/README.md](docs/README.md) for architecture, IPC, and release documentation.

## License

The application source is available under the [MIT License](LICENSE). Third-party programs, libraries, and model files keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

MiniMax Asset Tool is an independent project and is not an official MiniMax product.

<img width="1638" height="883" alt="Main window with generation tabs and file browser" src="https://github.com/user-attachments/assets/fcbf7ed9-e369-41b9-8ed3-763001e7bb9b" />

<img width="1920" height="1032" alt="Column-based image processing pipeline" src="https://github.com/user-attachments/assets/3770048b-fcfd-4d05-8e51-413046a8cde1" />

<img width="610" height="960" alt="Image editor with Asset Composer panel" src="https://github.com/user-attachments/assets/66a2e5de-57ef-4e59-949e-b09515845908" />
