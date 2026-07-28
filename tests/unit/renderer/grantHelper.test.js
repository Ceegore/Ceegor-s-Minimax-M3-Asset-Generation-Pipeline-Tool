// ============================================================================
// BGR follow-up — GrantHelper integration tests against the REAL
// PathGrantService.
//
// grantHelper.js (renderer/utils/grantHelper.js) mints the grant that
// each gated IPC handler later authorises. The three critical bugs found
// in the 360° hunt (BUG-1 missing coversRoot on ensureDir, BUG-2 missing
// 'write' capability on ensureRename, BUG-3 move/copy minted on destDir
// only) were all grant-SHAPE mismatches: the helper minted a grant that
// the handler's authorize() call then rejected. They slipped through the
// previous sweep because grantHelper had ZERO tests validating its mint
// shapes against the actual PathGrantService relation rules.
//
// These tests close that gap. Each test wires grantHelper → grantCache →
// a mintGrant stub that mirrors main/ipc/registerPathGrantIpc.js → a REAL
// PathGrantService (identity realpath, POSIX paths for cross-platform
// determinism), then asserts the EXACT authorize() pair the corresponding
// handler in main/ipc/registerFileBrowserIpc.js performs:
//
//   fb:read / fb:exists  → ('read',   file)
//   fb:write             → ('write',  outAbs)
//   optimize/resize/cut  → ('read',   src) + ('write', sibling-output)
//   fb:ensureDir         → ('mkdir',  dir-itself)      [needs coversRoot]
//   fb:mkdir             → ('mkdir',  dir/child)
//   fb:delete            → ('delete', file)
//   fb:rename            → ('rename', src) + ('write', target)
//   fb:move              → ('move',   src) + ('write', destPath)
//   fb:copy              → ('copy',   src) + ('write', destPath)
//
// Each positive assertion FAILS against the pre-fix grantHelper, so these
// are true regression tests for BUG-1/2/3.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { PathGrantService } = require(path.join(ROOT, 'main', 'services', 'PathGrantService'));
const grantCachePath = path.join(ROOT, 'renderer', 'services', 'grantCache.js');
const grantHelperPath = path.join(ROOT, 'renderer', 'utils', 'grantHelper.js');

const VALID_OPS = new Set(['read', 'write', 'delete', 'mkdir', 'rename', 'copy', 'move']);

/**
 * mintGrant stub mirroring main/ipc/registerPathGrantIpc.js 'pathGrant:mint'
 * (kind / capabilities / coversRoot parsing + directory-vs-file routing).
 * The trust-root check is intentionally omitted — it is orthogonal to the
 * grant-SHAPE contract under test here and is covered by its own tests.
 */
function makeMintGrant(svc) {
  return async function mintGrant(p, operation, opts) {
    if (typeof p !== 'string' || !p.trim()) return { ok: false, error: 'Path is required.' };
    if (!VALID_OPS.has(operation)) return { ok: false, error: 'bad operation: ' + operation };
    let kind = 'file';
    let capabilities = [operation];
    let coversRoot = false;
    if (opts && Object.getPrototypeOf(opts) === Object.prototype) {
      if (opts.kind != null) kind = opts.kind;
      if (opts.capabilities != null) capabilities = opts.capabilities.slice();
      if (opts.coversRoot != null) coversRoot = opts.coversRoot;
    }
    const spec = {
      origin: 'renderer-mint', purpose: operation + ' on ' + p,
      path: p, capabilities, singleUse: false,
    };
    if (kind === 'directory') {
      spec.coversRoot = coversRoot;
      return svc.mintDirectoryGrant(spec);
    }
    return svc.mintFileGrant(spec);
  };
}

/**
 * Build a fresh service + window + module instances. Identity realpath
 * means no filesystem access and POSIX paths canonicalise to themselves,
 * so the tests are deterministic on every platform.
 */
function setup(dirnameFn) {
  let idc = 0;
  const svc = new PathGrantService({
    now: () => 1700000000000,
    idFactory: () => 'g-' + (++idc),
    realpath: (p) => p,
  });
  global.window = {
    api: {
      mintGrant: makeMintGrant(svc),
      revokeGrant: async (id) => svc.revoke(id),
      pathDirname: dirnameFn || ((p) => path.posix.dirname(p)),
    },
  };
  for (const p of [grantCachePath, grantHelperPath]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  require(grantCachePath);              // sets window.GrantCache
  const helper = require(grantHelperPath); // sets + returns window.GrantHelper
  return { svc, helper };
}

test.afterEach(() => {
  delete global.window;
});

// ---------------------------------------------------------------------------
// A — ensureRead → file grant, exact-match read only.
// ---------------------------------------------------------------------------
test('GH.A: ensureRead mints a file grant that authorises read on the exact file only', async () => {
  const { svc, helper } = setup();
  const g = await helper.ensureRead('/work/a.png');
  assert.equal(typeof g, 'string', 'A: must return a grantId string');
  assert.equal(svc.authorize(g, { operation: 'read', path: '/work/a.png' }).ok, true,
    'A: fb:read/fb:exists authorise (read, file)');
  assert.equal(svc.authorize(g, { operation: 'read', path: '/work/b.png' }).ok, false,
    'A: file grant is exact-match — a sibling must NOT be covered');
  assert.equal(svc.authorize(g, { operation: 'write', path: '/work/a.png' }).ok, false,
    'A: read-only grant must not permit write');
});

// ---------------------------------------------------------------------------
// B — ensureWrite → parent-dir grant covering read-src + write-sibling.
// ---------------------------------------------------------------------------
test('GH.B: ensureWrite mints a parent-dir grant covering read-src + write-sibling (optimize/resize/cut pattern)', async () => {
  const { svc, helper } = setup();
  const g = await helper.ensureWrite('/work/a.opt.png');
  assert.equal(typeof g, 'string', 'B: must return a grantId string');
  assert.equal(svc.authorize(g, { operation: 'write', path: '/work/a.opt.png' }).ok, true,
    'B: fb:write authorises (write, outAbs)');
  assert.equal(svc.authorize(g, { operation: 'read', path: '/work/a.png' }).ok, true,
    'B: optimize/resize/cut authorise (read, src) — a sibling of the output');
  assert.equal(svc.authorize(g, { operation: 'write', path: '/work/a.out.png' }).ok, true,
    'B: ... and (write, sibling-output)');
});

// ---------------------------------------------------------------------------
// C — ensureDir → coversRoot grant (BUG-1 regression).
// ---------------------------------------------------------------------------
test('GH.C (BUG-1 regression): ensureDir mints a coversRoot grant authorising mkdir on the directory ITSELF', async () => {
  const { svc, helper } = setup();
  const g = await helper.ensureDir('/work/newdir');
  assert.equal(typeof g, 'string', 'C: must return a grantId string');
  // fb:ensureDir authorises ('mkdir', dir) — the grant ROOT itself. Without
  // coversRoot:true this rejects with 'directory grant covers only strict
  // descendants, not the root itself' (the pre-fix failure).
  assert.equal(svc.authorize(g, { operation: 'mkdir', path: '/work/newdir' }).ok, true,
    'C: fb:ensureDir authorises (mkdir, dir-itself) — requires coversRoot');
  assert.equal(svc.authorize(g, { operation: 'mkdir', path: '/work/newdir/sub' }).ok, true,
    'C: fb:mkdir authorises the named CHILD (strict descendant)');
});

// ---------------------------------------------------------------------------
// D — ensureDelete → parent-dir grant with delete capability.
// ---------------------------------------------------------------------------
test('GH.D: ensureDelete mints a parent-dir grant that authorises delete on the file', async () => {
  const { svc, helper } = setup();
  const g = await helper.ensureDelete('/work/a.png');
  assert.equal(typeof g, 'string', 'D: must return a grantId string');
  assert.equal(svc.authorize(g, { operation: 'delete', path: '/work/a.png' }).ok, true,
    'D: fb:delete authorises (delete, file)');
});

// ---------------------------------------------------------------------------
// E — ensureRename → rename-on-src AND write-on-target (BUG-2 regression).
// ---------------------------------------------------------------------------
test('GH.E (BUG-2 regression): ensureRename grant authorises BOTH rename-on-src AND write-on-target', async () => {
  const { svc, helper } = setup();
  const g = await helper.ensureRename('/work/old.png');
  assert.equal(typeof g, 'string', 'E: must return a grantId string');
  assert.equal(svc.authorize(g, { operation: 'rename', path: '/work/old.png' }).ok, true,
    'E: fb:rename authorises (rename, src)');
  // Without the 'write' capability this second handler check rejects with
  // 'operation "write" not permitted by grant capabilities' (pre-fix failure).
  assert.equal(svc.authorize(g, { operation: 'write', path: '/work/new.png' }).ok, true,
    'E: fb:rename ALSO authorises (write, target) — requires the write cap');
});

// ---------------------------------------------------------------------------
// F — ensureMove → common-ancestor grant (BUG-3 regression).
// ---------------------------------------------------------------------------
test('GH.F (BUG-3 regression): ensureMove mints on the common ancestor so BOTH src and destPath authorise', async () => {
  const { svc, helper } = setup();
  const r = await helper.ensureMove('/work/src/a.png', '/work/dst');
  // gewv2 GEW-002: ensureMove now returns { ok, srcGrant, destGrant } — when
  // a single common-ancestor grant covers both endpoints, srcGrant === destGrant.
  assert.equal(r.ok, true, 'F: must succeed');
  assert.equal(typeof r.srcGrant, 'string', 'F: srcGrant must be a grantId string');
  assert.equal(r.srcGrant, r.destGrant, 'F: a shared common-ancestor grant covers both endpoints');
  // fb:move authorises ('move', src). Minting on destDir alone (pre-fix)
  // fails this check because src lives OUTSIDE destDir (the normal case).
  assert.equal(svc.authorize(r.srcGrant, { operation: 'move', path: '/work/src/a.png' }).ok, true,
    'F: fb:move authorises (move, src) — src must be under the grant root');
  assert.equal(svc.authorize(r.destGrant, { operation: 'write', path: '/work/dst/a.png' }).ok, true,
    'F: fb:move ALSO authorises (write, destPath = destDir + basename)');
});

// ---------------------------------------------------------------------------
// G — ensureCopy → common-ancestor grant (BUG-3 regression).
// ---------------------------------------------------------------------------
test('GH.G (BUG-3 regression): ensureCopy mints on the common ancestor so BOTH src and destPath authorise', async () => {
  const { svc, helper } = setup();
  const r = await helper.ensureCopy('/work/src/a.png', '/work/dst');
  assert.equal(r.ok, true, 'G: must succeed');
  assert.equal(r.srcGrant, r.destGrant, 'G: a shared common-ancestor grant covers both endpoints');
  assert.equal(svc.authorize(r.srcGrant, { operation: 'copy', path: '/work/src/a.png' }).ok, true,
    'G: fb:copy authorises (copy, src)');
  assert.equal(svc.authorize(r.destGrant, { operation: 'write', path: '/work/dst/a.png' }).ok, true,
    'G: fb:copy ALSO authorises (write, destPath)');
});

// ---------------------------------------------------------------------------
// H — ensureMove where destDir is the src parent (rename-in-place).
// ---------------------------------------------------------------------------
test('GH.H: ensureMove where destDir is the src parent resolves the common ancestor to that parent', async () => {
  const { svc, helper } = setup();
  const r = await helper.ensureMove('/work/a.png', '/work');
  assert.equal(r.ok, true, 'H: must succeed');
  assert.equal(svc.authorize(r.srcGrant, { operation: 'move', path: '/work/a.png' }).ok, true,
    'H: (move, src) under the shared parent');
  assert.equal(svc.authorize(r.destGrant, { operation: 'write', path: '/work/b.png' }).ok, true,
    'H: (write, destPath) under the shared parent');
});

// ---------------------------------------------------------------------------
// I — ensureMove with deeper nesting resolves the correct ancestor.
// ---------------------------------------------------------------------------
test('GH.I: ensureMove with deeper nesting resolves the deepest common ancestor', async () => {
  const { svc, helper } = setup();
  const r = await helper.ensureMove('/work/proj/assets/img/a.png', '/work/proj/out/final');
  assert.equal(r.ok, true, 'I: must succeed');
  // Deepest common ancestor is /work/proj — both paths are strict descendants.
  assert.equal(svc.authorize(r.srcGrant, { operation: 'move', path: '/work/proj/assets/img/a.png' }).ok, true,
    'I: (move, src) under /work/proj');
  assert.equal(svc.authorize(r.destGrant, { operation: 'write', path: '/work/proj/out/final/a.png' }).ok, true,
    'I: (write, destPath) under /work/proj');
});

// ---------------------------------------------------------------------------
// J — guard behaviour: empty/missing paths return undefined (no mint, no throw).
// ---------------------------------------------------------------------------
test('GH.J: helpers return undefined for empty/missing paths (no mint, no throw)', async () => {
  const { helper } = setup();
  assert.equal(await helper.ensureRead(''), undefined, 'J: ensureRead("") → undefined');
  assert.equal(await helper.ensureWrite(''), undefined, 'J: ensureWrite("") → undefined');
  assert.equal(await helper.ensureDir(''), undefined, 'J: ensureDir("") → undefined');
  assert.equal(await helper.ensureDelete(''), undefined, 'J: ensureDelete("") → undefined');
  assert.equal(await helper.ensureRename(''), undefined, 'J: ensureRename("") → undefined');
  assert.equal(await helper.ensureMove('/work/a.png', ''), undefined, 'J: ensureMove(src, "") → undefined');
  assert.equal(await helper.ensureCopy('/work/a.png', ''), undefined, 'J: ensureCopy(src, "") → undefined');
});

// ---------------------------------------------------------------------------
// K — mixed-separator common ancestor (Windows '/' vs '\\' regression).
// ---------------------------------------------------------------------------
test('GH.K (mixed-separator regression): ensureMove finds the common ancestor across / and \\ separator styles', async () => {
  // Production pathDirname is a path.win32.dirname port, which PRESERVES the
  // input's separator style. A '/'-style src and a '\'-style destDir must
  // still resolve to their shared ancestor. Uses the win32 dirname stub; the
  // assertion is on the minted grant root (pure _commonAncestor logic +
  // identity realpath), so it is deterministic on every platform.
  const { svc, helper } = setup((p) => path.win32.dirname(p));
  const r = await helper.ensureMove('C:/work/src/a.png', 'C:\\work\\dst');
  assert.equal(r.ok, true, 'K: must succeed');
  assert.equal(r.srcGrant, r.destGrant, 'K: a shared common-ancestor grant covers both endpoints');
  // Before the separator-normalization fix, _commonAncestor returned null
  // (the '/'-chain never string-matched the '\'-walk) and the grant was
  // minted on destDir alone, which does not cover the src. The correct
  // common ancestor is 'C:\work'.
  const grant = svc.inspect(r.srcGrant);
  assert.ok(grant, 'K: grant must exist');
  assert.equal(
    String(grant.canonicalPath).replace(/\//g, '\\').toLowerCase(),
    'c:\\work',
    'K: grant must be minted on the common ancestor C:\\work, not destDir',
  );
});

// ---------------------------------------------------------------------------
// L — ensureTransform (pipeline "read src -> write dst into a sibling column
//     folder" grant). Regression for the pipeline write-authz failure where a
//     grant minted on pathDirname(src) did not cover the dst in another folder.
// ---------------------------------------------------------------------------
test('GH.L: ensureTransform mints on the common ancestor so src read + dst write both authorise (pipeline column folders)', async () => {
  const { svc, helper } = setup();
  // src lives in the 'original' column folder; the op writes into the
  // 'upscale' column folder (a sibling dir). A grant on pathDirname(src)
  // would fail the dst write check ("covers only strict descendants").
  const g = await helper.ensureTransform('/ws/original/img_1.png', '/ws/upscale/img_1_4x.png');
  assert.equal(typeof g, 'string', 'L: must return a grantId string');
  assert.equal(svc.authorize(g, { operation: 'read', path: '/ws/original/img_1.png' }).ok, true, 'L: read src must authorise');
  assert.equal(svc.authorize(g, { operation: 'write', path: '/ws/upscale/img_1_4x.png' }).ok, true, 'L: write dst must authorise');
});

test('GH.L2: ensureTransform for a same-folder sibling dst (batchPostprocess shape) still authorises both', async () => {
  const { svc, helper } = setup();
  const g = await helper.ensureTransform('/out/a.png', '/out/a_up2x.png');
  assert.equal(typeof g, 'string', 'L2: must return a grantId string');
  assert.equal(svc.authorize(g, { operation: 'read', path: '/out/a.png' }).ok, true, 'L2: read src');
  assert.equal(svc.authorize(g, { operation: 'write', path: '/out/a_up2x.png' }).ok, true, 'L2: write dst');
});

test('GH.L3 (mixed separators): ensureTransform resolves the common ancestor across / and \\ styles', async () => {
  const { svc, helper } = setup((p) => path.win32.dirname(p));
  const g = await helper.ensureTransform('C:/ws/original/x.png', 'C:\\ws\\upscale\\x_4x.png');
  assert.equal(typeof g, 'string', 'L3: must return a grantId string');
  const grant = svc.inspect(g);
  assert.ok(grant, 'L3: grant must exist');
  assert.equal(
    String(grant.canonicalPath).replace(/\//g, '\\').toLowerCase(),
    'c:\\ws',
    'L3: grant must be minted on the workspace root C:\\ws',
  );
});
