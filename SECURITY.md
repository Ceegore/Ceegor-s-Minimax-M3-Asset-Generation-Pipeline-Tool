# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in MiniMax Asset Tool, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email: security@ceegor.dev (or use the GitHub Security Advisory feature)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We aim to acknowledge reports within 48 hours and provide a fix within 7 days for critical issues.

## Security Architecture

### Process Isolation
- **Main process**: Handles all privileged operations (file I/O, network, process spawn)
- **Renderer process**: Sandboxed, no Node.js access, communicates only via IPC
- **contextIsolation**: Enabled — renderer cannot access Main's JavaScript context
- **sandbox**: Enabled — renderer runs in a Chromium sandbox

### IPC Security
- All privileged IPC channels use `secureHandle` wrapper (sender/frame/origin validation)
- Payload size limits enforced per-channel (default 1 MB)
- Destructive operations require native confirmation tokens

### Secret Management
- API keys encrypted with Electron safeStorage (OS-backed: DPAPI on Windows)
- Immutable UUID-based encrypted blobs; no plaintext fallback
- Config files contain only `api_credential_id` references, never raw keys
- API keys passed to child processes via file descriptor 3, not argv/env
- `config:getPublic` / `providers:getPublic` return secret-free DTOs
- Session credentials wiped on window close and app quit
- When OS encryption is unavailable, persisted save is disabled (session-only mode)

### Path Authorization
- All file operations require Main-minted grants
- Grants are time-limited (5min read, 10min write) and single-use for mutations
- Sensitive system roots (C:\, Windows, Program Files, AppData) are blocked
- Pipeline imports require per-file read grants

### Network Security
- All provider HTTP uses a single SafeHttpClient with DNS A/AAAA validation
- Socket-pinning: connections use only validated public addresses
- HTTPS enforced; no ambient proxy for provider connections
- Redirect revalidation with auth stripping on origin change
- Streaming byte counters with hard caps (no unbounded buffering)
- Combined AbortSignal timeouts on all requests

### Child Process Safety
- Minimal environment allowlist (PATH, SYSTEMROOT, TEMP only)
- stdout/stderr byte caps (1 MB)
- Hard timeout per job type
- Process tree kill on cancel/timeout
- Interpreter binaries blocked as external tools

## Windows security false positives (§55/56)

If Microsoft Defender, SmartScreen, or Smart App Control warns about a genuine
release of this application, the response is a submission, never a workaround:

1. **Never disable protection.** Do not turn off Defender, SmartScreen, or
   Smart App Control, and do not add antivirus exclusions for this
   application. Any guidance suggesting that is a security red flag.
2. Report the false positive to Microsoft through the Windows Defender
   Security Intelligence submission portal
   (https://www.microsoft.com/wdsi/filesubmission), attaching the flagged
   file and selecting "False positive".
3. Verify the release independently first (see README "Verifying release
   authenticity"): SHA-256 manifest, Minisign signature, provenance, SBOM.
   Only a release that passes verification is worth submitting as a false
   positive.
4. The 1.1.x release line is submitted to managed SignPath Foundation
   code signing (see CODE_SIGNING_POLICY.md), which removes the
   unsigned-reputation warning class for future releases.

## Threat Model

The primary threat is a **compromised renderer** (via XSS, malicious content, or supply chain attack). The security boundary is the IPC layer — the renderer is treated as untrusted for all privileged operations.

## Dependencies

- Electron (Chromium + Node.js)
- sharp (image processing)
- mmx-cli (MiniMax API)

We monitor dependencies via Dependabot and audit with `npm audit` in CI.
