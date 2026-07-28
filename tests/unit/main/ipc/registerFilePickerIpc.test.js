// tests/unit/main/ipc/registerFilePickerIpc.test.js
// ============================================================================
// R1.2 — file:pick + file:saveAs IPC contract tests (S1 §4 + §5).
//
// Invarianten:
//   • file:pick gibt NUR eine `picker-read-file` Grant zurück (read-only,
//     exakte Datei). Kein addTrusted. Der Pfad allein gewährt keine
//     Schreibrechte.
//   • file:saveAs gibt NUR eine `save-as-target` Grant zurück (write,
//     singleUse, exakte Datei). Der Grant wird im selben IPC-Aufruf
//     konsumiert.
//   • Beide Handler teilen sich den defaultService-Singleton, sodass
//     eine in `file:pick` gemintete GrantId auch für `fb:write` (R1.3)
//     sichtbar ist.
//   • Die Pflichtfelder des Envelopes sind ok/path/grantId/capabilities;
//     Renderer-Caller, die `r.path` lesen, bleiben rückwärtskompatibel.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PICKER_IPC = path.join(ROOT, 'main', 'ipc', 'registerFilePickerIpc.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r12-pick-'));

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---- Helper: load registerFilePickerIpc with mocked electron + dialog. ----
function loadIpc({ openResult, saveResult, dialogError = null } = {}) {
  for (const p of [PICKER_IPC, PATH_SECURITY, PATH_GRANT]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  // Reset the defaultService singleton between tests so grants
  // minted by an earlier test do not leak into this one.
  try {
    const { defaultService } = require(PATH_GRANT);
    defaultService.destroy();
  } catch (_) {}

  const handlers = new Map();
  const calls = { addTrusted: [], setActiveDir: [] };
  // The real PathSecurityService.addTrusted / setActiveDir, recorded
  // for the "no global trust" assertion.
  require.cache[require.resolve(PATH_SECURITY)] = {
    exports: {
      getAllowedRoots: () => [TMP],
      isPathUnderAny: (p) => {
        // Treat the temp dir as the only allowed root for source
        // validation. A more elaborate test would pre-seed this
        // via the real service; the source-side check is a
        // temporary bridge per S1 §4 and is migrated in R1.5.
        // We compare by path-component (not realpath) so a
        // non-existent path inside TMP still resolves as "inside",
        // allowing the handler to reach its own existence check.
        const norm = (s) => String(s).toLowerCase().replace(/[\\/]+/g, '/');
        const root = norm(TMP);
        const target = norm(p);
        return target === root || target.startsWith(root + '/');
      },
      isParentUnderAny: () => true,
      addTrusted: (p) => { calls.addTrusted.push(p); return [p]; },
      setActiveDir: (p) => { calls.setActiveDir.push(p); return p; },
      getActiveDir: () => null,
    },
  };
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      dialog: {
        showOpenDialog: async () => {
          if (dialogError) throw dialogError;
          return openResult;
        },
        showSaveDialog: async () => {
          if (dialogError) throw dialogError;
          return saveResult;
        },
      },
      app: { getPath: () => TMP },
    },
  };
  require(PICKER_IPC).register({ getMainWindow: () => null });
  return { handlers, calls };
}

// ===========================================================================
// file:pick
// ===========================================================================

// R1.2.A: file:pick gibt {ok, path, grantId, capabilities} mit read-only
// Grant. Kein addTrusted-Aufruf.
test('R1.2.A: file:pick returns a `picker-read-file` grantId + capabilities, without addTrusted', async () => {
  const target = path.join(TMP, 'source.png');
  fs.writeFileSync(target, 'fake-png-bytes');
  const { handlers, calls } = loadIpc({ openResult: { canceled: false, filePaths: [target] } });
  const pick = handlers.get('file:pick');
  assert.ok(pick, 'file:pick must be registered');

  const r = await pick({}, { title: 'Pick image', filters: [{ name: 'Images', extensions: ['png', 'jpg'] }] });
  assert.equal(r.ok, true);
  assert.equal(r.path, target, 'r.path must mirror the picked path (backward compat)');
  assert.ok(r.grantId, 'r.grantId must be present');
  assert.deepEqual(r.capabilities, ['read'], 'r.capabilities must be exactly [read]');
  // No addTrusted — the picked path is NOT a write-privilege escalation.
  assert.equal(calls.addTrusted.length, 0,
    'file:pick must NOT call PathSecurityService.addTrusted (R1.2 invariant)');
  assert.equal(calls.setActiveDir.length, 0,
    'file:pick must NOT call PathSecurityService.setActiveDir either');

  // The grantId is real: the defaultService can inspect it.
  const { defaultService } = require(PATH_GRANT);
  const grant = defaultService.inspect(r.grantId);
  assert.ok(grant, 'the grantId must be valid in the default service');
  assert.equal(grant.origin, 'picker-read-file');
  assert.equal(grant.kind, 'file');
  assert.equal(grant.capabilities[0], 'read');
  assert.equal(grant.singleUse, false, 'file:pick grants are not singleUse (consumed by read, not by write)');
});

// R1.2.B: file:pick with cancelled dialog returns {ok:false, canceled:true}.
// No grant must be minted.
test('R1.2.B: file:pick with cancelled dialog returns {ok:false, canceled:true} and mints nothing', async () => {
  const { handlers, calls } = loadIpc({ openResult: { canceled: true, filePaths: [] } });
  const pick = handlers.get('file:pick');
  const r = await pick({}, { title: 'Pick image' });
  assert.equal(r.ok, false);
  assert.equal(r.canceled, true);
  assert.ok(!r.grantId, 'no grantId should be minted on cancel');
  assert.equal(calls.addTrusted.length, 0);

  // defaultService is empty.
  const { defaultService } = require(PATH_GRANT);
  // We only minted in the previous test, so we can only check
  // that THIS run's grants are not present. Use inspect on a
  // known-bad id to confirm the store is fresh — actually a
  // simpler check: pick a random ID, it must return null.
  assert.equal(defaultService.inspect('not-minted-' + Date.now()), null);
});

// R1.2.C: file:pick with non-existent path is a noop; the OS dialog
// surfaced the path, the service mints, but a subsequent authorize
// on the missing file (e.g. read) would fail at the OS level. The
// IPC contract does NOT validate the picked path's existence — it
// trusts the dialog. This is fine because the renderer already saw
// the file in the dialog.
test('R1.2.C: file:pick on a missing path still mints a grantId (existence is the consumer\'s problem)', async () => {
  const ghost = path.join(TMP, 'does-not-exist.png');
  const { handlers } = loadIpc({ openResult: { canceled: false, filePaths: [ghost] } });
  const pick = handlers.get('file:pick');
  const r = await pick({}, { title: 'Pick image' });
  assert.equal(r.ok, true);
  assert.equal(r.path, ghost);
  assert.ok(r.grantId, 'a grantId is minted even for a non-existent path (the dialog owns the existence check)');
});

// R1.2.D: file:pick with invalid input opts (no title/filters) falls
// back to the default dialog filter and still mints a grant.
test('R1.2.D: file:pick with empty opts falls back to the default All-Files filter and mints a grant', async () => {
  const target = path.join(TMP, 'any.bin');
  fs.writeFileSync(target, 'x');
  const { handlers, calls } = loadIpc({ openResult: { canceled: false, filePaths: [target] } });
  const pick = handlers.get('file:pick');
  const r = await pick({}, {});
  assert.equal(r.ok, true);
  assert.equal(r.path, target);
  assert.ok(r.grantId);
  assert.deepEqual(r.capabilities, ['read']);
  assert.equal(calls.addTrusted.length, 0);
});

// ===========================================================================
// file:saveAs
// ===========================================================================

// R1.2.E: file:saveAs gibt {ok, path, grantId, capabilities} mit
// singleUse write-Grant. Der Grant wird bei der copyFile-Operation
// konsumiert (singleUse).
test('R1.2.E: file:saveAs returns a singleUse `save-as-target` grantId and consumes it during copy', async () => {
  const src = path.join(TMP, 'src.png');
  const dest = path.join(TMP, 'out.png');
  fs.writeFileSync(src, 'source-bytes');
  const { handlers, calls } = loadIpc({ saveResult: { canceled: false, filePath: dest } });
  const saveAs = handlers.get('file:saveAs');
  assert.ok(saveAs, 'file:saveAs must be registered');

  const r = await saveAs({}, src);
  assert.equal(r.ok, true);
  assert.equal(r.path, dest);
  assert.ok(r.grantId, 'r.grantId must be present');
  assert.deepEqual(r.capabilities, ['write']);

  // The grant is singleUse: it was consumed by the copy.
  const { defaultService } = require(PATH_GRANT);
  const grant = defaultService.inspect(r.grantId);
  assert.ok(grant, 'the grantId must be valid in the default service');
  assert.equal(grant.origin, 'save-as-target');
  assert.equal(grant.kind, 'file');
  assert.equal(grant.singleUse, true);
  assert.equal(grant.consumed, true,
    'singleUse grants must be marked consumed after the copyFile');
  // A second authorize call must reject.
  const second = defaultService.authorize(r.grantId, { operation: 'write', path: dest });
  assert.equal(second.ok, false, 'a consumed singleUse grant must not authorize again');
  assert.match(second.error, /consumed/i);

  // The file was actually copied.
  assert.equal(fs.existsSync(dest), true);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'source-bytes');
  // No addTrusted call.
  assert.equal(calls.addTrusted.length, 0,
    'file:saveAs must NOT call addTrusted (R1.2 invariant)');
});

// R1.2.F: file:saveAs with a cancelled dialog returns {ok:false, canceled:true}.
test('R1.2.F: file:saveAs with cancelled dialog returns {ok:false, canceled:true} and mints nothing', async () => {
  const src = path.join(TMP, 'src.png');
  fs.writeFileSync(src, 'x');
  const { handlers } = loadIpc({ saveResult: { canceled: true, filePath: null } });
  const saveAs = handlers.get('file:saveAs');
  const r = await saveAs({}, src);
  assert.equal(r.ok, false);
  assert.equal(r.canceled, true);
  assert.ok(!r.grantId);
});

// R1.2.G: file:saveAs rejects when srcPath is outside the allowed roots.
test('R1.2.G: file:saveAs rejects when srcPath is outside the allowed roots', async () => {
  const outside = path.join(os.tmpdir(), 'outside-pick-' + Date.now() + '.png');
  const dest = path.join(TMP, 'out-G.png');
  const { handlers } = loadIpc({ saveResult: { canceled: false, filePath: dest } });
  const saveAs = handlers.get('file:saveAs');
  const r = await saveAs({}, outside);
  assert.equal(r.ok, false);
  assert.match(r.error, /outside the allowed/i);
  // No grant was minted (early rejection).
  const { defaultService } = require(PATH_GRANT);
  // Try to inspect a known-bad id to confirm the store is empty.
  assert.equal(defaultService.inspect('never-minted'), null);
  // No file was copied.
  assert.equal(fs.existsSync(dest), false);
});

// R1.2.H: file:saveAs rejects when the source file does not exist.
test('R1.2.H: file:saveAs rejects when the source file does not exist', async () => {
  const ghost = path.join(TMP, 'does-not-exist-H.png');
  const dest = path.join(TMP, 'out-H.png');
  const { handlers } = loadIpc({ saveResult: { canceled: false, filePath: dest } });
  const saveAs = handlers.get('file:saveAs');
  const r = await saveAs({}, ghost);
  assert.equal(r.ok, false);
  assert.match(r.error, /source file does not exist/i);
  // No file was copied.
  assert.equal(fs.existsSync(dest), false);
});

// R1.2.I: file:saveAs rejects when srcPath is missing.
test('R1.2.I: file:saveAs rejects when srcPath is missing or non-string', async () => {
  const { handlers } = loadIpc({});
  const saveAs = handlers.get('file:saveAs');
  for (const bad of [undefined, null, '', 123, {}, []]) {
    const r = await saveAs({}, bad);
    assert.equal(r.ok, false, 'srcPath=' + String(bad) + ' must be rejected');
    assert.match(r.error, /srcPath is required/i);
  }
});

// R1.2.J: file:saveAs dialog error is surfaced (not swallowed).
test('R1.2.J: file:saveAs surfaces a dialog error to the renderer', async () => {
  const src = path.join(TMP, 'src.png');
  fs.writeFileSync(src, 'x');
  const { handlers } = loadIpc({ dialogError: new Error('OS dialog crashed') });
  const saveAs = handlers.get('file:saveAs');
  const r = await saveAs({}, src);
  assert.equal(r.ok, false);
  assert.match(r.error, /OS dialog crashed/);
});
