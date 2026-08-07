# Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

This document describes how releases of **MiniMax Asset Tool** are signed and
who is responsible for each step. It applies to the `Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool`
repository.

## Project

- **Project:** MiniMax Asset Tool
- **Repository:** https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool
- **Signing service:** SignPath Foundation (free managed code signing for open source)

## Roles

This is a single-maintainer project:

| Role | Person |
|---|---|
| Committer / Author | Ceegore |
| Reviewer for contributions by non-committers | Ceegore |
| Signing Approver | Ceegore |

Rules:

- GitHub MFA and SignPath MFA are enabled.
- External contributions are reviewed before merge.
- Every signing request is approved manually in SignPath.
- There is no `pull_request_target` workflow with signing secrets.
- Signing secrets are never exposed to fork pull requests.
- There is no automatic approval of signing requests.

## Build origin

Signed releases are built exclusively by GitHub Actions from tagged commits
(`v1.1.*`) that are reachable from `main`. The workflow verifies the tag,
the `package.json` version, and the main-origin of the commit before any
signing request is submitted.

## Manual approval

Signing requests use the `release-signing` policy, which requires manual
approval by the Signing Approver in SignPath before the certificate is
applied.

## Signature scope

Exactly ONE binary is signed with the project certificate:

```
MiniMaxAssetTool.exe
```

All other PE files (Electron runtime DLLs, FFmpeg/FFprobe, Real-ESRGAN,
Minisign, native modules) are upstream components. They are shipped with
their upstream state and MUST NOT carry the project SignPath signature.
Every PE in the release tree is classified automatically by
`scripts/verify-signing-scope.js --mode signpath` against
`scripts/pe-ownership-policy.json`; any unknown PE aborts the release.

## Handling of upstream binaries

Upstream components are tracked through:

- hash-pinned downloads and lockfiles,
- the runtime manifest and `FILES.sha256`,
- SHA-256 inventory manifests per release,
- the SBOM and license evidence (`LICENSE_EVIDENCE.json`).

Existing upstream signatures are verified but never replaced.

## Integrity layers

In addition to Authenticode signing, every release carries:

- an outer SHA-256 inventory manifest (`.sha256`) signed with Minisign,
- build provenance metadata,
- an SBOM.

## Privacy

See [PRIVACY.md](PRIVACY.md).

## Incident response

If a signing key, token, or release artifact is suspected to be compromised:

1. Revoke/rotate the affected credential (SignPath API token, GitHub secrets) immediately.
2. Mark or remove the affected release and publish a security notice.
3. Report the incident through [SECURITY.md](SECURITY.md).
4. Rebuild and re-sign a replacement release from a verified commit.
