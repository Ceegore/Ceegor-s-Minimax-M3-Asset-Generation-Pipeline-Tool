// tests/unit/main/ipc/pipelineWorkspacePersist.test.js
// ============================================================================
// QA-001 (360° bug-hunt) — a custom pipeline workspace must survive a
// save -> restart -> load cycle.
//
// Root cause found: the renderer stored the Main-minted workspaceId on a
// TRANSIENT `_workspaceId` field. The persistence schema (sanitisePipelineBoard
// in src/stateSanitizers.js) only knows `workspaceId` (no underscore), so the
// transient field was dropped on the very first autosave. After a restart the
// renderer's `board._workspaceId` was undefined, pipelineImport sent
// `workspaceId: undefined`, and Main silently fell back to the app-output root
// — the user's custom pipeline folder was lost.
//
// The renderer fix (renderer/pipeline/pipelineOverlay.js) now reads/writes the
// PERSISTED `workspaceId` field. These tests pin the persistence contract that
// fix relies on:
//   (A) a `workspaceId` set via state:set survives state:get (round-trip),
//   (B) a transient `_workspaceId` is dropped (documents the bug),
//   (C) the id keeps resolving across repeated save/load cycles (restart sim),
//   (D) a resolving id is never flagged reauthorizationRequired.
//
// Writes ONLY to an isolated OS-temp config dir. No product-code writes.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const STATE_IPC = path.join(ROOT, 'main', 'ipc', 'registerStateIpc.js');
const WS_MOD = path.join(ROOT, 'main', 'services', 'WorkspaceService.js');

// ---- Isolated temp config dir (mirrors the SYS-001 security harness) ----
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-qa001-wspersist-'));
process.env.MINIMAX_CONFIG_DIR = TMP_HOME;

function loadHandlers() {
  for (const p of [STATE_IPC,
    path.join(ROOT, 'src', 'config'),
    path.join(ROOT, 'src', 'pathUtils'),
    path.join(ROOT, 'main', 'services', 'PathSecurityService'),
    path.join(ROOT, 'src', 'state')]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  const handlers = new Map();
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      app: { getPath: () => TMP_HOME },
      dialog: { showMessageBox: async () => ({ response: 1 }) },
    },
  };
  require.cache[require.resolve('child_process')] = {
    exports: { spawn: () => { throw new Error('spawn should not be called in QA-001 persistence repros'); } },
  };
  require(STATE_IPC).register({ appRoot: TMP_HOME });
  return handlers;
}

// Mint a real, resolvable workspaceId through the SAME singleton the state
// IPC resolves through. WorkspaceService is intentionally NOT flushed in
// loadHandlers, so this id stays resolvable across handler reloads.
function mintWorkspace(tag) {
  const { defaultService } = require(WS_MOD);
  const dir = fs.mkdtempSync(path.join(TMP_HOME, 'ws-' + tag + '-'));
  const m = defaultService.mint({ origin: 'renderer', purpose: 'QA-001 regression ' + tag, path: dir });
  assert.equal(m.ok, true, 'mint must succeed for a real directory (' + tag + ')');
  return { id: m.id, dir };
}

test.after(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
});

test('QA-001.A: a persisted pipeline.image.workspaceId survives a state:set -> state:get round-trip', () => {
  const { id } = mintWorkspace('a');
  const handlers = loadHandlers();
  const stateSet = handlers.get('state:set');
  const stateGet = handlers.get('state:get');
  assert.ok(stateSet && stateGet, 'state:set and state:get handlers must be registered');

  // The renderer persists the Main-minted id on the `workspaceId` field.
  const w = stateSet({}, { pipeline: { image: { workspaceId: id } } });
  assert.equal(w.ok, true, 'state:set must accept a workspaceId payload');

  const s = stateGet({});
  assert.ok(s && s.pipeline && s.pipeline.image, 'state:get must return pipeline.image');
  assert.equal(s.pipeline.image.workspaceId, id,
    'QA-001 fix: the custom workspaceId must survive save -> load (renderer now persists this field)');
});

test('QA-001.B: a transient `_workspaceId` field is dropped on save (the bug the fix avoids)', () => {
  const { id } = mintWorkspace('b');
  const handlers = loadHandlers();
  const stateSet = handlers.get('state:set');
  const stateGet = handlers.get('state:get');

  // Pre-fix renderer behaviour: the id lived only on `_workspaceId`.
  stateSet({}, { pipeline: { image: { _workspaceId: id } } });
  const s = stateGet({});
  assert.ok(s && s.pipeline && s.pipeline.image, 'state:get must return pipeline.image');
  assert.equal(s.pipeline.image.workspaceId, null,
    'a transient _workspaceId is NOT persisted -> after restart the custom workspace is lost ' +
    '(this is exactly why the renderer must use the persisted `workspaceId` field)');
});

test('QA-001.C: the workspaceId keeps resolving across repeated save/load cycles (restart simulation)', () => {
  const { id } = mintWorkspace('c');
  const handlers = loadHandlers();
  const stateSet = handlers.get('state:set');
  const stateGet = handlers.get('state:get');

  // Three consecutive save -> load cycles. Each load feeds the next save,
  // exactly like successive app sessions. The id must never be clobbered.
  let payload = { pipeline: { image: { workspaceId: id } } };
  for (let cycle = 1; cycle <= 3; cycle++) {
    const w = stateSet({}, payload);
    assert.equal(w.ok, true, 'save cycle ' + cycle + ' must succeed');
    const s = stateGet({});
    assert.equal(s.pipeline.image.workspaceId, id,
      'QA-001: workspaceId must still resolve to the custom workspace on cycle ' + cycle);
    assert.notEqual(s.pipeline.image.reauthorizationRequired, true,
      'QA-001: a resolving workspaceId must NOT flag reauthorization on cycle ' + cycle);
    // Feed this load's image back as the next save (the renderer echoes state).
    payload = { pipeline: { image: s.pipeline.image } };
  }
});

test('QA-001.D: an unknown / unresolvable workspaceId is flagged reauthorizationRequired (security preserved)', () => {
  const handlers = loadHandlers();
  const stateSet = handlers.get('state:set');
  const stateGet = handlers.get('state:get');

  // A workspaceId that was never minted (e.g. hand-edited state.json or a
  // stale id from a deleted folder) must NOT be silently trusted.
  stateSet({}, { pipeline: { image: { workspaceId: 'ws_never_minted_deadbeef' } } });
  const s = stateGet({});
  assert.equal(s.pipeline.image.workspaceId, null,
    'R1.4: an unresolvable workspaceId must be nulled, not trusted');
  assert.equal(s.pipeline.image.reauthorizationRequired, true,
    'R1.4: an unresolvable workspaceId must prompt the user to re-pick the folder');
});
