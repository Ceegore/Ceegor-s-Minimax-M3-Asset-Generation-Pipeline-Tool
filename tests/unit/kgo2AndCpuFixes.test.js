// tests/unit/kgo2AndCpuFixes.test.js
// Dedicated test suite verifying past fixes, premade style parsing, and CPU thread capping.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

test('CPU Guard: getSafeThreadCount reserves at least 2 CPU cores', () => {
  const { getSafeThreadCount, getSafeProcessEnv } = require(path.join(ROOT, 'src/cpuGuard'));
  const os = require('os');
  const cores = (typeof os.availableParallelism === 'function') ? os.availableParallelism() : ((os.cpus() || []).length || 4);
  const expected = Math.max(1, cores - 2);
  assert.equal(getSafeThreadCount(), expected, 'getSafeThreadCount must return max(1, cores - 2)');

  const env = getSafeProcessEnv();
  assert.equal(env.OMP_NUM_THREADS, String(expected), 'OMP_NUM_THREADS must equal safeThreads');
  assert.equal(env.OPENBLAS_NUM_THREADS, String(expected), 'OPENBLAS_NUM_THREADS must equal safeThreads');
});

test('Real-ESRGAN: defaults to safe thread count -j 1:safeThreads:2 and safe env', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src/realesrgan.js'), 'utf8');
  assert.ok(code.includes('cpuGuard'), 'realesrgan.js must require cpuGuard');
  assert.ok(code.includes('getSafeProcessEnv'), 'realesrgan.js must pass getSafeProcessEnv to spawn');
});

test('Sharp: formatUtils applies CPU thread cap on sharp load', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src/imageOptimizer/formatUtils.js'), 'utf8');
  assert.ok(code.includes('applySharpThreadCap'), 'formatUtils.js must invoke applySharpThreadCap(sharp)');
});

test('Audio Runner: runFFmpeg passes safe -threads argument', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src/audio/AudioRunner.js'), 'utf8');
  assert.ok(code.includes("'-threads'"), 'AudioRunner.js must pass -threads argument to FFmpeg');
});

test('Premade Style Presets: parseStylePresetsFromMarkdown parses IMAGE_STYLE_PRESETS_ENGLISH_v2.0.md', () => {
  const { parseStylePresetsFromMarkdown } = require(path.join(ROOT, 'main/ipc/registerConfigIpc'));
  const mdPath = path.join(ROOT, 'IMAGE_STYLE_PRESETS_ENGLISH_v2.0.md');
  const text = fs.readFileSync(mdPath, 'utf8');
  const presets = parseStylePresetsFromMarkdown(text);

  assert.ok(Array.isArray(presets), 'parseStylePresetsFromMarkdown must return an array');
  assert.equal(presets.length, 56, 'IMAGE_STYLE_PRESETS_ENGLISH_v2.0.md contains 28 pairs (56 presets total)');

  const firstLong = presets.find(p => p.name === 'Modern Comic Book - long');
  assert.ok(firstLong, 'Must extract "Modern Comic Book - long"');
  assert.ok(firstLong.value.includes('Modern American comic-book illustration'), 'Long prompt content must match file');

  const firstShort = presets.find(p => p.name === 'Modern Comic Book - short');
  assert.ok(firstShort, 'Must extract "Modern Comic Book - short"');
  assert.ok(firstShort.value.includes('Modern comic art'), 'Short prompt content must match file');
});

test('KGO2 Fixes Integrity: Dynamic natural dimensions, Buffer sharp, escape isolation', () => {
  const canvasCode = fs.readFileSync(path.join(ROOT, 'renderer/overlays/imageEditorCanvas.js'), 'utf8');
  assert.ok(canvasCode.includes('session.imgW || imgW'), 'fitToContainer must read session.imgW dynamically');

  const archiveCode = fs.readFileSync(path.join(ROOT, 'renderer/widgets/ArchiveViewer.js'), 'utf8');
  assert.ok(archiveCode.includes('e.stopPropagation()'), 'ArchiveViewer must call e.stopPropagation on Escape key');

  const shortcutsCode = fs.readFileSync(path.join(ROOT, 'renderer/services/shortcutRegistry.js'), 'utf8');
  assert.ok(shortcutsCode.includes("combo: 'Ctrl+S'"), 'shortcutRegistry must include Ctrl+S');
});
