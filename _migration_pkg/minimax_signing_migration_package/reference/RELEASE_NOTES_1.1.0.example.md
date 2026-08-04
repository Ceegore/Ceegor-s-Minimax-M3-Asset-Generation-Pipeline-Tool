# MiniMax Asset Tool 1.1.0

Version 1.1.0 is the first release built through the managed SignPath code-signing workflow.

`MiniMaxAssetTool.exe` is Authenticode-signed through SignPath.io with a certificate provided by SignPath Foundation. Third-party runtime binaries keep their upstream identity and are not re-signed with the project's certificate.

The complete package is built from the public GitHub source commit, tested in GitHub Actions, signed before final packaging, checked on a clean Windows environment, and distributed with SHA-256 manifests, a detached Minisign signature, build provenance, and an SBOM.

A new signed file may still initially receive a Microsoft SmartScreen reputation prompt. Verify that the Authenticode signature is valid and that the displayed signer is SignPath Foundation. Do not disable Windows security features or add antivirus exclusions.
