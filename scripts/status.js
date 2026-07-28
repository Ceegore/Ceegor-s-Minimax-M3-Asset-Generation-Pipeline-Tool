// Reports the release files derived from package.json; never invents paths.
const path = require('path');
const { archiveFiles, infoFor, releasePaths, validateArchiveSequence } = require('./releaseArtifacts');
const { signatureFor } = require('./verify-release');

function fmtSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function report(root) {
  const paths = releasePaths(root);
  const exe = infoFor(paths.executable);
  const archives = archiveFiles(paths).map((filePath) => ({ filePath, ...infoFor(filePath) }));
  const signature = exe.exists ? signatureFor(paths.executable) : { status: 'MISSING_EXE' };
  const ready = exe.exists && archives.length > 0;
  return { paths, exe, archives, signature, ready };
}

function print(item) {
  const { paths, exe, archives, signature, ready } = item;
  console.log(`MiniMax Asset Tool release status (v${paths.version})`);
  console.log(`Output: ${paths.output}`);
  console.log(`Executable: ${exe.exists ? paths.executable : `MISSING (${paths.executable})`}`);
  if (exe.exists) console.log(`  ${fmtSize(exe.size)}  SHA256 ${exe.sha256}`);
  console.log(`Signature: ${signature.status}${signature.subject ? ` (${signature.subject})` : ''}`);
  if (archives.length === 0) {
    console.log(`Archive: MISSING (${paths.archive})`);
  } else {
    const split = archives.length > 1 || archives[0].filePath.endsWith('.001');
    console.log(`Archive${split ? ' (manual split)' : ''}:`);
    for (const archive of archives) console.log(`  ${archive.filePath}  ${fmtSize(archive.size)}  SHA256 ${archive.sha256}`);
  }
  console.log(`Portable artifact completeness: ${ready ? 'COMPLETE' : 'INCOMPLETE'}`);
  if (signature.status !== 'Valid') console.log('Note: this custom executable is unsigned. Prefer npm run build:release for the Electron-runtime handoff.');
  if (!ready) console.log('A portable artifact requires an executable and archive part(s).');
}

if (require.main === module) {
  const item = report(path.resolve(__dirname, '..'));
  print(item);
  if (!item.ready) process.exitCode = 1;
}

module.exports = { fmtSize, report };
