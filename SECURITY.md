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
- API keys stored in Windows Credential Manager (via DPAPI)
- Config files contain only `credential_id` references, never raw keys
- `config:getPublic` / `providers:getPublic` return secret-free DTOs
- Session credentials wiped on window close and app quit

### Path Authorization
- All file operations require Main-minted grants
- Grants are time-limited (5min read, 10min write) and single-use for mutations
- Sensitive system roots (C:\, Windows, Program Files, AppData) are blocked
- Pipeline imports require per-file read grants

### Network Security
- Provider URLs validated against SSRF blocklist (localhost, RFC1918, link-local, cloud metadata)
- HTTPS enforced for all provider connections
- DNS rebinding detection for custom provider hostnames

### Child Process Safety
- Minimal environment allowlist (PATH, SYSTEMROOT, TEMP only)
- stdout/stderr byte caps (1 MB)
- Hard timeout per job type
- Process tree kill on cancel/timeout
- Interpreter binaries blocked as external tools

## Threat Model

The primary threat is a **compromised renderer** (via XSS, malicious content, or supply chain attack). The security boundary is the IPC layer — the renderer is treated as untrusted for all privileged operations.

## Dependencies

- Electron (Chromium + Node.js)
- sharp (image processing)
- mmx-cli (MiniMax API)

We monitor dependencies via Dependabot and audit with `npm audit` in CI.
