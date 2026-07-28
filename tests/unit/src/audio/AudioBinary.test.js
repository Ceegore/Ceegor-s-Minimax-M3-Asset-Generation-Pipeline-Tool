// tests/unit/src/audio/AudioBinary.test.js
// Regression test for BUG-7: "Audio cutter: Could not read the audio
// file: Could not read audio metadata (unsupported format? corrupt
// file?)" — root cause was that `ffmpeg-static`'s binary path lives
// inside `app.asar`, and spawn() cannot execute a binary from inside
// the asar (it's a virtual read-only mount). electron-builder extracts
// such binaries to `app.asar.unpacked`, and AudioBinary.js must map
// the asar path to the unpacked twin BEFORE spawning.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { resolveAsarPath } = require('../../../../src/audio/AudioBinary.js');

test('resolveAsarPath: app.asar/foo -> app.asar.unpacked/foo', () => {
  assert.equal(
    resolveAsarPath('/some/dir/app.asar/node_modules/ffmpeg-static/ffmpeg.exe'),
    path.join('/some/dir/app.asar.unpacked', 'node_modules/ffmpeg-static/ffmpeg.exe')
  );
});

test('resolveAsarPath: C:\\app.asar\\foo -> C:\\app.asar.unpacked\\foo', () => {
  assert.equal(
    resolveAsarPath('C:\\proj\\dist\\win-unpacked\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe'),
    'C:\\proj\\dist\\win-unpacked\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe'
  );
});

test('resolveAsarPath: non-asar path is returned unchanged', () => {
  assert.equal(resolveAsarPath('/usr/bin/ffmpeg'), '/usr/bin/ffmpeg');
  assert.equal(resolveAsarPath('C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'),
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe');
});

test('resolveAsarPath: empty/null returns the input', () => {
  assert.equal(resolveAsarPath(''), '');
  assert.equal(resolveAsarPath(null), null);
});

test('findBinary: dev mode returns a usable path on this machine', () => {
  // Skip on environments where ffmpeg is not installed at all.
  const { findBinary } = require('../../../../src/audio/AudioBinary.js');
  const p = findBinary();
  // We do NOT assert a specific path; just that if a binary is
  // present on PATH or in node_modules, findBinary returns a
  // string. CI may run without ffmpeg-static installed; in that
  // case the result is null and we skip the executable check.
  if (p) {
    assert.equal(typeof p, 'string');
    // The path must NOT contain the literal string `app.asar/` —
    // either it was never an asar path (dev), or resolveAsarPath
    // rewrote it. Either way, the resolved path must be spawn-able.
    assert.ok(!p.includes('app.asar' + path.sep),
      'findBinary must NOT return an asar-internal path');
  }
});