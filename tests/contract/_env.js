// tests/contract/_env.js
// H11-6: shared env loader for the contract tests. Reads the API key from
// .env (no other code in the app loads .env — the key normally lives in
// config.txt). Skips all tests when RUN_CONTRACT_TESTS is not set, so
// `npm test` (the 1017 unit tests) stays free and offline.

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  try {
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch (_) { /* .env missing → tests skip */ }
}

function getApiKey() {
  return process.env.MINIMAX_API_KEY || '';
}

function shouldRun() {
  return process.env.RUN_CONTRACT_TESTS === '1' || process.env.RUN_CONTRACT_TESTS === 'true';
}

// Skip helper: call at the top of each test with the TestContext `t`.
// Returns true if the test should skip (so the caller can `if (skip(t)) return;`).
function skip(t) {
  if (!shouldRun()) {
    // t.skip() marks the test as skipped in the runner output.
    if (t && typeof t.skip === 'function') t.skip('Set RUN_CONTRACT_TESTS=1 to run contract tests (spends real API credits).');
    return true;
  }
  loadEnv();
  const key = getApiKey();
  if (!key) {
    if (t && typeof t.skip === 'function') t.skip('MINIMAX_API_KEY not found in .env or environment.');
    return true;
  }
  return false;
}

// KGO8-010 follow-up: distinguish "the provider refused us" from "the contract
// is broken". Once the contract suite actually ran (it silently skipped
// everything before), the two video tests turned out to exceed the daily video
// quota between them: the first real generation succeeds, the second comes back
// "Token Plan usage limit reached" and the suite went red for a reason that has
// nothing to do with the code under test.
//
// A quota wall means the assertion COULD NOT BE EVALUATED. Failing on it trains
// people to ignore the gate; passing silently is the dishonesty KGO8-010 exists
// to remove. So: mark it skipped with the provider's own message, which shows up
// as "not verified" in the runner output while leaving real contract breakage red.
const QUOTA_PATTERNS = [
  /usage limit reached/i,
  /Token Plan/i,
  /insufficient balance/i,
  /rate.?limit/i,
];

function isQuotaError(stderr) {
  const s = String(stderr || '');
  return QUOTA_PATTERNS.some((re) => re.test(s));
}

/**
 * Call with the runMmx result BEFORE asserting. Returns true when the run hit a
 * provider quota/rate wall, in which case the test should return early.
 */
function skipOnQuota(t, r) {
  if (r && r.ok !== true && isQuotaError(r.stderr)) {
    const msg = (String(r.stderr || '').match(/"message":\s*"([^"]+)"/) || [])[1] || 'provider quota reached';
    if (t && typeof t.skip === 'function') t.skip('NOT VERIFIED — provider quota/rate limit: ' + msg);
    return true;
  }
  return false;
}

module.exports = { loadEnv, getApiKey, shouldRun, skip, isQuotaError, skipOnQuota };
