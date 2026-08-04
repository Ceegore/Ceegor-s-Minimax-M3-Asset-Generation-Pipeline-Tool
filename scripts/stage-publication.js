// scripts/stage-publication.js
// ============================================================================
// V104-C002 (release requalification 1.0.4): stage EXACTLY the signed
// release inventory for publication.
//
// RR2-B002/M003/C002 (recheck-2) hardening:
//   • RR2-B002: every staged file's PARENT directory is created before the
//     copy (a nested manifest entry like win-unpacked/MiniMaxAssetTool.exe
//     used to crash copyFileSync with ENOENT).
//   • RR2-M003: the signed manifest must be EXACTLY the canonical
//     inventory — EXTRA entries are rejected, not only missing ones.
//   • RR2-C002: the manifest signature is verified CRYPTOGRAPHICALLY with
//     the PINNED public key (MINISIGN_PUB_PATH, fail-closed) BEFORE any
//     file is staged. The neighbouring dist-out/minisign.pub is part of
//     the protected payload, so it can never be the verification anchor;
//     when it ships it must equal the pinned key byte-for-byte. Manifest
//     paths are validated against traversal/absolute-path injection.
//
// Publication is limited to:
//   • every entry of the signed outer manifest (<base>.sha256)
//   • the detached signature (<base>.sha256.minisig)
//   • the signed manifest itself
//
// This script copies exactly those files into dist-out/publication/ and
// FAILS CLOSED if the manifest is unsigned/unverifiable, an entry is
// missing or extra, a path is unsafe, or a checksum does not match. The
// publication job uploads only that folder.
//
// Usage: node scripts/stage-publication.js
// ============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { outerManifestEntries, releasePaths } = require('./releaseArtifacts');

const ROOT = path.resolve(__dirname, '..');

function log(m) { process.stdout.write(m + '\n'); }
function fail(m) { process.stderr.write('ERROR: ' + m + '\n'); process.exit(1); }

// RR2-C002: a manifest entry must be a plain relative POSIX-style path.
// Rejects absolute paths, drive letters, UNC paths and ".." traversal.
const SAFE_REL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function validateManifestRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) {
    return { ok: false, error: 'Manifest entry path must be a non-empty string (<=512 chars).' };
  }
  if (!SAFE_REL_RE.test(rel)) {
    return { ok: false, error: `Manifest entry path contains unsafe characters: "${rel}"` };
  }
  if (/^[\w-]+:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) {
    return { ok: false, error: `Manifest entry must be a relative path: "${rel}"` };
  }
  const segments = rel.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) {
    return { ok: false, error: `Manifest entry contains a traversal or empty segment: "${rel}"` };
  }
  // The staging output folder must never be part of the signed payload.
  if (segments[0] === 'publication') {
    return { ok: false, error: `Manifest entry points into the publication staging folder: "${rel}"` };
  }
  return { ok: true };
}

// Parse a "<sha256>  <rel>" manifest. Returns { ok, entries, error }.
function parseManifest(content) {
  const entries = [];
  const lines = String(content).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  for (const line of lines) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (!m) return { ok: false, entries, error: `Manifest line is malformed: "${line}"` };
    const [, sha256, rel] = m;
    if (seen.has(rel)) return { ok: false, entries, error: `Duplicate manifest entry: "${rel}"` };
    seen.add(rel);
    const relCheck = validateManifestRel(rel);
    if (!relCheck.ok) return { ok: false, entries, error: relCheck.error };
    entries.push({ sha256: sha256.toLowerCase(), rel });
  }
  if (entries.length === 0) return { ok: false, entries, error: 'Manifest is empty.' };
  return { ok: true, entries };
}

// RR2-M003: EXACT set equality between the signed manifest and the
// canonical inventory. Returns { ok, missing[], extra[] }.
function checkExactInventory(manifestRels, canonicalRels) {
  const manifestSet = new Set(manifestRels);
  const canonicalSet = new Set(canonicalRels);
  const missing = [...canonicalSet].filter((rel) => !manifestSet.has(rel));
  const extra = [...manifestSet].filter((rel) => !canonicalSet.has(rel));
  if (missing.length || extra.length) return { ok: false, missing, extra };
  return { ok: true, missing, extra };
}

// RR2-C002: cryptographic Minisign verification of the detached manifest
// signature against a PINNED public key. `spawn` is injectable for tests.
function verifyManifestSignature({ manifestPath, sigPath, pubKeyPath, minisignBin, spawn = spawnSync }) {
  if (!pubKeyPath || !fs.existsSync(pubKeyPath)) {
    return { ok: false, error: 'RR2-C002: MINISIGN_PUB_PATH is not set or does not exist — publication cannot verify the manifest signature against the pinned key and must not proceed.' };
  }
  const bin = minisignBin || process.env.MINISIGN_TOOL_PATH || 'minisign';
  let r;
  try {
    r = spawn(bin, ['-V', '-Q', '-p', pubKeyPath, '-m', manifestPath, '-x', sigPath], { encoding: 'utf8', windowsHide: true });
  } catch (e) {
    return { ok: false, error: `Cannot launch the Minisign verifier (${bin}): ${e.message}` };
  }
  if (r.error) return { ok: false, error: `Cannot launch the Minisign verifier (${bin}): ${r.error.message}` };
  if (r.status !== 0) {
    const detail = ((r.stderr || '') + ' ' + (r.stdout || '')).trim();
    return { ok: false, error: `Minisign rejected the manifest signature (exit ${r.status}): ${detail}` };
  }
  return { ok: true };
}

// RR2-B002: copy every file AFTER creating its parent directory, so
// nested manifest entries (win-unpacked/...) never hit ENOENT.
function stageFiles({ srcRoot, stageDir, rels }) {
  for (const rel of rels) {
    const src = path.join(srcRoot, rel);
    const dest = path.join(stageDir, rel);
    if (!fs.existsSync(src)) throw new Error(`Staging source missing on disk: ${rel}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function sha256File(fp) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(fp, 'r');
  const buf = Buffer.alloc(64 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.slice(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

// Walk the staged folder and return every file relative to it — used to
// prove the staged set is EXACTLY what we copied (no leftovers).
function stagedFileRels(stageDir) {
  const rels = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else rels.push(path.relative(stageDir, full).replace(/\\/g, '/'));
    }
  })(stageDir);
  return rels.sort();
}

function main({ root = ROOT, env = process.env, spawn = spawnSync } = {}) {
  const paths = releasePaths(root);
  const sigPath = paths.manifest + '.minisig';

  // Fail closed: a publication must never happen from an unsigned state.
  if (!fs.existsSync(paths.manifest)) fail(`Outer manifest missing: ${paths.manifest}`);
  if (!fs.existsSync(sigPath)) fail(`Detached signature missing: ${sigPath} — a release cannot be published unsigned (sign:release must run first).`);

  // RR2-C002: the PINNED public key is the only accepted verification
  // anchor. The dist-out/minisign.pub shipped beside the release is part
  // of the signed payload and therefore circular — it may never replace
  // the pinned key (it is only byte-compared against it below).
  const pubKeyPath = env.MINISIGN_PUB_PATH || '';
  const sigCheck = verifyManifestSignature({
    manifestPath: paths.manifest,
    sigPath,
    pubKeyPath,
    minisignBin: env.MINISIGN_TOOL_PATH || '',
    spawn,
  });
  if (!sigCheck.ok) fail(sigCheck.error);
  log(`Minisign signature of ${path.basename(paths.manifest)} verified against the pinned key (${path.basename(pubKeyPath)}).`);

  // Parse the signed manifest and re-check every entry byte-for-byte.
  const parsed = parseManifest(fs.readFileSync(paths.manifest, 'utf8'));
  if (!parsed.ok) fail(parsed.error);
  for (const { sha256, rel } of parsed.entries) {
    const fp = path.join(paths.output, rel);
    if (!fs.existsSync(fp)) fail(`Manifest entry is missing on disk: ${rel}`);
    const actual = sha256File(fp);
    if (actual.toLowerCase() !== sha256) {
      fail(`Checksum mismatch for ${rel}: manifest ${sha256} != actual ${actual}`);
    }
  }

  // RR2-M003: EXACT set equality with the canonical inventory — neither a
  // dropped artifact class nor a smuggled extra entry can be published.
  const canonical = outerManifestEntries(paths);
  const inv = checkExactInventory(parsed.entries.map((e) => e.rel), canonical);
  if (!inv.ok) {
    if (inv.missing.length) fail(`Canonical artifact(s) missing from the signed manifest: ${inv.missing.join(', ')} — finalize the inventory and re-sign before publishing.`);
    fail(`Signed manifest contains entries outside the canonical inventory: ${inv.extra.join(', ')} — publication rejected.`);
  }

  // RR2-C002: when the release ships its own minisign.pub (for the end
  // user's offline verification), it MUST be byte-identical to the pinned
  // key we just verified with — otherwise an attacker could swap the
  // shipped key for one matching forged signatures.
  const shippedPub = path.join(paths.output, 'minisign.pub');
  if (fs.existsSync(shippedPub)) {
    const pinned = fs.readFileSync(pubKeyPath);
    const shipped = fs.readFileSync(shippedPub);
    if (!crypto.timingSafeEqual(
      crypto.createHash('sha256').update(pinned).digest(),
      crypto.createHash('sha256').update(shipped).digest(),
    )) {
      fail('The shipped minisign.pub differs from the pinned MINISIGN_PUB_PATH key — refusing to publish with a swapped verification key.');
    }
  }

  // Stage exactly the published set (manifest + signature included).
  const stage = path.join(paths.output, 'publication');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const publish = [...parsed.entries.map((e) => e.rel), path.basename(paths.manifest), path.basename(sigPath)];
  stageFiles({ srcRoot: paths.output, stageDir: stage, rels: publish });

  // Post-stage audit: the staged tree must contain EXACTLY the published
  // set — nothing more, nothing less.
  const stagedSet = new Set(stagedFileRels(stage));
  for (const rel of publish) {
    if (!stagedSet.has(rel)) fail(`Staged file missing after copy: ${rel}`);
    stagedSet.delete(rel);
  }
  if (stagedSet.size > 0) fail(`Unexpected extra file(s) in the staged publication: ${[...stagedSet].join(', ')}`);

  log(`Publication staged at ${stage} (${publish.length} files):`);
  for (const name of publish) log('  ' + name);
}

if (require.main === module) main();

module.exports = {
  checkExactInventory,
  main,
  parseManifest,
  sha256File,
  stageFiles,
  stagedFileRels,
  validateManifestRel,
  verifyManifestSignature,
};
