# Contributing

## General requirements

- Open a focused pull request.
- Describe the user-visible behavior and risk.
- Add or update tests.
- Do not commit secrets, generated user content, release artifacts or private model files.

## Binary and model policy

A new binary, native module or model is not accepted unless the pull request records:

- upstream project and URL,
- exact release or commit,
- exact file name and SHA-256,
- source-code license,
- binary redistribution terms,
- model-weight license where applicable,
- required notices or source offer,
- reason it is required.

Release workflow, signing scope, artifact configuration, dependency download or runtime manifest changes receive additional maintainer review.

## Review and signing

External contributions require review by a project committer before merge. A merged contribution is not automatically eligible for a signed release. Every release and signing request receives a separate manual approval.

## Security reports

Do not open public issues for vulnerabilities. Follow `SECURITY.md` or use GitHub Security Advisories.
