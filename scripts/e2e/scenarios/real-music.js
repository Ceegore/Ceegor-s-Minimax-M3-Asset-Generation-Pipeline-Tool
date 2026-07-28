// scripts/e2e/scenarios/real-music.js
// ============================================================================
// Phase 4 — Tier 3 real music generation (needsRealApi). Music is the slowest
// generator (30s–2min), so it gets a generous timeout. Asserts: new non-zero
// audio file on disk + log-result-ok row + toast + no uncaught errors.
// ============================================================================

const { genAndVerify } = require('../realUtils');

module.exports = {
  name: 'real-music',
  needsRealApi: true,
  order: 82,
  async run(ctx) {
    await genAndVerify(ctx, {
      tab: 'music',
      label: 'real-music/single',
      prompt: 'A short, calm lo-fi ambient loop, ten seconds, minimal',
      timeoutMs: 240000,
      extRe: /\.(mp3|wav|flac|aac|m4a)$/,
    });
  },
};
