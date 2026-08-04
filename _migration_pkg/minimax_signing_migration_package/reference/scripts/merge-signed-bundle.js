'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { copyTree } = require('./compose-legacy-release');

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

function findFiles(root, filename) {
  const matches = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) matches.push(absolute);
    }
  }
  walk(root);
  return matches;
}

function getSignatureInfo(filePath) {
  if (process.platform !== 'win32') throw new Error('Authenticode validation requires Windows');
  const escaped = filePath.replace(/'/g, "''");
  const script = `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}';$v=(Get-Item -LiteralPath '${escaped}').VersionInfo;[pscustomobject]@{Status=[string]$s.Status;StatusMessage=$s.StatusMessage;SignerSubject=$s.SignerCertificate.Subject;SignerThumbprint=$s.SignerCertificate.Thumbprint;TimestampSubject=$s.TimeStamperCertificate.Subject;ProductName=$v.ProductName;ProductVersion=$v.ProductVersion;FileVersion=$v.FileVersion;OriginalFilename=$v.OriginalFilename}|ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`signature inspection failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

function atomicReplace(tempRoot, outputRoot) {
  const backup = `${outputRoot}.previous`;
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(outputRoot)) fs.renameSync(outputRoot, backup);
  try { fs.renameSync(tempRoot, outputRoot); fs.rmSync(backup, { recursive: true, force: true }); }
  catch (error) {
    if (fs.existsSync(outputRoot)) fs.rmSync(outputRoot, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, outputRoot);
    throw error;
  }
}

function mergeSignedBundle({ unsigned, signed, output, version, signatureProvider = getSignatureInfo }) {
  const unsignedRoot = path.resolve(unsigned);
  const signedRoot = path.resolve(signed);
  const outputRoot = path.resolve(output);
  const unsignedExe = path.join(unsignedRoot, 'MiniMaxAssetTool.exe');
  if (!fs.existsSync(unsignedExe)) throw new Error(`missing unsigned executable: ${unsignedExe}`);
  if (!fs.existsSync(signedRoot)) throw new Error(`missing signed output: ${signedRoot}`);
  const matches = findFiles(signedRoot, 'MiniMaxAssetTool.exe');
  if (matches.length !== 1) throw new Error(`expected exactly one signed MiniMaxAssetTool.exe, found ${matches.length}`);
  const signedExe = matches[0];
  const signature = signatureProvider(signedExe);
  if (signature.Status !== 'Valid') throw new Error(`signed executable status is ${signature.Status}: ${signature.StatusMessage || ''}`);
  if (!/SignPath Foundation/i.test(signature.SignerSubject || '')) throw new Error(`unexpected signer: ${signature.SignerSubject || '<none>'}`);
  if (signature.ProductName !== 'MiniMaxAssetTool') throw new Error(`unexpected ProductName: ${signature.ProductName}`);
  if (!String(signature.ProductVersion || '').startsWith(String(version))) throw new Error(`ProductVersion ${signature.ProductVersion} does not match ${version}`);

  const unsignedHash = sha256(unsignedExe);
  const signedHash = sha256(signedExe);
  if (unsignedHash === signedHash) throw new Error('signed executable hash equals unsigned hash; signature was not applied');

  const tempRoot = `${outputRoot}.assembling-${process.pid}`;
  fs.rmSync(tempRoot, { recursive: true, force: true });
  copyTree(unsignedRoot, tempRoot);
  const targetExe = path.join(tempRoot, 'MiniMaxAssetTool.exe');
  const tempExe = `${targetExe}.signed-new`;
  fs.copyFileSync(signedExe, tempExe);
  fs.renameSync(tempExe, targetExe);

  const result = {
    schemaVersion: 1,
    releaseMode: 'signpath',
    version,
    unsignedSha256: unsignedHash,
    signedSha256: signedHash,
    signature,
    mergedAt: new Date().toISOString(),
    githubRunUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    commit: process.env.GITHUB_SHA || null,
  };
  fs.writeFileSync(path.join(tempRoot, 'SIGNING_RESULT.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  atomicReplace(tempRoot, outputRoot);
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['unsigned', 'signed', 'out', 'version']) if (!args[required]) throw new Error(`missing --${required}`);
  process.stdout.write(`${JSON.stringify(mergeSignedBundle({ unsigned: args.unsigned, signed: args.signed, output: args.out, version: args.version }), null, 2)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exit(1); }
}

module.exports = { findFiles, getSignatureInfo, mergeSignedBundle, parseArgs, sha256 };
