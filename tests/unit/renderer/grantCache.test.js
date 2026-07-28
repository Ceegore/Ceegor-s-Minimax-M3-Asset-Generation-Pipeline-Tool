// tests/unit/renderer/grantCache.test.js
// ============================================================================
// R1.5a.follow-up Phase 2 — Renderer-side grant cache tests.
//
// The grantCache (renderer/services/grantCache.js) is a thin
// FIFO Map that maps (path, operation) to a grantId. It
// de-dupes concurrent mints for the same key and evicts
// oldest entries when the cap (256) is hit.
//
// Tests:
//   A. first call → IPC mint, return grantId
//   B. second call for same key → cache hit, NO new IPC call
//   C. different operation on same path → new IPC call
//   D. concurrent mints for same key → de-duped (1 IPC call)
//   E. invalid inputs (empty path, empty op) → error envelope
//   F. dropPathGrant removes the cached entry
//   G. clearPathGrants empties the cache
//   H. eviction at cap 256 (FIFO)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const grantCachePath = path.join(ROOT, 'renderer', 'services', 'grantCache.js');

// We mock window.api.mintGrant per test. The cache reads
// window.api on each call, so the mock must be set BEFORE the
// first ensurePathGrant call. To avoid cross-test pollution,
// we re-require the module per test (clears the internal _cache
// and _mintPromise).
function freshCache() {
  for (const p of [grantCachePath]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  return require(grantCachePath);
}

function mockWindowApi(impl) {
  global.window = { api: impl };
}

test.afterEach(() => {
  delete global.window;
});

// ---------------------------------------------------------------------------
// A — first call → IPC mint
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.A: first call invokes mintGrant IPC and returns grantId', async () => {
  mockWindowApi({ mintGrant: async (p, op) => ({ ok: true, grantId: 'grant-A' }) });
  const { ensurePathGrant, clearPathGrants } = freshCache();
  clearPathGrants();
  const r = await ensurePathGrant('/a.png', 'read');
  assert.equal(r, 'grant-A', 'A: must return the minted grantId');
});

// ---------------------------------------------------------------------------
// B — second call for same key → cache hit
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.B: second call for same (path, op) is a cache hit (no new IPC call)', async () => {
  let calls = 0;
  mockWindowApi({ mintGrant: async () => { calls++; return { ok: true, grantId: 'grant-' + calls }; } });
  const { ensurePathGrant, clearPathGrants } = freshCache();
  clearPathGrants();
  const r1 = await ensurePathGrant('/a.png', 'read');
  const r2 = await ensurePathGrant('/a.png', 'read');
  assert.equal(r1, r2, 'B: same key must return same grantId');
  assert.equal(calls, 1, 'B: only 1 IPC call. Got: ' + calls);
});

// ---------------------------------------------------------------------------
// C — different operation on same path → new IPC call
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.C: different operation on same path → new IPC call', async () => {
  let calls = 0;
  mockWindowApi({ mintGrant: async () => { calls++; return { ok: true, grantId: 'grant-' + calls }; } });
  const { ensurePathGrant, clearPathGrants } = freshCache();
  clearPathGrants();
  const r1 = await ensurePathGrant('/a.png', 'read');
  const r2 = await ensurePathGrant('/a.png', 'write');
  assert.notEqual(r1, r2, 'C: different ops must yield different grantIds');
  assert.equal(calls, 2, 'C: 2 IPC calls. Got: ' + calls);
});

// ---------------------------------------------------------------------------
// D — concurrent mints for same key → de-duped
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.D: concurrent mints for same key are de-duped (1 IPC call)', async () => {
  let calls = 0;
  mockWindowApi({ mintGrant: async () => { calls++; return { ok: true, grantId: 'concurrent-' + calls }; } });
  const { ensurePathGrant, clearPathGrants } = freshCache();
  clearPathGrants();
  const [r1, r2, r3] = await Promise.all([
    ensurePathGrant('/b.png', 'read'),
    ensurePathGrant('/b.png', 'read'),
    ensurePathGrant('/b.png', 'read'),
  ]);
  assert.equal(r1, r2, 'D: same key → same grantId');
  assert.equal(r2, r3, 'D: same key → same grantId');
  assert.equal(calls, 1, 'D: only 1 IPC call. Got: ' + calls);
});

// ---------------------------------------------------------------------------
// E — invalid inputs
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.E: empty path → error envelope (no throw)', async () => {
  mockWindowApi({ mintGrant: async () => ({ ok: true, grantId: 'never-called' }) });
  const { ensurePathGrant, clearPathGrants } = freshCache();
  clearPathGrants();
  const r = await ensurePathGrant('', 'read');
  assert.equal(r.ok, false, 'E: empty path → error envelope');
  assert.ok(r.error.includes('path'), 'E: error must mention path. Got: ' + r.error);
});

test('R1.5a.follow-up.E.b: empty operation → error envelope (no throw)', async () => {
  mockWindowApi({ mintGrant: async () => ({ ok: true, grantId: 'never-called' }) });
  const { ensurePathGrant, clearPathGrants } = freshCache();
  clearPathGrants();
  const r = await ensurePathGrant('/a.png', '');
  assert.equal(r.ok, false, 'E.b: empty op → error envelope');
  assert.ok(r.error.includes('operation'), 'E.b: error must mention operation. Got: ' + r.error);
});

test('R1.5a.follow-up.E.c: mintGrant IPC failure → error envelope (no throw)', async () => {
  mockWindowApi({ mintGrant: async () => ({ ok: false, error: 'ipc failure' }) });
  const { ensurePathGrant, clearPathGrants } = freshCache();
  clearPathGrants();
  const r = await ensurePathGrant('/a.png', 'read');
  assert.equal(r.ok, false, 'E.c: IPC failure → error envelope');
  assert.equal(r.error, 'ipc failure', 'E.c: error must be propagated. Got: ' + r.error);
});

test('R1.5a.follow-up.E.d: window.api.mintGrant missing → error envelope (no throw)', async () => {
  global.window = { api: {} };
  const { ensurePathGrant, clearPathGrants } = freshCache();
  clearPathGrants();
  const r = await ensurePathGrant('/a.png', 'read');
  assert.equal(r.ok, false, 'E.d: missing mintGrant → error envelope');
  assert.ok(r.error.includes('mintGrant is not available'), 'E.d: error must mention mintGrant. Got: ' + r.error);
});

// ---------------------------------------------------------------------------
// F — dropPathGrant
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.F: dropPathGrant removes the cached entry', async () => {
  let calls = 0;
  mockWindowApi({ mintGrant: async () => { calls++; return { ok: true, grantId: 'g' + calls }; } });
  const { ensurePathGrant, dropPathGrant, clearPathGrants } = freshCache();
  clearPathGrants();
  await ensurePathGrant('/a.png', 'read');
  assert.equal(calls, 1, 'F: pre-drop: 1 IPC call');
  dropPathGrant('/a.png', 'read');
  const r = await ensurePathGrant('/a.png', 'read');
  assert.equal(calls, 2, 'F: post-drop: 2 IPC calls (cache miss after drop)');
  assert.equal(r, 'g2', 'F: post-drop: new grantId');
});

// ---------------------------------------------------------------------------
// G — clearPathGrants
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.G: clearPathGrants empties the cache', async () => {
  let calls = 0;
  mockWindowApi({ mintGrant: async () => { calls++; return { ok: true, grantId: 'g' + calls }; } });
  const { ensurePathGrant, clearPathGrants } = freshCache();
  await ensurePathGrant('/a.png', 'read');
  await ensurePathGrant('/b.png', 'read');
  assert.equal(calls, 2, 'G: pre-clear: 2 IPC calls');
  clearPathGrants();
  await ensurePathGrant('/a.png', 'read');
  assert.equal(calls, 3, 'G: post-clear: 3 IPC calls (cache miss after clear)');
});

// ---------------------------------------------------------------------------
// H — eviction at cap 256 (FIFO)
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.H: cap 256 FIFO eviction', async () => {
  let calls = 0;
  mockWindowApi({ mintGrant: async (p) => { calls++; return { ok: true, grantId: 'g-' + p }; } });
  const { ensurePathGrant, clearPathGrants, MAX_ENTRIES } = freshCache();
  clearPathGrants();
  // Fill cache with 256 entries
  for (let i = 0; i < MAX_ENTRIES; i++) {
    await ensurePathGrant('/p-' + i + '.png', 'read');
  }
  assert.equal(calls, MAX_ENTRIES, 'H: ' + MAX_ENTRIES + ' IPC calls. Got: ' + calls);
  // Add one more — should evict the oldest (FIFO)
  await ensurePathGrant('/p-new.png', 'read');
  assert.equal(calls, MAX_ENTRIES + 1, 'H: 257th call evicts oldest');
  // The first key should now be a cache miss
  calls = 0;
  await ensurePathGrant('/p-0.png', 'read');
  assert.equal(calls, 1, 'H: oldest key was evicted and re-minted. Got: ' + calls);
  // The last key should be a cache hit
  calls = 0;
  await ensurePathGrant('/p-new.png', 'read');
  assert.equal(calls, 0, 'H: newest key is still cached. Got: ' + calls);
});

// ---------------------------------------------------------------------------
// I — R1.5a.follow-up Phase 5: revoke-on-eviction. When the FIFO
//     evicts the oldest entry, the associated grantId is
//     fire-and-forget-revoked via window.api.revokeGrant. Without
//     this, PathGrantService entries leak until app restart (the
//     grants are multi-use and have no TTL).
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.I: cap eviction also revokes the evicted grantId', async () => {
  const revoked = [];
  mockWindowApi({
    mintGrant: async (p) => ({ ok: true, grantId: 'g-' + p }),
    revokeGrant: (id) => { revoked.push(id); return Promise.resolve({ ok: true }); },
  });
  const { ensurePathGrant, clearPathGrants, MAX_ENTRIES } = freshCache();
  clearPathGrants();
  for (let i = 0; i < MAX_ENTRIES; i++) {
    await ensurePathGrant('/p-' + i + '.png', 'read');
  }
  assert.equal(revoked.length, 0, 'I: pre-evict: 0 revokes');
  // Add one more → evicts /p-0.png which had grantId 'g-/p-0.png'
  await ensurePathGrant('/p-new.png', 'read');
  // Fire-and-forget — give the microtask queue a tick to drain
  await new Promise((r) => setImmediate(r));
  assert.equal(revoked.length, 1, 'I: 1 revoke (the evicted oldest). Got: ' + revoked.length);
  assert.equal(revoked[0], 'g-/p-0.png', 'I: revoked grantId must be the evicted one');
});

test('R1.5a.follow-up.I.b: eviction revoke is best-effort (IPC failure does not throw)', async () => {
  mockWindowApi({
    mintGrant: async (p) => ({ ok: true, grantId: 'g-' + p }),
    revokeGrant: () => { throw new Error('IPC down'); },
  });
  const { ensurePathGrant, clearPathGrants, MAX_ENTRIES } = freshCache();
  clearPathGrants();
  for (let i = 0; i < MAX_ENTRIES; i++) {
    await ensurePathGrant('/p-' + i + '.png', 'read');
  }
  // This must NOT throw even though revokeGrant throws.
  await ensurePathGrant('/p-new.png', 'read');
  await new Promise((r) => setImmediate(r));
  // No assertion needed — test passes if no throw.
});

// ---------------------------------------------------------------------------
// J — R1.5a.follow-up Phase 5: revokeAllAndClear. Used by the
//     renderer's onBeforeQuit handler to free server-side state
//     at shutdown. The cache is cleared AND every cached grantId
//     is revoked via window.api.revokeGrant. Returns stats
//     {revoked, failed}.
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.J: revokeAllAndClear revokes every cached grantId and empties the cache', async () => {
  const revoked = [];
  mockWindowApi({
    mintGrant: async (p) => ({ ok: true, grantId: 'g-' + p }),
    revokeGrant: (id) => { revoked.push(id); return Promise.resolve({ ok: true }); },
  });
  const { ensurePathGrant, revokeAllAndClear, clearPathGrants } = freshCache();
  clearPathGrants();
  await ensurePathGrant('/a.png', 'read');
  await ensurePathGrant('/b.png', 'read');
  await ensurePathGrant('/c.png', 'read');
  assert.equal(revoked.length, 0, 'J: pre-revokeAll: 0 revokes');
  const stats = await revokeAllAndClear();
  assert.equal(stats.revoked, 3, 'J: 3 grants revoked. Got: ' + stats.revoked);
  assert.equal(stats.failed, 0, 'J: 0 failed revokes');
  assert.deepEqual(revoked.sort(), ['g-/a.png', 'g-/b.png', 'g-/c.png'].sort(),
    'J: every grantId revoked exactly once');
  // Cache is now empty — re-calling ensurePathGrant for the same
  // path must re-mint.
  let mintCalls = 0;
  global.window.api.mintGrant = async (p) => { mintCalls++; return { ok: true, grantId: 'g2-' + p }; };
  await ensurePathGrant('/a.png', 'read');
  assert.equal(mintCalls, 1, 'J: cache cleared, ensurePathGrant re-mints');
});

test('R1.5a.follow-up.J.b: revokeAllAndClear counts failed revokes and still clears the cache', async () => {
  mockWindowApi({
    mintGrant: async (p) => ({ ok: true, grantId: 'g-' + p }),
    revokeGrant: (id) => {
      // First one fails, the rest succeed
      if (id === 'g-/a.png') return Promise.resolve({ ok: false, error: 'grant already gone' });
      return Promise.resolve({ ok: true });
    },
  });
  const { ensurePathGrant, revokeAllAndClear, clearPathGrants } = freshCache();
  clearPathGrants();
  await ensurePathGrant('/a.png', 'read');
  await ensurePathGrant('/b.png', 'read');
  await ensurePathGrant('/c.png', 'read');
  const stats = await revokeAllAndClear();
  assert.equal(stats.revoked, 2, 'J.b: 2 succeeded');
  assert.equal(stats.failed, 1, 'J.b: 1 failed (the "already gone" one)');
  // Cache is cleared regardless of revoke results
  let mintCalls = 0;
  global.window.api.mintGrant = async (p) => { mintCalls++; return { ok: true, grantId: 'g2-' + p }; };
  await ensurePathGrant('/a.png', 'read');
  assert.equal(mintCalls, 1, 'J.b: cache cleared even when some revokes failed');
});

test('R1.5a.follow-up.J.c: revokeAllAndClear handles missing window.api.revokeGrant gracefully', async () => {
  mockWindowApi({ mintGrant: async (p) => ({ ok: true, grantId: 'g-' + p }) });
  const { ensurePathGrant, revokeAllAndClear, clearPathGrants } = freshCache();
  clearPathGrants();
  await ensurePathGrant('/a.png', 'read');
  // No revokeGrant on window.api — revokeAllAndClear must not throw.
  const stats = await revokeAllAndClear();
  assert.equal(stats.revoked, 0, 'J.c: 0 revoked (no revokeGrant available)');
  assert.equal(stats.failed, 0, 'J.c: 0 failed (silently skipped)');
});

// ---------------------------------------------------------------------------
// K — R1.5a.follow-up Phase 6: opts parameter (kind + capabilities).
//     The grantCache must forward the 3rd arg to window.api.mintGrant
//     so the IPC can mint directory grants + multi-capability grants
//     (the read+write sibling-write pattern).
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.K: ensurePathGrant forwards opts to mintGrant (kind=directory)', async () => {
  const mintCalls = [];
  mockWindowApi({
    mintGrant: async (p, op, opts) => {
      mintCalls.push({ p, op, opts });
      return { ok: true, grantId: 'g-dir' };
    },
  });
  const { ensurePathGrant, clearPathGrants } = freshCache();
  clearPathGrants();
  const g = await ensurePathGrant('/work/output', 'read', { kind: 'directory', capabilities: ['read', 'write'] });
  assert.equal(g, 'g-dir', 'K: must return the grantId');
  assert.equal(mintCalls.length, 1, 'K: 1 mint call');
  assert.equal(mintCalls[0].opts.kind, 'directory', 'K: opts.kind forwarded');
  assert.deepEqual(mintCalls[0].opts.capabilities, ['read', 'write'], 'K: opts.capabilities forwarded');
});

test('R1.5a.follow-up.K.b: ensurePathGrant with opts does NOT collide with same (path, op) without opts', async () => {
  // Cache key must include opts (otherwise a file-grant+read could
  // shadow a directory-grant+read-write for the same path).
  const grants = { file: 'g-file', dir: 'g-dir' };
  mockWindowApi({
    mintGrant: async (p, op, opts) => {
      if (opts && opts.kind === 'directory') return { ok: true, grantId: grants.dir };
      return { ok: true, grantId: grants.file };
    },
  });
  const { ensurePathGrant, clearPathGrants } = freshCache();
  clearPathGrants();
  const gFile = await ensurePathGrant('/work/output', 'read');
  const gDir = await ensurePathGrant('/work/output', 'read', { kind: 'directory', capabilities: ['read', 'write'] });
  assert.equal(gFile, grants.file, 'K.b: file-grant grantId');
  assert.equal(gDir, grants.dir, 'K.b: directory-grant grantId (different cache entry)');
});

test('R1.5a.follow-up.K.c: ensurePathGrant with no opts is backward-compatible (file grant, single cap)', async () => {
  const mintCalls = [];
  mockWindowApi({
    mintGrant: async (p, op, opts) => {
      mintCalls.push({ p, op, opts });
      return { ok: true, grantId: 'g-bw' };
    },
  });
  const { ensurePathGrant, clearPathGrants } = freshCache();
  clearPathGrants();
  const g = await ensurePathGrant('/a.png', 'write');
  assert.equal(g, 'g-bw');
  assert.equal(mintCalls.length, 1);
  assert.equal(mintCalls[0].opts, undefined, 'K.c: no opts forwarded (backward-compat)');
});
