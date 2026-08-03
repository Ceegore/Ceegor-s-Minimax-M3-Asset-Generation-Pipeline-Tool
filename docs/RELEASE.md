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

- `MiniMaxAssetTool-<version>-x64.zip`, or independent `MiniMaxAssetTool-<version>-x64.part1.zip`, `.part2.zip`, … files when the archive is too large for one GitHub attachment. Every archive stores its files under the single top-level folder `MiniMaxAssetTool-<version>-x64/`; extracting all parts into the same destination merges them into that one folder.
- `MiniMaxAssetTool-<version>-x64.sha256`.
- `MiniMaxAssetTool-<version>-x64.provenance.json`.

The build also runs the exact packaged-dependency check and tests the no-admin installer and its shortcuts. The provenance record must show the expected commit and `commitDirty: false`. Test the extracted ZIP on a clean Windows account before publishing it.

### Independent test evidence (M-023)

A commit message claiming "N tests pass" is NOT evidence. A release must only be published from a green **Release Gate** workflow run (`release-gate.yml`) for the exact commit, and the provenance record of a CI-built release carries a `ci` block (`ci.runUrl`) linking that workflow run. Before publishing, open the run URL and confirm every gate (lint, unit + coverage, contract, identity, strict verification) is green for the tagged commit. A locally built release has `ci: null` and must never be presented as CI-verified.

## 3. Publish on GitHub

1. Create a release tag that matches `package.json`.
2. Paste the prepared text from `docs/GITHUB_RELEASE.md` and adjust the version-specific details.
3. Upload the ZIP, checksum, provenance, and root-level `Install-MiniMax-Asset-Tool.cmd` files. If the build is split, upload every `.partN.zip`. Label them **Full offline Windows release**.
4. Verify the download from GitHub and extract it again before announcing the release.

GitHub limits individual release attachments to 2 GiB. Each part is an independent, complete zip — the root-level CMD verifies every part and extracts them with Windows' built-in archive tool. Experienced users can simply extract every part into the same folder with any archiver; the parts merge into one `MiniMaxAssetTool-<version>-x64` folder.

## Signing and Windows warnings

The project does not currently use an Authenticode certificate. Do not promise that SmartScreen, Defender, AppLocker, or company security policy will allow the app without a warning. Publish the SHA-256 manifest so users can verify that their download matches the release artifact. Never tell users to disable Defender, add an exclusion, change execution policy, or bypass an organization policy.

The included CMD installer deliberately uses a per-user directory under `%LOCALAPPDATA%`, needs no elevation, makes no network requests, and creates shortcuts with Windows' built-in tools. It is an install helper, not a security-warning bypass. Code-sign every binary with one stable publisher identity or distribute through the Microsoft Store when that becomes possible.
