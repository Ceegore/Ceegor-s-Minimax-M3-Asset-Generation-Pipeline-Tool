# Windows release procedure

`package.json` is the source of truth for the version and artifact name. Releases are portable Windows x64 ZIP files built from a clean commit.

## 1. Prepare the repository

```powershell
git status --short
npm ci
npm run setup
npm run check
npm run lint
npm test
npm run test:contract
npm run test:e2e
```

The Git status must be clean before the release build. `npm run setup` populates the ignored `bin/` directory with the local models and binaries that are copied into the release.

## 2. Build and verify

```powershell
npm run build
npm run verify:release
```

The build writes these files under `dist-out/`:

- `MiniMaxAssetTool-<version>-x64.zip`, or numbered ZIP parts when the archive is too large for one GitHub attachment.
- `MiniMaxAssetTool-<version>-x64.zip.sha256`.
- `MiniMaxAssetTool-<version>-x64.provenance.json`.

The provenance record must show the expected commit and `commitDirty: false`. Test the extracted ZIP on a clean Windows account before publishing it.

## 3. Publish on GitHub

1. Create a release tag that matches `package.json`.
2. Paste the prepared text from `docs/GITHUB_RELEASE.md` and adjust the version-specific details.
3. Upload the ZIP, checksum, and provenance files. If the build is split, upload every numbered part.
4. Verify the download from GitHub and extract it again before announcing the release.

GitHub limits individual release attachments to 2 GiB. For a split archive, users must download every `.001`, `.002`, and later part into the same folder, then extract starting with `.001` using 7-Zip.

## Signing and Windows warnings

The project does not currently use an Authenticode certificate. Do not promise that SmartScreen, Defender, AppLocker, or company security policy will allow the app without a warning. Publish the SHA-256 manifest so users can verify that their download matches the release artifact.
