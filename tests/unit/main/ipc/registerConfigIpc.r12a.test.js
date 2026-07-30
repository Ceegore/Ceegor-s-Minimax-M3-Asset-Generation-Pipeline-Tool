// tests/unit/main/ipc/registerConfigIpc.r12a.test.js
// ============================================================================
// R1.2a — config:pickFolder + config:set grant contract (S1 §4 + §6).
//
// Invarianten:
//   • `config:pickFolder` mints einen `config-output` oder
//     `config-report` Grant und liefert {ok, path, grantId, capabilities}.
//     KEIN addTrusted mehr.
//   • `config:set` darf `output_dir` / `report_dir` nur ändern, wenn
//     der entsprechende, noch gültige Grant für genau den neuen Pfad
//     beigefügt wird. Unveränderte Config-Felder brauchen keinen
//     Grant. Manuelle Texteingabe ist verboten — der Main antwortet
//     mit einem klaren Fehler.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CFG_IPC = path.join(ROOT, 'main', 'ipc', 'registerConfigIpc.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
const MMX_KEY_SYNC = path.join(ROOT, 'src', 'mmxApiKeySync.js');
const SESSION_STORE = path.join(ROOT, 'main', 'services', 'SessionCredentialStore.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r12a-cfg-'));

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---- Helper: load registerConfigIpc with mocked electron + dialog. ----
function loadIpc({ openResult, dialogError = null } = {}) {
  for (const p of [CFG_IPC, PATH_SECURITY, PATH_GRANT, MMX_KEY_SYNC]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  // Reset the defaultService singleton between tests.
  try {
    const { defaultService } = require(PATH_GRANT);
    defaultService.destroy();
  } catch (_) {}

  const handlers = new Map();
  // Stub PathSecurityService — no addTrusted tracking needed because
  // R1.2a does NOT use it.
  require.cache[require.resolve(PATH_SECURITY)] = {
    exports: {
      getAllowedRoots: () => [TMP],
      isPathUnderAny: () => true,
      isParentUnderAny: () => true,
      addTrusted: () => [],
      setActiveDir: () => null,
      getActiveDir: () => null,
    },
  };
  require.cache[require.resolve(MMX_KEY_SYNC)] = {
    exports: { clearApiKeyFromMmxCliConfig: () => true, syncApiKeyToMmxCliConfig: () => true },
  };
  require(SESSION_STORE)._resetForTest();
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      dialog: {
        showOpenDialog: async () => {
          if (dialogError) throw dialogError;
          return openResult;
        },
      },
      app: { getPath: () => TMP },
    },
  };
  process.env.MINIMAX_CONFIG_DIR = TMP;
  require(CFG_IPC).register({ getMainWindow: () => null });
  return { handlers };
}

// ===========================================================================
// config:pickFolder
// ===========================================================================

// R1.2a.A: pickFolder mints a `config-output` grant with directory
// capabilities. No addTrusted. The grant kind is 'directory-root'
// (coversRoot:true) so the user can both authorise the new
// output_dir and write files inside.
test('R1.2a.A: config:pickFolder defaults to config-output purpose and mints a directory-root grant', async () => {
  const target = path.join(TMP, 'picked-output');
  fs.mkdirSync(target, { recursive: true });
  const { handlers } = loadIpc({ openResult: { canceled: false, filePaths: [target] } });
  const pick = handlers.get('config:pickFolder');
  const r = await pick({}, {});
  assert.equal(r.ok, true);
  assert.equal(r.path, target);
  assert.ok(r.grantId, 'r.grantId must be present');
  assert.ok(Array.isArray(r.capabilities), 'r.capabilities must be present');
  // The grant is a real directory-root grant on the defaultService.
  const { defaultService } = require(PATH_GRANT);
  const grant = defaultService.inspect(r.grantId);
  assert.ok(grant, 'the grantId must be valid in the default service');
  assert.equal(grant.origin, 'config-output');
  assert.equal(grant.kind, 'directory-root', 'config-output grants cover the root AND its descendants (app-output use case)');
  assert.ok(grant.capabilities.includes('write'),
    'a config-output grant must include the write capability');
});

// R1.2a.B: pickFolder with purpose:'config-report' mints a report grant.
test('R1.2a.B: config:pickFolder with purpose=report mints a config-report grant', async () => {
  const target = path.join(TMP, 'picked-report');
  fs.mkdirSync(target, { recursive: true });
  const { handlers } = loadIpc({ openResult: { canceled: false, filePaths: [target] } });
  const pick = handlers.get('config:pickFolder');
  const r = await pick({}, { purpose: 'config-report' });
  assert.equal(r.ok, true);
  const { defaultService } = require(PATH_GRANT);
  const grant = defaultService.inspect(r.grantId);
  assert.equal(grant.origin, 'config-report');
});

// R1.2a.C: pickFolder with unknown purpose defaults to config-output.
test('R1.2a.C: config:pickFolder with unknown purpose defaults to config-output', async () => {
  const target = path.join(TMP, 'picked-unknown');
  fs.mkdirSync(target, { recursive: true });
  const { handlers } = loadIpc({ openResult: { canceled: false, filePaths: [target] } });
  const pick = handlers.get('config:pickFolder');
  const r = await pick({}, { purpose: 'whatever' });
  const { defaultService } = require(PATH_GRANT);
  const grant = defaultService.inspect(r.grantId);
  assert.equal(grant.origin, 'config-output', 'unknown purpose must fall back to config-output');
});

// R1.2a.D: pickFolder with cancelled dialog returns {ok:false, canceled:true}.
test('R1.2a.D: cancelled pickFolder returns {ok:false, canceled:true} and mints nothing', async () => {
  const { handlers } = loadIpc({ openResult: { canceled: true, filePaths: [] } });
  const pick = handlers.get('config:pickFolder');
  const r = await pick({}, { purpose: 'config-output' });
  assert.equal(r.ok, false);
  assert.equal(r.canceled, true);
  assert.ok(!r.grantId);
});

// ===========================================================================
// config:set — output_dir grant contract
// ===========================================================================

// R1.2a.E: changing output_dir without a grant is REJECTED with a
// clear error message that names the picker path.
test('R1.2a.E: config:set rejects an output_dir change without a grant', async () => {
  const { handlers } = loadIpc({});
  const setCfg = handlers.get('config:set');
  // Set output_dir to a new value (from the empty default) WITHOUT a
  // grant. Must reject.
  const r = await setCfg({}, { cfg: { output_dir: path.join(TMP, 'no-grant-output') } });
  assert.equal(r.ok, false);
  assert.match(r.error, /output_dir changed but no grant/i);
  assert.match(r.error, /config:pickFolder/i,
    'error message must direct the caller to the picker path');
});

test('first run accepts the Main-owned default output directory without a Browse grant', async () => {
  const { handlers } = loadIpc({});
  const cfgMod = require(path.join(ROOT, 'src', 'config'));
  cfgMod.write(cfgMod.defaultConfig());
  const defaultDir = await handlers.get('config:defaultOutputDir')();
  const r = await handlers.get('config:set')({}, {
    cfg: { api_key: 'sk-first-run', output_dir: defaultDir },
    grants: {},
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.config.output_dir, defaultDir);
  // SEC-001: config:set returns a public DTO (no raw api_key).
  assert.equal(r.config.hasApiKey, true);
});

test('session-only Settings save stores the key in Main memory and never in config.txt', async () => {
  const { handlers } = loadIpc({});
  const r = await handlers.get('config:set')({}, {
    cfg: { api_key: '' }, apiKeyNoSave: true, sessionApiKey: 'sk-session-only', grants: {},
  });
  assert.equal(r.ok, true, r.error);
  // SEC-001: config:set returns a public DTO — empty key means hasApiKey:false.
  assert.equal(r.config.hasApiKey, false);
  assert.equal(require(SESSION_STORE).getSessionCredential(), 'sk-session-only');
});

// R1.2a.F: changing output_dir WITH a valid grant is accepted.
test('R1.2a.F: config:set accepts an output_dir change with a matching config-output grant', async () => {
  const target = path.join(TMP, 'granted-output');
  fs.mkdirSync(target, { recursive: true });
  const { handlers } = loadIpc({ openResult: { canceled: false, filePaths: [target] } });
  // First: pick a folder (mints a grant).
  const pick = handlers.get('config:pickFolder');
  const pickR = await pick({}, { purpose: 'config-output' });
  assert.equal(pickR.ok, true);
  // Second: setConfig with the grantId.
  const setCfg = handlers.get('config:set');
  const r = await setCfg({}, {
    cfg: { output_dir: target },
    grants: { output_dir: pickR.grantId },
  });
  assert.equal(r.ok, true);
  assert.equal(r.config.output_dir, target);
});

// R1.2a.G: changing output_dir with a grant for a DIFFERENT path is
// rejected (the grant covers only its exact canonical root).
test('R1.2a.G: config:set rejects when the grant is for a different path than output_dir', async () => {
  const picked = path.join(TMP, 'picked-path-A');
  const requested = path.join(TMP, 'different-path-B');
  fs.mkdirSync(picked, { recursive: true });
  fs.mkdirSync(requested, { recursive: true });
  const { handlers } = loadIpc({ openResult: { canceled: false, filePaths: [picked] } });
  const pickR = await handlers.get('config:pickFolder')({}, { purpose: 'config-output' });
  const r = await handlers.get('config:set')({}, {
    cfg: { output_dir: requested },
    grants: { output_dir: pickR.grantId },
  });
  assert.equal(r.ok, false, 'a grant for path A must NOT authorize output_dir=path-B');
  assert.match(r.error, /output_dir grant rejected|exact canonical path|not permitted/i);
});

// R1.2a.H: a config-report grant is rejected for an output_dir change.
test('R1.2a.H: config:set rejects a config-report grant used for an output_dir change', async () => {
  // The grant-service itself doesn't enforce purpose-mismatch; the
  // IPC handler must. We mint a config-report grant and try to use
  // it for output_dir — the IPC must reject because the purpose
  // does not match the field being set.
  const target = path.join(TMP, 'cross-purpose');
  fs.mkdirSync(target, { recursive: true });
  const { handlers } = loadIpc({ openResult: { canceled: false, filePaths: [target] } });
  const pickR = await handlers.get('config:pickFolder')({}, { purpose: 'config-report' });
  // The grant was minted for path = target with origin = 'config-report'.
  // Try to use it for output_dir = target. The grant is valid for the
  // path, but the PURPOSE is wrong. R1.2a is strict: the grant
  // origin must match the field being changed.
  //
  // NOTE: today, the grant-service only checks path + capabilities.
  // The purpose-mismatch check must live in the IPC handler. This
  // test pins that the handler rejects the misuse.
  const r = await handlers.get('config:set')({}, {
    cfg: { output_dir: target },
    grants: { output_dir: pickR.grantId },
  });
  assert.equal(r.ok, false, 'a config-report grant must NOT authorize an output_dir change (purpose mismatch)');
  assert.match(r.error, /config-output|config-report|purpose|origin/i);
});

// R1.2a.I: leaving output_dir unchanged does NOT require a grant.
test('R1.2a.I: config:set accepts an unchanged output_dir without any grant', async () => {
  const { handlers } = loadIpc({});
  // Read the current output_dir, then re-save it unchanged. The
  // previous tests may have left a non-empty value in TMP; we
  // explicitly preserve that value so the "no change" path is
  // actually exercised.
  const cfgMod = require(path.join(ROOT, 'src', 'config'));
  const current = cfgMod.read();
  const preserved = current.output_dir || '';
  const r = await handlers.get('config:set')({}, { cfg: { output_dir: preserved } });
  assert.equal(r.ok, true, 'unchanged output_dir must be storable without a grant');
  assert.equal(r.config.output_dir, preserved);
});

// R1.2a.J: a revoked grant is rejected for an output_dir change.
test('R1.2a.J: config:set rejects a revoked grant for an output_dir change', async () => {
  const target = path.join(TMP, 'revoked-output');
  fs.mkdirSync(target, { recursive: true });
  const { handlers } = loadIpc({ openResult: { canceled: false, filePaths: [target] } });
  const pickR = await handlers.get('config:pickFolder')({}, { purpose: 'config-output' });
  // Revoke the grant via the defaultService.
  const { defaultService } = require(PATH_GRANT);
  defaultService.revoke(pickR.grantId);
  // Now the save must reject.
  const r = await handlers.get('config:set')({}, {
    cfg: { output_dir: target },
    grants: { output_dir: pickR.grantId },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /output_dir grant rejected|revoked/i);
});

// R1.2a.K: an unknown grantId is rejected for an output_dir change.
test('R1.2a.K: config:set rejects an unknown grantId for an output_dir change', async () => {
  const target = path.join(TMP, 'unknown-grant');
  fs.mkdirSync(target, { recursive: true });
  const { handlers } = loadIpc({ openResult: { canceled: false, filePaths: [target] } });
  const r = await handlers.get('config:set')({}, {
    cfg: { output_dir: target },
    grants: { output_dir: 'this-id-was-never-minted' },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /output_dir grant rejected|not found/i);
});

// ===========================================================================
// config:set — report_dir grant contract (parallel to output_dir)
// ===========================================================================

// R1.2a.L: changing report_dir without a grant is REJECTED.
test('R1.2a.L: config:set rejects a report_dir change without a grant', async () => {
  const { handlers } = loadIpc({});
  const r = await handlers.get('config:set')({}, { cfg: { report_dir: path.join(TMP, 'no-grant-report') } });
  assert.equal(r.ok, false);
  assert.match(r.error, /report_dir changed but no grant/i);
});

// R1.2a.M: changing report_dir WITH a config-report grant is accepted.
test('R1.2a.M: config:set accepts a report_dir change with a matching config-report grant', async () => {
  const target = path.join(TMP, 'granted-report');
  fs.mkdirSync(target, { recursive: true });
  const { handlers } = loadIpc({ openResult: { canceled: false, filePaths: [target] } });
  const pickR = await handlers.get('config:pickFolder')({}, { purpose: 'config-report' });
  const r = await handlers.get('config:set')({}, {
    cfg: { report_dir: target },
    grants: { report_dir: pickR.grantId },
  });
  assert.equal(r.ok, true);
  assert.equal(r.config.report_dir, target);
});

// R1.2a.N: a config-output grant is rejected for a report_dir change.
test('R1.2a.N: a config-output grant is rejected for a report_dir change (purpose mismatch)', async () => {
  const target = path.join(TMP, 'cross-purpose-report');
  fs.mkdirSync(target, { recursive: true });
  const { handlers } = loadIpc({ openResult: { canceled: false, filePaths: [target] } });
  const pickR = await handlers.get('config:pickFolder')({}, { purpose: 'config-output' });
  const r = await handlers.get('config:set')({}, {
    cfg: { report_dir: target },
    grants: { report_dir: pickR.grantId },
  });
  assert.equal(r.ok, false, 'a config-output grant must NOT authorize a report_dir change');
  assert.match(r.error, /config-output|config-report|purpose|origin/i);
});

// ===========================================================================
// config:set — other fields (backward compat)
// ===========================================================================

// R1.2a.O: setting non-output_dir, non-report_dir fields works
// without any grant (legacy behavior preserved).
test('R1.2a.O: config:set accepts a payload with only api_key/region/theme/styles (no grants required)', async () => {
  const { handlers } = loadIpc({});
  const r = await handlers.get('config:set')({}, { cfg: { api_key: 'sk-test', region: 'global', theme: 'dark', styles: [] } });
  assert.equal(r.ok, true);
  // SEC-001: config:set returns a public DTO (no raw api_key).
  assert.equal(r.config.hasApiKey, true);
});

// R1.2a.P: setting BOTH output_dir (with a valid grant) and other
// fields works in one call.
test('R1.2a.P: config:set accepts a payload with output_dir (granted) + other fields in one call', async () => {
  const target = path.join(TMP, 'combined-output');
  fs.mkdirSync(target, { recursive: true });
  const { handlers } = loadIpc({ openResult: { canceled: false, filePaths: [target] } });
  const pickR = await handlers.get('config:pickFolder')({}, { purpose: 'config-output' });
  const r = await handlers.get('config:set')({}, {
    cfg: { api_key: 'sk-new', output_dir: target, region: 'cn', theme: 'light', styles: [] },
    grants: { output_dir: pickR.grantId },
  });
  assert.equal(r.ok, true);
  // SEC-001: config:set returns a public DTO (no raw api_key).
  assert.equal(r.config.hasApiKey, true);
  assert.equal(r.config.output_dir, target);
  // 'cn' is preserved; anything else (e.g. 'us') is normalised to
  // 'global' by the existing sanitize() in main/models/ConfigSchema.js.
  assert.equal(r.config.region, 'cn');
});

// R1.2a.Q: payload shape defensive checks. The renderer MUST send a
// plain object. Primitives and arrays at the TOP LEVEL are rejected.
// Wrapped-shape payloads with an invalid cfg (non-object or array)
// are also REJECTED (R2.3.2 Phasenpruefung-of-Phasenpruefung tightening
// — the previous "best-effort" interpretation was a silent hole: a
// `{cfg: []}` payload would have been saved as an empty cfg without
// the renderer noticing). Non-object grants are still tolerated as
// "no grants" (backward-compat for the bare-cfg path).
test('R1.2a.Q: config:set rejects non-object top-level payloads; invalid cfg is rejected (R2.3.2)', async () => {
  const { handlers } = loadIpc({});
  const setCfg = handlers.get('config:set');
  // Top-level primitives: REJECTED.
  for (const bad of [null, undefined, '', 123, 'string', true]) {
    const r = await setCfg({}, bad);
    assert.equal(r.ok, false, 'top-level payload ' + String(bad) + ' must be rejected');
    assert.match(r.error, /Config must be a plain object/i);
  }
  // Top-level array: REJECTED.
  const arr = await setCfg({}, [1, 2, 3]);
  assert.equal(arr.ok, false, 'array payload must be rejected');
  // R2.3.2 tightening: a wrapped shape with an array cfg is
  // REJECTED (not best-effort) — the payload is malformed and the
  // renderer must not silently no-op a save. This closes the
  // R2.3.2 E1d / E1e adversarial gap.
  const arrCfg = await setCfg({}, { cfg: [1, 2, 3], grants: { output_dir: 'x' } });
  assert.equal(arrCfg.ok, false, 'array cfg inside wrapped payload must be REJECTED (R2.3.2)');
  assert.match(arrCfg.error || '', /Config must be a plain object/i);
  // R2.3.2 tightening: a wrapped shape with a non-object cfg
  // (number, string, etc.) is also REJECTED.
  const numCfg = await setCfg({}, { cfg: 5, grants: { output_dir: 'x' } });
  assert.equal(numCfg.ok, false, 'number cfg inside wrapped payload must be REJECTED (R2.3.2)');
  assert.match(numCfg.error || '', /Config must be a plain object/i);
  // Non-object grants (string, number, array): treated as no grants.
  for (const badGrants of ['not-an-object', 123, [1, 2, 3]]) {
    const r = await setCfg({}, { cfg: { api_key: 'sk-q' }, grants: badGrants });
    assert.equal(r.ok, true, 'non-object grants (' + String(badGrants) + ') must be tolerated as no grants');
    // SEC-001: config:set returns a public DTO (no raw api_key).
    assert.equal(r.config.hasApiKey, true);
  }
});

// R1.2a.R: config:set with an unknown origin on the grant is
// rejected with a clear purpose-mismatch error.
test('R1.2a.R: config:set rejects an output_dir grant with an unknown origin (not config-output)', async () => {
  const target = path.join(TMP, 'unknown-origin');
  fs.mkdirSync(target, { recursive: true });
  const { handlers } = loadIpc({});
  // Mint a grant with origin 'app-output' (NOT config-output).
  const { defaultService } = require(PATH_GRANT);
  const mint = defaultService.mintDirectoryGrant({
    origin: 'app-output', purpose: 'not a config grant',
    path: target, capabilities: ['write'], coversRoot: true,
  });
  assert.equal(mint.ok, true);
  const r = await handlers.get('config:set')({}, {
    cfg: { output_dir: target },
    grants: { output_dir: mint.grantId },
  });
  assert.equal(r.ok, false, 'an app-output grant must NOT authorise an output_dir change');
  assert.match(r.error, /config-output|origin/i);
});
