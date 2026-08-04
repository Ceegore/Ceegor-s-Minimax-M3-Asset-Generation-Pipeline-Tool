// scripts/finalize-release-inventory.js
// ============================================================================
// V104-C002 (release requalification 1.0.4): finalize the COMPLETE outer
// release inventory AFTER provenance and SBOM exist, and BEFORE signing.
//
// Root cause of the v1.0.4 defect: zip-portable.js wrote the outer
// <base>.sha256 manifest BEFORE the provenance record existed, and the
// SBOM + signature material were produced afterwards — so the SIGNED
// manifest never covered provenance/SBOM, and publication uploaded the
// entire dist-out directory (including files no manifest entry covered).
//
// This script is the single point that produces the final signed inventory:
//   1. fail-closed preconditions: provenance + SBOM must already exist
//   2. copies the pinned Minisign public key (MINISIGN_PUB_PATH) into the
//      output dir — it is a canonical, manifest-covered release artifact
//   3. copies the pinned minisign verifier (MINISIGN_TOOL_PATH) when the
//      pipeline provides it, so end users can verify offline (C001)
//   4. rewrites <base>.sha256 from releaseArtifacts.outerManifestEntries()
//      — the manifest that sign-release.js signs afterwards is complete
//
// Usage: node scripts/finalize-release-inventory.js
//   env MINISIGN_PUB_PATH   path to the pinned public key (required)
//   env MINISIGN_TOOL_PATH  path to the pinned minisign.exe (optional)
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

  // ---- Fail-closed preconditions: every non-optional artifact exists. ----
  if (!fs.existsSync(paths.provenance)) {
    fail(`Build provenance is missing: ${paths.provenance}\nRun the portable build (npm run build) first — the inventory is only finalized for a complete build.`);
  }
  if (!fs.existsSync(paths.sbom)) {
    fail(`SBOM is missing: ${paths.sbom}\nRun "npm run sbom" (scripts/generate-sbom.js) before finalizing the inventory.`);
  }
  if (!fs.existsSync(paths.manifest)) {
    fail(`Outer manifest is missing: ${paths.manifest}\nThe build must have written the initial manifest before finalization.`);
  }

  // ---- Ship the pinned Minisign public key with the release (C001). ----
  const pubSrc = process.env.MINISIGN_PUB_PATH || path.join(ROOT, 'minisign.pub');
  if (!fs.existsSync(pubSrc)) {
    fail(`Pinned Minisign public key not found at ${pubSrc}. Set MINISIGN_PUB_PATH — a release cannot be finalized without the key that will verify it.`);
  }
  const pubDest = path.join(paths.output, 'minisign.pub');
  fs.copyFileSync(pubSrc, pubDest);
  log('Published pinned Minisign public key: ' + pubDest);

  // ---- Optionally ship the pinned verifier binary (C001). ----
  const toolSrc = process.env.MINISIGN_TOOL_PATH;
  if (toolSrc) {
    if (!fs.existsSync(toolSrc)) fail(`MINISIGN_TOOL_PATH points at a missing verifier: ${toolSrc}`);
    const toolDest = path.join(paths.output, 'minisign.exe');
    fs.copyFileSync(toolSrc, toolDest);
    log('Published pinned Minisign verifier: ' + toolDest + ' (sha256 ' + sha256File(toolDest) + ')');
  } else {
    log('MINISIGN_TOOL_PATH not set — the pinned verifier is NOT bundled (end users need minisign on PATH).');
  }

  // ---- Rewrite the outer manifest over the COMPLETE inventory. ----
  const entries = outerManifestEntries(paths);
  if (entries.length < 4) {
    fail(`Final inventory is implausibly small (${entries.length} entries) — refusing to finalize.`);
  }
  const lines = entries.map((rel) => {
    const fp = path.join(paths.output, rel);
    if (!fs.existsSync(fp)) fail(`canonical release artifact vanished during finalization: ${rel}`);
    return sha256File(fp) + '  ' + rel;
  });
  fs.writeFileSync(paths.manifest, lines.join('\n') + '\n', 'utf8');
  log(`Final release inventory written: ${paths.manifest} (${entries.length} entries)`);
  for (const rel of entries) log('  ' + rel);
}

main();
