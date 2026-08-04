'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyRuntimeAssets } = require('./lib/runtimeAssets');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function copyRequiredRuntime(root, unpacked) {
  const sourceBin = path.join(root, 'bin');
  const sourceRuntime = verifyRuntimeAssets(sourceBin);
  if (!sourceRuntime.ok) {
    throw new Error(`offline runtime is incomplete or changed:\n  ${sourceRuntime.issues.join('\n  ')}`);
  }
  const destBin = path.join(unpacked, 'resources', 'bin');
  const shipEntries = [
    'models',
    'realesrgan-ncnn-vulkan.exe',
    'realesrgan-ncnn-vulkan',
    'vcomp140.dll',
    'vcomp140d.dll',
  ];
  fs.rmSync(destBin, { recursive: true, force: true });
  fs.mkdirSync(destBin, { recursive: true });
  for (const entry of shipEntries) {
    const source = path.join(sourceBin, entry);
    if (!fs.existsSync(source)) continue;
    const target = path.join(destBin, entry);
    if (fs.statSync(source).isDirectory()) fs.cpSync(source, target, { recursive: true, dereference: false });
    else fs.copyFileSync(source, target);
  }
  const packagedRuntime = verifyRuntimeAssets(destBin);
  if (!packagedRuntime.ok) {
    throw new Error(`packaged offline runtime is incomplete or changed:\n  ${packagedRuntime.issues.join('\n  ')}`);
  }
  return packagedRuntime;
}

function copyEndUserFiles(root, unpacked) {
  for (const name of ['START HERE.txt', 'Install MiniMax Asset Tool.cmd', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const source = path.join(root, name);
    if (!fs.existsSync(source)) throw new Error(`required end-user file is missing: ${name}`);
    fs.copyFileSync(source, path.join(unpacked, name));
  }
  fs.copyFileSync(
    path.join(root, 'scripts', 'runtime-assets.json'),
    path.join(unpacked, 'OFFLINE_RUNTIME_MANIFEST.json'),
  );
}

function buildUnpacked({ root, output }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  if (!fs.existsSync(bin)) throw new Error(`electron-builder not found: ${bin}`);

  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  const args = ['--win', 'dir', '--x64', `--config.directories.output=${output}`, '--config.asar=true'];
  const command = process.platform === 'win32' ? 'cmd.exe' : bin;
  const commandArgs = process.platform === 'win32' ? ['/d', '/c', bin, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
  if (result.status !== 0) throw new Error(`electron-builder failed with exit code ${result.status}`);

  const unpacked = path.join(output, 'win-unpacked');
  const exe = path.join(unpacked, `${pkg.build?.productName || 'MiniMaxAssetTool'}.exe`);
  const asar = path.join(unpacked, 'resources', 'app.asar');
  if (!fs.existsSync(exe)) throw new Error(`missing executable: ${exe}`);
  if (!fs.existsSync(asar)) throw new Error(`missing app.asar: ${asar}`);
  for (const forbidden of ['main.js', 'preload.js', 'main', 'src', 'renderer']) {
    if (fs.existsSync(path.join(unpacked, forbidden))) {
      throw new Error(`loose application source found outside app.asar: ${forbidden}`);
    }
  }

  const runtime = copyRequiredRuntime(root, unpacked);
  copyEndUserFiles(root, unpacked);
  return { unpacked, exe, asar, runtimeFiles: runtime.count, runtimeBytes: runtime.totalBytes };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || path.join(__dirname, '..'));
  const output = path.resolve(args.out || path.join(root, 'dist-work', 'unsigned'));
  process.stdout.write(`${JSON.stringify(buildUnpacked({ root, output }), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exit(1); }
}

module.exports = { buildUnpacked, copyEndUserFiles, copyRequiredRuntime, parseArgs };
