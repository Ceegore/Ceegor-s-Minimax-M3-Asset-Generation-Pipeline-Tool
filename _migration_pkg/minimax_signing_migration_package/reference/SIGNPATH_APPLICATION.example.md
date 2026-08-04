# SignPath Foundation application text – MiniMax Asset Tool

## Project

- **Name:** MiniMax Asset Tool
- **Repository:** https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool
- **License:** MIT
- **Platform:** Windows 11 x64
- **Distribution:** Portable, independent multipart ZIP archives through GitHub Releases

## Project description

MiniMax Asset Tool is a Windows desktop application for planning, generating,
processing and organizing image, speech, music and video assets. It combines a
document-to-asset-plan workflow, queued provider generation, local image and
audio processing, file organization and export reports.

The project is publicly maintained on GitHub. Its release process includes
automated tests, runtime hash verification, an SBOM, build provenance, SHA-256
release inventories, detached Minisign signatures and clean Windows VM
acceptance tests.

## Existing release form

The application is already released in the same intended portable multipart-ZIP
distribution form. Version 1.0.7 is the final transition release. It keeps a
previously validated Windows runtime byte-identical while updating Electron
application content through app.asar. This transition mechanism will be retired
before the first SignPath release.

Future 1.1.x releases will be built fully from source by GitHub Actions. The
workflow will upload the GitHub workflow artifact before submitting the signing
request, require manual approval, download the signed result, verify it, package
it and publish only the exact accepted artifact.

## Requested signing scope

Initially, only the project-owned application launcher is requested for signing:

```text
MiniMaxAssetTool.exe
```

Electron components, FFmpeg, FFprobe, Real-ESRGAN, ONNX Runtime, native Node
modules, Minisign and other upstream binaries will not be signed with the
project certificate. Their source, version, license and hashes are tracked
separately.

## Team roles

- **Author/committer:** Ceegore
- **Reviewer for external contributions:** Ceegore
- **Signing approver:** Ceegore

GitHub and SignPath multi-factor authentication will be enabled. Every signing
request will be manually reviewed and approved.

## Privacy

Project files and local post-processing remain on the user's computer. Prompts
and user-selected inputs are sent only when the user explicitly starts an
operation using a configured cloud provider. The project does not operate an
intermediary generation server and does not intentionally send maintainer
analytics or telemetry. The full policy is published in `PRIVACY.md`.

## Additional evidence

The application page and release page describe the functionality, installation,
uninstallation, privacy behavior, third-party components and release integrity
process. Release builds identify the source commit and GitHub Actions run.
