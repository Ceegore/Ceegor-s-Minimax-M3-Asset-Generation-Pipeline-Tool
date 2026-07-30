// main/ipcRegistrarNames.js
// KGO7-004: the SINGLE source of truth for which `main/ipc/register*Ipc`
// modules the app loads.
//
// Why this file exists: the list used to be duplicated in four places —
// `main/index.js` (21 entries) and the three test harnesses
// (`scripts/e2e/harness.js`, `scripts/smoke-renderer.js`,
// `scripts/smoke-eval.js`, 17–18 entries each). They drifted:
// `registerResetIpc` and `registerM3Ipc` were missing from all three
// harnesses with no comment explaining why, so
//   • `app:resetAllData`, `app:relaunch`, `app:resetAndRelaunch` (the most
//     destructive handlers in the app) and `m3:chat` were never registered
//     during ANY automated run, and
//   • `test:ipc-coverage` reported "84/84 = 100 %" while the app actually
//     registers 91 channels — the gate was measuring a surface that had
//     been trimmed until it was reachable.
//
// This module is intentionally dependency-free (it does NOT require
// electron or any registrar), so a test harness can import it without
// booting anything.
//
// The matching `IPC_REGISTRAR_NAMES` <-> harness list invariant is asserted
// by tests/unit/main/ipcRegistrarNames.test.js.

'use strict';

/**
 * Every IPC registrar module name, in load order.
 * `core: true` means a `register()` throw aborts boot (SYS-006).
 */
const IPC_REGISTRARS = [
  { name: 'registerAppIpc', core: true },
  { name: 'registerConfigIpc', core: true },
  // P0-B (C-001): config:getPublic split out of registerConfigIpc (size budget);
  // core because the renderer boot reads the secret-free config DTO.
  { name: 'registerConfigPublicIpc', core: true },
  { name: 'registerMmxIpc', core: true },
  { name: 'registerUpscaleIpc', core: false },
  { name: 'registerIsnetbgIpc', core: false },
  { name: 'registerImageIpc', core: false },
  { name: 'registerAudioIpc', core: false },
  { name: 'registerFileBrowserIpc', core: true },
  { name: 'registerBatchesIpc', core: false },
  { name: 'registerStateIpc', core: true },
  { name: 'registerInstallIpc', core: false },
  { name: 'registerFilePickerIpc', core: true },
  { name: 'registerExternalToolsIpc', core: false },
  { name: 'registerPipelineIpc', core: false },
  { name: 'registerInpaintIpc', core: false },
  { name: 'registerInpaintOnnxIpc', core: false },
  { name: 'registerPathGrantIpc', core: true },
  { name: 'registerJobIpc', core: false },
  { name: 'registerResetIpc', core: false },
  { name: 'registerM3Ipc', core: false },
  { name: 'registerProvidersIpc', core: false },
];

const IPC_REGISTRAR_NAMES = IPC_REGISTRARS.map((r) => r.name);

/**
 * Registrars a fake-mode test harness must NOT load, with the reason.
 * `registerMmxIpc` is the ONLY legitimate omission: the harness registers
 * its own `mmx:*` stubs (fake mode) or real passthroughs (`--real`) so no
 * test spends API quota by accident. Anything else missing from a harness
 * is drift, and the unit test above fails.
 */
const HARNESS_STUBBED_REGISTRARS = Object.freeze({
  registerMmxIpc: 'the harness registers its own mmx:* handlers (fake stubs, or real passthroughs under --real)',
});

/** The list a fake-mode harness should load. */
function harnessRegistrarNames() {
  return IPC_REGISTRAR_NAMES.filter((n) => !HARNESS_STUBBED_REGISTRARS[n]);
}

module.exports = {
  IPC_REGISTRARS,
  IPC_REGISTRAR_NAMES,
  HARNESS_STUBBED_REGISTRARS,
  harnessRegistrarNames,
};
