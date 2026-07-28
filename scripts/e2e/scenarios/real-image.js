// scripts/e2e/scenarios/real-image.js
// ============================================================================
// Phase 4 — Tier 3 real image generation (needsRealApi, runs only with --real
// and a MINIMAX_API_KEY; skips cleanly otherwise).
//
// Proves the genuine image path end-to-end: renderer -> real mmx IPC ->
// mmx-cli -> API -> a real file on disk. Two generations:
//   1. a single default image;
//   2. a --n 2 run (multi-image) to exercise the per-variant loop.
// Each asserts the plan's success contract: a new non-zero file under the
// isolated output tree + a log-result-ok "Generated" row + a success toast +
// no uncaught renderer errors. (Style-prefix concatenation and the upscale
// chain are covered by the unit + fake tiers to keep nightly quota spend low.)
// ============================================================================

const { genAndVerify, setNumberParam } = require('../realUtils');

module.exports = {
  name: 'real-image',
  needsRealApi: true,
  order: 80,
  async run(ctx) {
    // 1. single image
    await genAndVerify(ctx, {
      tab: 'image',
      label: 'real-image/single',
      prompt: 'A tiny red square on a white background, minimalist',
      timeoutMs: 120000,
      extRe: /\.(jpe?g|png|webp)$/,
    });

    // 2. --n 2 (multi-image run)
    await genAndVerify(ctx, {
      tab: 'image',
      label: 'real-image/n2',
      prompt: 'A tiny blue circle on a white background, minimalist',
      timeoutMs: 180000,
      extRe: /\.(jpe?g|png|webp)$/,
      paramSetters: [
        async (c) => {
          const ok = await setNumberParam(c, 'image', /--n\b/, '2');
          c.check(ok, 'real-image/n2: could not set the --n parameter to 2');
        },
      ],
    });
  },
};
