// Shared, version-driven release artifact discovery.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function readPackage(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function releasePaths(root, pkg = readPackage(root)) {
  const output = path.resolve(root, pkg.build?.directories?.output || 'dist');
  const productName = pkg.build?.productName || pkg.productName || pkg.name;
  const baseName = `${productName}-${pkg.version}-x64`;
  return {
    root,
    output,
    productName,
    version: pkg.version,
    baseName,
    executable: path.join(output, 'win-unpacked', `${productName}.exe`),
    archive: path.join(output, `${baseName}.zip`),
    manifest: path.join(output, `${baseName}.sha256`),
    provenance: path.join(output, `${baseName}.provenance.json`),
  };
}

function infoFor(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { exists: false };
    // QA-026 fix: use streaming hash to support files >2 GiB
    // (readFileSync fails with ERR_FS_FILE_TOO_LARGE on V8's
    // max string/buffer length).
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.slice(0, bytesRead));
    }
    fs.closeSync(fd);
    return {
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      sha256: hash.digest('hex'),
    };
  } catch (_) {
    return { exists: false };
  }
}

// Discover the release archive. A single unsplit .zip always wins; otherwise
// we collect the .part1.zip/.part2.zip/... sequence. Each part is an
// INDEPENDENT, individually-valid zip (not a raw 7-Zip volume split) so any
// archiver extracts it straight into the release folder.
function archiveFiles(paths) {
  if (fs.existsSync(paths.archive)) return [paths.archive];
  try {
    return fs.readdirSync(paths.output)
      .filter((name) => new RegExp(`^${escapeRegExp(paths.baseName)}\\.part\\d+\\.zip$`).test(name))
      .sort((a, b) => partNumber(a) - partNumber(b))
      .map((name) => path.join(paths.output, name));
  } catch (_) {
    return [];
  }
}

function partNumber(name) {
  const m = /\.part(\d+)\.zip$/.exec(name);
  return m ? parseInt(m[1], 10) : 0;
}

// Validate that a split archive is a COMPLETE, contiguous part sequence.
// Returns { ok: true } or { ok: false, error, missing }.
//
// A standalone .part2.zip (with no .part1.zip), or a sequence with a gap
// (.part1 + .part3, no .part2), is rejected — these are exactly the
// false-positive shapes the old verifier accepted.
function validateArchiveSequence(paths) {
  const archives = archiveFiles(paths);
  if (archives.length === 0) {
    return { ok: false, error: `Missing release archive: ${paths.archive}`, missing: ['.part1.zip'] };
  }
  // A single unsplit zip needs no sequence check.
  if (archives.length === 1 && archives[0] === paths.archive) return { ok: true, single: true };
  // Split: must start at .part1.zip and be contiguous.
  for (let i = 1; i <= archives.length; i++) {
    const want = `${paths.baseName}.part${i}.zip`;
    const wantPath = path.join(paths.output, want);
    if (!fs.existsSync(wantPath)) {
      return { ok: false, error: `Archive part sequence is incomplete: missing ${want}`, missing: [want] };
    }
  }
  return { ok: true, single: false, volumes: archives.length };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function relative(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

module.exports = { archiveFiles, infoFor, readPackage, releasePaths, relative, validateArchiveSequence };
