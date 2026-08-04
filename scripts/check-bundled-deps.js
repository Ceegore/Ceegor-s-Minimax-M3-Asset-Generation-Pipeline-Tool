// scripts/check-bundled-deps.js
// ============================================================================
// Phase G — Dependency completeness check.
//
// Verifies that all runtime dependencies are present and correctly
// bundled for release builds:
//   - All `dependencies` from package.json are present in node_modules
//   - bin/ directory contains required executables
//   - Native modules have their platform-specific binaries
//
// This catches the "missing dependency in release build" regression
// that has caused multiple hotfixes.
//
// Usage:
//   node scripts/check-bundled-deps.js
//   npm run check:deps
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { verifyRuntimeAssets } = require('./lib/runtimeAssets');

const ROOT = path.resolve(__dirname, '..');
const releaseArg = process.argv.find((arg) => arg.startsWith('--release-dir='));
const RELEASE_DIR = releaseArg ? path.resolve(releaseArg.slice('--release-dir='.length)) : null;

function log(m) { process.stdout.write(`[check-bundled-deps] ${m}\n`); }

function checkDependencies() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {});
  const nmDir = path.join(ROOT, 'node_modules');
  const missing = [];

  log(`Checking ${deps.length} runtime dependencies...`);

  for (const dep of deps) {
    // Handle scoped packages (@scope/name).
    const depPath = path.join(nmDir, ...dep.split('/'));
    if (!fs.existsSync(depPath)) {
      missing.push(dep);
    }
  }

  if (missing.length > 0) {
    log(`FAIL: ${missing.length} dependencies missing from node_modules:`);
    for (const m of missing) log(`  - ${m}`);
    return false;
  }

  log(`All ${deps.length} dependencies present`);
  return true;
}

function checkBinaries() {
  const binDir = path.join(ROOT, 'bin');

  if (!fs.existsSync(binDir)) {
    log('WARN: bin/ directory not found; CI may omit the 2.5 GiB release payload');
    return true;
  }

  const result = verifyRuntimeAssets(binDir);
  if (!result.ok) {
    log(`FAIL: ${result.issues.length} offline runtime issue(s):`);
    for (const issue of result.issues) log(`  - ${issue}`);
    return false;
  }
  log(`All ${result.count} offline runtime assets match the release manifest`);
  return true;
}

function checkNativeModules() {
  const nativeModules = [
    { name: 'sharp', check: 'lib/index.js' },
    { name: 'ffmpeg-static', check: 'ffmpeg.exe' },
    { name: 'onnxruntime-node', check: 'bin/napi-v6/win32/x64/onnxruntime_binding.node' },
  ];

  const nmDir = path.join(ROOT, 'node_modules');
  const issues = [];

  log('Checking native module binaries...');

  for (const mod of nativeModules) {
    const modDir = path.join(nmDir, mod.name);
    if (!fs.existsSync(modDir)) {
      issues.push(`${mod.name}: package not installed`);
      continue;
    }

    // For sharp, check the @img scope for platform binaries.
    if (mod.name === 'sharp') {
      const imgDir = path.join(nmDir, '@img');
      if (!fs.existsSync(imgDir)) {
        issues.push('sharp: @img platform binaries not found');
      }
      continue;
    }

    const checkPath = path.join(modDir, mod.check);
    if (!fs.existsSync(checkPath)) {
      // Try alternative paths (different versions may have different layouts).
      const altExists = fs.existsSync(path.join(modDir, 'bin')) ||
                        fs.existsSync(path.join(modDir, 'dist'));
      if (!altExists) {
        issues.push(`${mod.name}: ${mod.check} not found`);
      }
    }
  }

  if (issues.length > 0) {
    log(`FAIL: ${issues.length} native module issues:`);
    for (const i of issues) log(`  - ${i}`);
  } else {
    log('All native module binaries present');
  }

  // QA-030 fix: native module issues are failures, not warnings.
  return issues.length === 0;
}

function checkAsarContents(releaseDir = path.join(ROOT, 'dist-out', 'win-unpacked')) {
  // If an asar exists, verify it contains the expected files.
  const asarPaths = [
    path.join(releaseDir, 'resources', 'app.asar'),
  ];

  for (const asarPath of asarPaths) {
    if (!fs.existsSync(asarPath)) continue;

    log(`Checking asar: ${path.relative(ROOT, asarPath)}`);

    // Use @electron/asar to list contents.
    try {
      const asar = require('@electron/asar');
      const files = asar.listPackage(asarPath);

      const required = [
        'main.js',
        'preload.js',
        'package.json',
        'main/index.js',
        'renderer/index.html',
        'IMAGE_STYLE_PRESETS_ENGLISH_v2.0.md',
        'node_modules/mmx-cli/dist/mmx.mjs',
        'node_modules/ffmpeg-static/index.js',
        'node_modules/onnxruntime-node/dist/index.js',
        'node_modules/sharp/dist/index.cjs',
      ];
      // asar.listPackage returns paths with leading / or \ depending on OS.
      const normalized = files.map(f => f.replace(/^[\/\\]/, '').replace(/\\/g, '/'));
      const missing = required.filter(f => !normalized.includes(f));

      if (missing.length > 0) {
        log(`  FAIL: Missing files in asar: ${missing.join(', ')}`);
        return false;
      }

      log(`  OK: ${files.length} files in asar, all required files present`);
    } catch (e) {
      // QA-030 fix: inability to inspect an existing asar is a failure.
      log(`  FAIL: Could not inspect asar: ${e.message}`);
      return false;
    }
  }

  return true;
}

function findFile(directory, fileName) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return false; }
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isFile() && (fileName instanceof RegExp ? fileName.test(entry.name) : entry.name.toLowerCase() === fileName.toLowerCase())) return true;
    if (entry.isDirectory() && findFile(filePath, fileName)) return true;
  }
  return false;
}

function checkReleaseDirectory(releaseDir) {
  if (!releaseDir) return true;
  log(`Checking exact release directory: ${releaseDir}`);
  const required = [
    'MiniMaxAssetTool.exe',
    'START HERE.txt',
    'Install MiniMax Asset Tool.cmd',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'OFFLINE_RUNTIME_MANIFEST.json',
    path.join('resources', 'app.asar'),
  ];
  const issues = required.filter((item) => !fs.existsSync(path.join(releaseDir, item)))
    .map((item) => `${item}: missing`);

  // A-004/§15.1: the composed legacy candidate reuses the 1.0.0 shell, which
  // predates ffprobe.exe; compose enforces exact lock equality, so the
  // exemption is only honored in explicit legacy release mode and stays
  // fail-closed for every normal release.
  const legacySkip = process.env.MINIMAX_RELEASE_MODE === 'legacy' ? ['ffprobe.exe'] : [];
  const runtime = verifyRuntimeAssets(path.join(releaseDir, 'resources', 'bin'), { skipPaths: legacySkip });
  issues.push(...runtime.issues.map((issue) => `resources/bin/${issue}`));

  const unpacked = path.join(releaseDir, 'resources', 'app.asar.unpacked');
  const nativeFiles = [
    ['ffmpeg.exe', 'ffmpeg.exe'],
    ['onnxruntime_binding.node', 'onnxruntime_binding.node'],
    ['onnxruntime.dll', 'onnxruntime.dll'],
    ['Sharp native binding', /^sharp-win32-x64(?:-[0-9.]+)?\.node$/i],
    ['libvips-42.dll', 'libvips-42.dll'],
  ];
  for (const [label, match] of nativeFiles) {
    if (!findFile(unpacked, match)) issues.push(`resources/app.asar.unpacked: ${label} missing`);
  }

  const foreignOnnx = path.join(unpacked, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  for (const foreignPath of ['darwin', 'linux', path.join('win32', 'arm64')]) {
    if (fs.existsSync(path.join(foreignOnnx, foreignPath))) issues.push(`unused ONNX runtime shipped: ${foreignPath}`);
  }

  if (issues.length) {
    log(`FAIL: ${issues.length} exact-release issue(s):`);
    for (const issue of issues) log(`  - ${issue}`);
    return false;
  }
  log(`Exact release contains all ${runtime.count} offline assets and required native modules`);
  return true;
}

// Run all checks.
function main() {
  log('Starting dependency completeness check...\n');

  let allPassed = true;

  allPassed = checkDependencies() && allPassed;
  allPassed = checkBinaries() && allPassed;
  allPassed = checkNativeModules() && allPassed;
  allPassed = checkAsarContents(RELEASE_DIR || undefined) && allPassed;
  allPassed = checkReleaseDirectory(RELEASE_DIR) && allPassed;

  log('');
  if (allPassed) {
    log('PASS: All dependency checks passed');
    process.exit(0);
  } else {
    log('FAIL: Some dependency checks failed');
    process.exit(1);
  }
}

main();
