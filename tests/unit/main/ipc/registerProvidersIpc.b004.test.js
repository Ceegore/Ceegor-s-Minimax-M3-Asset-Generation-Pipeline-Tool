// tests/unit/main/ipc/registerProvidersIpc.b004.test.js
// ============================================================================
// B-004 — built-in provider origins (OpenRouter / Replicate) are IMMUTABLE.
//
// Attack: a compromised renderer calls providers:set with the openrouter
// entry's baseUrl pointed at an attacker origin — every later request sends
// the Bearer API key there. Defense in depth:
//   1. providers:set REJECTS any baseUrl/kind change for a built-in id.
//   2. providersStore pins built-in origins at write() AND read() time, so
//      even a hand-edited providers.json on disk cannot redirect traffic.
// ============================================================================
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---- Isolate config to a temp dir ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-b004-'));
process.env.MINIMAX_CONFIG_DIR = tmpDir;

// ---- Stub electron ----
const handlers = new Map();
const fakeIpcMain = {
  handle: (channel, fn) => handlers.set(channel, fn),
  removeHandler: (channel) => handlers.delete(channel),
};
const userData = path.join(tmpDir, 'userData');
fs.mkdirSync(userData, { recursive: true });
require.cache[require.resolve('electron')] = {
  exports: {
    app: { getPath: (k) => (k === 'userData' ? userData : tmpDir), isPackaged: false },
    ipcMain: fakeIpcMain,
  },
};

// Clear caches so modules pick up the env override + electron stub.
for (const key of Object.keys(require.cache)) {
  if (key.includes('providersStore') || key.includes('registerProvidersIpc') || key.includes('secureHandle') || key.includes(path.join('src', 'config'))) {
    delete require.cache[key];
  }
}

// Grants are irrelevant here — always allow.
const grantMod = require.resolve('../../../../main/ipc/grantAuthorizer');
require.cache[grantMod] = { exports: { authorizePath: () => ({ ok: true }) } };

const providersStore = require('../../../../src/providersStore');
delete require.cache[require.resolve('../../../../main/ipc/registerProvidersIpc')];
const { register } = require('../../../../main/ipc/registerProvidersIpc');
register({ getMainWindow: () => null });

const PINNED_OPENROUTER = 'https://openrouter.ai/api/v1';
const EVIL = 'https://evil.attacker.example/api/v1';

function fullUpdate(mutate) {
  // Build a complete, valid update payload from defaults, then mutate.
  const d = providersStore._default();
  const update = {
    providers: d.providers.map((p) => ({ id: p.id, label: p.label, kind: p.kind, baseUrl: p.baseUrl || '' })),
    selections: d.selections,
  };
  if (mutate) mutate(update);
  return update;
}

// ---- Layer 1: providers:set rejects built-in origin changes ----

test('B-004: providers:set rejects an openrouter baseUrl change', async () => {
  const setHandler = handlers.get('providers:set');
  const r = await setHandler({}, fullUpdate((u) => {
    u.providers.find((p) => p.id === 'openrouter').baseUrl = EVIL;
  }));
  assert.equal(r.ok, false);
  assert.match(r.error, /built-in/i);
  // Nothing may have been persisted with the evil origin.
  assert.equal(providersStore.provider('openrouter').baseUrl, PINNED_OPENROUTER);
});

test('B-004: providers:set rejects a replicate baseUrl change', async () => {
  const setHandler = handlers.get('providers:set');
  const r = await setHandler({}, fullUpdate((u) => {
    u.providers.find((p) => p.id === 'replicate').baseUrl = EVIL;
  }));
  assert.equal(r.ok, false);
  assert.match(r.error, /built-in/i);
  assert.equal(providersStore.provider('replicate').baseUrl, '');
});

test('B-004: providers:set rejects a kind swap on a built-in id', async () => {
  const setHandler = handlers.get('providers:set');
  // kind swap alone (baseUrl kept pinned) — would reroute through another adapter.
  const r = await setHandler({}, fullUpdate((u) => {
    u.providers.find((p) => p.id === 'replicate').kind = 'custom-openai';
  }));
  assert.equal(r.ok, false);
  assert.match(r.error, /built-in/i);
});

test('B-004: providers:set with unchanged built-in origins still succeeds', async () => {
  const setHandler = handlers.get('providers:set');
  const r = await setHandler({}, fullUpdate((u) => {
    u.providers.find((p) => p.id === 'openrouter').apiKey = 'sk-legit-key';
  }));
  assert.equal(r.ok, true);
  assert.equal(providersStore.provider('openrouter').apiKey, 'sk-legit-key');
  assert.equal(providersStore.provider('openrouter').baseUrl, PINNED_OPENROUTER);
});

test('B-004: custom-openai baseUrl stays editable (dev / flag-gated path unchanged)', async () => {
  const setHandler = handlers.get('providers:set');
  // H-018: use a public IP literal so the async DNS check is skipped
  // (hostname-based URLs would require a real DNS resolution in tests).
  const r = await setHandler({}, fullUpdate((u) => {
    u.providers.find((p) => p.id === 'custom-openai').baseUrl = 'https://93.184.216.34/v1';
  }));
  assert.equal(r.ok, true);
  assert.equal(providersStore.provider('custom-openai').baseUrl, 'https://93.184.216.34/v1');
});

// ---- Layer 2: the store pins origins against on-disk tampering ----

test('B-004: a tampered providers.json cannot redirect openrouter (read-time pin)', () => {
  const d = providersStore.read();
  d.providers.find((p) => p.id === 'openrouter').baseUrl = EVIL;
  // Bypass write() — simulate a direct on-disk edit.
  fs.writeFileSync(providersStore.file(), JSON.stringify(d, null, 2));
  const raw = JSON.parse(fs.readFileSync(providersStore.file(), 'utf8'));
  assert.equal(raw.providers.find((p) => p.id === 'openrouter').baseUrl, EVIL, 'precondition: file really tampered');
  // read() and provider() must return the pinned origin regardless.
  assert.equal(providersStore.provider('openrouter').baseUrl, PINNED_OPENROUTER);
  assert.equal(providersStore.read().providers.find((p) => p.id === 'openrouter').baseUrl, PINNED_OPENROUTER);
});

test('B-004: providers:getPublic reports the pinned origin after disk tamper', () => {
  const getHandler = handlers.get('providers:getPublic');
  const dto = getHandler({});
  assert.equal(dto.ok, true);
  assert.equal(dto.providers.find((p) => p.id === 'openrouter').baseUrl, PINNED_OPENROUTER);
});

test('B-004: providersStore.write() normalizes built-in origins before persisting', () => {
  const d = providersStore._default();
  d.providers.find((p) => p.id === 'openrouter').baseUrl = EVIL;
  providersStore.write(d);
  const raw = JSON.parse(fs.readFileSync(providersStore.file(), 'utf8'));
  assert.equal(raw.providers.find((p) => p.id === 'openrouter').baseUrl, PINNED_OPENROUTER);
  assert.equal(raw.providers.find((p) => p.id === 'replicate').kind, 'replicate');
  assert.equal(raw.providers.find((p) => p.id === 'replicate').baseUrl, '');
});

// RR2-C003 (recheck-2): a re-kind of a built-in is now REJECTED by the
// write() schema guard outright (it used to be silently normalized). The
// read-time kind pin (_pinBuiltins) still protects against on-disk edits.
test('RR2-C003: providersStore.write() rejects a re-kinded built-in', () => {
  const d = providersStore._default();
  d.providers.find((p) => p.id === 'replicate').kind = 'openrouter';
  assert.throws(() => providersStore.write(d), /permanently bound to kind/);
  const tampered = providersStore.read();
  tampered.providers.find((p) => p.id === 'replicate').kind = 'custom-openai';
  fs.writeFileSync(providersStore.file(), JSON.stringify(tampered, null, 2));
  assert.equal(providersStore.read().providers.find((p) => p.id === 'replicate').kind, 'replicate');
});

test('B-004: BUILTIN_ORIGINS is frozen and exported', () => {
  assert.ok(Object.isFrozen(providersStore.BUILTIN_ORIGINS));
  assert.equal(providersStore.BUILTIN_ORIGINS.openrouter.baseUrl, PINNED_OPENROUTER);
  assert.throws(() => { providersStore.BUILTIN_ORIGINS.openrouter = { baseUrl: EVIL }; }, TypeError);
});

// Cleanup
test('cleanup', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MINIMAX_CONFIG_DIR;
});
