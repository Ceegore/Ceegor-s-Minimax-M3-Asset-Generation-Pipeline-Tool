# MiniMax Asset Tool 1.0.7

Version 1.0.7 is the final legacy-compatible 1.0.x release.

It contains the current application code and complete offline runtime. To avoid reintroducing the Windows execution problem that affected newly built unsigned launchers, this transition release keeps the previously validated Windows runtime binaries byte-identical and updates the Electron application content through `resources/app.asar`.

This is not a newly Authenticode-signed release and does not establish a new verified Windows publisher. Because the launcher bytes are intentionally unchanged, Windows file properties may still show the older runtime file/product version. The application content, release tag, provenance and `LEGACY_RUNTIME_NOTICE.json` identify this release as 1.0.7. Integrity is protected through SHA-256 manifests, a detached Minisign signature, build provenance, and an SBOM.

Do not disable Microsoft Defender, SmartScreen, Smart App Control, or add antivirus exclusions. Download only from this repository and verify the published files.

The next release line is being prepared for managed Authenticode signing.
