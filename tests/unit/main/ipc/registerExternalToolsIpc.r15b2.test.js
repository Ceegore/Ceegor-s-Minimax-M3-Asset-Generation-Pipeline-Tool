// tests/unit/main/ipc/registerExternalToolsIpc.r15b2.test.js
// ============================================================================
// R1.5b.2 — ExternalTools IPC grant migration (S1 §6 R1.5b).
//
// Invarianten (S1 §3 + §4 + §6 R1.5b):
//   • `externalTools:run` requires a `grantId` for the file paths in
//     `payload.paths`. The grant must authorise 'read' on every
//     file the renderer is handing off to the spawned tool.
//   • Without a grantId, the call fails closed (the renderer
//     forgot to mint a grant for the file paths).
//   • A grant that doesn't authorise any of the paths also fails
//     closed (per-path error message names the offending file).
//   • `externalTools:probe` is unchanged (no file paths in the
//     payload — just exe metadata; no grant required).
//   • The exe validation (existence + safe shape) is still
//     tool-config-derived (the renderer can't influence the
//     exe path; only the NAME is renderer-supplied).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const EXT_TOOLS_IPC = path.join(ROOT, 'main', 'ipc', 'registerExternalToolsIpc.js');
const CFG_PATH = path.join(ROOT, 'src', 'config.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const PATH_UTILS = path.join(ROOT, 'src', 'pathUtils.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15b2-'));

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---- Helper: build the mocked module graph + load the IPC fresh. ----
function loadIpc() {
  for (const p of [EXT_TOOLS_IPC, CFG_PATH, PATH_GRANT, PATH_SECURITY, PATH_UTILS]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  // Reset the defaultService singleton.
  try {
    const { defaultService } = require(PATH_GRANT);
    defaultService.destroy();
  } catch (_) {}

  const handlers = new Map();
  const calls = { spawn: [] };

  // Mock electron with the IPC handler bag.
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      shell: { showItemInFolder: () => undefined, openPath: async () => '' },
      app: { getPath: () => path.join(TMP, 'fake-userData') },
    },
  };

  // Mock child_process so the spawn doesn't actually launch a
  // process. We record the call args so the test can assert.
  const fakePid = 12345;
  require.cache[require.resolve('child_process')] = {
    exports: {
      spawn: (cmd, argv, opts) => {
        calls.spawn.push({ cmd, argv, opts });
        return {
          pid: fakePid,
          unref: () => undefined,
        };
      },
      spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    },
  };

  // Mock src/pathUtils (validateExePath calls nothing here, but
  // isPathUnderAny is no longer used by runExternalTool — kept
  // for legacy callers).
  require.cache[require.resolve(PATH_UTILS)] = {
    exports: {
      isPathUnderAny: () => true,
      isParentUnderAny: () => true,
      normalize: (p) => (typeof p === 'string' ? p : null),
    },
  };

  // Mock PathSecurityService.
  require.cache[require.resolve(PATH_SECURITY)] = {
    exports: {
      getAllowedRoots: () => [TMP],
      isPathUnderAny: () => true,
      isParentUnderAny: () => true,
      addTrusted: () => 0,
    },
  };

  // Pre-populate the PathGrantService cache AFTER the cache
  // clear (R1.5a.6 fix). The mock's authorize accepts any path
  // under TMP (or any path, for the negative tests we override).
  const defaultServiceMock = {
    authorize: (grantId, spec) => {
      calls.grantAuthorize = calls.grantAuthorize || [];
      calls.grantAuthorize.push({ grantId, spec });
      if (!grantId) return { ok: false, error: 'grantId required' };
      if (grantId === 'unknown') return { ok: false, error: 'grant not found' };
      if (grantId === 'revoked') return { ok: false, error: 'grant revoked' };
      if (!spec || typeof spec.path !== 'string') {
        return { ok: false, error: 'path required' };
      }
      return { ok: true, canonicalPath: spec.path };
    },
    mintDirectoryGrant: ({ path: p }) => ({
      ok: true,
      grantId: 'mock-dir-grant-' + (p || '').replace(/[^a-zA-Z0-9]/g, '_'),
      grant: { kind: 'directory', path: p },
    }),
    mintFileGrant: ({ path: p }) => ({
      ok: true,
      grantId: 'mock-file-grant-' + (p || '').replace(/[^a-zA-Z0-9]/g, '_'),
      grant: { kind: 'file', path: p },
    }),
    revoke: () => ({ ok: true }),
    destroy: () => 0,
  };
  require.cache[require.resolve(PATH_GRANT)] = {
    exports: { defaultService: defaultServiceMock },
  };

  // Now load the IPC.
  require(EXT_TOOLS_IPC).register();
  return { handlers, calls, defaultServiceMock, TMP };
}

// Helper: mint a real .exe file in TMP for the test.
function makeFakeExe() {
  const exe = path.join(TMP, 'fake-tool.exe');
  fs.writeFileSync(exe, 'MZ');
  return exe;
}

// Helper: write a fake file in TMP for the test.
function makeFakeFile(name = 'a.txt') {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, 'hello');
  return f;
}

// ===========================================================================
// externalTools:run — grant contract
// ===========================================================================

test('R1.5b.2: externalTools:run rejects when no grantId is supplied (with valid file paths)', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('externalTools:run')(null, {
    name: 'Tool', paths: [makeFakeFile('a.txt')],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /grantId is required/i);
});

test('R1.5b.2: externalTools:run rejects when grantId is an empty string', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('externalTools:run')(null, {
    name: 'Tool', paths: [makeFakeFile('a.txt')],
  }, '');
  assert.equal(r.ok, false);
  assert.match(r.error, /grantId is required/i);
});

test('R1.5b.2: externalTools:run rejects when grantId is non-string', async () => {
  const { handlers } = loadIpc();
  const r1 = await handlers.get('externalTools:run')(null, { name: 'Tool', paths: [makeFakeFile('a.txt')] }, null);
  const r2 = await handlers.get('externalTools:run')(null, { name: 'Tool', paths: [makeFakeFile('a.txt')] }, 123);
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
});

test('R1.5b.2: externalTools:run succeeds with a valid grantId + valid file path', async () => {
  const { handlers, calls, defaultServiceMock } = loadIpc();
  // Override the tool lookup: the real runExternalTool reads from
  // cfgMod.read which returns the default config (no tools). We
  // monkey-patch cfgMod.read after the IPC is loaded — but the
  // IPC closure captured the real cfgMod. Instead, pre-populate
  // the config with a tool that uses a fake .exe in TMP.
  const exe = makeFakeExe();
  const cfgMod = require(CFG_PATH);
  const origRead = cfgMod.read;
  cfgMod.read = () => ({
    api_key: '',
    external_tools: [{ name: 'Tool', exe, args: '' }],
  });
  // Re-call loadIpc to pick up the new config — actually no,
  // loadIpc already registered the handler. Instead, override
  // cfgMod.read and call the handler; the handler reads cfgMod.read
  // at call time (the require is module-level, but .read is the
  // function reference).
  const fakeFile = makeFakeFile('success.txt');
  const grantId = 'mock-file-grant-' + fakeFile.replace(/[^a-zA-Z0-9]/g, '_');
  const r = await handlers.get('externalTools:run')(null, { name: 'Tool', paths: [fakeFile] }, grantId);
  cfgMod.read = origRead;
  assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
  assert.equal(r.pid, 12345, 'pid should be the fake child pid from the mock');
  assert.equal(calls.spawn.length, 1, 'spawn must be called exactly once');
  // The argv must include the file path (last token per the
  // buildArgvForTool convention).
  assert.ok(calls.spawn[0].argv.includes(fakeFile),
    `argv should include the file path. got: ${JSON.stringify(calls.spawn[0].argv)}`);
  // The grant was authorised once for the file path.
  assert.ok(calls.grantAuthorize, 'grantAuthorize must have been called');
  const authForFile = calls.grantAuthorize.find((c) => c.spec.path === fakeFile);
  assert.ok(authForFile, `grant must have been called for ${fakeFile}`);
  assert.equal(authForFile.spec.operation, 'read');
});

test('R1.5b.2: externalTools:run rejects when grant does not authorise a file path', async () => {
  const { handlers, defaultServiceMock } = loadIpc();
  // Make the mock reject any path starting with C:\evil.
  const origAuthz = defaultServiceMock.authorize;
  defaultServiceMock.authorize = (grantId, spec) => {
    if (spec && typeof spec.path === 'string' && spec.path.startsWith('C:\\evil')) {
      return { ok: false, error: 'outside grant scope' };
    }
    return origAuthz(grantId, spec);
  };
  const r = await handlers.get('externalTools:run')(null, {
    name: 'Tool', paths: ['C:\\evil\\bad.dll'],
  }, 'mock-grant-id');
  assert.equal(r.ok, false);
  assert.match(r.error, /not authorised/i);
  assert.match(r.error, /C:\\evil/);
});

test('R1.5b.2: externalTools:run authorises every file path independently (one bad = call fails)', async () => {
  const { handlers, defaultServiceMock } = loadIpc();
  const origAuthz = defaultServiceMock.authorize;
  defaultServiceMock.authorize = (grantId, spec) => {
    if (spec && typeof spec.path === 'string' && spec.path.includes('bad')) {
      return { ok: false, error: 'outside grant scope' };
    }
    return origAuthz(grantId, spec);
  };
  const r = await handlers.get('externalTools:run')(null, {
    name: 'Tool', paths: [makeFakeFile('a.txt'), makeFakeFile('bad.txt')],
  }, 'mock-grant-id');
  assert.equal(r.ok, false);
  assert.match(r.error, /not authorised/i);
  assert.match(r.error, /bad\.txt/);
});

// ===========================================================================
// gewv2 GEW-012 — multi-folder selections: an ARRAY of grantIds, each path
// authorised by ANY ONE of them (not required to share a single grant).
// ===========================================================================

test('GEW-012: externalTools:run accepts an ARRAY of grantIds — a path authorised by ANY one of them passes', async () => {
  const { handlers, defaultServiceMock } = loadIpc();
  const exe = makeFakeExe();
  const cfgMod = require(CFG_PATH);
  const origRead = cfgMod.read;
  cfgMod.read = () => ({ api_key: '', external_tools: [{ name: 'Tool', exe, args: '' }] });
  const origAuthz = defaultServiceMock.authorize;
  // grant-A only authorises paths under \A\; grant-B only authorises \B\.
  defaultServiceMock.authorize = (grantId, spec) => {
    const p = spec && spec.path;
    if (grantId === 'grant-A') return (p && p.includes('\\A\\')) ? { ok: true, canonicalPath: p } : { ok: false, error: 'outside grant-A' };
    if (grantId === 'grant-B') return (p && p.includes('\\B\\')) ? { ok: true, canonicalPath: p } : { ok: false, error: 'outside grant-B' };
    return origAuthz(grantId, spec);
  };
  // The exact GEW-012 scenario: [C:\A\x, D:\B\y, C:\A\z] — a selection whose
  // MIDDLE path lies in a different folder than the first/last. A single
  // common-ancestor grant would miss the D:\B\ file; two grants (one per
  // distinct directory) cover all three.
  const r = await handlers.get('externalTools:run')(null, {
    name: 'Tool',
    paths: ['C:\\A\\x.txt', 'D:\\B\\y.txt', 'C:\\A\\z.txt'],
  }, ['grant-A', 'grant-B']);
  cfgMod.read = origRead;
  assert.equal(r.ok, true, `expected ok=true with a 2-grant array covering both folders, got: ${JSON.stringify(r)}`);
});

test('GEW-012: externalTools:run still fails closed when a path is covered by NEITHER grant in the array', async () => {
  const { handlers, defaultServiceMock } = loadIpc();
  const origAuthz = defaultServiceMock.authorize;
  defaultServiceMock.authorize = (grantId, spec) => {
    const p = spec && spec.path;
    if (grantId === 'grant-A') return (p && p.includes('\\A\\')) ? { ok: true, canonicalPath: p } : { ok: false, error: 'outside grant-A' };
    if (grantId === 'grant-B') return (p && p.includes('\\B\\')) ? { ok: true, canonicalPath: p } : { ok: false, error: 'outside grant-B' };
    return origAuthz(grantId, spec);
  };
  const r = await handlers.get('externalTools:run')(null, {
    name: 'Tool',
    paths: ['C:\\A\\x.txt', 'E:\\untrusted\\evil.dll'],
  }, ['grant-A', 'grant-B']);
  assert.equal(r.ok, false, 'a path outside every supplied grant must still hard-reject (no bypass)');
  assert.match(r.error, /not authorised/i);
  assert.match(r.error, /evil\.dll/);
});

test('R1.5b.2: externalTools:run rejects when grantId is unknown', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('externalTools:run')(null, {
    name: 'Tool', paths: [makeFakeFile('a.txt')],
  }, 'unknown');
  assert.equal(r.ok, false);
  assert.match(r.error, /not authorised|not found/i);
});

test('R1.5b.2: externalTools:run rejects when grantId is revoked', async () => {
  const { handlers, defaultServiceMock } = loadIpc();
  const origAuthz = defaultServiceMock.authorize;
  defaultServiceMock.authorize = (grantId, spec) => {
    if (grantId === 'revoked') return { ok: false, error: 'grant revoked' };
    return origAuthz(grantId, spec);
  };
  const r = await handlers.get('externalTools:run')(null, {
    name: 'Tool', paths: [makeFakeFile('a.txt')],
  }, 'revoked');
  assert.equal(r.ok, false);
  assert.match(r.error, /not authorised|revoked/i);
});

test('R1.5b.2: externalTools:run returns the legacy "every path must be a non-empty string" error for a non-string path', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('externalTools:run')(null, {
    name: 'Tool', paths: [null],
  }, 'mock-grant-id');
  assert.equal(r.ok, false);
  assert.match(r.error, /every file path must be a non-empty string/i);
});

test('R1.5b.2: externalTools:run returns error when paths is empty', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('externalTools:run')(null, {
    name: 'Tool', paths: [],
  }, 'mock-grant-id');
  assert.equal(r.ok, false);
  assert.match(r.error, /at least one file path/i);
});

test('R1.5b.2: externalTools:run still fails for an unknown tool name (even with a valid grant)', async () => {
  const { handlers } = loadIpc();
  // The cfg is the default (no external_tools), so any tool name
  // is unknown. The grant check happens FIRST now (R1.5b.2),
  // but with a valid grant + valid file path, the call proceeds
  // to the tool lookup which fails.
  const r = await handlers.get('externalTools:run')(null, {
    name: 'NoSuchTool', paths: [makeFakeFile('a.txt')],
  }, 'mock-grant-id');
  assert.equal(r.ok, false);
  assert.match(r.error, /not configured/i);
});

// ===========================================================================
// externalTools:probe — unchanged (no file paths, no grant required)
// ===========================================================================

test('R1.5b.2: externalTools:probe is unchanged — no grantId required', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('externalTools:probe')(null, { name: 'NoSuchTool' });
  // No grant required; the probe just returns the not-configured error.
  assert.equal(r.ok, false);
  assert.match(r.error, /not configured/i);
});
