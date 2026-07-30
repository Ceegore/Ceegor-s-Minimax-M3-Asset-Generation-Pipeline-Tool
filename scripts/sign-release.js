// scripts/sign-release.js
// H-013 (360° Audit): Detached Minisign signature for the release manifest.
//
// Usage:
//   node scripts/sign-release.js              Sign with MINISIGN_KEY_PATH env
//   node scripts/sign-release.js --verify     Verify an existing signature
//
// Prerequisites:
//   - minisign binary on PATH (https://jedisct1.github.io/minisign/)
//   - MINISIGN_KEY_PATH env var pointing to the secret key file
//   - For --verify: MINISIGN_PUB_KEY env var or default ./minisign.pub
//
// The signature is written alongside the .sha256 manifest:
//   dist-out/MiniMaxAssetTool-<version>-x64.sha256.minisig
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { releasePaths } = require('./releaseArtifacts');

const ROOT = path.resolve(__dirname, '..');

function log(m) { process.stdout.write(m + '\n'); }
function fail(m) { process.stderr.write('ERROR: ' + m + '\n'); process.exit(1); }

function findMinisign() {
  const r = spawnSync('minisign', ['-V'], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0) return 'minisign';
  // Windows: check common install locations
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'minisign', 'minisign.exe'),
    'C:\\Program Files\\minisign\\minisign.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function main() {
  const verify = process.argv.includes('--verify');
  const paths = releasePaths(ROOT);
  const manifest = paths.manifest;

  if (!fs.existsSync(manifest)) {
    fail(`Release manifest not found: ${manifest}\nRun "npm run build" first.`);
  }

  const bin = findMinisign();
  if (!bin) {
    fail('minisign binary not found. Install from https://jedisct1.github.io/minisign/');
  }

  const sigPath = manifest + '.minisig';

  if (verify) {
    // --- Verify mode ---
    const pubKey = process.env.MINISIGN_PUB_KEY || path.join(ROOT, 'minisign.pub');
    if (!fs.existsSync(pubKey)) fail(`Public key not found: ${pubKey}`);
    if (!fs.existsSync(sigPath)) fail(`Signature not found: ${sigPath}`);
    const r = spawnSync(bin, ['-V', '-p', pubKey, '-m', manifest, '-x', sigPath], {
      encoding: 'utf8', windowsHide: true,
    });
    if (r.status !== 0) {
      fail(`Signature verification FAILED:\n${r.stderr || r.stdout}`);
    }
    log('Signature verified OK: ' + sigPath);
    return;
  }

  // --- Sign mode ---
  const keyPath = process.env.MINISIGN_KEY_PATH;
  if (!keyPath) fail('Set MINISIGN_KEY_PATH to the minisign secret key file.');
  if (!fs.existsSync(keyPath)) fail(`Secret key not found: ${keyPath}`);

  const comment = `MiniMaxAssetTool-${paths.version} release manifest`;
  const r = spawnSync(bin, [
    '-S', '-s', keyPath, '-m', manifest, '-x', sigPath,
    '-t', comment, '-f',
  ], { encoding: 'utf8', windowsHide: true });

  if (r.status !== 0) {
    fail(`Signing failed:\n${r.stderr || r.stdout}`);
  }
  log('Signed: ' + sigPath);
  log('Distribute this file alongside the .sha256 manifest.');
}

main();
