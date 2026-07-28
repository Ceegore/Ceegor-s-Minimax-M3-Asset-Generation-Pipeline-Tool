// scripts/e2e/videoFake.js
// ============================================================================
// The ONE fake in the real-generation (Tier 3) tier, justified by the hard
// API limit of 3 video generations/day. It intercepts only
// `args[0] === 'video'` mmx calls, writes a tiny valid .mp4 stub to the
// requested output path, and returns an ok envelope — so the entire video
// UI/wiring/log/file-browser path is exercised on every real run without
// spending quota. A single real video generation (the canary, gated by
// RUN_VIDEO_CANARY=1) still runs nightly to prove the genuine path.
//
// Mehrwert: video UI stays covered at zero quota; the 3/day budget is
// reserved for the one daily canary instead of being burned by every run.
// ============================================================================

const fs = require('fs');
const path = require('path');

// Video is faked unless explicitly disabled. In the real-run harness this is
// on by default; the canary path in run.js bypasses it via RUN_VIDEO_CANARY.
function videoFakeEnabled() {
  return process.env.E2E_VIDEO_FAKE !== '0';
}

// Resolve the output path from an mmx argv (same conventions as the harness
// fake: --out / --download / -o, or any token under the output root).
function findOutPath(args, OUT) {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--out' || args[i] === '--download' || args[i] === '-o') return args[i + 1];
  }
  for (const a of args) if (typeof a === 'string' && OUT && a.toLowerCase().startsWith(OUT.toLowerCase())) return a;
  return null;
}

// Build a minimal-but-valid MP4: an `ftyp` box so file-type sniffers and the
// file browser recognise it as a real .mp4 (not just arbitrary bytes).
function minimalMp4() {
  const brands = Buffer.from('isomiso2mp41', 'ascii'); // compatible_brands
  const size = 8 + 4 + 4 + brands.length;              // header + major + minor + brands
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0);          // box size
  buf.write('ftyp', 4, 'ascii');       // box type
  buf.write('isom', 8, 'ascii');       // major_brand
  buf.writeUInt32BE(512, 12);          // minor_version
  brands.copy(buf, 16);                // compatible_brands
  return buf;
}

async function runVideoFake(args, OUT) {
  args = Array.isArray(args) ? args : [];
  const outFile = findOutPath(args, OUT);
  if (outFile) {
    try {
      fs.writeFileSync(outFile, minimalMp4());
    } catch (e) {
      return { ok: false, code: 1, stdout: '', stderr: 'ENOENT (video-fake): ' + e.message, parsed: null, command: 'mmx', argv: args };
    }
  }
  return { ok: true, code: 0, stdout: 'video-fake ok', stderr: '', parsed: { videoFake: true }, command: 'mmx', argv: args };
}

module.exports = { videoFakeEnabled, runVideoFake, findOutPath, minimalMp4 };
