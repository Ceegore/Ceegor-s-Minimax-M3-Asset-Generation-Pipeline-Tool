// tests/unit/renderer/tabs/batchImportFencedJson.test.js
// H9-007: the fenced ```batch-json canonical import path. The pipe-table parser
// splits every line on every `|`, so it cannot losslessly carry pipes-in-prose,
// multiline speech, or structured lyrics. The fenced-JSON path must round-trip
// all of them, and must reuse the existing alias/unknown-key/defective logic.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ---- minimal window so batchImportHelper.js + modelSpecs.js load ----
global.window = global;
global.state = { batches: {} };
global.toast = () => {};
global.showModal = () => {};
global.el = () => {};
global.$ = () => null;

require(path.join(ROOT, 'renderer', 'tabs', 'batchImportCompatibility.js'));
require(path.join(ROOT, 'renderer', 'tabs', 'batchImportHelper.js'));
require(path.join(ROOT, 'renderer', 'specs', 'modelSpecs.js'));
const { parseFencedBatchJson } = global.window.BatchManager;

test('H9-007 a fenced batch-json block parses losslessly', () => {
  const content = '```batch-json\n' +
    JSON.stringify([
      { type: 'image', prompt: 'a cat', params: { '--model': 'image-01' } },
      { type: 'speech', prompt: 'Hello | world', params: { '--model': 'speech-2.8-hd' } },
    ]) + '\n```';
  const r = parseFencedBatchJson(content);
  assert.equal(r.parsed, true);
  assert.equal(r.entries.image.length, 1);
  assert.equal(r.entries.speech.length, 1);
  // The pipe in the speech prompt is preserved (the table parser would split it).
  assert.equal(r.entries.speech[0].prompt, 'Hello | world');
});

test('H9-007 multiline speech text round-trips', () => {
  const content = '```batch-json\n' +
    JSON.stringify([
      { type: 'speech', text: 'Line one.\nLine two.\nLine three.', params: {} },
    ]) + '\n```';
  const r = parseFencedBatchJson(content);
  assert.equal(r.parsed, true);
  assert.equal(r.entries.speech[0].prompt, 'Line one.\nLine two.\nLine three.');
});

test('H9-007 structured lyrics with [Verse] tags round-trip', () => {
  const lyrics = '[Verse 1]\nTwinkle twinkle\n[Chorus]\nLittle star';
  const content = '```batch-json\n' +
    JSON.stringify([{ type: 'music', prompt: 'a lullaby', params: { '--lyrics': lyrics } }]) +
    '\n```';
  const r = parseFencedBatchJson(content);
  assert.equal(r.entries.music[0]['--lyrics'], lyrics);
});

test('H9-007 the fenced path reuses buildImportedEntry (aliases resolve)', () => {
  const content = '```batch-json\n' +
    JSON.stringify([{ type: 'video', prompt: 'a shot', params: { '--first-frame-image': 'C:/f.png', '--model': 'MiniMax-Hailuo-2.3' } }]) +
    '\n```';
  const r = parseFencedBatchJson(content);
  // alias --first-frame-image must resolve to --first-frame (existing logic).
  assert.equal(r.entries.video[0]['--first-frame'], 'C:/f.png');
});

test('H9-007 a fenced block with an unknown key flags the row defective', () => {
  const content = '```batch-json\n' +
    JSON.stringify([{ type: 'image', prompt: 'x', params: { '--nonsense': 'y' } }]) +
    '\n```';
  const r = parseFencedBatchJson(content);
  assert.ok(r.entries.image[0]._defective, 'unknown key flagged defective');
});

test('H9-007 content without a fence returns parsed=false (falls back to table)', () => {
  const r = parseFencedBatchJson('| image | a cat | --model image-01 |');
  assert.equal(r.parsed, false);
});

test('H9-007 a malformed fence throws (does NOT silently fall through)', () => {
  const content = '```batch-json\n{ not valid json ]\n```';
  assert.throws(() => parseFencedBatchJson(content), /could not be parsed/i);
});

test('H9-007 a style header before the fence is still detected', () => {
  const content = 'style: Moody = "dark, cinematic"\n\n```batch-json\n' +
    JSON.stringify([{ type: 'image', prompt: 'a cat', params: {} }]) + '\n```';
  const r = parseFencedBatchJson(content);
  assert.equal(r.styleHeader.name, 'Moody');
  assert.equal(r.styleHeader.value, 'dark, cinematic');
});

test('H9-007 ```json fence is also accepted (sibling of batch-json)', () => {
  const content = '```json\n' + JSON.stringify([{ type: 'image', prompt: 'x', params: {} }]) + '\n```';
  const r = parseFencedBatchJson(content);
  assert.equal(r.parsed, true);
});
