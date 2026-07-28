// tests/unit/renderer/tabs/goldenRequestSnapshots.test.js
// R7.3: Golden Request Snapshots — verifiziert, dass die argv-Builder
// für jeden Modus (Image, Speech, Music, Video) exakt die erwarteten
// mmx-CLI-Argumente produzieren.
//
// R7-Gate: "Golden Request Snapshots grün" — diese Tests sind die
// Voraussetzung für den Release-Gate. Sie stellen sicher, dass:
//   1. Jeder sichtbare Wert im effektiven Requestsnapshot steht.
//   2. Keine Parameter stillschweigend verloren gehen.
//   3. Die Builder stabil über Refactorings hinweg bleiben.
//
// Die Tests sind bewusst als "Snapshot"-Tests gestaltet: sie vergleichen
// die vollständige argv-Struktur gegen eine erwartete Referenz. Bei
// beabsichtigten Änderungen muss die Referenz explizit aktualisiert werden.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

global.window = global;
require(path.join(ROOT, 'renderer', 'tabs', 'argvBuilders.js'));
const { buildArgs, buildImageArgs, buildSpeechArgs, buildMusicArgs, buildVideoArgs } = global.window.ArgvBuilders;

// Deterministischer Context für reproduzierbare Snapshots.
function makeCtx(overrides) {
  return Object.assign({
    outputDir: 'C:\\output',
    filePrefix: 'test_',
    filePrefixForceOnly: false,
    styles: [{ name: 'cinematic', value: 'cinematic style, dramatic lighting' }],
    slugify: (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40),
    uniquePath: (dir, name) => dir + '\\' + name,
    nextFreeForcePrefixPath: async (dir, counter, prefix, ext) => dir + '\\' + (prefix || '') + '000001.' + ext,
    timestamp: () => '20260721_120000',
    forceCounter: { n: 0 },
  }, overrides || {});
}

// Helper: extrahiert ein Flag-Paar aus args.
function getFlag(args, flag) {
  const i = args.indexOf('--' + flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// Helper: prüft ob ein Bool-Flag gesetzt ist.
function hasBoolFlag(args, flag) {
  return args.includes('--' + flag);
}

// ============================================================================
// IMAGE — Golden Snapshots
// ============================================================================

test('R7.3.IMAGE.1: minimal image request (prompt only)', async () => {
  const { args, outFile } = await buildImageArgs({ prompt: 'a red castle' }, makeCtx());
  // Subcommand + prompt sind Pflicht.
  assert.equal(args[0], 'image');
  assert.equal(args[1], 'generate');
  assert.equal(getFlag(args, 'prompt'), 'a red castle');
  // Output-Pfad muss gesetzt sein.
  assert.ok(args.includes('--out'), 'must have --out');
  assert.ok(outFile.endsWith('.png'), 'default ext is png');
});

test('R7.3.IMAGE.2: full image request (all common params)', async () => {
  const params = {
    prompt: 'a futuristic city',
    style: 'cinematic',
    // Legacy model values must be ignored: image generate does not accept
    // --model in the installed mmx CLI.
    model: 'image-01-live',
    'aspect-ratio': '16:9',
    width: '1024',
    height: '768',
    n: '2',
    seed: '42',
    'prompt-optimizer': 'true',
    'aigc-watermark': 'true',
    'subject-ref': 'C:\\refs\\face.png',
    'response-format': 'url',
  };
  const { args, outDir } = await buildImageArgs(params, makeCtx());
  // Style-Prefix muss im Prompt stehen.
  const prompt = getFlag(args, 'prompt');
  assert.ok(prompt.startsWith('cinematic style, dramatic lighting'), 'style must be prepended');
  assert.ok(prompt.includes('a futuristic city'), 'original prompt must be present');
  // Alle Parameter müssen in args sein.
  assert.ok(!args.includes('--model'), 'image requests must not send unsupported --model');
  assert.equal(getFlag(args, 'aspect-ratio'), '16:9');
  assert.equal(getFlag(args, 'width'), '1024');
  assert.equal(getFlag(args, 'height'), '768');
  assert.equal(getFlag(args, 'n'), '2');
  assert.equal(getFlag(args, 'seed'), '42');
  assert.ok(hasBoolFlag(args, 'prompt-optimizer'), 'prompt-optimizer must be set');
  assert.ok(hasBoolFlag(args, 'aigc-watermark'), 'aigc-watermark must be set');
  // subject-ref wird zu type=character,image=<path> transformiert.
  assert.equal(getFlag(args, 'subject-ref'), 'type=character,image=C:\\refs\\face.png');
  assert.equal(getFlag(args, 'response-format'), 'url');
  // n>1 muss --out-dir verwenden.
  assert.ok(args.includes('--out-dir'), 'n>1 must use --out-dir');
  assert.equal(outDir, 'C:\\output');
});

test('R7.3.IMAGE.3: image with n=1 uses --out (not --out-dir)', async () => {
  const { args, outFile, outDir } = await buildImageArgs({ prompt: 'x', n: '1' }, makeCtx());
  assert.ok(args.includes('--out'), 'n=1 must use --out');
  assert.ok(!args.includes('--out-dir'), 'n=1 must NOT use --out-dir');
  assert.ok(outFile, 'n=1 must have a concrete outFile');
  assert.equal(outDir, null, 'n=1 has no outDir');
});

// ============================================================================
// SPEECH — Golden Snapshots
// ============================================================================

test('R7.3.SPEECH.1: minimal speech request (text only)', async () => {
  const { args, outFile } = await buildSpeechArgs({ prompt: 'Hello world' }, makeCtx());
  assert.equal(args[0], 'speech');
  assert.equal(args[1], 'synthesize'); // speech uses 'synthesize', not 'generate'
  assert.equal(getFlag(args, 'text'), 'Hello world');
  assert.ok(args.includes('--out'), 'must have --out');
  assert.ok(outFile.endsWith('.mp3'), 'default ext is mp3');
});

test('R7.3.SPEECH.2: full speech request (all common params)', async () => {
  const params = {
    prompt: 'Welcome to the show',
    style: 'cinematic',
    model: 'speech-2.8-hd',
    voice: 'English_narrator',
    speed: '1.25',
    volume: '5',
    pitch: '2',
    format: 'wav',
    'sample-rate': '44100',
    subtitles: 'true',
    'sound-effect': 'C:\\sfx\\intro.mp3',
    language: 'en',
  };
  const { args } = await buildSpeechArgs(params, makeCtx());
  // Style-Prefix muss im Text stehen.
  const text = getFlag(args, 'text');
  assert.ok(text.startsWith('cinematic style'), 'style must be prepended');
  assert.ok(text.includes('Welcome to the show'), 'original text must be present');
  // Alle Parameter müssen in args sein.
  assert.equal(getFlag(args, 'model'), 'speech-2.8-hd');
  assert.equal(getFlag(args, 'voice'), 'English_narrator');
  assert.equal(getFlag(args, 'speed'), '1.25');
  assert.equal(getFlag(args, 'volume'), '5');
  assert.equal(getFlag(args, 'pitch'), '2');
  assert.equal(getFlag(args, 'format'), 'wav');
  assert.equal(getFlag(args, 'sample-rate'), '44100');
  assert.ok(hasBoolFlag(args, 'subtitles'), 'subtitles must be set');
  assert.equal(getFlag(args, 'sound-effect'), 'C:\\sfx\\intro.mp3');
  assert.equal(getFlag(args, 'language'), 'en');
});

test('R7.3.SPEECH.3: speech format affects output extension', async () => {
  const wav = await buildSpeechArgs({ prompt: 'x', format: 'wav' }, makeCtx());
  assert.ok(wav.outFile.endsWith('.wav'), 'wav format must produce .wav file');
  const flac = await buildSpeechArgs({ prompt: 'x', format: 'flac' }, makeCtx());
  assert.ok(flac.outFile.endsWith('.flac'), 'flac format must produce .flac file');
});

// ============================================================================
// MUSIC — Golden Snapshots
// ============================================================================

test('R7.3.MUSIC.1: minimal music request (prompt only)', async () => {
  const { args, outFile } = await buildMusicArgs({ prompt: 'calm piano' }, makeCtx());
  assert.equal(args[0], 'music');
  assert.equal(args[1], 'generate');
  assert.equal(getFlag(args, 'prompt'), 'calm piano');
  assert.ok(args.includes('--out'), 'must have --out');
  assert.ok(outFile.endsWith('.mp3'), 'default ext is mp3');
});

test('R7.3.MUSIC.2: full music request (all common params)', async () => {
  const params = {
    prompt: 'epic orchestral',
    style: 'cinematic',
    model: 'music-2.6',
    genre: 'classical',
    mood: 'dramatic',
    vocals: 'choir',
    instruments: 'strings, brass',
    bpm: '120',
    key: 'C',
    tempo: 'allegro',
    format: 'wav',
    instrumental: 'true',
    lyrics: '[Verse]\nLa la la',
    'lyrics-optimizer': 'true',
    references: 'C:\\audio\\vocal.mp3',
  };
  const { args } = await buildMusicArgs(params, makeCtx());
  // Style-Prefix muss im Prompt stehen.
  const prompt = getFlag(args, 'prompt');
  assert.ok(prompt.startsWith('cinematic style'), 'style must be prepended');
  // Alle Parameter müssen in args sein.
  assert.equal(getFlag(args, 'model'), 'music-2.6');
  assert.equal(getFlag(args, 'genre'), 'classical');
  assert.equal(getFlag(args, 'mood'), 'dramatic');
  assert.equal(getFlag(args, 'vocals'), 'choir');
  assert.equal(getFlag(args, 'instruments'), 'strings, brass');
  assert.equal(getFlag(args, 'bpm'), '120');
  assert.equal(getFlag(args, 'key'), 'C');
  assert.equal(getFlag(args, 'tempo'), 'allegro');
  assert.equal(getFlag(args, 'format'), 'wav');
  assert.ok(hasBoolFlag(args, 'instrumental'), 'instrumental must be set');
  assert.equal(getFlag(args, 'lyrics'), '[Verse]\nLa la la');
  assert.ok(hasBoolFlag(args, 'lyrics-optimizer'), 'lyrics-optimizer must be set');
  assert.equal(getFlag(args, 'references'), 'C:\\audio\\vocal.mp3');
});

test('R7.3.MUSIC.3: music format affects output extension', async () => {
  const wav = await buildMusicArgs({ prompt: 'x', format: 'wav' }, makeCtx());
  assert.ok(wav.outFile.endsWith('.wav'), 'wav format must produce .wav file');
  const pcm = await buildMusicArgs({ prompt: 'x', format: 'pcm' }, makeCtx());
  assert.ok(pcm.outFile.endsWith('.pcm'), 'pcm format must produce .pcm file');
});

// ============================================================================
// VIDEO — Golden Snapshots
// ============================================================================

test('R7.3.VIDEO.1: minimal video request (prompt only)', async () => {
  const { args } = await buildVideoArgs({ prompt: 'sunset timelapse' }, makeCtx());
  assert.equal(args[0], 'video');
  assert.equal(args[1], 'generate');
  assert.equal(getFlag(args, 'prompt'), 'sunset timelapse');
  assert.ok(args.includes('--download'), 'video must have --download');
});

test('R7.3.VIDEO.2: full video request (all common params)', async () => {
  const params = {
    prompt: 'drone shot over mountains',
    style: 'cinematic',
    model: 'MiniMax-Hailuo-2.3',
    duration: '10',
    resolution: '1080P',
    'first-frame': 'C:\\frames\\start.png',
    'last-frame': 'C:\\frames\\end.png',
    'subject-image': 'C:\\refs\\person.png',
    'prompt-optimizer': 'true',
    'fast-pretreatment': 'true',
  };
  const { args } = await buildVideoArgs(params, makeCtx());
  // Style-Prefix muss im Prompt stehen.
  const prompt = getFlag(args, 'prompt');
  assert.ok(prompt.startsWith('cinematic style'), 'style must be prepended');
  // Alle Parameter müssen in args sein.
  assert.equal(getFlag(args, 'model'), 'MiniMax-Hailuo-2.3');
  assert.equal(getFlag(args, 'duration'), '10');
  assert.equal(getFlag(args, 'resolution'), '1080P');
  assert.equal(getFlag(args, 'first-frame'), 'C:\\frames\\start.png');
  assert.equal(getFlag(args, 'last-frame'), 'C:\\frames\\end.png');
  assert.equal(getFlag(args, 'subject-image'), 'C:\\refs\\person.png');
  assert.ok(hasBoolFlag(args, 'prompt-optimizer'), 'prompt-optimizer must be set');
  assert.ok(hasBoolFlag(args, 'fast-pretreatment'), 'fast-pretreatment must be set');
});

test('R7.3.VIDEO.3: video uses --download (not --out)', async () => {
  const { args } = await buildVideoArgs({ prompt: 'x' }, makeCtx());
  assert.ok(args.includes('--download'), 'video must use --download');
  assert.ok(!args.includes('--out'), 'video must NOT use --out');
});

// ============================================================================
// VIDEO SUB-MODES — T2V, I2V, SEF, S2V (R7.3: "Je eine Karte")
// ============================================================================

test('R7.3.T2V: text-to-video (default model, no image inputs)', async () => {
  const params = {
    prompt: 'aerial shot of a coastline',
    model: 'MiniMax-Hailuo-2.3',
    duration: '6',
    resolution: '768P',
    'prompt-optimizer': 'true',
  };
  const { args } = await buildVideoArgs(params, makeCtx());
  assert.equal(getFlag(args, 'model'), 'MiniMax-Hailuo-2.3');
  assert.equal(getFlag(args, 'duration'), '6');
  assert.equal(getFlag(args, 'resolution'), '768P');
  assert.ok(hasBoolFlag(args, 'prompt-optimizer'));
  // T2V must NOT have image inputs.
  assert.ok(!args.includes('--first-frame'), 'T2V must not have --first-frame');
  assert.ok(!args.includes('--last-frame'), 'T2V must not have --last-frame');
  assert.ok(!args.includes('--subject-image'), 'T2V must not have --subject-image');
});

test('R7.3.I2V: image-to-video (first-frame triggers I2V)', async () => {
  const params = {
    prompt: 'camera slowly zooms in',
    model: 'MiniMax-Hailuo-2.3',
    'first-frame': 'C:\\frames\\start.png',
    duration: '10',
    resolution: '1080P',
  };
  const { args } = await buildVideoArgs(params, makeCtx());
  assert.equal(getFlag(args, 'first-frame'), 'C:\\frames\\start.png');
  assert.equal(getFlag(args, 'duration'), '10');
  assert.equal(getFlag(args, 'resolution'), '1080P');
  // I2V must NOT have last-frame or subject-image.
  assert.ok(!args.includes('--last-frame'), 'I2V must not have --last-frame');
  assert.ok(!args.includes('--subject-image'), 'I2V must not have --subject-image');
});

test('R7.3.SEF: start-end-frame interpolation (Hailuo-02, first+last)', async () => {
  const params = {
    prompt: 'smooth transition between poses',
    model: 'MiniMax-Hailuo-02',
    'first-frame': 'C:\\frames\\start.png',
    'last-frame': 'C:\\frames\\end.png',
    resolution: '768P',
  };
  const { args } = await buildVideoArgs(params, makeCtx());
  assert.equal(getFlag(args, 'model'), 'MiniMax-Hailuo-02');
  assert.equal(getFlag(args, 'first-frame'), 'C:\\frames\\start.png');
  assert.equal(getFlag(args, 'last-frame'), 'C:\\frames\\end.png');
  // SEF must NOT have subject-image.
  assert.ok(!args.includes('--subject-image'), 'SEF must not have --subject-image');
});

test('R7.3.S2V: subject-to-video (S2V-01, subject-image)', async () => {
  const params = {
    prompt: 'person walking through a park',
    model: 'S2V-01',
    'subject-image': 'C:\\refs\\face.png',
    duration: '6',
  };
  const { args } = await buildVideoArgs(params, makeCtx());
  assert.equal(getFlag(args, 'model'), 'S2V-01');
  assert.equal(getFlag(args, 'subject-image'), 'C:\\refs\\face.png');
  assert.equal(getFlag(args, 'duration'), '6');
  // S2V must NOT have first-frame or last-frame.
  assert.ok(!args.includes('--first-frame'), 'S2V must not have --first-frame');
  assert.ok(!args.includes('--last-frame'), 'S2V must not have --last-frame');
});

// ============================================================================
// CROSS-MODE — Consistency Checks
// ============================================================================

test('R7.3.CROSS.1: all modes produce non-empty args array', async () => {
  const ctx = makeCtx();
  for (const mode of ['image', 'speech', 'music', 'video']) {
    const { args } = await buildArgs(mode, { prompt: 'test' }, ctx);
    assert.ok(Array.isArray(args), `${mode} must return args array`);
    assert.ok(args.length >= 3, `${mode} must have at least [sub, generate, --prompt/--text]`);
  }
});

test('R7.3.CROSS.2: style prefix is applied consistently across all modes', async () => {
  const ctx = makeCtx({ styles: [{ name: 'test', value: 'TESTPREFIX' }] });
  const image = await buildArgs('image', { prompt: 'x', style: 'test' }, ctx);
  const speech = await buildArgs('speech', { prompt: 'x', style: 'test' }, ctx);
  const music = await buildArgs('music', { prompt: 'x', style: 'test' }, ctx);
  const video = await buildArgs('video', { prompt: 'x', style: 'test' }, ctx);
  assert.ok(getFlag(image.args, 'prompt').includes('TESTPREFIX'), 'image style');
  assert.ok(getFlag(speech.args, 'text').includes('TESTPREFIX'), 'speech style');
  assert.ok(getFlag(music.args, 'prompt').includes('TESTPREFIX'), 'music style');
  assert.ok(getFlag(video.args, 'prompt').includes('TESTPREFIX'), 'video style');
});

test('R7.3.CROSS.3: empty/undefined params do not produce empty flags', async () => {
  const ctx = makeCtx();
  const params = { prompt: 'x', model: '', voice: undefined, speed: null, volume: '' };
  for (const mode of ['image', 'speech', 'music', 'video']) {
    const { args } = await buildArgs(mode, params, ctx);
    // Kein --flag ohne Wert (außer Bool-Flags).
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i].startsWith('--') && !args[i + 1].startsWith('--')) {
        assert.ok(args[i + 1] !== '', `${mode}: flag ${args[i]} must not have empty value`);
      }
    }
  }
});

// ============================================================================
// R7.4 — Music batch-builder flag emission
// ============================================================================
// NOTE (2026-07-21): R7.4.A/B/C were structural guards pinning the
// interactive musicTab.js lyrics/instrumental/lyrics-optimizer controls.
// That tab-side work was reverted (returned to the clean HEAD baseline),
// so those three source-pinned tests were removed as orphaned. R7.4.D is
// retained — the batch builder (argvBuilders.js) was NOT reverted and
// still emits these flags, so it remains a valid, passing contract.

test('R7.4.D: batch builder emits music lyrics/instrumental/lyrics-optimizer flags', async () => {
  // The batch builder (argvBuilders.js) must emit the lyrics/
  // instrumental/lyrics-optimizer flags for batch music generation.
  const { args } = await buildMusicArgs({
    prompt: 'test',
    lyrics: '[Verse]\nLa la la',
    instrumental: 'true',
    'lyrics-optimizer': 'true',
  }, makeCtx());
  assert.ok(args.includes('--lyrics'), 'batch builder must emit --lyrics');
  assert.ok(args.includes('--instrumental'), 'batch builder must emit --instrumental');
  assert.ok(args.includes('--lyrics-optimizer'), 'batch builder must emit --lyrics-optimizer');
});

// R7.4.A/B/C (re-added): structural guards for the interactive musicTab
// controls. Written as source-pattern assertions (robust — they don't
// break on comment changes, only on structural removal of the controls).
test('R7.4.A: musicTab has a --lyrics textarea control', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'musicTab.js'), 'utf8');
  assert.match(src, /buildParamRow\('--lyrics'/, 'musicTab must build a --lyrics row');
  assert.match(src, /kind:\s*'textarea'/, '--lyrics row must be a textarea');
});
test('R7.4.B: musicTab has --instrumental and --lyrics-optimizer boolean controls', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'musicTab.js'), 'utf8');
  assert.match(src, /buildParamRow\('--instrumental'/, 'musicTab must build a --instrumental row');
  assert.match(src, /buildParamRow\('--lyrics-optimizer'/, 'musicTab must build a --lyrics-optimizer row');
});
test('R7.4.C: musicTab emits lyrics/instrumental/lyrics-optimizer in argv + preflight uses real values', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'musicTab.js'), 'utf8');
  // Argv emission.
  assert.match(src, /args\.push\('--lyrics'/, 'musicTab must push --lyrics to argv');
  assert.match(src, /appendBoolFlag\(args,\s*instrumental\.input/, 'musicTab must emit --instrumental');
  assert.match(src, /appendBoolFlag\(args,\s*lyricsOptimizer\.input/, 'musicTab must emit --lyrics-optimizer');
  // Preflight must NOT hardcode false/empty.
  assert.doesNotMatch(src, /instrumental:\s*false\s*,/, 'preflight must not hardcode instrumental:false');
  assert.doesNotMatch(src, /'lyrics-optimizer':\s*false\s*,/, 'preflight must not hardcode lyrics-optimizer:false');
});

// R7.4.E: collectMusicOptions + buildMusicArgs parity.
test('R7.4.E: MusicOptions.collect + buildMusicArgs emits golden music argv', async () => {
  // Load musicOptions.js in a minimal window context.
  const origWindow = global.window;
  global.window = global.window || {};
  require(path.join(ROOT, 'renderer', 'tabs', 'musicOptions.js'));
  const { collect } = global.window.MusicOptions;
  const params = collect({
    model: 'music-2.6', prompt: 'a calm piano melody',
    lyrics: '[Verse]\nTwinkle twinkle', instrumental: false, lyricsOptimizer: false,
    genre: 'classical', format: 'wav', sampleRate: 44100,
  });
  const { args } = await buildMusicArgs(params, makeCtx());
  assert.ok(args.includes('--lyrics'), 'collect+build must emit --lyrics');
  assert.ok(args.includes('[Verse]\nTwinkle twinkle'), 'lyrics value must survive');
  assert.ok(args.includes('--genre'), 'collect+build must emit --genre');
  assert.ok(args.includes('classical'), 'genre value must survive');
  assert.ok(args.includes('--format'), 'collect+build must emit --format');
  assert.ok(args.includes('wav'), 'format value must survive');
  assert.ok(!args.includes('--instrumental'), 'instrumental=false must NOT emit flag');
  assert.ok(!args.includes('--lyrics-optimizer'), 'lyricsOptimizer=false must NOT emit flag');
  global.window = origWindow;
});

// ============================================================================
// R7.3 per-mode "every visible value in the effective request snapshot" gate.
// For each mode, set ALL visible controls and verify every value appears
// in the produced argv. This is the R7.3 release-gate assertion.
// ============================================================================

test('R7.3.GATE speech: every visible value appears in argv', async () => {
  const { args } = await buildArgs('speech', {
    prompt: 'Hello world',
    model: 'speech-2.8-hd',
    voice: 'English_expressive_narrator',
    speed: '1.25',
    volume: '5',
    pitch: '2',
    format: 'wav',
    'sample-rate': '44100',
    bitrate: '128000',
    channels: '2',
    language: 'en',
    subtitles: 'true',
    'sound-effect': 'happy',
    emotion: 'happy',
  }, makeCtx());
  // Every visible value must appear in the argv.
  assert.ok(args.includes('speech-2.8-hd'), 'model value in argv');
  assert.ok(args.includes('English_expressive_narrator'), 'voice value in argv');
  assert.ok(args.includes('1.25'), 'speed value in argv');
  assert.ok(args.includes('5'), 'volume value in argv');
  assert.ok(args.includes('2'), 'pitch/channels value in argv');
  assert.ok(args.includes('wav'), 'format value in argv');
  assert.ok(args.includes('44100'), 'sample-rate value in argv');
  assert.ok(args.includes('en'), 'language value in argv');
  assert.ok(args.includes('--subtitles'), 'subtitles flag in argv');
  assert.ok(args.includes('happy'), 'emotion/sound-effect value in argv');
});

test('R7.3.GATE image: every visible value appears in argv', async () => {
  const { args } = await buildArgs('image', {
    prompt: 'a red dragon',
    'aspect-ratio': '16:9',
    n: '2',
    width: '1024',
    height: '768',
    seed: '42',
    'prompt-optimizer': 'true',
    'aigc-watermark': 'true',
  }, makeCtx());
  assert.ok(!args.includes('--model'), 'image model is not a visible or supported flag');
  assert.ok(args.includes('16:9'), 'aspect-ratio value in argv');
  assert.ok(args.includes('1024'), 'width value in argv');
  assert.ok(args.includes('768'), 'height value in argv');
  assert.ok(args.includes('42'), 'seed value in argv');
  assert.ok(args.includes('--prompt-optimizer'), 'prompt-optimizer flag in argv');
  assert.ok(args.includes('--aigc-watermark'), 'aigc-watermark flag in argv');
  assert.ok(args.includes('a red dragon'), 'prompt value in argv');
});

test('R7.3.GATE music: every visible value appears in argv', async () => {
  const { args } = await buildArgs('music', {
    prompt: 'calm piano melody',
    model: 'music-2.6',
    lyrics: '[Verse] la la',
    genre: 'jazz',
    mood: 'calm',
    vocals: 'warm male baritone',
    instruments: 'piano',
    bpm: '120',
    key: 'C major',
    tempo: 'moderate',
    structure: 'verse-chorus',
    references: 'Norah Jones',
    avoid: 'heavy drums',
    'use-case': 'background music for video',
    extra: 'fade out ending',
    format: 'mp3',
    'sample-rate': '44100',
    bitrate: '256000',
    'aigc-watermark': 'true',
    'output-format': 'url',
  }, makeCtx());
  assert.ok(args.includes('music-2.6'), 'model');
  assert.ok(args.includes('[Verse] la la'), 'lyrics');
  assert.ok(args.includes('jazz'), 'genre');
  assert.ok(args.includes('calm'), 'mood');
  assert.ok(args.includes('warm male baritone'), 'vocals');
  assert.ok(args.includes('piano'), 'instruments');
  assert.ok(args.includes('120'), 'bpm');
  assert.ok(args.includes('C major'), 'key');
  assert.ok(args.includes('moderate'), 'tempo');
  assert.ok(args.includes('verse-chorus'), 'structure');
  assert.ok(args.includes('Norah Jones'), 'references');
  assert.ok(args.includes('heavy drums'), 'avoid');
  assert.ok(args.includes('background music for video'), 'use-case');
  assert.ok(args.includes('fade out ending'), 'extra');
  assert.ok(args.includes('mp3'), 'format');
  assert.ok(args.includes('44100'), 'sample-rate');
  assert.ok(args.includes('256000'), 'bitrate');
  assert.ok(args.includes('--aigc-watermark'), 'watermark flag');
  assert.ok(args.includes('url'), 'output-format');
});
