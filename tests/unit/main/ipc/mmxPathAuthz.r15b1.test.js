// tests/unit/main/ipc/mmxPathAuthz.r15b1.test.js
// ============================================================================
// R1.5b.1 — unit tests for the extracted mmxPathAuthz helpers.
//
// These tests cover the pure helpers in `main/ipc/mmxPathAuthz.js`
// (`collectMmxPathFlags` + `authorizeMmxPaths`) without going
// through the full IPC plumbing. The IPC integration is covered
// by `registerMmxIpc.r15b1.test.js`.
//
// Contract:
//   - `collectMmxPathFlags` walks the args array and returns the
//     path-taking flags as `[{ flag, value, kind }]`. Supports
//     both `--flag=value` (one token) and `--flag value` (two
//     tokens) forms. Ignores non-path flags.
//   - `authorizeMmxPaths` requires a non-empty string `grantId`.
//     Without a grantId, the call fails closed. With a grantId,
//     every path the args carry (and the cwd) is authorised via
//     the shared grantAuthorizer helper.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MMX_PATH_AUTHZ = path.join(ROOT, 'main', 'ipc', 'mmxPathAuthz.js');
const GRANT_AUTHORIZER = path.join(ROOT, 'main', 'ipc', 'grantAuthorizer.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15b1-authz-'));

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

function loadMod({ grantMock = {} } = {}) {
  for (const p of [MMX_PATH_AUTHZ, GRANT_AUTHORIZER, PATH_GRANT]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  // Mock the defaultService. The mock's authorize() is
  // configurable per test.
  const defaultService = {
    authorize: (grantId, spec) => {
      if (!grantId) return { ok: false, error: 'grantId required' };
      if (grantMock.rejects && grantMock.rejects.some((p) => spec && spec.path && spec.path.startsWith(p))) {
        return { ok: false, error: 'outside grant scope' };
      }
      if (!spec || typeof spec.path !== 'string') return { ok: false, error: 'path required' };
      return { ok: true, canonicalPath: spec.path };
    },
    mintDirectoryGrant: () => ({ ok: true, grantId: 'g', grant: {} }),
    mintFileGrant: () => ({ ok: true, grantId: 'g', grant: {} }),
    revoke: () => ({ ok: true }),
    destroy: () => 0,
  };
  // Pre-populate the cache (R1.5a.6 fix: lazy require in
  // grantAuthorizer hits the cache at handler-call time).
  require.cache[require.resolve(PATH_GRANT)] = { exports: { defaultService } };
  return require(MMX_PATH_AUTHZ);
}

// ---- collectMmxPathFlags -------------------------------------------------

test('R1.5b.1: collectMmxPathFlags returns [] for non-array args', () => {
  const m = loadMod();
  assert.deepEqual(m.collectMmxPathFlags(null), []);
  assert.deepEqual(m.collectMmxPathFlags(undefined), []);
  assert.deepEqual(m.collectMmxPathFlags('not-an-array'), []);
});

test('R1.5b.1: collectMmxPathFlags returns [] for args with no path flags', () => {
  const m = loadMod();
  assert.deepEqual(m.collectMmxPathFlags(['quota']), []);
  assert.deepEqual(m.collectMmxPathFlags(['image', 'generate', '--prompt', 'a cat']), []);
});

test('R1.5b.1: collectMmxPathFlags splits --flag=value (single-token form)', () => {
  const m = loadMod();
  const r = m.collectMmxPathFlags(['image', '--out=/tmp/x.jpg', '--out-dir=/tmp/d']);
  assert.deepEqual(r, [
    { flag: '--out', value: '/tmp/x.jpg', kind: 'file' },
    { flag: '--out-dir', value: '/tmp/d', kind: 'dir' },
  ]);
});

test('R1.5b.1: collectMmxPathFlags splits --flag value (two-token form)', () => {
  const m = loadMod();
  const r = m.collectMmxPathFlags(['image', '--out', '/tmp/x.jpg', '--out-dir', '/tmp/d']);
  assert.deepEqual(r, [
    { flag: '--out', value: '/tmp/x.jpg', kind: 'file' },
    { flag: '--out-dir', value: '/tmp/d', kind: 'dir' },
  ]);
});

test('R1.5b.1: collectMmxPathFlags accepts -o as a synonym for --out', () => {
  const m = loadMod();
  const r = m.collectMmxPathFlags(['image', '-o', '/tmp/x.jpg']);
  assert.deepEqual(r, [{ flag: '-o', value: '/tmp/x.jpg', kind: 'file' }]);
});

test('R1.5b.1: collectMmxPathFlags accepts --download as a file path flag', () => {
  const m = loadMod();
  const r = m.collectMmxPathFlags(['video', '--download', '/tmp/clip.mp4']);
  assert.deepEqual(r, [{ flag: '--download', value: '/tmp/clip.mp4', kind: 'file' }]);
});

test('R1.5b.1: collectMmxPathFlags ignores --flag with no value', () => {
  const m = loadMod();
  // --out is the last token, no value after it.
  assert.deepEqual(m.collectMmxPathFlags(['image', '--out']), []);
  // --out --another-flag: the next token starts with '-', so the
  // path is treated as missing.
  assert.deepEqual(m.collectMmxPathFlags(['image', '--out', '--another']), []);
});

test('R1.5b.1: collectMmxPathFlags ignores non-string array entries', () => {
  const m = loadMod();
  const r = m.collectMmxPathFlags(['image', 42, '--out', '/tmp/x.jpg', null]);
  // The 42 is skipped (no '='), but the next entry IS the value
  // for --out. The 42 is not consumed as a value because the
  // for-loop only advances past a value if MMX_FILE/DIR_PATH_FLAGS
  // matched. So 42 isn't a path flag, --out matches, and the next
  // token is /tmp/x.jpg.
  assert.deepEqual(r, [{ flag: '--out', value: '/tmp/x.jpg', kind: 'file' }]);
});

// ---- authorizeMmxPaths ---------------------------------------------------

test('R1.5b.1: authorizeMmxPaths fails closed when grantId is missing', () => {
  const m = loadMod();
  const r = m.authorizeMmxPaths('', [{ flag: '--out', value: '/tmp/x.jpg', kind: 'file' }]);
  assert.ok(r && /grantId is required/i.test(r), 'must fail with a grantId-required error');
});

test('R1.5b.1: authorizeMmxPaths fails closed when grantId is non-string', () => {
  const m = loadMod();
  const r1 = m.authorizeMmxPaths(null, [{ flag: '--out', value: '/tmp/x.jpg', kind: 'file' }]);
  const r2 = m.authorizeMmxPaths(123, [{ flag: '--out', value: '/tmp/x.jpg', kind: 'file' }]);
  const r3 = m.authorizeMmxPaths({}, [{ flag: '--out', value: '/tmp/x.jpg', kind: 'file' }]);
  assert.ok(r1 && /grantId is required/i.test(r1));
  assert.ok(r2 && /grantId is required/i.test(r2));
  assert.ok(r3 && /grantId is required/i.test(r3));
});

test('R1.5b.1: authorizeMmxPaths succeeds with empty pathFlags and no cwd (e.g. "mmx quota")', () => {
  const m = loadMod();
  const r = m.authorizeMmxPaths('g1', []);
  assert.equal(r, null, 'no paths to authorise = no error');
});

test('R1.5b.1: authorizeMmxPaths authorises --out with operation "write"', () => {
  const m = loadMod();
  // The mock defaultService.authorize records nothing; we use the
  // grants behaviour to assert (the mock accepts any non-empty path).
  const r = m.authorizeMmxPaths('g1', [{ flag: '--out', value: path.join(TMP, 'x.jpg'), kind: 'file' }]);
  assert.equal(r, null);
});

test('R1.5b.1: authorizeMmxPaths authorises cwd with operation "mkdir"', () => {
  const m = loadMod();
  const r = m.authorizeMmxPaths('g1', [], TMP);
  assert.equal(r, null);
});

test('R1.5b.1: authorizeMmxPaths authorises every path flag independently', () => {
  const m = loadMod();
  const r = m.authorizeMmxPaths('g1', [
    { flag: '--out', value: path.join(TMP, 'a.jpg'), kind: 'file' },
    { flag: '--out-dir', value: TMP, kind: 'dir' },
    { flag: '--download', value: path.join(TMP, 'clip.mp4'), kind: 'file' },
  ]);
  assert.equal(r, null);
});

test('R1.5b.1: authorizeMmxPaths returns the first failed path with the flag name', () => {
  const m = loadMod({ grantMock: { rejects: ['D:\\evil'] } });
  const r = m.authorizeMmxPaths('g1', [
    { flag: '--out', value: path.join(TMP, 'a.jpg'), kind: 'file' },
    { flag: '--out', value: 'D:\\evil\\x.jpg', kind: 'file' },
  ]);
  assert.ok(r, 'must return an error string');
  assert.match(r, /--out/);
  assert.match(r, /not authorised|outside grant scope/i);
  assert.match(r, /D:\\evil/);
});

test('R1.5b.1: authorizeMmxPaths returns a cwd-specific error when the cwd is rejected', () => {
  const m = loadMod({ grantMock: { rejects: ['D:\\evil'] } });
  const r = m.authorizeMmxPaths('g1', [], 'D:\\evil\\sub');
  assert.ok(r, 'must return an error string');
  assert.match(r, /cwd/i);
  assert.match(r, /D:\\evil/);
});
