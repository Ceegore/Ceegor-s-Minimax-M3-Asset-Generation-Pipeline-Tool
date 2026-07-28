// tests/unit/renderer/utils/fbSort.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
require('../../../../renderer/utils/fbSort.js');
const { FB_SORT_MODES, normalizeFbSort, naturalCompare, sortFbItems } = window.FbSort;

test('FB_SORT_MODES contains the 9 expected modes', () => {
  assert.equal(FB_SORT_MODES.size, 9);
  for (const m of ['name-asc', 'name-desc', 'size-desc', 'size-asc',
                   'mtime-desc', 'mtime-asc', 'created-desc',
                   'created-asc', 'type-asc']) {
    assert.ok(FB_SORT_MODES.has(m), `missing ${m}`);
  }
});

test('normalizeFbSort falls back to name-asc for invalid input', () => {
  assert.equal(normalizeFbSort('hacker'), 'name-asc');
  assert.equal(normalizeFbSort(null), 'name-asc');
  assert.equal(normalizeFbSort(undefined), 'name-asc');
  assert.equal(normalizeFbSort(42), 'name-asc');
  assert.equal(normalizeFbSort('size-desc'), 'size-desc'); // valid passes
});

test('naturalCompare: numeric suffixes sort in order', () => {
  // "file2" < "file10" (natural), not "file10" < "file2" (lexical)
  const arr = ['file10.png', 'file2.png', 'file1.png'];
  arr.sort(naturalCompare);
  assert.deepEqual(arr, ['file1.png', 'file2.png', 'file10.png']);
});

test('naturalCompare: equal numerics fall back to string compare', () => {
  assert.equal(naturalCompare('a', 'b'), -1);
  assert.equal(naturalCompare('a', 'a'), 0);
  assert.equal(naturalCompare('z', 'a'), 1);
});

test('sortFbItems: dirs always first', () => {
  const items = [
    { name: 'b.txt', isDir: false, size: 100, mtimeMs: 5, ext: 'txt' },
    { name: 'a-dir', isDir: true, size: 0, mtimeMs: 1, ext: '' },
    { name: 'a.txt', isDir: false, size: 50, mtimeMs: 3, ext: 'txt' },
  ];
  const sorted = sortFbItems(items, 'name-asc');
  assert.equal(sorted[0].name, 'a-dir');
});

test('sortFbItems: size-desc puts largest first', () => {
  const items = [
    { name: 'a', isDir: false, size: 10, mtimeMs: 0, ext: '' },
    { name: 'b', isDir: false, size: 100, mtimeMs: 0, ext: '' },
    { name: 'c', isDir: false, size: 1, mtimeMs: 0, ext: '' },
  ];
  const sorted = sortFbItems(items, 'size-desc');
  assert.deepEqual(sorted.map(i => i.size), [100, 10, 1]);
});

test('sortFbItems: does not mutate input', () => {
  const items = [
    { name: 'b', isDir: false, size: 0, mtimeMs: 0, ext: '' },
    { name: 'a', isDir: false, size: 0, mtimeMs: 0, ext: '' },
  ];
  const before = items.map(i => i.name);
  sortFbItems(items, 'name-asc');
  assert.deepEqual(items.map(i => i.name), before);
});

test('sortFbItems: type-asc sorts by extension then name', () => {
  const items = [
    { name: 'b.txt', isDir: false, size: 0, mtimeMs: 0, ext: 'txt' },
    { name: 'a.jpg', isDir: false, size: 0, mtimeMs: 0, ext: 'jpg' },
    { name: 'c.png', isDir: false, size: 0, mtimeMs: 0, ext: 'png' },
  ];
  const sorted = sortFbItems(items, 'type-asc');
  // jpg < png < txt alphabetically
  assert.deepEqual(sorted.map(i => i.ext), ['jpg', 'png', 'txt']);
});
