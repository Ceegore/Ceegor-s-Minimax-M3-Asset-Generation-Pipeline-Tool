// tests/unit/renderer/tabs/batchImportUnknownKeys.test.js
// H9-008: unknown / misspelled / unsupported keys must be surfaced (not silently
// accepted and then dropped by the executor). buildImportedEntry tags the row
// _defective with a precise reason so the queue editor can show it.
// H9-002: documented aliases resolve to their canonical executor flag.

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
const { buildImportedEntry } = global.window.BatchManager;

test('H9-008 an unknown key flags the row defective', () => {
  const e = buildImportedEntry('image', 'a cat', { '--nonsense-flag': 'x' });
  assert.ok(Array.isArray(e._defective) && e._defective.length > 0, 'row is defective');
  assert.ok(e._defective.some((m) => /nonsense-flag/i.test(m)), 'reason names the unknown key');
});

test('GEWV3-003 legacy image --model image-01 is migrated because the CLI uses it implicitly', () => {
  const e = buildImportedEntry('image', 'a cat', { '--model': 'image-01', '--aspect-ratio': '16:9' });
  assert.ok(!e._defective, 'the old manual\'s default model must remain runnable');
  assert.equal(e['--model'], undefined);
  assert.ok(e._importWarnings.some((m) => /legacy image --model/i.test(m)));
});

test('GEWV3-003 image-01-live remains defective because silently changing models is unsafe', () => {
  const e = buildImportedEntry('image', 'a cat', { '--model': 'image-01-live' });
  assert.ok(e._defective && e._defective.some((m) => /model/i.test(m)));
});

test('legacy speech sample-rate 48000 is migrated to supported 44100 Hz', () => {
  const e = buildImportedEntry('speech', 'Hello', { '--model': 'speech-2.8-hd', '--sample-rate': '48000' });
  assert.ok(!e._defective, JSON.stringify(e._defective));
  assert.equal(e['--sample-rate'], '44100');
  assert.ok(e._importWarnings.some((m) => /48000.*44100/i.test(m)));
});

test('unsupported prompt-to-SFX rows are blocked with safe, actionable guidance', () => {
  const e = buildImportedEntry('speech', 'short metallic UI click', { '--sound-effect': true });
  assert.ok(e._defective && e._defective.some((m) => /not supported by the bundled mmx-cli/i.test(m)));
  assert.ok(e._defective.some((m) => /not run as speech/i.test(m)), 'must explain that accidental TTS was prevented');
});

test('H9-008 a supported image key does NOT flag the row', () => {
  const e = buildImportedEntry('image', 'a cat', { '--aspect-ratio': '16:9' });
  assert.ok(!e._defective, 'no defect for known keys (got ' + JSON.stringify(e._defective) + ')');
});

test('H9-008 tool-level keys (variants, upscale, crop) are recognized', () => {
  const e = buildImportedEntry('image', 'a cat', { '--variants': '3', '--upscale': 'true', '--crop': '512x512' });
  // variants/upscale/crop are not unknown (they may still be _defective for OTHER reasons).
  const unknownReason = (e._defective || []).find((m) => /Unknown or unsupported/i.test(m));
  assert.ok(!unknownReason, 'tool keys must not be reported unknown: ' + unknownReason);
});

test('H9-002 image --subject-reference-file resolves to the canonical --subject-ref', () => {
  const e = buildImportedEntry('image', 'a cat', { '--subject-reference-file': 'C:/ref.png' });
  assert.equal(e['--subject-ref'], 'C:/ref.png', 'alias resolved to canonical executor flag');
  assert.ok(!e['--subject-reference-file'], 'old alias key removed');
});

test('H9-002 video --first-frame-image resolves to --first-frame', () => {
  const e = buildImportedEntry('video', 'a drone shot', { '--first-frame-image': 'C:/f.png', '--model': 'MiniMax-Hailuo-2.3' });
  assert.equal(e['--first-frame'], 'C:/f.png');
  assert.ok(!e['--first-frame-image']);
});

test('H9-002 video --last-frame-image resolves to --last-frame', () => {
  const e = buildImportedEntry('video', 'a drone shot', { '--last-frame-image': 'C:/l.png', '--first-frame': 'C:/f.png', '--model': 'MiniMax-Hailuo-02' });
  assert.equal(e['--last-frame'], 'C:/l.png');
});

test('H9-002 video --subject-image is NOT aliased (it is the executor canonical flag)', () => {
  // Regression: --subject-image was wrongly aliased to --subject-ref, which made
  // the S2V-01 subject reference silently disappear (the video tab never reads
  // --subject-ref). It must be preserved verbatim.
  const e = buildImportedEntry('video', 'a shot', { '--subject-image': 'C:/face.png', '--model': 'S2V-01' });
  assert.equal(e['--subject-image'], 'C:/face.png', 'subject-image preserved');
  assert.ok(!e['--subject-ref'], 'not renamed to the image-only --subject-ref');
});

test('H9-002 a misspelled alias is NOT silently resolved (it stays unknown)', () => {
  const e = buildImportedEntry('video', 'a shot', { '--first-frame-imge': 'C:/f.png' });
  assert.ok(e._defective && e._defective.some((m) => /first-frame-imge/i.test(m)), 'typo flagged, not silently resolved');
});
