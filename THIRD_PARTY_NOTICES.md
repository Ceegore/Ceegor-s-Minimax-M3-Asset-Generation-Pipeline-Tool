# Third-party notices

MiniMax Asset Tool is MIT licensed. It also uses third-party software and model files under their own licenses. Commercial use is permitted by the licenses listed below, but their notice, source, redistribution, and other conditions still apply.

This file is a practical inventory, not legal advice. Version details for npm packages are locked in `package-lock.json`; model download URLs and checksums are defined in `scripts/setup.js`, `src/isnetbg/modelRegistry.js`, and `src/inpaint/modelRegistry.js`.

## Runtime software

| Component | Use | License | Source |
|---|---|---|---|
| Electron | Desktop runtime | MIT | <https://github.com/electron/electron> |
| MiniMax CLI (`mmx-cli`) | MiniMax API client | MIT | <https://github.com/MiniMax-AI/cli> |
| ONNX Runtime | Local model inference | MIT | <https://github.com/microsoft/onnxruntime> |
| sharp / libvips | Image resize, conversion, and optimization | Apache-2.0 and bundled dependency licenses | <https://github.com/lovell/sharp> |
| FFmpeg via `ffmpeg-static` | Audio probing, cutting, and conversion | GPL-3.0-or-later for the npm package; the included FFmpeg build carries its own configuration-dependent license | <https://github.com/eugeneware/ffmpeg-static> |
| Real-ESRGAN / Real-ESRGAN-ncnn-vulkan | Local image upscaling | BSD-3-Clause | <https://github.com/xinntao/Real-ESRGAN> |
| ncnn | Runtime used by Real-ESRGAN-ncnn-vulkan | BSD-3-Clause | <https://github.com/Tencent/ncnn> |

The complete license files included by npm remain in their package directories. If you redistribute a release, keep this notice and the packaged license files. In particular, review the GPL obligations for the exact FFmpeg binary that is shipped and provide the corresponding source information required by that license.

## Downloaded model files

`npm run setup` downloads these model families into the ignored `bin/models/` directory:

| Model family | Purpose | License recorded by this project | Source |
|---|---|---|---|
| IS-Net | Background removal | Apache-2.0 | <https://github.com/xuebinqin/DIS> |
| BiRefNet | Background removal | MIT | <https://github.com/ZhengPeng7/BiRefNet> |
| MI-GAN | Image inpainting | MIT | <https://github.com/Picsart-AI-Research/MI-GAN> |
| LaMa | Image inpainting | Apache-2.0 | <https://github.com/advimman/lama> |
| Real-ESRGAN model files | Image upscaling | BSD-3-Clause project distribution | <https://github.com/xinntao/Real-ESRGAN> |

Do not add or auto-download a model marked for non-commercial use. The model registries intentionally expose download URLs only for models accepted for commercial workflows.

## Build-only software

Electron Builder and `7zip-bin` are MIT licensed and are used to create the Windows release archive. They are development dependencies rather than application features.

## Cloud services and generated output

MiniMax and optional providers are services, not components licensed by this repository. Their pricing, acceptable-use rules, input terms, and output terms apply separately. A pipeline report can support your internal records, but it does not grant rights or prove that an asset is legally clear for a particular use.
