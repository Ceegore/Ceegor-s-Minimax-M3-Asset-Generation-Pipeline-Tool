// tests/unit/mmxArgSanitizer.b005.test.js
// ============================================================================
// B-005 — the per-subcommand allowlists must cover every flag the UI's REAL
// argv builders emit. Acceptance criterion from the audit report:
//
//   "every tab's real default argv passes the production sanitizer;
//    unknown flags still fail closed."
//
// This test does NOT hand-copy flag lists (that's how the drift happened in
// the first place). It loads renderer/tabs/argvBuilders.js — the actual
// production builders — feeds each one a params object with EVERY feature
// enabled, and pushes the resulting argv through the production
// sanitizeOrReject(). A newly added UI flag that is missing from the
// allowlist fails here immediately.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const { sanitizeOrReject } = require(path.join(ROOT, 'src', 'mmxArgSanitizer'));

// ---------------------------------------------------------------------------
// Load the production argv builders in a minimal window sandbox.
// ---------------------------------------------------------------------------
function loadBuilders() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'argvBuilders.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'argvBuilders.js' });
  assert.ok(sandbox.ArgvBuilders, 'argvBuilders.js must export window.ArgvBuilders');
  return sandbox.ArgvBuilders;
}

// Deterministic ctx stubs — the builders only need paths back.
const CTX = {
  outputDir: 'C:\\out',
  filePrefix: '',
  filePrefixForceOnly: false,
  styles: [{ name: 'Anime', value: 'anime style' }],
  slugify: (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
  uniquePath: async (dir, name) => path.join(dir, name),
  nextFreeForcePrefixPath: async (dir, counter, prefix, ext) => path.join(dir, `${prefix}1.${ext}`),
  timestamp: () => '20260731-120000',
};

// ---------------------------------------------------------------------------
// Full-feature params per tab: every optional flag the builder can emit.
// ---------------------------------------------------------------------------
const FULL_PARAMS = {
  image: {
    prompt: 'a red fox', style: 'Anime', 'aspect-ratio': '16:9', n: '1',
    width: '1024', height: '576', seed: '42', 'prompt-optimizer': 'on',
    'aigc-watermark': 'on', 'subject-ref': 'C:\\refs\\face.png',
    'response-format': 'url',
  },
  speech: {
    text: 'Hello world', model: 'speech-2.5-hd-preview', voice: 'Wise_Woman',
    speed: '1.1', volume: '1.5', pitch: '2', format: 'mp3',
    'sample-rate': '32000', bitrate: '128000', channels: '2',
    language: 'English', subtitles: 'on', pronunciation: 'omg/oh my god',
  },
  music: {
    prompt: 'calm piano', model: 'music-1.5', lyrics: 'la la la',
    instrumental: 'on', 'lyrics-optimizer': 'on', genre: 'ambient',
    mood: 'calm', vocals: 'female', instruments: 'piano,strings',
    bpm: '90', key: 'C', tempo: 'slow', structure: 'verse-chorus',
    references: 'artist-a', avoid: 'drums', 'use-case': 'background',
    extra: 'soft dynamics', format: 'mp3', 'sample-rate': '44100',
    bitrate: '256000', 'aigc-watermark': 'on', 'output-format': 'url',
  },
  video: {
    prompt: 'a drone shot over mountains', model: 'MiniMax-Hailuo-02',
    'first-frame': 'C:\\refs\\first.png', 'last-frame': 'C:\\refs\\last.png',
    'subject-image': 'C:\\refs\\subject.png', duration: '6',
    resolution: '1080P', 'prompt-optimizer': 'on', 'fast-pretreatment': 'on',
    'poll-interval': '5',
  },
};

for (const tab of ['image', 'speech', 'music', 'video']) {
  test(`B-005: the full-feature ${tab} argv from the production builder passes the sanitizer`, async () => {
    const builders = loadBuilders();
    const built = await builders.buildArgs(tab, FULL_PARAMS[tab], CTX);
    // The builder runs inside a vm realm — copy into a host-realm array so
    // deepStrictEqual doesn't fail on the foreign Array.prototype.
    const args = Array.from(built.args);
    assert.ok(Array.isArray(args) && args.length > 2, 'builder must produce an argv');
    const r = sanitizeOrReject(args);
    assert.equal(r.err, undefined,
      `sanitizer must not reject the real ${tab} argv.\nargv: ${JSON.stringify(args)}\nerr: ${r.err && r.err.stderr}`);
    assert.deepEqual(r.safeArgs, args,
      `sanitizer must pass the real ${tab} argv through UNCHANGED (a silently stripped flag is a silent feature kill).\nargv: ${JSON.stringify(args)}`);
  });
}

// ---------------------------------------------------------------------------
// Fail-closed is preserved: unknown and dangerous flags still get blocked.
// ---------------------------------------------------------------------------
test('B-005: unknown flags still fail closed after the allowlist extension', () => {
  const r = sanitizeOrReject(['image', 'generate', '--prompt', 'x', '--totally-unknown-flag', 'v']);
  assert.ok(r.err, 'an unknown flag must still be rejected');
  assert.match(r.err.stderr, /--totally-unknown-flag/);
});

test('B-005: blocked global flags still fail closed on every subcommand', () => {
  for (const sub of ['image', 'speech', 'music', 'video']) {
    for (const bad of ['--api-key', '--base-url', '--config', '--insecure']) {
      const r = sanitizeOrReject([sub, 'generate', bad, 'evil']);
      assert.ok(r.err, `${sub}: ${bad} must be rejected`);
    }
  }
});
