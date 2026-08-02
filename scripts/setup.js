// scripts/setup.js
// One-shot "before first release" downloader. Run with:
//   npm run setup
//
// What it does:
//   1. Downloads the Real-ESRGAN binary + bundled models from the
//      v0.2.5.0 GitHub release and extracts them into ./bin/.
//   2. Downloads the isnet-general-use.onnx model from the
//      verified HuggingFace mirror into ./bin/models/.
//
// Background-removal uses the BUNDLED Node.js wrapper
// (onnxruntime-node + the IS-Net ONNX model) — no separate
// download or build step is required to use it out of the
// box. The C# isnetbg.exe is an optional fast-path for power
// users who want to swap it in; the script just notes whether
// one is present at ./bin/isnetbg.exe, it doesn't try to build it.
//
// The downloads go directly to the same paths the runtime
// wrappers probe for, so once the script finishes, the
// wrappers (`src/realesrgan.js` and `src/isnetbg.js`) will
// auto-detect everything on the very next launch and the
// "Optional add-ons" popup will silently skip itself.
//
// Idempotent: re-running overwrites the existing files with
// the latest verified versions. Atomic write (tmp + rename)
// so a kill mid-download doesn't leave a half-extracted binary.

const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const path = require('path');

// AUD-007/AUD-014 fix: Use shell-free extraction and bounded download client
// instead of PowerShell interpolation and raw https with no timeouts.
const { extractZip } = require('./lib/safeExtract');
const { downloadFile } = require('./lib/downloadClient');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const MODELS = path.join(BIN, 'models');

// Verified URLs. See README for the rationale + how to swap
// them when upstream releases change. The IS-Net model mirror
// is checked for being an actual ONNX file (not a .pth), the
// Real-ESRGAN URL points at the dated asset name that
// actually exists in v0.2.5.0.
const RE_ESRGAN_URL = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip';
const ISNET_MODEL_URL = 'https://huggingface.co/x-Liola-x/isnet-general-use-onnx/resolve/main/isnet-general-use.onnx';
// Editor Heal AI models — MI-GAN (MIT, ~28 MB) + LaMa (Apache-2.0, ~208 MB),
// both bundled so the editor's Resynthesize works out of the box. Verified
// URLs match src/inpaint/modelRegistry.js.
const MIGAN_MODEL_URL = 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx';
const LAMA_MODEL_URL = 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx';
const RE_ESRGAN_ZIP_SHA256 = 'abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d';
const ISNET_MODEL_SHA256 = '4c56bbc21588459dda11efba5a4a8ee163969da109ae170fb1988c1c2ea4a90a';
const MIGAN_MODEL_SHA256 = '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b';
const LAMA_MODEL_SHA256 = '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6';

function log(msg) {
  process.stdout.write(msg + '\n');
}
function warn(msg) {
  process.stdout.write('⚠  ' + msg + '\n');
}
function fail(msg) {
  process.stderr.write('✖  ' + msg + '\n');
  process.exit(1);
}

// AUD-014 fix: Bounded download with timeouts, redirect validation,
// streaming byte cap, and SHA-256 verification.
async function download(url, destPath, expectedSha256) {
  log('  → ' + url);
  const result = await downloadFile(url, destPath, {
    expectedSha256,
    maxBytes: 2 * 1024 * 1024 * 1024, // 2 GiB cap
    overallTimeoutMs: 600_000, // 10 minutes
    onProgress: ({ downloaded, total }) => {
      const pct = Math.floor((downloaded / total) * 100);
      process.stdout.write(`     ${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB (${pct}%)\r`);
    },
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  process.stdout.write('\n');
}

// AUD-007 fix: Shell-free extraction using 7zip-bin (no PowerShell).
// Archive entries are validated before extraction (no traversal, no device names).
async function extractZipSafe(zipPath, destDir) {
  const result = await extractZip(zipPath, destDir);
  if (!result.ok) {
    throw new Error(result.error);
  }
}

async function downloadRealEsrgan() {
  log('Real-ESRGAN binary (BSD-3-Clause)');
  // The release zip contains: realesrgan-ncnn-vulkan(.exe),
  // the models/ folder (realesrgan-x4plus.param, .bin, etc.),
  // and a few README files. We drop the whole archive into
  // ./bin/ so the models land at ./bin/models/realesrgan-*.{param,bin}
  // (exactly the layout the wrapper's `findBinary` + `findModelPath`
  // chain expects).
  const tmpZip = path.join(BIN, '.tmp-realesrgan.zip');
  try {
    await download(RE_ESRGAN_URL, tmpZip, RE_ESRGAN_ZIP_SHA256);
    log('  → extracting into ./bin/');
    await extractZipSafe(tmpZip, BIN);
  } finally {
    try { await fsp.unlink(tmpZip); } catch (_) {}
  }
}

async function downloadIsnetModel() {
  log('IS-Net ONNX model (~176 MB, Apache-2.0)');
  // The model is shipped at the same relative path the
  // isnetbg wrapper looks for: <bin>/models/isnet-general-use.onnx
  // (~170 MB binary blob, so we always stream — never load it
  // into a single buffer).
  await fsp.mkdir(MODELS, { recursive: true });
  const dest = path.join(MODELS, 'isnet-general-use.onnx');
  await download(ISNET_MODEL_URL, dest, ISNET_MODEL_SHA256);
}

// Editor Heal AI inpaint models. Both ship bundled so the editor's
// "Resynthesize" works out of the box; these land in bin/models/ alongside
// the IS-Net/BiRefNet models. Skip with --no-inpaint.
async function downloadInpaintModels() {
  await fsp.mkdir(MODELS, { recursive: true });
  log('MI-GAN inpaint model (~28 MB, MIT)');
  await download(MIGAN_MODEL_URL, path.join(MODELS, 'migan.onnx'), MIGAN_MODEL_SHA256);
  log('');
  log('LaMa inpaint model (~208 MB, Apache-2.0)');
  await download(LAMA_MODEL_URL, path.join(MODELS, 'lama-big.onnx'), LAMA_MODEL_SHA256);
}

async function checkIsnetBinary() {
  const exe = process.platform === 'win32' ? 'isnetbg.exe' : 'isnetbg';
  const dest = path.join(BIN, exe);
  try {
    await fsp.access(dest);
    log(`isnetbg binary: present at ./bin/${exe} (custom fast-path)`);
  } catch (_) {
    // The isnetbg C# binary is an optional fast-path for CPU-only boxes;
    // the bundled Node.js wrapper (see top-of-file) is the working
    // default, so its absence is not an error.
    log('isnetbg binary: optional — not present (not needed, the bundled Node.js wrapper works)');
  }
}

const { downloadModel } = require('../src/isnetbg/modelDownload');
const { verifyRuntimeAssets } = require('./lib/runtimeAssets');

(async () => {
  const argv = process.argv.slice(2);
  const dlLite = !argv.includes('--no-birefnet');
  const dlGeneral = !argv.includes('--no-birefnet');
  const dlPortrait = !argv.includes('--no-birefnet');
  const dlInpaint = !argv.includes('--no-inpaint');

  log('MiniMax Asset Tool — first-release setup');
  log('=========================================');
  log('');

  await fsp.mkdir(BIN, { recursive: true });
  await fsp.mkdir(MODELS, { recursive: true });

  await downloadRealEsrgan();
  log('');
  await downloadIsnetModel();
  log('');
  await checkIsnetBinary();

  if (dlLite) {
    log('');
    log('BiRefNet Lite model (~224 MB, MIT)');
    const r = await downloadModel('birefnet-general-lite', ({ downloaded, total }) => {
      process.stdout.write(`     ${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB\r`);
    });
    if (!r.ok) throw new Error(r.error);
    process.stdout.write('\n');
  }

  if (dlGeneral) {
    log('');
    log('BiRefNet General model (~930 MB, MIT)');
    const r = await downloadModel('birefnet-general', ({ downloaded, total }) => {
      process.stdout.write(`     ${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB\r`);
    });
    if (!r.ok) throw new Error(r.error);
    process.stdout.write('\n');
  }

  if (dlPortrait) {
    log('');
    log('BiRefNet Portrait model (~930 MB, MIT)');
    const r = await downloadModel('birefnet-portrait', ({ downloaded, total }) => {
      process.stdout.write(`     ${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB\r`);
    });
    if (!r.ok) throw new Error(r.error);
    process.stdout.write('\n');
  }

  if (dlInpaint) {
    log('');
    await downloadInpaintModels();
  }

  log('');
  log('Verifying the complete offline runtime by size and SHA-256...');
  const verification = verifyRuntimeAssets(BIN);
  if (!verification.ok) {
    throw new Error('Offline runtime verification failed:\n  ' + verification.issues.join('\n  '));
  }
  log(`  ${verification.count} files verified (${(verification.totalBytes / 1073741824).toFixed(2)} GiB)`);

  log('');
  log('Done. Verify with:');
  log('  npm run check');
})().catch((e) => {
  fail(String((e && e.message) || e));
});
