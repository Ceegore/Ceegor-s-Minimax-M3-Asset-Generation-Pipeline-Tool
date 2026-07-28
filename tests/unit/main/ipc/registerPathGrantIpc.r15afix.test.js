// tests/unit/main/ipc/registerPathGrantIpc.r15afix.test.js
// ============================================================================
// R1.5a.follow-up — pathGrant:mint IPC (renderer-side grant-mint helper).
//
// The IPC closes the R1.5a grantId-gap where renderer-callsites
// (preload.js + section07 + imageEditorHeal + imageEditorActions +
// pipelineImport + pipelineReport) did not pass a grantId to
// mutation IPCs (image:optimize, image:resize, image:fixExtension,
// fb:write, fb:delete, inpaint:runTelea, inpaint:runOnnx). The
// new IPC lets the renderer request a Main-minted grant BEFORE
// the mutation call, then pass the returned grantId to the
// mutation IPC.
//
// Tests:
//   A. happy path: valid (path, operation) → {ok, grantId}
//   B. invalid operation (not in allowlist) → REJECTED
//   C. invalid path (empty/non-string) → REJECTED
//   D. grant is usable: minted grantId authorises read on the same path
//   E. grant is multi-use: same grantId can be reused for multiple operations
//   F. revoke: after revoke, grantId no longer authorises
//   G. integration: mint + image:optimize call (the original bug) succeeds
//   H. invalid capability (defence-in-depth): not passed through
//   I. revoke with empty grantId → REJECTED
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
const PATH_GRANT_IPC = path.join(ROOT, 'main', 'ipc', 'registerPathGrantIpc.js');
const GRANT_AUTHORIZER = path.join(ROOT, 'main', 'ipc', 'grantAuthorizer.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const IMAGE_OPTIMIZER = path.join(ROOT, 'src', 'imageOptimizer.js');
const REGISTER_IMAGE_IPC = path.join(ROOT, 'main', 'ipc', 'registerImageIpc.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15afix-grant-'));

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---- Helper: load registerPathGrantIpc with stubbed electron + add TMP as trust root ----
function loadIpc({ alsoLoadImageIpc = false } = {}) {
  for (const p of [PATH_GRANT_IPC, PATH_GRANT, GRANT_AUTHORIZER, PATH_SECURITY, IMAGE_OPTIMIZER, REGISTER_IMAGE_IPC]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
  };
  require.cache[require.resolve('electron')] = {
    exports: { ipcMain },
  };
  const register = require(PATH_GRANT_IPC).register;
  register({ appRoot: TMP });
  // R1.5a.follow-up AuditFix: pathGrant:mint now enforces a trust-root
  // check (the renderer can only mint grants for paths the user has
  // already trusted via file:pick / config / app-output). Tests that
  // need a successful mint must pre-trust the TMP dir.
  require(PATH_SECURITY).addTrusted(TMP);
  if (alsoLoadImageIpc) {
    // Also load registerImageIpc so we can test the integration.
    require(REGISTER_IMAGE_IPC).register({ appRoot: TMP });
  }
  // Also load PathGrantService.defaultService so the test can authorise
  // grants minted by the IPC.
  const pathGrantService = require(PATH_GRANT);
  return { handlers, pathGrantService };
}

// ---------------------------------------------------------------------------
// A — happy path
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.A: pathGrant:mint happy path: valid (path, read) → {ok, grantId}', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('pathGrant:mint')({}, path.join(TMP, 'a.png'), 'read');
  assert.equal(r.ok, true);
  assert.ok(typeof r.grantId === 'string' && r.grantId.length > 0,
    'A: grantId must be a non-empty string. Got: ' + JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// B — invalid operation
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.B: pathGrant:mint with invalid operation → REJECTED', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('pathGrant:mint')({}, path.join(TMP, 'b.png'), 'invalid-op');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('Operation must be one of'),
    'B: error must mention valid operations. Got: ' + r.error);
});

// ---------------------------------------------------------------------------
// C — invalid path
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.C: pathGrant:mint with empty path → REJECTED', async () => {
  const { handlers } = loadIpc();
  const r1 = await handlers.get('pathGrant:mint')({}, '', 'read');
  assert.equal(r1.ok, false);
  assert.ok(r1.error.toLowerCase().includes('path is required'),
    'C: error must mention required path. Got: ' + r1.error);
  const r2 = await handlers.get('pathGrant:mint')({}, null, 'read');
  assert.equal(r2.ok, false);
  const r3 = await handlers.get('pathGrant:mint')({}, undefined, 'read');
  assert.equal(r3.ok, false);
});

// ---------------------------------------------------------------------------
// D — grant is usable (authorisation works)
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.D: pathGrant:mint grantId is usable for authorise', async () => {
  const { handlers, pathGrantService } = loadIpc();
  const p = path.join(TMP, 'd.png');
  const r = await handlers.get('pathGrant:mint')({}, p, 'read');
  assert.equal(r.ok, true);
  // Authorise the minted grant
  const auth = pathGrantService.defaultService.authorize(r.grantId, {
    operation: 'read', path: p,
  });
  assert.equal(auth.ok, true,
    'D: freshly minted grant must authorise. Got: ' + JSON.stringify(auth));
});

// ---------------------------------------------------------------------------
// E — grant is multi-use
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.E: pathGrant:mint grantId can be reused (multi-use)', async () => {
  const { handlers, pathGrantService } = loadIpc();
  const p = path.join(TMP, 'e.png');
  const r = await handlers.get('pathGrant:mint')({}, p, 'read');
  assert.equal(r.ok, true);
  // Authorise 3 times — should all succeed
  for (let i = 0; i < 3; i++) {
    const auth = pathGrantService.defaultService.authorize(r.grantId, {
      operation: 'read', path: p,
    });
    assert.equal(auth.ok, true, 'E: iteration ' + i + ' must succeed. Got: ' + JSON.stringify(auth));
  }
});

// ---------------------------------------------------------------------------
// F — revoke
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.F: pathGrant:revoke makes grantId unusable', async () => {
  const { handlers, pathGrantService } = loadIpc();
  const p = path.join(TMP, 'f.png');
  const r = await handlers.get('pathGrant:mint')({}, p, 'read');
  assert.equal(r.ok, true);
  // Confirm usable
  let auth = pathGrantService.defaultService.authorize(r.grantId, {
    operation: 'read', path: p,
  });
  assert.equal(auth.ok, true, 'F: pre-revoke must succeed');
  // Revoke
  const rev = await handlers.get('pathGrant:revoke')({}, r.grantId);
  assert.equal(rev.ok, true, 'F: revoke must succeed');
  // Now unusable
  auth = pathGrantService.defaultService.authorize(r.grantId, {
    operation: 'read', path: p,
  });
  assert.equal(auth.ok, false, 'F: post-revoke must fail. Got: ' + JSON.stringify(auth));
});

// ---------------------------------------------------------------------------
// G — integration with image:optimize
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.G: image:optimize with mint+grantId succeeds (the original R1.5a bug)', async () => {
  // The R1.5a bug: the renderer did not pass a grantId to image:optimize,
  // causing every call to fail with 'grantId is required for read on <path>'.
  // The fix: renderer calls `mintGrant(srcPath, 'read')` first, then
  // passes the grantId to image:optimize.
  const { handlers, pathGrantService } = loadIpc({ alsoLoadImageIpc: true });
  // Create a real PNG file (tiny 1x1) for the optimize handler to work on
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const src = path.join(TMP, 'optimize-integration.png');
  fs.writeFileSync(src, png);
  // Mint a read grant
  const mintR = await handlers.get('pathGrant:mint')({}, src, 'read');
  assert.equal(mintR.ok, true, 'G: mint must succeed');
  // Now call image:optimize with the grantId — this should NOT fail
  // with 'grantId is required'.
  const out = await handlers.get('image:optimize')({}, src, {}, mintR.grantId);
  // We don't assert on success (sharp may or may not be available in
  // the test env), but we DO assert that it's NOT a 'grantId required'
  // failure — that was the original bug.
  if (!out.ok) {
    assert.ok(!out.error.includes('grantId is required'),
      'G: original R1.5a bug must NOT recur. Got: ' + out.error);
  }
});

// ---------------------------------------------------------------------------
// H — invalid capability (defence-in-depth)
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.H: invalid capability in mint request is rejected (defence-in-depth)', async () => {
  // PathGrantService.mintFileGrant does NOT validate capabilities
  // (a renderer could pass capabilities: ['arbitrary-capability']).
  // The IPC layer restricts to the 7 valid operations.
  // (This test is covered by B: 'invalid-op' is not in the allowlist.)
  // Plus: the IPC's allowlist prevents even a valid operation with
  // a custom path-like capability.
  const { handlers } = loadIpc();
  const r = await handlers.get('pathGrant:mint')({}, path.join(TMP, 'h.png'), 'delete');
  assert.equal(r.ok, true, 'H: delete is a valid operation');
  // We can't easily test the capabilities-restriction at the IPC
  // layer because the IPC hardcodes capabilities: [operation].
  // The defence-in-depth is the IPC allowlist on `operation`, which
  // is tested by B.
});

// ---------------------------------------------------------------------------
// I — revoke with empty grantId
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.I: pathGrant:revoke with empty grantId → REJECTED', async () => {
  const { handlers } = loadIpc();
  const r1 = await handlers.get('pathGrant:revoke')({}, '');
  assert.equal(r1.ok, false);
  const r2 = await handlers.get('pathGrant:revoke')({}, null);
  assert.equal(r2.ok, false);
  const r3 = await handlers.get('pathGrant:revoke')({}, undefined);
  assert.equal(r3.ok, false);
});

// ---------------------------------------------------------------------------
// J — all 7 valid operations work
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.J: all 7 valid operations mint successfully', async () => {
  const { handlers } = loadIpc();
  for (const op of ['read', 'write', 'delete', 'mkdir', 'rename', 'copy', 'move']) {
    const r = await handlers.get('pathGrant:mint')({}, path.join(TMP, 'op-' + op + '.png'), op);
    assert.equal(r.ok, true, 'J: ' + op + ' must succeed. Got: ' + JSON.stringify(r));
    assert.ok(r.grantId, 'J: ' + op + ' must return grantId');
  }
});

// ---------------------------------------------------------------------------
// K — R1.5a.follow-up AuditFix: trust-root check (CRITICAL security)
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.K: pathGrant:mint with untrusted path → REJECTED (CRITICAL security fix)', async () => {
  // Before the AuditFix, any renderer could mint a grant for
  // C:\Windows\System32\notepad.exe (or any other system path) by
  // calling `window.api.mintGrant(path, 'read')`. The minted grant
  // was then usable by every R1.5a mutation handler. This
  // re-opened the SYS-001 trust-root attack surface.
  //
  // The fix: pathGrant:mint now checks
  // PathSecurityService.isPathUnderAny(path) and rejects any path
  // not in the current trust roots. The renderer is expected to
  // ask the user to pick the file/folder first (via file:pick,
  // which auto-trusts the parent) and only then mint a grant.
  const { handlers } = loadIpc();
  // TMP is the ONLY trust-root in this test (the loadIpc helper
  // adds it). C:\Windows\System32\notepad.exe is outside TMP, so
  // the mint must be REJECTED.
  const r = await handlers.get('pathGrant:mint')({}, 'C:\\Windows\\System32\\notepad.exe', 'read');
  assert.equal(r.ok, false, 'K: system path mint must be REJECTED');
  assert.ok(r.error.includes('not in an allowed root'),
    'K: error must mention "not in an allowed root". Got: ' + r.error);
});

test('R1.5a.follow-up.K.b: pathGrant:mint with tmpdir path (trusted) → succeeds', async () => {
  // After the AuditFix, only paths under the trust-root set are
  // mintable. The TMP dir is trusted by the loadIpc helper. A
  // mint for a TMP path must succeed.
  const { handlers } = loadIpc();
  const r = await handlers.get('pathGrant:mint')({}, path.join(TMP, 'kb.png'), 'read');
  assert.equal(r.ok, true, 'K.b: trusted-path mint must succeed');
});

// ---------------------------------------------------------------------------
// L — R1.5a.follow-up AuditFix: revoke-error-propagation
// ---------------------------------------------------------------------------
test('R1.5a.follow-up.L: pathGrant:revoke with non-existent grantId → error envelope (no silent success)', async () => {
  // Before the AuditFix, the IPC silently returned {ok: true} for
  // any grantId — even garbage or already-revoked ones. A
  // renderer that typo'd a grantId would think the revoke
  // succeeded, but the underlying grant was unchanged (silent
  // state-drift). The fix propagates the service's return value.
  const { handlers } = loadIpc();
  const r = await handlers.get('pathGrant:revoke')({}, 'non-existent-grant-12345');
  assert.equal(r.ok, false, 'L: revoke of non-existent must FAIL');
  assert.ok(r.error.includes('grant not found'),
    'L: error must mention "grant not found". Got: ' + r.error);
});

test('R1.5a.follow-up.L.b: pathGrant:revoke with already-revoked grantId (KNOWN service behaviour — out of R1.5a.follow-up scope)', async () => {
  // Pre-existing PathGrantService.revoke behaviour: returns {ok:true}
  // even for non-existent / already-revoked grantIds (the service's
  // revoke() is a Map.delete(), so second-revoke is a no-op that
  // silently succeeds). This is documented in
  // tests/unit/security/parallelCollision.security.test.js. The
  // R1.5a.follow-up IPC fix (L) propagates the service's return
  // value — so a future service-side fix to revoke() would
  // automatically surface as an error here.
  //
  // For now: this test documents the current behaviour so the
  // behaviour doesn't drift silently.
  const { handlers } = loadIpc();
  const p = path.join(TMP, 'lb.png');
  const m = await handlers.get('pathGrant:mint')({}, p, 'read');
  assert.equal(m.ok, true);
  const r1 = await handlers.get('pathGrant:revoke')({}, m.grantId);
  assert.equal(r1.ok, true, 'L.b: first revoke must succeed');
  const r2 = await handlers.get('pathGrant:revoke')({}, m.grantId);
  // KNOWN ISSUE: PathGrantService.revoke returns {ok:true} for
  // already-revoked grants. This is a service-side issue, not an
  // IPC-side issue. The IPC correctly propagates whatever the
  // service returns. If/when the service is fixed, this test
  // should be updated to expect {ok:false, error:'grant not found'}.
  assert.equal(r2.ok, true, 'L.b (KNOWN ISSUE): second revoke currently silent-success (service bug, not IPC bug)');
});

// ============================================================================
// R1.5a.follow-up Phase 6 — directory-grant + multi-capability opts.
//
// Background: the R1.5a.follow-up Phases 1-4b renderer-callsites
// minted FILE grants with a SINGLE capability ('read'). The
// handler's write-check on the sibling output (optimize/resize/
// inpaint/removeBg all write to a sibling of the source) then
// failed with "operation 'write' not permitted by grant
// capabilities (read)". Result: every production mutation
// call returned an error. Phase 6 adds (a) directory-grant kind
// (so one grant covers source + sibling output) and (b)
// multi-capability (so one grant covers both read AND write).
// ============================================================================

test('R1.5a.follow-up Phase 6.M: pathGrant:mint with {kind: "directory"} mints a directory grant', async () => {
  const { handlers } = loadIpc();
  const dir = path.join(TMP, 'm-dir');
  fs.mkdirSync(dir, { recursive: true });
  const m = await handlers.get('pathGrant:mint')({}, dir, 'read', { kind: 'directory' });
  assert.equal(m.ok, true, 'M: directory-grant mint must succeed: ' + (m && m.error));
  // Verify the grant kind by using it to authorise a descendant.
  const { defaultService } = require(PATH_GRANT);
  const authz = defaultService.authorize(m.grantId, { operation: 'read', path: path.join(dir, 'a.png') });
  assert.equal(authz.ok, true,
    'M: directory grant must authorise a descendant file. Got: ' + (authz && authz.error));
  // The directory grant does NOT authorise the root itself (S1 §2.5:
  // directory grants cover strict descendants only).
  const authzRoot = defaultService.authorize(m.grantId, { operation: 'read', path: dir });
  assert.equal(authzRoot.ok, false,
    'M: directory grant must NOT authorise the root itself (S1 §2.5 strict-descendant)');
});

test('R1.5a.follow-up Phase 6.N: pathGrant:mint with {capabilities: ["read","write"]} mints a multi-cap grant', async () => {
  const { handlers } = loadIpc();
  const p = path.join(TMP, 'n-multi.png');
  fs.writeFileSync(p, 'fake');
  const m = await handlers.get('pathGrant:mint')({}, p, 'read', { capabilities: ['read', 'write'] });
  assert.equal(m.ok, true, 'N: multi-cap mint must succeed: ' + (m && m.error));
  // Verify BOTH capabilities are present.
  const { defaultService } = require(PATH_GRANT);
  const readOk = defaultService.authorize(m.grantId, { operation: 'read', path: p });
  const writeOk = defaultService.authorize(m.grantId, { operation: 'write', path: p });
  assert.equal(readOk.ok, true, 'N: read must succeed. Got: ' + (readOk && readOk.error));
  assert.equal(writeOk.ok, true, 'N: write must succeed. Got: ' + (writeOk && writeOk.error));
});

test('R1.5a.follow-up Phase 6.O: directory + multi-cap grant covers source-read + sibling-output-write (THE production flow)', async () => {
  // The Phase 6 close: a directory grant on the PARENT of srcPath
  // with capabilities ['read', 'write'] must authorise BOTH the
  // source file (read) AND a sibling in the same directory (write).
  // This is the exact pattern every Phase 6 callsite uses.
  const { handlers } = loadIpc();
  const parent = path.join(TMP, 'o-prod');
  fs.mkdirSync(parent, { recursive: true });
  const src = path.join(parent, 'src.png');
  const dst = path.join(parent, 'src_optimized.png');
  fs.writeFileSync(src, 'fake');
  const m = await handlers.get('pathGrant:mint')({}, parent, 'read', {
    kind: 'directory', capabilities: ['read', 'write'],
  });
  assert.equal(m.ok, true, 'O: directory+multi-cap mint must succeed: ' + (m && m.error));
  const { defaultService } = require(PATH_GRANT);
  const readOk = defaultService.authorize(m.grantId, { operation: 'read', path: src });
  const writeOk = defaultService.authorize(m.grantId, { operation: 'write', path: dst });
  assert.equal(readOk.ok, true, 'O: source-read must succeed');
  assert.equal(writeOk.ok, true, 'O: sibling-output-write must succeed (the Phase 6 fix)');
});

test('R1.5a.follow-up Phase 6.P: invalid kind is REJECTED (defence-in-depth)', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('pathGrant:mint')({}, TMP, 'read', { kind: 'banana' });
  assert.equal(r.ok, false, 'P: invalid kind must reject');
  assert.ok(r.error.includes('kind'), 'P: error must mention "kind"');
});

test('R1.5a.follow-up Phase 6.Q: empty capabilities array is REJECTED', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('pathGrant:mint')({}, TMP, 'read', { capabilities: [] });
  assert.equal(r.ok, false, 'Q: empty capabilities must reject');
});

test('R1.5a.follow-up Phase 6.R: invalid capability value is REJECTED', async () => {
  const { handlers } = loadIpc();
  const r = await handlers.get('pathGrant:mint')({}, TMP, 'read', { capabilities: ['read', 'banana'] });
  assert.equal(r.ok, false, 'R: invalid capability value must reject');
});

test('R1.5a.follow-up Phase 6.S: opts is ignored when not an object (backward compat)', async () => {
  // Defensive: a renderer bug that passes opts=42 (or 'x', or
  // null) should NOT crash the IPC. Default behaviour (file grant,
  // single capability) should apply.
  const { handlers } = loadIpc();
  const p = path.join(TMP, 's-bw.png');
  fs.writeFileSync(p, 'fake');
  const r = await handlers.get('pathGrant:mint')({}, p, 'read', 42);
  assert.equal(r.ok, true, 'S: non-object opts must NOT break mint. Got: ' + (r && r.error));
});

test('R1.5a.follow-up Phase 6.S.b: opts is an Array (typeof === "object" in JS) — IPC does NOT crash, defaults apply', async () => {
  // Defensive: a renderer bug that passes opts=[...] (an array,
  // which is typeof "object" in JS) MUST NOT crash the IPC. The
  // current code accepts it gracefully (no kind / no capabilities
  // → defaults apply) thanks to the Object.getPrototypeOf(opts) ===
  // Object.prototype guard added in Phase 6.AuditFix. A future
  // refactor that drops the guard and reads e.g. opts.kind would
  // receive undefined (OK) but a refactor that iterates
  // Object.keys(opts) on an array would get ['0','1','2'] and
  // mis-behave. The guard prevents that footgun.
  const { handlers } = loadIpc();
  const p = path.join(TMP, 's-b.png');
  fs.writeFileSync(p, 'fake');
  const r = await handlers.get('pathGrant:mint')({}, p, 'read', [1, 2, 3]);
  assert.equal(r.ok, true, 'S.b: array opts must NOT crash; default file-grant+single-cap. Got: ' + (r && r.error));
});

test('R1.5a.follow-up Phase 6.S.c: opts is a Promise — IPC does NOT crash, defaults apply', async () => {
  // Same as S.b but for Promise (also typeof "object" in JS).
  // The Object.getPrototypeOf guard rejects non-plain-objects.
  const { handlers } = loadIpc();
  const p = path.join(TMP, 's-c.png');
  fs.writeFileSync(p, 'fake');
  const r = await handlers.get('pathGrant:mint')({}, p, 'read', Promise.resolve());
  assert.equal(r.ok, true, 'S.c: promise opts must NOT crash; default file-grant+single-cap. Got: ' + (r && r.error));
});
