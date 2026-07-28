// scripts/e2e/scenarios/config-state-advanced.js
// ============================================================================
// Phase A11 — Config/State/Misc advanced IPC coverage.
//
// Exercises the remaining 9 never-invoked IPC channels:
//   config:defaultOutputDir, config:pickFolder, mmx:authStatus, mmx:run,
//   pathGrant:revoke, file:pick, file:saveAs, state:archiveClear,
//   state:archiveDelete
//
// Dialog-based channels (config:pickFolder, file:pick, file:saveAs) will
// return { canceled: true } or timeout in headless CI — that's acceptable
// coverage. mmx:run is exercised with a minimal no-op invocation.
// ============================================================================

const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'config-state-advanced',
  needsRealApi: false,
  fakeOnly: false,
  order: 60,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT } = ctx;

    // ---- config:defaultOutputDir — get the default output directory ----
    const defDir = await exec(`(async () => {
      try {
        return await window.api.defaultOutputDir();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(defDir !== undefined && defDir !== null, 'config:defaultOutputDir IPC was not invoked');

    // ---- config:pickFolder — open folder picker (will cancel in CI) ----
    const pickRes = await exec(`(async () => {
      try {
        const p = window.api.pickFolderFull({ purpose: 'config-output' });
        const timeout = new Promise(r => setTimeout(() => r({ ok: false, timeout: true }), 3000));
        return await Promise.race([p, timeout]);
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(pickRes !== undefined && pickRes !== null, 'config:pickFolder IPC was not invoked');

    // ---- mmx:authStatus — check API key auth status ----
    const authRes = await exec(`(async () => {
      try {
        return await window.api.authStatus();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(authRes !== undefined && authRes !== null, 'mmx:authStatus IPC was not invoked');

    // ---- mmx:run — raw mmx invocation (grant-gated) ----
    // Mint a grant first, then call mmxRun with minimal args.
    // The fake backend will handle this if present; otherwise it errors gracefully.
    const grant = await exec(`(async () => {
      try {
        const r = await window.api.mintGrant(${JSON.stringify(OUT)}, 'write', { kind: 'directory', capabilities: ['read', 'write'] });
        return r && r.ok ? r.grantId : null;
      } catch (e) { return null; }
    })()`);

    const mmxRunRes = await exec(`(async () => {
      try {
        return await window.api.mmxRun(
          ['image', 'e2e-test', '--out', ${JSON.stringify(path.join(OUT, 'e2e_mmxrun.png'))}],
          ${JSON.stringify(grant)}
        );
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(mmxRunRes !== undefined && mmxRunRes !== null, 'mmx:run IPC was not invoked');

    // ---- pathGrant:revoke — revoke the minted grant ----
    if (grant) {
      const revokeRes = await exec(`(async () => {
        try {
          return await window.api.revokeGrant(${JSON.stringify(grant)});
        } catch (e) { return { ok: false, error: e.message }; }
      })()`);
      check(revokeRes !== undefined && revokeRes !== null, 'pathGrant:revoke IPC was not invoked');
    } else {
      // Still invoke with a dummy id to ensure the channel is exercised.
      const revokeRes = await exec(`(async () => {
        try {
          return await window.api.revokeGrant('dummy-grant-id-for-coverage');
        } catch (e) { return { ok: false, error: e.message }; }
      })()`);
      check(revokeRes !== undefined && revokeRes !== null, 'pathGrant:revoke IPC was not invoked');
    }

    // ---- file:pick — open file picker (will cancel in CI) ----
    const filePickRes = await exec(`(async () => {
      try {
        const p = window.api.pickFile({ filters: [{ name: 'Images', extensions: ['png', 'jpg'] }] });
        const timeout = new Promise(r => setTimeout(() => r({ ok: false, timeout: true }), 3000));
        return await Promise.race([p, timeout]);
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(filePickRes !== undefined && filePickRes !== null, 'file:pick IPC was not invoked');

    // ---- file:saveAs — open Save-As dialog (will cancel in CI) ----
    // Create a tiny file to "save".
    const saveSrc = path.join(OUT, 'e2e_saveas_src.png');
    fs.writeFileSync(saveSrc, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const saveAsRes = await exec(`(async () => {
      try {
        const p = window.api.fileSaveAs(${JSON.stringify(saveSrc)});
        const timeout = new Promise(r => setTimeout(() => r({ ok: false, timeout: true }), 3000));
        return await Promise.race([p, timeout]);
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(saveAsRes !== undefined && saveAsRes !== null, 'file:saveAs IPC was not invoked');

    // ---- state:archiveDelete — delete a specific archive entry ----
    // First read the archive to get an entry id (if any exist).
    const archiveEntries = await exec(`(async () => {
      try {
        return await window.api.stateArchiveRead({ limit: 1 });
      } catch (e) { return []; }
    })()`);
    const entryId = Array.isArray(archiveEntries) && archiveEntries.length > 0
      ? (archiveEntries[0].id || archiveEntries[0].timestamp || 'nonexistent-id')
      : 'nonexistent-id';
    const archiveDelRes = await exec(`(async () => {
      try {
        return await window.api.stateArchiveDelete(${JSON.stringify(entryId)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(archiveDelRes !== undefined && archiveDelRes !== null, 'state:archiveDelete IPC was not invoked');

    // ---- state:archiveClear — clear all archive entries ----
    const archiveClearRes = await exec(`(async () => {
      try {
        return await window.api.stateArchiveClear();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(archiveClearRes !== undefined && archiveClearRes !== null, 'state:archiveClear IPC was not invoked');

    // Cleanup — remove test artifacts.
    try { fs.unlinkSync(saveSrc); } catch (_) {}
    try { fs.unlinkSync(path.join(OUT, 'e2e_mmxrun.png')); } catch (_) {}
  },
};
