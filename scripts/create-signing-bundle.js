'use strict';

// Create the SignPath signing input bundle: exactly MiniMaxAssetTool.exe,
// validated against PE metadata (ProductName / ProductVersion /
// OriginalFilename) before upload. Writes SIGNING_INPUT.json evidence next to
// the bundle. Phase 2 tooling; unused by the v1.0.7 legacy flow.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  let count;
  try { while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function getPeMetadata(filePath) {
  if (process.platform !== 'win32') throw new Error('PE metadata validation requires Windows');
  const escaped = filePath.replace(/'/g, "''");
  const script = `$v=(Get-Item -LiteralPath '${escaped}').VersionInfo; [pscustomobject]@{ProductName=$v.ProductName;ProductVersion=$v.ProductVersion;FileVersion=$v.FileVersion;OriginalFilename=$v.OriginalFilename;FileDescription=$v.FileDescription}|ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`could not read PE metadata: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

function createSigningBundle({ unpacked, output, version, metadataProvider = getPeMetadata }) {
  const unpackedRoot = path.resolve(unpacked);
  const outputRoot = path.resolve(output);
  const sourceExe = path.join(unpackedRoot, 'MiniMaxAssetTool.exe');
  if (!fs.existsSync(sourceExe)) throw new Error(`missing ${sourceExe}`);
  const metadata = metadataProvider(sourceExe);
  if (metadata.ProductName !== 'MiniMaxAssetTool') throw new Error(`unexpected ProductName: ${metadata.ProductName}`);
  if (!String(metadata.ProductVersion || '').startsWith(String(version))) throw new Error(`ProductVersion ${metadata.ProductVersion} does not match requested ${version}`);
  if (metadata.OriginalFilename && metadata.OriginalFilename.toLowerCase() !== 'minimaxassettool.exe') throw new Error(`unexpected OriginalFilename: ${metadata.OriginalFilename}`);

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  const targetExe = path.join(outputRoot, 'MiniMaxAssetTool.exe');
  fs.copyFileSync(sourceExe, targetExe);
  const entries = fs.readdirSync(outputRoot);
  if (entries.length !== 1 || entries[0] !== 'MiniMaxAssetTool.exe') throw new Error('signing bundle must contain exactly MiniMaxAssetTool.exe');
  return { sourceExe, targetExe, sha256: sha256(targetExe), metadata };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['unpacked', 'out', 'version']) if (!args[required]) throw new Error(`missing --${required}`);
  const result = createSigningBundle({ unpacked: args.unpacked, output: args.out, version: args.version });
  const evidencePath = path.join(path.dirname(path.resolve(args.out)), 'SIGNING_INPUT.json');
  fs.writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exit(1); }
}

module.exports = { createSigningBundle, getPeMetadata, parseArgs, sha256 };
