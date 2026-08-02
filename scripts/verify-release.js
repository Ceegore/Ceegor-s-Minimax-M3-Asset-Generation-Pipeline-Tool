// Verifies the exact release files and, for release builds, enforces signing.
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { archiveFiles, infoFor, releasePaths, relative, validateArchiveSequence } = require('./releaseArtifacts');

function signatureFor(filePath) {
  if (process.platform !== 'win32') return { checked: false, status: 'UNSUPPORTED_PLATFORM' };
  const quotedPath = String(filePath).replace(/'/g, "''");
  const command = [
    `$s = Get-AuthenticodeSignature -LiteralPath '${quotedPath}'`,
    "[pscustomobject]@{ Status = [string]$s.Status; Subject = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { '' } } | ConvertTo-Json -Compress",
  ].join('; ');
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return { checked: true, status: 'CHECK_FAILED', error: (result.stderr || '').trim() };
  try {
    const parsed = JSON.parse(result.stdout);
    return { checked: true, status: parsed.Status, subject: parsed.Subject || '' };
  } catch (_) {
    return { checked: true, status: 'CHECK_FAILED', error: 'PowerShell returned invalid signature data.' };
  }
}

function parseArgs(argv) {
  return {
    requireArchive: argv.includes('--require-archive'),
    requireSignature: argv.includes('--require-signature'),
    writeManifest: argv.includes('--write-manifest'),
    // Skip the 7za integrity probe (slow on huge archives; tests default to skipping).
    skipIntegrity: argv.includes('--skip-integrity'),
  };
}

// QA-025 fix: validate that a file is a real PE executable by checking
// the MZ DOS header magic and the PE signature at the offset specified
// in the DOS header. Returns { ok, error }.
function validatePEHeader(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const dosHeader = Buffer.alloc(64);
    const bytesRead = fs.readSync(fd, dosHeader, 0, 64, 0);
    fs.closeSync(fd);
    if (bytesRead < 64) return { ok: false, error: 'File too small to be a valid PE executable (' + bytesRead + ' bytes).' };
    // MZ magic: 0x4D 0x5A
    if (dosHeader[0] !== 0x4D || dosHeader[1] !== 0x5A) {
      return { ok: false, error: 'Missing MZ magic bytes \u2014 not a valid PE executable.' };
    }
    // e_lfanew: offset to PE signature at DOS header offset 0x3C (little-endian uint32)
    const peOffset = dosHeader.readUInt32LE(0x3C);
    if (peOffset < 64 || peOffset > 4096) {
      return { ok: false, error: `Invalid e_lfanew offset (${peOffset}) \u2014 corrupt DOS header.` };
    }
    // Read the PE signature (4 bytes: "PE\0\0")
    const fd2 = fs.openSync(filePath, 'r');
    const peSig = Buffer.alloc(4);
    fs.readSync(fd2, peSig, 0, 4, peOffset);
    fs.closeSync(fd2);
    if (peSig[0] !== 0x50 || peSig[1] !== 0x45 || peSig[2] !== 0x00 || peSig[3] !== 0x00) {
      return { ok: false, error: 'Missing PE signature \u2014 file has MZ header but no valid PE structure.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Could not read PE header: ' + (e.message || e) };
  }
}

// Resolve the bundled 7za binary so the verifier is self-contained and not
// dependent on a system 7-Zip install. Mirrors build-dev-zip.js.
function sevenZipBin(root) {
  const candidates = [
    path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(root, 'node_modules', '7zip-bin', process.platform, process.arch === 'x64' ? 'x64' : 'x86', '7za'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

// Probe archive integrity with `7za t`. Returns { ok, error }.
function verifyArchiveIntegrity(root, paths, archives) {
  if (archives.length === 0) return { ok: false, error: 'No archive to test.' };
  const bin = sevenZipBin(root);
  if (!bin) {
    // 7za not available (e.g. on CI without devDeps). Degrade to a size >
    // 0 sanity check so we never silently PASS a text-as-zip fixture, but
    // don't hard-fail a real release when the tool isn't bundled.
    for (const a of archives) {
      const st = fs.statSync(a);
      if (st.size < 64) return { ok: false, error: `Archive "${path.basename(a)}" is ${st.size} bytes — too small to be a real zip (is this a text file?).` };
    }
    return { ok: true, skipped: true, note: '7za not bundled; size-only sanity check.' };
  }
  // Every part is an INDEPENDENT zip (not a raw volume split), so each one
  // must be tested on its own — `7za t` does not follow across parts.
  for (const a of archives) {
    const r = childProcess.spawnSync(bin, ['t', '-y', a], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) {
      const detail = (r.stderr || r.stdout || '').trim();
      return { ok: false, error: `Archive integrity test failed (7za exit ${r.status}) on ${path.basename(a)}: ${detail}` };
    }
  }
  return { ok: true };
}

// Verify every line of a neighbouring .sha256 manifest against the actual files.
// Returns { ok, errors[] }.
function verifyManifest(paths, files) {
  const manifest = paths.manifest;
  if (!fs.existsSync(manifest)) return { ok: true, skipped: true };
  const errors = [];
  const lines = fs.readFileSync(manifest, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const byRel = {};
  for (const f of files) byRel[relative(paths.output, f)] = f;
  // H-067 (_5 audit): track which expected files are covered by the
  // manifest so we can detect MISSING entries (completeness check).
  const manifestRels = new Set();
  for (const line of lines) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (!m) { errors.push(`Manifest line is not a valid "<sha256>  <file>" entry: "${line}".`); continue; }
    const [, expected, rel] = m;
    manifestRels.add(rel);
    const fp = byRel[rel] || path.join(paths.output, rel);
    const info = infoFor(fp);
    if (!info.exists) { errors.push(`Manifest references missing file: ${rel}.`); continue; }
    if (info.sha256.toLowerCase() !== expected.toLowerCase()) {
      errors.push(`Checksum mismatch for ${rel}: manifest ${expected} != actual ${info.sha256}.`);
    }
  }
  // H-067 (_5 audit): completeness — every expected release file must
  // appear exactly once in the manifest. A manifest that omits the
  // installer or an archive part would still pass the old check.
  for (const rel of Object.keys(byRel)) {
    if (!manifestRels.has(rel)) {
      errors.push(`Expected release file "${rel}" is missing from the manifest.`);
    }
  }
  // Duplicate detection: a file listed twice is a manifest corruption.
  const seen = new Set();
  for (const line of lines) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (!m) continue;
    if (seen.has(m[2])) errors.push(`Duplicate manifest entry: "${m[2]}".`);
    seen.add(m[2]);
  }
  return { ok: errors.length === 0, errors };
}

// Compare a provenance.json (written by the builder) against the actual
// release. Catches a stale dist-out: if the asar hash or the bundled
// Electron version no longer matches the current source/dep tree, the
// release is NOT what we think it is. Returns { ok, errors[], provenance }.
function verifyProvenance(root, paths) {
  // QA-025 fix: provenance file is REQUIRED for archive-verified releases.
  // A missing provenance means we cannot confirm the build is current.
  if (!fs.existsSync(paths.provenance)) return { ok: false, errors: ['Provenance file missing: ' + paths.provenance] };
  let prov;
  try { prov = JSON.parse(fs.readFileSync(paths.provenance, 'utf8')); }
  catch (e) { return { ok: false, errors: [`Provenance file is not valid JSON: ${e.message}`] }; }
  const errors = [];
  if (prov.commitDirty !== false) {
    errors.push('Provenance says the release was built from a dirty or unknown Git tree. Commit the intended release files and rebuild.');
  }
  if (!prov.commit) {
    errors.push('Provenance does not identify a Git commit. Build the release from a committed repository checkout.');
  }
  // Electron version: compare provenance against the currently-installed runtime.
  if (prov.electronVersion) {
    try {
      const elPkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
      if (elPkg.version !== prov.electronVersion) {
        errors.push(`Electron version mismatch: provenance recorded ${prov.electronVersion}, installed runtime is ${elPkg.version}. The release was built against a different Electron — rebuild before shipping.`);
      }
    } catch (_) { /* electron not in devDeps (e.g. packaged verifier) — skip */ }
  }
  // asar hash: compare provenance against the actual app.asar in win-unpacked.
  if (prov.asarSha256) {
    const asarPath = path.join(paths.output, 'win-unpacked', 'resources', 'app.asar');
    const info = infoFor(asarPath);
    if (!info.exists) {
      errors.push(`Provenance recorded an asar hash but app.asar is missing at ${relative(root, asarPath)}.`);
    } else if (info.sha256.toLowerCase() !== String(prov.asarSha256).toLowerCase()) {
      errors.push(`app.asar hash mismatch: provenance ${prov.asarSha256} != actual ${info.sha256}. The packaged code does not match the build record — rebuild.`);
    }
  }
  return { ok: errors.length === 0, errors, provenance: prov };
}

function evaluate(root, opts = {}) {
  const paths = releasePaths(root);
  const exe = infoFor(paths.executable);
  const archives = archiveFiles(paths);
  const archiveInfo = archives.map((filePath) => ({ filePath, ...infoFor(filePath) }));
  const signature = exe.exists ? signatureFor(paths.executable) : { checked: false, status: 'MISSING_EXE' };
  const errors = [];
  if (!exe.exists) errors.push(`Missing executable: ${paths.executable}`);
  // QA-025 fix: validate PE header so a fake/text exe is rejected.
  if (exe.exists) {
    const pe = validatePEHeader(paths.executable);
    if (!pe.ok) errors.push(`Executable failed PE validation: ${pe.error}`);
  }

  // Archive checks (only when --require-archive, so `verify:release` without
  // the flag still works as a lightweight presence probe).
  let integrity = { ok: true, skipped: true, note: 'not requested' };
  let manifest = { ok: true, skipped: true };
  let provenance = { ok: true, skipped: true };
  let freshness = { ok: true, skipped: true };
  if (opts.requireArchive) {
    const seq = validateArchiveSequence(paths);
    if (!seq.ok) {
      errors.push(seq.error);
    } else {
      if (!opts.skipIntegrity) {
        integrity = verifyArchiveIntegrity(root, paths, archives);
        if (!integrity.ok) errors.push(integrity.error);
      }
      manifest = verifyManifest(paths, [paths.executable, ...archives]);
      if (!manifest.ok) errors.push(...manifest.errors);
      provenance = verifyProvenance(root, paths);
      if (!provenance.ok) errors.push(...provenance.errors);
      // KGO7-022: an archive that predates the source it claims to package
      // is not a valid release. Version matching cannot catch this — the
      // version does not move between patch batches. Measured 2026-07-27:
      // the gate reported "Integrity: ok / Provenance: verified" for a zip
      // built 2 days and ~40 commits earlier.
      freshness = verifyArchiveFreshness(root, archives);
      if (!freshness.ok) errors.push(...freshness.errors);
    }
  }
  if (opts.requireSignature && signature.status !== 'Valid') {
    errors.push(`Executable is not validly code signed: ${signature.status}`);
  }
  return { paths, exe, archives: archiveInfo, signature, integrity, manifest, provenance, freshness, errors };
}

/**
 * KGO7-022: reject an archive that is older than the source it packages.
 * Only `main/`, `renderer/`, `src/`, `preload.js`, `main.js` and
 * `package.json` count — docs, tests and scratch files do not invalidate a
 * build.
 */
function verifyArchiveFreshness(root, archives) {
  const SOURCE_ROOTS = ['main', 'renderer', 'src', 'preload.js', 'main.js', 'package.json'];
  const SKIP = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;
  if (!archives || !archives.length) return { ok: true, skipped: true };
  let oldest = Infinity;
  for (const a of archives) {
    try { oldest = Math.min(oldest, fs.statSync(a).mtimeMs); } catch (_) { /* handled elsewhere */ }
  }
  if (!Number.isFinite(oldest)) return { ok: true, skipped: true };
  const newer = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch (_) { return; }
    if (st.isDirectory()) {
      if (SKIP.test(p)) return;
      let entries;
      try { entries = fs.readdirSync(p); } catch (_) { return; }
      for (const e of entries) walk(path.join(p, e));
      return;
    }
    if (!/\.(js|html|css|json)$/i.test(p)) return;
    if (st.mtimeMs > oldest) newer.push({ p, m: st.mtimeMs });
  };
  for (const r of SOURCE_ROOTS) walk(path.join(root, r));
  if (!newer.length) return { ok: true, newerCount: 0 };
  newer.sort((a, b) => b.m - a.m);
  const sample = newer.slice(0, 8).map((f) => '    ' + relative(root, f.p) + '  ' + new Date(f.m).toISOString());
  return {
    ok: false,
    newerCount: newer.length,
    errors: [
      `Archive is STALE: ${newer.length} source file(s) are newer than the built archive `
      + `(archive: ${new Date(oldest).toISOString()}). Rebuild before releasing.\n` + sample.join('\n')
      + (newer.length > 8 ? `\n    … and ${newer.length - 8} more` : ''),
    ],
  };
}

function writeManifest(report) {
  const files = [report.paths.executable, ...report.archives.map((item) => item.filePath)];
  const lines = files.map((filePath) => {
    const info = infoFor(filePath);
    if (!info.exists) throw new Error(`Cannot write a checksum for missing file: ${filePath}`);
    return `${info.sha256}  ${relative(report.paths.root, filePath)}`;
  });
  fs.writeFileSync(report.paths.manifest, lines.join('\n') + '\n', 'utf8');
  return report.paths.manifest;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = evaluate(process.cwd(), opts);
  console.log(`Release version: ${report.paths.version}`);
  console.log(`Output directory: ${report.paths.output}`);
  console.log(`Executable: ${report.exe.exists ? 'present' : 'MISSING'}`);
  console.log(`Signature: ${report.signature.status}${report.signature.subject ? ` (${report.signature.subject})` : ''}`);
  console.log(`Archive: ${report.archives.length ? report.archives.map((item) => path.basename(item.filePath)).join(', ') : 'MISSING'}`);
  if (opts.requireArchive) {
    console.log(`Integrity: ${report.integrity.ok ? (report.integrity.skipped ? 'skipped (' + (report.integrity.note || 'n/a') + ')' : 'ok') : 'FAILED'}`);
    console.log(`Manifest: ${report.manifest.ok ? (report.manifest.skipped ? 'n/a' : 'verified') : 'MISMATCH'}`);
    console.log(`Provenance: ${report.provenance.ok ? (report.provenance.skipped ? 'n/a' : 'verified') : 'MISMATCH'}`);
    console.log(`Freshness: ${report.freshness.ok ? (report.freshness.skipped ? 'n/a' : 'up to date') : `STALE (${report.freshness.newerCount} newer source file(s))`}`);
  }
  if (opts.writeManifest && report.errors.length === 0) console.log(`Checksums: ${writeManifest(report)}`);
  if (report.errors.length) {
    for (const error of report.errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { evaluate, parseArgs, signatureFor, writeManifest, verifyArchiveIntegrity, verifyManifest, verifyProvenance, verifyArchiveFreshness, validateArchiveSequence, validatePEHeader };
