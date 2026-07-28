// tests/unit/renderer/tabs/batchImportHelper.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
// Mock standard globals used by batchImportHelper.js on file-load
global.state = { batches: {} };
global.toast = () => {};
global.showModal = () => {};
global.el = () => {};
global.$ = () => null;

require('../../../../renderer/tabs/batchImportHelper.js');
const { parseParams, batchEntryText, withBatchEntryText } = window.BatchManager;

test('parseParams: returns empty object for empty/null input', () => {
  assert.deepEqual(parseParams(''), {});
  assert.deepEqual(parseParams(null), {});
  assert.deepEqual(parseParams(undefined), {});
});

test('parseParams: parses key-value pairs with equals sign', () => {
  const result = parseParams('--width=1024 --height=768');
  assert.deepEqual(result, { width: '1024', height: '768' });
});

test('parseParams: parses key-value pairs with colon', () => {
  const result = parseParams('width: 1024 height: 768');
  assert.deepEqual(result, { width: '1024', height: '768' });
});

test('parseParams: parses standard CLI space-separated options', () => {
  const result = parseParams('--width 1024 --height 768');
  assert.deepEqual(result, { width: '1024', height: '768' });
});

test('parseParams: handles simple flags without values', () => {
  const result = parseParams('--instrumental --stereo');
  assert.deepEqual(result, { instrumental: 'true', stereo: 'true' });
});

test('parseParams: handles quoted values with spaces', () => {
  const result = parseParams('--voice "English Expressive Narrator" --speed 1.2');
  assert.deepEqual(result, { voice: 'English Expressive Narrator', speed: '1.2' });
});

test('parseParams: handles single-quoted values with spaces', () => {
  const result = parseParams("--voice 'German Female' --speed 0.95");
  assert.deepEqual(result, { voice: 'German Female', speed: '0.95' });
});

test('parseParams: normalizes keys to lowercase and removes leading dashes', () => {
  const result = parseParams('--Aspect-Ratio 16:9 --bpm 120');
  assert.deepEqual(result, { 'aspect-ratio': '16:9', bpm: '120' });
});

// ----- BGR-021 + follow-up: inline key:value tokens (colon syntax) -----
// The import parser must handle `key:value` and `--key:value` tokens,
// splitting on the FIRST colon only, while still refusing to split a
// bare scheme URL ("http://x.com") whose first colon IS the "://"
// scheme separator.

test('parseParams: dashed --key:value inline colon', () => {
  assert.deepEqual(parseParams('--duration:5'), { duration: '5' });
  assert.deepEqual(parseParams('--n:4'), { n: '4' });
});

test('parseParams: dashed --key:value where the value itself contains colons', () => {
  assert.deepEqual(parseParams('--aspect-ratio:16:9'), { 'aspect-ratio': '16:9' });
  assert.deepEqual(parseParams('--start:00:30'), { start: '00:30' });
});

test('parseParams: bare key:value inline colon (BGR-021)', () => {
  assert.deepEqual(parseParams('aspect-ratio:16:9'), { 'aspect-ratio': '16:9' });
  assert.deepEqual(parseParams('n:4'), { n: '4' });
});

test('parseParams: --key:value with a URL value is split on the key colon', () => {
  // The value contains "://" but the FIRST colon separates key from value.
  assert.deepEqual(parseParams('--url:http://x.com'), { url: 'http://x.com' });
  assert.deepEqual(parseParams('--subject-ref:https://cdn.example.com/a.png'), { 'subject-ref': 'https://cdn.example.com/a.png' });
});

test('parseParams: bare key:value with a URL value', () => {
  assert.deepEqual(parseParams('url:http://x.com'), { url: 'http://x.com' });
  assert.deepEqual(parseParams('ref:ftp://host/file'), { ref: 'ftp://host/file' });
});

test('parseParams: a bare scheme URL is NOT split into key:value', () => {
  assert.deepEqual(parseParams('http://x.com'), {});
  assert.deepEqual(parseParams('a cat http://x.com photo'), {});
});

test('parseParams: space-separated URL value still works', () => {
  assert.deepEqual(parseParams('--ref http://x.com'), { ref: 'http://x.com' });
});

test('parseParams: dashed --key:value with a Windows path value', () => {
  assert.deepEqual(parseParams('--output:C:\\Users\\foo\\out.png'), { output: 'C:\\Users\\foo\\out.png' });
});

test('parseParams: mixed space-separated + inline-colon + boolean tokens', () => {
  const result = parseParams('--model image-01 --duration:5 --fast');
  assert.deepEqual(result, { model: 'image-01', duration: '5', fast: 'true' });
});

// ----- Bug-fix #5 (2026-06-19): batch entry shape helpers -----
// The BatchGen editor needs to round-trip entries of two shapes
// (string or {prompt, params...}). These tests pin the contract so
// future changes can't silently start dropping params.

test('batchEntryText: returns the string for legacy string entries', () => {
  assert.equal(batchEntryText('hello world'), 'hello world');
  assert.equal(batchEntryText(''), '');
});

test('batchEntryText: returns prompt for snapshot object entries', () => {
  assert.equal(batchEntryText({ prompt: 'a quiet alley', style: 'Pixel Art' }), 'a quiet alley');
  assert.equal(batchEntryText({ prompt: '' }), '');
});

test('batchEntryText: handles null / undefined / non-object without throwing', () => {
  assert.equal(batchEntryText(null), '');
  assert.equal(batchEntryText(undefined), '');
  assert.equal(batchEntryText(42), '');
  assert.equal(batchEntryText({}), ''); // no .prompt
});

test('withBatchEntryText: leaves legacy string entries as strings', () => {
  assert.equal(withBatchEntryText('old prompt', 'new prompt'), 'new prompt');
  assert.equal(withBatchEntryText(undefined, 'text'), 'text');
});

test('withBatchEntryText: preserves params on object entries', () => {
  const entry = { prompt: 'old', style: 'Pixel Art', width: 1024, label: 'demo' };
  const next = withBatchEntryText(entry, 'new prompt');
  assert.equal(next.prompt, 'new prompt');
  assert.equal(next.style, 'Pixel Art');
  assert.equal(next.width, 1024);
  assert.equal(next.label, 'demo');
  // Original is not mutated (defensive copy).
  assert.equal(entry.prompt, 'old');
});

test('withBatchEntryText: returns "" for empty text on object entries (keeps shape)', () => {
  const entry = { prompt: 'old', style: 'Pixel Art' };
  const next = withBatchEntryText(entry, '');
  assert.equal(next.prompt, '');
  assert.equal(next.style, 'Pixel Art');
});

test('end-to-end: edit a snapshot entry keeps params intact', () => {
  // Simulates what batchManager.js does when the user edits a
  // textbox seeded from a snapshot entry, then saves.
  const original = { prompt: 'original', style: 'Neon Cyberpunk', upscale: 'on' };
  const edited = withBatchEntryText(original, 'edited by user');
  assert.equal(edited.prompt, 'edited by user');
  assert.equal(edited.style, 'Neon Cyberpunk');
  assert.equal(edited.upscale, 'on');
});
