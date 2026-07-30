// tests/unit/main/ipc/registerMmxIpc.r15b1.test.js
// ============================================================================
// R1.5b.1 — Mmx IPC grant migration (S1 §6 R1.5b).
//
// Invarianten (S1 §3 + §4 + §6 R1.5b):
//   • `mmx:run` and `mmx:run:job` require a `grantId` for any path the
//     renderer's `args` (or `payload.cwd`) would touch.
//   • The grant must be a `directory` or `directory-root` grant that
//     covers every path the args carry:
//       - file paths (--out / --download / -o): grant must authorise
//         'write' on the file (the parent dir is inside the grant's
//         scope).
//       - directory paths (--out-dir): grant must authorise 'write'
//         on the directory itself. A default `directory` grant does
//         NOT cover the root (S1 §2.5); the renderer must mint a
//         `directory-root` grant (coversRoot:true) for the --out-dir
//         use case.
//       - payload.cwd: grant must authorise 'mkdir' on the cwd.
//   • Args with no path flag AND no cwd still succeed without a
//     grant (e.g. `mmx quota`).
//   • One missing / unknown / revoked grant fails the call closed
//     (code -1, same envelope as the legacy "outside the allowed
//     directories" error so the renderer's existing error surface
//     is unchanged).
//   • mmx:voices / mmx:quota / mmx:profile / mmx:cancel /
//     mmx:authStatus / mmx:diagnose are unchanged (no user-supplied
//     paths).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MMX_IPC = path.join(ROOT, 'main', 'ipc', 'registerMmxIpc.js');
const MMX_PATH = path.join(ROOT, 'src', 'mmx.js');
const MMX_APIKEY_SYNC_PATH = path.join(ROOT, 'src', 'mmxApiKeySync.js');
const CONFIG_PATH = path.join(ROOT, 'src', 'config.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
const GRANT_AUTHORIZER = path.join(ROOT, 'main', 'ipc', 'grantAuthorizer.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const STATE_PATH = path.join(ROOT, 'src', 'state.js');
const VOICES_CACHE = path.join(ROOT, 'main', 'services', 'VoicesCacheService.js');
const MMX_ALLOWLIST = path.join(ROOT, 'main', 'models', 'MmxSubcommandAllowlist.js');
const MMX_CAPABILITY = path.join(ROOT, 'src', 'mmxCapability.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15b1-'));
process.env.MINIMAX_CONFIG_DIR = ROOT;

// P4.1 (DB-H-002/008): the IPC now validates every --out/--download/-o
// artifact after runMmx resolves (existence + size + magic bytes). The
// runMmx mock doesn't write files, so pre-create plausible JPEG artifacts
// for the success-path tests (>= 1 KB, JPEG magic).
function writeFakeJpeg(p) {
  const buf = Buffer.alloc(2048, 0);
  buf[0] = 0xFF; buf[1] = 0xD8; buf[2] = 0xFF;
  fs.writeFileSync(p, buf);
}
for (const n of ['cat.jpg', 'a.jpg', 'b.jpg']) writeFakeJpeg(path.join(TMP, n));

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---- Helper: build the mocked module graph + load the IPC fresh. ----
function loadIpc() {
  for (const p of [MMX_IPC, MMX_PATH, MMX_APIKEY_SYNC_PATH, CONFIG_PATH, PATH_GRANT, GRANT_AUTHORIZER, PATH_SECURITY, STATE_PATH, VOICES_CACHE, MMX_ALLOWLIST, MMX_CAPABILITY]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  // Reset the defaultService singleton.
  try {
    const { defaultService } = require(PATH_GRANT);
    defaultService.destroy();
  } catch (_) {}

  const handlers = new Map();
  const calls = { runMmx: [], grantAuthorize: [] };

  // Mock electron with the IPC handler bag.
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      app: { getPath: () => path.join(ROOT, 'fake-userData') },
    },
  };

  // Mock src/mmx.js with a thin runMmx recorder.
  require.cache[require.resolve(MMX_PATH)] = {
    exports: {
      runMmx: async (opts) => {
        calls.runMmx.push(opts);
        return {
          ok: true, code: 0,
          stdout: '{"saved":["a.jpg"]}',
          stderr: '',
          parsed: { saved: ['a.jpg'] },
          command: 'mmx-mock',
          argv: opts.args || [],
        };
      },
      cancelAll: () => {},
      cancelByJobId: () => {},
      cancelOne: () => {},
      resolve: () => ({ command: 'mmx-mock', prefix: [] }),
      probeMmxVersion: () => '1.0.16',
      SUPPORTED_MMX: { min: '1.0.16' },
      compareSemver: () => 0,
    },
  };

  // Mock src/config.js with a known API key + an output dir.
  require.cache[require.resolve(CONFIG_PATH)] = {
    exports: {
      read: () => ({ api_key: 'test-key', region: 'cn' }),
      effectiveOutputDir: () => TMP,
    },
  };

  // Mock src/mmxApiKeySync.js
  require.cache[require.resolve(MMX_APIKEY_SYNC_PATH)] = {
    exports: { syncApiKeyToMmxCliConfig: () => true },
  };

  // Mock src/state.js (no session-only flag).
  require.cache[require.resolve(STATE_PATH)] = {
    exports: { read: () => ({ apiKeyNoSave: false }) },
  };

  // Mock PathSecurityService (legacy isPathUnderAny / isParentUnderAny
  // — R1.5b.1 removed the dependency on these in the mutating handlers,
  // but mmx:authStatus / mmx:diagnose still touch the legacy gate).
  require.cache[require.resolve(PATH_SECURITY)] = {
    exports: {
      getAllowedRoots: () => [TMP],
      isPathUnderAny: () => true,
      isParentUnderAny: () => true,
      addTrusted: () => 0,
    },
  };

  // Mock VoicesCacheService.
  require.cache[require.resolve(VOICES_CACHE)] = {
    exports: { get: async () => [] },
  };

  // R7.2: Mock mmxCapability (no real CLI probes in tests).
  require.cache[require.resolve(MMX_CAPABILITY)] = {
    exports: { getSnapshot: () => null, invalidate: () => {} },
  };

  // Pre-populate the PathGrantService cache AFTER the cache clear
  // above (see R1.5a.6 fix: the lazy require in grantAuthorizer runs
  // at handler-call time, so the mock must be in require.cache then).
  // The defaultService mock records every authorize() call so we can
  // assert which paths the handler authorises.
  const defaultServiceMock = {
    authorize: (grantId, spec) => {
      calls.grantAuthorize.push({ grantId, spec });
      if (!grantId) return { ok: false, error: 'grantId required' };
      if (grantId === 'unknown') return { ok: false, error: 'grant not found' };
      if (grantId === 'revoked') return { ok: false, error: 'grant revoked' };
      // Real-path-mock: return ok if the grant is for the file
      // path (file grant) or the path is under the directory root.
      // For test purposes we accept any non-empty path.
      if (!spec || typeof spec.path !== 'string' || !spec.path) {
        return { ok: false, error: 'path required' };
      }
      return { ok: true, canonicalPath: spec.path };
    },
    mintDirectoryGrant: ({ path: p, capabilities, coversRoot }) => ({
      ok: true,
      grantId: 'mock-dir-grant-' + (p || '').replace(/[^a-zA-Z0-9]/g, '_'),
      grant: { kind: coversRoot ? 'directory-root' : 'directory', path: p, capabilities: capabilities || ['read', 'write'] },
    }),
    mintFileGrant: ({ path: p, capabilities }) => ({
      ok: true,
      grantId: 'mock-file-grant-' + (p || '').replace(/[^a-zA-Z0-9]/g, '_'),
      grant: { kind: 'file', path: p, capabilities: capabilities || ['read', 'write'] },
    }),
    revoke: () => ({ ok: true }),
    destroy: () => 0,
  };
  require.cache[require.resolve(PATH_GRANT)] = {
    exports: { defaultService: defaultServiceMock },
  };

  // Now load the IPC.
  require(MMX_IPC).register({ getMainWindow: () => null, appRoot: ROOT });
  return { handlers, calls, defaultServiceMock, TMP };
}

function assertCodeIsMinusOne(r, label) {
  assert.equal(r.code, -1, `${label}: must return code -1, got ${r.code}`);
  assert.match(r.stderr, /grant|authoris|outside|invalid/i, `${label}: stderr must explain why (got: ${r.stderr})`);
}

// ===========================================================================
// mmx:run
// ===========================================================================

test('R1.5b.1: mmx:run rejects when args contain a path flag and no grantId is supplied', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('mmx:run')(null,
    ['image', 'generate', '--prompt', 'a cat', '--out', path.join(TMP, 'cat.jpg')]);
  assertCodeIsMinusOne(r, 'mmx:run no-grant');
});

test('R1.5b.1: mmx:run rejects when args contain --out-dir and no grantId is supplied', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('mmx:run')(null,
    ['image', 'generate', '--prompt', 'a cat', '--out-dir', TMP]);
  assertCodeIsMinusOne(r, 'mmx:run --out-dir no-grant');
});

test('R1.5b.1: mmx:run succeeds with a valid grantId + valid --out path', async () => {
  const { handlers, calls } = loadIpc();
  const r = await handlers.get('mmx:run')(null,
    ['image', 'generate', '--prompt', 'a cat', '--out', path.join(TMP, 'cat.jpg')],
    'mock-file-grant-' + path.join(TMP, 'cat.jpg').replace(/[^a-zA-Z0-9]/g, '_'));
  assert.equal(r.code, 0, `expected code 0, got ${r.code} (stderr: ${r.stderr})`);
  assert.equal(calls.runMmx.length, 1, 'runMmx must have been called exactly once');
  assert.equal(calls.grantAuthorize.length, 1, 'one grant.authorize call (for the --out file)');
  assert.equal(calls.grantAuthorize[0].spec.operation, 'write');
  assert.equal(calls.grantAuthorize[0].spec.path, path.join(TMP, 'cat.jpg'));
});

test('R1.5b.1: mmx:run succeeds with --out=value (single-token form)', async () => {
  const { handlers, calls } = loadIpc();
  const outPath = path.join(TMP, 'cat.jpg');
  const r = await handlers.get('mmx:run')(null,
    ['image', 'generate', '--prompt', 'a cat', '--out=' + outPath],
    'mock-file-grant-' + outPath.replace(/[^a-zA-Z0-9]/g, '_'));
  assert.equal(r.code, 0, `expected code 0, got ${r.code} (stderr: ${r.stderr})`);
  assert.equal(calls.runMmx.length, 1);
  assert.equal(calls.grantAuthorize[0].spec.path, outPath);
});

test('R1.5b.1: mmx:run authorises every --out + --download path independently', async () => {
  const { handlers, calls } = loadIpc();
  const outA = path.join(TMP, 'a.jpg');
  const outB = path.join(TMP, 'b.jpg');
  const r = await handlers.get('mmx:run')(null,
    ['image', 'generate', '--prompt', 'cat', '--out', outA, '--download', outB],
    'mock-grant-id');
  assert.equal(r.code, 0, `expected code 0, got ${r.code} (stderr: ${r.stderr})`);
  assert.equal(calls.grantAuthorize.length, 2, 'one authorize per path flag');
  assert.deepEqual(
    calls.grantAuthorize.map((c) => c.spec.path).sort(),
    [outA, outB].sort(),
  );
});

test('R1.5b.1: mmx:run rejects when an unknown grantId is supplied (with a path flag)', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('mmx:run')(null,
    ['image', 'generate', '--prompt', 'a cat', '--out', path.join(TMP, 'cat.jpg')],
    'unknown');
  assertCodeIsMinusOne(r, 'mmx:run unknown-grant');
  assert.match(r.stderr, /not authorised|not found/i);
});

test('R1.5b.1: mmx:run succeeds without a grantId when args have no path flags (e.g. "mmx quota")', async () => {
  const { handlers, calls } = loadIpc();
  const r = await handlers.get('mmx:run')(null, ['quota']);
  assert.equal(r.code, 0, `expected code 0, got ${r.code} (stderr: ${r.stderr})`);
  assert.equal(calls.runMmx.length, 1);
  assert.equal(calls.grantAuthorize.length, 0, 'no grant call when there are no path flags');
});

// ===========================================================================
// mmx:run:job
// ===========================================================================

test('R1.5b.1: mmx:run:job rejects when args contain a path flag and no grantId is supplied', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('mmx:run:job')(null, {
    args: ['image', 'generate', '--prompt', 'a cat', '--out-dir', TMP],
    jobId: 'j1',
  });
  assertCodeIsMinusOne(r, 'mmx:run:job no-grant');
});

test('R1.5b.1: mmx:run:job rejects when payload.cwd is supplied without a grantId', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('mmx:run:job')(null, {
    args: ['image', 'generate', '--prompt', 'a cat', '--out-dir', TMP],
    jobId: 'j1',
    cwd: TMP,
  });
  assertCodeIsMinusOne(r, 'mmx:run:job no-grant-cwd');
});

test('R1.5b.1: mmx:run:job succeeds with a valid grantId + valid --out-dir + valid cwd', async () => {
  const { handlers, calls } = loadIpc();
  const r = await handlers.get('mmx:run:job')(null, {
    args: ['image', 'generate', '--prompt', 'a cat', '--out-dir', TMP],
    jobId: 'j2',
    cwd: TMP,
  }, 'mock-grant-id');
  assert.equal(r.code, 0, `expected code 0, got ${r.code} (stderr: ${r.stderr})`);
  assert.equal(calls.runMmx.length, 1);
  // grant.authorize was called for: 1 path flag (--out-dir TMP) + 1 cwd (TMP) = 2 calls.
  // The cwd is authorised with the 'mkdir' operation.
  assert.equal(calls.grantAuthorize.length, 2);
  const writeCall = calls.grantAuthorize.find((c) => c.spec.operation === 'write');
  const mkdirCall = calls.grantAuthorize.find((c) => c.spec.operation === 'mkdir');
  assert.ok(writeCall, 'must have a write-call for the --out-dir path');
  assert.equal(writeCall.spec.path, TMP);
  assert.ok(mkdirCall, 'must have a mkdir-call for the cwd');
  assert.equal(mkdirCall.spec.path, TMP);
});

test('R1.5b.1: mmx:run:job rejects when payload.cwd is outside the grant', async () => {
  const { handlers, defaultServiceMock } = loadIpc();
  // Make the mock reject any path under D:\evil (covers both
  // --out-dir and cwd, so the handler bails on the FIRST one it
  // authorises; we want it to bail on the cwd so we use a cwd
  // that's an exact sibling of an evil dir but not a descendant
  // of TMP).
  const origAuthz = defaultServiceMock.authorize;
  defaultServiceMock.authorize = (grantId, spec) => {
    if (spec && typeof spec.path === 'string' && spec.path.startsWith('D:\\evil')) {
      return { ok: false, error: 'outside grant scope' };
    }
    return origAuthz(grantId, spec);
  };
  const r = await handlers.get('mmx:run:job')(null, {
    args: ['image', 'generate', '--prompt', 'a cat', '--out', path.join(TMP, 'cat.jpg')],
    jobId: 'j3',
    cwd: 'D:\\evil\\sub',
  }, 'mock-grant-id');
  assertCodeIsMinusOne(r, 'mmx:run:job cwd-outside-grant');
  assert.match(r.stderr, /cwd/i);
});

test('R1.5b.1: mmx:run:job succeeds with a valid grantId + valid --out file (no cwd)', async () => {
  const { handlers, calls } = loadIpc();
  const outPath = path.join(TMP, 'cat.jpg');
  const r = await handlers.get('mmx:run:job')(null, {
    args: ['image', 'generate', '--prompt', 'a cat', '--out', outPath],
    jobId: 'j4',
  }, 'mock-file-grant-' + outPath.replace(/[^a-zA-Z0-9]/g, '_'));
  assert.equal(r.code, 0, `expected code 0, got ${r.code} (stderr: ${r.stderr})`);
  assert.equal(calls.runMmx.length, 1);
  assert.equal(calls.grantAuthorize.length, 1);
  assert.equal(calls.grantAuthorize[0].spec.operation, 'write');
});

test('R1.5b.1: mmx:run:job rejects when args contain --out=evil and the grant does not authorise evil', async () => {
  const { handlers, defaultServiceMock } = loadIpc();
  // The mock defaultService.authorize rejects paths starting with "D:\\evil".
  const origAuthz = defaultServiceMock.authorize;
  defaultServiceMock.authorize = (grantId, spec) => {
    if (spec && typeof spec.path === 'string' && spec.path.startsWith('D:\\evil')) {
      return { ok: false, error: 'outside grant scope' };
    }
    return origAuthz(grantId, spec);
  };
  const r = await handlers.get('mmx:run:job')(null, {
    args: ['image', 'generate', '--prompt', 'a cat', '--out', 'D:\\evil\\x.jpg'],
    jobId: 'j5',
  }, 'mock-grant-id');
  assertCodeIsMinusOne(r, 'mmx:run:job out-evil');
  assert.match(r.stderr, /--out/i);
});

test('R1.5b.1: mmx:run:job succeeds without a grantId when args have no path flags AND no cwd', async () => {
  const { handlers, calls } = loadIpc();
  const r = await handlers.get('mmx:run:job')(null, {
    args: ['quota'],
    jobId: 'j6',
  });
  assert.equal(r.code, 0, `expected code 0, got ${r.code} (stderr: ${r.stderr})`);
  assert.equal(calls.runMmx.length, 1);
  assert.equal(calls.grantAuthorize.length, 0);
});

// ===========================================================================
// P4.1 (DB-H-002/008): output validation — verification gate "CLI ok:true
// with missing file reports error".
// ===========================================================================

test('P4.1: mmx:run:job flips ok:true to code -1 when the --out artifact was never written', async () => {
  const { handlers, calls } = loadIpc();
  const missing = path.join(TMP, 'never-written.jpg');
  const r = await handlers.get('mmx:run:job')(null, {
    args: ['image', 'generate', '--prompt', 'a cat', '--out', missing],
    jobId: 'j7',
  }, 'mock-file-grant-' + missing.replace(/[^a-zA-Z0-9]/g, '_'));
  assert.equal(calls.runMmx.length, 1, 'runMmx ran (grant was fine)');
  assert.equal(r.ok, false, 'ok:true with a missing artifact must be rejected');
  assert.equal(r.code, -1);
  assert.match(r.stderr, /output failed validation/i);
  assert.match(r.stderr, /not created/i);
});

test('P4.1: mmx:run flips ok:true to code -1 when the --out artifact is truncated (< 1 KB)', async () => {
  const { handlers } = loadIpc();
  const tiny = path.join(TMP, 'tiny.jpg');
  fs.writeFileSync(tiny, Buffer.from([0xFF, 0xD8, 0xFF, 0x00]));
  const r = await handlers.get('mmx:run')(null,
    ['image', 'generate', '--prompt', 'a cat', '--out', tiny],
    'mock-file-grant-' + tiny.replace(/[^a-zA-Z0-9]/g, '_'));
  assert.equal(r.ok, false);
  assert.equal(r.code, -1);
  assert.match(r.stderr, /output failed validation/i);
  assert.ok(!fs.existsSync(tiny), 'the truncated artifact must be deleted');
});
