# Privacy

MiniMax Asset Tool is a desktop application. This document states exactly what
happens with your data. Every statement below was checked against the source
code as part of the signed-release documentation (§25).

## Local processing

- Documents, images, audio, and generated assets are processed on your own
  computer. The local runtime (models and tools under the application's
  runtime directory) runs offline.
- The application does not upload your files to any server operated by the
  project. There is no project backend.

## Network traffic initiated by user actions

The application connects to external services ONLY when you use a feature
that requires them:

- **MiniMax API / configured providers:** when you generate media, the
  document/prompt and the necessary input files are sent to the provider you
  configured: MiniMax (`api.minimax.io` or `api.minimaxi.com` depending on
  region), OpenRouter (`openrouter.ai`), Replicate (`api.replicate.com`), or
  an optional custom OpenAI-compatible endpoint whose base URL you enter
  yourself.
- No request leaves your machine without a user action that triggers it.

## Credential storage

- API keys and provider credentials are stored locally in the application's
  settings files (`providers.json` / `settings.json` inside your local
  configuration directory) on your machine.
- Credentials are sent only to the provider they belong to, and only when a
  request to that provider is made.
- Session-only mode: with the "do not save API key" option, the key is kept
  for the current session only and is not persisted to the settings store.

## Local logs and crash reports

- Debug logs are written locally only, to a log file you choose via the
  application's debug log feature.
- Crash reports are not uploaded automatically; there is no crash-reporting
  component in the application.

## Telemetry

- The application contains NO telemetry and sends no usage statistics,
  analytics, or crash data to the project or any third party. This was
  verified by code inspection of the main, src, and renderer modules.

## File deletion

- Files you delete through the application are deleted from your disk
  according to the operating system's normal behavior; they are not sent
  anywhere.

## Third-party terms

When you use cloud generation, your data is subject to the terms of the
provider you selected (for example MiniMax's terms of service and privacy
policy). Review them before submitting sensitive content.

## Background network activity

Complete list of background (non-user-action) network activity: NONE. There
are no update checks, no model downloads at startup, and no background sync;
verified by code inspection of the main, src, and renderer modules.

## Changes

Changes to this document are part of the signed release process and are
visible in the repository history.
