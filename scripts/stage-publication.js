// scripts/stage-publication.js
// ============================================================================
// V104-C002 (release requalification 1.0.4): stage EXACTLY the signed
// release inventory for publication.
//
// Root cause of the v1.0.4 defect: the publication job uploaded the
// ENTIRE dist-out directory — including files the signed manifest never
// covered (provenance, SBOM, build leftovers). Anything placed in
// dist-out would have shipped. Publication must instead be limited to:
//   • every entry of the signed outer manifest (<base>.sha256)
//   • the detached signature (<base>.sha256.minisig)
//   • the signed manifest itself
//
// This script copies exactly those files into dist-out/publication/ and
// FAILS CLOSED if the manifest is unsigned, an entry is missing, or a
// checksum does not match. The publication job uploads only that folder.
//
// Usage: node scripts/stage-publication.js
// ============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { outerManifestEntries, releasePaths } = require('./releaseArtifacts');

const ROOT = path.resolve(__dirname, '..');

function log(m) { process.stdout.write(m + '\n'); }
function fail(m) { process.stderr.write('ERROR: ' + m + '\n'); process.exit(1); }

function sha256File(fp) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(fp, 'r');
  const buf = Buffer.alloc(64 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.slice(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

function main() {
  const paths = releasePaths(ROOT);
  const sigPath = paths.manifest + '.minisig';

  // Fail closed: a publication must never happen from an unsigned state.
  if (!fs.existsSync(paths.manifest)) fail(`Outer manifest missing: ${paths.manifest}`);
  if (!fs.existsSync(sigPath)) fail(`Detached signature missing: ${sigPath} — a release cannot be published unsigned (sign:release must run first).`);

  // Parse the signed manifest and re-check every entry byte-for-byte.
  const lines = fs.readFileSync(paths.manifest, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const staged = [];
  for (const line of lines) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (!m) fail(`Manifest line is malformed: "${line}"`);
    const [, expected, rel] = m;
    const fp = path.join(paths.output, rel);
    if (!fs.existsSync(fp)) fail(`Manifest entry is missing on disk: ${rel}`);
    const actual = sha256File(fp);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      fail(`Checksum mismatch for ${rel}: manifest ${expected} != actual ${actual}`);
    }
    staged.push(rel);
  }

  // Cross-check against the canonical inventory so a finalized manifest
  // that silently dropped an artifact class cannot be published either.
  const canonical = new Set(outerManifestEntries(paths));
  for (const rel of canonical) {
    if (!staged.includes(rel)) fail(`Canonical artifact "${rel}" is not covered by the signed manifest — finalize the inventory and re-sign before publishing.`);
  }

  // Stage exactly the published set (manifest + signature included).
  const stage = path.join(paths.output, 'publication');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const publish = [...staged, path.basename(paths.manifest), path.basename(sigPath)];
  for (const name of publish) {
    fs.copyFileSync(path.join(paths.output, name), path.join(stage, name));
  }
  log(`Publication staged at ${stage} (${publish.length} files):`);
  for (const name of publish) log('  ' + name);
}

main();
