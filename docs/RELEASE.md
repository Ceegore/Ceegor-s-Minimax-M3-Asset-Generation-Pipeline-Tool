# Windows release procedure

`package.json` is the source of truth for the version and artifact name. Releases are portable Windows x64 ZIP files built from a clean commit.

## 1. Prepare the repository

```powershell
git status --short
npm ci
npm run setup
npm run check
npm run check:deps
npm run lint
npm test
npm run test:contract
npm run test:e2e
```

The Git status must be clean before the release build. `npm run setup` populates the ignored `bin/` directory. `npm run check` verifies all 19 required runtime files against `scripts/runtime-assets.json`, including size and SHA-256, so a partial or changed model cannot enter a release.

## 2. Build and verify

```powershell
npm run build
npm run verify:release
```

The build writes these files under `dist-out/`:

- `MiniMaxAssetTool-<version>-x64.zip`, or numbered ZIP parts when the archive is too large for one GitHub attachment.
- `MiniMaxAssetTool-<version>-x64.zip.sha256`.
- `MiniMaxAssetTool-<version>-x64.provenance.json`.

The build also runs the exact packaged-dependency check and tests the no-admin installer and its shortcuts. The provenance record must show the expected commit and `commitDirty: false`. Test the extracted ZIP on a clean Windows account before publishing it.

## 3. Publish on GitHub

1. Create a release tag that matches `package.json`.
2. Paste the prepared text from `docs/GITHUB_RELEASE.md` and adjust the version-specific details.
3. Upload the ZIP, checksum, provenance, and root-level `Install MiniMax Asset Tool.cmd` files. If the build is split, upload every numbered part. Label them **Full offline Windows release**.
4. Verify the download from GitHub and extract it again before announcing the release.

GitHub limits individual release attachments to 2 GiB. The root-level CMD verifies and joins a split archive before extracting it with Windows' built-in archive tool. Experienced users can still extract starting with `.001` using 7-Zip.

## Signing and Windows warnings

The project does not currently use an Authenticode certificate. Do not promise that SmartScreen, Defender, AppLocker, or company security policy will allow the app without a warning. Publish the SHA-256 manifest so users can verify that their download matches the release artifact. Never tell users to disable Defender, add an exclusion, change execution policy, or bypass an organization policy.

The included CMD installer deliberately uses a per-user directory under `%LOCALAPPDATA%`, needs no elevation, makes no network requests, and creates shortcuts with Windows' built-in tools. It is an install helper, not a security-warning bypass. Code-sign every binary with one stable publisher identity or distribute through the Microsoft Store when that becomes possible.
