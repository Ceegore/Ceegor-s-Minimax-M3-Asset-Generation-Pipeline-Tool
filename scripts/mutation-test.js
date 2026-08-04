// scripts/mutation-test.js
// ============================================================================
// RQ-004 fix + V104-H001: systematic mutation-testing gate for the
// release-critical credential and security modules.
//
// Directed mutants are injected ONE AT A TIME into the production source
// (with backup + guaranteed restore), and the targeted regression suite is
// run against each mutant. A mutant the tests fail to catch ("survivor")
// means a real regression of that shape could ship undetected — so any
// survivor fails this gate.
//
// V104-H001: the v1.0.4 requalification rejected a gate that covered only
// six mutants in two files. The battery now spans EVERY critical module
// that carries a dedicated regression suite: credential store + repository,
// payload schema, secret redaction, path containment, API-key sync,
// config parsing, batch recovery latch, job registry, CPU reservation and
// asset-path resolution. Mutants still mirror REAL defect shapes (RQ-003
// credential reference loss, RQ-006 corrupt-key reporting, orphaned secret
// blobs, plaintext resurrection, session-key resolution, builtin origin
// pinning) plus the classic security regressions (prefix-path escape,
// redaction leak, fail-open schema gates).
//
// RR2-H005: the recheck-2 requalification rejected a battery that stopped
// at the src/ credential layer. The campaign now ALSO mutates the release
// pipeline itself: publication stager (signature gate, exact-set inventory,
// path traversal), release verifier (output-root PE Authenticode scan),
// archive sequence validation, SBOM exact version@name resolution, the
// installer trust-anchor stamping AND the shipped installer template,
// SSRF URL policy, path-grant containment, artifact no-clobber finalize
// and the runtime installer's unverified-activation rollback.
//
// Usage:  node scripts/mutation-test.js [--min-score=100]
// Output: console verdict per mutant + coverage/mutation-report.json.
// Exit 0 only when the kill rate meets --min-score (default 100%).
// ============================================================================

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function log(m) { process.stdout.write(`[mutation] ${m}\n`); }
function fail(m) { process.stderr.write(`[mutation] ERROR: ${m}\n`); process.exit(1); }

const scoreArg = process.argv.find((a) => a.startsWith('--min-score='));
const MIN_SCORE = scoreArg ? parseFloat(scoreArg.split('=')[1]) : 100;
// Kill suites per mutated module. node --test runs each file in its own
// process, so module-state mutations cannot leak between files.
const SUITES = {
  'src/providersStore.js': [
    'tests/unit/src/providers/providersStore.test.js',
    'tests/unit/main/providersCredential.rq102.test.js',
    'tests/unit/src/providers/providersPayloadSchema.rq104.test.js',
  ],
  'main/services/ProviderCredentialRepository.js': [
    'tests/unit/main/services/CredentialRepository.hhhhu3.test.js',
    'tests/unit/main/providersCredential.rq102.test.js',
  ],
  'src/providersPayloadSchema.js': [
    'tests/unit/src/providers/providersPayloadSchema.rq104.test.js',
  ],
  'src/deepRedactor.js': [
    'tests/unit/src/deepRedactor.r24.test.js',
    'tests/unit/src/deepRedactor.r241.test.js',
  ],
  'src/pathUtils.js': [
    'tests/unit/src/pathUtils.test.js',
  ],
  'src/mmxApiKeySync.js': [
    'tests/unit/src/mmxApiKeySync.r23.test.js',
    'tests/unit/src/mmxApiKeySync.r23pp.test.js',
  ],
  'src/config.js': [
    'tests/unit/src/config.test.js',
  ],
  'src/batches.js': [
    'tests/unit/src/batches.h053.test.js',
  ],
  'src/jobRegistry.js': [
    'tests/unit/src/jobRegistry.test.js',
  ],
  'src/cpuGuard.js': [
    'tests/unit/kgo2AndCpuFixes.test.js',
  ],
  'src/assetPaths.js': [
    'tests/unit/src/assetPaths.h065.test.js',
  ],
  // RR2-H005: release-pipeline and service-layer mutation targets.
  'scripts/stage-publication.js': [
    'tests/unit/scripts/stagePublication.rr2.test.js',
  ],
  'scripts/verify-release.js': [
    'tests/unit/scripts/verifyRelease.test.js',
    'tests/unit/scripts/authenticodeGate.rr2.test.js',
  ],
  'scripts/releaseArtifacts.js': [
    'tests/unit/scripts/releaseArtifacts.test.js',
  ],
  'scripts/generate-sbom.js': [
    'tests/unit/scripts/sbomExactResolve.rr2.test.js',
    'tests/unit/scripts/sbomGate.rq104.test.js',
  ],
  'scripts/finalize-release-inventory.js': [
    'tests/unit/scripts/installerTrustAnchor.rr2.test.js',
  ],
  'Install MiniMax Asset Tool.cmd': [
    'tests/unit/scripts/installerTrustAnchor.rr2.test.js',
  ],
  'src/providers/urlPolicy.js': [
    'tests/security/compromised-renderer.test.js',
  ],
  'main/services/PathGrantService.js': [
    'tests/unit/main/services/PathGrantService.test.js',
  ],
  'main/services/ArtifactFinalizer.js': [
    'tests/unit/main/services/ArtifactFinalizer.h064.test.js',
  ],
  'scripts/lib/RuntimeInstaller.js': [
    'tests/unit/scripts/RuntimeInstaller.test.js',
  ],
};

// Directed mutants — each one recreates a defect shape that actually
// shipped or was found in audit. `find` must occur EXACTLY ONCE in the file.
const MUTANTS = [
  {
    id: 'M1',
    file: 'src/providersStore.js',
    shape: 'RQ-003 regression: keep-save drops the persisted credential_id',
    find: 'if (prev && prev.credential_id) p.credential_id = prev.credential_id;',
    replace: '/* mutant M1: credential reference not preserved on keep */',
  },
  {
    id: 'M2',
    file: 'src/providersStore.js',
    shape: 'B-006 regression: raw apiKey resurrected into metadata with repo active',
    find: 'if (repoActive) delete p.apiKey;',
    replace: 'if (false) delete p.apiKey;',
  },
  {
    id: 'M3',
    file: 'main/services/ProviderCredentialRepository.js',
    shape: 'RQ-006 regression: corrupt credential reported as hasKey=true',
    find: "hasKey: credentialState === 'persisted' || credentialState === 'session',",
    replace: "hasKey: credentialState !== 'none',",
  },
  {
    id: 'M4',
    file: 'main/services/ProviderCredentialRepository.js',
    shape: 'M-005 regression: failed replace leaves the fresh blob orphaned',
    find: 'try { this.blobStore.remove(newId); } catch (_) {}',
    replace: '/* mutant M4: orphan the fresh blob on rollback */',
  },
  {
    id: 'M5',
    file: 'main/services/ProviderCredentialRepository.js',
    shape: 'M-006 regression: session-only keys never resolve',
    find: 'return this._sessionKeys.get(providerId);',
    replace: 'return null; /* mutant M5: session keys dropped */',
  },
  {
    id: 'M6',
    file: 'main/services/ProviderCredentialRepository.js',
    shape: 'M-005 regression: failed migration leaves the blob orphaned',
    find: 'try { this.blobStore.remove(blobId); } catch (_) {}',
    replace: '/* mutant M6: orphan the blob on migration rollback */',
  },
  // V104-H001: systematic battery across the remaining critical modules.
  {
    id: 'M7',
    file: 'src/providersPayloadSchema.js',
    shape: 'H004 regression: an empty providers[] full replacement wipes the store',
    find: 'if (data.providers.length === 0) {',
    replace: 'if (false) { /* mutant M7: empty replacements accepted */',
  },
  {
    id: 'M8',
    file: 'src/providersStore.js',
    shape: 'H004 regression: the defense-in-depth store guard is bypassed',
    find: "const guard = require('./providersPayloadSchema').validateProvidersSetPayload(d);",
    replace: "const guard = { ok: true }; /* mutant M8: store guard bypassed */",
  },
  {
    id: 'M9',
    file: 'src/deepRedactor.js',
    shape: 'R0.1-003 regression: argv two-token secret leaks unredacted',
    find: 'out[i + 1] = repl; // redact the value',
    replace: 'out[i + 1] = value[i + 1]; // mutant M9: secret value not redacted',
  },
  {
    id: 'M10',
    file: 'src/pathUtils.js',
    shape: 'path-containment regression: sibling-prefix escape (C:\\Gen2 under C:\\Gen)',
    find: 'return pLow.startsWith(rLow + path.sep);',
    replace: 'return pLow.startsWith(rLow); /* mutant M10: prefix escape */',
  },
  {
    id: 'M11',
    file: 'src/mmxApiKeySync.js',
    shape: 'R2.3 regression: the persisted API key survives the privacy clear',
    find: 'delete existing.api_key;',
    replace: '/* mutant M11: persisted key not deleted */',
  },
  {
    id: 'M12',
    file: 'src/config.js',
    shape: 'P4.3 regression: the billable-units clamp is bypassed on parse',
    find: 'out.batch_max_units = Number.isFinite(n) && n >= 1 ? Math.min(n, 10000) : 200;',
    replace: 'out.batch_max_units = n; /* mutant M12: clamp bypassed */',
  },
  {
    id: 'M13',
    file: 'src/batches.js',
    shape: 'H-053 regression: a newer-schema batches.json is reinterpreted (fail-open)',
    find: 'if (raw && typeof raw.schemaVersion === \'number\' && raw.schemaVersion > SCHEMA_VERSION) {',
    replace: 'if (false) { /* mutant M13: newer schema accepted */',
  },
  {
    id: 'M14',
    file: 'src/jobRegistry.js',
    shape: 'R6.6.3 regression: a stale close event deletes a newer same-jobId entry',
    find: 'if (entry && entry.proc !== proc) return false; // stale close event',
    replace: '/* mutant M14: stale close events delete newer entries */',
  },
  {
    id: 'M15',
    file: 'src/cpuGuard.js',
    shape: 'KGO-2 regression: heavy backends no longer reserve OS cores',
    find: 'return Math.max(1, cores - 2);',
    replace: 'return Math.max(1, cores); /* mutant M15: no OS reservation */',
  },
  {
    id: 'M16',
    file: 'src/assetPaths.js',
    shape: 'H-065 regression: writable resolution without a userData guard',
    find: "if (!userDataPath) {\n    throw new Error('userDataPath is required for resolveWritableOverride');\n  }",
    replace: '/* mutant M16: writable override without userData guard */',
  },
  // RR2-H005: release-pipeline + service-layer battery.
  {
    id: 'M17',
    file: 'scripts/stage-publication.js',
    shape: 'RR2-C002 regression: a REJECTED Minisign signature is accepted',
    find: 'if (r.status !== 0) {',
    replace: 'if (false) { /* mutant M17: bad signature accepted */',
  },
  {
    id: 'M18',
    file: 'scripts/stage-publication.js',
    shape: 'RR2-M003 regression: extra manifest entries are published',
    find: 'if (missing.length || extra.length) return { ok: false, missing, extra };',
    replace: 'if (missing.length) return { ok: false, missing, extra }; /* mutant M18: extra entries accepted */',
  },
  {
    id: 'M19',
    file: 'scripts/stage-publication.js',
    shape: 'RR2-C002 regression: ".." traversal segments pass manifest validation',
    find: "if (segments.some((s) => s === '..' || s === '.' || s === '')) {",
    replace: 'if (false) { /* mutant M19: traversal segments accepted */',
  },
  {
    id: 'M20',
    file: 'scripts/verify-release.js',
    shape: 'RR2-H007 regression: output-root PEs (bundled minisign.exe) skip the Authenticode gate',
    find: 'if (!entry.isFile() || !/\\.(exe|dll|node)$/i.test(entry.name)) continue;',
    replace: 'continue; /* mutant M20: output-root PEs never checked */',
  },
  {
    id: 'M21',
    file: 'scripts/releaseArtifacts.js',
    shape: 'H002-era regression: a gapped split-archive sequence is accepted',
    find: 'if (!fs.existsSync(wantPath)) {\n      return { ok: false, error: `Archive part sequence is incomplete: missing ${want}`',
    replace: 'if (false) {\n      return { ok: false, error: `Archive part sequence is incomplete: missing ${want}`',
  },
  {
    id: 'M22',
    file: 'scripts/generate-sbom.js',
    shape: 'RR2-M002 regression: lockfile entries match by NAME only, not version',
    find: 'if (!key || !entry || entry.version !== version) continue;',
    replace: 'if (!key || !entry) continue; /* mutant M22: version filter removed */',
  },
  {
    id: 'M23',
    file: 'scripts/finalize-release-inventory.js',
    shape: 'RR2-C001 regression: the verifier SHA-256 pin is never stamped into the installer',
    find: "content = content.replace('RR2-C001-VERIFIER-SHA256', sha256File(toolDest));",
    replace: '/* mutant M23: verifier SHA-256 pin not stamped */',
  },
  {
    id: 'M24',
    file: 'Install MiniMax Asset Tool.cmd',
    shape: 'RR2-C001 regression: the installer trust-anchor marker is removed',
    find: '# RR2-C001-BEGIN-EMBEDDED-MINISIGN-PUBKEY',
    replace: 'rem mutant M24: trust anchor marker removed',
  },
  {
    id: 'M25',
    file: 'src/providers/urlPolicy.js',
    shape: 'SSRF regression: 192.168.x private provider URLs are allowed',
    find: 'if (a === 192 && b === 168) return true;',
    replace: 'if (false) return true; /* mutant M25: 192.168 SSRF bypass */',
  },
  {
    id: 'M26',
    file: 'main/services/PathGrantService.js',
    shape: 'AUD-017 regression: a directory grant authorizes ANY path',
    find: "if (!isStrictDescendant(grant.canonicalPath, candidateCanonical)) {\n        return { ok: false, error: 'directory grant covers only strict descendants, not the root itself' };",
    replace: "if (false) {\n        return { ok: false, error: 'directory grant covers only strict descendants, not the root itself' };",
  },
  {
    id: 'M27',
    file: 'main/services/ArtifactFinalizer.js',
    shape: 'H-064 regression: finalize overwrites an existing final path',
    find: 'if (fs.existsSync(opts.finalPath)) {',
    replace: 'if (false) { /* mutant M27: overwrite allowed */',
  },
  {
    id: 'M28',
    file: 'scripts/lib/RuntimeInstaller.js',
    shape: 'H-013 regression: an interrupted activation without a verifier is NOT rolled back',
    // NOTE: this file is CRLF — the anchor must stay byte-exact.
    find: "          if (marker.backupPath && fs.existsSync(marker.backupPath)) {\r\n            this._rollbackToBackup(marker);\r\n            this._removeMarker();\r\n            return { recovered: true, action: 'rolled-back-unverifiable-activation' };",
    replace: "          if (false) {\r\n            this._rollbackToBackup(marker);\r\n            this._removeMarker();\r\n            return { recovered: true, action: 'rolled-back-unverifiable-activation' };",
  },
];

// KNOWN FALSE POSITIVE: spawnSync launches ONLY the Node binary
// (process.execPath) with fixed --test flags and fixed repo-relative test
// paths — it is NOT arbitrary command execution.
function runSuite(testFiles) {
  return spawnSync(
    process.execPath,
    ['--test', ...testFiles],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 }
  );
}

function applyMutant(mutant) {
  const abs = path.join(ROOT, mutant.file);
  const src = fs.readFileSync(abs, 'utf8');
  const count = src.split(mutant.find).length - 1;
  if (count !== 1) {
    fail(`Mutant ${mutant.id}: anchor occurs ${count} time(s) in ${mutant.file} (must be exactly 1). Update the mutant.`);
  }
  fs.writeFileSync(abs, src.split(mutant.find).join(mutant.replace), 'utf8');
  return src;
}

const results = [];
let killed = 0;

function runBattery() {
// Baseline: the targeted suites must pass on the UNMUTATED source first,
// otherwise a "kill" below could be a false positive from a broken suite.
log('Running baseline (unmutated) targeted suites...');
for (const [file, suite] of Object.entries(SUITES)) {
  const b = runSuite(suite);
  if (b.status !== 0) {
    process.stdout.write((b.stdout || '') + (b.stderr || ''));
    fail(`Baseline suite for ${file} FAILED on clean source. Fix the tests before mutation testing.`);
  }
}
log('Baseline green.\n');

for (const mutant of MUTANTS) {
  const abs = path.join(ROOT, mutant.file);
  const original = applyMutant(mutant);
  let verdict = 'UNKNOWN';
  try {
    const r = runSuite(SUITES[mutant.file]);
    // Exit != 0 means the tests caught the mutant. A compile error in the
    // mutated file also counts as killed (the mutant is not viable).
    verdict = r.status !== 0 ? 'KILLED' : 'SURVIVED';
    if (verdict === 'SURVIVED') {
      const out = (r.stdout || '') + (r.stderr || '');
      const pass = Number((out.match(/^\s*(?:ℹ\s*)?pass\s+(\d+)/m) || [])[1] || 0);
      if (pass === 0) verdict = 'NO_COVERAGE'; // suite ran nothing — treat as not killed
    }
  } finally {
    fs.writeFileSync(abs, original, 'utf8'); // guaranteed restore
  }
  if (verdict === 'KILLED') killed++;
  results.push({ id: mutant.id, file: mutant.file, shape: mutant.shape, verdict });
  log(`  ${mutant.id} [${verdict}] ${mutant.file} — ${mutant.shape}`);
}

const score = (killed / MUTANTS.length) * 100;
try {
  const reportDir = path.join(ROOT, 'coverage');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'mutation-report.json'), JSON.stringify({
    mutants: MUTANTS.length, killed, survived: MUTANTS.length - killed,
    score, minScore: MIN_SCORE,
    verdict: score >= MIN_SCORE ? 'PASS' : 'FAIL',
    results, at: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');
} catch (_) { /* report writing must not mask the verdict */ }

log(`\nMutation score: ${killed}/${MUTANTS.length} killed (${score.toFixed(1)}%), required ${MIN_SCORE}%.`);
if (score < MIN_SCORE) {
  const survivors = results.filter((r) => r.verdict !== 'KILLED').map((r) => `${r.id} (${r.verdict}): ${r.shape}`);
  log('FAIL: surviving mutants — the regression suite cannot catch these defect shapes:\n  ' + survivors.join('\n  '));
  process.exit(1);
}
log('PASS: every directed mutant was killed by the regression suite.');
}

if (require.main === module) runBattery();

module.exports = { MUTANTS, SUITES, runBattery };
