// tests/unit/src/providers/providersPayloadSchema.rq104.test.js
// ============================================================================
// V104-H004 (release requalification 1.0.4): regression tests for the
// strict providers:set payload schema + the providersStore.write() guard.
// The defect: malformed full replacements (empty array, duplicate ids,
// dropped built-ins) were accepted and could wipe providers.json or
// orphan encrypted credential blobs.
// ============================================================================
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { validateProvidersSetPayload } = require('../../../../src/providersPayloadSchema');

// Isolate configDir for the store-guard tests.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provschema-'));
process.env.MINIMAX_CONFIG_DIR = tmpDir;
delete require.cache[require.resolve('../../../../src/config')];
delete require.cache[require.resolve('../../../../src/providersStore')];
const store = require('../../../../src/providersStore');

/** The exact full-update shape the renderer sends (providersTab.js). */
function validPayload() {
  return {
    providers: [
      { id: 'openrouter', label: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
      { id: 'replicate', label: 'Replicate', kind: 'replicate', baseUrl: '' },
      { id: 'custom-openai', label: 'Custom (OpenAI-compat)', kind: 'custom-openai', baseUrl: '' },
    ],
    selections: { image: { providerId: 'openrouter', model: 'img-m' } },
  };
}

test('V104-H004: a legitimate renderer full-update payload passes', () => {
  assert.deepEqual(validateProvidersSetPayload(validPayload()), { ok: true });
});

test('V104-H004: null / non-object payloads are rejected', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const r = validateProvidersSetPayload(bad);
    assert.equal(r.ok, false, 'payload ' + JSON.stringify(bad));
    assert.match(r.error, /object/i);
  }
});

test('V104-H004: a missing or non-array providers field is rejected', () => {
  assert.equal(validateProvidersSetPayload({}).ok, false);
  assert.equal(validateProvidersSetPayload({ providers: 'no' }).ok, false);
  assert.equal(validateProvidersSetPayload({ selections: {} }).ok, false);
});

test('V104-H004: an EMPTY providers array is rejected (store-wipe attempt)', () => {
  const r = validateProvidersSetPayload({ providers: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /empty/i);
});

test('V104-H004: duplicate provider ids are rejected', () => {
  const p = validPayload();
  p.providers.push({ id: 'openrouter', label: 'Dup', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' });
  const r = validateProvidersSetPayload(p);
  assert.equal(r.ok, false);
  assert.match(r.error, /[Dd]uplicate/);
});

test('V104-H004: a full replacement that drops a built-in is rejected', () => {
  const p = validPayload();
  p.providers = p.providers.filter((x) => x.id !== 'replicate');
  const r = validateProvidersSetPayload(p);
  assert.equal(r.ok, false);
  assert.match(r.error, /replicate/);
});

test('V104-H004: malformed entries are rejected (id rules, types, bounds)', () => {
  const cases = [
    [{ id: '' }],                              // empty id
    [{ id: 42 }],                              // non-string id
    [{ id: 'openrouter x' }],                  // illegal charset
    [{ id: 'a'.repeat(65) }],                  // id too long
    [{ id: 'openrouter', label: 7 }],          // non-string label
    [{ id: 'openrouter', kind: 7 }],           // non-string kind
    [{ id: 'openrouter', baseUrl: 7 }],        // non-string baseUrl
    [{ id: 'openrouter', baseUrl: 'https://x'.repeat(500) }], // url too long
    [{ id: 'openrouter', apiKey: 7 }],         // non-string apiKey
    [{ id: 'openrouter', keyAction: 'nuke' }], // invalid keyAction
    [null],                                    // non-object entry
  ];
  for (const providers of cases) {
    // Top up with the other built-ins so only the targeted entry fails.
    const full = [...providers,
      { id: 'replicate', kind: 'replicate', baseUrl: '' },
      { id: 'custom-openai', kind: 'custom-openai', baseUrl: '' }];
    const r = validateProvidersSetPayload({ providers: full });
    assert.equal(r.ok, false, 'expected rejection for ' + JSON.stringify(providers));
  }
});

test('V104-H004: selections referencing unknown providers are rejected', () => {
  const p = validPayload();
  p.selections.music = { providerId: 'ghost', model: 'm' };
  const r = validateProvidersSetPayload(p);
  assert.equal(r.ok, false);
  assert.match(r.error, /ghost/);
});

test('V104-H004: selections with non-string metadata are rejected', () => {
  const p = validPayload();
  p.selections.image.model = 123;
  assert.equal(validateProvidersSetPayload(p).ok, false);
  p.selections.image = 'not-an-object';
  assert.equal(validateProvidersSetPayload(p).ok, false);
});

test('V104-H004: providersStore.write() refuses an empty replacement (guard)', () => {
  // Seed the store with defaults first.
  store.write(store._default());
  const before = fs.readFileSync(store.file(), 'utf8');
  assert.throws(() => store.write({ providers: [] }), /rejected/);
  assert.throws(() => store.write(null), /rejected/);
  // A payload dropping a built-in is refused too.
  const p = validPayload();
  p.providers = p.providers.filter((x) => x.id !== 'custom-openai');
  assert.throws(() => store.write(p), /rejected/);
  // The on-disk store is untouched after every refusal.
  assert.equal(fs.readFileSync(store.file(), 'utf8'), before);
});

test('cleanup', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MINIMAX_CONFIG_DIR;
});
