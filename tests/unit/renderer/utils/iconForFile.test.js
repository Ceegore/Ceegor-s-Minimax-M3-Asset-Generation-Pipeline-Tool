// tests/unit/renderer/utils/iconForFile.test.js
// Regression tests for the file-type icon helper. The previous
// version used single-emoji glyphs that disappeared on the
// dark theme (the music-note 🎵 was especially hard to see).
// v1.1.15 switched to higher-contrast glyphs and added a
// per-type CSS class so the CSS can colour-tint the icon's
// background.

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
require('../../../../renderer/utils/pureFuncs.js');

const { iconForFile, iconClassForFile } = window.PureFuncs;

test('iconForFile returns the image emoji for image extensions', () => {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']) {
    assert.equal(iconForFile(ext), '🖼️', `image icon for ${ext}`);
  }
});

test('iconForFile returns the music emoji (the new colourful one) for audio', () => {
  // v1.1.15: the old 🎵 (single, dark-blue note) was almost
  // invisible on the dark theme. The new 🎶 (colourful double
  // note) is clearly visible. This test pins the new glyph
  // so a future "tweak" can't silently swap it back to 🎵.
  for (const ext of ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.opus', '.pcm', '.aac', '.wma', '.aif', '.aiff']) {
    assert.equal(iconForFile(ext), '🎶', `audio icon for ${ext}`);
  }
});

test('iconForFile returns the video emoji for video extensions', () => {
  for (const ext of ['.mp4', '.mov', '.webm', '.mkv', '.avi']) {
    assert.equal(iconForFile(ext), '🎞️', `video icon for ${ext}`);
  }
});

test('iconForFile returns the text emoji for text / subtitle extensions', () => {
  for (const ext of ['.srt', '.txt', '.json', '.md', '.lrc']) {
    assert.equal(iconForFile(ext), '📝', `text icon for ${ext}`);
  }
});

test('iconForFile falls back to a generic document icon for unknown extensions', () => {
  assert.equal(iconForFile('.exe'), '📄');
  assert.equal(iconForFile(''), '📄');
  assert.equal(iconForFile('.unknown'), '📄');
});

test('iconClassForFile returns the image class for image extensions', () => {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']) {
    assert.equal(iconClassForFile(ext), 'fb-icon-image', `image class for ${ext}`);
  }
});

test('iconClassForFile returns the audio class for audio extensions', () => {
  for (const ext of ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.opus', '.pcm', '.aac', '.wma', '.aif', '.aiff']) {
    assert.equal(iconClassForFile(ext), 'fb-icon-audio', `audio class for ${ext}`);
  }
});

test('iconClassForFile returns the video class for video extensions', () => {
  for (const ext of ['.mp4', '.mov', '.webm', '.mkv', '.avi']) {
    assert.equal(iconClassForFile(ext), 'fb-icon-video', `video class for ${ext}`);
  }
});

test('iconClassForFile returns the text class for text / subtitle extensions', () => {
  for (const ext of ['.srt', '.txt', '.json', '.md', '.lrc']) {
    assert.equal(iconClassForFile(ext), 'fb-icon-text', `text class for ${ext}`);
  }
});

test('iconClassForFile returns a fallback class for unknown extensions', () => {
  assert.equal(iconClassForFile('.exe'), 'fb-icon-other');
  assert.equal(iconClassForFile(''), 'fb-icon-other');
  assert.equal(iconClassForFile('.unknown'), 'fb-icon-other');
});
