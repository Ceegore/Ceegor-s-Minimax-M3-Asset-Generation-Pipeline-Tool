// main/ipc/diagnoseSnapshot.js
// ============================================================================
// R2.4 — Build the `mmx:diagnose` snapshot. Extracted from
// registerMmxIpc.js to keep that file under its frozen 384-LOC
// SIZE-BUDGET (the redaction contract is non-trivial: any field
// added to the snapshot must pass through deepRedact, and the helper
// lives at the call site so the test mocks don't have to stub
// mmx.deepRedact).
//
// Contract (closes R0.1-002.D):
//   • Returns a deep-redacted snapshot of the current state.
//   • `apiKeyLength: <number>` is the ONLY numeric/api-key field
//     surfaced; the full key is never returned.
//   • `apiKeyPresent: <boolean>` indicates whether a non-empty key
//     is in config.txt (or the session-only store).
//   • `sessionOnly: <boolean>` is true when state.apiKeyNoSave is set,
//     so the diagnose modal can show "API key is session-only".
//   • Every other field (cliVersion, platform, electron/node version,
//     mmxCommand, mmxEntry, nodePath) is also deep-redacted to
//     guarantee that no future addition accidentally surfaces a raw
//     secret.
// ============================================================================

const { deepRedact } = require('../../src/deepRedactor');

/**
 * @param {{
 *   cfg: object,            // src/config.js#read() result
 *   state: object,          // src/state.js#read() result
 *   mmxResolve: object,     // src/mmx.js#resolve() result
 *   cliVersion: string|null,
 *   cliSupported: boolean|null,
 *   supportedMin: string|null,
 *   capabilitySnapshot: object|null, // R7.2: mmxCapability.getSnapshot()
 * }} input
 * @returns {object}  deep-redacted snapshot
 */
function buildDiagnoseSnapshot(input) {
  const { cfg, state, mmxResolve, cliVersion, cliSupported, supportedMin, capabilitySnapshot } = input;
  const raw = {
    platform: process.platform,
    electronVersion: process.versions.electron || 'n/a',
    nodeVersion: process.versions.node,
    nodePath: mmxResolve.node || null,
    mmxEntry: mmxResolve.entry || (mmxResolve.prefix && mmxResolve.prefix[0]) || null,
    mmxCommand: mmxResolve.command || null,
    error: mmxResolve.error,
    // R2.4: API-key length is the ONLY numeric/api-key field we
    // surface. The full key is never returned.
    apiKeyLength: cfg && cfg.api_key ? cfg.api_key.length : 0,
    apiKeyPresent: !!(cfg && cfg.api_key && cfg.api_key.trim()),
    // R2.4: surface session-only mode explicitly so the diagnose
    // modal can render "API key is session-only (not persisted)"
    // instead of just "API key is set".
    sessionOnly: !!(state && state.apiKeyNoSave),
    region: cfg && cfg.region,
    cliVersion: cliVersion || null,
    cliSupportedMin: supportedMin,
    cliSupported: cliSupported == null ? null : !!cliSupported,
    // R7.2: capability-based fields (replaces version-only warning).
    capabilityAvailable: !!capabilitySnapshot,
    capability: capabilitySnapshot ? {
      version: capabilitySnapshot.version,
      hasDryRun: !!capabilitySnapshot.hasDryRun,
      subcommands: Object.fromEntries(
        Object.entries(capabilitySnapshot.subcommands || {}).map(([k, v]) => [k, {
          available: !!v.available,
          flags: v.flags || [],
          models: v.models || [],
        }]),
      ),
      probedAt: capabilitySnapshot.probedAt || null,
    } : null,
  };
  return deepRedact(raw);
}

module.exports = { buildDiagnoseSnapshot };
