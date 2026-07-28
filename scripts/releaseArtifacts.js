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
    manifest: path.join(output, `${baseName}.zip.sha256`),
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
// we collect the .001/.002/... volume sequence.
function archiveFiles(paths) {
  if (fs.existsSync(paths.archive)) return [paths.archive];
  try {
    return fs.readdirSync(paths.output)
      .filter((name) => new RegExp(`^${escapeRegExp(path.basename(paths.archive))}\\.\\d{3}$`).test(name))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((name) => path.join(paths.output, name));
  } catch (_) {
    return [];
  }
}

// Validate that a split archive is a COMPLETE, contiguous volume sequence.
// Returns { ok: true } or { ok: false, error, missing }.
//
// A standalone .zip.002 (with no .001), or a sequence with a gap
// (.001 + .003, no .002), is rejected — these are exactly the
// false-positive shapes the old verifier accepted.
function validateArchiveSequence(paths) {
  const archives = archiveFiles(paths);
  if (archives.length === 0) {
    return { ok: false, error: `Missing release archive: ${paths.archive}`, missing: ['.001'] };
  }
  // A single unsplit zip needs no sequence check.
  if (archives.length === 1 && archives[0] === paths.archive) return { ok: true, single: true };
  // Split: must start at .001 and be contiguous.
  const base = path.basename(paths.archive);
  for (let i = 1; i <= archives.length; i++) {
    const want = `${base}.${String(i).padStart(3, '0')}`;
    const wantPath = path.join(paths.output, want);
    if (!fs.existsSync(wantPath)) {
      return { ok: false, error: `Archive volume sequence is incomplete: missing ${want}`, missing: [want] };
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
