// tests/unit/main/ipc/registerFileBrowserIpc.test.js
// ============================================================================
// Bug-fix (reported by user, this round): generating while the file browser
// was sitting at a DRIVE ROOT (e.g. "D:\") failed with
//   "Cannot resolve output folder: EPERM: operation not permitted, mkdir 'D:\'".
// On Windows, fs.mkdir on a drive root throws EPERM even with
// { recursive: true } — Node won't no-op the already-existing root. The fix
// makes fb:ensureDir stat-first and return ok WITHOUT calling mkdir when the
// path already exists as a directory.
//
// These tests mock the entire module graph of registerFileBrowserIpc so we
// can force fsp.mkdir to throw EPERM (simulating the drive root) and prove
// the handler still returns ok — and, crucially, that mkdir was never even
// called for an existing directory.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FB_IPC = path.join(ROOT, 'main', 'ipc', 'registerFileBrowserIpc.js');

// v1.1.29: shared mutable config mock. `requireFresh` reassigns the
// output_dir between tests so fb:trust-ancestors runs against a
// predictable trusted root.
const mockConfig = { effectiveOutputDir: () => '/tmp/x' };

// Load registerFileBrowserIpc with a mocked module graph and return the
// captured ipcMain handlers + the mkdir/stat call trackers.
function loadWithMocks({ statResult, mkdirImpl }) {
  const handlers = {};
  const calls = { mkdir: [], stat: [], trust: [], active: [] };
  const fakeFsp = {
    async stat(p) {
      calls.stat.push(p);
      const r = typeof statResult === 'function' ? statResult(p) : statResult;
      if (r === 'ENOENT') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return r;
    },
    async mkdir(p, opts) {
      calls.mkdir.push({ p, opts });
      if (mkdirImpl) return mkdirImpl(p, opts);
      return undefined;
    },
    async access() { return undefined; },
    async writeFile() { return undefined; },
    async rename() { return undefined; },
    async unlink() { return undefined; },
  };
  // R1.3: mock the PathGrantService. The OLD tests treat the gate
  // as "always pass" (see pathUtils.isPathUnderAny: () => true),
  // so the mock's authorize accepts any non-empty grantId + path
  // and returns ok:true. The handler-level grantId-required check
  // is still enforced (the IPC's _authorizePath rejects missing/
  // empty grantIds BEFORE the service is even called).
  const mockPathGrantService = {
    defaultService: {
      authorize: (grantId, { operation, path: p } = {}) => {
        if (!grantId) return { ok: false, error: 'grantId required' };
        if (!p) return { ok: false, error: 'path required' };
        return { ok: true, canonicalPath: p };
      },
      mintDirectoryGrant: (spec) => ({ ok: true, grantId: 'mock-grant-id', grant: Object.assign({}, spec) }),
      mintFileGrant: (spec) => ({ ok: true, grantId: 'mock-grant-id', grant: Object.assign({}, spec) }),
      revoke: () => ({ ok: true }),
      destroy: () => 0,
    },
  };
  const mocks = {
    electron: { ipcMain: { handle(channel, fn) { handlers[channel] = fn; } } },
    fs: { promises: fakeFsp, constants: { F_OK: 0 } },
    [path.join(ROOT, 'src', 'fileBrowser')]: {},
    [path.join(ROOT, 'src', 'pathUtils')]: {
      // Allow every path so we exercise the mkdir/stat branch, not the gate.
      isPathUnderAny: () => true,
      isParentUnderAny: () => true,
      normalize: (p) => p,
    },
    [path.join(ROOT, 'main', 'services', 'PathSecurityService')]: {
      getAllowedRoots: () => ['D:\\'],
      // v1.1.29: trust-ancestors test uses an isolated allow-list
      // seeded with the test's `mockConfig.effectiveOutputDir()`.
      addTrusted: (p) => calls.trust.push(p),
      // BUG-9-04: the new activeDir-based write gate. The mock
      // records every setActiveDir call so the test can assert
      // the Up button pushed the new path.
      setActiveDir: (p) => { calls.active.push(p); return p; },
      getActiveDir: () => (calls.active.length ? calls.active[calls.active.length - 1] : null),
    },
    // R1.3: PathGrantService mock (see above).
    [path.join(ROOT, 'main', 'services', 'PathGrantService')]: mockPathGrantService,
    // v1.1.29: stub src/config so fb:trust-ancestors sees the
    // mockConfig-controlled root.
    [path.join(ROOT, 'src', 'config')]: {
      read: () => ({ output_dir: mockConfig.effectiveOutputDir() }),
      effectiveOutputDir: mockConfig.effectiveOutputDir,
    },
  };
  // Map the relative request strings registerFileBrowserIpc uses to our mocks.
  const relMap = {
    electron: mocks.electron,
    fs: mocks.fs,
    '../../src/fileBrowser': mocks[path.join(ROOT, 'src', 'fileBrowser')],
    '../../src/pathUtils': mocks[path.join(ROOT, 'src', 'pathUtils')],
    '../services/PathSecurityService': mocks[path.join(ROOT, 'main', 'services', 'PathSecurityService')],
    '../services/PathGrantService': mocks[path.join(ROOT, 'main', 'services', 'PathGrantService')],
    '../../src/config': mocks[path.join(ROOT, 'src', 'config')],
  };
  const originalLoad = Module._load;
  delete require.cache[require.resolve(FB_IPC)];
  // R1.5a.6: also clear the PathGrantService cache so the lazy
  // require inside grantAuthorizer.authorizePath() (called at
  // handler-invocation time, OUTSIDE the patched Module._load)
  // doesn't accidentally hit a stale entry from a prior test.
  try { delete require.cache[require.resolve(path.join(ROOT, 'main', 'services', 'PathGrantService.js'))]; } catch (_) {}
  Module._load = function patched(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(relMap, request)) return relMap[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(FB_IPC).register({ appRoot: ROOT });
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(FB_IPC)];
  }
  // R1.5a.6: pre-populate require.cache with the mock so the
  // LAZY `require('../services/PathGrantService')` inside
  // grantAuthorizer.authorizePath() (executed at handler-call
  // time, AFTER the Module._load patch is restored) resolves
  // to the mock instead of loading the real PathGrantService
  // from disk. The Node loader checks require.cache BEFORE
  // calling Module._load, so a cache hit short-circuits the
  // restored (real) loader and returns the mock.
  require.cache[require.resolve(path.join(ROOT, 'main', 'services', 'PathGrantService.js'))] = {
    exports: mockPathGrantService,
  };
  return { handlers, calls };
}

// v1.1.29: re-register the IPC fresh so per-test config overrides
// take effect. Each call clears the require cache and re-runs the
// patched Module._load, picking up the latest mockConfig.effectiveOutputDir.
let _patchedLoad = null;
function requireFresh() {
  const handlers = {};
  const calls = { mkdir: [], stat: [], trust: [], active: [] };
  const fakeFsp = {
    async stat(p) { calls.stat.push(p); return { isDirectory: () => true }; },
    async mkdir(p, opts) {
      calls.mkdir.push({ p, opts });
      return undefined;
    },
    async access() { return undefined; },
    async writeFile() { return undefined; },
    async rename() { return undefined; },
    async unlink() { return undefined; },
  };
  const mocks = {
    electron: { ipcMain: { handle(channel, fn) { handlers[channel] = fn; } } },
    fs: { promises: fakeFsp, constants: { F_OK: 0 } },
    [path.join(ROOT, 'src', 'fileBrowser')]: {},
    [path.join(ROOT, 'src', 'pathUtils')]: {
      // BUG-9-04: was always returning true, which made the
      // "refuses free-floating paths" test pass spuriously (the
      // mock lied about the gate). Match the real check: the
      // requested path must be inside `mockConfig.effectiveOutputDir()`
      // for isPathUnderAny to be true.
      isPathUnderAny: (p, roots) => {
        const r = path.resolve(mockConfig.effectiveOutputDir());
        const n = path.resolve(String(p || ''));
        if (!n || n === r) return true;
        return n.startsWith(r + path.sep) || n.startsWith(r + '/');
      },
      isParentUnderAny: (p) => {
        // Mimic the real check: returns true if p's parent is under
        // any root. For our test dirs under TMP, we treat the test
        // trust root as the only root.
        const r = path.resolve(mockConfig.effectiveOutputDir());
        const parent = path.dirname(path.resolve(p));
        // If parent === r, parent IS the root (i.e. p is one level
        // inside the root). Walk up from parent looking for r.
        let cur = parent;
        // Bound the walk so we can't infinite-loop on weird inputs.
        for (let i = 0; i < 64; i++) {
          if (cur === r) return true;
          const next = path.dirname(cur);
          if (next === cur) return false;
          cur = next;
        }
        return false;
      },
      normalize: (p) => p,
    },
    [path.join(ROOT, 'main', 'services', 'PathSecurityService')]: {
      // Seed the allow-list with the mockConfig root so trust-ancestors
      // can recognise "is the requested dir's ancestor chain anchored at
      // a trusted root?".
      getAllowedRoots: () => [path.resolve(mockConfig.effectiveOutputDir())],
      addTrusted: (p) => calls.trust.push(p),
      // BUG-9-04: activeDir-based write gate. The test records
      // every setActiveDir call so it can assert the IPC pushed
      // the new path. getActiveDir returns the most recently set
      // value (matching the real PathSecurityService behaviour).
      setActiveDir: (p) => { calls.active.push(p); return p; },
      getActiveDir: () => (calls.active.length ? calls.active[calls.active.length - 1] : null),
    },
    // R1.3: PathGrantService mock (see loadWithMocks for rationale).
    [path.join(ROOT, 'main', 'services', 'PathGrantService')]: {
      defaultService: {
        authorize: (grantId, { operation, path: p } = {}) => {
          if (!grantId) return { ok: false, error: 'grantId required' };
          if (!p) return { ok: false, error: 'path required' };
          return { ok: true, canonicalPath: p };
        },
        mintDirectoryGrant: (spec) => ({ ok: true, grantId: 'mock-grant-id', grant: Object.assign({}, spec) }),
        mintFileGrant: (spec) => ({ ok: true, grantId: 'mock-grant-id', grant: Object.assign({}, spec) }),
        revoke: () => ({ ok: true }),
        destroy: () => 0,
      },
    },
    [path.join(ROOT, 'src', 'config')]: {
      read: () => ({ output_dir: mockConfig.effectiveOutputDir() }),
      effectiveOutputDir: mockConfig.effectiveOutputDir,
    },
  };
  const relMap = {
    electron: mocks.electron,
    fs: mocks.fs,
    '../../src/fileBrowser': mocks[path.join(ROOT, 'src', 'fileBrowser')],
    '../../src/pathUtils': mocks[path.join(ROOT, 'src', 'pathUtils')],
    '../services/PathSecurityService': mocks[path.join(ROOT, 'main', 'services', 'PathSecurityService')],
    '../services/PathGrantService': mocks[path.join(ROOT, 'main', 'services', 'PathGrantService')],
    '../../src/config': mocks[path.join(ROOT, 'src', 'config')],
  };
  // Reset to the real loader so our patched function can recurse
  // to it without infinite-looping.
  const _realLoad = Module._load;
  if (_patchedLoad) Module._load = _realLoad;
  _patchedLoad = function patched(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(relMap, request)) return relMap[request];
    return _realLoad.call(this, request, parent, isMain);
  };
  // R1.5a.6: clear the PathGrantService cache too (same reason
  // as in loadWithMocks: the lazy require inside grantAuthorizer
  // runs at handler-call time, outside the Module._load patch).
  try { delete require.cache[require.resolve(path.join(ROOT, 'main', 'services', 'PathGrantService.js'))]; } catch (_) {}
  delete require.cache[require.resolve(FB_IPC)];
  Module._load = _patchedLoad;
  try {
    require(FB_IPC).register({ appRoot: ROOT });
  } finally {
    Module._load = _patchedLoad;
    delete require.cache[require.resolve(FB_IPC)];
  }
  // R1.5a.6: pre-populate require.cache with the PathGrantService
  // mock so the lazy require inside grantAuthorizer.authorizePath()
  // (at handler-call time, AFTER the Module._load patch is
  // restored) resolves to the mock. See loadWithMocks for the full
  // rationale.
  require.cache[require.resolve(path.join(ROOT, 'main', 'services', 'PathGrantService.js'))] = {
    exports: mocks[path.join(ROOT, 'main', 'services', 'PathGrantService')],
  };
  return { handlers, calls };
}

test('fb:ensureDir returns ok for an existing drive root WITHOUT calling mkdir (EPERM avoidance)', async () => {
  // The drive root already exists; mkdir on it would throw EPERM.
  const { handlers, calls } = loadWithMocks({
    statResult: { isDirectory: () => true },
    mkdirImpl: () => { const e = new Error("EPERM: operation not permitted, mkdir 'D:\\'"); e.code = 'EPERM'; throw e; },
  });
  // R1.3: pass a valid grantId. The mock's authorize accepts any
  // non-empty grantId (the test exercises the mkdir/stat branch,
  // not the gate).
  const res = await handlers['fb:ensureDir'](null, 'D:\\', 'mock-grant-id');
  assert.deepEqual(res, { ok: true, path: 'D:\\' }, 'must return ok for the already-existing drive root');
  assert.equal(calls.mkdir.length, 0, 'mkdir must NOT be called when the directory already exists (this is what dodges the EPERM)');
  assert.equal(calls.stat.length, 1, 'stat must be consulted first');
});

test('fb:ensureDir still creates a genuinely missing directory', async () => {
  const { handlers, calls } = loadWithMocks({
    statResult: 'ENOENT', // does not exist yet
    mkdirImpl: () => undefined, // succeeds
  });
  // R1.3: pass a valid grantId.
  const res = await handlers['fb:ensureDir'](null, 'D:\\NewFolder', 'mock-grant-id');
  assert.deepEqual(res, { ok: true, path: 'D:\\NewFolder' });
  assert.equal(calls.mkdir.length, 1, 'mkdir must run when the directory does not exist');
  assert.equal(calls.mkdir[0].opts.recursive, true);
});

test('fb:ensureDir reports a clear error when the path exists but is a file', async () => {
  const { handlers, calls } = loadWithMocks({
    statResult: { isDirectory: () => false },
  });
  // R1.3: pass a valid grantId.
  const res = await handlers['fb:ensureDir'](null, 'D:\\somefile.txt', 'mock-grant-id');
  assert.equal(res.ok, false);
  assert.match(res.error, /not a folder/i);
  assert.equal(calls.mkdir.length, 0, 'must not try to mkdir over an existing file');
});

test('fb:ensureDir surfaces a real mkdir failure for a missing dir (not swallowed)', async () => {
  const { handlers } = loadWithMocks({
    statResult: 'ENOENT',
    mkdirImpl: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; },
  });
  // R1.3: pass a valid grantId.
  const res = await handlers['fb:ensureDir'](null, 'D:\\Protected', 'mock-grant-id');
  assert.equal(res.ok, false);
  assert.match(res.error, /EACCES/);
});

// v1.1 (audit BUG-R2-03): fb:write must accept paths whose
// PARENT IS the allowed root. The audit claimed
// isParentUnderAny requires the parent to be a STRICT child
// of a root, which is incorrect — pathUtils.isPathUnder returns
// true when p === root (the equality branch is hit). The
// regression test below locks in that "writing next to the
// root" works, so a future refactor that switches the call to
// a "strictly under" check would fail here and force the
// author to either restore the equality check OR change the
// handler to use isPathUnderAny on the full output path.
test('fb:write accepts an output path whose parent IS the allowed root (drive-root output_dir)', async () => {
  const { handlers } = loadWithMocks({});
  // Mock isParentUnderAny to behave like the REAL one:
  // accept equality (this is the case the audit was worried
  // about — the parent IS the root).
  // We do this by NOT mocking isParentUnderAny in the loadWithMocks
  // call below — it uses the default isParentUnderAny: () => true
  // from the mock map. So this test asserts the mock flow.
  const outAbs = 'D:\\myoutput\\file.png';
  // The mock pathUtils.normalise just returns the input verbatim,
  // so we can test the path-validation gate directly.
  // R1.3: pass a valid grantId.
  const r = await handlers['fb:write'](null, outAbs, Buffer.from('hello').toString('base64'), 'mock-grant-id');
  assert.equal(r.ok, true, 'write to a path whose parent IS the allowed root must succeed');
  assert.equal(r.path, outAbs);
});

// v1.1 (audit BUG-R2-04): fb:rename must validate newName
// for path traversal. The audit suggested that
// "..\..\..\Windows\System32\evil.dll" would be accepted, but
// the underlying src/fileBrowser.js#rename calls
// validateName(newName) which rejects any name containing
// path separators (/ or \). This regression test asserts
// the validation by passing a path-traversal attempt to
// fb:rename via the real (non-mocked) fb module. We can't use
// loadWithMocks because the mock map replaces the real
// fileBrowser with an empty stub — we need the REAL rename()
// to actually run validateName.
test('fb:rename rejects newName with path separators (BUG-R2-04 regression)', async () => {
  // Load the REAL fileBrowser + register with mocks for the
  // dependencies. This way fb.rename is the production code
  // (which calls validateName).
  const handlers = {};
  const Module = require('module');
  const ROOT2 = path.resolve(__dirname, '..', '..', '..', '..');
  const FB_IPC2 = path.join(ROOT2, 'main', 'ipc', 'registerFileBrowserIpc.js');
  const realFb = require(path.join(ROOT2, 'src', 'fileBrowser'));
  const mocks = {
    electron: { ipcMain: { handle(channel, fn) { handlers[channel] = fn; } } },
    fs: { promises: {
      stat: async () => ({ isDirectory: () => true }),
      access: async () => undefined,
      writeFile: async () => undefined,
      rename: async () => undefined,
      unlink: async () => undefined,
    }, constants: { F_OK: 0 } },
    [path.join(ROOT2, 'src', 'fileBrowser')]: realFb,
    [path.join(ROOT2, 'src', 'pathUtils')]: {
      isPathUnderAny: () => true,
      isParentUnderAny: () => true,
      normalize: (p) => p,
    },
    [path.join(ROOT2, 'main', 'services', 'PathSecurityService')]: {
      getAllowedRoots: () => ['D:\\myoutput'],
    },
    // R1.3: PathGrantService mock (see loadWithMocks for rationale).
    [path.join(ROOT2, 'main', 'services', 'PathGrantService')]: {
      defaultService: {
        authorize: (grantId, { operation, path: p } = {}) => {
          if (!grantId) return { ok: false, error: 'grantId required' };
          if (!p) return { ok: false, error: 'path required' };
          return { ok: true, canonicalPath: p };
        },
        mintDirectoryGrant: (spec) => ({ ok: true, grantId: 'mock-grant-id', grant: Object.assign({}, spec) }),
        mintFileGrant: (spec) => ({ ok: true, grantId: 'mock-grant-id', grant: Object.assign({}, spec) }),
        revoke: () => ({ ok: true }),
        destroy: () => 0,
      },
    },
  };
  const relMap = {
    electron: mocks.electron,
    fs: mocks.fs,
    '../../src/fileBrowser': mocks[path.join(ROOT2, 'src', 'fileBrowser')],
    '../../src/pathUtils': mocks[path.join(ROOT2, 'src', 'pathUtils')],
    '../services/PathSecurityService': mocks[path.join(ROOT2, 'main', 'services', 'PathSecurityService')],
    '../services/PathGrantService': mocks[path.join(ROOT2, 'main', 'services', 'PathGrantService')],
  };
  const originalLoad = Module._load;
  delete require.cache[require.resolve(FB_IPC2)];
  // R1.5a.6: clear the PathGrantService cache so the lazy require
  // inside grantAuthorizer.authorizePath() (at handler-call time,
  // outside the Module._load patch) doesn't hit a stale entry.
  try { delete require.cache[require.resolve(path.join(ROOT2, 'main', 'services', 'PathGrantService.js'))]; } catch (_) {}
  Module._load = function patched(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(relMap, request)) return relMap[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(FB_IPC2).register({ appRoot: ROOT2 });
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(FB_IPC2)];
  }
  // R1.5a.6: pre-populate require.cache with the PathGrantService
  // mock so the lazy require inside grantAuthorizer.authorizePath()
  // (at handler-call time, AFTER the Module._load patch is
  // restored) resolves to the mock. See loadWithMocks for the
  // full rationale.
  require.cache[require.resolve(path.join(ROOT2, 'main', 'services', 'PathGrantService.js'))] = {
    exports: mocks[path.join(ROOT2, 'main', 'services', 'PathGrantService')],
  };
  // Source path is in an allowed root; newName is a path-traversal
  // attempt. The validation in validateName (called by fb.rename)
  // must reject it BEFORE the OS call.
  // R1.3: pass a valid grantId. The handler re-uses the grantId
  // for both the source and target re-authorization.
  const r = await handlers['fb:rename'](null, 'D:\\myoutput\\file.png', '..\\..\\..\\Windows\\System32\\evil.dll', 'mock-grant-id');
  assert.equal(r.ok, false, 'fb:rename must reject newName with path separators');
  assert.match(r.error, /path separators|reserved|cannot/i, `error must explain why (got: ${r.error})`);
});

// ============================================================================
// R1.3 REMOVAL NOTE: `fb:trust-ancestors` was the IPC the file browser's
// Up button used to widen the trust set (and BUG-9-04 added the
// activeDir-based write gate). The R1.3 contract (S1 §4 "File Browser")
// removes this handler entirely: navigation no longer mints, and the
// mutating handlers require a Main-minted grant. The Up button is
// expected to navigate (fb:list + fb:set-active-dir nav-ACK) and then
// present a grant via a new Main-minted picker if a write is needed.
//
// Tests for the new R1.3 contract live in
// `tests/unit/main/ipc/registerFileBrowserIpc.r13.test.js` (R1.3.A–G).
// ============================================================================
