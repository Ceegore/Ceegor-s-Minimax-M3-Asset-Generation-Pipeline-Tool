// tests/unit/main/ipc/mmxPathAuthz.b002b003.test.js
// ============================================================================
// B-002 + B-003 — regression tests for the mmx path authoriser.
//
// B-002: `authorizeMmxPaths` accepts PLURAL read grants (string OR array).
//   An input path (e.g. --first-frame C:\refs\a.png) passes if ANY of the
//   supplied read grants authorises it. Renderer-minted per-file read
//   grants make local reference images work even when the output write
//   grant doesn't cover them. Backward compat: no read grants → fall back
//   to the write grantId.
//
// B-003: strict input typing. `collectMmxPathFlags` classifies input flag
//   values: `https://…` → kind 'url' (passes with NO grant); any other
//   URL scheme (http:, file:, ftp:, data:) fails closed in the authoriser;
//   plain values are LOCAL paths (kind 'input') requiring a read grant.
//   `--subject-ref` composites (`type=character,image=<path-or-url>`) are
//   unwrapped to the `image=` part before classification.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MMX_PATH_AUTHZ = path.join(ROOT, 'main', 'ipc', 'mmxPathAuthz.js');
const GRANT_AUTHORIZER = path.join(ROOT, 'main', 'ipc', 'grantAuthorizer.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');

// Load the module with a mocked PathGrantService. `perGrant` maps a
// grantId to the path prefixes it authorises — unknown grants reject
// everything. Without `perGrant`, every grantId authorises every path
// (mirrors the r15b1 mock).
function loadMod({ perGrant } = {}) {
  for (const p of [MMX_PATH_AUTHZ, GRANT_AUTHORIZER, PATH_GRANT]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  const defaultService = {
    authorize: (grantId, spec) => {
      if (!grantId) return { ok: false, error: 'grantId required' };
      if (!spec || typeof spec.path !== 'string') return { ok: false, error: 'path required' };
      if (perGrant) {
        const prefixes = perGrant[grantId];
        if (!prefixes) return { ok: false, error: 'unknown grant' };
        if (!prefixes.some((p) => spec.path.startsWith(p))) {
          return { ok: false, error: 'outside grant scope' };
        }
      }
      return { ok: true, canonicalPath: spec.path };
    },
    mintDirectoryGrant: () => ({ ok: true, grantId: 'g', grant: {} }),
    mintFileGrant: () => ({ ok: true, grantId: 'g', grant: {} }),
    revoke: () => ({ ok: true }),
    destroy: () => 0,
  };
  require.cache[require.resolve(PATH_GRANT)] = { exports: { defaultService } };
  return require(MMX_PATH_AUTHZ);
}

// ---- B-003: collectMmxPathFlags typing -----------------------------------

test('B-003: an https URL on an input flag is classified as kind "url"', () => {
  const m = loadMod();
  const r = m.collectMmxPathFlags(['video', 'generate', '--first-frame', 'https://cdn.example.com/a.png']);
  assert.deepEqual(r, [{ flag: '--first-frame', value: 'https://cdn.example.com/a.png', kind: 'url' }]);
});

test('B-003: a local path on an input flag stays kind "input"', () => {
  const m = loadMod();
  const r = m.collectMmxPathFlags(['video', 'generate', '--first-frame', 'C:\\refs\\a.png']);
  assert.deepEqual(r, [{ flag: '--first-frame', value: 'C:\\refs\\a.png', kind: 'input' }]);
});

test('B-002/B-003: --subject-ref composite is unwrapped to the image= path', () => {
  const m = loadMod();
  const r = m.collectMmxPathFlags(['image', 'generate', '--subject-ref', 'type=character,image=C:\\refs\\face.png']);
  assert.deepEqual(r, [{ flag: '--subject-ref', value: 'C:\\refs\\face.png', kind: 'input' }]);
});

test('B-003: --subject-ref composite with an https URL is kind "url"', () => {
  const m = loadMod();
  const r = m.collectMmxPathFlags(['image', 'generate', '--subject-ref', 'type=character,image=https://cdn.example.com/f.png']);
  assert.deepEqual(r, [{ flag: '--subject-ref', value: 'https://cdn.example.com/f.png', kind: 'url' }]);
});

test('B-003: output flags are never URL-typed (a URL --out stays kind "file")', () => {
  const m = loadMod();
  // Nonsense input, but the classifier must not weaken the write check.
  const r = m.collectMmxPathFlags(['image', '--out', 'https://evil.example.com/x.png']);
  assert.deepEqual(r, [{ flag: '--out', value: 'https://evil.example.com/x.png', kind: 'file' }]);
});

// ---- B-003: URL policy in the authoriser ----------------------------------

test('B-003: an https URL input passes with NO grant at all', () => {
  const m = loadMod();
  const flags = m.collectMmxPathFlags(['video', '--first-frame', 'https://cdn.example.com/a.png']);
  // No grantId, no readGrantIds — a pure-URL call needs no filesystem grant.
  assert.equal(m.authorizeMmxPaths(undefined, flags), null);
});

test('B-003: http / file / ftp / data URLs fail closed', () => {
  const m = loadMod();
  for (const bad of ['http://cdn.example.com/a.png', 'file:///C:/secrets/x.png', 'ftp://host/a.png', 'data://x']) {
    const flags = m.collectMmxPathFlags(['video', '--first-frame', bad]);
    const r = m.authorizeMmxPaths('g1', flags, undefined, ['g1']);
    assert.ok(r, `${bad} must be rejected`);
    assert.match(r, /only https:\/\//i);
  }
});

// ---- B-002: plural read grants ---------------------------------------------

test('B-002: an input path passes when ANY of the supplied read grants covers it', () => {
  const m = loadMod({ perGrant: {
    'g-out': ['C:\\out'],
    'g-ref': ['C:\\refs'],
  } });
  const flags = m.collectMmxPathFlags([
    'image', 'generate',
    '--subject-ref', 'type=character,image=C:\\refs\\face.png',
    '--out', 'C:\\out\\img.png',
  ]);
  // g-out (the write grant) does NOT cover C:\refs — only g-ref does.
  const r = m.authorizeMmxPaths('g-out', flags, undefined, ['g-ref']);
  assert.equal(r, null);
});

test('B-002: readGrantIds accepts a single string (back-compat)', () => {
  const m = loadMod({ perGrant: { 'g-out': ['C:\\out'], 'g-ref': ['C:\\refs'] } });
  const flags = m.collectMmxPathFlags(['video', '--first-frame', 'C:\\refs\\a.png', '--download', 'C:\\out\\v.mp4']);
  assert.equal(m.authorizeMmxPaths('g-out', flags, undefined, 'g-ref'), null);
});

test('B-002: multiple local refs each covered by a different read grant', () => {
  const m = loadMod({ perGrant: {
    'g-out': ['C:\\out'],
    'g-a': ['C:\\refsA'],
    'g-b': ['D:\\refsB'],
  } });
  const flags = m.collectMmxPathFlags([
    'video', 'generate',
    '--first-frame', 'C:\\refsA\\first.png',
    '--last-frame', 'D:\\refsB\\last.png',
    '--download', 'C:\\out\\v.mp4',
  ]);
  assert.equal(m.authorizeMmxPaths('g-out', flags, undefined, ['g-a', 'g-b']), null);
});

test('B-002: fails closed when no read grant covers the input path', () => {
  const m = loadMod({ perGrant: { 'g-out': ['C:\\out'], 'g-ref': ['C:\\refs'] } });
  const flags = m.collectMmxPathFlags(['video', '--first-frame', 'C:\\private\\x.png', '--download', 'C:\\out\\v.mp4']);
  const r = m.authorizeMmxPaths('g-out', flags, undefined, ['g-ref']);
  assert.ok(r, 'uncovered input path must fail closed');
  assert.match(r, /--first-frame/);
  assert.match(r, /read grant/i);
});

test('B-002: no readGrantIds → input falls back to the write grantId (back-compat)', () => {
  const m = loadMod({ perGrant: { 'g-out': ['C:\\out'] } });
  const flags = m.collectMmxPathFlags(['image', '--subject-ref', 'type=character,image=C:\\out\\face.png', '--out', 'C:\\out\\img.png']);
  assert.equal(m.authorizeMmxPaths('g-out', flags), null);
});

test('B-002: non-string entries in readGrantIds are ignored (fail closed when nothing valid remains)', () => {
  const m = loadMod();
  const flags = m.collectMmxPathFlags(['video', '--first-frame', 'C:\\refs\\a.png']);
  // No grantId either → nothing to authorise the input against.
  const r = m.authorizeMmxPaths(undefined, flags, undefined, [null, 42, {}, '']);
  assert.ok(r, 'must fail closed');
  assert.match(r, /readGrantId/i);
});

test('B-002: output paths are still checked ONLY against the write grantId (a read grant cannot smuggle a write)', () => {
  const m = loadMod({ perGrant: { 'g-out': ['C:\\out'], 'g-ref': ['C:\\refs'] } });
  const flags = m.collectMmxPathFlags(['image', '--out', 'C:\\refs\\evil.png']);
  const r = m.authorizeMmxPaths('g-out', flags, undefined, ['g-ref']);
  assert.ok(r, 'a write outside the write grant must fail even if a read grant covers it');
  assert.match(r, /--out/);
});
