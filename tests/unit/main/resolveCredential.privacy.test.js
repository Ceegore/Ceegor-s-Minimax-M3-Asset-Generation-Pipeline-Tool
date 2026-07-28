// tests/unit/main/resolveCredential.privacy.test.js
// ============================================================================
// R2.2 — Direct unit tests for `main/ipc/resolveCredential.js`.
//
// The IPC-handler tests in `registerMmxIpc.r22.test.js` exercise the
// resolver indirectly through the `mmx:run:job` and `mmx:run` IPC
// handlers. Those tests cover the lazy-loaded deps path (the
// production path), but they do NOT cover the deps-injection path
// — the documented test hook for isolated unit tests.
//
// This file exercises the resolver directly with injected
// cfgMod + stateMod stubs, so a future refactor that breaks the
// deps-injection path is caught even when the IPC path is fine.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RESOLVE_PATH = path.join(ROOT, 'main', 'ipc', 'resolveCredential.js');

// Make a fresh per-test home so the resolver's lazy-loaded deps
// (src/config + src/state) read from a predictable place. We use a
// real temp HOME; this is the production code path.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r22-resolver-'));

test.beforeEach(() => {
  process.env.USERPROFILE = TMP;
  process.env.HOME = TMP;
  process.env.MINIMAX_CONFIG_DIR = TMP;
  // Clear module cache so resolveCredential re-loads its deps.
  for (const p of [RESOLVE_PATH, path.join(ROOT, 'src', 'config.js'), path.join(ROOT, 'src', 'state.js')]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
});

test.afterEach(() => {
  delete process.env.USERPROFILE;
  delete process.env.HOME;
  delete process.env.MINIMAX_CONFIG_DIR;
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// R2.2.direct.1: explicit sessionOnly + rendererApiKey returns the key
// ---------------------------------------------------------------------------
test('R2.2.direct.1: explicit sessionOnly + rendererApiKey returns the key + sessionOnly:true', () => {
  const { resolveCredential } = require(RESOLVE_PATH);
  const cred = resolveCredential({ sessionOnly: true, rendererApiKey: 'sk-DIRECT-1' });
  assert.deepEqual(cred, { apiKey: 'sk-DIRECT-1', sessionOnly: true });
});

// ---------------------------------------------------------------------------
// R2.2.direct.2: explicit sessionOnly + missing rendererApiKey → fail-closed
// ---------------------------------------------------------------------------
test('R2.2.direct.2: explicit sessionOnly + missing rendererApiKey → fail-closed', () => {
  const { resolveCredential } = require(RESOLVE_PATH);
  for (const bad of [undefined, '', '   ', null]) {
    const cred = resolveCredential({ sessionOnly: true, rendererApiKey: bad });
    assert.equal(cred.apiKey, null, 'apiKey must be null; got ' + JSON.stringify(cred));
    assert.equal(cred.sessionOnly, true, 'sessionOnly must be true (the user opted in)');
    assert.match(cred.error, /sessionOnly=true requires payload\.rendererApiKey/);
  }
});

// ---------------------------------------------------------------------------
// R2.2.direct.3: explicit sessionOnly + non-string rendererApiKey → fail-closed
// ---------------------------------------------------------------------------
test('R2.2.direct.3: explicit sessionOnly + non-string rendererApiKey → fail-closed', () => {
  const { resolveCredential } = require(RESOLVE_PATH);
  for (const bad of [0, 1, false, true, {}, [], Symbol('x')]) {
    const cred = resolveCredential({ sessionOnly: true, rendererApiKey: bad });
    assert.equal(cred.apiKey, null, 'non-string rendererApiKey must be rejected; got ' + JSON.stringify(cred));
    assert.match(cred.error || '', /non-empty string/);
  }
});

// ---------------------------------------------------------------------------
// R2.2.direct.4: non-session-only payload reads deps.cfgMod + deps.stateMod
// ---------------------------------------------------------------------------
test('R2.2.direct.4: non-session-only payload uses injected deps (cfgMod + stateMod)', () => {
  const { resolveCredential } = require(RESOLVE_PATH);
  const cfgModStub = { read: () => ({ api_key: 'sk-INJECTED-FROM-CFG' }) };
  const stateModStub = { read: () => ({ apiKeyNoSave: false }) };
  const cred = resolveCredential({}, { cfgMod: cfgModStub, stateMod: stateModStub });
  assert.deepEqual(cred, { apiKey: 'sk-INJECTED-FROM-CFG', sessionOnly: false });
});

// ---------------------------------------------------------------------------
// R2.2.direct.5: non-session-only + state.apiKeyNoSave === true yields
// sessionOnly:true even when the payload has no sessionOnly flag
// (preserves the pre-R2.2 behavior of the legacy mmx:run path)
// ---------------------------------------------------------------------------
test('R2.2.direct.5: state.apiKeyNoSave=true is honored even without explicit sessionOnly in the payload', () => {
  const { resolveCredential } = require(RESOLVE_PATH);
  const cfgModStub = { read: () => ({ api_key: 'sk-LEGACY-PERSISTED' }) };
  const stateModStub = { read: () => ({ apiKeyNoSave: true }) };
  const cred = resolveCredential({}, { cfgMod: cfgModStub, stateMod: stateModStub });
  // The user's persisted state says session-only; the resolver
  // surfaces that as `sessionOnly: true` so the handler routes
  // the persisted key via MMX_API_KEY env instead of writing to
  // ~/.mmx/config.json. The apiKey stays the persisted value
  // (the resolver does NOT second-guess the renderer about the
  // in-memory key in case 5 — that's a follow-up R2.x card).
  assert.equal(cred.apiKey, 'sk-LEGACY-PERSISTED');
  assert.equal(cred.sessionOnly, true);
});

// ---------------------------------------------------------------------------
// R2.2.direct.6: cfgMod.read() throws → fail-closed envelope
// ---------------------------------------------------------------------------
test('R2.2.direct.6: a thrown cfgMod.read() yields a fail-closed envelope, no exception', () => {
  const { resolveCredential } = require(RESOLVE_PATH);
  const cfgModStub = { read: () => { throw new Error('disk EIO'); } };
  const stateModStub = { read: () => ({}) };
  let caught = null;
  let cred = null;
  try {
    cred = resolveCredential({}, { cfgMod: cfgModStub, stateMod: stateModStub });
  } catch (e) {
    caught = e;
  }
  assert.equal(caught, null, 'resolver must never throw; caught: ' + (caught && caught.message));
  assert.equal(cred.apiKey, null);
  assert.equal(cred.sessionOnly, false);
  assert.match(cred.error, /failed to read persisted config/);
});

// ---------------------------------------------------------------------------
// R2.2.direct.7: stateMod.read() throws → swallowed, sessionOnly defaults to false
// ---------------------------------------------------------------------------
test('R2.2.direct.7: a thrown stateMod.read() is swallowed; sessionOnly defaults to false', () => {
  const { resolveCredential } = require(RESOLVE_PATH);
  const cfgModStub = { read: () => ({ api_key: 'sk-OK' }) };
  const stateModStub = { read: () => { throw new Error('state EIO'); } };
  let cred = null;
  try {
    cred = resolveCredential({}, { cfgMod: cfgModStub, stateMod: stateModStub });
  } catch (_) { /* must not throw */ }
  // The cfg.api_key is returned; sessionOnly defaults to false
  // because the stateMod.read() throw is caught. The handler can
  // still proceed with the persisted key + the default
  // (non-session-only) mode.
  assert.equal(cred.apiKey, 'sk-OK');
  assert.equal(cred.sessionOnly, false);
});

// ---------------------------------------------------------------------------
// R2.2.direct.8: missing deps + non-session-only → reads real src/config
// (the production lazy-load path; the contract is "works without deps")
// ---------------------------------------------------------------------------
test('R2.2.direct.8: no deps + non-session-only → reads lazy-loaded src/config + src/state', () => {
  // Pre-seed a config with a known key.
  fs.writeFileSync(path.join(TMP, 'config.txt'),
    ['api_key=sk-LAZY-LOADED', 'output_dir=', 'region=global', 'theme=dark', 'styles=', ''].join('\n'));
  const { resolveCredential } = require(RESOLVE_PATH);
  const cred = resolveCredential({});
  assert.equal(cred.apiKey, 'sk-LAZY-LOADED');
  assert.equal(cred.sessionOnly, false);
});

// ---------------------------------------------------------------------------
// R2.2.direct.9: missing deps + sessionOnly → reads lazy-loaded state too
// ---------------------------------------------------------------------------
test('R2.2.direct.9: no deps + sessionOnly=true + state.apiKeyNoSave=true', () => {
  fs.writeFileSync(path.join(TMP, 'config.txt'),
    ['api_key=sk-CFG', 'output_dir=', 'region=global', 'theme=dark', 'styles=', ''].join('\n'));
  // Write a state file with apiKeyNoSave=true so the lazy-loaded
  // stateMod.read() picks it up.
  fs.writeFileSync(path.join(TMP, 'state.json'),
    JSON.stringify({ apiKeyNoSave: true, tabs: {} }, null, 2));
  const { resolveCredential } = require(RESOLVE_PATH);
  // payload has sessionOnly + rendererApiKey; the explicit branch
  // wins regardless of the persisted state. (We test the explicit
  // branch's interaction with the lazy-loaded state, to make sure
  // the explicit branch does NOT silently fall through to the
  // cfg/state path.)
  const cred = resolveCredential({ sessionOnly: true, rendererApiKey: 'sk-EXPLICIT' });
  assert.deepEqual(cred, { apiKey: 'sk-EXPLICIT', sessionOnly: true });
});

// ---------------------------------------------------------------------------
// R2.2.direct.10: edge case — sessionOnly: false explicitly → non-session-only path
// ---------------------------------------------------------------------------
test('R2.2.direct.10: explicit sessionOnly: false goes to the non-session-only path', () => {
  const { resolveCredential } = require(RESOLVE_PATH);
  const cfgModStub = { read: () => ({ api_key: 'sk-PERSISTED' }) };
  const stateModStub = { read: () => ({ apiKeyNoSave: true }) };
  // sessionOnly: false is a STRICT comparison, so this goes to
  // the non-session-only path. The resolver returns the cfg key
  // and the persisted sessionOnly flag. (The handler will then
  // use sessionOnly from the resolver, not the payload.)
  const cred = resolveCredential({ sessionOnly: false }, { cfgMod: cfgModStub, stateMod: stateModStub });
  assert.equal(cred.apiKey, 'sk-PERSISTED');
  assert.equal(cred.sessionOnly, true, 'state.apiKeyNoSave=true is still honored when payload.sessionOnly is false');
});
