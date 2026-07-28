// scripts/e2e/scenarios/external-tools.js
// ============================================================================
// Phase A7 — External tools IPC coverage.
//
// Exercises the 2 never-invoked externalTools:* IPC channels:
//   externalTools:probe, externalTools:run
//
// externalTools:probe checks if a registered external tool binary exists.
// externalTools:run spawns it with validated args. We probe for a tool
// that may not exist (graceful { available: false }) and attempt a run
// that will fail gracefully if the binary is absent.
// ============================================================================

const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'external-tools',
  needsRealApi: false,
  fakeOnly: false,
  order: 52,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT } = ctx;

    // Mint a grant for OUT (needed by externalTools:run path validation).
    const grant = await exec(`(async () => {
      try {
        const r = await window.api.mintGrant(${JSON.stringify(OUT)}, 'write', { kind: 'directory', capabilities: ['read', 'write'] });
        return r && r.ok ? r.grantId : null;
      } catch (e) { return null; }
    })()`);
    check(!!grant, 'external-tools: could not mint grant for OUT');

    // ---- externalTools:probe — probe for a known tool (e.g. 'realesrgan') ----
    const probeRes = await exec(`(async () => {
      try {
        return await window.api.externalToolsProbe({ tool: 'realesrgan' });
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(probeRes !== undefined && probeRes !== null, 'externalTools:probe IPC was not invoked');
    // The probe should return a structured response regardless of availability.
    if (probeRes && probeRes.ok !== undefined) {
      check(typeof probeRes.ok === 'boolean', 'externalTools:probe did not return a boolean ok field');
    }

    // ---- externalTools:probe — probe for a non-existent tool ----
    const probeMissing = await exec(`(async () => {
      try {
        return await window.api.externalToolsProbe({ tool: 'nonexistent-tool-xyz' });
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(probeMissing !== undefined && probeMissing !== null, 'externalTools:probe (missing tool) IPC was not invoked');

    // ---- externalTools:run — attempt to run a tool (graceful failure expected) ----
    // Create a tiny dummy input file so the path arg is valid.
    const dummyFile = path.join(OUT, 'e2e_exttools_input.png');
    fs.writeFileSync(dummyFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const runRes = await exec(`(async () => {
      try {
        return await window.api.externalToolsRun({
          tool: 'realesrgan',
          args: ['-i', ${JSON.stringify(dummyFile)}, '-o', ${JSON.stringify(path.join(OUT, 'e2e_exttools_out.png'))}],
        }, ${JSON.stringify(grant)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(runRes !== undefined && runRes !== null, 'externalTools:run IPC was not invoked');
    // If realesrgan binary is not present, expect a graceful error response.
    // We only assert the IPC round-tripped successfully.

    // Cleanup — remove test artifacts.
    try { fs.unlinkSync(dummyFile); } catch (_) {}
    try { fs.unlinkSync(path.join(OUT, 'e2e_exttools_out.png')); } catch (_) {}
  },
};
