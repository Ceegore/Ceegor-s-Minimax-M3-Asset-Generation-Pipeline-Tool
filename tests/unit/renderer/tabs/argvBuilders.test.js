// tests/unit/renderer/tabs/argvBuilders.test.js
// X1-F1/F2: argvBuilders.js is the DEFAULT batch-execution path (H11-3
// direct/snapshot mode) and previously had ZERO tests. Two real bugs slipped
// through as a result:
//   F1: a plain-string batch row (the "+ Add prompt"/"Bulk paste" shape —
//       src/batches.js explicitly preserves this shape) produced an EMPTY
//       --prompt/--text because the pure builders only read params.prompt/
//       params.text, both undefined on a bare string.
//   F2: the image builder re-read params.variants into --n even though the
//       batch loop already owns variant expansion, so variants=4 produced
//       4 loop iterations x --n 4 = 16 outputs.
// These tests pin the fixed behaviour (string-row normalisation happens in
// batchDirectRunner.js; this file guards the builder's own --n contract).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

global.window = global;
require(path.join(ROOT, 'renderer', 'tabs', 'argvBuilders.js'));
const { buildArgs, buildImageArgs } = global.window.ArgvBuilders;

function makeCtx(overrides) {
  let n = 0;
  return Object.assign({
    outputDir: 'C:\\out',
    filePrefix: '',
    filePrefixForceOnly: false,
    styles: [],
    slugify: (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    uniquePath: (dir, name) => dir + '\\' + name,
    nextFreeForcePrefixPath: async (dir, counter, prefix, ext) => dir + '\\' + (prefix || '') + String(++n).padStart(6, '0') + '.' + ext,
    timestamp: () => '20260101_000000',
    forceCounter: { n: 0 },
  }, overrides || {});
}

test('buildImageArgs: object row with a prompt produces a non-empty --prompt', async () => {
  const { args } = await buildImageArgs({ prompt: 'a castle' }, makeCtx());
  const i = args.indexOf('--prompt');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'a castle');
});

test('GEWV3-003: image builder drops legacy --model values', async () => {
  const { args } = await buildImageArgs({ prompt: 'a castle', model: 'image-01-live' }, makeCtx());
  assert.ok(!args.includes('--model'), 'image generate does not support --model');
  assert.ok(!args.includes('image-01-live'), 'legacy model value must not reach argv');
});

test('F2: variants must NOT translate into --n (the batch loop owns variant expansion)', async () => {
  const { args } = await buildImageArgs({ prompt: 'a castle', variants: '4' }, makeCtx());
  assert.ok(!args.includes('--n'), 'builder must not read params.variants into --n');
  assert.ok(!args.includes('--out-dir'), 'a single (non--n) call must use --out, not --out-dir');
  assert.ok(args.includes('--out'));
});

test('F2: an explicit --n (real API n, distinct from batch variants) still works', async () => {
  const { args } = await buildImageArgs({ prompt: 'a castle', n: '3' }, makeCtx());
  const i = args.indexOf('--n');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], '3');
  assert.ok(args.includes('--out-dir'));
});

test('buildArgs dispatches to the four modalities and always includes an --out/--download flag', async () => {
  const ctx = makeCtx();
  const image = await buildArgs('image', { prompt: 'a' }, ctx);
  assert.ok(image.args.includes('--out'));
  const speech = await buildArgs('speech', { prompt: 'hello' }, ctx);
  assert.ok(speech.args.includes('--out'));
  assert.equal(speech.args[speech.args.indexOf('--text') + 1], 'hello');
  const music = await buildArgs('music', { prompt: 'a tune' }, ctx);
  assert.ok(music.args.includes('--out'));
  const video = await buildArgs('video', { prompt: 'a scene' }, ctx);
  assert.ok(video.args.includes('--download'));
});

test('F8: music output format uses --format (the real mmx flag), NOT --audio-format', async () => {
  // mmx `music generate` accepts `--format <mp3|wav|pcm>`; `--audio-format` is
  // unrecognized and silently ignored, which made batch music ignore a
  // requested wav/pcm and emit mp3 audio under a mis-named extension.
  const withKey = await buildArgs('music', { prompt: 'a tune', 'audio-format': 'wav' }, makeCtx());
  assert.ok(withKey.args.includes('--format'), 'must emit --format');
  assert.ok(!withKey.args.includes('--audio-format'), 'must not emit the bogus --audio-format');
  assert.equal(withKey.args[withKey.args.indexOf('--format') + 1], 'wav', 'the value from either row-key must be forwarded');
  // The output file extension must match the requested format (not default mp3).
  assert.ok(/\.wav$/i.test(withKey.outFile), `outFile should be .wav, got ${withKey.outFile}`);
  // Also accept the alternate row key `format`.
  const altKey = await buildArgs('music', { prompt: 'x', format: 'pcm' }, makeCtx());
  assert.equal(altKey.args[altKey.args.indexOf('--format') + 1], 'pcm');
});

test('unknown tab key throws (no silent fallback)', async () => {
  await assert.rejects(() => buildArgs('bogus', { prompt: 'x' }, makeCtx()));
});

test('X3-02: music emits --instrumental / --lyrics / --lyrics-optimizer (were silently dropped)', async () => {
  const inst = await buildArgs('music', { prompt: 'epic', instrumental: 'true' }, makeCtx());
  assert.ok(inst.args.includes('--instrumental'), 'imported --instrumental must reach mmx');
  const lyr = await buildArgs('music', { prompt: 'song', lyrics: '[Verse] hi', 'lyrics-optimizer': 'true' }, makeCtx());
  const li = lyr.args.indexOf('--lyrics');
  assert.ok(li >= 0 && lyr.args[li + 1] === '[Verse] hi', 'imported --lyrics must reach mmx with its text');
  assert.ok(lyr.args.includes('--lyrics-optimizer'), 'imported --lyrics-optimizer must reach mmx');
  // A false/empty value must NOT emit the flag.
  const off = await buildArgs('music', { prompt: 'x', instrumental: 'false', lyrics: '' }, makeCtx());
  assert.ok(!off.args.includes('--instrumental'), 'instrumental:false must not emit the flag');
  assert.ok(!off.args.includes('--lyrics'), 'empty lyrics must not emit --lyrics');
});

test('X3-03: image n>1 uses --out-dir and reports outDir so the runner can scan it', async () => {
  const one = await buildImageArgs({ prompt: 'x', n: '1' }, makeCtx());
  assert.equal(one.outDir, null, 'n=1 is a single --out call, no outDir to scan');
  assert.ok(one.outFile, 'n=1 must produce a concrete outFile');
  const many = await buildImageArgs({ prompt: 'x', n: '4' }, makeCtx());
  assert.ok(many.args.includes('--out-dir'), 'n>1 must use --out-dir');
  assert.equal(many.outFile, null, 'n>1 has no single outFile');
  assert.equal(many.outDir, 'C:\\out', 'n>1 must report the out-dir so batchDirectRunner can scan for the produced files');
});
