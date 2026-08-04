# Code signing policy

> Den folgenden SignPath-Satz erst aktiv als aktuelle Leistung darstellen, nachdem das Projekt angenommen wurde und der erste tatsächlich SignPath-signierte Release verfügbar ist.

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## Project

- Project: MiniMax Asset Tool
- Repository: https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool
- License: MIT

## Roles

- Committer/author: [Ceegore](https://github.com/Ceegore)
- Reviewer for contributions by non-committers: [Ceegore](https://github.com/Ceegore)
- Signing approver: [Ceegore](https://github.com/Ceegore)

External pull requests must be reviewed by a project committer before merge. Every release signing request requires manual approval.

## Build origin

Release binaries are built from the public repository by GitHub Actions. The release workflow records the source commit, workflow run, package version, SBOM and build provenance. Signed binaries are not manually rebuilt or modified after signing.

## Signing scope

The project signing identity is used only for binaries produced and maintained by this project.

Initial signed artifact:

- `MiniMaxAssetTool.exe`

Third-party and upstream binaries, including Electron components, FFmpeg, FFprobe, Real-ESRGAN, ONNX Runtime, native Node modules and Minisign, are not signed with the project's SignPath Foundation certificate. Their origin, version, license and hashes are tracked separately.

## Approval checks

Before approving a signing request, the approver checks:

1. the source commit belongs to the intended protected release branch or tag;
2. all required CI gates passed;
3. the requested version matches `package.json`;
4. the signing artifact contains only allowed project-owned files;
5. PE metadata matches the artifact configuration;
6. the SBOM and third-party inventory contain no unapproved component;
7. no security or licensing blocker is open.

## Privacy

See [PRIVACY.md](PRIVACY.md).

The application does not transfer information to networked systems unless the user explicitly requests or configures an operation that requires a selected cloud provider. Generation prompts and user-selected inputs are sent only to the provider selected by the user for that operation. Local post-processing remains local.

## Security incidents

Reports concerning a signed release, unexpected network behavior, malware or potentially unwanted application detection, signing-scope violations or build origin are investigated promptly. Affected releases are withdrawn when necessary, signing is paused, and SignPath Foundation is assisted with verification and root-cause analysis.
