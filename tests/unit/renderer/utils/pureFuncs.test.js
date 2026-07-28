// tests/unit/renderer/utils/pureFuncs.test.js
// Pure-helper coverage for renderer/utils/pureFuncs.js. Focuses on
// parentDir (file-browser ".." navigation) whose drive-root / POSIX-root
// handling regressed silently before (parentDir('C:\work') -> 'C:', a
// drive-CURRENT-dir reference, and parentDir('/a') -> '').
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
require('../../../../renderer/utils/pureFuncs.js');
const { parentDir, derivedOutputPath, parseAspect, humanSize, iconForFile } = window.PureFuncs;

// ---------------------------------------------------------------------------
// parentDir — Windows drive paths
// ---------------------------------------------------------------------------
test('parentDir: parent of a dir directly under a drive root is the drive ROOT (C:\\), not the bare drive letter (C:)', () => {
  // Regression: a bare "C:" is the drive's CURRENT directory on Windows, not
  // the root. The file-browser ".." from C:\work must land on C:\ — landing
  // on C: would list whatever the main process's drive-C cwd happens to be.
  assert.equal(parentDir('C:\\work'), 'C:\\');
  assert.equal(parentDir('D:\\x'), 'D:\\');
});

test('parentDir: normal Windows parent', () => {
  assert.equal(parentDir('C:\\work\\sub'), 'C:\\work');
  assert.equal(parentDir('C:\\a\\b\\c.png'), 'C:\\a\\b');
});

test('parentDir: the drive root itself has no parent', () => {
  assert.equal(parentDir('C:\\'), '');
  assert.equal(parentDir('C:'), '');
});

// ---------------------------------------------------------------------------
// parentDir — UNC paths
// ---------------------------------------------------------------------------
test('parentDir: UNC paths keep the leading double-backslash', () => {
  assert.equal(parentDir('\\\\server\\share\\dir'), '\\\\server\\share');
  assert.equal(parentDir('\\\\server\\share'), '\\\\server');
});

// ---------------------------------------------------------------------------
// parentDir — POSIX paths
// ---------------------------------------------------------------------------
test('parentDir: parent of a single component under the POSIX root is the root (/)', () => {
  // Regression: parentDir('/a') used to return '' (no parent) instead of '/'.
  assert.equal(parentDir('/a'), '/');
});

test('parentDir: normal POSIX parent', () => {
  assert.equal(parentDir('/work/a'), '/work');
  assert.equal(parentDir('/a/b/c.png'), '/a/b');
});

// ---------------------------------------------------------------------------
// parentDir — relative / degenerate inputs
// ---------------------------------------------------------------------------
test('parentDir: a bare relative name has no parent', () => {
  assert.equal(parentDir('a.png'), '');
  assert.equal(parentDir('a'), '');
});

test('parentDir: empty / falsy returns empty string', () => {
  assert.equal(parentDir(''), '');
  assert.equal(parentDir(null), '');
  assert.equal(parentDir(undefined), '');
});

// ---------------------------------------------------------------------------
// derivedOutputPath
// ---------------------------------------------------------------------------
test('derivedOutputPath: inserts the infix between stem and extension (absolute Windows path)', () => {
  assert.equal(derivedOutputPath('C:\\w\\a.png', '_2x'), 'C:\\w\\a_2x.png');
});

test('derivedOutputPath: handles a dot in a directory name (does not cut at the dir dot)', () => {
  assert.equal(derivedOutputPath('C:\\my.dir\\a.png', '_crop'), 'C:\\my.dir\\a_crop.png');
});

test('derivedOutputPath: no extension -> infix appended to the stem', () => {
  assert.equal(derivedOutputPath('C:\\w\\README', '_bak'), 'C:\\w\\README_bak');
});

// ---------------------------------------------------------------------------
// parseAspect
// ---------------------------------------------------------------------------
test('parseAspect: parses "W:H" into {w,h}', () => {
  assert.deepEqual(parseAspect('16:9'), { w: 16, h: 9 });
  assert.deepEqual(parseAspect('1:1'), { w: 1, h: 1 });
});

test('parseAspect: rejects malformed input', () => {
  assert.equal(parseAspect(''), null);
  assert.equal(parseAspect(null), null);
  assert.equal(parseAspect('16x9'), null);
  assert.equal(parseAspect('16:9:4'), null);
  assert.equal(parseAspect('a:b'), null);
});

// ---------------------------------------------------------------------------
// humanSize
// ---------------------------------------------------------------------------
test('humanSize: formats bytes / KB / MB / GB', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(1023), '1023 B');
  assert.equal(humanSize(1024), '1.0 KB');
  assert.equal(humanSize(1024 * 1024), '1.0 MB');
  assert.equal(humanSize(1024 * 1024 * 1024), '1.00 GB');
});

// ---------------------------------------------------------------------------
// iconForFile
// ---------------------------------------------------------------------------
test('iconForFile: case-insensitive + tolerant of a leading dot', () => {
  assert.equal(iconForFile('.PNG'), iconForFile('png'));
  assert.equal(iconForFile('MP3'), iconForFile('mp3'));
  assert.equal(iconForFile('unknown-ext'), iconForFile(''));
});
