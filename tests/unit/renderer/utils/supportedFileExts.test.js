// tests/unit/renderer/utils/supportedFileExts.test.js
// Regression tests for the file-browser's supported-asset-types filter.
//
// H7-019: the earlier version of this test DUPLICATED the extension list
// inline, so it never caught the real bug — `.avif` (which the image
// optimizer/pipeline reads AND writes) was missing from the live list and
// generated AVIFs were hidden in the browser. This version parses the ACTUAL
// `SUPPORTED_FILE_EXTS` array literal out of renderer/services/fileBrowser1.js
// so a future regression is caught at test time (loading the whole script in a
// sandbox is fragile — it has many DOM deps — so we read the constant by
// source-scanning instead).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function extractLiveExts() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'renderer', 'services', 'fileBrowser1.js'),
    'utf8',
  );
  // Grab the SUPPORTED_FILE_EXTS array body (from the assignment up to the
  // closing `];`).
  const m = src.match(/const SUPPORTED_FILE_EXTS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, 'could not find SUPPORTED_FILE_EXTS array literal in fileBrowser1.js');
  // Pull out every quoted extension token.
  const exts = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) {
    const tok = mm[1] != null ? mm[1] : mm[2];
    if (tok.startsWith('.')) exts.push(tok);
  }
  return exts;
}

const SUPPORTED_FILE_EXTS = extractLiveExts();
const _set = new Set(SUPPORTED_FILE_EXTS);
function isSupported(it) {
  if (!it) return false;
  if (it.isDir) return true;
  return _set.has((it.ext || '').toLowerCase());
}

test('SUPPORTED_FILE_EXTS is read from the live source (not duplicated)', () => {
  assert.ok(SUPPORTED_FILE_EXTS.length > 20, 'expected a populated extension list');
});

test('H7-019: SUPPORTED_FILE_EXTS includes .avif (optimizer can write AVIF)', () => {
  assert.ok(_set.has('.avif'), '.avif must be in the supported list so generated/converted AVIFs are visible');
});

test('SUPPORTED_FILE_EXTS includes all image formats the pipeline handles', () => {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']) {
    assert.ok(_set.has(ext), `${ext} should be in the supported list`);
  }
});

test('SUPPORTED_FILE_EXTS includes all audio formats the cutter handles', () => {
  for (const ext of ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.opus', '.pcm', '.aac', '.wma', '.aif', '.aiff']) {
    assert.ok(_set.has(ext), `${ext} should be in the supported list`);
  }
});

test('SUPPORTED_FILE_EXTS includes all video formats the preview pane handles', () => {
  for (const ext of ['.mp4', '.webm', '.mov', '.mkv', '.avi']) {
    assert.ok(_set.has(ext), `${ext} should be in the supported list`);
  }
});

test('SUPPORTED_FILE_EXTS includes all text / subtitle formats', () => {
  for (const ext of ['.txt', '.srt', '.json', '.md', '.lrc']) {
    assert.ok(_set.has(ext), `${ext} should be in the supported list`);
  }
});

test('SUPPORTED_FILE_EXTS does NOT include .exe / .dll / .bat', () => {
  for (const ext of ['.exe', '.dll', '.bat', '.sh', '.ps1']) {
    assert.ok(!_set.has(ext), `${ext} should NOT be in the supported list`);
  }
});

test('isSupported returns true for every entry in the supported list', () => {
  for (const ext of SUPPORTED_FILE_EXTS) {
    assert.ok(isSupported({ isDir: false, ext }), `${ext} should be supported`);
  }
});

test('isSupported returns true for directories', () => {
  assert.ok(isSupported({ isDir: true, ext: '' }));
  assert.ok(isSupported({ isDir: true, ext: '.whatever' }));
});

test('isSupported returns false for unsupported files', () => {
  for (const it of [
    { isDir: false, ext: '.exe' },
    { isDir: false, ext: '.dll' },
    { isDir: false, ext: '.bat' },
    { isDir: false, ext: '' },
    null,
    undefined,
  ]) {
    assert.equal(isSupported(it), false, `should reject ${JSON.stringify(it)}`);
  }
});

test('isSupported is case-insensitive on the extension', () => {
  assert.ok(isSupported({ isDir: false, ext: '.PNG' }));
  assert.ok(isSupported({ isDir: false, ext: '.Mp3' }));
  assert.ok(isSupported({ isDir: false, ext: '.AVIF' }));
});
