# Privacy policy

## Summary

MiniMax Asset Tool is a local Windows desktop application. Project files, settings, generated assets and local post-processing remain on the user's computer unless the user explicitly starts an operation that sends data to a selected cloud provider.

## Data sent to cloud providers

When the user starts an image, speech, music, video, document-analysis or other provider-backed generation request, the application sends the prompt and any user-selected input required for that request to the provider selected by the user.

Supported providers may include MiniMax and optional OpenAI-compatible or Replicate-compatible endpoints configured by the user. Those providers process data under their own terms and privacy policies. The project does not operate an intermediary generation server.

## Local processing

Local operations such as image resizing, conversion, optimization, cropping, background removal, upscaling, inpainting, audio cutting and file organization run on the local computer using bundled components.

## Credentials

API credentials are stored locally using Electron `safeStorage` where available, backed by Windows DPAPI. Persistent storage is disabled when secure OS-backed encryption is unavailable. The session-only option keeps credentials in memory for the current session and clears them when the application exits.

Credentials are not intentionally included in reports, release artifacts, command-line arguments or logs.

## Telemetry

The project does not intentionally send product analytics or telemetry to the project maintainer. If this changes, this policy and the application UI must be updated before the feature is enabled.

## Logs and crash information

Application logs and crash information are stored locally. They are not automatically uploaded to the maintainer. Users may choose to provide selected logs when reporting a problem. Secret-redaction controls are applied, but users should still review files before sharing them.

## Files and deletion

Generated files and user-selected project files remain in directories chosen by the user. Removing the application does not automatically delete generated assets. Application settings and local state can be removed separately from the Windows user profile.

## Network behavior

The application makes network requests only for user-configured provider operations and any explicitly documented user-requested network feature. Hidden background uploads are not permitted.

## Third-party components

Bundled open-source components keep their own licenses. Cloud providers keep their own terms and privacy policies. See `THIRD_PARTY_NOTICES.md` and the provider configuration shown in the application.
