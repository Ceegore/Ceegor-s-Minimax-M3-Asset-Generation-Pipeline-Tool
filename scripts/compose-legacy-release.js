'use strict';

// Compose a legacy-compatible release tree: a fresh donor build (from
// scripts/build-unpacked.js) provides the application content, while every
// runtime binary is byte-replaced from the hash-locked warning-free seed.
// Hard rules: the donor's every PE except MiniMaxAssetTool.exe must already
// equal the lock, and the composed tree must reach EXACT PE equality with the
// lock. Any mismatch stops the release. Writes LEGACY_RUNTIME_NOTICE.json.

const fs = require('fs');
const path = require('path');
const { hashFile, hasPeMagic, isPe, normalize, walkFiles } = require('./capture-legacy-shell-lock');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link not allowed: ${src}`);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
  }
}

function verifyFileMap(root, fileMap, label) {
  for (const [relative, expected] of Object.entries(fileMap)) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) throw new Error(`${label} is missing locked file: ${relative}`);
    const actualHash = hashFile(absolute);
    const actualSize = fs.statSync(absolute).size;
    if (actualHash !== expected.sha256 || actualSize !== expected.size) {
      throw new Error(`${label} mismatch for ${relative}: expected ${expected.sha256}/${expected.size}, got ${actualHash}/${actualSize}`);
    }
  }
}

function collectPeMap(root) {
  const result = {};
  for (const absolute of walkFiles(root)) {
    const relative = normalize(path.relative(root, absolute));
    if (isPe(relative) || hasPeMagic(absolute)) {
      result[relative] = { sha256: hashFile(absolute), size: fs.statSync(absolute).size };
    }
  }
  return result;
}

function comparePathSets(actual, expected, label) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    const added = actualKeys.filter((key) => !(key in expected));
    const missing = expectedKeys.filter((key) => !(key in actual));
    throw new Error(`${label} path set differs. Added: ${added.join(', ') || '-'}; Missing: ${missing.join(', ') || '-'}`);
  }
}

function compareExactMaps(actual, expected, label) {
  comparePathSets(actual, expected, label);
  for (const key of Object.keys(expected).sort()) {
    if (actual[key].sha256 !== expected[key].sha256 || actual[key].size !== expected[key].size) {
      throw new Error(`${label} byte mismatch: ${key}`);
    }
  }
}

function assertApplicationLayout(root) {
  const asar = path.join(root, 'resources', 'app.asar');
  if (!fs.existsSync(asar) || fs.statSync(asar).size < 1024) throw new Error(`missing or implausibly small app.asar: ${asar}`);
  for (const forbidden of ['main.js', 'preload.js', 'main', 'src', 'renderer']) {
    if (fs.existsSync(path.join(root, forbidden))) throw new Error(`loose application source outside app.asar: ${forbidden}`);
  }
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

function composeLegacyRelease({ seed, current, output, lockPath, version, commit }) {
  const seedRoot = path.resolve(seed);
  const currentRoot = path.resolve(current);
  const outputRoot = path.resolve(output);
  const lock = JSON.parse(fs.readFileSync(path.resolve(lockPath), 'utf8'));
  if (!fs.existsSync(seedRoot)) throw new Error(`seed not found: ${seedRoot}`);
  if (!fs.existsSync(currentRoot)) throw new Error(`current build not found: ${currentRoot}`);
  assertApplicationLayout(currentRoot);
  verifyFileMap(seedRoot, lock.frozenFiles, 'legacy seed');
  verifyFileMap(seedRoot, lock.peFiles, 'legacy seed PE inventory');

  // The newly built tree is only an application-content donor. Its launcher
  // is expected to differ because electron-builder embeds the new application
  // version and PE metadata; that launcher is never shipped. Every OTHER PE
  // must already be byte-identical to the locked runtime. This prevents a
  // same-path native dependency update (.dll/.node/.exe) from silently
  // introducing an ABI that the legacy shell was never validated with.
  const currentPe = collectPeMap(currentRoot);
  const currentRuntimePe = { ...currentPe };
  const lockedRuntimePe = { ...lock.peFiles };
  delete currentRuntimePe['MiniMaxAssetTool.exe'];
  delete lockedRuntimePe['MiniMaxAssetTool.exe'];
  compareExactMaps(currentRuntimePe, lockedRuntimePe, 'current native-runtime PE inventory');

  const tempRoot = `${outputRoot}.assembling-${process.pid}`;
  fs.rmSync(tempRoot, { recursive: true, force: true });
  copyTree(currentRoot, tempRoot);
  const lockedRuntimePaths = new Set([...Object.keys(lock.frozenFiles), ...Object.keys(lock.peFiles)]);
  for (const relative of [...lockedRuntimePaths].sort()) {
    const src = path.join(seedRoot, relative);
    const dst = path.join(tempRoot, relative);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  assertApplicationLayout(tempRoot);
  verifyFileMap(tempRoot, lock.frozenFiles, 'composed legacy release');
  compareExactMaps(collectPeMap(tempRoot), lock.peFiles, 'composed PE inventory');

  const notice = {
    schemaVersion: 1,
    releaseMode: 'legacy-compatible-transition',
    applicationVersion: version || null,
    sourceCommit: commit || null,
    runtimeSourceTag: lock.sourceTag || null,
    runtimeSourceVersion: lock.sourceVersion || null,
    electronVersion: lock.electronVersion || null,
    executableSha256: lock.executableSha256,
    composedAt: new Date().toISOString(),
    warning: 'This transition release reuses hash-locked runtime binaries and is not a new Authenticode-signed build.',
  };
  fs.writeFileSync(path.join(tempRoot, 'LEGACY_RUNTIME_NOTICE.json'), `${JSON.stringify(notice, null, 2)}\n`, 'utf8');
  atomicReplace(tempRoot, outputRoot);
  return notice;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['seed', 'current', 'out', 'lock']) if (!args[required]) throw new Error(`missing --${required}`);
  const result = composeLegacyRelease({ seed: args.seed, current: args.current, output: args.out, lockPath: args.lock, version: args.version, commit: args.commit });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exit(1); }
}

module.exports = { assertApplicationLayout, collectPeMap, compareExactMaps, comparePathSets, composeLegacyRelease, copyTree, verifyFileMap };
