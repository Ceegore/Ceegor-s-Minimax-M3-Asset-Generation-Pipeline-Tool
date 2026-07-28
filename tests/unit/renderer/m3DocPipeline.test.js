// tests/unit/renderer/m3DocPipeline.test.js
// Tests the pure functions in renderer/services/m3DocPipeline.js:
// extractJsonArray, composeBatchJson, and the LIMITS constant.
// Uses the vm-sandbox pattern (same as aspectLink.test.js).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function loadPipeline() {
  const sandbox = {
    window: { api: {} },
    console,
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'renderer/services/m3DocPipeline.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'm3DocPipeline.js' });
  return sandbox.window.M3DocPipeline;
}

test('M3DocPipeline exposes the expected API', () => {
  const p = loadPipeline();
  assert.ok(p, 'M3DocPipeline is defined');
  assert.equal(typeof p.run, 'function');
  assert.equal(typeof p.runAndImport, 'function');
  assert.equal(typeof p.composeBatchJson, 'function');
  assert.equal(typeof p.extractJsonArray, 'function');
  assert.ok(p.LIMITS, 'LIMITS is defined');
});

test('LIMITS matches modelSpecs hard limits', () => {
  const p = loadPipeline();
  assert.equal(p.LIMITS.image, 1500);
  assert.equal(p.LIMITS.speech, 10000);
  assert.equal(p.LIMITS.music, 2000);
  assert.equal(p.LIMITS.video, 2000);
});

// ---- extractJsonArray ----

test('extractJsonArray parses a direct JSON array', () => {
  const p = loadPipeline();
  const result = p.extractJsonArray('[{"id":"S1","description":"forest"}]');
  assert.equal(JSON.stringify(result), JSON.stringify([{ id: 'S1', description: 'forest' }]));
});

test('extractJsonArray extracts from a fenced code block', () => {
  const p = loadPipeline();
  const text = 'Here is the result:\n```json\n[{"id":"C1","description":"knight"}]\n```\nDone.';
  const result = p.extractJsonArray(text);
  assert.equal(JSON.stringify(result), JSON.stringify([{ id: 'C1', description: 'knight' }]));
});

test('extractJsonArray finds brackets in prose', () => {
  const p = loadPipeline();
  const text = 'The scenes are [{"id":"S1","description":"cave"}] as requested.';
  const result = p.extractJsonArray(text);
  assert.equal(JSON.stringify(result), JSON.stringify([{ id: 'S1', description: 'cave' }]));
});

test('extractJsonArray returns null for invalid input', () => {
  const p = loadPipeline();
  assert.equal(p.extractJsonArray(''), null);
  assert.equal(p.extractJsonArray(null), null);
  assert.equal(p.extractJsonArray('no json here'), null);
  assert.equal(p.extractJsonArray('{"not":"array"}'), null);
});

// ---- composeBatchJson ----

test('composeBatchJson produces a fenced batch-json document', () => {
  const p = loadPipeline();
  const scenes = [{ id: 'S1', description: 'A dark cave.' }];
  const characters = [{ id: 'C1', description: 'A tall knight.' }];
  const shots = [
    { type: 'image', sceneId: 'S1', characterIds: ['C1'], action: 'The knight enters.', params: {} },
  ];
  const doc = p.composeBatchJson(scenes, characters, shots, {});
  assert.ok(doc.includes('```batch-json'), 'has fenced block');
  assert.ok(doc.includes('"type": "image"'), 'has image entry');
  assert.ok(doc.includes('A dark cave.'), 'scene description present');
  assert.ok(doc.includes('A tall knight.'), 'character description present');
  assert.ok(doc.includes('The knight enters.'), 'action present');
});

test('composeBatchJson concatenates scene + character + action verbatim', () => {
  const p = loadPipeline();
  const scenes = [{ id: 'S1', description: 'Forest clearing at dawn.' }];
  const characters = [{ id: 'C1', description: 'Elara the ranger.' }];
  const shots = [
    { type: 'image', sceneId: 'S1', characterIds: ['C1'], action: 'She draws her bow.', params: {} },
    { type: 'image', sceneId: 'S1', characterIds: ['C1'], action: 'She kneels by the stream.', params: {} },
  ];
  const doc = p.composeBatchJson(scenes, characters, shots, {});
  // Both prompts must contain the identical scene + character text.
  const parsed = JSON.parse(doc.match(/```batch-json\n([\s\S]*?)\n```/)[1]);
  assert.equal(parsed.length, 2);
  const scenePart = 'Forest clearing at dawn.';
  const charPart = 'Elara the ranger.';
  assert.ok(parsed[0].prompt.includes(scenePart), 'shot 1 has scene');
  assert.ok(parsed[1].prompt.includes(scenePart), 'shot 2 has scene');
  assert.ok(parsed[0].prompt.includes(charPart), 'shot 1 has character');
  assert.ok(parsed[1].prompt.includes(charPart), 'shot 2 has character');
  // The scene text must be byte-for-byte identical in both.
  const idx0 = parsed[0].prompt.indexOf(scenePart);
  const idx1 = parsed[1].prompt.indexOf(scenePart);
  assert.equal(parsed[0].prompt.slice(idx0, idx0 + scenePart.length), parsed[1].prompt.slice(idx1, idx1 + scenePart.length));
});

test('composeBatchJson enforces HARD limit by trimming action', () => {
  const p = loadPipeline();
  const longScene = 'X'.repeat(1400);
  const scenes = [{ id: 'S1', description: longScene }];
  const characters = [];
  const shots = [
    { type: 'image', sceneId: 'S1', characterIds: [], action: 'Y'.repeat(500), params: {} },
  ];
  const doc = p.composeBatchJson(scenes, characters, shots, {});
  const parsed = JSON.parse(doc.match(/```batch-json\n([\s\S]*?)\n```/)[1]);
  assert.ok(parsed[0].prompt.length <= 1500, 'prompt within HARD limit: ' + parsed[0].prompt.length);
});

test('composeBatchJson applies style header when provided', () => {
  const p = loadPipeline();
  const scenes = [{ id: 'S1', description: 'Cave.' }];
  const shots = [{ type: 'image', sceneId: 'S1', characterIds: [], action: 'Dark.', params: {} }];
  const doc = p.composeBatchJson(scenes, [], shots, { styleName: 'Fantasy', styleValue: 'cinematic fantasy art' });
  assert.ok(doc.includes('style: Fantasy = cinematic fantasy art'), 'style header present');
  const parsed = JSON.parse(doc.match(/```batch-json\n([\s\S]*?)\n```/)[1]);
  assert.ok(parsed[0].prompt.startsWith('cinematic fantasy art'), 'style prefix in prompt');
});

test('composeBatchJson handles speech/music (no scene concatenation)', () => {
  const p = loadPipeline();
  const shots = [
    { type: 'speech', sceneId: null, characterIds: [], action: 'Hello world, this is a test.', params: { '--voice': 'male-1' } },
    { type: 'music', sceneId: null, characterIds: [], action: 'Epic orchestral battle theme.', params: { '--model': 'music-2.6' } },
  ];
  const doc = p.composeBatchJson([], [], shots, {});
  const parsed = JSON.parse(doc.match(/```batch-json\n([\s\S]*?)\n```/)[1]);
  assert.equal(parsed[0].prompt, 'Hello world, this is a test.');
  assert.equal(parsed[1].prompt, 'Epic orchestral battle theme.');
  assert.equal(parsed[0].params['--voice'], 'male-1');
});

test('composeBatchJson applies variants and sendToPipeline from opts', () => {
  const p = loadPipeline();
  const shots = [{ type: 'image', sceneId: null, characterIds: [], action: 'Test.', params: {} }];
  const doc = p.composeBatchJson([], [], shots, { variants: 3, sendToPipeline: true });
  const parsed = JSON.parse(doc.match(/```batch-json\n([\s\S]*?)\n```/)[1]);
  assert.equal(parsed[0].params.variants, 3);
  assert.equal(parsed[0].sendToPipeline, true);
});
