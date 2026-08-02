# Contributing

## AI-Assisted Development Policy

AI-generated changes are permitted, but the committer owns correctness and must
identify generated or heavily assisted security-critical changes in the PR
description.

### Security-Critical Areas

The following areas require heightened review:

- Credentials and secret management
- IPC handlers and preload bridge
- Filesystem mutation (delete, move, overwrite)
- Network policy and provider adapters
- Updater/setup and runtime installation
- Release signing and verification
- Sandbox and Electron security configuration

### Review Process

For a solo-maintained repository, use a documented two-pass process:

1. **Implementation pass** — write the code and tests.
2. **Cooling-off period** — wait at least one day, then perform a separate
   review checklist and adversarial test pass.
3. **External validation** — beta testing or independent audit before claiming
   production safety.

### Assurance Record

Each security-critical PR should include:

```markdown
## Assurance record
- Threat model affected:
- Invariants changed:
- Failure modes considered:
- Tests added:
- Fault injection points:
- Packaged verification:
- AI assistance used:
- Human review performed by / solo second-pass date:
- Residual risks:
```

### Release Claims

- Do not use unsupported certainty statements such as "zero bugs," "perfectly
  secure," or "N tests prove no remaining defects."
- Release notes distinguish: unit-tested, integration-tested, packaged-tested,
  live-contract-tested, independently reviewed, and not tested.

## Development Setup

```bash
npm install
npm run setup    # download runtime binaries and models
npm run check    # lint + unit tests + contract checks
```

## Testing

```bash
npm test                  # unit tests
npm run test:contract     # IPC contract tests
npm run test:e2e          # end-to-end tests
npm run test:coverage     # coverage report
```

All tests use isolated temporary directories. No test reads or modifies the
developer's real config, credentials, models, or output.

## Code Style

- CommonJS modules (`require`/`module.exports`)
- `'use strict'` at the top of every file
- JSDoc comments for public functions
- Typed error codes via `AppError` for all security-relevant failures
