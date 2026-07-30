// scripts/set-fuses.js
// M-033 (360° Audit): Electron fuse configuration for release builds.
//
// Usage: node scripts/set-fuses.js [path-to-electron-binary]
// Default target: dist-out/win-unpacked/MiniMaxAssetTool.exe
//
// Fuses set:
//   RunAsNode                     = OFF  (prevents using exe as plain Node)
//   EnableNodeOptionsEnvironmentVariable = OFF
//   EnableNodeCliInspectArguments = OFF
//   OnlyLoadAppFromAsar           = ON   (only load from app.asar)
//   EnableEmbeddedAsarIntegrityValidation = ON (macOS only, no-op on Win)
//
// Requires: npm install --save-dev @electron/fuses
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TARGET = path.join(ROOT, 'dist-out', 'win-unpacked', 'MiniMaxAssetTool.exe');

function log(m) { process.stdout.write(m + '\n'); }
function fail(m) { process.stderr.write('ERROR: ' + m + '\n'); process.exit(1); }

async function main() {
  const target = process.argv[2] || DEFAULT_TARGET;
  if (!fs.existsSync(target)) {
    fail(`Target binary not found: ${target}\nRun "npm run build" first or pass the path as an argument.`);
  }

  let fuses;
  try {
    fuses = require('@electron/fuses');
  } catch (_) {
    fail('@electron/fuses is not installed. Run: npm install --save-dev @electron/fuses');
  }

  const { flipFuses, FuseVersion, FuseV1Options } = fuses;

  log(`Setting fuses on: ${target}`);
  await flipFuses(target, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  log('Fuses set successfully.');
  log('  RunAsNode: OFF');
  log('  EnableCookieEncryption: ON');
  log('  EnableNodeOptionsEnvironmentVariable: OFF');
  log('  EnableNodeCliInspectArguments: OFF');
  log('  OnlyLoadAppFromAsar: ON');
}

main().catch((e) => fail(e.message || e));
