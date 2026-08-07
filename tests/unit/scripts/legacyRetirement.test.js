'use strict';

// §22 retirement guard: after v1.0.7 (the final legacy-compatible release)
// the runtime-reuse path is permanently decommissioned. This test scans every
// ACTIVE workflow under .github/workflows for the legacy markers and fails
// closed if any of them reappears. The one-time release-legacy-final.yml and
// its watchdog were removed as part of the retirement; a workflow containing
// these markers can only come back through a deliberate change, which this
// gate forces to be visible as a failing check.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const WORKFLOW_DIR = path.join(__dirname, '..', '..', '..', '.github', 'workflows');

// The four retirement markers mandated by §22.
const LEGACY_MARKERS = [
  'legacy:compose',
  'legacy-shell.lock.json',
  'MINIMAX_RELEASE_MODE=legacy',
  'legacy-shell-seed',
];

test('no active workflow revives the legacy runtime-reuse release path (§22)', () => {
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
  assert.ok(files.length > 0, 'expected at least one workflow file to scan');

  const hits = [];
  for (const name of files) {
    const content = fs.readFileSync(path.join(WORKFLOW_DIR, name), 'utf8');
    for (const marker of LEGACY_MARKERS) {
      if (content.includes(marker)) {
        hits.push(`${name} contains legacy marker "${marker}"`);
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    'Legacy release mechanism must stay retired (§22). ' +
      'Found: ' + hits.join('; ')
  );
});
