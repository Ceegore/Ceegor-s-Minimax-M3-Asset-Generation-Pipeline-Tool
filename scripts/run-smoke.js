// scripts/run-smoke.js — runner for the headless renderer smoke test.
// Spawns Electron with scripts/smoke-renderer.js, streams its output, and
// exits with the harness's exit code so `npm run test:smoke` fails CI if
// any assertion fails. Kept separate from the harness because the harness
// must run inside the Electron runtime (it can't be `node`-executed).

const { spawnSync } = require('child_process');
const path = require('path');

let electronPath;
try {
  electronPath = require('electron'); // the package's main export is the binary path
} catch (e) {
  console.error('Electron is not installed (npm install first).');
  process.exit(1);
}

const harness = path.join(__dirname, 'smoke-renderer.js');
const r = spawnSync(electronPath, [harness], {
  stdio: 'inherit',
  env: { ...process.env },
});

if (r.error) { console.error('Failed to launch Electron:', r.error); process.exit(1); }
process.exit(r.status == null ? 1 : r.status);
