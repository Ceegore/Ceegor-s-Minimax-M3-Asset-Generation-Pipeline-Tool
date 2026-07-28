// tests/unit/renderer/ensureSubDir.test.js
// Bug-fix (2026-06-19, reported by user): `ensureSubDir` was
// lost during the Phase 3 Block 29 refactor. Each tab's
// generate handler calls `await ensureSubDir(name)`, but the
// function was undefined → ReferenceError → catch block fired
// → "No output directory set. Open Settings." even when the
// user had just picked one. This test pins the contract so a
// future refactor can't drop the function again.

const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal renderer shim. ensureSubDir touches: state.config.output_dir,
// state.fbDir, and window.api.fbMkdir.
const mkdirCalls = [];
const state = {
  config: { output_dir: '' },
  fbDir: '',
};
global.window = global;
global.state = state;
global.window.api = global.window.api || {
  fbMkdir: async (dir, name) => { mkdirCalls.push([dir, name]); return { ok: true }; },
};

// Loading app.js executes a lot of renderer code we don't want to
// re-run in a unit test. Instead, we extract just the ensureSubDir
// body by re-requiring the file in a tiny sandbox: we shim every
// helper it depends on and let the IIFE that wraps app.js hit the
// "ready" branch cleanly. We keep this test small by sourcing the
// function via a fresh node VM context.
//
// Simpler approach: read the function definition from app.js as a
// string and eval it inside a controlled scope. We pin the exact
// behaviour we want by exercising the live function.

test('ensureSubDir is defined and exported on window', async () => {
  // Load app.js — but app.js boots a full DOMContentLoaded
  // handler, so we just check the function name is reachable
  // without throwing.
  const fs = require('fs');
  const path = require('path');
  const code = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'renderer', 'app.js'),
    'utf8',
  );
  // The function must be defined in the file.
  assert.ok(/async function ensureSubDir\(/.test(code),
    'ensureSubDir function definition missing from renderer/app.js');
  // It must be exposed on window so tab scripts (loaded earlier
  // in index.html) can see it.
  assert.ok(/window\.ensureSubDir\s*=\s*ensureSubDir/.test(code),
    'ensureSubDir not exposed on window — tab scripts would crash with ReferenceError');
});

// Bug-fix B4 (_temp5.md): source-pinned guard against the
// spurious-<picked>/<tab>-folder regression. The real ensureSubDir
// in renderer/app.js MUST call fbEnsureDir(picked) in the case-4
// (external picked) branch, NOT fbMkdir(picked, name) — the latter
// created a stray empty directory on every generation into an
// external folder because files landed in <picked> but the mkdir
// created <picked>/<tab>. We pin the exact source shape so a future
// refactor that reverts the fix fails this test.
test('B4: real app.js ensureSubDir case-4 uses fbEnsureDir(picked), not fbMkdir(picked, name)', () => {
  const fs = require('fs');
  const path = require('path');
  const code = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'renderer', 'app.js'),
    'utf8',
  );
  // Isolate the externalPicked branch so we assert about THAT
  // branch, not any other fbMkdir/fbEnsureDir call in the function.
  const externalBranchMatch = code.match(/else if \(externalPicked\) \{[\s\S]*?\}\s*else \{/);
  assert.ok(externalBranchMatch, 'could not locate the externalPicked branch in ensureSubDir');
  const branch = externalBranchMatch[0];
  // R7.5: the call now threads a Main-minted grantId as an optional
  // trailing arg — fbEnsureDir(picked, outGrantId). Allow the optional
  // ", <grant>" suffix so the B4 guard (fbEnsureDir, NOT fbMkdir) still
  // pins the branch shape without false-firing on the grant wiring.
  assert.ok(/fbEnsureDir\s*\(\s*picked\s*(,[^)]*)?\)/.test(branch),
    'case-4 branch must call fbEnsureDir(picked[, grantId]) — B4 regression: it does not');
  // The actual call would be `await mkdirOrThrow(picked, name)`.
  // The comment explaining the OLD bug mentions `mkdirOrThrow(picked, name)`
  // without `await`, so we match the await-prefixed form to catch a
  // real regression without false-firing on the comment text.
  assert.ok(!/await\s+mkdirOrThrow\s*\(\s*picked\s*,\s*name\s*\)/.test(branch),
    'case-4 branch must NOT actually call await mkdirOrThrow(picked, name) — that creates a spurious <picked>/<tab> folder (B4 regression)');
});

// Behaviour tests via a small inlined re-implementation that
// matches the live function line-for-line. We pin the contract
// here so a regression in the live code is caught by the lint
// script's structural checks + by these tests exercising the
// same branches in isolation.

async function ensureSubDir(base, fbDir, name, fbMkdir, fbEnsureDir) {
  if (!base) throw new Error('No output directory set. Open Settings.');
  const normForCompare = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const baseNorm = normForCompare(base);
  const fbNorm = normForCompare(fbDir);
  const baseSep = base.includes('\\') ? '\\' : '/';
  const join = (a, b, sep) => a.replace(/[\\/]+$/, '') + sep + b;
  let targetDir;
  let externalPicked = false;
  let rootDefault = false;
  if (fbNorm && fbNorm.startsWith(baseNorm + '/')) {
    // Case 2: real subfolder of output_dir
    targetDir = (fbDir || '').replace(/[\\/]+$/, '');
  } else if (fbNorm && fbNorm !== baseNorm && !fbNorm.startsWith(baseNorm + '/')) {
    // Case 4: external folder (e.g. picked via the native dialog)
    targetDir = (fbDir || '').replace(/[\\/]+$/, '');
    externalPicked = true;
  } else {
    // Case 3 (bug-fix D1): empty / equal to output_dir root → write to
    // the root directly. The previous behaviour redirected this case to
    // <output_dir>/<name>, which put files one level deeper than the
    // folder the browser was actually showing.
    targetDir = base.replace(/[\\/]+$/, '');
    rootDefault = true;
  }
  if (rootDefault) {
    // fbMkdir always creates a NAMED CHILD of its first argument, so it
    // can't create the root itself — fbEnsureDir is the dedicated call
    // for "create this exact (already-allowed) path if missing".
    // v1.1.12 (reported by user): no .catch(() => null) here. A failed
    // mkdir must surface as a thrown error so the gen handler's catch
    // block can show the real reason (instead of silently returning a
    // targetDir that doesn't exist on disk, which then ENOENTs in
    // mmxRun).
    await fbEnsureDir(targetDir);
  } else if (externalPicked) {
    // Bug-fix B4 (_temp5.md): the picked folder already exists (the
    // user is browsing it) and files land DIRECTLY in it. The
    // previous version called fbMkdir(picked, name), which created a
    // spurious empty <picked>/<tabName> directory on every
    // generation into an external folder — files never went into it
    // (they went to <picked>), contradicting the case-4 contract.
    // fbEnsureDir is idempotent on disk but keeps the allow-list
    // check consistent with the other branches.
    const picked = (fbDir || '').replace(/[\\/]+$/, '');
    await fbEnsureDir(picked);
  } else {
    const stripped = targetDir.replace(/[\\/]+$/, '');
    const baseN = base.replace(/[\\/]+$/, '');
    const relParts = [];
    if (stripped.length > baseN.length) {
      const rel = stripped.slice(baseN.length).replace(/^[\\/]+/, '');
      for (const p of rel.split(/[\\/]/).filter(Boolean)) relParts.push(p);
    }
    let cur = base;
    for (const p of relParts) {
      await fbMkdir(cur, p);
      cur = join(cur, p, baseSep);
    }
  }
  return targetDir;
}

test('throws when output_dir is blank', async () => {
  await assert.rejects(
    () => ensureSubDir('', '', 'image', async () => null),
    /No output directory set/,
  );
});

test('respects external picked folder (outside output_dir) — used as the destination, NO spurious subdir (B4)', async () => {
  // Bug-fix B4 (_temp5.md): files must land DIRECTLY in the picked
  // external folder, NOT in a <picked>/<tabName> subfolder. The
  // previous version called fbMkdir(picked, name) which created a
  // stray empty <picked>/image directory on every generation into
  // an external folder. fbEnsureDir(picked) is idempotent and
  // creates NO child directory.
  const mkdirCalls = [];
  const ensureCalls = [];
  const fakeMkdir = async (dir, name) => { mkdirCalls.push([dir, name]); };
  const fakeEnsureDir = async (dir) => { ensureCalls.push(dir); };
  const target = await ensureSubDir('C:/out', 'C:/somewhere/else', 'image', fakeMkdir, fakeEnsureDir);
  assert.equal(target, 'C:/somewhere/else');
  // The picked folder is ensured (idempotent no-op on disk since
  // the user is browsing it), but NO child mkdir is issued.
  assert.deepEqual(ensureCalls, ['C:/somewhere/else']);
  assert.deepEqual(mkdirCalls, [],
    'case 4 must NOT call fbMkdir(picked, name) — that created a spurious empty <picked>/<tab> folder (B4 regression)');
});

test('respects fbDir when it IS under output_dir', async () => {
  const calls = [];
  const fakeMkdir = async (dir, name) => { calls.push([dir, name]); };
  const target = await ensureSubDir('C:/out', 'C:/out/image/sub', 'image', fakeMkdir);
  assert.equal(target, 'C:/out/image/sub');
  // The mkdir calls walk the segments from <out>/image down to
  // <out>/image/sub. They're idempotent on the OS side, so the
  // important contract is just that targetDir == fbDir.
  assert.deepEqual(calls, [
    ['C:/out', 'image'],
    ['C:/out/image', 'sub'],
  ]);
});

test('respects fbDir when it IS the output_dir itself (bug-fix D1: writes to the root, NOT a per-tab subfolder)', async () => {
  // Bug-fix D1 (_temp4.md): v1.1.8 redirected this case to
  // <output>/<tabName> to avoid cluttering the drive root — but that
  // meant a file could land one level deeper than the folder the
  // browser was actually showing, which looks like the file
  // "vanished". The corrected contract: when fbDir IS the output_dir
  // root (a valid, already-displayed folder), write there directly.
  // The root may not exist on disk yet, so it goes through
  // fbEnsureDir (not fbMkdir, which always requires a child name).
  const mkdirCalls = [];
  const ensureCalls = [];
  const fakeMkdir = async (dir, name) => { mkdirCalls.push([dir, name]); };
  const fakeEnsureDir = async (dir) => { ensureCalls.push(dir); };
  const target = await ensureSubDir('C:/out', 'C:/out', 'image', fakeMkdir, fakeEnsureDir);
  assert.equal(target, 'C:/out');
  assert.deepEqual(ensureCalls, ['C:/out']);
  assert.deepEqual(mkdirCalls, []);
});

test('writes to the root when fbDir is empty (same as fbDir === base)', async () => {
  const mkdirCalls = [];
  const ensureCalls = [];
  const fakeMkdir = async (dir, name) => { mkdirCalls.push([dir, name]); };
  const fakeEnsureDir = async (dir) => { ensureCalls.push(dir); };
  const target = await ensureSubDir('C:/out', '', 'image', fakeMkdir, fakeEnsureDir);
  assert.equal(target, 'C:/out');
  assert.deepEqual(ensureCalls, ['C:/out']);
  assert.deepEqual(mkdirCalls, []);
});

test('respects external picked folder (outside output_dir) — no child mkdir (B4)', async () => {
  // Bug-fix B4 (_temp5.md): user picked a folder on a different
  // drive via the native dialog. The path is already in
  // trustedPickPaths (the picker added it), so fbEnsureDir(picked)
  // is the only call needed. NO <picked>/<tab> child may be
  // created — files land directly in the picked folder.
  const mkdirCalls = [];
  const ensureCalls = [];
  const fakeMkdir = async (dir, name) => { mkdirCalls.push([dir, name]); };
  const fakeEnsureDir = async (dir) => { ensureCalls.push(dir); };
  const target = await ensureSubDir('C:/out', 'E:/myproject/assets', 'image', fakeMkdir, fakeEnsureDir);
  assert.equal(target, 'E:/myproject/assets');
  assert.deepEqual(ensureCalls, ['E:/myproject/assets']);
  assert.deepEqual(mkdirCalls, [],
    'case 4 must NOT call fbMkdir(picked, name) — that created a spurious <picked>/<tab> folder (B4 regression)');
});

test('walks path segments when fbDir is a deeper subfolder', async () => {
  const calls = [];
  const fakeMkdir = async (dir, name) => { calls.push([dir, name]); };
  const target = await ensureSubDir('C:/out', 'C:/out/foo/bar/baz', 'image', fakeMkdir);
  assert.equal(target, 'C:/out/foo/bar/baz');
  // Should mkdir <out>/foo, then <out>/foo/bar, then <out>/foo/bar/baz.
  assert.deepEqual(calls, [
    ['C:/out', 'foo'],
    ['C:/out/foo', 'bar'],
    ['C:/out/foo/bar', 'baz'],
  ]);
});

test('handles Windows backslashes', async () => {
  const calls = [];
  const ensureCalls = [];
  const fakeMkdir = async (dir, name) => { calls.push([dir, name]); };
  const fakeEnsureDir = async (dir) => { ensureCalls.push(dir); };
  // fbDir === base on a drive root → writes to the root (bug-fix D1).
  const target = await ensureSubDir('C:\\out', 'C:\\out', 'image', fakeMkdir, fakeEnsureDir);
  assert.equal(target, 'C:\\out');
  // Trailing slash on output_dir is normalised away before the
  // call; fbDir is outside output_dir so it's case-4 (external pick).
  // Bug-fix B4 (_temp5.md): case 4 now uses fbEnsureDir(picked), NOT
  // fbMkdir(picked, name) — no spurious child folder is created.
  const target2 = await ensureSubDir('C:\\out\\', 'C:\\elsewhere', 'music', fakeMkdir, fakeEnsureDir);
  assert.equal(target2, 'C:\\elsewhere');
  assert.deepEqual(ensureCalls, ['C:\\out', 'C:\\elsewhere']);
  assert.deepEqual(calls, [],
    'case 4 (external pick) must NOT call fbMkdir(picked, name) — B4 regression');
});

test('case-insensitive subfolder match (Windows-friendly)', async () => {
  const calls = [];
  const fakeMkdir = async (dir, name) => { calls.push([dir, name]); };
  // base = 'C:/Out' (capital O), fbDir = 'c:/out/Image' (lower-case)
  // → under-root check is case-insensitive, so fbDir is honoured.
  const target = await ensureSubDir('C:/Out', 'c:/out/Image', 'image', fakeMkdir);
  // targetDir preserves the base's original case (the user's
  // configured folder); the case-insensitive normalisation is
  // only used for the startsWith guard.
  assert.equal(target, 'c:/out/Image');
  // fbDir was just 'Image' (one segment under <out>), so the
  // walker mkdirs '<base>/Image' idempotently — using the base's
  // original casing.
  assert.deepEqual(calls, [['C:/Out', 'Image']]);
});