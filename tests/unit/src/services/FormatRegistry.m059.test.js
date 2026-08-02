// tests/unit/src/services/FormatRegistry.m059.test.js
// ============================================================================
// M-059 regression: ISO-BMFF (ftyp) detection must not default to video/mp4.
// The major brand alone is not definitive (an isom-brand M4A is audio);
// compatible brands are scanned, and everything else is 'ambiguous' so the
// caller is forced to ffprobe the real streams.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fromMagic,
  allExtsByCategory,
  FORMATS,
  ISOBMFF_AMBIGUOUS,
} = require('../../../../src/services/FormatRegistry');

/**
 * Build an ftyp box: [size u32 BE]['ftyp'][major][minor=0][...compatible]
 * @param {string} major - 4-char major brand.
 * @param {string[]} [compatible] - 4-char compatible brands.
 * @param {number} [padTo] - Optionally pad the buffer with trailing zeros.
 */
function ftyp(major, compatible = [], padTo = 0) {
  const brands = Buffer.from(major + '\x00\x00\x00\x00' + compatible.join(''), 'latin1');
  const size = 8 + brands.length;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(size, 0);
  head.write('ftyp', 4, 'latin1');
  let buf = Buffer.concat([head, brands]);
  if (padTo > buf.length) buf = Buffer.concat([buf, Buffer.alloc(padTo - buf.length)]);
  return buf;
}

test('M-059: definitive major brands still resolve directly', () => {
  assert.equal(fromMagic(ftyp('avif')).id, 'avif');
  assert.equal(fromMagic(ftyp('avis')).id, 'avif');
  assert.equal(fromMagic(ftyp('M4A ')).id, 'm4a');
  assert.equal(fromMagic(ftyp('M4B ')).id, 'm4a');
});

test('M-059: isom-brand M4A is detected via the compatible-brands scan, not as mp4', () => {
  // Many AAC encoders write major=isom with M4A among the compatible brands.
  const detected = fromMagic(ftyp('isom', ['iso2', 'M4A ', 'mp41']));
  assert.equal(detected.id, 'm4a');
  assert.equal(detected.category, 'audio');
});

test('M-059: mif1-brand AVIF is detected via the compatible-brands scan', () => {
  const detected = fromMagic(ftyp('mif1', ['miaf', 'avif']));
  assert.equal(detected.id, 'avif');
  assert.equal(detected.category, 'image');
});

test('M-059: generic ISO-BMFF brands return the ambiguous entry, NEVER video/mp4', () => {
  for (const major of ['isom', 'mp42', 'mp41', 'dash', 'MSNV', 'qt  ']) {
    const detected = fromMagic(ftyp(major, ['isom', 'iso2']));
    assert.equal(detected, ISOBMFF_AMBIGUOUS, `major=${JSON.stringify(major)}`);
    assert.equal(detected.category, 'ambiguous');
    assert.notEqual(detected.category, 'video');
    assert.equal(detected.decoderHint, 'ffprobe', 'caller must probe the real streams');
  }
});

test('M-059: a 16-byte header without compatible-brand data is ambiguous', () => {
  // Callers that only read 16 bytes give the scan nothing to work with —
  // the result must still be ambiguous rather than defaulting to mp4.
  const buf = ftyp('isom').slice(0, 16);
  assert.equal(fromMagic(buf), ISOBMFF_AMBIGUOUS);
});

test('M-059: compatible-brand scan respects the ftyp box size boundary', () => {
  // Box size says 16 (no compatible brands); bytes past the box belong to the
  // NEXT box and must not be misread as brands.
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16, 0);
  head.write('ftyp', 4, 'latin1');
  head.write('isom', 8, 'latin1');
  const nextBox = Buffer.from('M4A M4A ', 'latin1'); // looks like a brand but is out of box
  const buf = Buffer.concat([head, nextBox]);
  assert.equal(fromMagic(buf), ISOBMFF_AMBIGUOUS, 'data outside the ftyp box is ignored');
});

test('M-059: ambiguous entry is a detection result, not a registered format', () => {
  assert.equal(FORMATS.has('isobmff'), false);
  // allExtsByCategory must not blow up or grow an 'ambiguous' bucket.
  const cats = allExtsByCategory();
  assert.deepEqual(Object.keys(cats).sort(), ['audio', 'image', 'video']);
});

test('M-059: non-ISO-BMFF detection is unaffected', () => {
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
  assert.equal(fromMagic(png).id, 'png');
  const riffWave = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);
  assert.equal(fromMagic(riffWave).id, 'wav');
});
