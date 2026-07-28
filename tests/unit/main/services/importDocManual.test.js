// tests/unit/main/services/importDocManual.test.js
// Verifies the AI-readable import manual includes every required section so the
// external writing assistant (that converts GDDs → import table) knows all options AND
// all follow-up features, and is told to ask the user the big decision questions
// in a structured flow (Task 5).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { generateManual } = require('../../../../main/services/importDocManual');

test('generateManual produces a non-trivial document', () => {
  const m = generateManual();
  assert.ok(typeof m === 'string' && m.length > 2000, 'manual is a substantial string');
});

test('manual contains the structured workflow (Phase 1-4) the agent must follow', () => {
  const m = generateManual();
  assert.ok(m.includes('Structured workflow'), 'has the structured-workflow heading');
  assert.ok(m.includes('Phase 1'), 'Phase 1 present');
  assert.ok(m.includes('Phase 2'), 'Phase 2 present');
  assert.ok(m.includes('Phase 3'), 'Phase 3 present');
  assert.ok(m.includes('Phase 4'), 'Phase 4 present');
});

test('manual TELLS the agent to ASK THE USER the big decision questions', () => {
  const m = generateManual();
  assert.ok(/ASK THE USER/i.test(m), 'instructs the agent to ask the user');
  // the specific decision questions must each appear
  assert.ok(m.includes('Output folder'), 'output-folder decision present');
  assert.ok(m.includes('Pipeline usage'), 'pipeline-usage decision present');
  assert.ok(m.includes('Style consistency'), 'style-consistency decision present');
  assert.ok(m.includes('Variants'), 'variants decision present');
  assert.ok(m.includes('Format'), 'format decision present');
});

test('manual documents the import table format + HARD limits', () => {
  const m = generateManual();
  assert.ok(m.includes('| Type | Prompt / Text | Parameters |'), 'table header present');
  assert.ok(/HARD character limits/i.test(m), 'HARD limits section present');
  assert.ok(m.includes('image'), 'image type documented');
  assert.ok(m.includes('speech'), 'speech type documented');
  assert.ok(m.includes('music'), 'music type documented');
  assert.ok(m.includes('video'), 'video type documented');
});

test('manual documents ALL follow-up features (so the agent can advise the user)', () => {
  const m = generateManual();
  assert.ok(m.includes('Pipeline'), 'Pipeline follow-up documented');
  assert.ok(/Upscale/.test(m) && /Remove Background/.test(m) && /Crop/.test(m) && /Optimize/.test(m),
    'all four pipeline columns documented');
  assert.ok(m.includes('pixel editor'), 'pixel editor documented');
  assert.ok(m.includes('eraser-to-transparency'), 'eraser-to-alpha documented');
  assert.ok(m.includes('Composite'), '2nd-image composite documented');
  assert.ok(/Heal/.test(m) && /Resynthesize/.test(m), 'heal/inpaint documented');
  assert.ok(m.includes('audio cutter') || m.includes('Audio tools'), 'audio tools documented');
  assert.ok(m.includes('batch'), 'batch operations documented');
});

test('manual documents the style-preset header', () => {
  const m = generateManual();
  assert.ok(/style preset header/i.test(m), 'style header section present');
  assert.ok(m.includes('style:'), 'style header syntax shown');
});

test('manual includes a worked example table', () => {
  const m = generateManual();
  assert.ok(m.includes('Example'), 'example section present');
  assert.ok(m.includes('--model'), 'example uses model flags');
});

// ---- H9-001: descriptions must actually populate (the scraper bug) ----
test('H9-001 every documented flag has a non-empty description', () => {
  const m = generateManual();
  // Grab every bullet of the form "- `--flag`: <desc>" and assert none are blank.
  const lines = m.split('\n');
  const blank = [];
  for (const l of lines) {
    const mm = l.match(/^- `(--[a-z0-9-]+)`: (.*)$/);
    if (!mm) continue;
    if (!mm[2] || mm[2].trim().length < 3) blank.push(mm[1]);
  }
  assert.deepEqual(blank, [], 'no flag may have a blank description: ' + blank.join(', '));
});

test('H9-001 the model flag carries real allowed values + a default', () => {
  const m = generateManual();
  assert.match(m, /`--model`: Generation model[\s\S]*?Allowed:\*\* image-01 \/ image-01-live/);
  assert.match(m, /\*\*Default:\*\* `image-01`/);
});

// ---- H9-002: documented schema matches the executor ----
test('H9-002 the image --subject-ref canonical executor flag is documented', () => {
  const m = generateManual();
  assert.ok(m.includes('--subject-ref'), 'canonical --subject-ref documented');
});

test('H9-002 the video --first-frame / --last-frame canonical flags are documented', () => {
  const m = generateManual();
  assert.ok(m.includes('--first-frame'), 'canonical --first-frame documented');
  assert.ok(m.includes('--last-frame'), 'canonical --last-frame documented');
});

test('H9-002 image --response-format is documented (was missing)', () => {
  const m = generateManual();
  assert.ok(m.includes('--response-format'), '--response-format documented');
});

test('H9-002 video --subject-image is documented as the canonical S2V-01 flag (not aliased away)', () => {
  const m = generateManual();
  // Must appear as a real documented flag with a description, not be folded
  // into an alias of the image-only --subject-ref.
  assert.match(m, /`--subject-image`: Subject \(face\) reference image path[\s\S]*?REQUIRED for the S2V-01 model/);
});

// ---- H9-020: MD and TXT must agree (rendered from one registry) ----
test('H9-020 generateTxtManual is exported and substantial', () => {
  const { generateTxtManual } = require('../../../../main/services/importDocManual');
  const t = generateTxtManual();
  assert.ok(typeof t === 'string' && t.length > 2000, 'TXT manual is substantial');
});

test('H9-020 MD and TXT document the same flag set (no drift)', () => {
  const { generateTxtManual } = require('../../../../main/services/importDocManual');
  const md = generateManual();
  const txt = generateTxtManual();
  // Extract every documented `--flag` from both; compare as sets.
  const mdFlags = new Set((md.match(/`(--[a-z0-9-]+)`/g) || []).map((s) => s.replace(/`/g, '')));
  const txtFlags = new Set();
  for (const line of txt.split('\n')) {
    const mm = line.match(/^- (--[a-z0-9-]+):/);
    if (mm) txtFlags.add(mm[1]);
  }
  // Every TXT flag must appear in MD.
  for (const f of txtFlags) {
    assert.ok(mdFlags.has(f), `TXT flag ${f} missing from MD — drift`);
  }
  // Spot-check the previously-drifting flags are consistent.
  assert.equal(txt.includes('--genre'), md.includes('--genre'), '--genre consistency');
  assert.equal(txt.includes('--emotion'), false, 'TXT must not document the no-op --emotion');
  assert.equal(md.includes('--emotion'), false, 'MD must not document the no-op --emotion');
});

test('H9-020 TXT no longer hard-codes the wrong --upscale-multiplier range', () => {
  const { generateTxtManual } = require('../../../../main/services/importDocManual');
  const t = generateTxtManual();
  // The old template said "2 or 4"; the registry says 2/3/4.
  assert.match(t, /2\/3\/4|2, 3, 4/);
  assert.ok(!/--upscale-multiplier: 2 or 4/.test(t), 'stale "2 or 4" range removed');
});

test('H9-002 the music example does NOT use unimplemented --genre/--bpm', () => {
  const m = generateManual();
  const exampleLine = m.split('\n').find((l) => l.startsWith('| music |'));
  assert.ok(exampleLine, 'music example row present');
  assert.ok(!/--genre/.test(exampleLine), 'no --genre (no live consumer)');
  assert.ok(!/--bpm/.test(exampleLine), 'no --bpm (no live consumer)');
});

// ---- H9-019: manual export fails closed on a broken registry ----
test('H9-019 generateManual throws (does not return error text) when the registry is broken', () => {
  const registry = require('../../../../main/services/importCapabilityRegistry');
  const orig = registry.CAPABILITIES.image.flags;
  // Corrupt one entry's description.
  registry.CAPABILITIES.image.flags = orig.map((f) => f.flag === '--model' ? { flag: '--model', desc: '' } : f);
  try {
    assert.throws(() => generateManual(), /invalid/i, 'must throw on a broken registry');
  } finally {
    registry.CAPABILITIES.image.flags = orig; // restore for other tests
  }
});

// ---- registry unit tests ----
test('H9-002 resolveAlias maps --first-frame-image → --first-frame', () => {
  const { resolveAlias } = require('../../../../main/services/importCapabilityRegistry');
  assert.equal(resolveAlias('video', '--first-frame-image'), '--first-frame');
  assert.equal(resolveAlias('video', '--last-frame-image'), '--last-frame');
  // A non-alias flag is returned unchanged.
  assert.equal(resolveAlias('video', '--duration'), '--duration');
});

test('H9-008 knownFlagsByType recognizes the documented flags', () => {
  const { knownFlagsByType } = require('../../../../main/services/importCapabilityRegistry');
  const known = knownFlagsByType();
  assert.ok(known.image.has('--response-format'));
  assert.ok(known.video.has('--first-frame'));
  assert.ok(known.speech.has('--voice'));
  // cross-type keys
  assert.ok(known.music.has('--variants'));
});
