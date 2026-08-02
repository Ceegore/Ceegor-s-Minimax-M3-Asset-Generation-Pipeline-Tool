// tests/unit/renderer/grantHelper.b002.test.js
// ============================================================================
// B-002 — the renderer must mint READ grants for local input reference
// paths before an mmx run. `GrantHelper.ensureMmxReadGrants(args)` scans
// the argv for input file flags, unwraps --subject-ref composites, skips
// URLs, and mints one file-read grant per distinct local path.
//
// Loads the REAL renderer/utils/grantHelper.js in a vm sandbox with a
// recording GrantCache stub — no hand-copied logic.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'utils', 'grantHelper.js'), 'utf8');

// Build a sandbox with a recording GrantCache. Each mint returns a fresh
// grantId string ('grant-1', 'grant-2', …) unless `failFor` matches the
// path (then an {ok:false} envelope is returned, like the real cache).
function loadHelper({ failFor = [], noCache = false } = {}) {
  const minted = [];
  let n = 0;
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (!noCache) {
    sandbox.GrantCache = {
      ensurePathGrant: async (p, op, opts) => {
        minted.push({ path: p, op, opts });
        if (failFor.some((f) => p.startsWith(f))) return { ok: false, error: 'mint failed' };
        n++;
        return 'grant-' + n;
      },
    };
  }
  sandbox.api = {
    mintGrant: () => {},
    pathDirname: (p) => String(p).replace(/[\\/][^\\/]*$/, ''),
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'grantHelper.js' });
  assert.ok(sandbox.GrantHelper, 'grantHelper.js must export window.GrantHelper');
  return { helper: sandbox.GrantHelper, minted };
}

test('B-002: mints one read grant per distinct local input path', async () => {
  const { helper, minted } = loadHelper();
  const args = [
    'video', 'generate',
    '--first-frame', 'C:\\refsA\\first.png',
    '--last-frame', 'D:\\refsB\\last.png',
    '--download', 'C:\\out\\v.mp4', // output flag — NOT a read target
  ];
  const ids = Array.from(await helper.ensureMmxReadGrants(args));
  assert.deepEqual(ids, ['grant-1', 'grant-2']);
  assert.deepEqual(minted.map((m) => m.path), ['C:\\refsA\\first.png', 'D:\\refsB\\last.png']);
  // Every mint must be a read grant (file kind, read capability).
  for (const m of minted) {
    assert.equal(m.op, 'read');
    assert.equal(m.opts.kind, 'file');
    assert.deepEqual(Array.from(m.opts.capabilities), ['read']);
  }
});

test('B-002: unwraps the --subject-ref composite and mints for the image= path', async () => {
  const { helper, minted } = loadHelper();
  const args = ['image', 'generate', '--subject-ref', 'type=character,image=C:\\refs\\face.png', '--out', 'C:\\out\\i.png'];
  const ids = Array.from(await helper.ensureMmxReadGrants(args));
  assert.deepEqual(ids, ['grant-1']);
  assert.deepEqual(minted.map((m) => m.path), ['C:\\refs\\face.png']);
});

test('B-002: https URLs are skipped (no local grant needed)', async () => {
  const { helper, minted } = loadHelper();
  const args = [
    'video', 'generate',
    '--first-frame', 'https://cdn.example.com/a.png',
    '--subject-image', 'C:\\refs\\subj.png',
  ];
  const ids = Array.from(await helper.ensureMmxReadGrants(args));
  assert.deepEqual(ids, ['grant-1']);
  assert.deepEqual(minted.map((m) => m.path), ['C:\\refs\\subj.png']);
});

test('B-002: duplicate paths are minted once', async () => {
  const { helper, minted } = loadHelper();
  const args = ['video', '--first-frame', 'C:\\refs\\a.png', '--last-frame', 'C:\\refs\\a.png'];
  const ids = Array.from(await helper.ensureMmxReadGrants(args));
  assert.deepEqual(ids, ['grant-1']);
  assert.equal(minted.length, 1);
});

test('B-002: a failed mint is skipped best-effort (main fails closed later)', async () => {
  const { helper } = loadHelper({ failFor: ['C:\\refsA'] });
  const args = ['video', '--first-frame', 'C:\\refsA\\a.png', '--last-frame', 'C:\\refsB\\b.png'];
  const ids = Array.from(await helper.ensureMmxReadGrants(args));
  assert.deepEqual(ids, ['grant-1']); // only the refsB grant survived
});

test('B-002: returns [] without GrantCache (bare harness) and for non-array args', async () => {
  const { helper } = loadHelper({ noCache: true });
  assert.deepEqual(Array.from(await helper.ensureMmxReadGrants(['video', '--first-frame', 'C:\\r\\a.png'])), []);
  const { helper: h2 } = loadHelper();
  assert.deepEqual(Array.from(await h2.ensureMmxReadGrants(null)), []);
});
