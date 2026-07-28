// scripts/e2e/scenarios/video-canary.js
// ============================================================================
// Phase 4 — the ONE real video generation (needsRealApi + canary-gated).
//
// Video is faked everywhere else (scripts/e2e/videoFake.js) because of the hard
// 3/day quota. This canary is the single daily real run that proves the genuine
// video path still works: renderer -> real mmx IPC -> mmx-cli -> API -> a real
// .mp4 on disk. It is double-gated so it can NEVER burn quota accidentally:
//   • needsRealApi  -> skipped in the fake tier;
//   • skipWhen      -> skipped unless RUN_VIDEO_CANARY=1 (set only by the
//                      nightly e2e-real.yml workflow);
//   • run.js        -> video is only de-faked when RUN_VIDEO_CANARY=1 as well.
// Video generation takes 1–3 minutes, hence the long timeout.
// ============================================================================

const { genAndVerify } = require('../realUtils');

module.exports = {
  name: 'video-canary',
  needsRealApi: true,
  order: 85,
  // Only run when the nightly explicitly opts in — otherwise video stays faked
  // and a "real" canary would silently test the fake instead of the API.
  skipWhen: () => (process.env.RUN_VIDEO_CANARY === '1'
    ? null
    : 'RUN_VIDEO_CANARY not set (video stays faked; a canary must be a real generation)'),
  async run(ctx) {
    await genAndVerify(ctx, {
      tab: 'video',
      label: 'video-canary/real',
      prompt: 'A single red dot slowly moving across a white background',
      timeoutMs: 420000,
      extRe: /\.mp4$/,
    });
  },
};
