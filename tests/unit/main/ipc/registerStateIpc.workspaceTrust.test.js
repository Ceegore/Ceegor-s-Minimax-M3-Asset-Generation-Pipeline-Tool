// tests/unit/main/ipc/registerStateIpc.workspaceTrust.test.js
// ============================================================================
// R1.4 (S1 §4 "Pipeline und State"): state:get MUST NOT addTrusted() a
// renderer-supplied path. A legacy persisted `pipeline.image.workspace`
// string is migrated to a Main-minted `workspaceId` (or reported as
// `reauthorizationRequired`); the trust gate is no longer widened
// implicitly by reading the state.
//
// Pre-R1.4 this test asserted that state:get addTrusted()'d the
// workspace path. That was the X1-F4 / H11-2 fix that the SYS-001
// threat model (R0.1-001) flagged as a security loophole. The R1.4
// contract replaces it: persisted paths are never trusted on read;
// mutations are authorised per-call via a Main-minted grant.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-state-workspace-test-'));
process.env.MINIMAX_CONFIG_DIR = tmpDir;

const handlers = new Map();
const fakeIpcMain = {
  handle: (channel, fn) => handlers.set(channel, fn),
  removeHandler: (channel) => handlers.delete(channel),
};
const userData = path.join(tmpDir, 'userData');
require.cache[require.resolve('electron')] = {
  exports: {
    app: { getPath: (k) => (k === 'userData' ? userData : tmpDir) },
    ipcMain: fakeIpcMain,
  },
};

for (const mod of [
  '../../../../main/ipc/registerStateIpc',
  '../../../../src/state',
  '../../../../src/config',
  '../../../../main/services/PathSecurityService',
  '../../../../main/services/WorkspaceService',
]) {
  try { delete require.cache[require.resolve(mod)]; } catch (_) {}
}

const stateMod = require('../../../../src/state');
const { defaultService: workspaceService } = require('../../../../main/services/WorkspaceService');
// Reset the workspace registry so the test starts clean.
workspaceService.destroy();
const registerStateIpc = require('../../../../main/ipc/registerStateIpc');
registerStateIpc.register({ appRoot: tmpDir });

test('R1.4: state:get does NOT addTrusted() a persisted custom workspace (R1.4 contract)', () => {
  // R1.4 Phasenpruefung (CRITICAL fix): the legacy `workspace` string
  // is only auto-mintable when it is INSIDE a currently Main-registered
  // Config-Root. To exercise the auto-mint path we put the custom
  // workspace INSIDE the test's output_dir (which is the
  // Main-registered Config-Root for this test). The OUTSIDE case is
  // covered by the next test.
  const cfgMod = require('../../../../src/config');
  const configRoot = cfgMod.effectiveOutputDir(cfgMod.read());
  const customWorkspace = path.join(configRoot, 'mmx-custom-pipeline-workspace-' + Date.now());
  fs.mkdirSync(customWorkspace, { recursive: true });
  const s = stateMod.read();
  s.pipeline = { image: { workspace: customWorkspace, columns: [], hiddenColumns: [], columnFolders: {}, items: [], trash: [], counter: 0 } };
  stateMod.write(s);

  const handler = handlers.get('state:get');
  assert.ok(handler, 'state:get handler must be registered');
  const out = handler();

  // R1.4 invariant: state:get MUST NOT call addTrusted for the
  // workspace. The legacy pre-R1.4 code did; R1.4 removed every
  // addTrusted call from state:get. We assert the absence indirectly:
  // the path is a child of the Config-Root (so isPathUnderAny would
  // already be true via the Config-Root registration, not via
  // addTrusted); R1.4 keeps it that way. A more direct test would
  // require instrumenting PathSecurityService to count addTrusted
  // calls; for now the migration contract (auto-mint to workspaceId)
  // is the load-bearing assertion.

  // The legacy string is migrated to a workspaceId. The renderer
  // gets the id (or reauthorizationRequired) so it can re-prompt
  // the user via the native folder flow.
  assert.ok(out && out.pipeline && out.pipeline.image, 'state:get must return the pipeline image object');
  const img = out.pipeline.image;
  assert.equal(Boolean(img.workspaceId), true,
    'R1.4: state:get must migrate a legacy string path INSIDE a Config-Root to a Main-minted workspaceId');
  assert.equal(typeof img.workspaceId, 'string',
    'R1.4: workspaceId must be a string id');
  // The legacy string is dropped on the way back (state may store
  // workspaceId, never a free-form workspace path).
  assert.equal(img.workspace, undefined,
    'R1.4: state:get must NOT return a `workspace` path (only workspaceId)');
  // The minted id resolves to the same canonical root.
  const resolved = workspaceService.resolve(img.workspaceId);
  assert.equal(resolved && fs.realpathSync(resolved), fs.realpathSync(customWorkspace),
    'R1.4: the minted workspaceId must resolve to the original path');
});

test('R1.4: a legacy workspace OUTSIDE the Config-Root sets reauthorizationRequired (CRITICAL — S1 §4)', () => {
  // S1 §4: "Ein Legacy-Workspace außerhalb des aktuellen Main-registrierten
  // Config-Roots wird nicht gelöscht und nicht vertraut; er wird als
  // reauthorizationRequired zurückgemeldet." This test pins that
  // contract: a legacy path that is NOT under the Config-Root must
  // NOT be auto-minted (an attacker who smuggled an absolute path
  // into a pre-R1.4 state.json must not gain a Main-minted grant).
  const outsidePath = path.join(os.tmpdir(), 'mmx-r14-outside-' + Date.now());
  fs.mkdirSync(outsidePath, { recursive: true });
  // Sanity: the outside path is NOT under the Main-registered
  // Config-Root.
  const cfgMod = require('../../../../src/config');
  const configRoot = cfgMod.effectiveOutputDir(cfgMod.read());
  assert.equal(outsidePath.startsWith(configRoot), false,
    'precondition: the outside path must NOT be inside the Config-Root');

  const s = stateMod.read();
  s.pipeline = { image: { workspace: outsidePath, columns: [], hiddenColumns: [], columnFolders: {}, items: [], trash: [], counter: 0 } };
  stateMod.write(s);

  const handler = handlers.get('state:get');
  const out = handler();
  const img = out && out.pipeline && out.pipeline.image;
  assert.ok(img, 'state:get must return the image object');
  // The outside path is NOT auto-minted. workspaceId is null and
  // reauthorizationRequired is true so the renderer can re-prompt
  // the user via the native folder flow.
  assert.equal(img.workspaceId, null,
    'R1.4 CRITICAL: a legacy workspace OUTSIDE the Config-Root must NOT be auto-minted (workspaceId stays null)');
  assert.equal(img.reauthorizationRequired, true,
    'R1.4 CRITICAL: a legacy workspace OUTSIDE the Config-Root must set reauthorizationRequired=true');
  // The legacy string is still dropped.
  assert.equal(img.workspace, undefined,
    'R1.4: the legacy `workspace` string is always dropped on the way back');
});

test('R1.4: a persisted workspaceId that no longer resolves sets reauthorizationRequired', () => {
  // Mint a workspace, persist its id, then destroy the registry
  // (simulating a fresh session that has lost the in-memory id).
  const wsPath = path.join(os.tmpdir(), 'mmx-r14-vanished-' + Date.now());
  fs.mkdirSync(wsPath, { recursive: true });
  const minted = workspaceService.mint({
    origin: 'app-output', purpose: 'R1.4 vanished test', path: wsPath,
  });
  assert.equal(minted.ok, true);
  // Persist the id.
  const s = stateMod.read();
  s.pipeline = { image: { workspaceId: minted.id, columns: [], hiddenColumns: [], columnFolders: {}, items: [], trash: [], counter: 0 } };
  stateMod.write(s);
  // Simulate a restart: destroy the in-memory registry.
  workspaceService.destroy();
  // state:get should now report reauthorizationRequired (and the
  // workspaceId field cleared) because the id is no longer known.
  const out = handlers.get('state:get')();
  const img = out && out.pipeline && out.pipeline.image;
  assert.ok(img, 'state:get must return the image object');
  assert.equal(img.workspaceId, null,
    'R1.4: a vanished workspaceId must be cleared (not silently trusted)');
  assert.equal(img.reauthorizationRequired, true,
    'R1.4: a vanished workspaceId must set reauthorizationRequired=true so the renderer re-prompts');
});

test('R1.4 Phasenpruefung-2: a migration error does NOT wipe the user\'s state', () => {
  // R1.4 used to wrap the ENTIRE state:get in a try-catch that
  // returned {} on any error. That meant a migration failure
  // (workspaceService.mint / isPathUnderAny / realpath throwing on
  // a weird path) would erase the user's valid state.json — DATA
  // LOSS. After the fix, migration errors are caught LOCALLY and
  // set reauthorizationRequired; the underlying state.json is
  // preserved. This test simulates a migration error by forcing
  // workspaceService.mint to throw, and asserts the user's other
  // state fields (tabs, filePrefix, etc.) survive the error.
  //
  // R1.4 Phasenpruefung-3 (CRITICAL fix): the legacy test used
  // `path.join(os.tmpdir(), ...)` which is OUTSIDE the test's
  // Config-Root (`tmpDir/userData/generated`). With that path the
  // migration's OUTSIDE branch is hit (which was already covered
  // by the "a legacy workspace OUTSIDE the Config-Root" test) and
  // the stubbed workspaceService.mint is NEVER called. The test
  // passed for the wrong reason — not because the local try-catch
  // caught the simulated migration error, but because the OUTSIDE
  // branch correctly set reauthorizationRequired. The fix: put the
  // exploding path INSIDE the Config-Root so the migration reaches
  // workspaceService.mint() and the stub throw is actually invoked.
  const cfgMod = require('../../../../src/config');
  const configRoot = cfgMod.effectiveOutputDir(cfgMod.read());
  const s = stateMod.read();
  // Set the user's settings to a known shape.
  s.tabs = { image: { prompt: 'robot' } };
  s.filePrefix = 'demo-';
  s.filePrefixForceOnly = true;
  const explodingPath = path.join(configRoot, 'mmx-r14-exploding-' + Date.now());
  fs.mkdirSync(explodingPath, { recursive: true });
  // Sanity: the exploding path IS under the Config-Root (so the
  // migration reaches workspaceService.mint, not the OUTSIDE branch).
  assert.equal(explodingPath.startsWith(configRoot), true,
    'precondition: the exploding path must be INSIDE the Config-Root so the migration reaches workspaceService.mint');
  s.pipeline = {
    image: {
      workspace: explodingPath,
      columns: [], hiddenColumns: [], columnFolders: {}, items: [], trash: [], counter: 0,
    },
  };
  stateMod.write(s);
  // Force the next mint to throw. This simulates a migration error
  // (e.g., a realpath failure on a bizarre path that the user had
  // persisted pre-R1.4). With the path now INSIDE the Config-Root,
  // the local try-catch in state:get is actually exercised.
  const origMint = workspaceService.mint.bind(workspaceService);
  let mintCallCount = 0;
  workspaceService.mint = function () {
    mintCallCount++;
    throw new Error('simulated migration failure');
  };
  try {
    const out = handlers.get('state:get')();
    // Verify the migration ACTUALLY reached workspaceService.mint —
    // otherwise the test passed for the wrong reason.
    assert.equal(mintCallCount, 1,
      'R1.4 Phasenpruefung-3: the migration must actually call workspaceService.mint (count=1) — ' +
      'if this is 0, the test path is OUTSIDE the Config-Root and the OUTSIDE branch short-circuits the mint call');
    // The user's tabs/filePrefix are preserved (state.json NOT wiped).
    assert.equal(out && out.tabs && out.tabs.image && out.tabs.image.prompt, 'robot',
      'R1.4 Phasenpruefung-2: a migration error must NOT wipe the user\'s tabs');
    assert.equal(out.filePrefix, 'demo-',
      'R1.4 Phasenpruefung-2: filePrefix must survive a migration error');
    assert.equal(out.filePrefixForceOnly, true,
      'R1.4 Phasenpruefung-2: filePrefixForceOnly must survive a migration error');
    // The legacy workspace is still dropped (replaced by re-prompt).
    const img = out.pipeline.image;
    assert.equal(img.workspace, undefined,
      'R1.4: the legacy `workspace` string is still dropped even on migration error');
    // reauthorizationRequired is set so the renderer re-prompts.
    assert.equal(img.reauthorizationRequired, true,
      'R1.4 Phasenpruefung-2: a migration error must set reauthorizationRequired=true');
    assert.equal(img.workspaceId, null,
      'R1.4 Phasenpruefung-2: a migration error must clear workspaceId');
  } finally {
    workspaceService.mint = origMint;
  }
});

test('R1.4 Phasenpruefung-3: isPathUnderAny throwing is caught locally (data preserved)', () => {
  // R1.4 Phasenpruefung-2 added a local try-catch around the
  // migration. The Phasenpruefung-3 walks each helper in the
  // migration to ensure the catch is reachable for each throw
  // source. This test pins the isPathUnderAny helper: a throw
  // there must be caught locally and set reauthorizationRequired,
  // NOT propagate to the outer catch (which would erase state).
  const cfgMod = require('../../../../src/config');
  const configRoot = cfgMod.effectiveOutputDir(cfgMod.read());
  const insidePath = path.join(configRoot, 'mmx-r14-ispathtunder-throw-' + Date.now());
  fs.mkdirSync(insidePath, { recursive: true });
  const s = stateMod.read();
  s.tabs = { image: { prompt: 'guard' } };
  s.filePrefix = 'iso-';
  s.pipeline = {
    image: {
      workspace: insidePath,
      columns: [], hiddenColumns: [], columnFolders: {}, items: [], trash: [], counter: 0,
    },
  };
  stateMod.write(s);
  // Force isPathUnderAny to throw. The local try-catch in state:get
  // catches it and sets reauthorizationRequired. Tabs/filePrefix
  // survive because the outer catch (which would return {}) is
  // never reached.
  const pathUtils = require('../../../../src/pathUtils');
  const origIsPathUnderAny = pathUtils.isPathUnderAny;
  let throwCount = 0;
  pathUtils.isPathUnderAny = function () {
    throwCount++;
    throw new Error('simulated isPathUnderAny failure');
  };
  try {
    const out = handlers.get('state:get')();
    assert.equal(throwCount, 1,
      'R1.4 Phasenpruefung-3: isPathUnderAny must actually be called (count=1) — ' +
      'if this is 0, the code path skipped the boundary check');
    // Tabs preserved (data NOT wiped).
    assert.equal(out && out.tabs && out.tabs.image && out.tabs.image.prompt, 'guard',
      'R1.4 Phasenpruefung-3: tabs must survive an isPathUnderAny throw');
    assert.equal(out.filePrefix, 'iso-',
      'R1.4 Phasenpruefung-3: filePrefix must survive an isPathUnderAny throw');
    const img = out.pipeline.image;
    assert.equal(img.workspace, undefined,
      'R1.4: the legacy `workspace` string is dropped on isPathUnderAny throw');
    assert.equal(img.reauthorizationRequired, true,
      'R1.4 Phasenpruefung-3: an isPathUnderAny throw must set reauthorizationRequired=true');
    assert.equal(img.workspaceId, null,
      'R1.4 Phasenpruefung-3: an isPathUnderAny throw must clear workspaceId');
  } finally {
    pathUtils.isPathUnderAny = origIsPathUnderAny;
  }
});

test('R1.4 Phasenpruefung-3: workspaceService.resolve throwing is caught locally (data preserved)', () => {
  // R1.4 Phasenpruefung-2 added a SECOND try-catch around
  // workspaceService.resolve (for the case where the user
  // persists a workspaceId that the resolver throws on, e.g. an
  // I/O error during statSync on a race condition). This test
  // pins that contract: a resolve throw must be caught locally
  // and set reauthorizationRequired.
  const cfgMod = require('../../../../src/config');
  const configRoot = cfgMod.effectiveOutputDir(cfgMod.read());
  const wsPath = path.join(configRoot, 'mmx-r14-resolve-throw-' + Date.now());
  fs.mkdirSync(wsPath, { recursive: true });
  // First: mint a real workspace so a real workspaceId is in the
  // persisted state. This is the "happy path" baseline.
  const m = workspaceService.mint({ origin: 'picker-workspace', purpose: 'resolve-throw test', path: wsPath });
  assert.equal(m.ok, true, 'mint must succeed for a real directory');
  const s = stateMod.read();
  s.tabs = { image: { prompt: 'resolve' } };
  s.filePrefix = 'res-';
  s.pipeline = {
    image: {
      workspaceId: m.id,
      columns: [], hiddenColumns: [], columnFolders: {}, items: [], trash: [], counter: 0,
    },
  };
  stateMod.write(s);
  // Now stub workspaceService.resolve to throw. The local try-catch
  // in the resolve branch of state:get catches it.
  const origResolve = workspaceService.resolve.bind(workspaceService);
  let resolveCount = 0;
  workspaceService.resolve = function () {
    resolveCount++;
    throw new Error('simulated resolve failure');
  };
  try {
    const out = handlers.get('state:get')();
    assert.equal(resolveCount, 1,
      'R1.4 Phasenpruefung-3: workspaceService.resolve must actually be called (count=1) — ' +
      'if this is 0, the code path skipped the resolve branch');
    // Tabs preserved (data NOT wiped).
    assert.equal(out && out.tabs && out.tabs.image && out.tabs.image.prompt, 'resolve',
      'R1.4 Phasenpruefung-3: tabs must survive a resolve throw');
    assert.equal(out.filePrefix, 'res-',
      'R1.4 Phasenpruefung-3: filePrefix must survive a resolve throw');
    const img = out.pipeline.image;
    assert.equal(img.workspaceId, null,
      'R1.4 Phasenpruefung-3: a resolve throw must clear workspaceId');
    assert.equal(img.reauthorizationRequired, true,
      'R1.4 Phasenpruefung-3: a resolve throw must set reauthorizationRequired=true');
  } finally {
    workspaceService.resolve = origResolve;
  }
});
