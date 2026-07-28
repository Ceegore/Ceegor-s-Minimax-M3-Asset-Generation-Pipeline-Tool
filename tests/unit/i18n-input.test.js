// ============================================================================
// Phase 3 — Multilingual input acceptance (Tier 0, offline).
//
// The tool's UI stays English-only (a product decision), but EVERY input path
// must accept arbitrary Unicode and pass it through intact to the API. Chinese
// users are expected; we do not limit ourselves to Chinese. These tests load
// the ACTUAL production functions out of the renderer sources (via vm +
// brace-matched extraction, the same pattern as mmxErrorClassify.test.js) so a
// regression in the real source fails here.
//
// Covered:
//   • computePromptSize counts Unicode CODE POINTS, not UTF-16 code units and
//     not bytes (CJK, emoji / surrogate pairs, combining marks, astral CJK).
//   • slugify / uniquePath produce safe filenames for CJK / Arabic / emoji
//     prompts without collisions.
//   • buildFinalPrompt + style-prefix concatenation preserve UTF-8 exactly.
//   • RTL (Arabic / Hebrew) and mixed-direction prompts do not corrupt the
//     adjacent fields or the composed --prompt token.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
// Lexer-aware extractor (see _fnExtract.js).
const { extractFnSrc } = require('./_fnExtract');

// Load the real production functions into an isolated vm context. `styles`
// seeds state.config.styles so getStyleById / getStyleText / buildFinalPrompt
// resolve real style presets (including Unicode ones).
function loadI18n(styles = []) {
  const appSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const styleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'styleHelpers.js'), 'utf8');
  const counterSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section12_Prompt_character_counter.js'), 'utf8');

  const parts = [
    extractFnSrc(appSrc, 'function slugify(s) {'),
    extractFnSrc(appSrc, 'function uniquePath(dir, name) {'),
    extractFnSrc(styleSrc, 'function getStyleById(id) {'),
    extractFnSrc(styleSrc, 'function getStyleText(id) {'),
    extractFnSrc(styleSrc, "function buildFinalPrompt(selEl, manualEl, extraPrefix = '') {"),
    extractFnSrc(counterSrc, "function computePromptSize(selEl, manualEl, extraPrefix = '') {"),
    'globalThis.slugify = slugify;',
    'globalThis.uniquePath = uniquePath;',
    'globalThis.getStyleText = getStyleText;',
    'globalThis.buildFinalPrompt = buildFinalPrompt;',
    'globalThis.computePromptSize = computePromptSize;',
  ];

  const context = vm.createContext({ state: { config: { styles } } });
  vm.runInContext(parts.join('\n'), context);
  return context;
}

// A minimal stand-in for a <select>/<textarea> — the functions only read .value.
const field = (value) => ({ value });

// ---------------------------------------------------------------------------
// 1. The prompt character counter counts CODE POINTS, not UTF-16 units/bytes.
// ---------------------------------------------------------------------------
test('computePromptSize counts CJK code points exactly', () => {
  const { computePromptSize } = loadI18n();
  // 4 Han characters = 4 code points (all BMP, so also 4 UTF-16 units here).
  assert.equal(computePromptSize(null, field('你好世界')), 4);
  // Hiragana + kanji mix.
  assert.equal(computePromptSize(null, field('こんにちは世界')), 7);
});

test('computePromptSize counts a surrogate-pair emoji as ONE code point (not 2 UTF-16 units, not 4 bytes)', () => {
  const { computePromptSize } = loadI18n();
  // U+1F600 occupies a surrogate pair: String.length === 2, UTF-8 === 4 bytes,
  // but the user perceives ONE character and the API counts ONE code point.
  assert.equal('😀'.length, 2, 'sanity: the emoji is 2 UTF-16 units');
  assert.equal(computePromptSize(null, field('😀')), 1);
  assert.equal(computePromptSize(null, field('🎉🚀')), 2);
});

test('computePromptSize counts astral CJK (Extension B) as ONE code point', () => {
  const { computePromptSize } = loadI18n();
  // U+20000 (𠀀) is an astral Han character: String.length === 2.
  assert.equal('𠀀'.length, 2, 'sanity: astral CJK is 2 UTF-16 units');
  assert.equal(computePromptSize(null, field('𠀀')), 1);
});

test('computePromptSize counts combining marks as separate code points (not bytes, not graphemes)', () => {
  const { computePromptSize } = loadI18n();
  // 'e' + U+0301 combining acute = 2 code points (1 grapheme, 3 UTF-8 bytes).
  const decomposed = 'e\u0301';
  assert.equal(computePromptSize(null, field(decomposed)), 2);
});

test('computePromptSize handles mixed multilingual prompts and includes style + prefix', () => {
  const styles = [{ name: 'anime', value: '动漫风格' }]; // 4 code points
  const { computePromptSize } = loadI18n(styles);
  // manual: 你好(2) + 😀(1) + مرحبا(5) = 8 code points.
  const manual = '你好😀مرحبا';
  assert.equal(Array.from(manual).length, 8, 'sanity: manual prompt is 8 code points');
  // extraPrefix 'ZZPRE_' = 6 code points; style '动漫风格' = 4; manual = 8 → 18.
  assert.equal(computePromptSize(field('anime'), field(manual), 'ZZPRE_'), 6 + 4 + 8);
  // No style, no prefix → just the manual prompt.
  assert.equal(computePromptSize(field(''), field(manual)), 8);
});

// ---------------------------------------------------------------------------
// 2. slugify / uniquePath produce safe filenames for any-language prompts.
// ---------------------------------------------------------------------------
test('slugify always yields a filesystem-safe [a-z0-9-] slug for any-language input', () => {
  const { slugify } = loadI18n();
  const inputs = [
    'Hello World', 'Café Münich', '你好世界', 'مرحبا', 'שלום', '😀🎉',
    '你好 Hello 世界', '  --Weird!!  Chars--  ', '日本語のプロンプト',
  ];
  for (const s of inputs) {
    const slug = slugify(s);
    assert.match(slug, /^[a-z0-9-]*$/, `slug not filesystem-safe for: ${s}`);
    assert.ok(!slug.startsWith('-') && !slug.endsWith('-'), `slug has stray dashes for: ${s}`);
  }
});

test('slugify keeps Latin words, collapses non-Latin runs, and falls back to empty for pure CJK/emoji', () => {
  const { slugify } = loadI18n();
  assert.equal(slugify('Hello World'), 'hello-world');
  // Mixed: the CJK runs collapse to dashes that are then trimmed away.
  assert.equal(slugify('你好 Hello 世界'), 'hello');
  // Pure non-Latin prompts produce an empty slug → the gen handler falls back
  // to the per-tab default name ('image' etc.). That is the safe, intended path.
  assert.equal(slugify('你好世界'), '');
  assert.equal(slugify('😀🎉'), '');
  assert.equal(slugify('مرحبا'), '');
});

test('uniquePath preserves CJK/Arabic/emoji stems verbatim and appends a collision suffix', () => {
  const { uniquePath } = loadI18n();
  // Windows-style dir (backslash separator).
  assert.match(uniquePath('C:\\out', '你好.jpg'), /^C:\\out\\你好_[0-9a-z]{4}\.jpg$/);
  // POSIX-style dir (forward slash separator).
  assert.match(uniquePath('/tmp/out', 'مرحبا.png'), /^\/tmp\/out\/مرحبا_[0-9a-z]{4}\.png$/);
  // Emoji stem survives intact (valid on NTFS and ext4).
  assert.match(uniquePath('/tmp/out', '😀🎉.mp3'), /^\/tmp\/out\/😀🎉_[0-9a-z]{4}\.mp3$/);
});

test('uniquePath strips trailing dir separators and keeps the extension after the suffix', () => {
  const { uniquePath } = loadI18n();
  assert.match(uniquePath('C:\\out\\', 'image.jpg'), /^C:\\out\\image_[0-9a-z]{4}\.jpg$/);
  assert.match(uniquePath('/tmp/out/', 'a.b.tar.gz'), /^\/tmp\/out\/a\.b\.tar_[0-9a-z]{4}\.gz$/);
  // No extension at all.
  assert.match(uniquePath('/tmp/out', 'README'), /^\/tmp\/out\/README_[0-9a-z]{4}$/);
});

test('uniquePath effectively never collides (random 4-char base36 suffix)', () => {
  const { uniquePath } = loadI18n();
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(uniquePath('C:\\out', '你好.jpg'));
  // Two same-second generations must not overwrite each other. Allow for the
  // astronomically unlikely chance of a couple of random collisions, but the
  // suffix must clearly vary across calls.
  assert.ok(seen.size >= 990, `expected ~1000 unique paths, got ${seen.size}`);
});

// ---------------------------------------------------------------------------
// 3. buildFinalPrompt + style-prefix concatenation preserve UTF-8 exactly.
// ---------------------------------------------------------------------------
test('buildFinalPrompt preserves CJK/emoji prompts byte-for-byte', () => {
  const { buildFinalPrompt } = loadI18n();
  assert.equal(buildFinalPrompt(field(''), field('你好世界')), '你好世界');
  assert.equal(buildFinalPrompt(field(''), field('😀🎉🚀')), '😀🎉🚀');
});

test('buildFinalPrompt concatenates extraPrefix + style + manual with ", " and trims the manual field', () => {
  const styles = [{ name: 'anime', value: '  anime style  ' }]; // value is trimmed by getStyleText
  const { buildFinalPrompt } = loadI18n(styles);
  assert.equal(
    buildFinalPrompt(field('anime'), field('  a red dragon  '), 'ZZPRE_'),
    'ZZPRE_, anime style, a red dragon'
  );
  // Empty parts are filtered out (no leading/trailing/double separators).
  assert.equal(buildFinalPrompt(field(''), field('  你好  '), ''), '你好');
  assert.equal(buildFinalPrompt(field('anime'), field(''), ''), 'anime style');
});

test('buildFinalPrompt keeps a Unicode style preset intact next to a Unicode prompt', () => {
  const styles = [{ name: 'shuimo', value: '水墨画风格' }]; // Chinese style preset
  const { buildFinalPrompt } = loadI18n(styles);
  assert.equal(
    buildFinalPrompt(field('shuimo'), field('一只在月光下奔跑的狼')),
    '水墨画风格, 一只在月光下奔跑的狼'
  );
});

// ---------------------------------------------------------------------------
// 4. RTL (Arabic / Hebrew) and mixed-direction prompts do not corrupt fields.
// ---------------------------------------------------------------------------
test('buildFinalPrompt preserves RTL prompts exactly (data order is unchanged by bidi)', () => {
  const { buildFinalPrompt } = loadI18n();
  // Arabic.
  assert.equal(buildFinalPrompt(field(''), field('مرحبا بالعالم')), 'مرحبا بالعالم');
  // Hebrew.
  assert.equal(buildFinalPrompt(field(''), field('שלום עולם')), 'שלום עולם');
});

test('buildFinalPrompt keeps adjacent fields intact around an RTL segment (mixed direction)', () => {
  const styles = [{ name: 'ar', value: 'أنمي' }]; // Arabic style value
  const { buildFinalPrompt } = loadI18n(styles);
  // LTR prefix, RTL style, CJK manual — the composed token must keep every
  // segment in the exact order it was assembled, regardless of rendering dir.
  const composed = buildFinalPrompt(field('ar'), field('你好'), 'PREFIX');
  assert.equal(composed, 'PREFIX, أنمي, 你好');
  // Each field is recoverable and uncorrupted.
  const parts = composed.split(', ');
  assert.deepEqual(parts, ['PREFIX', 'أنمي', '你好']);
});

test('getStyleText trims and preserves a Unicode style value', () => {
  const styles = [{ name: 'x', value: '  水墨画  ' }];
  const { getStyleText } = loadI18n(styles);
  assert.equal(getStyleText('x'), '水墨画');
  assert.equal(getStyleText('missing'), '');
});

// ---------------------------------------------------------------------------
// 5. The composed prompt is emitted as a single exact --prompt argv token.
// ---------------------------------------------------------------------------
// The tab handlers build their argv with `args.push('--prompt', promptText)`,
// where promptText is exactly buildFinalPrompt(...)'s return value. A single
// array element is a single argv token — no shell re-splitting, no escaping —
// so asserting the token equals the composed string proves the UTF-8 prompt
// reaches mmx intact. (The full process-spawn path is additionally asserted
// end-to-end against the harness's lastFullArgs capture in the i18n scenario.)
test('the --prompt argv token carries the exact composed UTF-8 string', () => {
  const styles = [{ name: 'anime', value: 'anime style' }];
  const { buildFinalPrompt } = loadI18n(styles);
  const promptText = buildFinalPrompt(field('anime'), field('一条中国龙 🐉'), '');
  const args = [];
  args.push('--prompt', promptText); // mirrors the tab handlers' argv assembly
  const i = args.indexOf('--prompt');
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], 'anime style, 一条中国龙 🐉');
  // The token is a single element — the emoji/CJK are not split across tokens.
  assert.equal(args.length, 2);
});
