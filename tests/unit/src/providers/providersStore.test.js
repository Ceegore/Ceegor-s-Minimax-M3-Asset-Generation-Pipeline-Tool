// tests/unit/src/providers/providersStore.test.js
// Unit tests for src/providersStore.js — config persistence for the Other APIs tab.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate configDir to a temp folder so tests never touch real config.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provstore-'));
process.env.MINIMAX_CONFIG_DIR = tmpDir;

// Clear require cache so config.js picks up the env override.
delete require.cache[require.resolve('../../../../src/config')];
delete require.cache[require.resolve('../../../../src/providersStore')];
const store = require('../../../../src/providersStore');

test('providersStore: read() returns default when no file exists', () => {
  const d = store.read();
  assert.ok(d.providers, 'has providers array');
  assert.equal(d.providers.length, 3);
  assert.ok(d.selections, 'has selections');
  assert.ok(d.selections.image, 'has image selection');
  assert.ok(d.selections.music, 'has music selection');
});

test('providersStore: default providers have correct kinds', () => {
  const d = store._default();
  const kinds = d.providers.map((p) => p.kind);
  assert.deepEqual(kinds, ['openrouter', 'replicate', 'custom-openai']);
});

test('providersStore: write() + read() round-trips', () => {
  const data = store._default();
  data.providers[0].apiKey = 'sk-test-123';
  data.selections.image.model = 'openai/gpt-image-1';
  store.write(data);
  const back = store.read();
  assert.equal(back.providers[0].apiKey, 'sk-test-123');
  assert.equal(back.selections.image.model, 'openai/gpt-image-1');
});

test('providersStore: provider(id) returns the matching entry', () => {
  const p = store.provider('replicate');
  assert.equal(p.kind, 'replicate');
  assert.equal(p.label, 'Replicate');
});

test('providersStore: provider(id) throws for unknown id', () => {
  assert.throws(() => store.provider('nonexistent'), /unknown provider/);
});

test('providersStore: file() points to providers.json in configDir', () => {
  const f = store.file();
  assert.ok(f.endsWith('providers.json'));
  assert.ok(f.startsWith(tmpDir));
});

test('providersStore: write is atomic (tmp + rename)', () => {
  const data = store._default();
  data.providers[1].apiKey = 'r8-token';
  store.write(data);
  // No leftover .tmp files
  const files = fs.readdirSync(tmpDir);
  const tmps = files.filter((f) => f.includes('.tmp-'));
  assert.equal(tmps.length, 0, 'no leftover tmp files');
  // File exists and is valid JSON
  const raw = fs.readFileSync(store.file(), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.providers[1].apiKey, 'r8-token');
});

test('providersStore: read() recovers from corrupted JSON', () => {
  // Write garbage to the providers file
  fs.writeFileSync(store.file(), '{invalid json!!!');
  const d = store.read();
  // Should fall back to defaults
  assert.ok(d.providers, 'has providers array');
  assert.equal(d.providers.length, 3);
});

test('providersStore: write() works in a fresh directory (configDir pre-created)', () => {
  const nestedDir = path.join(tmpDir, 'nested', 'deep');
  fs.mkdirSync(nestedDir, { recursive: true });
  const origEnv = process.env.MINIMAX_CONFIG_DIR;
  process.env.MINIMAX_CONFIG_DIR = nestedDir;
  // Clear cache to pick up new env
  delete require.cache[require.resolve('../../../../src/config')];
  delete require.cache[require.resolve('../../../../src/providersStore')];
  const store2 = require('../../../../src/providersStore');
  const data = store2._default();
  data.providers[0].apiKey = 'sk-nested';
  store2.write(data);
  assert.ok(fs.existsSync(store2.file()), 'file created in nested dir');
  const back = store2.read();
  assert.equal(back.providers[0].apiKey, 'sk-nested');
  // Restore
  process.env.MINIMAX_CONFIG_DIR = origEnv;
  delete require.cache[require.resolve('../../../../src/config')];
  delete require.cache[require.resolve('../../../../src/providersStore')];
});

test('providersStore: selections persist per-modality', () => {
  const data = store._default();
  data.selections.image = { providerId: 'openrouter', model: 'gpt-image-1' };
  data.selections.speech = { providerId: 'replicate', model: 'hexgrad/kokoro-82m' };
  store.write(data);
  const back = store.read();
  assert.equal(back.selections.image.model, 'gpt-image-1');
  assert.equal(back.selections.speech.providerId, 'replicate');
});

// Cleanup
test('providersStore: cleanup', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MINIMAX_CONFIG_DIR;
});
