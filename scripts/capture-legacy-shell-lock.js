'use strict';

// Capture a byte-lock ("legacy shell lock") of a locally-working, warning-free
// runtime seed (e.g. C:\Tools\MinimaxAssetTool1.0.0). The lock freezes every
// file except the documented mutable surface (app.asar, models, docs) and
// inventories every PE file by SHA-256 + size. User data paths are refused.
// The lock feeds scripts/compose-legacy-release.js so v1.0.7 ships exactly the
// proven runtime binaries.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PE_EXTENSIONS = new Set(['.exe', '.dll', '.node', '.sys', '.ocx', '.cpl', '.scr', '.drv', '.mui', '.ax', '.acm', '.tsp', '.efi']);
const DEFAULT_MUTABLE_PREFIXES = [
  'resources/app.asar',
  'resources/app.asar.unpacked/',
  'resources/bin/models/',
  'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'START HERE.txt',
  'Install MiniMax Asset Tool.cmd', 'OFFLINE_RUNTIME_MANIFEST.json',
  'FILES.sha256', 'LEGACY_RUNTIME_NOTICE.json',
];
const FORBIDDEN_USER_PATHS = [
  'config.txt', 'providers.json', 'renderer-error.log', 'renderer-error.log.old',
  'renderer-error.log.prev', 'generated/', 'output/', 'reports/', 'crashes/',
  'user-data/', 'credentials/', 'secrets/',
];

function normalize(value) { return value.replace(/\\/g, '/').replace(/^\.\//, ''); }
function isPrefixMatch(relativePath, prefix) {
  const rel = normalize(relativePath).toLowerCase();
  const p = normalize(prefix).toLowerCase();
  return p.endsWith('/') ? rel.startsWith(p) : rel === p;
}
function isMutable(relativePath, prefixes = DEFAULT_MUTABLE_PREFIXES) { return prefixes.some((p) => isPrefixMatch(relativePath, p)); }
function isForbiddenUserPath(relativePath) { return FORBIDDEN_USER_PATHS.some((p) => isPrefixMatch(relativePath, p)); }
function isPe(relativePath) { return PE_EXTENSIONS.has(path.extname(relativePath).toLowerCase()); }

function hasPeMagic(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(2);
  try { return fs.readSync(fd, buffer, 0, 2, 0) === 2 && buffer[0] === 0x4d && buffer[1] === 0x5a; }
  finally { fs.closeSync(fd); }
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  let count;
  try { while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function walkFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in a legacy seed: ${absolute}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  walk(root);
  return files.sort();
}

function copyFilePreservingPath(sourceRoot, relativePath, targetRoot) {
  const source = path.join(sourceRoot, relativePath);
  const target = path.join(targetRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function captureLegacyShellLock({ seed, tag, provenancePath, mutablePrefixes = DEFAULT_MUTABLE_PREFIXES, exportDir }) {
  const seedRoot = path.resolve(seed);
  if (!fs.existsSync(seedRoot)) throw new Error(`seed directory not found: ${seedRoot}`);
  const exePath = path.join(seedRoot, 'MiniMaxAssetTool.exe');
  const asarPath = path.join(seedRoot, 'resources', 'app.asar');
  if (!fs.existsSync(exePath)) throw new Error(`missing MiniMaxAssetTool.exe in ${seedRoot}`);
  if (!fs.existsSync(asarPath)) throw new Error(`missing resources/app.asar in ${seedRoot}`);

  const frozenFiles = {};
  const peFiles = {};
  let ignoredMutableFileCount = 0;
  for (const absolute of walkFiles(seedRoot)) {
    const relative = normalize(path.relative(seedRoot, absolute));
    if (isForbiddenUserPath(relative)) throw new Error(`possible user data or secret material in seed: ${relative}`);
    const info = { sha256: hashFile(absolute), size: fs.statSync(absolute).size };
    if (isPe(relative) || hasPeMagic(absolute)) peFiles[relative] = info;
    if (!isMutable(relative, mutablePrefixes)) frozenFiles[relative] = info;
    else ignoredMutableFileCount += 1;
  }

  let provenance = null;
  if (provenancePath) provenance = JSON.parse(fs.readFileSync(path.resolve(provenancePath), 'utf8'));
  const lock = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceTag: tag || null,
    architecture: 'x64',
    productName: 'MiniMaxAssetTool',
    executableSha256: peFiles['MiniMaxAssetTool.exe']?.sha256 || null,
    electronVersion: provenance?.electronVersion || null,
    sourceVersion: provenance?.version || null,
    mutablePrefixes,
    frozenFiles,
    peFiles,
    ignoredMutableFileCount,
  };

  if (exportDir) {
    const exportRoot = path.resolve(exportDir);
    fs.rmSync(exportRoot, { recursive: true, force: true });
    fs.mkdirSync(exportRoot, { recursive: true });
    const exportPaths = new Set([...Object.keys(frozenFiles), ...Object.keys(peFiles)]);
    for (const relative of [...exportPaths].sort()) copyFilePreservingPath(seedRoot, relative, exportRoot);
    fs.writeFileSync(path.join(exportRoot, 'legacy-shell.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  }
  return lock;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.seed || !args.out) throw new Error('usage: --seed <dir> --out <lock.json> [--tag <name>] [--provenance <file>] [--export-dir <dir>]');
  const lock = captureLegacyShellLock({ seed: args.seed, tag: args.tag, provenancePath: args.provenance, exportDir: args['export-dir'] });
  const out = path.resolve(args.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  process.stdout.write(`Legacy shell lock written: ${out}\nExecutable SHA-256: ${lock.executableSha256}\nPE files: ${Object.keys(lock.peFiles).length}\nFrozen files: ${Object.keys(lock.frozenFiles).length}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exit(1); }
}

module.exports = { DEFAULT_MUTABLE_PREFIXES, FORBIDDEN_USER_PATHS, PE_EXTENSIONS, captureLegacyShellLock, hashFile, hasPeMagic, isForbiddenUserPath, isMutable, isPe, normalize, walkFiles };
