const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSilenceDetectStderr, invertSilences } = require('../../../../src/audio/AudioSilenceDetect');

test('parseSilenceDetectStderr extracts correct timestamps from ffmpeg stderr', () => {
  const stderr = `
[silencedetect @ 000001f3] silence_start: 1.234
[silencedetect @ 000001f3] silence_end: 3.456 | silence_duration: 2.222
[silencedetect @ 000001f3] silence_start: 5.678
[silencedetect @ 000001f3] silence_end: 8.910 | silence_duration: 3.232
  `;
  const duration = 10;
  const silences = parseSilenceDetectStderr(stderr, duration);
  assert.deepEqual(silences, [
    { start: 1.234, end: 3.456 },
    { start: 5.678, end: 8.910 }
  ]);
});

test('parseSilenceDetectStderr handles unpaired silence_start at EOF', () => {
  const stderr = `
[silencedetect @ 000001f3] silence_start: 7.5
  `;
  const duration = 10;
  const silences = parseSilenceDetectStderr(stderr, duration);
  assert.deepEqual(silences, [
    { start: 7.5, end: 10 }
  ]);
});

test('invertSilences successfully turns silences into sound segments', () => {
  const silences = [
    { start: 1.0, end: 2.5 },
    { start: 4.0, end: 6.0 }
  ];
  const duration = 10.0;
  const sound = invertSilences(silences, duration);
  assert.deepEqual(sound, [
    { start: 0, end: 1.0 },
    { start: 2.5, end: 4.0 },
    { start: 6.0, end: 10.0 }
  ]);
});

test('invertSilences handles empty silences', () => {
  const silences = [];
  const duration = 5.0;
  const sound = invertSilences(silences, duration);
  assert.deepEqual(sound, [
    { start: 0, end: 5.0 }
  ]);
});

test('invertSilences filters out near-zero segments', () => {
  const silences = [
    { start: 0, end: 2.0 },
    { start: 2.00001, end: 4.0 }
  ];
  const duration = 4.0;
  const sound = invertSilences(silences, duration);
  assert.deepEqual(sound, []);
});
