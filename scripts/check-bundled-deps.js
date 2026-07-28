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

const ROOT = path.resolve(__dirname, '..');

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
  const requiredBins = [
    // QA-030 fix: populate with known required binaries so the check
    // actually catches missing executables.
    'realesrgan-ncnn-vulkan.exe',
  ];

  if (!fs.existsSync(binDir)) {
    log('WARN: bin/ directory not found (optional for dev builds)');
    return true; // bin/ is optional in dev
  }

  const missing = [];
  for (const bin of requiredBins) {
    if (!fs.existsSync(path.join(binDir, bin))) {
      missing.push(bin);
    }
  }

  if (missing.length > 0) {
    log(`FAIL: ${missing.length} binaries missing from bin/:`);
    for (const m of missing) log(`  - ${m}`);
  } else {
    log('All required binaries present');
  }

  // QA-030 fix: missing required binaries is a failure, not a warning.
  return missing.length === 0;
}

function checkNativeModules() {
  const nativeModules = [
    { name: 'sharp', check: 'lib/index.js' },
    { name: 'ffmpeg-static', check: 'ffmpeg.exe' },
    { name: 'onnxruntime-node', check: 'bin/napi-v3/win32/x64/onnxruntime_binding.node' },
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

function checkAsarContents() {
  // If an asar exists, verify it contains the expected files.
  const asarPaths = [
    path.join(ROOT, 'dist-out', 'win-unpacked', 'resources', 'app.asar'),
  ];

  for (const asarPath of asarPaths) {
    if (!fs.existsSync(asarPath)) continue;

    log(`Checking asar: ${path.relative(ROOT, asarPath)}`);

    // Use @electron/asar to list contents.
    try {
      const asar = require('@electron/asar');
      const files = asar.listPackage(asarPath);

      const required = ['main.js', 'preload.js', 'package.json', 'main/index.js', 'renderer/index.html', 'IMAGE_STYLE_PRESETS_ENGLISH_v2.0.md'];
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

// Run all checks.
function main() {
  log('Starting dependency completeness check...\n');

  let allPassed = true;

  allPassed = checkDependencies() && allPassed;
  allPassed = checkBinaries() && allPassed;
  allPassed = checkNativeModules() && allPassed;
  allPassed = checkAsarContents() && allPassed;

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
