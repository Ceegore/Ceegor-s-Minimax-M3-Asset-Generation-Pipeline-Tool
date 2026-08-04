# README signing sections

## Before SignPath acceptance

```markdown
## Code signing status

The project is preparing an application for managed Authenticode signing through
SignPath Foundation. No SignPath signature is claimed until the first signed
release has actually been published.

The current release uses SHA-256 inventories, a detached Minisign signature, an
SBOM and build provenance for integrity verification. These mechanisms do not
replace Windows Authenticode publisher trust. Do not disable Microsoft Defender,
SmartScreen or Smart App Control and do not create antivirus exclusions.
```

## After the first genuine SignPath release

```markdown
## Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

See [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md) for the signing scope,
maintainer roles, approval process, build origin and privacy policy. Only
project-owned binaries are signed with the project identity; redistributed
upstream binaries retain their own signatures or are verified through pinned
hashes and the release SBOM.
```

## Portable installation text for 1.1.0

```markdown
### Windows portable installation

1. Download every `MiniMaxAssetTool-<version>-x64.partN.zip` file and the
   published verification files from this GitHub Release.
2. Keep every part in the same download directory.
3. Extract every part into the same destination directory. The archives merge
   into one `MiniMaxAssetTool-<version>-x64` folder.
4. Open the folder and start `MiniMaxAssetTool.exe`.
5. Before the first start, right-click the EXE, open **Properties → Digital
   Signatures**, and confirm a valid SignPath Foundation signature.

A newly signed release may still have limited SmartScreen reputation initially.
Never continue if Windows Defender reports a concrete malware or PUA detection.
```
