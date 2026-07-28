// scripts/e2e/scenarios/real-speech.js
// ============================================================================
// Phase 4 — Tier 3 real speech synthesis (needsRealApi). Two generations:
//   1. default mp3 output;
//   2. --format wav, proving the format enum flows through to a real .wav.
// Each asserts: new non-zero file on disk + log-result-ok row + toast + no
// uncaught errors.
// ============================================================================

const { genAndVerify, setNumberParam } = require('../realUtils');

module.exports = {
  name: 'real-speech',
  needsRealApi: true,
  order: 81,
  async run(ctx) {
    // 1. default (mp3)
    await genAndVerify(ctx, {
      tab: 'speech',
      label: 'real-speech/mp3',
      prompt: 'Hello. This is an end to end smoke test of the speech pipeline.',
      timeoutMs: 90000,
      extRe: /\.mp3$/,
    });

    // 2. wav via the --format enum
    await genAndVerify(ctx, {
      tab: 'speech',
      label: 'real-speech/wav',
      prompt: 'Hello again. This one tests the wave format path.',
      timeoutMs: 90000,
      extRe: /\.wav$/,
      paramSetters: [
        async (c) => {
          const ok = await setNumberParam(c, 'speech', /--format\b/, 'wav');
          c.check(ok, 'real-speech/wav: could not set the --format parameter to wav');
        },
      ],
    });
  },
};
