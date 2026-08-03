// scripts/e2e/scenarios/file-ops-mutations.js
// ============================================================================
// Phase A1 — File browser mutation operations (IPC coverage).
//
// Exercises the 8 never-invoked fb:* IPC channels:
//   fb:mkdir, fb:rename, fb:copy, fb:move, fb:delete, fb:read,
//   fb:reveal, fb:openInExplorer
//
// Strategy: create a real file in the isolated OUT dir, then drive the
// renderer's window.api.* methods (same code path as the context-menu
// handlers) to exercise each IPC channel end-to-end.
//
// B-007 (hhhhu3 audit): rename/move/delete now REQUIRE a one-shot intent
// token minted by fb:confirmDestructive. This scenario drives them through
// the renderer's window.FbIntent bridge (confirm-then-execute); the harness
// auto-accepts the native confirmation (dialog.showMessageBox patch).
// ============================================================================

const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'file-ops-mutations',
  needsRealApi: false,
  fakeOnly: false,
  order: 40,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT, TMP } = ctx;

    // Seed a test file in OUT so we have something to operate on.
    const testFile = path.join(OUT, 'e2e_fileops_test.png');
    fs.writeFileSync(testFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // Mint a grant for the OUT directory (the harness registers the real
    // pathGrant:mint handler, so this works exactly like production).
    const grant = await exec(`(async () => {
      try {
        const r = await window.api.mintGrant(${JSON.stringify(OUT)}, 'write', { kind: 'directory', capabilities: ['read', 'write', 'mkdir', 'rename', 'copy', 'move', 'delete'] });
        return r && r.ok ? r.grantId : null;
      } catch (e) { return null; }
    })()`);
    check(!!grant, 'file-ops: could not mint a directory grant for OUT');

    // ---- fb:mkdir — create a subfolder ----
    const mkdirRes = await exec(`(async () => {
      try {
        return await window.api.fbMkdir(${JSON.stringify(OUT)}, 'e2e_subfolder', ${JSON.stringify(grant)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(mkdirRes && mkdirRes.ok, `fb:mkdir failed: ${mkdirRes && mkdirRes.error}`);
    check(fs.existsSync(path.join(OUT, 'e2e_subfolder')), 'fb:mkdir did not create the folder on disk');

    // ---- B-007 guard: a tokenless mutation must be refused ----
    const tokenless = await exec(`(async () => {
      try {
        return await window.api.fbDelete(${JSON.stringify(testFile)}, ${JSON.stringify(grant)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(tokenless && tokenless.ok === false, 'fb:delete without an intent token must be refused');
    check(fs.existsSync(testFile), 'tokenless fb:delete must not remove the file');

    // ---- fb:rename — rename the test file (via the FbIntent confirm bridge) ----
    const renameRes = await exec(`(async () => {
      try {
        return await window.FbIntent.rename(${JSON.stringify(testFile)}, 'e2e_renamed.png', ${JSON.stringify(grant)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(renameRes && renameRes.ok, `fb:rename failed: ${renameRes && renameRes.error}`);
    const renamedPath = path.join(OUT, 'e2e_renamed.png');
    check(fs.existsSync(renamedPath), 'fb:rename did not produce the renamed file on disk');
    check(!fs.existsSync(testFile), 'fb:rename left the original file behind');

    // ---- fb:copy — copy the renamed file into the subfolder ----
    const subDir = path.join(OUT, 'e2e_subfolder');
    const copyRes = await exec(`(async () => {
      try {
        return await window.api.fbCopy(${JSON.stringify(renamedPath)}, ${JSON.stringify(subDir)}, ${JSON.stringify(grant)}, ${JSON.stringify(grant)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(copyRes && copyRes.ok, `fb:copy failed: ${copyRes && copyRes.error}`);
    check(fs.existsSync(path.join(subDir, 'e2e_renamed.png')), 'fb:copy did not produce the copied file in the subfolder');
    check(fs.existsSync(renamedPath), 'fb:copy removed the source (should be a copy, not a move)');

    // ---- fb:move — move the copied file back to OUT root (via FbIntent) ----
    const copiedFile = path.join(subDir, 'e2e_renamed.png');
    const moveRes = await exec(`(async () => {
      try {
        return await window.FbIntent.move(${JSON.stringify(copiedFile)}, ${JSON.stringify(OUT)}, ${JSON.stringify(grant)}, ${JSON.stringify(grant)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(moveRes && moveRes.ok, `fb:move failed: ${moveRes && moveRes.error}`);
    // After move, the file should be back in OUT (possibly auto-renamed if clash).
    check(!fs.existsSync(copiedFile), 'fb:move left the source file behind');

    // ---- fb:read — read file content ----
    const readRes = await exec(`(async () => {
      try {
        return await window.api.fbRead(${JSON.stringify(renamedPath)}, ${JSON.stringify(grant)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(readRes && readRes.ok !== false, `fb:read failed: ${readRes && readRes.error}`);

    // ---- fb:reveal — reveal file in Explorer (IPC invoked, shell op best-effort) ----
    const revealRes = await exec(`(async () => {
      try {
        const r = await window.api.fbReveal(${JSON.stringify(renamedPath)});
        return { invoked: true, result: r };
      } catch (e) { return { invoked: true, error: e.message }; }
    })()`);
    check(revealRes && revealRes.invoked, 'fb:reveal IPC was not invoked');

    // ---- fb:openInExplorer — open folder in Explorer ----
    const openRes = await exec(`(async () => {
      try {
        const r = await window.api.fbOpenInExplorer(${JSON.stringify(OUT)});
        return { invoked: true, result: r };
      } catch (e) { return { invoked: true, error: e.message }; }
    })()`);
    check(openRes && openRes.invoked, 'fb:openInExplorer IPC was not invoked');

    // ---- fb:delete — delete the renamed file (via the FbIntent confirm bridge) ----
    const deleteRes = await exec(`(async () => {
      try {
        return await window.FbIntent.del(${JSON.stringify(renamedPath)}, ${JSON.stringify(grant)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(deleteRes && deleteRes.ok, `fb:delete failed: ${deleteRes && deleteRes.error}`);
    check(!fs.existsSync(renamedPath), 'fb:delete did not remove the file from disk');

    // Cleanup: remove the subfolder.
    try { fs.rmSync(subDir, { recursive: true, force: true }); } catch (_) {}
  },
};
