// Preflight check for the bundled runtime. Run with `npm run check`.
// It verifies the dependencies required by the default out-of-box path.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const MODELS = path.join(BIN, 'models');

const checks = [
  {
    label: 'Real-ESRGAN binary (optional acceleration)',
    path: path.join(BIN, process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan'),
    optional: true,
  },
  {
    label: 'Real-ESRGAN model: realesrgan-x4plus.param (optional acceleration)',
    path: path.join(MODELS, 'realesrgan-x4plus.param'),
    optional: true,
  },
  {
    label: 'Real-ESRGAN model: realesrgan-x4plus.bin (optional acceleration)',
    path: path.join(MODELS, 'realesrgan-x4plus.bin'),
    optional: true,
  },
  {
    label: 'IS-Net ONNX model: isnet-general-use.onnx',
    path: path.join(MODELS, 'isnet-general-use.onnx'),
    requiredMinBytes: 100 * 1024 * 1024,
  },
  {
    label: 'npm dep: onnxruntime-node',
    resolve: () => require.resolve('onnxruntime-node', { paths: [ROOT] }),
  },
  {
    label: 'npm dep: sharp',
    resolve: () => require.resolve('sharp', { paths: [ROOT] }),
  },
];

function inspect(check) {
  try {
    const filePath = check.resolve ? check.resolve() : check.path;
    const stat = fs.statSync(filePath);
    if (check.requiredMinBytes && stat.size < check.requiredMinBytes) {
      return { ok: false, detail: `too small (${(stat.size / 1024 / 1024).toFixed(1)} MB)` };
    }
    return { ok: true, detail: check.resolve ? 'present' : `present (${(stat.size / 1024 / 1024).toFixed(1)} MB)` };
  } catch (_) {
    return { ok: false, detail: check.optional ? 'missing (optional)' : 'MISSING' };
  }
}

let requiredMissing = 0;
let optionalMissing = 0;
let leakedTemps = 0;
console.log('Pre-release preflight check');
console.log('===========================');
for (const check of checks) {
  const result = inspect(check);
  console.log(`  ${result.ok ? 'OK' : (check.optional ? 'OPTIONAL' : 'MISSING')}  ${check.label}`);
  console.log(`       ${result.detail}`);
  if (!result.ok) {
    if (check.optional) optionalMissing++;
    else requiredMissing++;
  }
}

// KGO7-017: orphaned download temps under bin/ are wasted disk AND would
// be swept into a release archive. One measured leak was 161 MB and every
// gate stayed green with it present.
{
  const binDir = path.join(__dirname, '..', 'bin');
  const leaks = [];
  const walkBin = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walkBin(p); continue; }
      if (/\.tmp-|\.partial$|\.download$/i.test(e.name)) {
        let size = 0;
        try { size = fs.statSync(p).size; } catch (_) {}
        leaks.push({ p, size });
      }
    }
  };
  walkBin(binDir);
  if (leaks.length) {
    const totalMB = leaks.reduce((a, l) => a + l.size, 0) / 1048576;
    console.log('');
    console.log(`  LEAK  ${leaks.length} orphaned temp file(s) under bin/ (${totalMB.toFixed(1)} MB)`);
    for (const l of leaks) {
      console.log(`       ${path.relative(path.join(__dirname, '..'), l.p)}  (${(l.size / 1048576).toFixed(1)} MB)`);
    }
    console.log('       These are aborted model downloads. Delete them before building.');
    leakedTemps = leaks.length;
  }
}

console.log('');
if (leakedTemps > 0) {
  console.log(`${leakedTemps} orphaned temp file(s) under bin/ must be deleted before building.`);
  process.exit(1);
}
if (requiredMissing === 0) {
  console.log(`All required bundled runtime files are in place. (${optionalMissing} optional Real-ESRGAN item(s) missing.)`);
  console.log('The default background-removal path is the bundled Node.js/ONNX backend; no C# or .NET runtime is required.');
  console.log('You can now run: npm run build');
  process.exit(0);
}

console.log(`${requiredMissing} required runtime item(s) are missing.`);
console.log('To fix, run: npm run setup');
process.exit(1);
