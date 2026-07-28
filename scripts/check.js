// Strict preflight for a full offline Windows release. Run with `npm run check`.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyRuntimeAssets } = require('./lib/runtimeAssets');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin');

const requiredPackages = [
  'ffmpeg-static',
  'mmx-cli',
  'onnxruntime-node',
  'sharp',
];

console.log('Full offline release preflight');
console.log('==============================');

let requiredMissing = 0;
for (const packageName of requiredPackages) {
  try {
    const packagePath = path.join(ROOT, 'node_modules', ...packageName.split('/'), 'package.json');
    if (!fs.statSync(packagePath).isFile()) throw new Error('not a file');
    console.log(`  OK       npm runtime: ${packageName}`);
  } catch (_) {
    console.log(`  MISSING  npm runtime: ${packageName}`);
    requiredMissing++;
  }
}

if (process.platform === 'win32') {
  const probes = [
    {
      label: 'Sharp and ONNX Runtime native bindings',
      run() {
        const sharp = require('sharp');
        const onnx = require('onnxruntime-node');
        return typeof sharp === 'function' && typeof onnx.InferenceSession === 'function';
      },
    },
    {
      label: 'bundled MiniMax CLI',
      run() {
        const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'mmx-cli', 'dist', 'mmx.mjs'), '--version'], { encoding: 'utf8', windowsHide: true });
        return result.status === 0 && /mmx\s+\d+\.\d+\.\d+/i.test(result.stdout || '');
      },
    },
    {
      label: 'bundled FFmpeg',
      run() {
        const ffmpeg = require('ffmpeg-static');
        const result = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
        return result.status === 0 && /ffmpeg version/i.test(result.stdout || '');
      },
    },
    {
      label: 'bundled Real-ESRGAN executable',
      run() {
        const executable = path.join(BIN, 'realesrgan-ncnn-vulkan.exe');
        const result = spawnSync(executable, ['-h'], { encoding: 'utf8', windowsHide: true });
        return /Usage:\s*realesrgan-ncnn-vulkan/i.test((result.stdout || '') + (result.stderr || ''));
      },
    },
  ];

  console.log('');
  console.log('Loading and starting the bundled native tools...');
  for (const probe of probes) {
    let ok = false;
    try { ok = probe.run(); } catch (_) {}
    console.log(`  ${ok ? 'OK     ' : 'FAILED '}  ${probe.label}`);
    if (!ok) requiredMissing++;
  }
}

let runtimeResult;
try {
  console.log('');
  console.log('Checking every bundled model and native runtime by size and SHA-256...');
  runtimeResult = verifyRuntimeAssets(BIN);
  if (runtimeResult.ok) {
    console.log(`  OK       ${runtimeResult.count} runtime assets (${(runtimeResult.totalBytes / 1073741824).toFixed(2)} GiB)`);
  } else {
    for (const issue of runtimeResult.issues) console.log(`  MISSING  ${issue}`);
    requiredMissing += runtimeResult.issues.length;
  }
} catch (error) {
  console.log(`  ERROR    ${error.message}`);
  requiredMissing++;
}

// A hard process kill can leave large temporary downloads behind. They are
// excluded from the curated release copy, but failing here keeps the local
// runtime trustworthy and prevents unnoticed multi-gigabyte leaks.
let leakedTemps = 0;
const leaks = [];
const walkBin = (directory) => {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkBin(filePath);
    } else if (/\.tmp-|\.partial$|\.download$/i.test(entry.name)) {
      let size = 0;
      try { size = fs.statSync(filePath).size; } catch (_) {}
      leaks.push({ filePath, size });
    }
  }
};
walkBin(BIN);
if (leaks.length) {
  console.log('');
  console.log(`  LEAK     ${leaks.length} orphaned download file(s)`);
  for (const leak of leaks) {
    console.log(`           ${path.relative(ROOT, leak.filePath)} (${(leak.size / 1048576).toFixed(1)} MB)`);
  }
  leakedTemps = leaks.length;
}

console.log('');
if (requiredMissing === 0 && leakedTemps === 0) {
  console.log('PASS: The source runtime is complete and verified for an offline release.');
  console.log('No model, Node.js, Python, .NET, FFmpeg, or Real-ESRGAN download is required after installation.');
  process.exit(0);
}

if (leakedTemps > 0) console.log(`${leakedTemps} orphaned temp file(s) must be moved out of bin/ before building.`);
if (requiredMissing > 0) console.log(`${requiredMissing} required runtime check(s) failed. Run: npm ci && npm run setup`);
process.exit(1);
