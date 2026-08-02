// tests/unit/main/ipc/pipelineIpc.test.js
// Feature 3 — exercises the pipeline:import / :replace / :trash / :thumb IPC
// handlers against a real temp filesystem. Mirrors the fullToolSweep electron-
// mock pattern. Guards the path-security gate (a dst outside the allowed roots
// is rejected) + the copy-not-move + naming contracts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

function setupElectronMock(outputDir) {
  const handlers = {};
  // The PathSecurityService allow-list = effectiveOutputDir + trusted + activeDir.
  // We point config at outputDir so effectiveOutputDir resolves there.
  process.env.MINIMAX_CONFIG_DIR = outputDir;
  const electronMock = {
    module: {
      ipcMain: { handle(ch, fn) { handlers[ch] = fn; } },
      app: { getPath: () => outputDir },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: {},
    },
  };
  require.cache[require.resolve('electron')] = { exports: electronMock.module };
  return { handlers, electronMock };
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ipc-'));
  // Create a fake output_dir under config so effectiveOutputDir lands inside it.
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  // Write a config.txt with output_dir set so effectiveOutputDir resolves.
  fs.writeFileSync(path.join(dir, 'config.txt'), `output_dir = ${outDir}\n`);
  try { return await fn(dir, outDir); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}

test('pipeline:import copies files into the workspace with the img_<id> naming', async () => {
  await withTempDir(async (cfgDir, outDir) => {
    const { handlers } = setupElectronMock(cfgDir);
    // Purge caches so the registrar sees our configDir.
    for (const k of Object.keys(require.cache)) { if (k.includes('PathSecurityService') || k.includes('pipelineModel') || k.includes('config.js') || k.includes('registerPipelineIpc') || k.includes('WorkspaceService')) delete require.cache[k]; }
    require('../../../../main/ipc/registerPipelineIpc').register({ appRoot: process.cwd(), getMainWindow: () => null });

    // Source file anywhere on disk (a read — not gated).
    // H-059: write the full 8-byte PNG signature so FormatRegistry.fromMagic()
    // recognizes it (the old inline check only needed 4 bytes).
    const src = path.join(cfgDir, 'src.png');
    fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
    // R1.4 Phasenpruefung-2: explicitly mint a workspaceId for the
    // test path so the test exercises the WORKSPACEID routing (not
    // the auto-mint fallback that happens to match this path). The
    // workspaceId is minted from the real WorkspaceService so the
    // IPC's resolve() returns the same canonical root.
    //
    // R1.4 Phasenpruefung-3 (CRITICAL fix): WorkspaceService.mint
    // returns `{ok, id, workspace}` — NOT `{ok, grantId, ...}`.
    // `minted.grantId` is `undefined`, which sends the handler
    // down the FALLBACK auto-mint path (not the explicit
    // workspaceId path the test comment claims to exercise). The
    // test passed for the wrong reason. Fix: use `minted.id`.
    const { defaultService: workspaceService } = require('../../../../main/services/WorkspaceService');
    const minted = workspaceService.mint({
      origin: 'picker-workspace', purpose: 'pipelineIpc test', path: outDir,
    });
    const workspaceId = minted.id;
    assert.equal(typeof workspaceId, 'string', 'R1.4 Phasenpruefung-3: minted.id must be a string workspaceId');
    // R1.4 Phasenpruefung-3 (test assertion fix): with the explicit
    // workspaceId the IPC resolves the workspace to the canonical
    // path of the minted folder (outDir itself), NOT the auto-mint
    // fallback path (`<outDir>/pipeline/image`). The old test
    // assertion `ws = path.join(outDir, 'pipeline', 'image')`
    // was only correct because the test was silently going through
    // the FALLBACK path. Now the test exercises the actual
    // explicit-workspaceId routing, so the workspace IS outDir.
    const ws = outDir;

    // P0-D (360° Audit C-006): pipeline:import now requires a read grant
    // per source file. Mint one via the same PathGrantService the
    // production pathGrant:mint IPC uses.
    const { defaultService: grantService } = require('../../../../main/services/PathGrantService');
    const readGrant = grantService.mintFileGrant({
      origin: 'picker-file', purpose: 'pipelineIpc test import', path: src, capabilities: ['read'],
    });
    assert.equal(readGrant.ok, true, 'read grant minted');

    const r = await handlers['pipeline:import']({}, {
      workspaceId,
      items: [{ srcAbsPath: src, destColumn: 'original', imageId: 'img_test1', displayName: 'hero.png', readGrantId: readGrant.grantId }],
    });
    assert.ok(r && Array.isArray(r.results));
    assert.equal(r.results.length, 1);
    assert.ok(r.results[0].ok, 'import should succeed');
    assert.ok(r.results[0].dst, 'should return a dst path');
    assert.ok(r.results[0].dst.includes('img_test1_hero.png'), 'naming: img_<id>_<name>');
    assert.ok(r.results[0].dst.startsWith(ws), 'dst under the explicit-workspaceId workspace');
    assert.ok(fs.existsSync(r.results[0].dst), 'file actually copied');
    assert.ok(fs.existsSync(src), 'source NOT moved (copy semantics)');
  });
});

test('pipeline:import rejects an unknown workspaceId with reauthorizationRequired', async () => {
  // R1.4 contract (S1 §4 "Pipeline und State"): the per-call `workspace`
  // STRING is ignored. A `workspaceId` is required; an unknown id
  // must return reauthorizationRequired so the renderer re-prompts via
  // the native folder flow. This replaces the pre-R1.4 test that
  // tried to steer a workspace path to an off-root location.
  await withTempDir(async (cfgDir, outDir) => {
    const { handlers } = setupElectronMock(cfgDir);
    for (const k of Object.keys(require.cache)) { if (k.includes('PathSecurityService') || k.includes('pipelineModel') || k.includes('config.js') || k.includes('registerPipelineIpc') || k.includes('WorkspaceService')) delete require.cache[k]; }
    require('../../../../main/ipc/registerPipelineIpc').register({ appRoot: process.cwd(), getMainWindow: () => null });

    const src = path.join(cfgDir, 'src.png');
    fs.writeFileSync(src, Buffer.from([0x89]));
    // The workspaceId is a per-call field (top-level payload), not
    // per-item. An unknown id is rejected; every per-item entry
    // carries reauthorizationRequired so the renderer re-prompts.
    const r = await handlers['pipeline:import']({}, {
      workspaceId: 'ws_evil_does_not_exist',
      items: [{ srcAbsPath: src, destColumn: 'original', imageId: 'img_x', displayName: 'a.png' }],
    });
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].ok, false, 'unknown workspaceId rejected');
    assert.equal(r.results[0].reauthorizationRequired, true,
      'R1.4: an unknown workspaceId must set reauthorizationRequired so the renderer re-prompts');
  });
});

test('pipeline:import sanitises a malicious displayName (no path traversal)', async () => {
  await withTempDir(async (cfgDir, outDir) => {
    const { handlers } = setupElectronMock(cfgDir);
    for (const k of Object.keys(require.cache)) { if (k.includes('PathSecurityService') || k.includes('pipelineModel') || k.includes('config.js') || k.includes('registerPipelineIpc') || k.includes('WorkspaceService')) delete require.cache[k]; }
    require('../../../../main/ipc/registerPipelineIpc').register({ appRoot: process.cwd(), getMainWindow: () => null });
    const src = path.join(cfgDir, 'src.png'); fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    // R1.4 Phasenpruefung-2: explicit workspaceId (minted) so the
    // test exercises the routing contract, not the auto-mint fallback.
    //
    // R1.4 Phasenpruefung-3 (CRITICAL fix): use `minted.id`, not
    // `minted.grantId` (which is `undefined` for WorkspaceService).
    const { defaultService: workspaceService } = require('../../../../main/services/WorkspaceService');
    const minted = workspaceService.mint({
      origin: 'picker-workspace', purpose: 'pipelineIpc test (sanitise)', path: outDir,
    });
    const workspaceId = minted.id;
    // R1.4 Phasenpruefung-3 (test assertion fix): with the explicit
    // workspaceId the workspace IS outDir, not the auto-mint fallback.
    const ws = outDir;
    // P0-D (C-006): mint the required read grant for the source file.
    const { defaultService: grantService } = require('../../../../main/services/PathGrantService');
    const readGrant = grantService.mintFileGrant({
      origin: 'picker-file', purpose: 'pipelineIpc test sanitise', path: src, capabilities: ['read'],
    });
    assert.equal(readGrant.ok, true, 'read grant minted');
    const r = await handlers['pipeline:import']({}, {
      workspaceId,
      items: [{ srcAbsPath: src, destColumn: 'original', imageId: 'img_ev', displayName: '../../../etc/passwd.png', readGrantId: readGrant.grantId }],
    });
    assert.ok(r.results[0].ok);
    const dst = r.results[0].dst;
    // The meaningful security property: the resolved dst is still INSIDE the
    // workspace (path.relative from ws does not start with '..'). Slashes are
    // turned into underscores so '../' never appears as a path separator.
    const rel = path.relative(ws, dst);
    assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), 'dst stays inside the workspace (no traversal)');
    assert.ok(!rel.includes('..\\') && !rel.includes('../'), 'no parent-traversal separator in the relative path');
  });
});

test('pipeline:replace copies with a _replaceN infix (GIMP round-trip)', async () => {
  await withTempDir(async (cfgDir, outDir) => {
    const { handlers } = setupElectronMock(cfgDir);
    for (const k of Object.keys(require.cache)) { if (k.includes('PathSecurityService') || k.includes('pipelineModel') || k.includes('config.js') || k.includes('registerPipelineIpc') || k.includes('WorkspaceService')) delete require.cache[k]; }
    require('../../../../main/ipc/registerPipelineIpc').register({ appRoot: process.cwd(), getMainWindow: () => null });
    const src = path.join(cfgDir, 'fixed.png'); fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    // R1.4 Phasenpruefung-2: explicit workspaceId.
    // R1.4 Phasenpruefung-3 (CRITICAL fix): use `minted.id`.
    const { defaultService: workspaceService } = require('../../../../main/services/WorkspaceService');
    const minted = workspaceService.mint({
      origin: 'picker-workspace', purpose: 'pipelineIpc test (replace)', path: outDir,
    });
    const workspaceId = minted.id;
    // P0-D (C-006): mint the required read grant for the source file.
    const { defaultService: grantService } = require('../../../../main/services/PathGrantService');
    const readGrant = grantService.mintFileGrant({
      origin: 'picker-file', purpose: 'pipelineIpc test replace', path: src, capabilities: ['read'],
    });
    assert.equal(readGrant.ok, true, 'read grant minted');
    const r = await handlers['pipeline:replace']({}, { workspaceId, srcAbsPath: src, column: 'crop', imageId: 'img_r', displayName: 'hero.png', readGrantId: readGrant.grantId });
    assert.ok(r.ok, r.error);
    assert.match(r.dst, /replace1\.png$/, 'first replace gets _replace1');
    assert.ok(fs.existsSync(r.dst));
  });
});

test('pipeline:trash moves files into <workspace>/.trash/<id>/', async () => {
  await withTempDir(async (cfgDir, outDir) => {
    const { handlers } = setupElectronMock(cfgDir);
    for (const k of Object.keys(require.cache)) { if (k.includes('PathSecurityService') || k.includes('pipelineModel') || k.includes('config.js') || k.includes('registerPipelineIpc') || k.includes('WorkspaceService')) delete require.cache[k]; }
    require('../../../../main/ipc/registerPipelineIpc').register({ appRoot: process.cwd(), getMainWindow: () => null });
    // R1.4 Phasenpruefung-2: explicit workspaceId.
    // R1.4 Phasenpruefung-3 (CRITICAL fix): use `minted.id`.
    const { defaultService: workspaceService } = require('../../../../main/services/WorkspaceService');
    const minted = workspaceService.mint({
      origin: 'picker-workspace', purpose: 'pipelineIpc test (trash)', path: outDir,
    });
    const workspaceId = minted.id;
    const ws = path.join(outDir, 'pipeline', 'image');
    // Create a file under the workspace to trash.
    const f = path.join(ws, 'original', 'img_t_hero.png');
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from([0x89]));
    const r = await handlers['pipeline:trash']({}, { workspaceId, imageId: 'img_t', files: [f] });
    assert.ok(r.ok);
    assert.equal(r.moved.length, 1);
    assert.ok(r.moved[0].to.includes('.trash'), 'moved into .trash');
    assert.ok(r.moved[0].to.includes('img_t'), 'trash subdir keyed by imageId');
    assert.ok(!fs.existsSync(f), 'original gone (moved)');
    assert.ok(fs.existsSync(r.moved[0].to), 'file now in trash');
  });
});

// 360° audit fix: the prior trash handler reported `moved` unconditionally —
// even when rename AND copy both failed (file already gone), it pushed a
// success entry pointing at a non-existent dst. It must NOT report a move that
// didn't happen, and must NOT delete the source unless the copy succeeded.
test('pipeline:trash does NOT claim success for an already-missing file', async () => {
  await withTempDir(async (cfgDir, outDir) => {
    const { handlers } = setupElectronMock(cfgDir);
    for (const k of Object.keys(require.cache)) { if (k.includes('PathSecurityService') || k.includes('pipelineModel') || k.includes('config.js') || k.includes('registerPipelineIpc') || k.includes('WorkspaceService')) delete require.cache[k]; }
    require('../../../../main/ipc/registerPipelineIpc').register({ appRoot: process.cwd(), getMainWindow: () => null });
    // R1.4 Phasenpruefung-2: explicit workspaceId.
    // R1.4 Phasenpruefung-3 (CRITICAL fix): use `minted.id`.
    const { defaultService: workspaceService } = require('../../../../main/services/WorkspaceService');
    const minted = workspaceService.mint({
      origin: 'picker-workspace', purpose: 'pipelineIpc test (trash-missing)', path: outDir,
    });
    const workspaceId = minted.id;
    const ws = path.join(outDir, 'pipeline', 'image');
    const ghost = path.join(ws, 'original', 'does_not_exist.png');
    const r = await handlers['pipeline:trash']({}, { workspaceId, imageId: 'img_g', files: [ghost] });
    assert.ok(r.ok, 'handler resolves ok (best-effort)');
    assert.equal(r.moved.length, 0, 'a missing file is NOT reported as moved');
    assert.ok(r.failed && r.failed.length >= 1, 'the failure is reported in `failed`');
  });
});

// 360° audit fix: two source files sharing a basename (e.g. hero.png in
// original/ and upscale/) previously collided in the trash bin — the second
// overwrote the first. The handler must de-dup the trash names.
test('pipeline:trash de-dups basenames so sibling-column files do not overwrite', async () => {
  await withTempDir(async (cfgDir, outDir) => {
    const { handlers } = setupElectronMock(cfgDir);
    for (const k of Object.keys(require.cache)) { if (k.includes('PathSecurityService') || k.includes('pipelineModel') || k.includes('config.js') || k.includes('registerPipelineIpc') || k.includes('WorkspaceService')) delete require.cache[k]; }
    require('../../../../main/ipc/registerPipelineIpc').register({ appRoot: process.cwd(), getMainWindow: () => null });
    // R1.4 Phasenpruefung-2: explicit workspaceId.
    // R1.4 Phasenpruefung-3 (CRITICAL fix): use `minted.id`.
    const { defaultService: workspaceService } = require('../../../../main/services/WorkspaceService');
    const minted = workspaceService.mint({
      origin: 'picker-workspace', purpose: 'pipelineIpc test (trash-dedup)', path: outDir,
    });
    const workspaceId = minted.id;
    const ws = path.join(outDir, 'pipeline', 'image');
    const f1 = path.join(ws, 'original', 'img_a_hero.png');
    const f2 = path.join(ws, 'upscale', 'img_b_hero.png');
    fs.mkdirSync(path.dirname(f1), { recursive: true }); fs.mkdirSync(path.dirname(f2), { recursive: true });
    fs.writeFileSync(f1, Buffer.from([0x89])); fs.writeFileSync(f2, Buffer.from([0x50]));
    const r = await handlers['pipeline:trash']({}, { workspaceId, imageId: 'img_dup', files: [f1, f2] });
    assert.equal(r.moved.length, 2, 'both moved');
    assert.notEqual(r.moved[0].to, r.moved[1].to, 'trash destinations differ (no overwrite)');
    // Both bytes preserved distinctly.
    assert.equal(fs.readFileSync(r.moved[0].to)[0], 0x89);
    assert.equal(fs.readFileSync(r.moved[1].to)[0], 0x50);
  });
});

// 360° audit fix: imageId was not charset-validated, so 'a/b/c' could create
// nested subdirs under .trash. Must reject path separators.
test('pipeline:trash rejects an imageId containing path separators', async () => {
  await withTempDir(async (cfgDir, outDir) => {
    const { handlers } = setupElectronMock(cfgDir);
    for (const k of Object.keys(require.cache)) { if (k.includes('PathSecurityService') || k.includes('pipelineModel') || k.includes('config.js') || k.includes('registerPipelineIpc') || k.includes('WorkspaceService')) delete require.cache[k]; }
    require('../../../../main/ipc/registerPipelineIpc').register({ appRoot: process.cwd(), getMainWindow: () => null });
    // R1.4 Phasenpruefung-2: explicit workspaceId (the imageId check
    // fails BEFORE the workspace check, but the workspaceId must
    // still be valid for the handler to reach that check).
    // R1.4 Phasenpruefung-3 (CRITICAL fix): use `minted.id`.
    const { defaultService: workspaceService } = require('../../../../main/services/WorkspaceService');
    const minted = workspaceService.mint({
      origin: 'picker-workspace', purpose: 'pipelineIpc test (imageId-reject)', path: outDir,
    });
    const workspaceId = minted.id;
    const r = await handlers['pipeline:trash']({}, { workspaceId, imageId: 'a/../../evil', files: [] });
    assert.equal(r.ok, false, 'imageId with separators rejected');
  });
});
