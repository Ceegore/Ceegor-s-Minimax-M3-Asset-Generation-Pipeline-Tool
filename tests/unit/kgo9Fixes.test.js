// Regression guards for QA run 16 (_kgooo8.md).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// KGO9-001 — the inpaint models' tensor conventions.
//
// `lama-big` was fed ImageNet-normalised input and its output de-normalised
// with (v*std+mean)*255. Measured against the real bin/models/lama-big.onnx,
// that export wants plain 0..1 input and already emits 0..255, so every
// channel saturated and the AI heal produced a pure-WHITE patch. A float32
// output is NOT automatically in normalised space — that assumption is the bug.
// ---------------------------------------------------------------------------
test('KGO9-001: every inpaint model declares its I/O scale explicitly', () => {
  const { MODELS } = require(path.join(ROOT, 'src', 'inpaint', 'modelRegistry.js'));
  for (const [key, m] of Object.entries(MODELS)) {
    assert.ok(m.inputScale, `${key} must declare inputScale — the two models genuinely differ`);
    assert.ok(m.outputScale, `${key} must declare outputScale`);
    assert.ok(['0..1', 'imagenet', 'uint8'].includes(m.inputScale), `${key} inputScale "${m.inputScale}" is not a known convention`);
    assert.ok(['0..255', 'normalised'].includes(m.outputScale), `${key} outputScale "${m.outputScale}" is not a known convention`);
  }
});

test('KGO9-001: lama-big uses 0..1 in / 0..255 out (measured against the real export)', () => {
  const { getModel } = require(path.join(ROOT, 'src', 'inpaint', 'modelRegistry.js'));
  const m = getModel('lama-big');
  assert.strictEqual(m.inputScale, '0..1',
    'the Carve LaMa export wants plain v/255; ImageNet normalisation gave outsideMAE 84.1 vs 0.0');
  assert.strictEqual(m.outputScale, '0..255',
    'the raw output range is 0.000..255.000 — de-normalising it saturates every channel to white');
});

test('KGO9-001: inpaint_node honours the declared scales, not the tensor dtype', () => {
  const src = read('src/inpaint/inpaint_node.js');
  assert.match(src, /m\.inputScale === '0\.\.1'/,
    'buildFeeds must branch on the declared input scale');
  assert.match(src, /m\.outputScale === '0\.\.255'/,
    'the de-normalisation must branch on the declared output scale, not only on out.type === uint8');
});

// ---------------------------------------------------------------------------
// KGO9-002 — the legacy adapter destroyed handler-supplied warnings.
// `{...result, ...validated.value}` let a stderr-derived (usually empty)
// warnings array overwrite the handler's own. image:optimize is routed through
// the adapter, so its "kept the original" notice never reached the renderer.
// ---------------------------------------------------------------------------
test('KGO9-002: the legacy adapter MERGES handler warnings instead of replacing them', () => {
  const { adaptInpaintResult } = require(path.join(ROOT, 'main', 'ipc', 'legacyAdapter.js'));
  const out = adaptInpaintResult({
    ok: true,
    outputPath: 'C:\\x\\y.png',
    warnings: ['Re-encoding would have produced a LARGER file; the original was kept.'],
    stderr: '',
  }, 'sharp');
  assert.ok(Array.isArray(out.warnings), 'warnings must be an array');
  assert.ok(out.warnings.some((w) => /LARGER file/.test(w)),
    `the handler's own warning must survive the adapter, got ${JSON.stringify(out.warnings)}`);
});

test('KGO9-002: handler warnings and stderr warnings both survive together', () => {
  const { adaptInpaintResult } = require(path.join(ROOT, 'main', 'ipc', 'legacyAdapter.js'));
  const out = adaptInpaintResult({
    ok: true,
    outputPath: 'C:\\x\\y.png',
    warnings: ['from-handler'],
    stderr: 'from-stderr',
  }, 'sharp');
  assert.ok(out.warnings.includes('from-handler'), 'handler warning lost');
  assert.ok(out.warnings.some((w) => /from-stderr/.test(w)), 'stderr warning lost');
});

test('KGO9-002: a non-array warnings field cannot corrupt the envelope', () => {
  const { adaptInpaintResult } = require(path.join(ROOT, 'main', 'ipc', 'legacyAdapter.js'));
  for (const bad of ['a string', 42, { a: 1 }, null, undefined]) {
    const out = adaptInpaintResult({ ok: true, outputPath: 'C:\\x\\y.png', warnings: bad, stderr: '' }, 'sharp');
    assert.ok(Array.isArray(out.warnings), `warnings must stay an array for ${JSON.stringify(bad)}`);
  }
  // empty/whitespace entries are dropped, not forwarded as blank toasts
  const out = adaptInpaintResult({ ok: true, outputPath: 'C:\\x\\y.png', warnings: ['', '   ', 'real'], stderr: '' }, 'sharp');
  assert.deepStrictEqual(out.warnings, ['real']);
});

// ---------------------------------------------------------------------------
// KGO9-003 — asyncPrompt ignored Enter when no `expect` was supplied.
// ---------------------------------------------------------------------------
test('KGO9-003: asyncPrompt wires Enter outside the expect-only branch', () => {
  const src = read('renderer/sections/section19_Modal.js');
  const fn = src.slice(src.indexOf('function asyncPrompt'));
  // Slice exactly the body of `if (expect != null) { … }` by walking braces,
  // so the check cannot accidentally include the code that follows it.
  const start = fn.indexOf('if (expect != null)');
  assert.ok(start > -1, 'the expect-gating branch must still exist');
  const open = fn.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < fn.length; i++) {
    if (fn[i] === '{') depth++;
    else if (fn[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const expectBlock = fn.slice(open, end + 1);
  assert.doesNotMatch(expectBlock, /'keydown'/,
    'the Enter listener must NOT live inside `if (expect != null)` — free-form prompts could only be submitted with the mouse');
  assert.match(fn, /addEventListener\('keydown'[\s\S]{0,120}e\.key === 'Enter'[\s\S]{0,80}confirmBtn\.disabled/,
    'Enter must submit in both modes, guarded on the confirm button being enabled');
});

// ---------------------------------------------------------------------------
// KGO9-005 — the over-ceiling resize error quoted the clamped width.
// ---------------------------------------------------------------------------
test('KGO9-005: the pixel-ceiling check runs on the REQUESTED size', async () => {
  const os = require('os');
  const sharp = require('sharp');
  const { resize } = require(path.join(ROOT, 'src', 'imageResize.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-kgo9-'));
  try {
    const src = path.join(dir, 's.png');
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#204080' } }).png().toFile(src);
    const r = await resize(src, { outputPath: path.join(dir, 'o.png'), width: 66000, height: 5000 });
    assert.strictEqual(r.ok, false, 'a 330 MP target must be rejected');
    assert.match(r.error, /66000×5000/,
      `the message must name the size the user asked for, got: ${r.error}`);
    assert.doesNotMatch(r.error, /65500×5000/,
      'the message must not quote the per-axis-clamped width the user never typed');
    // a legitimate large-but-allowed size still works
    const ok = await resize(src, { outputPath: path.join(dir, 'ok.png'), width: 8000, height: 6000 });
    assert.strictEqual(ok.ok, true, `8000×6000 (48 MP) must still be allowed: ${ok.error}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
