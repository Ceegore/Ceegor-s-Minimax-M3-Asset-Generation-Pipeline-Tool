// scripts/sign-output-binaries.js
// ============================================================================
// RR2-H007 (release requalification 1.0.4 recheck-2): the Authenticode
// gate must cover EVERY PE that ships — including output-ROOT binaries
// like the pinned minisign.exe verifier that finalize-release-inventory
// copies beside the archives. electron-builder only signs the PEs IT
// emits (win-unpacked), so the copied verifier used to ship unsigned.
//
// This script Authenticode-signs every .exe/.dll/.node directly inside
// dist-out/ (skipping subdirectories — win-unpacked is already signed by
// the builder) using signtool + a certificate thumbprint, and FAILS
// CLOSED when any signature does not validate afterwards.
//
// It MUST run BEFORE finalize:release rewrites the outer manifest, so the
// signed hash of minisign.exe covers the signed bytes.
//
// Usage:
//   node scripts/sign-output-binaries.js
// Env:
//   MINIMAX_AUTH_THUMBPRINT  certificate thumbprint already imported into
//                            the runner's personal store (required)
//   MINIMAX_AUTH_TIMESTAMP   RFC-3161 timestamp URL (default: Sectigo)
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { releasePaths } = require('./releaseArtifacts');

const ROOT = path.resolve(__dirname, '..');

function log(m) { process.stdout.write(`[sign-out] ${m}\n`); }
function fail(m) { process.stderr.write(`ERROR: ${m}\n`); process.exit(1); }

function findSigntool() {
  const probe = spawnSync('signtool.exe', ['/help'], { encoding: 'utf8', windowsHide: true });
  if (!probe.error) return 'signtool.exe';
  // Common Windows SDK locations.
  const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  try {
    const versions = fs.readdirSync(sdkRoot).filter((d) => /^\d/.test(d)).sort().reverse();
    for (const v of versions) {
      const c = path.join(sdkRoot, v, 'x64', 'signtool.exe');
      if (fs.existsSync(c)) return c;
    }
  } catch (_) { /* SDK not present */ }
  return null;
}

function statusFor(filePath) {
  const quoted = String(filePath).replace(/'/g, "''");
  const command = `(Get-AuthenticodeSignature -LiteralPath '${quoted}').Status`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').trim();
}

function main() {
  if (process.platform !== 'win32') fail('Authenticode signing is only supported on Windows.');
  const thumbprint = process.env.MINIMAX_AUTH_THUMBPRINT;
  if (!thumbprint) fail('MINIMAX_AUTH_THUMBPRINT is not set — cannot sign output-root binaries.');
  const signtool = findSigntool();
  if (!signtool) fail('signtool.exe not found (install the Windows 10/11 SDK or VS Build Tools).');
  const timestamp = process.env.MINIMAX_AUTH_TIMESTAMP || 'http://timestamp.sectigo.com';

  const output = releasePaths(ROOT).output;
  let entries;
  try {
    entries = fs.readdirSync(output, { withFileTypes: true });
  } catch (e) {
    fail(`cannot read the release output directory ${output}: ${e.message}`);
  }
  const targets = entries
    .filter((e) => e.isFile() && /\.(exe|dll|node)$/i.test(e.name))
    .map((e) => path.join(output, e.name));
  if (targets.length === 0) {
    log('no output-root binaries to sign.');
    return;
  }
  for (const bin of targets) {
    // Idempotence: already-validly-signed binaries are left untouched so a
    // re-run can never alter bytes that a signed manifest already covers.
    if (statusFor(bin) === 'Valid') {
      log(`already signed: ${path.basename(bin)} — skipped`);
      continue;
    }
    const r = spawnSync(signtool, [
      'sign', '/fd', 'sha256', '/tr', timestamp, '/td', 'sha256',
      '/sha1', thumbprint, bin,
    ], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) {
      fail(`signtool failed (exit ${r.status}) for ${path.basename(bin)}: ${(r.stderr || r.stdout || '').trim()}`);
    }
    const status = statusFor(bin);
    if (status !== 'Valid') {
      fail(`signed ${path.basename(bin)} but the signature does not validate (status: ${status}).`);
    }
    log(`signed: ${path.basename(bin)}`);
  }
}

main();
