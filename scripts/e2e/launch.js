// scripts/e2e/launch.js
// Node-side launcher for the E2E suite. Spawns Electron with
// scripts/e2e/run.js as its main script, streams output, and forwards the
// harness's exit code so `npm run test:e2e` fails CI on any assertion
// failure. Mirrors scripts/run-smoke.js (the harness must run inside the
// Electron runtime, so it can't be `node`-executed directly).
//
// KNOWN FALSE POSITIVE: `spawnSync` below spawns ONLY the Electron binary
// (a known path inside node_modules) with a fixed entry-point script.
// It is NOT arbitrary command execution. `require('electron')` returns
// the binary path as a string — it does NOT load Electron into this process.
// See harness.js header for the full false-positives reference.

const { spawnSync } = require('child_process');
const path = require('path');

let electronPath;
try {
  electronPath = require('electron'); // the package's main export is the binary path
} catch (e) {
  console.error('Electron is not installed (npm install first).');
  process.exit(1);
}

const entry = path.join(__dirname, 'run.js');
// Forward CLI args (--real, --only=..., --isolate) to the Electron entry.
const args = [entry, ...process.argv.slice(2)];
const r = spawnSync(electronPath, args, {
  stdio: 'inherit',
  env: { ...process.env },
});

if (r.error) { console.error('Failed to launch Electron:', r.error); process.exit(1); }
process.exit(r.status == null ? 1 : r.status);
