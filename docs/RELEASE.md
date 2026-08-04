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
- `MiniMaxAssetTool-<version>-x64.sha256` (the outer inventory manifest).
- `MiniMaxAssetTool-<version>-x64.provenance.json`.
- `MiniMaxAssetTool-<version>-x64.sbom.json` (CycloneDX 1.5, full transitive production tree plus the offline runtime assets).

After the build, the pipeline finalizes the release inventory (`npm run finalize:release`, V104-C002) so the manifest covers EVERY shipped file — archives, installer, provenance, SBOM, `minisign.pub`, and the pinned Minisign verifier — and then signs it. `npm run verify:release` is strict and fail-closed: archive hashes, Authenticode signatures, the Minisign manifest signature, provenance, and SBOM completeness must all verify. The provenance record must show the expected commit and `commitDirty: false`. Test the extracted ZIP on a clean Windows account before publishing it.

### Independent test evidence (M-023)

A commit message claiming "N tests pass" is NOT evidence. A release must only be published from a green **Release Gate** workflow run (`release-gate.yml`) for the exact commit, and the provenance record of a CI-built release carries a `ci` block (`ci.runUrl`) linking that workflow run. Before publishing, open the run URL and confirm every gate (lint, unit + coverage, contract, identity, strict verification) is green for the tagged commit. A locally built release has `ci: null` and must never be presented as CI-verified.

## 3. Publish on GitHub

1. Create a release tag that matches `package.json`.
2. Paste the prepared text from `docs/GITHUB_RELEASE.md` and adjust the version-specific details.
3. Publish EXACTLY the signed inventory (V104-C002): the Release Gate workflow stages `dist-out/publication/` from the Minisign-verified manifest (`npm run stage:publication`). Upload those files — every `.partN.zip`, the `.sha256` manifest and its `.minisig`, the installer CMD, provenance, SBOM, `minisign.pub`, and the pinned verifier. Label them **Full offline Windows release**. Never upload the raw `dist-out/` tree.
4. Verify the download from GitHub and extract it again before announcing the release.

GitHub limits individual release attachments to 2 GiB. Each part is an independent, complete zip — the root-level CMD verifies every part and extracts them with Windows' built-in archive tool. Experienced users can simply extract every part into the same folder with any archiver; the parts merge into one `MiniMaxAssetTool-<version>-x64` folder.

## Signing and Windows warnings

Release builds are signed end to end, and every check is fail-closed (V104-C001/V104-C002):

- **Authenticode**: electron-builder signs every PE it emits in the Release Gate workflow (certificate supplied via `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` secrets); `npm run verify:release --require-authenticode` rejects any unsigned executable.
- **Minisign inventory**: the complete release inventory manifest is signed with Minisign (pinned 0.11 verifier, published key ships as `minisign.pub`). The installer and the publication step verify the signature before touching a single file, and abort when the verifier or key is missing.

Still, do not promise that SmartScreen, Defender, AppLocker, or company security policy will allow the app without a warning — a new signing identity needs reputation. Publish the SHA-256 inventory manifest so users can verify that their download matches the release artifact. Never tell users to disable Defender, add an exclusion, change execution policy, or bypass an organization policy.

The included CMD installer deliberately uses a per-user directory under `%LOCALAPPDATA%`, needs no elevation, makes no network requests, and creates shortcuts with Windows' built-in tools. It is an install helper, not a security-warning bypass. Keep signing every binary with the same stable publisher identity across releases so SmartScreen reputation accumulates.
