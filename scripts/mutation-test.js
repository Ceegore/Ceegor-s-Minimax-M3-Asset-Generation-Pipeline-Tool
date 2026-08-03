// scripts/mutation-test.js
// ============================================================================
// RQ-004 fix: mutation-testing gate for the release-critical credential
// and security modules.
//
// Directed mutants are injected ONE AT A TIME into the production source
// (with backup + guaranteed restore), and the targeted regression suite is
// run against each mutant. A mutant the tests fail to catch ("survivor")
// means a real regression of that shape could ship undetected — so any
// survivor fails this gate.
//
// Mutants are curated to mirror REAL past defects (RQ-003 credential
// reference loss, RQ-006 corrupt-key reporting, orphaned secret blobs,
// plaintext resurrection, session-key resolution, builtin origin pinning).
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
  ],
  'main/services/ProviderCredentialRepository.js': [
    'tests/unit/main/services/CredentialRepository.hhhhu3.test.js',
    'tests/unit/main/providersCredential.rq102.test.js',
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
