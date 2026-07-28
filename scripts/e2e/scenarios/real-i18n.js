// scripts/e2e/scenarios/real-i18n.js
// ============================================================================
// Phase 4 — Tier 3 real multilingual generation (needsRealApi). Proves the full
// UTF-8 path through the renderer -> mmx-cli -> the live API on Windows:
//   1. a Chinese image prompt;
//   2. a Chinese speech prompt.
// Cost is ~0 (one cheap image + one short TTS) but it catches any UTF-8
// mangling that only surfaces against the genuine API/CLI (argv encoding,
// code-page issues, etc.) which the fake tier cannot.
// ============================================================================

const { genAndVerify } = require('../realUtils');

module.exports = {
  name: 'real-i18n',
  needsRealApi: true,
  order: 83,
  async run(ctx) {
    // 1. Chinese image prompt
    await genAndVerify(ctx, {
      tab: 'image',
      label: 'real-i18n/image-zh',
      prompt: '一只穿着宇航服的猫在月球上，极简风格',
      timeoutMs: 120000,
      extRe: /\.(jpe?g|png|webp)$/,
    });

    // 2. Chinese speech prompt
    await genAndVerify(ctx, {
      tab: 'speech',
      label: 'real-i18n/speech-zh',
      prompt: '你好，这是一段端到端的中文语音合成测试。',
      timeoutMs: 90000,
      extRe: /\.(mp3|wav)$/,
    });
  },
};
